// app/src/app/api/v1/cases/__tests__/intake-route.test.ts
// POST /api/v1/cases/{id}/intake —— 首诊那六步的落脚点。
//
// 【为什么这条要单独验一遍】三名小白用户各自走完首诊，抓包结果一致：
// **整个提交过程零个非 GET 请求**。前端把六步内容全写在 localStorage 里，
// 末步直接跳演示案件。这条接口存在与否，就是「用户交出去的东西有没有人接住」。
// 所以这里走**真 handler + 真库**，落库结果回头查表，不看返回体自称成功。
import { beforeAll, beforeEach, describe, expect, test } from 'vitest';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { Database } from 'better-sqlite3';

import { generateApiKey, hashApiKey } from '@/lib/auth/api-key';
import { signToken } from '@/lib/auth/jwt';

type Handler = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

let postIntake: Handler;
let getCase: Handler;
let getActions: Handler;
let db: Database;
let userA: number;
let userB: number;
let caseA: number;
let caseB: number;

const ctx = (id: number) => ({ params: Promise.resolve({ id: String(id) }) });

const BODY = {
  stage: '已收通知',
  company_name: '华衡永泰供应链管理有限公司',
  employed_from: '2021-04-12',
  monthly_wage_fen: 2_200_000,
  position: '仓储主管',
  contract_count: '只签过一次',
  events: [{ date: '2026-08-28', text: '部门开会说要优化' }],
  free_text: '9 月 1 日 HR 约谈让我签自愿离职，我没签。',
  company_docs: { terminationNotice: '有', settlementAgreement: '没有', otherPaper: '不确定' },
  company_wording: 'HR 说公司要优化，给 N，三天内答复。',
  goals: ['违法解除赔偿金（2N）', '拖欠的工资'],
  bottom_line: '低于 2N 不签。',
};

function request(auth: string | undefined, body: unknown): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (auth) headers.authorization = `Bearer ${auth}`;
  return new Request('http://localhost/api/v1/cases/1/intake', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

function issueKey(userId: number, scopes: string[]): string {
  const key = generateApiKey();
  db.prepare(
    "INSERT INTO api_keys (user_id, name, key_hash, scopes, enabled, created_at) VALUES (?, 'k', ?, ?, 1, '2026-08-19T00:00:00.000Z')",
  ).run(userId, hashApiKey(key), JSON.stringify(scopes));
  return key;
}

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';
  process.env.LAWER_DATA_KEY = crypto.randomBytes(32).toString('base64');
  process.env.DB_PATH = path.join(os.tmpdir(), `lawer-intake-${crypto.randomUUID()}.db`);

  postIntake = (await import('../[id]/intake/route')).POST;
  const caseRoute = await import('../[id]/route');
  getCase = caseRoute.GET;
  getActions = (await import('../[id]/actions/route')).GET;
  db = (await import('@/lib/db/client')).getDb();
});

beforeEach(() => {
  for (const t of ['api_keys', 'timeline_events', 'action_items', 'deadlines', 'company_profiles', 'cases', 'users']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
  const insertUser = db.prepare(
    "INSERT INTO users (phone_hash, auth_status, created_at) VALUES (?, '未认证', '2026-08-19T00:00:00.000Z')",
  );
  userA = Number(insertUser.run(`a-${crypto.randomUUID()}`).lastInsertRowid);
  userB = Number(insertUser.run(`b-${crypto.randomUUID()}`).lastInsertRowid);
  const insertCase = db.prepare(
    "INSERT INTO cases (user_id, title, stage, created_at) VALUES (?, ?, '风声', '2026-08-19T00:00:00.000Z')",
  );
  caseA = Number(insertCase.run(userA, '我的案件').lastInsertRowid);
  caseB = Number(insertCase.run(userB, '别人的案件').lastInsertRowid);
});

describe('首诊提交', () => {
  test('201，且档案、时间线、行动卡都能从**读接口**再读出来', async () => {
    const token = signToken(userA);
    const res = await postIntake(request(token, BODY), ctx(caseA));
    expect(res.status).toBe(201);
    const saved = await res.json();
    expect(saved).toMatchObject({ ok: true, case_id: caseA });
    expect(saved.saved.timelineAdded).toBeGreaterThanOrEqual(4);
    expect(saved.saved.actionsAdded).toBe(3);

    // 用户下一屏读到的就是这些：从读接口回头验，而不是信写接口的自述
    const detail = await (await getCase(new Request('http://localhost/api/v1/cases/1', {
      headers: { authorization: `Bearer ${token}` },
    }), ctx(caseA))).json();
    expect(detail.case).toMatchObject({
      stage: '已收通知',
      employed_from: '2021-04-12',
      monthly_wage_fen: 2_200_000,
      goal: '违法解除赔偿金（2N）、拖欠的工资',
      bottom_line: '低于 2N 不签。',
    });
    expect(detail.timeline.length).toBeGreaterThanOrEqual(4);
    expect(detail.timeline.map((t: { title: string }) => t.title)).toContain('部门开会说要优化');

    const actions = await (await getActions(new Request('http://localhost/api/v1/cases/1', {
      headers: { authorization: `Bearer ${token}` },
    }), ctx(caseA))).json();
    expect(actions.actions).toHaveLength(3);
    expect(actions.actions[0].title).toBe('把解除通知原件拍照，传到文件解读');
  });

  test('别人的案件：404 CASE_NOT_FOUND，不是 403，也不留任何痕迹', async () => {
    const res = await postIntake(request(signToken(userA), BODY), ctx(caseB));
    expect(res.status).toBe(404);
    expect((await res.json()).error_code).toBe('CASE_NOT_FOUND');
    expect(db.prepare('SELECT COUNT(*) n FROM timeline_events WHERE case_id = ?').get(caseB)).toEqual({ n: 0 });
    expect(db.prepare('SELECT stage FROM cases WHERE id = ?').get(caseB)).toEqual({ stage: '风声' });
  });

  test('不存在的案件号同样 404，与别人的案件不可分辨', async () => {
    const res = await postIntake(request(signToken(userA), BODY), ctx(999_999));
    expect(res.status).toBe(404);
    expect((await res.json()).error_code).toBe('CASE_NOT_FOUND');
  });

  test('没凭据 401；有凭据但缺 case:write 403', async () => {
    expect((await postIntake(request(undefined, BODY), ctx(caseA))).status).toBe(401);
    const readOnly = issueKey(userA, ['case:read']);
    const res = await postIntake(request(readOnly, BODY), ctx(caseA));
    expect(res.status).toBe(403);
    expect((await res.json()).error_code).toBe('FORBIDDEN_SCOPE');
  });

  test('必填项没过 → 400 且库里一个字都不写', async () => {
    const res = await postIntake(request(signToken(userA), { ...BODY, goals: [] }), ctx(caseA));
    expect(res.status).toBe(400);
    expect((await res.json()).error_code).toBe('INVALID_GOALS');
    expect(db.prepare('SELECT COUNT(*) n FROM timeline_events WHERE case_id = ?').get(caseA)).toEqual({ n: 0 });
    expect(db.prepare('SELECT employed_from FROM cases WHERE id = ?').get(caseA)).toEqual({
      employed_from: null,
    });
  });
});
