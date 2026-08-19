// app/src/lib/db/modelRates.ts
// model_rates 表封装：模型 token 费率的唯一读写入口。
// 表只追加不修改——改价 = 写一条更晚 effective_at 的新行，历史行保留以便按当时费率复算旧账。
// 预编译语句按 db 实例缓存（同一 db 只 prepare 一次；:memory: 单测各自独立 db 不互相污染）。
import type Database from 'better-sqlite3';
import { DEFAULT_RATES, type TokenRates } from '../billing/pricing';

/**
 * 每档取 effective_at ≤ now 的最新一行。
 * SQLite 特例：聚合查询里只用 MAX() 一个聚合函数时，同 SELECT 的裸列取自 MAX 所在那行——
 * 故一次分组即可拿到「每档最新生效行」的费率，无需相关子查询。
 */
const SQL_LATEST_RATES = `
  SELECT token_kind, gongdao_per_token, MAX(effective_at) AS eff
    FROM model_rates
   WHERE model = ? AND effective_at <= datetime('now')
   GROUP BY token_kind
`;

// effective_at 统一经 datetime() 归一（既接受 'YYYY-MM-DD HH:MM:SS' 也接受 ISO 串），
// 否则字符串比较会把 '2026-01-01T00:00:00Z' 排到 '2026-01-01 00:00:00' 之后，取错生效行。
const SQL_INSERT_RATE = `
  INSERT INTO model_rates (model, token_kind, gongdao_per_token, effective_at)
  VALUES (?, ?, ?, COALESCE(datetime(?), datetime('now')))
`;

interface Stmts {
  latest: Database.Statement;
  insert: Database.Statement;
}

const CACHE = new WeakMap<Database.Database, Stmts>();

function stmts(db: Database.Database): Stmts {
  let s = CACHE.get(db);
  if (!s) {
    s = { latest: db.prepare(SQL_LATEST_RATES), insert: db.prepare(SQL_INSERT_RATE) };
    CACHE.set(db, s);
  }
  return s;
}

/**
 * 取某模型当前生效的三档费率（单位 公道值/token）。
 * 三档任一缺行（含整个模型没配过费率）时，该档回落 DEFAULT_RATES——
 * 宁可按兜底草案计费，也不让没配费率的模型白跑不记账。
 */
export function getRatesForModel(db: Database.Database, model: string): TokenRates {
  const rows = stmts(db).latest.all(model) as { token_kind: string; gongdao_per_token: number }[];
  const rates: TokenRates = { ...DEFAULT_RATES };
  for (const r of rows) {
    if (r.token_kind === 'in' || r.token_kind === 'out' || r.token_kind === 'cache') {
      rates[r.token_kind] = r.gongdao_per_token;
    }
  }
  return rates;
}

/**
 * 追加一条费率（改价即追加，绝不 UPDATE 既有行）。
 * effectiveAt 省略即刻生效；同 (model, token_kind, effective_at) 重复写入由唯一索引抛错——
 * 这是有意的：同一时点两个不同费率无法判定用哪个，必须由调用方给出不同生效时间。
 */
export function setModelRate(
  db: Database.Database,
  model: string,
  kind: 'in' | 'out' | 'cache',
  gongdaoPerToken: number,
  effectiveAt?: string,
): void {
  stmts(db).insert.run(model, kind, gongdaoPerToken, effectiveAt ?? null);
}
