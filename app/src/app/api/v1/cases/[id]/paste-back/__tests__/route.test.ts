// 无工具模式回填两条路由的判据（设计稿 §15 路径 D ③）。
//
// 【变异臂（手工跑过，2026-09-06）】
//  ① lib/paste/apply.ts 里去掉 client_ref ⇒「重放同一批零双写」当场红（时间线多一条、行动卡多一张）。
//  ② lib/paste/index.ts 里把 crisisNotice 换成恒 {triggered:false} ⇒「危机命中带提示与号码」红。
//  ③ 预览里加一次写库 ⇒「预览零新增」红。
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, beforeEach, describe, expect, test } from 'vitest';
import type { Database } from 'better-sqlite3';

import { generateApiKey, hashApiKey } from '@/lib/auth/api-key';
import { signToken } from '@/lib/auth/jwt';
import { FENCE_TAG } from '@/lib/paste';

type Handler = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

let preview: Handler;
let confirm: Handler;
let opener: Handler;
let db: Database;
let userA: number;
let userB: number;
let caseA: number;

const ctx = (id: number) => ({ params: Promise.resolve({ id: String(id) }) });

function post(auth: string, body: unknown, url = 'http://localhost/api/v1/cases/1/paste-back'): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${auth}` },
    body: JSON.stringify(body),
  });
}

/** 五张会被回填写到的表 + 幂等台账，逐张数行数 */
function counts(): Record<string, number> {
  const one = (t: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
  return {
    timeline_events: one('timeline_events'),
    action_items: one('action_items'),
    claims: one('claims'),
    deadlines: one('deadlines'),
    agent_writes: one('agent_writes'),
  };
}

const BLOCK = {
  timeline: [
    { happened_at: '2026-09-01T10:00:00+08:00', kind: '公司动作', title: 'HR 第一次约谈', detail: '提出协商解除' },
  ],
  actions: [
    { what: '导出考勤记录', how: '打开 OA→我的考勤→导出→发到个人邮箱', why: '离职后打不开 OA', due_at: '2026-09-02T18:00:00+08:00' },
  ],
  claims: [{ kind: '欠薪', amount_yuan: 0, basis: '用户自述 8 月工资未发' }],
  deadlines: [{ kind: '举证期限', anchor_date: '2026-09-01', days: 10 }],
};

const reply = (block: unknown, tail = '') =>
  ['先说结论：明天之前把考勤导出来。', '```' + FENCE_TAG, JSON.stringify(block), '```', tail].join('\n');

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';
  process.env.LAWER_DATA_KEY = crypto.randomBytes(32).toString('base64');
  process.env.DB_PATH = path.join(os.tmpdir(), `lawer-paste-${crypto.randomUUID()}.db`);

  preview = (await import('../route')).POST;
  confirm = (await import('../confirm/route')).POST;
  opener = (await import('../../opener/route')).GET;
  db = (await import('@/lib/db/client')).getDb();
});

beforeEach(() => {
  for (const t of ['agent_writes', 'timeline_events', 'action_items', 'claims', 'deadlines', 'api_keys', 'cases', 'users']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
  const insertUser = db.prepare("INSERT INTO users (phone_hash, created_at) VALUES (?, '2026-09-01T00:00:00.000Z')");
  userA = Number(insertUser.run(`a-${crypto.randomUUID()}`).lastInsertRowid);
  userB = Number(insertUser.run(`b-${crypto.randomUUID()}`).lastInsertRowid);
  caseA = Number(
    db.prepare("INSERT INTO cases (user_id, title, created_at) VALUES (?, '甲的案子', '2026-09-01T00:00:00.000Z')")
      .run(userA).lastInsertRowid,
  );
});

describe('预览', () => {
  test('解析出四条、逐条说清要写什么，且一行都没写进库', async () => {
    const before = counts();
    const res = await preview(post(signToken(userA), { text: reply(BLOCK) }), ctx(caseA));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.items).toHaveLength(4);
    expect(body.items.every((i: { ok: boolean }) => i.ok)).toBe(true);
    expect(body.items.map((i: { dedup: string }) => i.dedup)).toEqual(['new', 'new', 'new', 'new']);
    expect(typeof body.batch_id).toBe('string');
    // 零新增：预览是用户还没点头的那一步，档案要和粘贴之前一模一样
    expect(counts()).toEqual(before);
  });

  test('没有结构块 / 坏 JSON 各回各的 error_code（不合成一句"解析失败"）', async () => {
    const noBlock = await preview(post(signToken(userA), { text: '你好' }), ctx(caseA));
    expect(noBlock.status).toBe(400);
    expect((await noBlock.json()).error_code).toBe('NO_BLOCK');

    const bad = await preview(
      post(signToken(userA), { text: '```' + FENCE_TAG + '\n{坏\n```' }),
      ctx(caseA),
    );
    expect((await bad.json()).error_code).toBe('BAD_JSON');
  });

  test('别人的案子回 CASE_NOT_FOUND', async () => {
    const res = await preview(post(signToken(userB), { text: reply(BLOCK) }), ctx(caseA));
    expect(res.status).toBe(404);
    expect((await res.json()).error_code).toBe('CASE_NOT_FOUND');
  });

  test('api key 调不动（这条只认网页登录态）', async () => {
    const key = generateApiKey();
    db.prepare(
      "INSERT INTO api_keys (user_id, name, key_hash, scopes, enabled, created_at) VALUES (?, 'k', ?, ?, 1, '2026-09-01T00:00:00.000Z')",
    ).run(userA, hashApiKey(key), JSON.stringify(['case:read', 'case:write']));
    const res = await preview(post(key, { text: reply(BLOCK) }), ctx(caseA));
    expect(res.status).toBe(403);
    expect((await res.json()).error_code).toBe('WEB_SESSION_REQUIRED');
  });
});

describe('危机', () => {
  test('对话里出现危机信号 ⇒ 结果顶部带提示与号码（且不影响正常解析）', async () => {
    const res = await preview(
      post(signToken(userA), { text: reply(BLOCK, '你说的「不想活了」我听见了。') }),
      ctx(caseA),
    );
    const body = await res.json();
    expect(body.crisis.triggered).toBe(true);
    expect(body.crisis.message).toContain('危机信号');
    // 号码从资源卡取，不是写在代码里的字面量
    expect(body.crisis.message).toContain('12356');
    expect(body.items).toHaveLength(4);
  });

  test('解析失败也照样把号码带出去（格式不对不该让人拿不到号码）', async () => {
    const res = await preview(post(signToken(userA), { text: '我不想活了，什么都没意义。' }), ctx(caseA));
    const body = await res.json();
    expect(body.error_code).toBe('NO_BLOCK');
    expect(body.crisis.triggered).toBe(true);
    expect(body.crisis.message).toContain('12356');
  });

  test('普通抱怨不触发（资源卡一案只给一次，别烧在情绪低谷上）', async () => {
    const res = await preview(
      post(signToken(userA), { text: reply(BLOCK, '这破公司待着也没意思。') }),
      ctx(caseA),
    );
    expect((await res.json()).crisis.triggered).toBe(false);
  });
});

describe('确认写入', () => {
  async function previewed(text = reply(BLOCK)) {
    const res = await preview(post(signToken(userA), { text }), ctx(caseA));
    return (await res.json()) as { batch_id: string; items: { index: number }[] };
  }

  test('勾上的写进档案，走的是与 MCP 同一批能力', async () => {
    const p = await previewed();
    const res = await confirm(
      post(signToken(userA), { batch_id: p.batch_id, accept: p.items.map((i) => i.index) }),
      ctx(caseA),
    );
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.written).toBe(4);
    expect(body.failed).toBe(0);

    const c = counts();
    expect(c.timeline_events).toBe(1);
    expect(c.action_items).toBe(1);
    expect(c.claims).toBe(1);
    expect(c.deadlines).toBe(1);
    // 到期日由服务端按 lib/deadline 的规则推算——回填里只给锚点日与天数，日期不容模型转述
    const due = db.prepare('SELECT kind, due_at, derived_from FROM deadlines').get() as {
      kind: string;
      due_at: string;
      derived_from: string;
    };
    expect(due.kind).toBe('举证期限');
    expect(due.due_at.slice(0, 10)).toBe('2026-09-10');
    expect(due.derived_from).toContain('2026-09-01');
  });

  test('重放同一批 ⇒ 零双写（client_ref = paste-<batch_id>-<序号>）', async () => {
    const p = await previewed();
    const accept = p.items.map((i) => i.index);
    await confirm(post(signToken(userA), { batch_id: p.batch_id, accept }), ctx(caseA));
    const after1 = counts();

    const second = await confirm(post(signToken(userA), { batch_id: p.batch_id, accept }), ctx(caseA));
    const body = await second.json();
    expect(body.ok).toBe(true);
    expect(body.written).toBe(0);
    expect(body.deduped).toBe(4);
    expect(counts()).toEqual(after1);
  });

  test('只写勾中的那几条', async () => {
    const p = await previewed();
    await confirm(post(signToken(userA), { batch_id: p.batch_id, accept: [0] }), ctx(caseA));
    const c = counts();
    expect(c.timeline_events).toBe(1);
    expect(c.action_items).toBe(0);
    expect(c.claims).toBe(0);
    expect(c.deadlines).toBe(0);
  });

  test('校验没过的条目单条失败，不拖累同批其它条', async () => {
    const p = await previewed(
      reply({
        timeline: [{ happened_at: '上周三', kind: '公司动作', title: '约谈' }],
        actions: BLOCK.actions,
      }),
    );
    const res = await confirm(post(signToken(userA), { batch_id: p.batch_id, accept: [0, 1] }), ctx(caseA));
    const body = await res.json();
    expect(body.failed).toBe(1);
    expect(body.written).toBe(1);
    expect(body.results[0].error.code).toBe('INVALID_HAPPENED_AT');
    expect(counts().action_items).toBe(1);
    expect(counts().timeline_events).toBe(0);
  });

  test('别人的批次拿不到（batch_id 猜到也没用）', async () => {
    const p = await previewed();
    const res = await confirm(post(signToken(userB), { batch_id: p.batch_id, accept: [0] }), ctx(caseA));
    expect(res.status).toBe(404);
    expect((await res.json()).error_code).toBe('CASE_NOT_FOUND');
  });

  test('批次不存在 ⇒ 自述三段式（说清为什么没了、怎么办）', async () => {
    const res = await confirm(post(signToken(userA), { batch_id: 'nope', accept: [0] }), ctx(caseA));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error_code).toBe('BATCH_NOT_FOUND');
    expect(body.message).toContain('重新粘一次');
  });
});

describe('开场白路由', () => {
  test('三档各回一份，且 tier 不认的值回 INVALID_TIER', async () => {
    const get = (q: string) =>
      opener(
        new Request(`http://localhost/api/v1/cases/${caseA}/opener${q}`, {
          headers: { authorization: `Bearer ${signToken(userA)}` },
        }),
        ctx(caseA),
      );

    for (const tier of ['long', 'medium', 'short']) {
      const body = await (await get(`?tier=${tier}`)).json();
      expect(body.ok).toBe(true);
      expect(body.tier).toBe(tier);
      expect(body.length).toBeLessThanOrEqual(body.budget);
      expect(body.text).toContain('```' + FENCE_TAG);
    }

    const bad = await get('?tier=huge');
    expect(bad.status).toBe(400);
    expect((await bad.json()).error_code).toBe('INVALID_TIER');
  });

  test('别人的案子回 CASE_NOT_FOUND', async () => {
    const res = await opener(
      new Request(`http://localhost/api/v1/cases/${caseA}/opener`, {
        headers: { authorization: `Bearer ${signToken(userB)}` },
      }),
      ctx(caseA),
    );
    expect(res.status).toBe(404);
    expect((await res.json()).error_code).toBe('CASE_NOT_FOUND');
  });
});
