// app/src/lib/db/elements.ts
// `element_fills` 的取数面：「这一行事实是为了坐实哪一个要件写进来的」。
//
// 【为什么单独一个文件】它只有两个函数、零业务判断，而 lib/db/agent.ts 已经很长；
// 更要紧的是**读侧只有一个消费者**（element_sheet_get 的 filled_by 列）。
// 混进那个文件的形态是：下一个人为了看懂一张 20 行的关系表，先读完一屏别的表。
import type { Database } from 'better-sqlite3';

/** 一条填充留痕。`targetTable` 只会是 timeline_events 或 claims（写侧限定，见能力壳）。 */
export interface ElementFillRow {
  id: number;
  case_id: number;
  element_id: string;
  slot: string;
  target_table: string;
  target_id: number;
  created_at: string;
}

/**
 * 记一条填充留痕。**幂等**：同案 + 同要件 + 同一行事实重复记只留一条
 *（唯一索引 uq_element_fills + INSERT OR IGNORE）。
 *
 * 重复记会怎样：模型在一轮里把同一条事件映射给同一个要件两次（它常这么干），
 * 不幂等的形态是 filled_by 那一列印出两个一模一样的行号，用户以为自己有两份材料。
 */
export function recordElementFill(
  db: Database,
  input: { caseId: number; elementId: string; slot: string; targetTable: string; targetId: number },
): void {
  db.prepare(
    `INSERT OR IGNORE INTO element_fills (case_id, element_id, slot, target_table, target_id)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(input.caseId, input.elementId, input.slot, input.targetTable, input.targetId);
}

/**
 * 按唯一键取回那一条留痕（uq_element_fills 的四列）。取不到回 null。
 *
 * 【谁用它】台账元数据（能力 element_fill 的 ledger.rowsOf）：recordElementFill 走的是
 * INSERT OR IGNORE、不回行号，而台账那一行要指得出**具体是哪一条留痕**。
 * 不回读、拿业务侧那张表的行号顶替的形态是：agent_writes 说 target_table=element_fills
 * 而 target_id 是一条时间线事件的号——两张表的行号都是小整数，指错了也照样像个正常记录。
 */
export function findElementFill(
  db: Database,
  key: { caseId: number; elementId: string; targetTable: string; targetId: number },
): ElementFillRow | null {
  const row = db
    .prepare(
      `SELECT * FROM element_fills
        WHERE case_id = ? AND element_id = ? AND target_table = ? AND target_id = ?`,
    )
    .get(key.caseId, key.elementId, key.targetTable, key.targetId) as ElementFillRow | undefined;
  return row ?? null;
}

/** 本案的全部填充留痕（按 id 升序，即写入先后）。 */
export function listElementFills(db: Database, caseId: number): ElementFillRow[] {
  return db
    .prepare('SELECT * FROM element_fills WHERE case_id = ? ORDER BY id')
    .all(caseId) as ElementFillRow[];
}
