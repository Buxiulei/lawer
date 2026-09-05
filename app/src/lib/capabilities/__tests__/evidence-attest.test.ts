// app/src/lib/capabilities/__tests__/evidence-attest.test.ts
// evidence_attest（出证）与 attest_verify（核验）两条能力，外加「出证成功才写简报」这条接缝。
//
// sidecar 全程 mock（打 fetch），不依赖真实 TSA / 签名证书，可离线跑。
// 简报生成器用假的插进 setBriefGenerator —— 真生成器是另一条线的事，这里钉的是
// **什么时候调它、失败了怎么办**：出证不成不许有简报，简报炸了不许影响出证。
import BetterSqlite3, { type Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// 必须在任何加解密调用之前就位（crypto 首次调用时读 env 并缓存）
process.env.LAWER_DATA_KEY = Buffer.alloc(32, 9).toString('base64');

import type { Identity } from '@/lib/auth/identity';
import { getCapability } from '@/lib/capabilities';
import { MAX_ATTEST_PER_CALL } from '@/lib/capabilities/families/evidence-write';
import { encryptField } from '@/lib/crypto';
import { runMigrations } from '@/lib/db/migrate';
import * as evidence from '@/lib/evidence';
import { ensureBrief, setBriefGenerator, type BriefInput } from '@/lib/evidence/brief';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let db: Database;
let userA: number;
let caseA: number;
let tmpDir: string;
/** 假生成器每被调一次记一笔输入，用来断言「拿到的是什么」而不只是「调没调」 */
let briefCalls: BriefInput[];

const FAKE_TST = 'MIILAQYJKoZIhvcNAQcCoIIK8jCCCu4CAQMx';

function mockSidecarOk() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const u = String(url);
      if (u.endsWith('/signer')) {
        return new Response(
          JSON.stringify({ signer_cn: '某某公司', signer_org: null, not_before: null, not_after: null, serial: 'x' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (u.endsWith('/tsa')) {
        return new Response(
          JSON.stringify({
            tst_b64: FAKE_TST,
            gen_time: '2026-09-05T03:42:58+00:00',
            serial: '12822790593270748442097240347230746476',
            tsa_url: 'http://tsa.example/tsa',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (u.endsWith('/evidence-pdf')) return new Response(new Uint8Array(Buffer.from('%PDF unsigned')), { status: 200 });
      if (u.endsWith('/pades')) return new Response(new Uint8Array(Buffer.from('%PDF signed')), { status: 200 });
      throw new Error(`未预期的 sidecar 调用: ${u}`);
    }),
  );
}

/** sidecar 报错：出证在第一段（取时间戳）就失败 */
function mockSidecarFail() {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify({ detail: 'TSA 上游不可用' }), {
          status: 502,
          headers: { 'Content-Type': 'application/json' },
        }),
    ),
  );
}

function identity(uid: number): Identity {
  return { uid, via: 'jwt', scopes: ['case:read', 'case:write'] };
}

async function call(name: string, uid: number, args: Record<string, unknown>) {
  const cap = getCapability(name);
  if (!cap) throw new Error(`没有这个能力：${name}`);
  return (await cap.run(db, identity(uid), args)) as Record<string, unknown>;
}

function makeEvidence(name = '解除通知.jpg', bytes = Buffer.from('通知正文')) {
  const r = evidence.uploadEvidence(db, {
    caseId: caseA,
    userId: userA,
    bytes,
    name,
    mime: 'image/jpeg',
    category: '公司文件',
    provePurpose: '证明公司单方解除',
    originalMedium: '手机拍照',
  });
  if (!r.ok) throw new Error(`造样本失败：${r.errorCode}`);
  return r.evidence.id;
}

function briefOf(evidenceId: number) {
  return db
    .prepare('SELECT brief_json, brief_version, brief_updated_by FROM evidence WHERE id = ?')
    .get(evidenceId) as { brief_json: string | null; brief_version: number; brief_updated_by: string | null };
}

beforeEach(() => {
  db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  userA = Number(
    db
      .prepare(
        `INSERT INTO users (phone_hash, real_name_enc, id_card_enc, auth_status, cert_type)
         VALUES ('h-a', ?, ?, '已实名', '身份证')`,
      )
      .run(encryptField('张三'), encryptField('110101199001011234')).lastInsertRowid,
  );
  caseA = Number(
    db.prepare("INSERT INTO cases (user_id, title, stage) VALUES (?, '甲的案子', '风声')").run(userA).lastInsertRowid,
  );
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lawer-attest-brief-'));
  process.env.FILES_DIR = tmpDir;
  briefCalls = [];
  setBriefGenerator((input) => {
    briefCalls.push(input);
    return { 能证明什么: `${input.name} 的要点`, 有没有正文: input.extractedText === null ? '没有' : '有' };
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  setBriefGenerator(null);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  db.close();
});

describe('evidence_attest：幂等与逐件结果', () => {
  test('出证成功回订单号；同一条再发起是同一个订单号，不出第二份证明', async () => {
    mockSidecarOk();
    const id = makeEvidence();

    const first = await call('evidence_attest', userA, { evidence_ids: [id] });
    expect(first.ok).toBe(true);
    expect(first.succeeded).toBe(1);
    const orderNo = (first.results as { order_no: string }[])[0].order_no;
    expect(orderNo).toMatch(/^LAWER-ATT-\d{8}-[0-9a-f]{16}$/);

    const again = await call('evidence_attest', userA, { evidence_ids: [id] });
    expect((again.results as { order_no: string }[])[0].order_no).toBe(orderNo);
    expect(db.prepare('SELECT COUNT(*) AS n FROM attestations').get()).toEqual({ n: 1 });
  });

  test('同一个 id 在入参里报两遍只算一件，回包不出现两行一样的结果', async () => {
    mockSidecarOk();
    const id = makeEvidence();
    const res = await call('evidence_attest', userA, { evidence_ids: [id, id] });
    expect((res.results as unknown[]).length).toBe(1);
  });

  test('逐件独立成败：别人的条目失败，自己的照常出证', async () => {
    mockSidecarOk();
    const mine = makeEvidence('我的.jpg', Buffer.from('我的内容'));
    const res = await call('evidence_attest', userA, { evidence_ids: [mine, 999999] });
    const results = res.results as { evidence_id: number; ok: boolean; error_code?: string }[];
    expect(res.succeeded).toBe(1);
    expect(res.failed).toBe(1);
    expect(results.find((r) => r.evidence_id === 999999)?.error_code).toBe('EVIDENCE_NOT_FOUND');
  });

  test(`一次超过 ${MAX_ATTEST_PER_CALL} 件整笔拒收，一件都不发起`, async () => {
    mockSidecarOk();
    const ids = Array.from({ length: MAX_ATTEST_PER_CALL + 1 }, (_, i) =>
      makeEvidence(`第${i}份.jpg`, Buffer.from(`内容${i}`)),
    );
    const res = await call('evidence_attest', userA, { evidence_ids: ids });
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('TOO_MANY_EVIDENCE_IDS');
    expect(db.prepare('SELECT COUNT(*) AS n FROM attestations').get()).toEqual({ n: 0 });
  });
});

describe('出证成功后自动写简报', () => {
  test('出证成功 ⇒ 简报由 system 写入，版本从 0 变 1', async () => {
    mockSidecarOk();
    const id = makeEvidence();
    expect(briefOf(id)).toMatchObject({ brief_json: null, brief_version: 0 });

    await call('evidence_attest', userA, { evidence_ids: [id] });

    const brief = briefOf(id);
    expect(brief.brief_version).toBe(1);
    expect(brief.brief_updated_by).toBe('system');
    expect(JSON.parse(brief.brief_json as string)['能证明什么']).toContain('解除通知.jpg');
    expect(briefCalls).toHaveLength(1);
  });

  test('没有提取文本时按元数据写：生成器拿到的 extractedText 是 null，名称与证明目的齐备', async () => {
    mockSidecarOk();
    const id = makeEvidence();
    await call('evidence_attest', userA, { evidence_ids: [id] });
    expect(briefCalls[0]).toMatchObject({
      evidenceId: id,
      name: '解除通知.jpg',
      category: '公司文件',
      provePurpose: '证明公司单方解除',
      originalMedium: '手机拍照',
      extractedText: null,
    });
    expect(JSON.parse(briefOf(id).brief_json as string)['有没有正文']).toBe('没有');
  });

  /**
   * 🔴 变异臂「attest 失败仍写简报」：把 attest.ts 里 ensureBrief 的调用从 certified()
   * 里挪到 attestEvidence 开头（或挪到 sidecarFailure 那条返回路径上），这条会翻红。
   */
  test('出证失败 ⇒ 一个字的简报都不写', async () => {
    mockSidecarFail();
    const id = makeEvidence();
    const res = await call('evidence_attest', userA, { evidence_ids: [id] });
    expect(res.failed).toBe(1);
    expect(briefCalls).toHaveLength(0);
    expect(briefOf(id)).toMatchObject({ brief_json: null, brief_version: 0 });
  });

  test('简报生成器抛异常 ⇒ 出证照样成功（附赠品不许拖垮正事）', async () => {
    mockSidecarOk();
    setBriefGenerator(() => {
      throw new Error('模型这会儿不可用');
    });
    const id = makeEvidence();
    const res = await call('evidence_attest', userA, { evidence_ids: [id] });
    expect(res.succeeded).toBe(1);
    expect((res.results as { ok: boolean }[])[0].ok).toBe(true);
    expect(briefOf(id).brief_version).toBe(0);
  });

  test('已经有简报的不覆盖（用户手写过的那版不许被 system 盖掉）', async () => {
    mockSidecarOk();
    const id = makeEvidence();
    db.prepare(
      "UPDATE evidence SET brief_json = ?, brief_version = 3, brief_updated_by = 'web' WHERE id = ?",
    ).run(JSON.stringify({ 能证明什么: '用户自己写的' }), id);

    await call('evidence_attest', userA, { evidence_ids: [id] });
    const brief = briefOf(id);
    expect(brief.brief_version).toBe(3);
    expect(brief.brief_updated_by).toBe('web');
    expect(briefCalls).toHaveLength(0);
  });

  test('没插生成器时安静地什么都不做，出证照常', async () => {
    mockSidecarOk();
    setBriefGenerator(null);
    const id = makeEvidence();
    const res = await call('evidence_attest', userA, { evidence_ids: [id] });
    expect(res.succeeded).toBe(1);
    expect(await ensureBrief(db, id)).toBe('no_generator');
    expect(briefOf(id).brief_version).toBe(0);
  });

  test('ensureBrief 的各档回值分得清「没插生成器」「生成器不写」「已经有了」', async () => {
    const id = makeEvidence('另一份.jpg', Buffer.from('另一份内容'));
    setBriefGenerator(() => null);
    expect(await ensureBrief(db, id)).toBe('declined');
    expect(briefOf(id).brief_version).toBe(0);

    setBriefGenerator(() => ({ 能证明什么: '写了' }));
    expect(await ensureBrief(db, id)).toBe('written');
    expect(await ensureBrief(db, id)).toBe('already');
    expect(await ensureBrief(db, 999999)).toBe('not_found');
  });
});

describe('attest_verify：公开只读，与 GET /verify 同一份数据', () => {
  test('按订单号查得到哈希与时间戳，且不含持证人身份', async () => {
    mockSidecarOk();
    const id = makeEvidence();
    const attested = await call('evidence_attest', userA, { evidence_ids: [id] });
    const orderNo = (attested.results as { order_no: string }[])[0].order_no;

    const seen = await call('attest_verify', userA, { order_no: orderNo });
    expect(seen.ok).toBe(true);
    expect(seen.order_no).toBe(orderNo);
    expect(seen.status).toBe('certified');
    expect((seen.timestamp as { tst_b64: string }).tst_b64).toBe(FAKE_TST);
    expect((seen.evidence as { name: string }).name).toBe('解除通知.jpg');
    // 无鉴权接口不该带出身份：整份回包里不能出现姓名或证件号
    const dump = JSON.stringify(seen);
    expect(dump).not.toContain('张三');
    expect(dump).not.toContain('110101199001011234');
  });

  test('与 lib/evidence.getVerification 逐字相同（同一份数据，不是另抄一份）', async () => {
    mockSidecarOk();
    const id = makeEvidence();
    const attested = await call('evidence_attest', userA, { evidence_ids: [id] });
    const orderNo = (attested.results as { order_no: string }[])[0].order_no;
    expect(await call('attest_verify', userA, { order_no: orderNo })).toEqual(
      evidence.getVerification(db, orderNo),
    );
  });

  test('不是本人的订单号照样能查（核验方本来就不该先注册账号）', async () => {
    mockSidecarOk();
    const id = makeEvidence();
    const attested = await call('evidence_attest', userA, { evidence_ids: [id] });
    const orderNo = (attested.results as { order_no: string }[])[0].order_no;

    const outsider = Number(
      db.prepare("INSERT INTO users (phone_hash, auth_status) VALUES ('h-x', '未认证')").run().lastInsertRowid,
    );
    const seen = await call('attest_verify', outsider, { order_no: orderNo });
    expect(seen.ok).toBe(true);
    expect(seen.order_no).toBe(orderNo);
  });

  test('查不到的订单号回 404，且与"存在但不是你的"不可分辨（本来就都能查，故只有一档）', async () => {
    const seen = await call('attest_verify', userA, { order_no: 'LAWER-ATT-20260905-deadbeefdeadbeef' });
    expect(seen.ok).toBe(false);
    expect(seen.errorCode).toBe('ORDER_NOT_FOUND');
    expect(await call('attest_verify', userA, { order_no: '   ' })).toMatchObject({
      errorCode: 'ORDER_NOT_FOUND',
    });
  });
});
