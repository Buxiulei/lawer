// scripts/eval-agent.ts
// C04 陪跑场景评测集的执行器（lib/agent 验收基准 · M1 质量闸门）。
//
// 用法（在 app/ 下跑，依赖由 app 包提供）：
//   cd app && npx tsx ../scripts/eval-agent.ts              # 全量 15 剧本
//   cd app && npx tsx ../scripts/eval-agent.ts S08 S15      # 只跑红线剧本
//   cd app && EVAL_PLAN=pro npx tsx ../scripts/eval-agent.ts S01
//   cd app && EVAL_DUMP=1 npx tsx ../scripts/eval-agent.ts S08   # 打印回复全文
//   cd app && EVAL_NO_JUDGE=1 npx tsx ../scripts/eval-agent.ts S08  # 只跑机械断言（快，迭代用）
//   cd app && EVAL_RUN_NOTE='本轮跑的代码尚未包含 X' npx tsx ../scripts/eval-agent.ts  # 披露写进证据产物
//
// 退出码：0 = 全过；1 = 有 FAIL（红线剧本任一项 FAIL 即整场 FAIL，不加权）。
//
// 凭据：启动时**强制**加载 app/.env.local，并断言本档路由未降级，否则拒绝开跑——
// 降级模型跑出来的 PASS/FAIL 和正常的长得一模一样，拿它签红线等于用另一个模型的表现背书。
// 实际路由会打进控制台与证据产物头部，每轮评测自证跑在什么模型上。
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { createKnowledgeSearcher, runTurn, type AgentEvent, type KnowledgePack } from '../app/src/lib/agent';
// better-sqlite3 装在 app/ 下、scripts/ 解析不到，故建库复用 app 侧的测试夹具
import { makeAgentFixture } from '../app/src/lib/agent/__tests__/fixtures';
import { API_KEY_ENV, route, type Plan, type TaskClass } from '../app/src/lib/llm';
import {
  crisisTurnAssertions,
  emotionalLeverageAssertions,
  globalAssertions,
  type TurnRecord,
  type Verdict,
} from './eval/assertions';
import { judgeAvailable, judgeItem, type JudgeResult } from './eval/judge';
import { newRunId, writeEvidence, type ScenarioEvidence } from './eval/report';
import { findScenarios, type Scenario } from './eval/scenarios';

/** 手工加载 app/.env.local（不引 dotenv：只为一个脚本加依赖不划算）。
 *  文件缺失直接抛：静默跳过会让整轮评测跑在降级链上，而那份结果看起来跟正常的一模一样。 */
function loadEnv(): void {
  const file = path.resolve(import.meta.dirname, '..', 'app', '.env.local');
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    throw new Error(`读不到 ${file}：评测必须显式加载凭据，否则会静默跑在降级模型上`);
  }
  for (const line of raw.split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

/**
 * 开跑前断言：本次套餐档的每个任务档都必须路由到**首选**模型，一旦 degraded 就拒绝开跑。
 *
 * 为什么这条要 fail loud 而不是打个警告：降级后的评测结果和正常结果长得一模一样——
 * 都是一堆 PASS/FAIL——但它测的是另一个模型。拿这种结果去判红线过没过，
 * 等于用 qwen 的表现给 deepseek 签字。证据不干净比没有证据更危险。
 */
function assertNotDegraded(plan: Plan): { taskClass: TaskClass; model: string }[] {
  const used: { taskClass: TaskClass; model: string }[] = [];
  for (const taskClass of ['critical', 'standard'] as const) {
    const r = route(taskClass, plan);
    if (r.degraded) {
      throw new Error(
        `路由降级：${plan}/${taskClass} 首选 ${r.degradedFrom?.provider}/${r.degradedFrom?.model.api} 缺 key，` +
          `实际会用 ${r.provider}/${r.model.api}。评测拒绝在降级模型上开跑——` +
          `请补齐 app/.env.local 的 ${API_KEY_ENV[r.degradedFrom!.provider]}，或显式换 EVAL_PLAN。`,
      );
    }
    used.push({ taskClass, model: `${r.provider}/${r.model.api}` });
  }
  return used;
}

/** 语义断言没跑时的**真实**原因。
 *  以前这里不分青红皂白一律打「未配置 DEEPSEEK_API_KEY」，结果我自己用 EVAL_NO_JUDGE
 *  跑的那次被读成「key 没加载 → 对话本体也可能跑在降级模型上」，白排查一轮。
 *  日志把两种原因说反了，比不打日志更费事。 */
function judgeOffReason(): string {
  if (process.env.EVAL_NO_JUDGE === '1') return 'EVAL_NO_JUDGE=1 主动关闭，不构成完整验收';
  return '未配置 DEEPSEEK_API_KEY';
}

/** 同时在跑的 judge 条目数。每条又自带 2 票，所以实际并发是这个数的两倍；
 *  4 是在「别把 15 场评测拖成一小时」与「别把 DeepSeek 打到限流」之间取的值。 */
const JUDGE_CONCURRENCY = 4;

/**
 * 基础设施抖动（不是行为问题）的错误特征：连接被掐、DNS/TLS 失败、上游 5xx。
 * 这类错误重跑一次通常就好，而把它算成「红线未通过」是错的——
 * 与 judge 故障隔离同一个道理：基础设施故障不该伪装成行为判决（见 eval/README.md §2）。
 */
const TRANSIENT_ERROR_RE = /terminated|aborted|fetch failed|ECONNRESET|ETIMEDOUT|socket hang up|EAI_AGAIN|HTTP 5\d\d/i;

/** 剧本级重试次数。只重试一次：再挂就不像抖动，值得人看一眼。 */
const SCENARIO_RETRIES = 1;

/** 限并发的 map，保持输入顺序（报告要按 must / mustNot 的原始顺序读） */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i]);
  });
  await Promise.all(workers);
  return out;
}

const C = {
  pass: (s: string) => `\x1b[32m${s}\x1b[0m`,
  fail: (s: string) => `\x1b[31m${s}\x1b[0m`,
  warn: (s: string) => `\x1b[33m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

interface ScenarioReport {
  scenario: Scenario;
  turns: TurnRecord[];
  mechanical: Verdict[];
  semantic: JudgeResult[];
  error?: string;
}

async function runScenario(scenario: Scenario, plan: Plan): Promise<ScenarioReport> {
  const { db, userId, caseId } = makeAgentFixture();
  db.prepare("UPDATE cases SET title = ?, stage = '风声' WHERE id = ?").run(`${scenario.id} ${scenario.title}`, caseId);
  scenario.setup(db, caseId);

  // 用生产同一个检索器：评测要是跑在夹具索引上，测出来的就是夹具，不是线上会发生的事
  const searcher = createKnowledgeSearcher();
  const turns: TurnRecord[] = [];

  for (const input of scenario.turns) {
    const events: AgentEvent[] = [];
    const before = db.prepare('SELECT MAX(id) AS m FROM action_items').get() as { m: number | null };
    const beforeDrafts = db.prepare('SELECT MAX(id) AS m FROM drafts').get() as { m: number | null };

    const result = await runTurn({
      db,
      caseId,
      userId,
      message: input,
      plan,
      searcher,
      emit: (e) => events.push(e),
    });
    if (!result.ok) throw new Error(`${scenario.id} 轮 ${turns.length + 1} 失败：${result.message}`);

    // 本轮新增的行动卡与文书（按 id 分水岭取，比数事件更贴近"落库了没有"）
    const cards = db
      .prepare('SELECT title, detail, due_at FROM action_items WHERE case_id = ? AND id > ? ORDER BY id')
      .all(caseId, before.m ?? 0) as TurnRecord['actionCards'];
    const drafts = db
      .prepare('SELECT kind, content FROM drafts WHERE case_id = ? AND id > ? ORDER BY id')
      .all(caseId, beforeDrafts.m ?? 0) as TurnRecord['drafts'];

    turns.push({
      input,
      text: result.text,
      events,
      retrieved: result.retrieved as KnowledgePack[],
      actionCards: cards,
      drafts,
      model: result.model,
      degraded: result.degraded,
      taskClass: result.taskClass,
    });
  }

  const mechanical = [
    // 全局断言只对最后一轮判（前面几轮是铺垫，C04 的清单也是按最终状态写的）
    ...globalAssertions(turns[turns.length - 1]).map((v) => ({ ...v, id: `${scenario.id}-${v.id}` })),
    // 安全铁律：**逐轮**判，且对全部 15 个剧本生效——不只是 S08。
    // 将来任何剧本里出现危机表述，这条都会盯着那一轮有没有号码。
    ...crisisTurnAssertions(turns).map((v) => ({ ...v, id: `${scenario.id}-${v.id}` })),
    ...emotionalLeverageAssertions(turns).map((v) => ({ ...v, id: `${scenario.id}-${v.id}` })),
    ...(scenario.mechanical?.(turns) ?? []),
  ];

  // 语义断言判**整段对话**而不是最后一轮：C04 的条目本身就带轮次限定
  // （"轮2 后立即暂停法律内容"、S15 的"轮1 明确拒绝 / 轮2 顶住施压"），
  // 只喂最后一轮会让所有指向前面轮次的条目无条件 FAIL。逐轮精度由机械断言负责。
  const transcript = turns.map((t, i) => `【第 ${i + 1} 轮 · 用户】\n${t.input}\n\n【第 ${i + 1} 轮 · AI】\n${t.text}`).join('\n\n');
  const userSide = turns.map((t, i) => `【第 ${i + 1} 轮】${t.input}`).join('\n');

  // judge 整体失败同样不许吃掉已跑完的机械断言：兜一层，失败就当没跑语义断言。
  const semantic: JudgeResult[] = judgeAvailable()
    ? await mapLimit(
        [
          ...scenario.must.map((item) => ({ item, kind: '必须出现' as const })),
          ...scenario.mustNot.map((item) => ({ item, kind: '禁止出现' as const })),
        ],
        JUDGE_CONCURRENCY,
        ({ item, kind }) => judgeItem(userSide, transcript, item, kind),
      ).catch((e) => {
        console.log(C.warn(`  语义断言整体失败（机械断言不受影响）：${e instanceof Error ? e.message : String(e)}`));
        return [] as JudgeResult[];
      })
    : [];

  db.close();
  return { scenario, turns, mechanical, semantic };
}

function printReport(r: ScenarioReport): boolean {
  const tag = r.scenario.redline ? C.warn('[红线]') : '';
  console.log(`\n${C.bold(`${r.scenario.id} ${r.scenario.title}`)} ${tag}`);
  if (r.error) {
    console.log(`  ${C.fail('运行失败')}：${r.error}`);
    return false;
  }

  let allPass = true;
  console.log(C.dim('  机械断言：'));
  for (const v of r.mechanical) {
    console.log(`    ${v.pass ? C.pass('PASS') : C.fail('FAIL')} ${v.id}  ${C.dim(v.detail)}`);
    if (!v.pass) allPass = false;
  }

  if (r.semantic.length) {
    console.log(C.dim('  语义断言（judge 两票制）：'));
    for (const j of r.semantic) {
      const mark = j.verdict === 'PASS' ? C.pass('PASS') : j.verdict === 'FAIL' ? C.fail('FAIL') : C.warn('SPLIT');
      console.log(`    ${mark} ${j.item.slice(0, 46)}${j.item.length > 46 ? '…' : ''}  ${C.dim(j.reasons[0] ?? '')}`);
      // SPLIT 不算通过也不算失败——它是"需人工复核"，但不能让它悄悄变成绿灯
      if (j.verdict === 'FAIL') allPass = false;
    }
  } else {
    console.log(C.dim(`  语义断言：未跑（${judgeOffReason()}）`));
  }

  if (process.env.EVAL_DUMP) {
    for (const [i, t] of r.turns.entries()) {
      console.log(C.dim(`\n  ── 轮 ${i + 1} 用户 ──\n  ${t.input}`));
      console.log(C.dim(`  ── 轮 ${i + 1} agent ──\n${t.text.replace(/^/gm, '  ')}`));
      for (const c of t.actionCards) console.log(C.dim(`  [卡] ${c.title} | 截止 ${c.due_at}`));
    }
  }
  return allPass;
}

async function main() {
  loadEnv();
  const ids = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const plan = (process.env.EVAL_PLAN as Plan) ?? 'entry';
  const scenarios = findScenarios(ids);

  // 开跑前把「跑在什么模型上」钉死并打出来，结果头部也会写进证据产物
  const routing = assertNotDegraded(plan);
  const judgeOff = process.env.EVAL_NO_JUDGE === '1' ? '关（EVAL_NO_JUDGE=1，不构成完整验收）' : '缺 DEEPSEEK_API_KEY 而跳过';
  console.log(C.bold(`C04 评测：${scenarios.length} 个剧本，套餐档 ${plan}，judge ${judgeAvailable() ? '开' : judgeOff}`));
  console.log(C.dim(`  实际路由：${routing.map((r) => `${r.taskClass}→${r.model}`).join('，')}（未降级）`));

  // 逐个剧本跑完就立刻打印：全量 15 场要跑十几分钟，攒到最后一起输出的话
  // 中途看不出是在跑还是卡死了，也没法提前发现某一场在系统性地挂。
  const runId = newRunId();
  const startedAt = new Date().toISOString();
  const results: { r: ScenarioReport; pass: boolean }[] = [];
  const evidence: ScenarioEvidence[] = [];

  for (const s of scenarios) {
    process.stdout.write(C.dim(`\n跑 ${s.id}…`));
    const t0 = Date.now();
    let report: ScenarioReport;
    let attempt = 0;
    for (;;) {
      try {
        report = await runScenario(s, plan);
        break;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        // 只对基础设施抖动重试；行为/断言问题原样报出，绝不靠重跑洗白
        if (attempt < SCENARIO_RETRIES && TRANSIENT_ERROR_RE.test(message)) {
          attempt += 1;
          console.log(C.warn(`\n  基础设施抖动（${message}），第 ${attempt} 次重试…`));
          continue;
        }
        report = { scenario: s, turns: [], mechanical: [], semantic: [], error: message };
        break;
      }
    }
    if (attempt > 0) console.log(C.dim(`  （本场重试了 ${attempt} 次，非行为问题）`));
    const pass = printReport(report);
    console.log(C.dim(`  （耗时 ${Math.round((Date.now() - t0) / 1000)}s）`));
    results.push({ r: report, pass });
    evidence.push({
      id: s.id,
      title: s.title,
      redline: !!s.redline,
      pass,
      error: report.error,
      turns: report.turns.map((t) => ({
        input: t.input,
        text: t.text,
        actionCards: t.actionCards,
        retrievedIds: t.retrieved.map((p) => p.id),
        model: t.model,
        degraded: t.degraded,
        taskClass: t.taskClass,
      })),
      mechanical: report.mechanical,
      semantic: report.semantic,
    });
  }

  const failed = results.filter((x) => !x.pass);
  const redlineFailed = failed.filter((x) => x.r.scenario.redline);

  // 证据落盘（manager 验收要看的链路），无论过没过都写——失败的那次才是最需要留证的
  const written = writeEvidence({
    runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    plan,
    routing,
    judgeEnabled: judgeAvailable(),
    runNotes: (process.env.EVAL_RUN_NOTE ?? '')
      .split('|')
      .map((n) => n.trim())
      .filter(Boolean),
    scenarios: evidence,
  });

  console.log(C.bold(`\n───────── 汇总 ─────────`));
  console.log(`通过 ${results.length - failed.length}/${results.length}`);
  if (failed.length) console.log(C.fail(`未通过：${failed.map((x) => x.r.scenario.id).join(' ')}`));
  if (redlineFailed.length) console.log(C.fail(`⚠ 红线剧本未通过：${redlineFailed.map((x) => x.r.scenario.id).join(' ')}`));
  if (!judgeAvailable()) console.log(C.warn('注意：本次未跑语义断言（judge），不构成完整验收'));
  console.log(C.dim(`证据产物：\n  ${written.md}\n  ${written.json}`));

  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
