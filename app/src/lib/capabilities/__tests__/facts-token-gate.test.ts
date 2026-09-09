// app/src/lib/capabilities/__tests__/facts-token-gate.test.ts
// facts_token 闸的**接线**判据（设计稿 §4.2-4 / §4.4-1）：三臂各一条 + 错误体夹事实卡 +
// 名单与注册表一致 + 低危写不挂闸 + 重放豁免 + 写路径的档位落库。
//
// 与 lib/cases/__tests__/facts-token.test.ts 的分工：那份测的是核验函数本身（纯逻辑），
// 这份测的是「它真的挂在这四条能力上、拦下来的时候零写入、错误体里有出路」。
import BetterSqlite3, { type Database } from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Identity } from '@/lib/auth/identity';
import { factsCardFor } from '@/lib/agent';
import { FACTS_TOKEN_TOOLS, issueFactsToken } from '@/lib/cases/facts-token';
import { runMigrations } from '@/lib/db/migrate';

import { CAPABILITIES, getCapability } from '..';
import { invokeCapability } from '../invoke';

let db: Database;
let caseId: number;
let identity: Identity;

const AGENT: Omit<Identity, 'uid'> = { via: 'api_key', scopes: ['case:read', 'case:write'], keyId: 9 };

beforeEach(() => {
  db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const uid = Number(
    db.prepare("INSERT INTO users (phone_hash, auth_status) VALUES ('h', '已实名')").run().lastInsertRowid,
  );
  caseId = Number(
    db.prepare("INSERT INTO cases (user_id, title, stage) VALUES (?, ?, '已收通知')").run(uid, '本人的案子')
      .lastInsertRowid,
  );
  // agent_writes.key_id 是真外键：拿一个不存在的 id 会在写台账那一步撞 FK，
  // 而那个报错离病因隔着好几层。所以夹具里发一把真的 key。
  const keyId = Number(
    db
      .prepare(
        "INSERT INTO api_keys (user_id, name, key_hash, scopes, enabled) VALUES (?, 'k', 'h', '[\"case:read\",\"case:write\"]', 1)",
      )
      .run(uid).lastInsertRowid,
  );
  identity = { uid, ...AGENT, keyId };
});

const freshToken = () => issueFactsToken(factsCardFor(db, caseId));
const call = (name: string, args: Record<string, unknown>) =>
  invokeCapability(db, identity, name, { case_id: caseId, ...args });
const countClaims = () =>
  (db.prepare('SELECT COUNT(*) AS n FROM claims').get() as { n: number }).n;

describe('注册表接线：名单与 precondition 逐字相等', () => {
  it('挂 facts_token 的能力恰好是 FACTS_TOKEN_TOOLS（变异：给某条能力去掉 precondition → 红）', () => {
    // 名单住在 lib/cases/facts-token（零依赖，站内工具循环要用它，从注册表现算会成环）。
    // 两处漂开时当场红，而不是等某条能力悄悄脱闸。
    const gated = CAPABILITIES.filter((c) => c.precondition.includes('facts_token')).map((c) => c.name);
    expect(gated.sort()).toEqual([...FACTS_TOKEN_TOOLS].sort());
  });

  it('低危高频写**不挂闸**（变异：给 timeline_add 挂上 → 红：模型会干脆不记）', () => {
    for (const name of ['timeline_add', 'emotion_log', 'action_create', 'company_profile_upsert']) {
      expect(getCapability(name)!.precondition, name).not.toContain('facts_token');
    }
  });

  it('case_update 只在 stage 那个入参上开闸（变异：删掉 factsTokenArgs → 补一个岗位名也要先读档）', () => {
    expect(getCapability('case_update')!.factsTokenArgs).toEqual(['stage']);
    // 其余三条恒开（没有 factsTokenArgs）
    for (const name of ['claims_upsert', 'deadline_set', 'draft_write']) {
      expect(getCapability(name)!.factsTokenArgs, name).toBeUndefined();
    }
  });

  it('四条的 inputSchema 里都有 facts_token 这一格（变异：漏掉一条 → 对方 agent 读不到该带什么）', () => {
    for (const name of FACTS_TOKEN_TOOLS) {
      const props = getCapability(name)!.inputSchema.properties as Record<string, unknown>;
      expect(props.facts_token, name).toBeDefined();
    }
  });
});

describe('三臂：缺 / 过期 / 有效', () => {
  const claimArgs = { kind: '欠薪', amount_fen: 12_300 };

  it('① 缺 ⇒ FACTS_STALE 且**零写入**（变异：把 checkFactsToken 从 checkPreconditions 摘掉 → 红）', async () => {
    const res = await call('claims_upsert', claimArgs);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errorCode).toBe('FACTS_STALE');
    expect(res.status).toBe(409);
    expect(countClaims(), '闸拦下时一条都不许落库').toBe(0);
  });

  it('② 过期 ⇒ FACTS_STALE（变异：把 TTL 判定删掉 → 红）', async () => {
    const stale = issueFactsToken(factsCardFor(db, caseId), new Date(Date.now() - 11 * 60_000));
    const res = await call('claims_upsert', { ...claimArgs, facts_token: stale });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errorCode).toBe('FACTS_STALE');
    expect(countClaims()).toBe(0);
  });

  it('③ 有效 ⇒ 照常写入（变异：把闸写成恒拒 → 红，这一条证明它不是一道死闸）', async () => {
    const res = await call('claims_upsert', { ...claimArgs, facts_token: freshToken() });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(countClaims()).toBe(1);
  });

  it('④ 档案在读过之后变了 ⇒ 同样 FACTS_STALE（变异：只判时间不判哈希 → 红）', async () => {
    const token = freshToken();
    // 用一条**不挂闸**的写能力把档案改掉（这正是设计里允许的顺序）
    const added = await call('timeline_add', {
      happened_at: '2026-09-01T10:00:00+08:00',
      kind: '公司动作',
      title: '收到解除通知',
    });
    expect(added.ok).toBe(true);

    const res = await call('claims_upsert', { ...claimArgs, facts_token: token });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errorCode).toBe('FACTS_STALE');
    expect(countClaims()).toBe(0);
  });
});

describe('禁令配出路：错误体里夹最新事实卡与一枚新令牌', () => {
  it('错误体带 case_facts + facts_token，且那枚新令牌当场就能用（变异：只回一句「令牌过期」 → 红）', async () => {
    const res = await call('claims_upsert', { kind: '欠薪', amount_fen: 12_300 });
    expect(res.ok).toBe(false);
    if (res.ok) return;

    const extra = res.extra as { case_facts?: string; facts_token?: string };
    expect(typeof extra.case_facts).toBe('string');
    expect(extra.case_facts).toContain('案件事实卡');
    expect(typeof extra.facts_token).toBe('string');

    // 一次重试就该成功——三段式里的「怎么办」必须真的走得通
    const retry = await call('claims_upsert', {
      kind: '欠薪',
      amount_fen: 12_300,
      facts_token: extra.facts_token,
    });
    expect(retry.ok, JSON.stringify(retry)).toBe(true);
  });

  it('message 是三段式：缺什么 / 为什么缺 / 怎么办（变异：删掉「怎么办」那一段 → 红）', async () => {
    const res = await call('deadline_set', { kind: '仲裁时效', anchor_date: '2026-08-20' });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toContain('没有写入任何东西');
    expect(res.message).toContain('缺 facts_token');
    expect(res.message).toContain('怎么办');
  });
});

describe('case_update：只有 stage 触发闸', () => {
  it('只改 goal 不必带令牌（变异：把 factsTokenArgs 删掉 → 红）', async () => {
    const res = await call('case_update', { goal: '拿到 2N' });
    expect(res.ok, JSON.stringify(res)).toBe(true);
  });

  it('改 stage 缺令牌 ⇒ FACTS_STALE 且 stage 没动（变异：把 stage 从 factsTokenArgs 里摘掉 → 红）', async () => {
    const before = (db.prepare('SELECT stage FROM cases WHERE id = ?').get(caseId) as { stage: string }).stage;
    const res = await call('case_update', { stage: '仲裁准备' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errorCode).toBe('FACTS_STALE');
    expect((db.prepare('SELECT stage FROM cases WHERE id = ?').get(caseId) as { stage: string }).stage).toBe(
      before,
    );
  });

  it('改 stage 带上令牌就通（变异：把闸写成恒拒 → 红）', async () => {
    const res = await call('case_update', { stage: '仲裁准备', facts_token: freshToken() });
    expect(res.ok, JSON.stringify(res)).toBe(true);
  });
});

describe('重放豁免：同一个 client_ref 的第二次不再被闸拦', () => {
  it('第一次带令牌成功、第二次拿同一份参数重放 ⇒ deduped，不是 FACTS_STALE（变异：删掉 isKnownReplay 那一句 → 红）', async () => {
    const payload = {
      kind: '仲裁时效',
      anchor_date: '2026-08-20',
      client_ref: 'ref-1',
      facts_token: freshToken(),
    };
    const first = await call('deadline_set', payload);
    expect(first.ok, JSON.stringify(first)).toBe(true);

    // 网络抖动之后按幂等约定重发**同一份参数**——那枚令牌已经被第一次写入弄失效了。
    // 不豁免的形态是：对方拿到 FACTS_STALE，而它读起来像"你的认知过期了"，
    // 会诱使模型去改内容重发——那才是真正危险的下一步。
    const second = await call('deadline_set', payload);
    expect(second.ok, JSON.stringify(second)).toBe(true);
    if (second.ok) expect(second.value.deduped).toBe(true);
    expect((db.prepare('SELECT COUNT(*) AS n FROM deadlines').get() as { n: number }).n).toBe(1);
  });

  it('没写过的 client_ref 不豁免（变异：把豁免写成"只要带了 client_ref 就放行" → 红：一句 ref 就绕开整道闸）', async () => {
    const res = await call('deadline_set', {
      kind: '仲裁时效',
      anchor_date: '2026-08-20',
      client_ref: 'never-used',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errorCode).toBe('FACTS_STALE');
  });
});

describe('写路径落档位：档位收声明，断言人按身份判', () => {
  it('agent 经 API 写的时间线记 agent_inferred（变异：把 assertedByOf 改成恒 user → 红：展示层不再标黄）', async () => {
    await call('timeline_add', {
      happened_at: '2026-09-01T10:00:00+08:00',
      kind: '公司动作',
      title: '收到解除通知',
      source_tier: '书证',
    });
    const row = db.prepare('SELECT source_tier, asserted_by FROM timeline_events WHERE case_id = ?').get(caseId);
    expect(row).toEqual({ source_tier: '书证', asserted_by: 'agent_inferred' });
  });

  it('网页登录态写的记 user（变异：同上 → 红）', async () => {
    const web: Identity = { uid: identity.uid, via: 'jwt', scopes: ['case:read', 'case:write'] };
    await invokeCapability(db, web, 'timeline_add', {
      case_id: caseId,
      happened_at: '2026-09-02T10:00:00+08:00',
      kind: '我方动作',
      title: '发出异议函',
    });
    const row = db
      .prepare("SELECT source_tier, asserted_by FROM timeline_events WHERE title = '发出异议函'")
      .get();
    expect(row).toEqual({ source_tier: '自述', asserted_by: 'user' });
  });

  it('不认识的档位一律拒收，不静默折成缺省档（变异：认不出时落自述 → 红）', async () => {
    const res = await call('timeline_add', {
      happened_at: '2026-09-03T10:00:00+08:00',
      kind: '公司动作',
      title: '档位写错的一条',
      source_tier: '书面证据',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errorCode).toBe('INVALID_SOURCE_TIER');
    expect((db.prepare('SELECT COUNT(*) AS n FROM timeline_events').get() as { n: number }).n).toBe(0);
  });

  it('claims_upsert 的档位随入参落库（变异：把 origin 丢掉 → 落 DDL 缺省档 → 红）', async () => {
    await call('claims_upsert', {
      kind: '欠薪',
      amount_fen: 12_300,
      source_tier: '对方认可',
      facts_token: freshToken(),
    });
    expect(db.prepare('SELECT source_tier, asserted_by FROM claims WHERE case_id = ?').get(caseId)).toEqual({
      source_tier: '对方认可',
      asserted_by: 'agent_inferred',
    });
  });
});

describe('读能力签发令牌', () => {
  it('case_facts 回包同时给事实卡与令牌，且那枚令牌当场可用（变异：不签令牌 → 对方每次写都要再读一遍）', async () => {
    const res = await invokeCapability(db, identity, 'case_facts', { case_id: caseId });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(typeof res.value.facts_token).toBe('string');
    const write = await call('claims_upsert', {
      kind: '欠薪',
      amount_fen: 1,
      facts_token: res.value.facts_token,
    });
    expect(write.ok, JSON.stringify(write)).toBe(true);
  });

  it('case_report_get 也签一枚（变异：只让 case_facts 签 → 照说明书先读报告的 agent 要多跑一轮）', async () => {
    const res = await invokeCapability(db, identity, 'case_report_get', { case_id: caseId });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    if (!res.ok) return;
    expect(typeof res.value.facts_token).toBe('string');
  });
});
