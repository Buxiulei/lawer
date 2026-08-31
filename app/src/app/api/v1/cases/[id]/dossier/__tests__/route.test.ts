// app/src/app/api/v1/cases/[id]/dossier/__tests__/route.test.ts
// 案件 → 档案适配端点的**通线**判据：真库、真迁移、真路由 handler，一处 mock 都没有。
//
// ─────────────── 这组测试补的是哪个缺口 ───────────────
// 档案页早就在打 `/cases/:id/dossier` 了，而这个端点**根本不存在**：
// 前端把 404 当成「还没建档」，于是每一个真实案件都看见一屏体面的招呼页；
// 而组件测试 mock 掉了 apiFetch，从头到尾全绿。
// **mock 了网络层的全绿，证不了端点存在。** 所以这份判据从 handler 本体起跑：
//   变异臂：把 ../route.ts 删掉 —— 下面 beforeAll 的 import 当场失败，整组红。
//   （这正是要抓的那个形态；把 404 当成正常状态的写法抓不到它。）
//
// 另外两条要害：
//   · 归属红线：别人的案件一律当作不存在，且响应里不许漏出任何公司名。
//   · 「还没建档」的三种来路（没有被申请人 / 全站没建过 / 建过但这个账号没买过）
//     **返回同一个载荷**——分开说等于做出一个「这家公司有没有人建过档」的探针。
import { beforeAll, beforeEach, describe, expect, test } from 'vitest';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { Database } from 'better-sqlite3';

import { generateApiKey, hashApiKey } from '@/lib/auth/api-key';
import { signToken } from '@/lib/auth/jwt';

type Handler = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

let getDossier: Handler;
let db: Database;
let userA: number;
let userB: number;
let caseA: number;

const COMPANY = '星曜网络科技（北京）有限公司';
const USCC = '91110105MA01X1X1X1';

const ctx = (id: number | string) => ({ params: Promise.resolve({ id: String(id) }) });

function request(auth?: string): Request {
  const headers: Record<string, string> = {};
  if (auth) headers.authorization = `Bearer ${auth}`;
  return new Request('http://localhost/api/v1/cases/1/dossier', { headers });
}

function issueKey(userId: number, scopes: string[]): string {
  const key = generateApiKey();
  db.prepare(
    "INSERT INTO api_keys (user_id, name, key_hash, scopes, enabled, created_at) VALUES (?, 'k', ?, ?, 1, '2026-08-19T00:00:00.000Z')",
  ).run(userId, hashApiKey(key), JSON.stringify(scopes));
  return key;
}

/** 给本案落一个被申请人主体。role 默认签约主体（仲裁列谁为被申请人由角色判定）。 */
function addProfile(role = '签约主体', name = COMPANY, uscc: string | null = USCC): number {
  return Number(
    db
      .prepare(
        `INSERT INTO company_profiles (case_id, name, uscc, role, created_at)
         VALUES (?, ?, ?, ?, '2026-08-19T00:00:00.000Z')`,
      )
      .run(caseA, name, uscc, role).lastInsertRowid,
  );
}

/** 用真的 createDossier 建档（company_key 由 lib/company/normalize 唯一产出，测试不另算一遍）。 */
async function addDossier(orderedBy: number | null, status = 'done'): Promise<number> {
  const { createDossier, setStatus } = await import('@/lib/company/dossier');
  const row = createDossier(db, { name: COMPANY, uscc: USCC, orderedByUserId: orderedBy });
  setStatus(db, row.id, status as never);
  return row.id;
}

async function body(auth: string, id: number | string = caseA) {
  const res = await getDossier(request(auth), ctx(id));
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';
  process.env.LAWER_DATA_KEY = crypto.randomBytes(32).toString('base64');
  process.env.DB_PATH = path.join(os.tmpdir(), `lawer-casedossier-${crypto.randomUUID()}.db`);

  getDossier = (await import('../route')).GET;
  db = (await import('@/lib/db/client')).getDb();
});

beforeEach(() => {
  for (const t of [
    'company_patterns',
    'company_dossier_stats',
    'company_dossier_blocks',
    'company_dossiers',
    'company_profiles',
    'pricing_config',
    'api_keys',
    'cases',
    'users',
  ]) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
  const insertUser = db.prepare(
    "INSERT INTO users (phone_hash, auth_status, created_at) VALUES (?, '未认证', '2026-08-19T00:00:00.000Z')",
  );
  userA = Number(insertUser.run(`a-${crypto.randomUUID()}`).lastInsertRowid);
  userB = Number(insertUser.run(`b-${crypto.randomUUID()}`).lastInsertRowid);
  caseA = Number(
    db
      .prepare(
        "INSERT INTO cases (user_id, title, stage, district, created_at) VALUES (?, '甲的案子', '风声', '朝阳', '2026-08-19T00:00:00.000Z')",
      )
      .run(userA).lastInsertRowid,
  );
});

describe('端点存在，且鉴权与归属照红线走', () => {
  /** 这一条本身就是"端点存在"的判据：上面的动态 import 是它的前半句。 */
  test('路由文件导出了 GET handler', () => {
    expect(typeof getDossier).toBe('function');
  });

  test('无凭据 401', async () => {
    expect((await getDossier(request(), ctx(caseA))).status).toBe(401);
  });

  test('凭据缺 case:read 时不放行', async () => {
    const res = await getDossier(request(issueKey(userA, ['case:write'])), ctx(caseA));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect((await res.json()).ok).toBe(false);
  });

  test('非数字 id（含 demo）当作不存在——演示案件不走这条端点', async () => {
    expect((await getDossier(request(signToken(userA)), ctx('demo'))).status).toBe(404);
  });

  /**
   * 变异臂：把路由里的 cases.getCase 归属校验去掉，这条会红——
   * 而且它红的方式正是最怕的那种：另一个用户案件里的公司名被原样返回。
   */
  test('别人的案件返回 CASE_NOT_FOUND，且不泄漏公司名', async () => {
    addProfile();
    await addDossier(userA);

    const { status, json } = await body(signToken(userB));
    expect(status).toBe(404);
    expect(json).toMatchObject({ ok: false, error_code: 'CASE_NOT_FOUND' });
    expect(JSON.stringify(json)).not.toContain('星曜');
  });
});

describe('还没建档：三种来路同一个载荷，且都不是错误', () => {
  const guidance = { ok: true, status: 'none', dossier: null, orderPath: '' };

  test('案里还没落被申请人主体', async () => {
    const { status, json } = await body(signToken(userA));
    expect(status).toBe(200);
    expect(json).toEqual({ ...guidance, orderPath: `/case/${caseA}/dossier/order` });
  });

  test('有主体、但这家公司全站没人建过档', async () => {
    addProfile();
    const { status, json } = await body(signToken(userA));
    expect(status).toBe(200);
    expect(json).toEqual({ ...guidance, orderPath: `/case/${caseA}/dossier/order` });
  });

  /**
   * 档案是**跨案共享的付费资产**：「我的案子的被申请人恰好是这家」不构成看它的理由。
   * 变异臂：把路由里 getDossierBillingView 那道判据去掉直接 build，这条会红——
   * 别人买的一份档案会白送给任何一个把公司名填对了的账号。
   */
  test('别人建过档、这个账号没买过 ⇒ 同一个载荷，且不透露这家已有存档', async () => {
    addProfile();
    await addDossier(userB);

    const { status, json } = await body(signToken(userA));
    expect(status).toBe(200);
    expect(json).toEqual({ ...guidance, orderPath: `/case/${caseA}/dossier/order` });
    expect(JSON.stringify(json)).not.toContain('星曜');
  });

  /**
   * `关联` 角色的含义恰恰是"不是被申请人"。
   * 变异臂：把 pickRespondent 换成"取第一条 company_profiles"，这条会红——
   * 整页档案会讲另一家公司的判例，而页面上看不出任何异样。
   */
  test('案里只有关联公司（没有签约/用工主体）⇒ 当作还没确定被申请人', async () => {
    addProfile('关联', '某某关联公司有限公司', null);
    const rel = await import('@/lib/company/dossier');
    rel.createDossier(db, { name: '某某关联公司有限公司', orderedByUserId: userA });

    const { status, json } = await body(signToken(userA));
    expect(status).toBe(200);
    expect(json.status).toBe('none');
  });
});

describe('已建档：按呈现契约给档案，数字都带着它的三件套', () => {
  /**
   * 最小的一份真档案：只建了档、什么块都还没跑。
   * 这一屏正是用户下单之后立刻看到的那一屏，它必须**说得出"还什么都没有"**，
   * 而不是给一份全 0 的统计。
   */
  test('刚下单（queued，零块）⇒ 四块都在队列里、统计为 null、位次说得出来', async () => {
    addProfile();
    await addDossier(userA, 'queued');

    const { status, json } = await body(signToken(userA));
    expect(status).toBe(200);
    expect(json.status).toBe('ready');

    const d = json.dossier as Record<string, unknown>;
    expect(d.companyName).toBe(COMPANY);
    expect((d.blocks as Array<{ block: string; state: string }>).map((b) => b.block)).toEqual([
      'graph',
      'litigation',
      'stats',
      'patterns',
    ]);
    for (const b of d.blocks as Array<{ state: string }>) expect(b.state).toBe('queued');
    expect(d.queuePosition).toBe(1);
    expect(d.outcome).toBeNull();
    expect(d.duration).toBeNull();
    expect(d.patterns).toEqual([]);
    expect(d.tenureYears).toBeNull();
    expect(d.refund).toBeNull();
    expect(d.graphReady).toBe(false);
    // 仲裁地这一块跟案件的 district 走，首发只做北京朝阳
    expect((d.venue as { venue: string; covered: boolean }).venue).toBe('北京朝阳');
    expect((d.venue as { covered: boolean }).covered).toBe(true);
    // 【本条同时是件2的通线】仲裁地卡的出处必须能一路走到响应里
    const cards = (d.venue as { cards: Array<{ id: string; sources: string[] }> }).cards;
    expect(cards.length).toBeGreaterThan(0);
    for (const c of cards) expect(`${c.id}:${c.sources.length > 0}`).toBe(`${c.id}:true`);
  });

  /**
   * 变异臂：把 buildDossierView 里 outcome 的 `minSample` 改成写死的 5，这条会红。
   * 门槛写死在代码里，改表就改不动它——而"门槛是多少"恰恰是这块诚实性的全部内容。
   */
  test('统计快照落了 ⇒ 三件套齐、分母是可判定篇数、门槛读 pricing_config', async () => {
    addProfile();
    const dossierId = await addDossier(userA);
    db.prepare('INSERT OR REPLACE INTO pricing_config (key, value_int) VALUES (?,?)').run(
      'dossier.min_sample_outcome',
      8,
    );
    db.prepare(
      `INSERT INTO company_dossier_stats
         (dossier_id, docs_total, docs_fulltext, docs_outcome_decided, worker_favorable_n,
          applicant_labor_n, applicant_employer_n,
          arb_n, arb_median_days, trial2_n, trial2_median_days,
          as_of, coverage_note, dropped_patterns)
       VALUES (?, 41, 17, 12, 7, 8, 3, 9, 58, 2, NULL, '2026-08-28', '覆盖度说明原文', 3)`,
    ).run(dossierId);

    const d = (await body(signToken(userA))).json.dossier as Record<string, unknown>;
    const outcome = d.outcome as Record<string, unknown>;
    expect(outcome.docsTotal).toBe(41);
    expect(outcome.docsOutcomeDecided).toBe(12);
    // 比率卡的样本量是它自己的分母，不是全档案条目数
    expect(outcome.sampleN).toBe(12);
    expect(outcome.asOf).toBe('2026-08-28');
    expect(outcome.source).toBe('裁判文书网·人机接力取证');
    expect(outcome.minSample).toBe(8);
    // 三档相对**同一个分母**（可判定 12 篇）：卡上那句话是「这 12 篇里……」，
    // 拿全部入档条目 41 去减会摆出一道加不起来的算术题。
    expect(outcome.byApplicant).toEqual({ worker: 8, employer: 3, unknown: 1 });
    const { worker, employer, unknown } = outcome.byApplicant as Record<string, number>;
    expect(worker + employer + unknown).toBe(outcome.docsOutcomeDecided);

    const duration = d.duration as { minSample: number; segments: Array<Record<string, unknown>> };
    expect(duration.segments.map((s) => s.key)).toEqual([
      'arbitration',
      'firstInstance',
      'secondInstance',
      'execution',
    ]);
    const arb = duration.segments[0];
    expect(arb).toMatchObject({ n: 9, medianDays: 58, sampleN: 9, asOf: '2026-08-28' });
    // 二审段 n=2、中位数算不出来：这一段自己不出数，**不牵连**其它三段
    expect(duration.segments[2]).toMatchObject({ n: 2, medianDays: null });
    expect(d.coverageNote).toBe('覆盖度说明原文');
    expect(d.droppedPatterns).toBe(3);
    // 契约里没有、也不许有「平均时长」这类合成字段
    expect(JSON.stringify(duration)).not.toMatch(/avg|average|平均/);
  });

  /**
   * 变异臂：把 patternsOf 末尾的 `.filter(evidence.length > 0)` 去掉，这条会红。
   * 没有证据的套路是这条红线唯一会漏的形态——它读起来和有证据的一模一样。
   */
  test('套路带逐条证据才出得来；证据为空的那条整条不出', async () => {
    addProfile();
    const dossierId = await addDossier(userA);
    const ins = db.prepare(
      'INSERT INTO company_patterns (dossier_id, pattern, evidence_json, model, generated_at) VALUES (?,?,?,?,?)',
    );
    ins.run(
      dossierId,
      '解除通知同时写两个理由，两个都不举证',
      JSON.stringify([{ case_no: '（示例）京0X民初1号', quote: '未提交证据证明' }]),
      'deepseek-v4-pro',
      '2026-08-28',
    );
    ins.run(dossierId, '这条没有证据', '[]', 'deepseek-v4-pro', '2026-08-28');

    const d = (await body(signToken(userA))).json.dossier as Record<string, unknown>;
    const patterns = d.patterns as Array<Record<string, unknown>>;
    expect(patterns).toHaveLength(1);
    expect(patterns[0].pattern).toContain('两个都不举证');
    expect(patterns[0].evidence).toEqual([
      { caseNo: '（示例）京0X民初1号', quote: '未提交证据证明', docUrl: null },
    ]);
  });

  /**
   * 变异臂：把 graphReady 改成看档案总状态（`status === 'done'`），这条会红——
   * 谱系块早就交付了，图谱入口却要等判例、统计、套路三块全跑完才给点。
   */
  test('谱系块跑完即开图谱入口，不等整份档案跑完', async () => {
    addProfile();
    const dossierId = await addDossier(userA, 'graph_done');
    const { finishBlock, startBlock } = await import('@/lib/company/blocks');
    startBlock(db, dossierId, 'graph');
    finishBlock(db, dossierId, 'graph', { status: 'ok' });
    startBlock(db, dossierId, 'litigation');

    const d = (await body(signToken(userA))).json.dossier as Record<string, unknown>;
    expect(d.graphReady).toBe(true);
    const blocks = new Map(
      (d.blocks as Array<{ block: string; state: string }>).map((b) => [b.block, b.state]),
    );
    expect(blocks.get('graph')).toBe('done');
    expect(blocks.get('litigation')).toBe('running'); // 有行、没回填 = 在跑（或崩了）
    expect(blocks.get('stats')).toBe('queued'); // 无行 = 从没排过
    // 跑起来之后不再报队列位次：报一个"第 3 位"是句假话
    expect(d.queuePosition).toBeNull();
  });

  /**
   * 失败原因**原文**要一路转到界面，不许在中途被压成「失败」两个字。
   */
  test('块失败时把原因原文带出来', async () => {
    addProfile();
    const dossierId = await addDossier(userA);
    const { finishBlock, startBlock } = await import('@/lib/company/blocks');
    startBlock(db, dossierId, 'patterns');
    finishBlock(db, dossierId, 'patterns', {
      status: 'failed',
      errorText: '缺可喂的判决全文：本档 17 篇里 0 篇取到全文；等判例块补齐后会自动重跑。',
    });

    const d = (await body(signToken(userA))).json.dossier as Record<string, unknown>;
    const patterns = (d.blocks as Array<{ block: string; state: string; errorText: string }>).find(
      (b) => b.block === 'patterns',
    )!;
    expect(patterns.state).toBe('failed');
    expect(patterns.errorText).toContain('0 篇取到全文');
  });

  /** 超期退款的那一档：判例块单独标 expired（它与 failed 的区别是**带着退款**）。 */
  test('litigation_expired ⇒ 判例块标 expired', async () => {
    addProfile();
    await addDossier(userA, 'litigation_expired');
    const d = (await body(signToken(userA))).json.dossier as Record<string, unknown>;
    const blocks = new Map(
      (d.blocks as Array<{ block: string; state: string }>).map((b) => [b.block, b.state]),
    );
    expect(blocks.get('litigation')).toBe('expired');
    expect(blocks.get('graph')).toBe('queued');
  });
});
