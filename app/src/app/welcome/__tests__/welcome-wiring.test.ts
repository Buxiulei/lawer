// app/src/app/welcome/__tests__/welcome-wiring.test.ts
// F-201 复核 MF-A：/welcome 那四个维度**真的是从库里读出来的**。
//
// ─────────────── 这组补的是哪个缺口 ───────────────
// 同目录的 welcome-states 验了三件事：判定对不对（isFreshCase）、两屏各说什么、
// 挑屏对不对（screenFor）。取数那一截它是拿 mock 过的 apiFetch 喂的——
// 而 mock 是照着**我以为的**返回体形状捏的，捏错了它自己不会知道。
// 复核变异实测里三条接线变异因此全都活了下来：
//   R5 fetchCaseSnapshot 里 timelineCount 恒 0
//   R6 evidenceCount 恒 0
//   R7 首诊四列映射全 null
// 每一条的后果都一样：一个把经过讲完了 / 传过证据 / 填过工资司龄的人，
// 重登之后读到「档案已创建 … 接下来花几分钟做一次首诊」。判据全绿，页面不报错。
//
// 所以这组一处 mock 都没有：真库、真迁移、真路由 handler、真 apiFetch。
// 造一条数据（只造一个维度）→ 看那个维度的计数真的 > 0 → 看这一屏真的翻成「欢迎回来」。
// 少了任何一条接线，对应那一条当场红。
//
// 【为什么连 fetch 都不 mock 掉而是接到 handler 上】接线错得最隐蔽的一处是字段名：
// 后端回 snake_case（employed_from），前端映射写成 employedFrom 是对的、写成
// employedAt 就恒 null，而两边各自的判据都不会响。把真 handler 接上，这类错必红。
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { Database } from 'better-sqlite3';

import { signToken } from '@/lib/auth/jwt';
import { TOKEN_STORAGE_KEY } from '@/app/_ui/auth';
import { fetchCaseSnapshot, loadWelcomeState, welcomeStateFor } from '../_components/welcomeData';

type Ctx = { params: Promise<{ id: string }> };
type IdHandler = (req: Request, ctx: Ctx) => Promise<Response>;

let getCase: IdHandler;
let getMessages: IdHandler;
let getEvidence: IdHandler;
let listCases: (req: Request) => Promise<Response>;
let db: Database;
let userId: number;
let caseId: number;

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';
  process.env.LAWER_DATA_KEY = crypto.randomBytes(32).toString('base64');
  process.env.DB_PATH = path.join(os.tmpdir(), `lawer-welcome-${crypto.randomUUID()}.db`);

  getCase = (await import('@/app/api/v1/cases/[id]/route')).GET;
  getMessages = (await import('@/app/api/v1/cases/[id]/messages/route')).GET;
  getEvidence = (await import('@/app/api/v1/cases/[id]/evidence/route')).GET;
  listCases = (await import('@/app/api/v1/cases/route')).GET;
  db = (await import('@/lib/db/client')).getDb();
});

/** 浏览器那一侧：本机存着这个人的 token，fetch 直接落到真 handler 上 */
function browserFor(uid: number) {
  const store = new Map<string, string>([[TOKEN_STORAGE_KEY, signToken(uid)]]);
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const req = new Request(url, {
      method: init?.method ?? 'GET',
      headers: init?.headers as HeadersInit,
    });
    const detail = url.pathname.match(/^\/api\/v1\/cases\/(\d+)$/);
    if (detail) return getCase(req, { params: Promise.resolve({ id: detail[1] }) });
    const sub = url.pathname.match(/^\/api\/v1\/cases\/(\d+)\/(messages|evidence)$/);
    if (sub) {
      const ctx = { params: Promise.resolve({ id: sub[1] }) };
      return sub[2] === 'messages' ? getMessages(req, ctx) : getEvidence(req, ctx);
    }
    if (url.pathname === '/api/v1/cases') return listCases(req);
    throw new Error(`这条路径没接上真 handler：${url.pathname}`);
  });
}

beforeEach(() => {
  vi.unstubAllGlobals();
  for (const table of ['evidence', 'files', 'messages', 'threads', 'timeline_events', 'cases', 'users']) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
  userId = Number(
    db
      .prepare(
        "INSERT INTO users (phone_hash, auth_status, created_at) VALUES (?, '未认证', '2026-08-19T00:00:00.000Z')",
      )
      .run(`u-${crypto.randomUUID()}`).lastInsertRowid,
  );
  // 注册那一刻 ensureDefaultCase 建的那个空案件：人人都有，所以它不能算"回来了"
  caseId = Number(
    db
      .prepare(
        "INSERT INTO cases (user_id, title, stage, created_at) VALUES (?, '被裁', '风声', '2026-08-19T00:00:00.000Z')",
      )
      .run(userId).lastInsertRowid,
  );
  browserFor(userId);
});

function addTimelineEvent(): void {
  db.prepare(
    "INSERT INTO timeline_events (case_id, happened_at, kind, title) VALUES (?, '2026-08-22', '公司动作', '收到解除通知')",
  ).run(caseId);
}

function addMessage(): void {
  const threadId = Number(
    db.prepare("INSERT INTO threads (case_id, mode) VALUES (?, '问诊')").run(caseId).lastInsertRowid,
  );
  db.prepare("INSERT INTO messages (thread_id, role, content) VALUES (?, 'user', ?)").run(
    threadId,
    '5 月 30 日全员会宣布部门合并',
  );
}

function addEvidence(): void {
  const fileId = Number(
    db
      .prepare(
        "INSERT INTO files (sha256, size, mime, enc_path) VALUES (?, 1024, 'image/jpeg', '/dev/null.enc')",
      )
      .run(crypto.randomUUID()).lastInsertRowid,
  );
  db.prepare(
    "INSERT INTO evidence (case_id, user_id, file_id, name, category) VALUES (?, ?, ?, '解除通知书', '公司文件')",
  ).run(caseId, userId, fileId);
}

describe('fetchCaseSnapshot：四个维度真的从后端读得出来', () => {
  it('反向对照：刚注册那个空案件 → 四维全空，仍判新人', async () => {
    // 少了这条，把 fetchCaseSnapshot 写成「什么都恒 1」也会让下面每一条全绿，
    // 那时刚注册完的人一落地就被问「要不要回到你的案件」，而里面什么都没有。
    const snapshot = await fetchCaseSnapshot(caseId);
    expect(snapshot).toEqual({
      timelineCount: 0,
      messageCount: 0,
      evidenceCount: 0,
      intake: {
        employedFrom: null,
        monthlyWageFen: null,
        position: null,
        contractCount: null,
      },
    });
    expect(welcomeStateFor({ caseId, snapshot })).toEqual({ kind: 'fresh' });
  });

  it('库里有一条时间线 → timelineCount > 0 → 欢迎回来', async () => {
    addTimelineEvent();
    const snapshot = await fetchCaseSnapshot(caseId);
    expect(
      snapshot.timelineCount,
      '缺什么：库里那条时间线没被读进快照（接线断了，不是判定错了）。\n' +
        '为什么缺：把 timelineCount 写成恒 0，isFreshCase 的四个维度判据一条都不会红——' +
        '它们喂的是手写的快照。屏幕上的后果是：刚把被裁经过讲完的人重登一次，' +
        '读到「档案已创建，接下来花几分钟做一次首诊」。\n' +
        '怎么办：fetchCaseSnapshot 取 /cases/{id}?timeline_limit=1 的 timeline.length。',
    ).toBeGreaterThan(0);
    expect(welcomeStateFor({ caseId, snapshot })).toEqual({ kind: 'returning', caseId });
  });

  it('库里有一份证据 → evidenceCount > 0 → 欢迎回来', async () => {
    addEvidence();
    const snapshot = await fetchCaseSnapshot(caseId);
    expect(
      snapshot.evidenceCount,
      '缺什么：库里那份证据没被读进快照。\n' +
        '为什么缺：传完解除通知书、还没开口聊过的人，四个维度里只有这一个非空；' +
        '这条接线一断，他就是"新人"，屏幕请他去做首诊。\n' +
        '怎么办：fetchCaseSnapshot 取 /cases/{id}/evidence 的 evidence.length。',
    ).toBeGreaterThan(0);
    expect(welcomeStateFor({ caseId, snapshot })).toEqual({ kind: 'returning', caseId });
  });

  it('库里有一句对话 → messageCount > 0 → 欢迎回来', async () => {
    addMessage();
    const snapshot = await fetchCaseSnapshot(caseId);
    expect(snapshot.messageCount).toBeGreaterThan(0);
    expect(welcomeStateFor({ caseId, snapshot })).toEqual({ kind: 'returning', caseId });
  });

  /**
   * 首诊四列逐列各一条。**一列一列地验**，是因为它们的失败形态是逐列的：
   * 字段名映射错一个（employed_from → employedAt），那一列恒 null，
   * 只填过那一格的人就被当成新人，而其余三列还在、判据照样绿。
   */
  it.each([
    ['入职日期', 'employed_from', '2021-03-01', 'employedFrom', '2021-03-01'],
    ['月工资', 'monthly_wage_fen', 2000000, 'monthlyWageFen', 2000000],
    ['岗位', 'position', '后端工程师', 'position', '后端工程师'],
    ['合同次数', 'contract_count', '续签过一次', 'contractCount', '续签过一次'],
  ] as const)(
    '首诊只填了「%s」→ 这一列读得出来 → 欢迎回来',
    async (label, column, stored, field, expected) => {
      db.prepare(`UPDATE cases SET ${column} = ? WHERE id = ?`).run(stored, caseId);
      const snapshot = await fetchCaseSnapshot(caseId);
      expect(
        snapshot.intake[field],
        `缺什么：首诊的「${label}」那一列（cases.${column}）没被读进快照。\n` +
          '为什么缺：填完工资司龄、一句话还没聊的人，四个维度里只有首诊这一格非空。' +
          '这一列的映射一断，他重登就读到「档案已创建 / 开始首诊」——' +
          '而他刚刚才填过首诊。这个错是静默的：页面排版正常，没有任何报错。\n' +
          `怎么办：fetchCaseSnapshot 里 intake.${field} 取 detail.case.${column}。`,
      ).toBe(expected);
      expect(welcomeStateFor({ caseId, snapshot })).toEqual({ kind: 'returning', caseId });
    },
  );
});

describe('loadWelcomeState：从名下清单一路问到这一屏', () => {
  it('名下有一个有东西的案件 → 欢迎回来，CTA 指向它', async () => {
    addTimelineEvent();
    expect(await loadWelcomeState()).toEqual({ kind: 'returning', caseId });
  });

  it('反向对照：名下只有那个刚建的空案件 → 新人那一屏', async () => {
    expect(await loadWelcomeState()).toEqual({ kind: 'fresh' });
  });
});
