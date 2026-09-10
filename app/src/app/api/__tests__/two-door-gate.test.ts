// app/src/app/api/__tests__/two-door-gate.test.ts
//
// 行为判据：**同一把 key、同一份入参，分别打两道门（POST /api/mcp 的 tools/call 与
// POST /api/v1/tools/{name}），前置闸的判定与回包必须逐字段一致。**
//
// ── 这组补的是哪个缺口（2026-09-10 复审）──
// 两道门此前不是同一条调用路径：通用桥走 invokeCapability（args 交给前置闸），
// MCP 那道自己拿着 tool.run 跑、只借走 checkPreconditions 一句，**且没把 args 传进去**。
// 于是 facts_token 闸里那两条按入参判的分支（factsTokenArgs 命中、case_id 取值）
// 双双提前 return null——同一把 key、同一份入参：
//   · 走 MCP  的 case_update 带 stage 不带 facts_token ⇒ 200，档案真的被改了；
//   · 走 REST 的同一次调用                        ⇒ 409 FACTS_STALE，零写入。
// 两边都返回得体、都不报错，只有闸在一边不存在。
//
// ── 为什么判据要「两门对打」，不是各验各的 ──
// 各验各的形态正是上面那个：MCP 那侧的判据全绿（它验的是「这道门跑得通」），
// 而它跑得通的那条路上没有闸。只有把同一份入参同时喂给两道门、逐字段比对回包，
// 少一道闸才会当场读出来。
//
// ── 变异臂（同一份判据上手工验过，2026-09-10）──
//  ① 把 mcp/route.ts 的 invokeCapability 改回 `checkPreconditions(db, tool, identity)`
//     + tool.run（即把 args 再抽掉）⇒ 四条挂闸能力的「① 不带令牌」全红
//     （MCP 那侧回 ok、且真写了行）。
//  ② 把 invoke.ts 里 checkFactsToken 的 `factsTokenArgs` 判定删掉 ⇒ 「不锁的两条」红
//     （timeline_add / emotion_log 开始被闸拦）。
//  ③ 把 checkFactsToken 里的 isKnownReplay 豁免删掉 ⇒ 重放那组红（第二次回 FACTS_STALE）。
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import type { Database } from 'better-sqlite3';
import { beforeAll, beforeEach, describe, expect, test } from 'vitest';

process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';
process.env.LAWER_DATA_KEY = crypto.randomBytes(32).toString('base64');
process.env.DB_PATH = path.join(os.tmpdir(), `lawer-two-door-${crypto.randomUUID()}.db`);

import { generateApiKey, hashApiKey } from '@/lib/auth/api-key';
import { CONSENT_KINDS } from '@/lib/consent';
import { recordConsent } from '@/lib/db/consents';

const DOORS = ['mcp', 'rest-tools'] as const;
type Door = (typeof DOORS)[number];

let db: Database;
let mcpPost: (req: Request) => Promise<Response>;
let toolsPost: (req: Request, ctx: { params: Promise<{ name: string }> }) => Promise<Response>;

let uid: number;
let apiKey: string;
/** 两条案子：挂闸能力「带令牌真写」那一臂两门各写各的，免得后写的那门读到前一门的行。 */
let caseOf: Record<Door, number>;

beforeAll(async () => {
  mcpPost = (await import('../mcp/route')).POST;
  toolsPost = (await import('../v1/tools/[name]/route')).POST;
  db = (await import('@/lib/db/client')).getDb();
});

beforeEach(() => {
  for (const t of [
    // agent_writes 排最前：key_id 外键指向 api_keys 且没有级联。
    'agent_writes', 'consents', 'emotion_log', 'drafts', 'deadlines', 'claims',
    'timeline_events', 'action_items', 'api_keys', 'cases', 'users',
  ]) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
  uid = Number(
    db
      .prepare(
        "INSERT INTO users (phone_hash, auth_status, created_at) VALUES (?, '已实名', '2026-09-01T00:00:00.000Z')",
      )
      .run(`u-${crypto.randomUUID()}`).lastInsertRowid,
  );
  const mkCase = (title: string) =>
    Number(
      db
        .prepare(
          "INSERT INTO cases (user_id, title, stage, goal, created_at) VALUES (?, ?, '风声', '拿到 2N', '2026-09-01T00:00:00.000Z')",
        )
        .run(uid, title).lastInsertRowid,
    );
  caseOf = { mcp: mkCase('甲的案子'), 'rest-tools': mkCase('甲的第二件案子') };
  apiKey = generateApiKey();
  db.prepare(
    "INSERT INTO api_keys (user_id, name, key_hash, scopes, enabled, created_at) VALUES (?, 'k', ?, ?, 1, '2026-09-01T00:00:00.000Z')",
  ).run(uid, hashApiKey(apiKey), JSON.stringify(['case:read', 'case:write']));
  // emotion_log 挂的是 emotion_consent 闸，本组验的是 facts_token 那道，先把这一道满足掉
  recordConsent(db, { userId: uid, kind: CONSENT_KINDS.emotion });
});

// ───────────────────────── 调门 ─────────────────────────

interface DoorReply {
  /** 这次调用成没成。MCP 看 isError，REST 看 body.ok —— 两门必须给同一个答案 */
  ok: boolean;
  /** 回包正文。REST 的 `ok` 那一格是外壳，比对前摘掉（MCP 那侧没有外壳） */
  payload: Record<string, unknown>;
}

async function callDoor(
  door: Door,
  name: string,
  args: Record<string, unknown>,
): Promise<DoorReply> {
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` };
  if (door === 'rest-tools') {
    const res = await toolsPost(
      new Request(`http://localhost/api/v1/tools/${name}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(args),
      }),
      { params: Promise.resolve({ name }) },
    );
    const body = (await res.json()) as Record<string, unknown>;
    const { ok, ...payload } = body;
    return { ok: ok === true, payload };
  }
  const res = await mcpPost(
    new Request('http://localhost/api/mcp', {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    }),
  );
  const body = (await res.json()) as {
    result?: { isError: boolean; content: { text: string }[] };
    error?: { message: string };
  };
  if (!body.result) throw new Error(`${name} 走 MCP 拿到协议层错误：${body.error?.message}`);
  const { ok: _ok, ...payload } = JSON.parse(body.result.content[0].text) as Record<string, unknown>;
  void _ok;
  return { ok: !body.result.isError, payload };
}

/** 从这道门读一枚当下有效的令牌（对方 agent 照说明书就是这么拿的）。 */
async function freshToken(door: Door): Promise<string> {
  const { ok, payload } = await callDoor(door, 'case_facts', { case_id: caseOf[door] });
  expect(ok, '读事实卡本身不该失败').toBe(true);
  return payload.facts_token as string;
}

/**
 * 回包里逐次都会变的那几格换成占位符，其余每一格两门逐字比。
 *
 * 只有 facts_token 一格：它是**当场新签的**一枚令牌（错误体里的出路），
 * 两次签发差一个时刻就不同。把整包一起放过的形态是：这条判据只剩「两边都回了个对象」。
 */
const VOLATILE = new Set(['facts_token']);

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        VOLATILE.has(k) ? '<每次都不同>' : stable(v),
      ]),
    );
  }
  return value;
}

// ───────────────────────── 六条能力 ─────────────────────────

interface Arm {
  name: string;
  /** 不含 case_id：调用时按门补上各自的案子 */
  args: Record<string, unknown>;
  /** 这条能力真正落库的那几行（不含自增 id，两门各写各的必不同） */
  rows(caseId: number): unknown[];
}

/** 挂 facts_token 闸的四条（注册表 precondition 里点了名的那些）。 */
const GATED: Arm[] = [
  {
    name: 'case_update',
    args: { stage: '仲裁准备' },
    // 改的是档案自身那一行，所以"写没写"看的是 stage 有没有变成这次要改的那个值
    rows: (caseId) =>
      db.prepare("SELECT stage FROM cases WHERE id = ? AND stage = '仲裁准备'").all(caseId),
  },
  {
    name: 'claims_upsert',
    args: { kind: '欠薪', amount_fen: 12_300 },
    rows: (caseId) => db.prepare('SELECT kind, amount_fen FROM claims WHERE case_id = ?').all(caseId),
  },
  {
    name: 'deadline_set',
    args: { kind: '仲裁时效', anchor_date: '2026-08-20' },
    rows: (caseId) => db.prepare('SELECT kind, due_at FROM deadlines WHERE case_id = ?').all(caseId),
  },
  {
    name: 'draft_write',
    args: { kind: '谈判话术', title: '与 HR 的第一轮', body: '【开场】按事实讲，不承诺。' },
    rows: (caseId) => db.prepare('SELECT kind, title, content FROM drafts WHERE case_id = ?').all(caseId),
  },
];

/** 不挂闸的两条（低危高频写：挂上去模型就干脆不记了，见 registry.factsTokenArgs 抬头）。 */
const UNGATED: Arm[] = [
  {
    name: 'timeline_add',
    args: { happened_at: '2026-09-01T10:00:00+08:00', kind: '公司动作', title: 'HR 第一次约谈' },
    rows: (caseId) =>
      db.prepare('SELECT kind, title FROM timeline_events WHERE case_id = ?').all(caseId),
  },
  {
    name: 'emotion_log',
    args: { level: '焦虑', note: '他说这几天整晚睡不着' },
    rows: (caseId) => db.prepare('SELECT level, note FROM emotion_log WHERE case_id = ?').all(caseId),
  },
];

/**
 * 两门各打一次，回两份答复。
 *
 * @param caseFor 这门打哪件案子。**被闸拦下的那一臂两门共用同一件**——事实卡上印着案件
 *   编号与抬头，各打各的案子时两份错误体天生就不一样，那条"逐字段一致"会退化成
 *   "两边都回了个对象"；而拦下时零写入，共用同一件不会互相污染。
 *   真会写进去的那几臂反过来必须各写各的（caseOf[door]）。
 */
async function bothDoors(
  arm: Arm,
  extra: (door: Door) => Promise<Record<string, unknown>> | Record<string, unknown>,
  caseFor: (door: Door) => number = (door) => caseOf[door],
): Promise<Record<Door, DoorReply>> {
  const out = {} as Record<Door, DoorReply>;
  for (const door of DOORS) {
    out[door] = await callDoor(door, arm.name, {
      case_id: caseFor(door),
      ...arm.args,
      ...(await extra(door)),
    });
  }
  return out;
}

describe.each(GATED.map((a) => [a.name, a] as const))('%s：挂闸能力两门同判', (_name, arm) => {
  test('① 不带 facts_token ⇒ 两门都 FACTS_STALE、错误体逐字段一致，且都零写入', async () => {
    const shared = caseOf.mcp;
    const reply = await bothDoors(arm, () => ({}), () => shared);

    for (const door of DOORS) {
      expect(reply[door].ok, `${door} 这道门放行了一次没过闸的写入`).toBe(false);
      expect(reply[door].payload.error_code, door).toBe('FACTS_STALE');
    }
    expect(arm.rows(shared), '被闸拦下时一行都不许落库').toEqual([]);

    // 错误体逐字段相同：错误码、给人读的那段话、夹在里面的整张事实卡与出路的形状。
    // 只比错误码的形态是：一道门夹着事实卡与新令牌、另一道门只回一句话，
    // 照说明书重试的 agent 在其中一边永远重试不成功。
    expect(stable(reply.mcp.payload)).toEqual(stable(reply['rest-tools'].payload));
    for (const door of DOORS) {
      expect(typeof reply[door].payload.case_facts, door).toBe('string');
      expect(typeof reply[door].payload.facts_token, door).toBe('string');
    }
  });

  test('② 带上当下有效的 facts_token ⇒ 两门都写成功，落库那几行逐字段一致', async () => {
    const reply = await bothDoors(arm, async (door) => ({ facts_token: await freshToken(door) }));

    for (const door of DOORS) {
      expect(reply[door].ok, `${door}：${JSON.stringify(reply[door].payload)}`).toBe(true);
    }
    // 回包的字段名两门必须一样（值里有自增 id，比键位）
    expect(Object.keys(reply.mcp.payload).sort()).toEqual(
      Object.keys(reply['rest-tools'].payload).sort(),
    );
    // 真正落库的那几行逐字段一致——闸放行之后两门跑的是同一份实现
    expect(arm.rows(caseOf.mcp)).toEqual(arm.rows(caseOf['rest-tools']));
    expect(arm.rows(caseOf.mcp).length).toBeGreaterThan(0);
  });
});

describe.each(UNGATED.map((a) => [a.name, a] as const))('%s：不锁的能力两门都不锁', (_name, arm) => {
  test('不带 facts_token 照样写成功，两门落库逐字段一致（变异：给它挂上闸 ⇒ 红）', async () => {
    const reply = await bothDoors(arm, () => ({}));
    for (const door of DOORS) {
      expect(reply[door].ok, `${door}：${JSON.stringify(reply[door].payload)}`).toBe(true);
      expect(reply[door].payload.error_code, `${door} 不该有错误码`).toBeUndefined();
    }
    expect(Object.keys(reply.mcp.payload).sort()).toEqual(
      Object.keys(reply['rest-tools'].payload).sort(),
    );
    expect(arm.rows(caseOf.mcp)).toEqual(arm.rows(caseOf['rest-tools']));
    expect(arm.rows(caseOf.mcp).length).toBeGreaterThan(0);
  });
});

/**
 * 重放豁免（设计稿 §4.2-4 / idempotent.isKnownReplay 抬头）。
 *
 * agent 按幂等约定重发**同一份参数**时，那枚令牌已经被第一次写入弄失效了。
 * 不豁免的形态是：它拿到 FACTS_STALE，而那句话读起来像"你的认知过期了"，
 * 会诱使模型改内容重发——那才是真正危险的下一步。两道门都得豁免。
 */
describe('client_ref 重放豁免：两门都认', () => {
  test.each(DOORS)('%s：同一份参数发两次 ⇒ 第二次 deduped，不是 FACTS_STALE', async (door) => {
    const caseId = caseOf[door];
    const payload = {
      case_id: caseId,
      kind: '仲裁时效',
      anchor_date: '2026-08-20',
      client_ref: 'ref-1',
      facts_token: await freshToken(door),
    };

    const first = await callDoor(door, 'deadline_set', payload);
    expect(first.ok, JSON.stringify(first.payload)).toBe(true);

    const second = await callDoor(door, 'deadline_set', payload);
    expect(second.ok, JSON.stringify(second.payload)).toBe(true);
    expect(second.payload.deduped, '第二次必须认成重放，不是又写了一条').toBe(true);
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM deadlines WHERE case_id = ?').get(caseId) as { n: number }).n,
    ).toBe(1);
  });
});
