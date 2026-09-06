// app/src/app/_ui/__tests__/list-full-fetch.test.ts
// 清单端点分页之后：**网页拿到的仍是全部**，不是第一页。
//
// ─────────────── 这组补的是哪个缺口 ───────────────
// 三条清单端点（证据 / 行动卡 / 期限）加了分页，不传 limit 时只回前 50 条。
// 网页四处消费者读的是回包里的老键（`evidence` / `actions` / `deadlines`），
// 既不传 limit 也不看 next_offset——于是第 51 条起**静默消失**：
// HTTP 200、结构合法、列表画得整整齐齐，只是少了几件，屏幕上没有任何异常信号。
// 一个传了 57 份材料的人，在自己的证据库里翻不到最后那 7 份。
//
// 端点侧的分页判据（patch-and-paging）验的是"不传参数默认前 50 条"——它全绿，
// 恰恰是这个缺口成立的证明：两边各自都对，合起来是数据丢失。
//
// 所以这组一处 mock 都没有：真库、真迁移、真路由 handler、真 apiFetch。
// 造 57 / 217 行（跨过默认页大小 50、跨过封顶 200 这两道坎）→
// 看四处消费者各自真的拿到全部行。
// 环⑥另走一条路：扫源码，看还有没有第二处按老键直读单页的写法——
// 行为环只管现在这四处，结构环管"下一处别再这么写"。
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { readdirSync, readFileSync } from 'node:fs';
import type { Database } from 'better-sqlite3';

import { signToken } from '@/lib/auth/jwt';
import { TOKEN_STORAGE_KEY } from '@/app/_ui/auth';

/**
 * 两道坎，各拦一种错法：
 *   50  = 端点默认页大小 → 拦"根本没传 limit"（只拿第一页）；
 *   200 = 端点封顶（lib/cases 的 LIST_MAX_LIMIT）→ 拦"传了 limit 但不翻页"。
 * 只造 57 行时第二种错法活得好好的：一页 200 装得下 57 行，不翻页也拿得全。
 */
const OVER_DEFAULT = 57;
const OVER_CAP = 217;

type Ctx = { params: Promise<{ id: string }> };
type IdHandler = (req: Request, ctx: Ctx) => Promise<Response>;

let getCase: IdHandler;
let getEvidence: IdHandler;
let getActions: IdHandler;
let getDeadlines: IdHandler;
let getMessages: IdHandler;
let db: Database;
let userId: number;
let caseId: number;

let fetchEvidenceList: (caseId: string) => Promise<{ id: string }[]>;
let fetchDashboard: (caseId: string) => Promise<{
  actions: unknown[];
  deadlines: unknown[];
  records: { name: string }[];
}>;
let fetchCaseStatus: (caseId: string) => Promise<{ nearestDueAt: string | null }>;
let fetchCaseSnapshot: (caseId: number) => Promise<{ evidenceCount: number }>;

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';
  process.env.LAWER_DATA_KEY = crypto.randomBytes(32).toString('base64');
  process.env.DB_PATH = path.join(os.tmpdir(), `lawer-listfull-${crypto.randomUUID()}.db`);

  getCase = (await import('@/app/api/v1/cases/[id]/route')).GET;
  getEvidence = (await import('@/app/api/v1/cases/[id]/evidence/route')).GET;
  getActions = (await import('@/app/api/v1/cases/[id]/actions/route')).GET;
  getDeadlines = (await import('@/app/api/v1/cases/[id]/deadlines/route')).GET;
  getMessages = (await import('@/app/api/v1/cases/[id]/messages/route')).GET;
  db = (await import('@/lib/db/client')).getDb();

  fetchEvidenceList = (await import('@/app/(app)/case/[id]/evidence/_data')).fetchEvidenceList;
  fetchDashboard = (await import('@/app/(app)/case/[id]/_components/dashboardData')).fetchDashboard;
  fetchCaseStatus = (await import('@/app/(app)/case/[id]/_components/caseStatus')).fetchCaseStatus;
  fetchCaseSnapshot = (await import('@/app/welcome/_components/welcomeData')).fetchCaseSnapshot;
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
    const sub = url.pathname.match(/^\/api\/v1\/cases\/(\d+)\/(evidence|actions|deadlines|messages)$/);
    if (sub) {
      const ctx = { params: Promise.resolve({ id: sub[1] }) };
      if (sub[2] === 'evidence') return getEvidence(req, ctx);
      if (sub[2] === 'actions') return getActions(req, ctx);
      if (sub[2] === 'deadlines') return getDeadlines(req, ctx);
      return getMessages(req, ctx);
    }
    throw new Error(`这条路径没接上真 handler：${url.pathname}`);
  });
}

beforeEach(() => {
  vi.unstubAllGlobals();
  for (const table of ['evidence', 'files', 'action_items', 'deadlines', 'cases', 'users']) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
  userId = Number(
    db
      .prepare(
        "INSERT INTO users (phone_hash, auth_status, created_at) VALUES (?, '未认证', '2026-08-19T00:00:00.000Z')",
      )
      .run(`u-${crypto.randomUUID()}`).lastInsertRowid,
  );
  caseId = Number(
    db
      .prepare(
        "INSERT INTO cases (user_id, title, stage, created_at) VALUES (?, '被裁', '风声', '2026-08-19T00:00:00.000Z')",
      )
      .run(userId).lastInsertRowid,
  );
  browserFor(userId);
});

/** 第 n 份材料。名字带序号，好让"少的是哪几份"直接看得出来 */
function addEvidence(n: number): void {
  const fileId = Number(
    db
      .prepare(
        "INSERT INTO files (sha256, size, mime, enc_path) VALUES (?, 1024, 'image/jpeg', '/dev/null.enc')",
      )
      .run(crypto.randomUUID()).lastInsertRowid,
  );
  db.prepare(
    "INSERT INTO evidence (case_id, user_id, file_id, name, category, created_at) VALUES (?, ?, ?, ?, '公司文件', ?)",
  ).run(caseId, userId, fileId, `材料 ${n}`, new Date(Date.UTC(2026, 0, n)).toISOString());
}

function seedEvidence(count: number): void {
  for (let n = 1; n <= count; n += 1) addEvidence(n);
}

function seedActions(count: number): void {
  const stmt = db.prepare("INSERT INTO action_items (case_id, title, status) VALUES (?, ?, '待办')");
  for (let n = 1; n <= count; n += 1) stmt.run(caseId, `该做的第 ${n} 件事`);
}

function seedDeadlines(count: number): void {
  const stmt = db.prepare("INSERT INTO deadlines (case_id, kind, due_at) VALUES (?, '自定义', ?)");
  // due_at 两两不同且递增：清单按 due_at 升序，后半段只有翻完页才拿得到
  for (let n = 1; n <= count; n += 1) stmt.run(caseId, new Date(Date.UTC(2027, 0, n)).toISOString());
}

describe('网页读清单：> 50 条时仍拿全', () => {
  it('反向对照：库里只有 3 份材料 → 证据页拿到 3 份，不多不少', async () => {
    // 少了这条，把 fetchEvidenceList 写成「恒回 57 行」也能让下面每一条全绿。
    seedEvidence(3);
    expect(await fetchEvidenceList(String(caseId))).toHaveLength(3);
  });

  it.each([OVER_DEFAULT, OVER_CAP])('证据页：库里 %i 份 → 列表一份不少', async (rows) => {
    seedEvidence(rows);
    const list = await fetchEvidenceList(String(caseId));
    expect(
      list.length,
      '缺什么：证据库列表少了第 51 份起的材料。\n' +
        '为什么缺：清单端点不传 limit 只回前 50 条，页面读回包里的 evidence 老键、' +
        '不看 next_offset，于是多出来的那几份静默消失——HTTP 200、页面不报错、' +
        '列表整整齐齐，只是传上去的材料在自己的证据库里找不到了。\n' +
        '怎么办：走 apiFetchAll（app/_ui/api），它按 next_offset 翻到底。',
    ).toBe(rows);
    // 不是把同一页取了两遍：id 必须两两不同
    expect(new Set(list.map((row) => row.id)).size).toBe(rows);
  });

  it(`驾驶舱：${OVER_CAP} 张行动卡 / ${OVER_CAP} 条期限 → 一张一条都不少`, async () => {
    seedActions(OVER_CAP);
    seedDeadlines(OVER_CAP);
    seedEvidence(3);
    const data = await fetchDashboard(String(caseId));
    expect(
      data.actions.length,
      '缺什么：驾驶舱少了第 51 张起的行动卡。\n' +
        '为什么缺：同上——分页默认页大小 50，页面按老键直读第一页。' +
        '后果是"该做的事"这一栏看着是全的，实际漏掉的那几件没有任何提示。\n' +
        '怎么办：fetchDashboard 里三条清单都走 apiFetchAll。',
    ).toBe(OVER_CAP);
    expect(data.deadlines.length, '期限漏了就是错过时效，这一栏漏不得').toBe(OVER_CAP);
  });

  it(`案件状态条：${OVER_CAP} 条期限也照样算得出最近一条`, async () => {
    // 这一条不是截断判据（期限按 due_at 升序，最近的一条本来就在第一页），
    // 是接线判据：换成 apiFetchAll 之后这一栏还得照常出数。
    seedDeadlines(OVER_CAP);
    const status = await fetchCaseStatus(String(caseId));
    expect(status.nearestDueAt).not.toBeNull();
  });

  it(`欢迎页：${OVER_CAP} 份材料 → 计数就是 ${OVER_CAP}，不是 50 也不是 200`, async () => {
    seedEvidence(OVER_CAP);
    const snapshot = await fetchCaseSnapshot(caseId);
    expect(
      snapshot.evidenceCount,
      '缺什么：材料计数封在 50。\n' +
        '为什么缺：读的是第一页的长度。这一页的判定只问"有没有"，' +
        '所以现在还看不出错——但这个计数一旦被别处当成真数用，错得毫无征兆。\n' +
        '怎么办：走 apiFetchAll，计数是全量长度。',
    ).toBe(OVER_CAP);
  });
});

/* ── 结构环：下一处别再按老键直读单页 ─────────────────────────── */

const WEB_ROOT = path.join(process.cwd(), 'src/app');
/** 分页外壳给的老键（lib/cases/paging 的 legacyKey）。按这些键直读 = 只拿到第一页 */
const LEGACY_KEYS = ['evidence', 'actions', 'deadlines', 'events'];

function webSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    // api/ 是端点自己（它就是回包那一侧）；__tests__ 里的替身另算
    if (entry.isDirectory()) {
      if (entry.name === 'api' || entry.name === '__tests__') continue;
      webSources(full, out);
    } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
      out.push(full);
    }
  }
  return out;
}

describe('结构环：网页不许再按老键直读一页', () => {
  it('src/app 下（除 api/ 与 __tests__）没有 apiFetch<{ 老键 … }> 的写法', () => {
    // 认的是「把老键读成数组」。同名的单行详情（/evidence/{id} 回的 evidence 是一行不是一页）
    // 不在此列，所以要求类型带 `[]`。
    const pattern = new RegExp(`apiFetch<\\{[^>]*?\\b(${LEGACY_KEYS.join('|')})\\s*:\\s*[\\w.]+\\[\\]`);
    const offenders = webSources(WEB_ROOT)
      .filter((file) => pattern.test(readFileSync(file, 'utf8')))
      .map((file) => path.relative(process.cwd(), file));
    expect(
      offenders,
      '缺什么：这些文件按清单老键读单页，第 51 条起会静默消失。\n' +
        '为什么缺：老键（evidence/actions/deadlines/events）与 items 指向同一个数组，' +
        '但那只是**这一页**；老写法读起来跟"全量"一模一样，没有任何地方会报错。\n' +
        '怎么办：改用 apiFetchAll（app/_ui/api），调用方连键名都不必知道。\n' +
        `点名：${offenders.join('、')}`,
    ).toEqual([]);
  });
});
