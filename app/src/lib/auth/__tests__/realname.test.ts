// app/src/lib/auth/__tests__/realname.test.ts
// 实人认证（阿里云 CloudAuth）。签名算错的表现是线上一发就 SignatureDoesNotMatch，
// 故这里独立复算一遍签名（手法同 lib/notify/__tests__/sms.test.ts）。
// 全程注入假阿里云，**绝不真调**——真活体认证要真人脸，也要花钱。
import { beforeEach, describe, expect, test, vi } from 'vitest';
import crypto, { createHmac } from 'node:crypto';
import type { Database } from 'better-sqlite3';

import { decryptField } from '@/lib/crypto';
import * as realnameStore from '@/lib/db/realname';
import * as users from '@/lib/db/otp';
import { requireRealname } from '../guard';
import type { Identity } from '../identity';
import {
  AUTH_STATUS,
  VERIFICATION_STATUS,
  describeFaceVerify,
  initFaceVerify,
  refreshRealnameStatus,
  startRealname,
} from '../realname';
import { makeTestDb } from './helpers';

const SECRET = 'test-cloudauth-secret';
const REAL_NAME = '张三';
const ID_CARD = '11010519491231002X';

/** 假阿里云：记录被请求的 URL，返回给定响应体 */
function fakeAliyun(body: unknown) {
  const calls: string[] = [];
  const impl = vi.fn(async (url: string | URL | Request) => {
    calls.push(String(url));
    return new Response(JSON.stringify(body));
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

function okInit(certifyUrl: string | null = 'https://cloudauth.aliyun.com/h5?token=abc') {
  return {
    Code: '200',
    Message: 'success',
    ResultObject: {
      CertifyId: 'certify-123',
      ...(certifyUrl === null ? {} : { CertifyUrl: certifyUrl }),
    },
  };
}

function seedUser(db: Database): number {
  return users.insertUser(db, {
    phoneEnc: 'v1:whatever',
    phoneHash: crypto.randomUUID(),
    verifiedAt: '2026-08-20 10:00:00',
  });
}

function identityOf(uid: number): Identity {
  return { uid, via: 'jwt', scopes: ['case:read', 'case:write'] };
}

beforeEach(() => {
  process.env.LAWER_DATA_KEY = crypto.randomBytes(32).toString('base64');
  process.env.ALIYUN_ACCESS_KEY_ID = 'test-access-key-id';
  process.env.ALIYUN_ACCESS_KEY_SECRET = SECRET;
  process.env.ALIYUN_REGION = 'cn-beijing';
  process.env.CLOUDAUTH_SCENE_ID = '1000016498';
  process.env.CLOUDAUTH_PRODUCT_CODE = 'PV_FV';
  process.env.CLOUDAUTH_MODEL = 'LIVENESS';
  process.env.CLOUDAUTH_RETURN_URL_BASE = 'https://lawer.example.com';
});

describe('阿里云 RPC 调用', () => {
  test('InitFaceVerify 参数齐备，且 Signature 能按阿里云规则独立复算出来', async () => {
    const { impl, calls } = fakeAliyun(okInit());
    const result = await initFaceVerify(
      { userId: 7, certName: REAL_NAME, certNo: ID_CARD, returnUrl: 'https://lawer.example.com/cb' },
      impl,
    );

    expect(result).toEqual({
      certifyId: 'certify-123',
      certifyUrl: 'https://cloudauth.aliyun.com/h5?token=abc',
    });
    expect(calls).toHaveLength(1);

    const url = new URL(calls[0]);
    // cloudauth 是分区域域名，region 配错会连不上
    expect(url.host).toBe('cloudauth.cn-beijing.aliyuncs.com');
    const params = url.searchParams;
    expect(params.get('Action')).toBe('InitFaceVerify');
    expect(params.get('Version')).toBe('2019-03-07');
    expect(params.get('SceneId')).toBe('1000016498');
    expect(params.get('ProductCode')).toBe('PV_FV');
    expect(params.get('Model')).toBe('LIVENESS');
    expect(params.get('CertType')).toBe('IDENTITY_CARD');
    expect(params.get('CertName')).toBe(REAL_NAME);
    expect(params.get('CertNo')).toBe(ID_CARD);
    expect(params.get('OuterOrderNo')).toBe('user_7');
    expect(params.get('UserId')).toBe('7');
    expect(params.get('ReturnUrl')).toBe('https://lawer.example.com/cb');
    expect(params.get('CertifyUrlStyle')).toBe('L');
    // 短信那套是 HMAC-SHA1，实人认证是 SHA256，抄串了线上必挂
    expect(params.get('SignatureMethod')).toBe('HMAC-SHA256');

    const encode = (v: string) =>
      encodeURIComponent(v).replace(/\+/g, '%20').replace(/\*/g, '%2A').replace(/%7E/g, '~');
    const given = params.get('Signature')!;
    params.delete('Signature');
    const canonicalized = [...params.keys()]
      .sort()
      .map((k) => `${encode(k)}=${encode(params.get(k)!)}`)
      .join('&');
    const expected = createHmac('sha256', `${SECRET}&`)
      .update(`GET&${encode('/')}&${encode(canonicalized)}`)
      .digest('base64');
    expect(given).toBe(expected);
  });

  test('SceneId 绑成 APP 接入时只回 CertifyId，不当作错误抛', async () => {
    const { impl } = fakeAliyun(okInit(null));
    const result = await initFaceVerify(
      { userId: 1, certName: REAL_NAME, certNo: ID_CARD, returnUrl: 'https://x/cb' },
      impl,
    );
    expect(result.certifyUrl).toBeNull();
  });

  test('Code !== 200 时抛出阿里云的 Message', async () => {
    const { impl } = fakeAliyun({ Code: 'InvalidParameter', Message: '场景不存在' });
    await expect(
      initFaceVerify(
        { userId: 1, certName: REAL_NAME, certNo: ID_CARD, returnUrl: 'https://x/cb' },
        impl,
      ),
    ).rejects.toThrow('场景不存在');
  });

  test('缺凭证时在发请求之前就拦下', async () => {
    delete process.env.CLOUDAUTH_SCENE_ID;
    const { impl, calls } = fakeAliyun(okInit());
    await expect(
      initFaceVerify(
        { userId: 1, certName: REAL_NAME, certNo: ID_CARD, returnUrl: 'https://x/cb' },
        impl,
      ),
    ).rejects.toThrow('阿里云实人认证凭证未配置');
    expect(calls).toHaveLength(0);
  });

  test('DescribeFaceVerify 以 Passed 为准：T 通过 / F 带原因 / 缺失表示还没做完', async () => {
    const passedRes = await describeFaceVerify(
      'certify-123',
      fakeAliyun({ Code: '200', ResultObject: { Passed: 'T', SubCode: '200' } }).impl,
    );
    expect(passedRes).toMatchObject({ passed: true, passedRaw: 'T', message: '认证通过' });

    const failedRes = await describeFaceVerify(
      'certify-123',
      fakeAliyun({ Code: '200', ResultObject: { Passed: 'F', SubCode: '203' } }).impl,
    );
    expect(failedRes).toMatchObject({ passed: false, subCode: '203', message: '活体检测失败' });

    const pendingRes = await describeFaceVerify(
      'certify-123',
      fakeAliyun({ Code: '200', ResultObject: {} }).impl,
    );
    expect(pendingRes.passedRaw).toBeNull();
    expect(pendingRes.passed).toBe(false);
  });
});

describe('startRealname', () => {
  test('姓名/身份证格式不合法时不调阿里云', async () => {
    const db = makeTestDb();
    const userId = seedUser(db);
    const init = vi.fn();

    const noName = await startRealname(db, { userId, realName: '  ', idCard: ID_CARD }, { init });
    expect(noName).toMatchObject({ ok: false, status: 400, errorCode: 'INVALID_REAL_NAME' });

    const badId = await startRealname(db, { userId, realName: REAL_NAME, idCard: '1234' }, { init });
    expect(badId).toMatchObject({ ok: false, status: 400, errorCode: 'INVALID_ID_CARD' });

    expect(init).not.toHaveBeenCalled();
    expect(realnameStore.latestByUser(db, userId)).toBeUndefined();
  });

  test('发起成功：落一条待审流水，姓名证件号只以密文存在，users 转「待审」', async () => {
    const db = makeTestDb();
    const userId = seedUser(db);
    const init = vi.fn(async (arg: Parameters<typeof initFaceVerify>[0]) => {
      // ReturnUrl 由服务端拼，不受前端摆布
      expect(arg.returnUrl).toBe('https://lawer.example.com/realname/callback');
      return { certifyId: 'certify-123', certifyUrl: 'https://h5' };
    });

    const result = await startRealname(db, { userId, realName: REAL_NAME, idCard: ID_CARD }, { init });
    expect(result).toMatchObject({ ok: true, certifyId: 'certify-123', certifyUrl: 'https://h5' });
    expect(init).toHaveBeenCalledTimes(1);

    const row = realnameStore.latestByUser(db, userId)!;
    expect(row.provider).toBe('cloudauth');
    expect(row.status).toBe(VERIFICATION_STATUS.pending);
    // cert_no 存的是阿里云认证流水号，不是身份证号——身份证号不得有明文列
    expect(row.cert_no).toBe('certify-123');
    expect(row.raw_meta_enc).not.toContain(REAL_NAME);
    expect(row.raw_meta_enc).not.toContain(ID_CARD);
    // 加密落库回环：解出来还是原文
    expect(JSON.parse(decryptField(row.raw_meta_enc!))).toEqual({
      cert_name: REAL_NAME,
      cert_no: ID_CARD,
    });

    expect(users.findUserById(db, userId)!.auth_status).toBe(AUTH_STATUS.pending);
  });

  test('重复发起允许，每次都是新流水（改名/换证走同一条路）', async () => {
    const db = makeTestDb();
    const userId = seedUser(db);
    const init = vi.fn(async () => ({ certifyId: 'certify-2', certifyUrl: null }));

    await startRealname(db, { userId, realName: REAL_NAME, idCard: ID_CARD }, { init });
    await startRealname(db, { userId, realName: '李四', idCard: ID_CARD }, { init });

    const rows = db
      .prepare('SELECT id FROM realname_verifications WHERE user_id = ?')
      .all(userId) as unknown[];
    expect(rows).toHaveLength(2);
  });

  test('阿里云报错时不落流水，回 502', async () => {
    const db = makeTestDb();
    const userId = seedUser(db);
    const init = vi.fn(async () => {
      throw new Error('场景不存在');
    });

    const result = await startRealname(db, { userId, realName: REAL_NAME, idCard: ID_CARD }, { init });
    expect(result).toMatchObject({ ok: false, status: 502, errorCode: 'REALNAME_INIT_FAILED' });
    expect(realnameStore.latestByUser(db, userId)).toBeUndefined();
    expect(users.findUserById(db, userId)!.auth_status).toBe(AUTH_STATUS.none);
  });
});

describe('refreshRealnameStatus', () => {
  /** 建号 + 发起认证，回到"待审"这个起点 */
  async function pending(db: Database): Promise<number> {
    const userId = seedUser(db);
    await startRealname(
      db,
      { userId, realName: REAL_NAME, idCard: ID_CARD },
      { init: async () => ({ certifyId: 'certify-123', certifyUrl: 'https://h5' }) },
    );
    return userId;
  }

  function describeStub(result: {
    passed: boolean;
    passedRaw: string | null;
    subCode?: string;
    message?: string;
  }) {
    return vi.fn(async () => ({
      passed: result.passed,
      passedRaw: result.passedRaw,
      subCode: result.subCode ?? '',
      message: result.message ?? '',
      raw: { Code: '200', ResultObject: { Passed: result.passedRaw, SubCode: result.subCode } },
    }));
  }

  test('从未发起过认证 → 如实回未认证，不调阿里云', async () => {
    const db = makeTestDb();
    const userId = seedUser(db);
    const describe = describeStub({ passed: false, passedRaw: null });

    const result = await refreshRealnameStatus(db, { userId }, { describe });
    expect(result).toMatchObject({
      ok: true,
      authStatus: AUTH_STATUS.none,
      verificationStatus: null,
    });
    expect(describe).not.toHaveBeenCalled();
  });

  test('用户还没做完人脸 → 保持待审，不动流水也不动 users', async () => {
    const db = makeTestDb();
    const userId = await pending(db);
    const describe = describeStub({ passed: false, passedRaw: null });

    const result = await refreshRealnameStatus(db, { userId }, { describe });
    expect(result).toMatchObject({
      ok: true,
      authStatus: AUTH_STATUS.pending,
      verificationStatus: VERIFICATION_STATUS.pending,
    });
    expect(realnameStore.latestByUser(db, userId)!.status).toBe(VERIFICATION_STATUS.pending);
  });

  test('通过 → 流水落定、users 转已实名并回填姓名证件号密文', async () => {
    const db = makeTestDb();
    const userId = await pending(db);
    const describe = describeStub({ passed: true, passedRaw: 'T', subCode: '200', message: '认证通过' });

    const result = await refreshRealnameStatus(db, { userId }, { describe });
    expect(result).toMatchObject({
      ok: true,
      authStatus: AUTH_STATUS.verified,
      verificationStatus: VERIFICATION_STATUS.passed,
    });

    const user = db
      .prepare('SELECT real_name_enc, id_card_enc, auth_status FROM users WHERE id = ?')
      .get(userId) as { real_name_enc: string; id_card_enc: string; auth_status: string };
    expect(user.auth_status).toBe(AUTH_STATUS.verified);
    expect(decryptField(user.real_name_enc)).toBe(REAL_NAME);
    expect(decryptField(user.id_card_enc)).toBe(ID_CARD);

    // 三方原始报文并进信封留档，姓名证件号仍在
    const envelope = JSON.parse(decryptField(realnameStore.latestByUser(db, userId)!.raw_meta_enc!));
    expect(envelope).toMatchObject({ cert_name: REAL_NAME, cert_no: ID_CARD });
    expect(envelope.result).toBeTruthy();
  });

  test('落定后重复轮询不再调阿里云，也不重复回填', async () => {
    const db = makeTestDb();
    const userId = await pending(db);
    const describe = describeStub({ passed: true, passedRaw: 'T', subCode: '200' });

    await refreshRealnameStatus(db, { userId }, { describe });
    const afterFirst = db
      .prepare('SELECT real_name_enc FROM users WHERE id = ?')
      .get(userId) as { real_name_enc: string };

    const second = await refreshRealnameStatus(db, { userId }, { describe });
    expect(describe).toHaveBeenCalledTimes(1);
    expect(second).toMatchObject({
      ok: true,
      authStatus: AUTH_STATUS.verified,
      verificationStatus: VERIFICATION_STATUS.passed,
    });
    // 密文没被重新生成（重新加密同一明文会得到不同密文，据此可判有没有再写一次）
    expect(
      (db.prepare('SELECT real_name_enc FROM users WHERE id = ?').get(userId) as {
        real_name_enc: string;
      }).real_name_enc,
    ).toBe(afterFirst.real_name_enc);
  });

  test('未通过 → 流水记未通过与原因，users 退回未认证', async () => {
    const db = makeTestDb();
    const userId = await pending(db);
    const describe = describeStub({
      passed: false,
      passedRaw: 'F',
      subCode: '201',
      message: '姓名和身份证号不一致',
    });

    const result = await refreshRealnameStatus(db, { userId }, { describe });
    expect(result).toMatchObject({
      ok: true,
      authStatus: AUTH_STATUS.none,
      verificationStatus: VERIFICATION_STATUS.failed,
      message: '姓名和身份证号不一致',
    });
    expect(users.findUserById(db, userId)!.auth_status).toBe(AUTH_STATUS.none);
    expect(
      JSON.parse(decryptField(realnameStore.latestByUser(db, userId)!.raw_meta_enc!)).result,
    ).toBeTruthy();
  });
});

describe('requireRealname 闸门', () => {
  test('未认证 / 待审 / 已实名 三态：只有已实名放行', async () => {
    const db = makeTestDb();
    const userId = seedUser(db);

    const denied = requireRealname(db, identityOf(userId));
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.response.status).toBe(403);
      expect(await denied.response.json()).toMatchObject({
        ok: false,
        error_code: 'REALNAME_REQUIRED',
      });
    }

    // 待审 = 认证发起了但人没做完，同样不放行
    users.setUserAuthStatus(db, userId, AUTH_STATUS.pending);
    expect(requireRealname(db, identityOf(userId)).ok).toBe(false);

    users.setUserAuthStatus(db, userId, AUTH_STATUS.verified);
    expect(requireRealname(db, identityOf(userId)).ok).toBe(true);
  });
});
