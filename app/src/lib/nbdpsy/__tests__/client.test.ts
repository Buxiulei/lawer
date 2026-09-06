// app/src/lib/nbdpsy/__tests__/client.test.ts
// NBDpsy 内部接口客户端（契约 T259 v1.3）的判据。
//
// 【判据 ↔ 变异臂】
//  1) 签名串 = `${ts}\n${raw_body}`：一条与文档算法一致的固定向量可复现，且只签体得到的是另一个值
//     «签名串丢掉 ts ⇒ 假对方按 `${ts}\n体` 重算，对不上 ⇒ 401»
//  2) 请求头 X-Source/X-Timestamp/X-Signature、体内带 16 字节 nonce：假对方全都校
//     «缺 nonce ⇒ 400 missing_nonce»
//  3) identity 按 v1.3 读 verified / id_number_masked（不再收全号）
//  4) referral 201 duplicate:false 与 200 duplicate:true 都算已送达，lead_id(数字)归一成 external_ref
//  5) 429 ⇒ reason=RATE_LIMITED（上层据此重试且不计尝试）；401/403/400 ⇒ BAD_RESPONSE 自述
import { createHmac } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createReferralLead,
  identityStatus,
  signRequest,
  type FetchImpl,
} from '../client';

const SECRET = 'test-shared-secret';
const BASE = 'http://127.0.0.1:8083';

const envBackup = {
  base: process.env.NBDPSY_INTERNAL_BASE,
  secret: process.env.NBDPSY_INTERNAL_SECRET,
};

beforeEach(() => {
  process.env.NBDPSY_INTERNAL_BASE = BASE;
  process.env.NBDPSY_INTERNAL_SECRET = SECRET;
});

afterEach(() => {
  if (envBackup.base === undefined) delete process.env.NBDPSY_INTERNAL_BASE;
  else process.env.NBDPSY_INTERNAL_BASE = envBackup.base;
  if (envBackup.secret === undefined) delete process.env.NBDPSY_INTERNAL_SECRET;
  else process.env.NBDPSY_INTERNAL_SECRET = envBackup.secret;
});

function jsonRes(status: number, obj: unknown): Response {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}

/**
 * 契约 v1.3 的「假对方」：**逐条按契约校** X-Source / 签名（`${ts}\n体`，ts±300s）/ nonce，
 * 任一不过就回对应错误码。客户端发得对才走得到业务回包——这才让上面的变异臂真的会红。
 */
function fakeServer(opts: {
  secret?: string;
  identityBody?: Record<string, unknown>;
  referralStatus?: number;
  referralBody?: Record<string, unknown>;
  /** 收到（且通过白名单校验的）转介体时回调，供判据核对拍平后的字段集与取值。 */
  onReferralBody?: (body: Record<string, unknown>) => void;
}): FetchImpl {
  const secret = opts.secret ?? SECRET;
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const h = new Headers(init?.headers);
    const body = String(init?.body ?? '');

    if (h.get('x-source') !== 'tubashu') return jsonRes(403, { ok: false, error: 'source_not_allowed' });

    const sig = h.get('x-signature');
    const tsHeader = h.get('x-timestamp');
    if (!sig || !tsHeader) return jsonRes(401, { ok: false, error: 'missing_signature' });

    const ts = Number(tsHeader);
    if (!Number.isFinite(ts) || Math.abs(Math.floor(Date.now() / 1000) - ts) > 300) {
      return jsonRes(401, { ok: false, error: 'invalid_signature' });
    }
    // 用**头里的 ts + 体逐字**重算：客户端若没把 ts 拼进签名串，这里就对不上
    if (sig !== signRequest(secret, tsHeader, body)) {
      return jsonRes(401, { ok: false, error: 'invalid_signature' });
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(body) as Record<string, unknown>;
    } catch {
      return jsonRes(400, { ok: false, error: 'invalid_body' });
    }
    if (typeof parsed.nonce !== 'string' || !/^[0-9a-f]{32}$/.test(parsed.nonce)) {
      return jsonRes(400, { ok: false, error: 'missing_nonce' });
    }

    if (u.endsWith('/api/internal/identity/v1/status')) {
      return jsonRes(200, opts.identityBody ?? { ok: true, found: false });
    }
    if (u.endsWith('/api/internal/leads/v1/referral')) {
      // deny_unknown_fields（契约 v1.3 §2）：字段集必须恰好是白名单，多一个就是 400。
      const allowed = new Set([
        'channel', 'name', 'phone', 'realname_status', 'emotional_summary', 'needs',
        'case_stage', 'urgency', 'consent_at', 'source_case_hash', 'nonce',
      ]);
      const extra = Object.keys(parsed).filter((k) => !allowed.has(k));
      if (extra.length > 0) return jsonRes(400, { ok: false, error: 'invalid_body' });
      opts.onReferralBody?.(parsed);
      return jsonRes(
        opts.referralStatus ?? 201,
        opts.referralBody ?? { ok: true, lead_id: 4242, duplicate: false },
      );
    }
    return jsonRes(404, { ok: false, error: 'not_found' });
  }) as unknown as FetchImpl;
}

// ───────────────────────── 1. 签名固定向量 ─────────────────────────

describe('signRequest：签名串 = `${ts}\\n${raw_body}`（契约 v1.3 §0）', () => {
  const ts = 1725580800;
  const rawBody = '{"phone":"13800138000","nonce":"0123456789abcdef0123456789abcdef"}';

  it('与文档算法一致的固定向量可复现', () => {
    expect(signRequest(SECRET, ts, rawBody)).toBe(
      'sha256=71698448c03e35378eda1e4fde8b6a2767f4390dd6db8c06998eda9d30c029f0',
    );
  });

  it('ts 确实进了签名串：只签体得到的是另一个值', () => {
    const onlyBody = `sha256=${createHmac('sha256', SECRET).update(rawBody, 'utf-8').digest('hex')}`;
    expect(signRequest(SECRET, ts, rawBody)).not.toBe(onlyBody);
  });
});

// ───────────────────────── 2. 假对方的校验有牙 ─────────────────────────
// 直接给假对方喂**畸形请求**，证明它真的会拦——否则上面的正例只是在跟一个永远放行的桩打交道。

describe('假对方按契约校验（变异臂）', () => {
  const goodBody = '{"phone":"13800138000","nonce":"0123456789abcdef0123456789abcdef"}';

  async function hitFake(headers: Record<string, string>, body: string): Promise<Response> {
    const f = fakeServer({});
    return f(`${BASE}/api/internal/identity/v1/status`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body,
    });
  }

  it('签名串不带 ts（只签体）⇒ 假对方 401', async () => {
    const ts = Math.floor(Date.now() / 1000);
    const onlyBody = `sha256=${createHmac('sha256', SECRET).update(goodBody, 'utf-8').digest('hex')}`;
    const res = await hitFake(
      { 'x-source': 'tubashu', 'x-timestamp': String(ts), 'x-signature': onlyBody },
      goodBody,
    );
    expect(res.status).toBe(401);
  });

  it('体里缺 nonce ⇒ 假对方 400', async () => {
    const ts = Math.floor(Date.now() / 1000);
    const noNonce = '{"phone":"13800138000"}';
    const res = await hitFake(
      { 'x-source': 'tubashu', 'x-timestamp': String(ts), 'x-signature': signRequest(SECRET, ts, noNonce) },
      noNonce,
    );
    expect(res.status).toBe(400);
  });

  it('签名与 nonce 都对 ⇒ 假对方放行到业务回包（对照：证明它不是永远拒）', async () => {
    const ts = Math.floor(Date.now() / 1000);
    const res = await hitFake(
      { 'x-source': 'tubashu', 'x-timestamp': String(ts), 'x-signature': signRequest(SECRET, ts, goodBody) },
      goodBody,
    );
    expect(res.status).toBe(200);
  });
});

// ───────────────────────── 3. identityStatus（读 v1.3 字段） ─────────────────────────

describe('identityStatus', () => {
  it('已实名：读 verified / id_number_masked（不再收全号）', async () => {
    const res = await identityStatus(
      '13800138000',
      fakeServer({
        identityBody: {
          ok: true,
          found: true,
          verified: true,
          customer_code: 'C-8899',
          real_name: '张三',
          id_type: 'id_card',
          id_number_masked: '1101**********1234',
          verified_at: '2026-08-01T10:00:00Z',
        },
      }),
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.approved).toBe(true);
      expect(res.idMasked).toBe('1101**********1234');
      expect(res.realName).toBe('张三');
      expect(res.customerCode).toBe('C-8899');
      expect(res.verifiedAt).toBe('2026-08-01T10:00:00Z');
    }
  });

  it('未找到：found:false ⇒ approved:false，字段全空', async () => {
    const res = await identityStatus(
      '13800138000',
      fakeServer({ identityBody: { ok: true, found: false } }),
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.approved).toBe(false);
      expect(res.idMasked).toBeNull();
      expect(res.realName).toBeNull();
    }
  });
});

// ───────────────────────── 4. createReferralLead（拍平成 v1.3 §2 体 + 201/200） ─────────────────────────

/** withPlainPhone 产物形态的转介数据包；**故意带上不该外发的字段**（source_system / referral_reason…）。 */
const PACKET: Record<string, unknown> = {
  source_system: 'tubashu',
  channel: 'tubashu',
  identity: {
    real_name: '张三',
    phone_masked: '138****8000',
    realname_status: '已实名',
    realname_source: 'nbdpsy',
    phone: '13800138000',
  },
  emotion_summary: '最近两周睡眠差、情绪低落，但愿意求助。',
  emotion_summary_redactions: 0,
  referral_reason: '想找人聊聊', // 不该外发
  needs: ['情绪支持', '睡眠'],
  stage_sentence: '已进入约谈阶段',
  urgency: { crisis_recent: true, crisis_hits_72h: 2 },
  consent_at: '2026-09-06 10:00:00',
  source_case_hash: 'abc123',
};

describe('createReferralLead：拍平成契约 v1.3 §2 白名单体', () => {
  it('只发白名单字段、字段名/取值都按契约拍平，deny_unknown_fields 严格比对通过', async () => {
    let sent: Record<string, unknown> | null = null;
    const res = await createReferralLead(
      PACKET,
      fakeServer({ onReferralBody: (b) => (sent = b) }),
    );
    expect(res.ok).toBe(true);
    expect(sent).not.toBeNull();
    const body = sent as unknown as Record<string, unknown>;
    // 字段集恰好是白名单（含 postSigned 补的 nonce），一个不多一个不少
    expect(new Set(Object.keys(body))).toEqual(
      new Set([
        'channel', 'name', 'phone', 'realname_status', 'emotional_summary', 'needs',
        'case_stage', 'urgency', 'consent_at', 'source_case_hash', 'nonce',
      ]),
    );
    // 拍平与改名
    expect(body.channel).toBe('tubashu');
    expect(body.name).toBe('张三');
    expect(body.phone).toBe('13800138000');
    expect(body.realname_status).toBe('已实名');
    expect(body.emotional_summary).toBe('最近两周睡眠差、情绪低落，但愿意求助。');
    expect(body.needs).toEqual(['情绪支持', '睡眠']);
    expect(body.case_stage).toBe('已进入约谈阶段');
    expect(body.urgency).toBe(2);
    expect(body.consent_at).toBe('2026-09-06T10:00:00Z'); // canonical → RFC3339
    expect(body.source_case_hash).toBe('abc123');
    // 不该外发的一律不在
    for (const leaked of ['source_system', 'referral_reason', 'identity', 'phone_masked', 'emotion_summary', 'stage_sentence', 'emotion_summary_redactions']) {
      expect(body[leaked], `不该外发的字段泄漏了：${leaked}`).toBeUndefined();
    }
  });

  it('201 duplicate:false ⇒ 已送达，lead_id 数字归一成 external_ref', async () => {
    const res = await createReferralLead(
      PACKET,
      fakeServer({ referralStatus: 201, referralBody: { ok: true, lead_id: 4242, duplicate: false } }),
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.externalRef).toBe('4242');
      expect(res.duplicate).toBe(false);
    }
  });

  it('200 duplicate:true ⇒ 同样算已送达', async () => {
    const res = await createReferralLead(
      PACKET,
      fakeServer({ referralStatus: 200, referralBody: { ok: true, lead_id: 77, duplicate: true } }),
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.externalRef).toBe('77');
      expect(res.duplicate).toBe(true);
    }
  });

  it('对照臂：体里多带一个字段 ⇒ 假对方 deny_unknown_fields 判 400（证明比对有牙）', async () => {
    const ts = Math.floor(Date.now() / 1000);
    const withExtra = '{"channel":"tubashu","source_case_hash":"x","nonce":"0123456789abcdef0123456789abcdef","referral_reason":"多带一个"}';
    const res = await fakeServer({})(`${BASE}/api/internal/leads/v1/referral`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-source': 'tubashu',
        'x-timestamp': String(ts),
        'x-signature': signRequest(SECRET, ts, withExtra),
      },
      body: withExtra,
    });
    expect(res.status).toBe(400);
  });
});

// ───────────────────────── 5. 错误码映射 ─────────────────────────

describe('错误体映射到 last_error 自述', () => {
  it('429 ⇒ reason=RATE_LIMITED（上层重试且不计尝试）', async () => {
    const res = await createReferralLead(
      { channel: 'tubashu' },
      (async () => jsonRes(429, { ok: false, error: 'rate_limited' })) as unknown as FetchImpl,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe('RATE_LIMITED');
      expect(res.message).toContain('429');
    }
  });

  it('密钥两边不一致 ⇒ 401 ⇒ BAD_RESPONSE，自述点到签名/密钥', async () => {
    const res = await createReferralLead(
      { channel: 'tubashu', phone: '13800138000' },
      fakeServer({ secret: '另一把不一样的密钥' }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe('BAD_RESPONSE');
      expect(res.message).toContain('401');
    }
  });

  it('来源不被认可 ⇒ 403 ⇒ BAD_RESPONSE，自述点到来源', async () => {
    const res = await createReferralLead(
      { channel: 'tubashu' },
      (async () => jsonRes(403, { ok: false, error: 'source_not_allowed' })) as unknown as FetchImpl,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe('BAD_RESPONSE');
      expect(res.message).toContain('403');
    }
  });
});
