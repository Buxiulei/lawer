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

/** 对一个已打开的库做全量对账（只读，不写任何行）。 */
export function reconcile(db: Database.Database): ReconcileReport {
  const problems: string[] = [];
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
