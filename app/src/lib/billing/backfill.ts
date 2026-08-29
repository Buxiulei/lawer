// app/src/lib/billing/backfill.ts
// 从 messages.tokens_json 把**已经发生但没记进账本**的用量补记回 token_usage + gongdao_ledger。
//
// 【为什么需要它】2026-08-25 之前记账根本没接线（三表 0 行），而每一轮的四桶用量其实都
// 老老实实存在 messages.tokens_json 里。接线上线前的这段窗口期里，真实用户的用量
// 会落在 messages 而进不了账本——**可补的账目缺口不值当关闭注册**（manager 裁定），
// 但必须补得回来，且必须能说清补的是哪一段时间。
//
// 【三条纪律】
//  1) **幂等**：已有该轮用量行就跳过；消耗流水另有 (type, ref_id) 唯一索引兜底。反复跑不双扣。
//  2) **不许拿 0 冒充**：tokens_json 里四桶全 null 的轮（当时就没回报计量）**不补**，单列计数——
//     补一行 0 成本等于宣称那几轮免费，而真相是花了多少无从得知（llm/types.ts 铁律）。
//  3) **默认只算不写**：apply=false 时一行不落，只出报告。钱的操作不给「顺手就执行」的机会。
import { type Database } from 'better-sqlite3';

import { openCliDb, rethrowIfSchemaStale } from '../db/cli-open';

import { getRatesForModel } from '../db/modelRates';
import { gongdaoSettle, recordTokenUsage, turnRefId } from './index';
import { featureOfMode } from './features';
import { costOfUsage, type UsageTokens } from './pricing';

/** 待补的一轮：assistant 消息 + 它所属线程的模式 + 案件归属的用户。 */
const SQL_CANDIDATES = `
  SELECT m.id AS message_id, m.created_at AS created_at, m.tokens_json AS tokens_json,
         t.mode AS mode, c.user_id AS user_id
    FROM messages m
    JOIN threads t ON t.id = m.thread_id
    JOIN cases   c ON c.id = t.case_id
   WHERE m.role = 'assistant' AND m.tokens_json IS NOT NULL
   ORDER BY m.id
`;

export interface BackfillReport {
  /** 扫描到的候选轮数（有 tokens_json 的 assistant 消息） */
  scanned: number;
  /** 本次补记的轮数（apply=false 时为「将会补记」） */
  backfilled: number;
  /** 账本里已有该轮用量，跳过 */
  alreadyRecorded: number;
  /** tokens_json 里四桶全 null（当时就没回报计量）→ 不补，单列 */
  unreported: number;
  /** tokens_json 解析不了或缺 model → 不补，单列（数据问题，需人看） */
  malformed: number;
  /** 补记的公道值合计 */
  gongdao: number;
  /** 窗口期：本次补记覆盖的最早/最晚一轮（PR 里要记录的那段时间） */
  windowFrom: string | null;
  windowTo: string | null;
  /** 是否真的写了库 */
  applied: boolean;
}

interface Candidate {
  message_id: number;
  created_at: string;
  tokens_json: string;
  mode: string;
  user_id: number;
}

/** tokens_json 形如 {model, usage:{prompt,completion,cachedRead,cachedWrite}}（orchestrator 写入） */
function parseUsage(raw: string): { model: string; tokens: UsageTokens | null } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const rec = parsed as { model?: unknown; usage?: Record<string, unknown> };
  if (typeof rec?.model !== 'string' || !rec.model || typeof rec.usage !== 'object' || rec.usage === null) return null;
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const four = {
    promptTokens: num(rec.usage.prompt),
    completionTokens: num(rec.usage.completion),
    cacheReadTokens: num(rec.usage.cachedRead),
    cacheWriteTokens: num(rec.usage.cachedWrite),
  };
  // 四桶全 null = 当时就没回报，无从补起（不是 0）
  if (Object.values(four).every((v) => v === null)) return { model: rec.model, tokens: null };
  return {
    model: rec.model,
    tokens: {
      promptTokens: four.promptTokens ?? 0,
      completionTokens: four.completionTokens ?? 0,
      cacheReadTokens: four.cacheReadTokens ?? 0,
      cacheWriteTokens: four.cacheWriteTokens ?? 0,
    },
  };
}

/**
 * 补记窗口期用量。
 * @param apply false（默认）＝只算不写，返回「将会补记多少」；true ＝真写库。
 */
export function backfillTokenUsage(db: Database, apply = false): BackfillReport {
  const rows = db.prepare(SQL_CANDIDATES).all() as Candidate[];
  const has = db.prepare('SELECT 1 FROM token_usage WHERE ref_id = ? LIMIT 1');

  const report: BackfillReport = {
    scanned: rows.length,
    backfilled: 0,
    alreadyRecorded: 0,
    unreported: 0,
    malformed: 0,
    gongdao: 0,
    windowFrom: null,
    windowTo: null,
    applied: apply,
  };

  for (const row of rows) {
    const refId = turnRefId(row.message_id);
    if (has.get(refId)) {
      report.alreadyRecorded += 1;
      continue;
    }
    const parsed = parseUsage(row.tokens_json);
    if (!parsed) {
      report.malformed += 1;
      continue;
    }
    if (!parsed.tokens) {
      report.unreported += 1;
      continue;
    }
    const cost = costOfUsage(parsed.tokens, getRatesForModel(db, parsed.model));
    const feature = featureOfMode(row.mode);
    if (apply) {
      // 与实时记账同一条纪律：用量行与消耗流水同事务，不制造「用量无落账」的孤儿。
      db.transaction(() => {
        recordTokenUsage(row.user_id, feature, parsed.model, parsed.tokens!, refId, null, db);
        gongdaoSettle(row.user_id, cost, refId, feature, db);
      })();
    }
    report.backfilled += 1;
    report.gongdao += cost;
    report.windowFrom ??= row.created_at;
    report.windowTo = row.created_at;
  }
  return report;
}

/**
 * CLI 本体：打开库、补记、打印报告。
 * @returns 进程退出码（0=正常；1=有解析不了的行，需要人看）。
 */
export function backfillCli(dbPath: string, apply: boolean): number {
  console.log(`[回填] 库：${dbPath}｜模式：${apply ? '写入' : '试算（不写库）'}`);
  // 试算一律只读打开：钱的脚本要让「不写」这件事由文件句柄兜底，而不是靠代码里记得别写。
  const db = openCliDb(dbPath, { readonly: !apply, fileMustExist: true });
  db.pragma('foreign_keys = ON');
  let r: BackfillReport;
  try {
    r = backfillTokenUsage(db, apply);
  } catch (e) {
    // 试算是只读句柄，跑不了迁移；缺表时把「为什么」和「怎么办」说清楚，别只丢一句 no such table。
    if (!apply) rethrowIfSchemaStale(e, dbPath);
    throw e;
  } finally {
    db.close();
  }
  console.log(`[回填] 扫描 ${r.scanned} 轮：补记 ${r.backfilled}、已有账 ${r.alreadyRecorded}、当时未回报计量 ${r.unreported}、数据异常 ${r.malformed}`);
  console.log(`[回填] 合计公道值 ${r.gongdao}｜窗口期 ${r.windowFrom ?? '—'} 至 ${r.windowTo ?? '—'}`);
  if (!apply) console.log('[回填] 试算完成，未写任何行；确认无误后加 --apply 执行');
  if (r.malformed > 0) {
    console.error(`[回填] 有 ${r.malformed} 轮的 tokens_json 解析不了或缺 model，未补——这几轮的账要人工核`);
    return 1;
  }
  return 0;
}
