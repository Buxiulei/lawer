/**
 * 转介 NBDpsy（设计稿 §14）的判据。
 *
 * 【判据 ↔ 变异臂】
 *  1) consent 缺 ⇒ 拒，且**零写入**（referrals 与 agent_writes 都数行数）
 *     «去掉 consent 检查 ⇒ 红»：那条会落库、状态 pending。
 *     只看返回值的判据挡不住"先插入再报错"，而那正是最像成功的失败。
 *  2) 数据包不含公司名与案情：模型返回的摘要里**故意带着公司全称与案情词**，
 *     断言过滤后一个字都没留下，且整份数据包里搜不到公司名
 *     «摘要不过滤（sanitizeNeutral 换成恒等）⇒ 红»。
 *     单变量对照：同一段原文先断言它本来带着公司名，再断言产物里没有。
 *  3) 未接通（缺 env）⇒ 留 pending 且 last_error 自述三段式，**attempts 不加**
 *     «把 NOT_CONNECTED 也记成一次尝试 ⇒ 红»（跑满 MAX_SEND_ATTEMPTS 轮后会变 failed）。
 *  4) 假对方回 200 ⇒ sent + external_ref；且发出去的体带手机明文、
 *     签名是 sha256=hex(HMAC(secret, 体原文))、而**库里那份没有明文手机号**
 *     «把明文手机号一起落库 ⇒ 红»。
 *  5) 实名互认：假对方 approved ⇒ 本地落一条 provider=nbdpsy 的快照，
 *     证件号**只有掩码**（对方即使回全号也当场再掩一次），且 requireRealname 放行
 *     «快照存证件号明文（把 ensureMasked 去掉）⇒ 红»。
 *  6) 对方不可用 ⇒ 按未实名（requireRealname 仍然拒）。
 */
import crypto from 'node:crypto';

import Database from 'better-sqlite3';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { requireRealname } from '@/lib/auth/guard';
import type { Identity } from '@/lib/auth/identity';
import { getCapability } from '@/lib/capabilities';
import { decryptField, encryptField, hashLookup } from '@/lib/crypto';
import { runMigrations } from '@/lib/db/migrate';
import * as referralStore from '@/lib/db/referrals';
import * as realnameStore from '@/lib/db/realname';
import { MAX_SEND_ATTEMPTS, runReferralQueue } from '@/lib/jobs/referral-worker';
import { signBody } from '@/lib/nbdpsy/client';

import { adoptNbdpsyRealname, type NbdpsySnapshot } from '../identity-link';
import { createReferral } from '..';
import { findForbidden } from '../neutral';
import type { SummaryLlm } from '../packet';

const PHONE = '13800138000';
const COMPANY = '蓝海科技有限公司';
const SECRET = 'test-shared-secret';

/** 模型写出来的那段——**故意带着公司全称、字号与案情词**。判据 2 的原料。 */
const LEAKY_SUMMARY =
  `他这两周因为${COMPANY}的裁员一直失眠，反复跟我确认仲裁能不能赢，` +
  '也提到蓝海拖欠的工资让他很焦虑，情绪明显低落，但仍愿意求助。';

function leakyLlm(): SummaryLlm {
  return { chatJSON: async () => JSON.stringify({ summary: LEAKY_SUMMARY }) };
}

let db: Database.Database;
let uid: number;
let caseId: number;
let identity: Identity;

const envBackup = {
  base: process.env.NBDPSY_INTERNAL_BASE,
  secret: process.env.NBDPSY_INTERNAL_SECRET,
};

beforeAll(() => {
  process.env.LAWER_DATA_KEY = crypto.randomBytes(32).toString('base64');
});

beforeEach(() => {
  delete process.env.NBDPSY_INTERNAL_BASE;
  delete process.env.NBDPSY_INTERNAL_SECRET;

  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);

  uid = Number(
    db
      .prepare('INSERT INTO users (phone_enc, phone_hash) VALUES (?, ?)')
      .run(encryptField(PHONE), hashLookup(PHONE)).lastInsertRowid,
  );
  const keyId = Number(
    db
      .prepare(
        "INSERT INTO api_keys (user_id, name, key_hash, scopes) VALUES (?, '测试钥匙', 'kh', '[\"case:read\",\"case:write\"]')",
      )
      .run(uid).lastInsertRowid,
  );
  identity = { uid, via: 'api_key', scopes: ['case:read', 'case:write'], keyId };

  // stage 刻意选一个词表里没有的档（判据 2 要断言整份数据包搜不到禁用词，
  // 而阶段一句话是**允许**带流程措辞的，混在一起会让那条判据说不清自己在验什么）
  caseId = Number(
    db
      .prepare("INSERT INTO cases (user_id, title, stage) VALUES (?, '我的案件', '约谈中')")
      .run(uid).lastInsertRowid,
  );
  db.prepare('INSERT INTO company_profiles (case_id, name) VALUES (?, ?)').run(caseId, COMPANY);
  db.prepare("INSERT INTO emotion_log (case_id, level, note) VALUES (?, '焦虑', ?)").run(
    caseId,
    '半夜三点还醒着',
  );
});

afterEach(() => {
  if (envBackup.base === undefined) delete process.env.NBDPSY_INTERNAL_BASE;
  else process.env.NBDPSY_INTERNAL_BASE = envBackup.base;
  if (envBackup.secret === undefined) delete process.env.NBDPSY_INTERNAL_SECRET;
  else process.env.NBDPSY_INTERNAL_SECRET = envBackup.secret;
  db.close();
});

function count(table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

function connect(): void {
  process.env.NBDPSY_INTERNAL_BASE = 'http://127.0.0.1:9999';
  process.env.NBDPSY_INTERNAL_SECRET = SECRET;
}

// ───────────────────────── 1. 同意闸 ─────────────────────────

describe('同意闸', () => {
  it('缺 consent ⇒ CONSENT_REQUIRED，且 referrals 与 agent_writes 都零行', async () => {
    const cap = getCapability('referral_create')!;
    const out = (await cap.run(db, identity, { case_id: caseId, reason: '睡不着' })) as {
      ok: boolean;
      errorCode: string;
    };
    expect(out.ok).toBe(false);
    expect(out.errorCode).toBe('CONSENT_REQUIRED');
    expect(count('referrals'), '拒绝的调用不许留下台账行').toBe(0);
    expect(count('agent_writes'), '拒绝的调用不许记进写入台账').toBe(0);
  });

  it('consent 传字符串 "true" 也算没给（只认布尔真）', async () => {
    const cap = getCapability('referral_create')!;
    const out = (await cap.run(db, identity, {
      case_id: caseId,
      consent: 'true',
    })) as { ok: boolean; errorCode: string };
    expect(out.errorCode).toBe('CONSENT_REQUIRED');
    expect(count('referrals')).toBe(0);
  });

  it('consent:true ⇒ 落一条 pending，回 {referral_id, status}', async () => {
    const cap = getCapability('referral_create')!;
    const out = (await cap.run(db, identity, {
      case_id: caseId,
      consent: true,
      needs: ['情绪疏导', '睡眠'],
    })) as { ok: boolean; referral_id: number; status: string };
    expect(out.ok).toBe(true);
    expect(out.status).toBe('pending');
    expect(count('referrals')).toBe(1);
    expect(referralStore.findReferralById(db, out.referral_id)?.consent_at).toBeTruthy();
  });

  it('同一个 client_ref 重放不双写', async () => {
    const cap = getCapability('referral_create')!;
    const args = { case_id: caseId, consent: true, client_ref: 'ref-1' };
    await cap.run(db, identity, args);
    const again = (await cap.run(db, identity, args)) as { deduped?: boolean };
    expect(again.deduped).toBe(true);
    expect(count('referrals'), '重放不许再落一条').toBe(1);
  });

  it('别人的案件一律 CASE_NOT_FOUND，零写入', async () => {
    const other = Number(
      db.prepare("INSERT INTO users (phone_hash) VALUES ('hash-b')").run().lastInsertRowid,
    );
    const cap = getCapability('referral_create')!;
    const out = (await cap.run(
      db,
      { uid: other, via: 'api_key', scopes: ['case:write'] } as Identity,
      { case_id: caseId, consent: true },
    )) as { ok: boolean; errorCode: string };
    expect(out.errorCode).toBe('CASE_NOT_FOUND');
    expect(count('referrals')).toBe(0);
  });
});

// ───────────────────────── 2. 数据包中立化 ─────────────────────────

describe('数据包不含公司名与案情', () => {
  it('模型把公司名写进摘要 ⇒ 产物里一个字都没有（变异：过滤换成恒等 ⇒ 红）', async () => {
    // 单变量对照的另一臂：这段原文**确实**带着公司名与案情词。
    expect(LEAKY_SUMMARY).toContain(COMPANY);
    expect(LEAKY_SUMMARY).toContain('裁员');

    const created = await createReferral(db, {
      caseId,
      userId: uid,
      reason: `被${COMPANY}裁掉之后一直缓不过来`,
      needs: [`跟${COMPANY}的事无关，就是想睡个好觉`],
      consent: true,
      llm: leakyLlm(),
    });
    if (created.ok !== true) throw new Error(`建包失败：${created.message}`);
    const p = created.packet;

    for (const term of [COMPANY, '蓝海', '裁员', '仲裁', '工资']) {
      expect(p.emotion_summary, `摘要里不该有「${term}」`).not.toContain(term);
    }
    expect(p.referral_reason, 'reason 走同一道过滤').not.toContain('蓝海');
    expect(p.needs.join(''), 'needs 走同一道过滤').not.toContain('蓝海');
    // 整份数据包（含落库的 JSON）都搜不到公司名
    expect(JSON.stringify(p)).not.toContain('蓝海');
    // 只记「挡了几个」，不记「挡的是哪几个」——记词的话公司全名会原样躺在
    // 同一份要发出去的数据里（这条判据 2026-09-06 真的撞到过）
    expect(p.emotion_summary_redactions).toBeGreaterThan(0);
    expect(JSON.stringify(p)).not.toContain('裁员');

    // 落库那份同样干净
    const row = referralStore.findReferralById(db, created.referral_id)!;
    expect(row.payload_json).not.toContain('蓝海');
  });

  it('摘要截到 200 字以内，且截断发生在过滤之后', async () => {
    const long = { chatJSON: async () => JSON.stringify({ summary: '很难受。'.repeat(200) }) };
    const created = await createReferral(db, {
      caseId,
      userId: uid,
      reason: '',
      needs: [],
      consent: true,
      llm: long,
    });
    if (created.ok !== true) throw new Error('建包失败');
    expect(Array.from(created.packet.emotion_summary).length).toBeLessThanOrEqual(200);
  });

  it('没有模型时回落到按记录统计的兜底摘要，而不是一句「暂无」', async () => {
    const created = await createReferral(db, {
      caseId,
      userId: uid,
      reason: '',
      needs: [],
      consent: true,
    });
    if (created.ok !== true) throw new Error('建包失败');
    expect(created.packet.emotion_summary).toContain('焦虑');
    expect(findForbidden(created.packet.emotion_summary)).toEqual([]);
  });

  it('落库的数据包只有掩码手机号，没有明文', async () => {
    const created = await createReferral(db, {
      caseId,
      userId: uid,
      reason: '',
      needs: [],
      consent: true,
    });
    if (created.ok !== true) throw new Error('建包失败');
    expect(created.packet.identity.phone_masked).toBe('138****8000');
    const row = referralStore.findReferralById(db, created.referral_id)!;
    expect(row.payload_json, '库里不许出现手机明文').not.toContain(PHONE);
  });

  it('紧迫度数的是近 72 小时的 crisis_hits（变异：packet 改回数 timeline ⇒ 红）', async () => {
    // 只落 crisis_hits、不落时间线卡留痕：若 packet 退回去数 timeline，这里会数出 0 ⇒ 红。
    db.prepare(
      "INSERT INTO crisis_hits (case_id, user_id, source, terms_hash, at) VALUES (?,?,?,?, datetime('now','-1 hours'))",
    ).run(caseId, uid, 'site', 'x'.repeat(64));
    db.prepare(
      "INSERT INTO crisis_hits (case_id, user_id, source, terms_hash, at) VALUES (?,?,?,?, datetime('now','-10 days'))",
    ).run(caseId, uid, 'site', 'y'.repeat(64));
    const created = await createReferral(db, {
      caseId,
      userId: uid,
      reason: '',
      needs: [],
      consent: true,
    });
    if (created.ok !== true) throw new Error('建包失败');
    expect(created.packet.urgency).toEqual({ crisis_recent: true, crisis_hits_72h: 1 });
  });
});

// ───────────────────────── 3/4. 发送队列 ─────────────────────────

async function seedPending(): Promise<number> {
  const created = await createReferral(db, {
    caseId,
    userId: uid,
    reason: '',
    needs: [],
    consent: true,
  });
  if (created.ok !== true) throw new Error('建包失败');
  return created.referral_id;
}

describe('发送队列', () => {
  it('未接通 ⇒ 留 pending、last_error 自述三段式、attempts 不加（变异：把它记成一次尝试 ⇒ 红）', async () => {
    const id = await seedPending();
    // 缺 env ⇒ 真实客户端直接回 NOT_CONNECTED，不发任何请求
    for (let i = 0; i < MAX_SEND_ATTEMPTS + 2; i += 1) await runReferralQueue(db);

    const row = referralStore.findReferralById(db, id)!;
    expect(row.status, '没接通不该把用户的转介判死').toBe('pending');
    expect(row.attempts).toBe(0);
    expect(row.last_error).toContain('还没接通');
    expect(row.last_error).toContain('为什么');
    expect(row.last_error).toContain('怎么办');
  });

  it('假对方 200 ⇒ sent + external_ref，且签名与手机明文都对', async () => {
    connect();
    const id = await seedPending();

    const seen: { url: string; signature: string | null; body: string }[] = [];
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const body = String(init?.body ?? '');
      seen.push({
        url: String(url),
        signature: new Headers(init?.headers).get('x-signature'),
        body,
      });
      return new Response(JSON.stringify({ lead_id: 'LEAD-42' }), { status: 200 });
    }) as unknown as typeof fetch;

    const tick = await runReferralQueue(db, {
      send: (payload) =>
        import('@/lib/nbdpsy/client').then((m) => m.createReferralLead(payload, fakeFetch)),
    });
    expect(tick.sent).toBe(1);

    const row = referralStore.findReferralById(db, id)!;
    expect(row.status).toBe('sent');
    expect(row.external_ref).toBe('LEAD-42');
    expect(row.last_error).toBeNull();

    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe('http://127.0.0.1:9999/api/internal/leads/referral');
    expect(seen[0].signature, '签名必须算在逐字的请求体上').toBe(signBody(SECRET, seen[0].body));
    // 发出去的那份带手机明文（对方按手机号匹配），而库里那份没有
    expect(JSON.parse(seen[0].body).identity.phone).toBe(PHONE);
    expect(referralStore.findReferralById(db, id)!.payload_json).not.toContain(PHONE);
  });

  it('对方回 200 但不给线索 id ⇒ 不记成已送达，留 pending 重试', async () => {
    connect();
    const id = await seedPending();
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200 })) as unknown as typeof fetch;
    await runReferralQueue(db, {
      send: (p) => import('@/lib/nbdpsy/client').then((m) => m.createReferralLead(p, fakeFetch)),
    });
    const row = referralStore.findReferralById(db, id)!;
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(1);
    expect(row.last_error).toContain('没回线索 id');
  });

  it('对方持续 500 ⇒ 攒够次数后置 failed', async () => {
    connect();
    const id = await seedPending();
    const fakeFetch = (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch;
    for (let i = 0; i < MAX_SEND_ATTEMPTS; i += 1) {
      await runReferralQueue(db, {
        send: (p) => import('@/lib/nbdpsy/client').then((m) => m.createReferralLead(p, fakeFetch)),
      });
    }
    const row = referralStore.findReferralById(db, id)!;
    expect(row.status).toBe('failed');
    expect(row.attempts).toBe(MAX_SEND_ATTEMPTS);
    expect(row.last_error).toContain('HTTP 500');
  });

  it('已 sent 的不会被再发一遍', async () => {
    connect();
    const id = await seedPending();
    referralStore.markSent(db, id, 'LEAD-1');
    const tick = await runReferralQueue(db, {
      send: async () => {
        throw new Error('不该被调用');
      },
    });
    expect(tick).toEqual({ sent: 0, failed: 0, deferred: 0 });
  });
});

// ───────────────────────── 5/6. 实名互认 ─────────────────────────

/** 对方的回包：**故意同时给全号 id_masked 与一个明文键**，看我们收哪个、又掩没掩。 */
const FULL_ID = '110101199001011234';

function identityFetch(body: Record<string, unknown>): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
}

describe('实名互认（读侧）', () => {
  it('对方 approved ⇒ 落 provider=nbdpsy 快照，证件号只有掩码（变异：存明文 ⇒ 红）', async () => {
    connect();
    const ok = await adoptNbdpsyRealname(
      db,
      uid,
      identityFetch({
        verified: true,
        real_name: '张三',
        id_type: 'idcard',
        id_masked: FULL_ID, // 对方即使回了全号
        id_no: FULL_ID, // 甚至另给一个明文键
        verified_at: '2026-08-01T10:00:00Z',
        customer_code: 'C-8899',
      }),
    );
    expect(ok).toBe(true);

    const row = realnameStore.latestByUser(db, uid)!;
    expect(row.provider).toBe('nbdpsy');
    expect(row.status).toBe('已实名');
    expect(row.cert_no, '那一列不放证件号').toBeNull();

    const snapshot = JSON.parse(decryptField(row.raw_meta_enc!)) as NbdpsySnapshot;
    expect(snapshot.id_masked).toContain('*');
    expect(snapshot.id_masked).not.toBe(FULL_ID);
    expect(JSON.stringify(snapshot), '快照里不许有证件号明文').not.toContain(FULL_ID);
    expect(snapshot.customer_code).toBe('C-8899');
    expect(snapshot.verified_at).toBe('2026-08-01T10:00:00Z');

    const user = db
      .prepare('SELECT auth_status, real_name_enc, linked_nbdpsy_customer_code FROM users WHERE id=?')
      .get(uid) as {
      auth_status: string;
      real_name_enc: string | null;
      linked_nbdpsy_customer_code: string | null;
    };
    expect(user.auth_status).toBe('已实名');
    expect(decryptField(user.real_name_enc!)).toBe('张三');
    expect(user.linked_nbdpsy_customer_code).toBe('C-8899');
  });

  it('对方没通过 ⇒ 不写任何东西', async () => {
    connect();
    const ok = await adoptNbdpsyRealname(db, uid, identityFetch({ verified: false }));
    expect(ok).toBe(false);
    expect(count('realname_verifications')).toBe(0);
    expect(
      (db.prepare('SELECT auth_status FROM users WHERE id=?').get(uid) as { auth_status: string })
        .auth_status,
    ).toBe('未认证');
  });

  it('没接通 ⇒ 一律按未实名，requireRealname 仍然拒', async () => {
    const gate = await requireRealname(db, identity);
    expect(gate.ok).toBe(false);
    expect(count('realname_verifications')).toBe(0);
  });

  it('接通且对方 approved ⇒ requireRealname 当场放行（走同一道判定入口）', async () => {
    connect();
    const original = globalThis.fetch;
    globalThis.fetch = identityFetch({
      verified: true,
      real_name: '张三',
      id_masked: '1101**********1234',
      customer_code: 'C-1',
    });
    try {
      const gate = await requireRealname(db, identity);
      expect(gate.ok).toBe(true);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('对方连不上 ⇒ 按未实名，不抛错', async () => {
    connect();
    const boom = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    expect(await adoptNbdpsyRealname(db, uid, boom)).toBe(false);
    expect(count('realname_verifications')).toBe(0);
  });
});
