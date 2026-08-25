// app/src/lib/db/reconcile.ts
// 公道值对账（spec §6）：账本是唯一事实源，物化余额只是缓存——本模块核对二者是否还对得上。
// CLI 入口在仓库根 scripts/reconcile.ts（那里只做「定位库 + 退出码」，逻辑全在这里，可单测）。
import Database from 'better-sqlite3';

/** 余额行与流水按 user_id 全外连（SQLite 无 FULL JOIN，用 UNION 取并集再左连两侧）。 */
const SQL_BALANCES = `
  SELECT u.user_id AS user_id,
         g.balance AS balance,
         l.s       AS ledger_sum
    FROM (SELECT user_id FROM gongdao
          UNION
          SELECT user_id FROM gongdao_ledger) u
    LEFT JOIN gongdao g ON g.user_id = u.user_id
    LEFT JOIN (SELECT user_id, SUM(delta) AS s FROM gongdao_ledger GROUP BY user_id) l
           ON l.user_id = u.user_id
   ORDER BY u.user_id
`;

/** token_usage 有 ref_id 但 ledger 查无对应消耗行——用量没落账，是真漏账。 */
const SQL_USAGE_ORPHANS = `
  SELECT t.ref_id AS ref_id, COUNT(*) AS n, COALESCE(SUM(t.cost_li), 0) AS cost_li
    FROM token_usage t
   WHERE t.ref_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM gongdao_ledger l WHERE l.ref_id = t.ref_id AND l.type = '消耗'
     )
   GROUP BY t.ref_id
   ORDER BY t.ref_id
`;

/**
 * 计费口径漂移探针：同一 model（计费键）下出现过几个不同的 api_model（厂商回显串）。
 * 厂商把别名重指向新快照时 api_model 会变而 model 不变 —— 于是我们仍按旧价记账、
 * 实际跑的却是新模型。这只是「可能算错钱」的信号、不是账目对不上，故只告警不判错。
 * last_id 用于判定「最新值」（id 单调递增，比时间串可靠，ADR-002）。
 */
const SQL_API_MODEL_DRIFT = `
  SELECT model, api_model, COUNT(*) AS n, MAX(id) AS last_id
    FROM token_usage
   WHERE api_model IS NOT NULL
   GROUP BY model, api_model
   ORDER BY model, last_id
`;

/**
 * 「模型真跑过」的证据：assistant 消息行。content 非空 = 那一轮确实产出了回复
 *（content 为 NULL 是生成中/中断，见 messages 表注释，不算跑完）。
 */
const SQL_ASSISTANT_ACTIVITY = `
  SELECT COUNT(*) AS n, MIN(created_at) AS first_at, MAX(created_at) AS last_at
    FROM messages
   WHERE role = 'assistant' AND content IS NOT NULL
`;

/** ledger 有消耗行但无 token_usage——定额端点（出证/导出）本就不产 token，只警告不判错。 */
const SQL_LEDGER_WITHOUT_USAGE = `
  SELECT l.ref_id AS ref_id, l.feature AS feature, l.delta AS delta
    FROM gongdao_ledger l
   WHERE l.type = '消耗' AND l.ref_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM token_usage t WHERE t.ref_id = l.ref_id)
   ORDER BY l.ref_id
`;

export interface ReconcileReport {
  /** 被核验的用户数（余额行与流水的并集）。 */
  users: number;
  /** 判错项：存在任一即对账失败。 */
  problems: string[];
  /** 只提示不判错项。 */
  warnings: string[];
}

/**
 * 计费键 → 厂商回显串的漂移告警（只告警，不判错）。
 * 触发条件：同一 model 下出现过 >1 个 api_model；此时另指出最新值与众值（出现次数最多者），
 * 两者不同即说明厂商近期换了快照，该复核 model_rates 是否还对得上实际在跑的模型。
 */
function apiModelDriftWarnings(db: Database.Database): string[] {
  const rows = db.prepare(SQL_API_MODEL_DRIFT).all() as
    { model: string; api_model: string; n: number; last_id: number }[];

  const byModel = new Map<string, typeof rows>();
  for (const r of rows) {
    const list = byModel.get(r.model) ?? [];
    list.push(r);
    byModel.set(r.model, list);
  }

  const out: string[] = [];
  for (const [model, list] of byModel) {
    if (list.length < 2) continue; // 只有一个回显串 = 没漂移
    // 众值：出现次数最多者（并列时取更晚出现的那个）；最新值：last_id 最大者
    const mode = list.reduce((a, b) => (b.n > a.n || (b.n === a.n && b.last_id > a.last_id) ? b : a));
    const latest = list.reduce((a, b) => (b.last_id > a.last_id ? b : a));
    const detail = list.map((r) => `${r.api_model}×${r.n}`).join('、');
    const tail = latest.api_model === mode.api_model
      ? ''
      : `；最新=${latest.api_model} ≠ 众值=${mode.api_model}（厂商疑似已换快照，请复核 model_rates）`;
    out.push(`计费口径漂移：model=${model} 下出现 ${list.length} 个 api_model（${detail}）${tail}`);
  }
  return out;
}

/**
 * 空账本检查：**有模型回复产生的时间窗内，账本一行都没有 = 判错，不是"账目一致"**。
 *
 * 【为什么这条必须在，2026-08-25 生产冒烟】token_usage / gongdao_ledger / model_rates 三表
 * 全 0 行时，上面每一条检查都无行可查，于是对账报「零不一致」——**一片绿**。
 * 而真相是收费的地基根本没建：漏接线迟早会被发现，但**一个报绿的对账器会让所有人
 * 相信账是对的，从而没人再去看账本**——它是掩盖问题的那一层。
 *
 * 判定用「有没有发生过模型回复」而不是「表空不空」：全新库、只有用户消息还没回的库
 * 都不该报错——**没发生过的事不算漏账**（不知道 ≠ 零）。
 */
function emptyLedgerProblems(db: Database.Database): string[] {
  const act = db.prepare(SQL_ASSISTANT_ACTIVITY).get() as { n: number; first_at: string | null; last_at: string | null };
  if (act.n === 0 || !act.first_at) return []; // 模型一次都没跑过，无账可记

  const out: string[] = [];
  const since = act.first_at;
  const window = `${act.first_at} 起至 ${act.last_at}`;
  const usage = (db.prepare('SELECT COUNT(*) AS n FROM token_usage WHERE created_at >= ?').get(since) as { n: number }).n;
  if (usage === 0) {
    out.push(
      `账本空表：${window} 有 ${act.n} 条模型回复（messages.role='assistant'），` +
        `而 token_usage 在该时间窗内一行都没有——这不是账目一致，是根本没记账（用量口径）`,
    );
  }
  const consume = (
    db
      .prepare("SELECT COUNT(*) AS n FROM gongdao_ledger WHERE type = '消耗' AND created_at >= ?")
      .get(since) as { n: number }
  ).n;
  if (consume === 0) {
    out.push(
      `账本空表：${window} 有 ${act.n} 条模型回复，而 gongdao_ledger 在该时间窗内` +
        `一条「消耗」流水都没有——这不是账目一致，是根本没扣费（账本口径）`,
    );
  }
  return out;
}

/** 对一个已打开的库做全量对账（只读，不写任何行）。 */
export function reconcile(db: Database.Database): ReconcileReport {
  const problems: string[] = [...emptyLedgerProblems(db)];
  const warnings: string[] = [];

  const rows = db.prepare(SQL_BALANCES).all() as
    { user_id: number; balance: number | null; ledger_sum: number | null }[];
  for (const r of rows) {
    if (r.balance == null) {
      problems.push(`用户 ${r.user_id}：有流水（合计 ${r.ledger_sum}）但无 gongdao 余额行`);
    } else if (r.ledger_sum == null) {
      if (r.balance !== 0) problems.push(`用户 ${r.user_id}：有余额行 balance=${r.balance} 但无任何流水`);
    } else if (r.balance !== r.ledger_sum) {
      problems.push(
        `用户 ${r.user_id}：balance=${r.balance} ≠ SUM(ledger.delta)=${r.ledger_sum}（差 ${r.balance - r.ledger_sum}）`,
      );
    }
  }

  const orphans = db.prepare(SQL_USAGE_ORPHANS).all() as { ref_id: string; n: number; cost_li: number }[];
  for (const o of orphans) {
    problems.push(`ref_id=${o.ref_id}：${o.n} 条 token_usage（合计 ${o.cost_li} 厘）无对应「消耗」流水`);
  }

  const noUsage = db.prepare(SQL_LEDGER_WITHOUT_USAGE).all() as
    { ref_id: string; feature: string | null; delta: number }[];
  for (const l of noUsage) {
    warnings.push(`ref_id=${l.ref_id}（feature=${l.feature ?? '-'}，delta=${l.delta}）有消耗流水但无 token_usage`);
  }

  warnings.push(...apiModelDriftWarnings(db));

  return { users: rows.length, problems, warnings };
}

/**
 * CLI 本体：只读打开 dbPath、对账、打印明细。
 * @returns 进程退出码（0=账目一致；1=存在不一致）。
 */
export function reconcileCli(dbPath: string): number {
  console.log(`[对账] 库：${dbPath}`);
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  let report: ReconcileReport;
  try {
    report = reconcile(db);
  } finally {
    db.close();
  }

  console.log(`[对账] 已核 ${report.users} 个用户的余额与流水`);
  for (const w of report.warnings) console.log(`[警告] ${w}`);
  for (const p of report.problems) console.error(`[不一致] ${p}`);

  if (report.problems.length > 0) {
    console.error(`[对账] 失败：${report.problems.length} 项不一致（另有 ${report.warnings.length} 项警告）`);
    return 1;
  }
  console.log(`[对账] 通过：账目一致（${report.warnings.length} 项警告）`);
  return 0;
}
