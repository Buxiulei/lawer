// scripts/acceptance-billing.ts
// 公道值账本接线**验收**（manager 2026-08-26 改判：第 3 件从"实现"改为"验收"）。
//
// 【为什么要有这个文件，而不是"我跑了一下看着对"】验收标准原话是
// **「在非空表上跑通」，空表报绿不算通过**。单测用 :memory: + 假 provider 能证明接线在，
// 但证明不了「真模型跑完一轮、落到磁盘库、CLI 对账器读得到」这条完整链路。
//
// 【为什么带变异矩阵】一个只在"应该绿"的样本上跑绿的对账器，与一个恒绿的空壳无法区分。
// 所以每一条判错项都要**当场把它弄坏一次、看它变红**——没变红的那条，它的绿就不作数。
//
// 用法（在 app/ 下跑，与 eval-agent 同）：
//   cd app && DB_PATH=$PWD/data/acceptance/billing-acceptance.db npx tsx ../scripts/acceptance-billing.ts
//   （加 ACCEPT_NO_MODEL=1 可跳过真实模型调用，只跑对照组与变异矩阵）
//
// 【为什么 DB_PATH 必须由外面传】lib/db/client.ts 在**模块加载时**就把 DB_PATH 定死
//（顶层 const），而本脚本 import 产线 agent 时会连带把它加载起来——**在脚本第一行代码
// 跑之前**。所以脚本里再设 process.env.DB_PATH 已经晚了：实测那样会安静地写进
// app/data/lawer.db（默认库），而验收报告照样打印得像模像样。
// 这正是「配置在加载时求值」的经典坑：**没报错、路径却是另一条**。所以这里改成
// 缺 DB_PATH 就拒跑，宁可跑不起来，也不要跑在一个我以为不是它的库上。
// 注：**不直接 import better-sqlite3**——原生依赖装在 app/ 下，scripts/ 解析不到（与 eval-agent 同）。
// 建库一律走产线自己的 getDb()（它认 DB_PATH，且自带 migrate + WAL + 外键），
// 这样验收用的库与线上库是**同一条建库路径**，不是我另手搭的一个像它的东西。
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';

import { runTurn } from '../app/src/lib/agent';
import { reconcile, reconcileCli } from '../app/src/lib/db/reconcile';
import { route, type Plan, type TaskClass } from '../app/src/lib/llm';

function loadEnv(): void {
  const file = path.resolve(import.meta.dirname, '..', 'app', '.env.local');
  const raw = readFileSync(file, 'utf8');
  for (const line of raw.split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

/** 与评测同一条纪律：降级模型跑出来的验收和正常的长得一样，不许在降级链上签字。 */
function assertNotDegraded(plan: Plan): string[] {
  const out: string[] = [];
  for (const taskClass of ['critical', 'standard'] as TaskClass[]) {
    const r = route(taskClass, plan);
    if (r.degraded) throw new Error(`路由降级：${plan}/${taskClass} 缺 key，拒绝在降级链上做验收`);
    out.push(`${taskClass}→${r.provider}/${r.model.api}`);
  }
  return out;
}

const DB_PATH = process.env.DB_PATH ?? '';
const DIR = path.dirname(DB_PATH);

async function freshDb() {
  // ACCEPT_REUSE=1：不重建、不再跑模型，复用上一次的库——只为迭代变异矩阵（纯 SQL 逻辑）。
  // **报告里会显式打出"复用"**：一份没说清自己跑在什么状态上的验收报告，等于没跑。
  if (process.env.ACCEPT_REUSE !== '1') {
    rmSync(DIR, { recursive: true, force: true });
    mkdirSync(DIR, { recursive: true });
  }
  const { getDb } = await import('../app/src/lib/db/client');
  const db = getDb();
  // 自证跑在哪个库上：client.ts 的 DB_PATH 是加载时求值的，光看环境变量不算数
  const actual = (db.prepare('PRAGMA database_list').all() as { file: string }[])[0]?.file ?? '';
  if (path.resolve(actual) !== path.resolve(DB_PATH)) {
    throw new Error(`建库路径对不上：期望 ${DB_PATH}，实得 ${actual || '(内存库)'}`);
  }
  if (process.env.ACCEPT_REUSE === '1') {
    const u = (db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').all() as { id: number }[])[0];
    const c = (db.prepare('SELECT id FROM cases ORDER BY id LIMIT 1').all() as { id: number }[])[0];
    return { db, userId: u.id, caseId: c.id };
  }
  const userId = Number(db.prepare("INSERT INTO users (phone_hash, auth_status) VALUES ('acc-hash','已实名')").run().lastInsertRowid);
  const caseId = Number(db.prepare("INSERT INTO cases (user_id, title, stage) VALUES (?,?,'已收通知')").run(userId, '验收用例：违法解除').lastInsertRowid);
  return { db, userId, caseId };
}

type Db = { prepare: (sql: string) => { all: (...a: unknown[]) => unknown[]; run: (...a: unknown[]) => { lastInsertRowid: number | bigint } }; exec: (sql: string) => unknown; close: () => void };
const q = <T>(db: Db, sql: string): T[] => db.prepare(sql).all() as T[];
let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

async function main() {
  if (!DB_PATH) throw new Error('必须从外面传 DB_PATH（见文件头注释）：lib/db/client.ts 在模块加载时就把它定死了，脚本里再设已经晚了');
  loadEnv();
  console.log('【公道值账本接线 · 验收】');
  console.log(`  库：${DB_PATH}（每次重建，不复用旧状态）`);

  const reuse = process.env.ACCEPT_REUSE === '1';
  if (reuse) console.log('  ⚠️ ACCEPT_REUSE=1：复用既有库、跳过真实模型轮，**本次只验变异矩阵**，不构成完整验收');
  const { db, userId, caseId } = await freshDb();

  // ── 对照组：模型一次都没跑过的新库必须报绿（"没发生过的事不算漏账"，不知道 ≠ 零）──
  if (!reuse) {
    const virgin = reconcile(db as never);
    check('对照组：全新库（零 assistant 消息）对账报绿', virgin.problems.length === 0, `problems=${virgin.problems.length}`);
  }

  if (process.env.ACCEPT_NO_MODEL !== '1' && !reuse) {
    const routing = assertNotDegraded('entry');
    console.log(`  实际路由：${routing.join('，')}（未降级）`);
    console.log('  跑一轮**真实模型**对话…（无 searcher，走"无依据、保守做法"路径；只验记账链路）');
    const t0 = Date.now();
    const res = await runTurn({
      db, caseId, userId,
      message: '我 8 月 20 号收到公司的解除通知，说是客观情况发生重大变化。我想知道我现在该先做什么。',
      emit: () => {},
    });
    if (!('ok' in res) || !res.ok) throw new Error(`真实轮未成功：${JSON.stringify(res)}`);
    console.log(`  一轮完成，耗时 ${Math.round((Date.now() - t0) / 1000)}s，model=${res.model} degraded=${res.degraded} messageId=${res.messageId}`);
  }

  // ── 非空表验收 ──
  const usage = q<{ ref_id: string; feature: string; model: string; api_model: string | null; prompt_tokens: number; completion_tokens: number; cache_read_tokens: number; cache_write_tokens: number; cost_li: number }>(db, 'SELECT * FROM token_usage');
  const ledger = q<{ ref_id: string; type: string; delta: number; feature: string | null }>(db, 'SELECT * FROM gongdao_ledger');
  const msgs = q<{ id: number }>(db, "SELECT id FROM messages WHERE role='assistant' AND content IS NOT NULL");
  console.log('\n  ── 落库实况 ──');
  for (const u of usage) console.log(`    token_usage: ref=${u.ref_id} feature=${u.feature} model=${u.model} api_model=${u.api_model} 四桶=${u.prompt_tokens}/${u.completion_tokens}/${u.cache_read_tokens}/${u.cache_write_tokens} cost_li=${u.cost_li}`);
  for (const l of ledger) console.log(`    gongdao_ledger: ref=${l.ref_id} type=${l.type} delta=${l.delta} feature=${l.feature ?? '-'}`);

  check('token_usage 长出行来', usage.length > 0, `${usage.length} 行`);
  check('gongdao_ledger「消耗」长出行来', ledger.some((l) => l.type === '消耗'), `${ledger.filter((l) => l.type === '消耗').length} 行`);
  check('两侧 ref_id 对得上（对账靠这个键）', usage.length > 0 && ledger.some((l) => l.type === '消耗' && l.ref_id === usage[0].ref_id));
  check('四桶不是全 0 冒充（真回报过计量）', usage.length > 0 && usage[0].prompt_tokens > 0);
  check('assistant 消息也在（三向的第三向）', msgs.length > 0, `${msgs.length} 条`);

  console.log('\n  ── CLI 三向对账（真·非空表）──');
  const rc = reconcileCli(DB_PATH);
  check('reconcileCli 退出码 0（非空表上跑通）', rc === 0, `rc=${rc}`);

  // ── 变异矩阵：每条判错项都必须**被弄坏时变红**，否则它的绿不作数 ──
  console.log('\n  ── 变异矩阵（把它弄坏，看对账器变不变红）──');
  // 变异在**同一个连接的事务内**做完就回滚：既不用第二个原生连接，也保证验收库不被写脏。
  //
  // 【每条变异必须钉住"红的是哪一条"，不能只看"红了没"】第一版这里只断言 `problems.length > 0`，
  // 结果「只删消耗流水」那条本意打 usage 孤儿检查，实际先撞上「账本空表·账本口径」——**红是红了，
  // 红的是另一条规则**，于是孤儿检查其实一次都没被验到，而矩阵报的是全绿。
  // **一个只问"变红了吗"的变异矩阵，与一个恒绿的空壳的区别，比看上去小得多。**
  const mutate = (name: string, sql: string, expect: string) => {
    db.exec('BEGIN');
    db.exec(sql);
    const r = reconcile(db as never);
    db.exec('ROLLBACK');
    const hit = r.problems.find((x) => x.includes(expect));
    check(
      `变异「${name}」→ 命中「${expect}」`,
      hit !== undefined,
      hit ?? (r.problems.length ? `红了，但红的是别条：${r.problems[0]}` : '完全没红'),
    );
  };
  mutate('删光 token_usage（接线漏了的形态）', 'DELETE FROM token_usage', '根本没记账（用量口径）');
  mutate('删光 gongdao_ledger 消耗行', "DELETE FROM gongdao_ledger WHERE type='消耗'", '根本没扣费（账本口径）');
  mutate('篡改物化余额（缓存与账本不符）', 'UPDATE gongdao SET balance = balance + 999', '≠ SUM(ledger.delta)');
  // 隔离 usage 孤儿：**保留**真实那条消耗流水（否则"账本空表"先开火，把孤儿检查挡在后面），
  // 另插一条无对应流水的用量行 —— 这才是"接了用量、漏了扣费"的真实形态。
  mutate(
    '插一条无对应消耗流水的用量行（漏账形态，隔离孤儿检查）',
    `INSERT INTO token_usage (user_id, feature, model, api_model, prompt_tokens, completion_tokens, cost_li, ref_id)
       SELECT user_id, feature, model, api_model, 1, 1, 42, 'turn-orphan-probe' FROM token_usage LIMIT 1`,
    'ref_id=turn-orphan-probe',
  );
  // 反向：有消耗流水而无用量（定额端点的正常形态）**只该告警、不该判错**——
  // 这条验的是"该红的红"之外的另一半：**不该红的别红**。
  {
    db.exec('BEGIN');
    // 余额也要同步扣，否则 balance ≠ SUM(delta) 会先开火——**那样这条反向对照测的就不是它自己了**
    db.exec("INSERT INTO gongdao_ledger (user_id, delta, type, ref_id, feature) SELECT user_id, -3, '消耗', 'fixed-fee-probe', 'export' FROM gongdao LIMIT 1");
    db.exec('UPDATE gongdao SET balance = balance - 3');
    const r = reconcile(db as never);
    db.exec('ROLLBACK');
    check('反向：定额端点（有消耗无用量）只告警不判错',
      r.problems.length === 0 && r.warnings.some((w) => w.includes('fixed-fee-probe')),
      `problems=${r.problems.length} warnings=${r.warnings.filter((w) => w.includes('fixed-fee-probe')).length}`);
  }

  console.log(`\n【结论】${failures === 0 ? '✅ 全部通过' : `❌ ${failures} 项未通过`}`);
  db.close();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
