// app/src/lib/billing/index.ts
// 公道值账本核心（钱的地基）。设计四铁律：
//   1) gongdao_ledger 是唯一事实源，gongdao.balance 是其物化余额；对账 = SUM(ledger.delta)。
//   2) 全部写入幂等：ref_id 非空时 (type, ref_id) 唯一部分索引 + INSERT OR IGNORE + changes 守卫——
//      重复调用绝不双记/双扣。
//   3) 事务内原子：流水与余额同增同减，不可分。
//   4) 宁可少扣不可多扣：结算按实际 token（无预扣退费）；最后一单允许透支入负，负余额由 gate 拦。
// 核心函数末位可注入 db（默认进程级 getDb()），便于 :memory: 单测。
import type Database from 'better-sqlite3';
import { getDb } from '../db/client';
import { getRatesForModel } from '../db/modelRates';
import {
  GONGDAO_GATE_MIN,
  GONGDAO_LEDGER_TYPE,
  costLiOfUsage,
  type GongdaoLedgerType,
  type UsageTokens,
} from './pricing';

/**
 * 一轮对话的记账幂等键：**一轮一笔，与模型往返次数无关**。
 * 用量行（token_usage.ref_id）与消耗流水（gongdao_ledger.ref_id）共用它——对账靠它把两侧对起来，
 * 重放同一轮由 (type, ref_id) 唯一索引挡下。实时记账与回填脚本必须用同一个函数生成，
 * 各写各的格式会让回填在已记过账的轮上再扣一笔。
 */
export function turnRefId(messageId: number): string {
  return `turn-${messageId}`;
}

/** 读取公道值余额（无行视作 0）。 */
export function getGongdao(userId: number, db: Database.Database = getDb()): number {
  const row = db.prepare('SELECT balance FROM gongdao WHERE user_id=?').get(userId) as
    | { balance: number }
    | undefined;
  return row?.balance ?? 0;
}

export interface GongdaoLedgerEntry {
  id: number;
  delta: number;
  type: string;
  ref_id: string | null;
  feature: string | null;
  created_at: string;
  /** 这一笔之后的余额，由当前余额沿时间倒推 */
  balance_after: number;
}

export interface GongdaoLedgerView {
  /** 物化余额（gongdao.balance），就是计费门槛实际读的那个数 */
  balance: number;
  /**
   * 账本流水求和。**与 balance 一起返回，不是冗余。**
   * 二者不等意味着物化余额与账本不符（对账器判错的那种情形）。
   * 如果这里只返回一个数，页面上会渲染出一个**看起来完全正常的错数**——
   * 而本产品页面写着「每一笔都记着只增不改」，那句承诺的兑现方式就是让不符可见。
   */
  ledger_sum: number;
  entries: GongdaoLedgerEntry[];
}

/**
 * 读某人的公道值余额与流水（倒序，最新在前）。
 *
 * 【balance_after 为什么由余额倒推而不是正向累加】正向累加要求拿到**全部**流水，
 * 一分页就会错；倒推只需要当前余额和本页这些笔，任何 limit 下都是对的。
 */
export function listGongdaoLedger(
  userId: number,
  limit = 50,
  db: Database.Database = getDb(),
): GongdaoLedgerView {
  const balance = getGongdao(userId, db);
  const sumRow = db.prepare('SELECT COALESCE(SUM(delta),0) AS s FROM gongdao_ledger WHERE user_id=?').get(userId) as {
    s: number;
  };
  const rows = db
    .prepare(
      'SELECT id, delta, type, ref_id, feature, created_at FROM gongdao_ledger WHERE user_id=? ORDER BY id DESC LIMIT ?',
    )
    .all(userId, Math.max(1, Math.min(200, Math.trunc(limit)))) as Omit<GongdaoLedgerEntry, 'balance_after'>[];

  let running = balance;
  const entries: GongdaoLedgerEntry[] = [];
  for (const r of rows) {
    entries.push({ ...r, balance_after: running });
    running -= r.delta;
  }
  return { balance, ledger_sum: sumRow.s, entries };
}

/** 一轮对话能不能开始，以及此刻的余额（拦下时文案要说出这个数）。 */
export interface TurnGate {
  ok: boolean;
  balance: number;
}

/**
 * **对话闸的唯一入口**（主理人 2026-09-03「拦」）：开始新一轮之前问它一句。
 * 余额 ≥ GONGDAO_GATE_MIN（=1）放行；0 与负数一律拦（负余额来自上一轮的透支结算，
 * 「最多欠一轮」的那一轮就是被这里收住的）。
 *
 * 【为什么判定收在 lib/billing 而不是写在路由里】判定要读 gongdao 表，而余额的口径
 * （物化余额 vs 账本求和、门槛是几、会员算不算数）全长在本文件。路由自己 SELECT 一次，
 * 门槛就有了第二份定义——下一处需要闸的调用方会照抄那一份，而那一份不会跟着这里改。
 * 判据侧另有结构守卫钉住「chat 路由不许自己读 gongdao 表」。
 *
 * 【会员没有口子】会员的额度是**买来入账的公道值**（gongdaoGrant），不是绕过闸的资格，
 * 所以这里不看 membership：会员余额到 0 同样拦。
 *
 * 只读，不写任何行——拦下的那一轮必须做到 messages / ledger / token_usage 全部零新增。
 */
export function canStartTurn(userId: number, db: Database.Database = getDb()): TurnGate {
  const balance = getGongdao(userId, db);
  return { ok: balance >= GONGDAO_GATE_MIN, balance };
}

/**
 * 被闸拦下时对外说的那句话，自述三段式：**余额多少 / 为什么开不了 / 怎么办**。
 *
 * 与判定同处一处，是为了让「说出去的余额」和「判定用的余额」永远是同一个数：
 * 在路由里就地拼一句，下一处需要拦的地方会照抄，而余额口径改了那份不会跟着改。
 *
 * 这是**服务端 API 面**的文案（curl / 自带 agent / 第三方客户端都读它），
 * 所以用产品原词「公道值」。网页横幅另有一份低调模式下换成中性词的说法
 * （见 case/[id]/_components/StreamParts 的 GongdaoExhaustedBanner）——
 * 两处受众不同：API 面没有旁人在肩后看屏幕，网页有。
 */
export function gongdaoExhaustedMessage(balance: number): string {
  return (
    `公道值余额 ${balance}，这一轮开不了。` +
    `每轮对话按实际消耗的 token 扣公道值，余额低于 ${GONGDAO_GATE_MIN} 就不再起新的一轮` +
    `（已经开始的那一轮会照常答完）。` +
    `到「我的」页兑换一张公道值码，或买一份套餐充值，回来接着问。`
  );
}

/**
 * 计费门槛的布尔外壳（同一道判定，见 canStartTurn）。
 * 两个名字共用一份判定，改门槛只改一处。
 */
export function gongdaoGate(userId: number, db: Database.Database = getDb()): boolean {
  return canStartTurn(userId, db).ok;
}

/**
 * 公道值入账（正向：会员额度/充值/兑换/注册赠送等）。
 * 幂等：refId 非空时 (type, refId) 唯一索引兜底，重复调用只入账一次；refId=null 时不去重（每次都记）。
 * @returns true=本次真实入账；false=命中幂等（已入过账，跳过）或 delta 非正被拒。
 */
export function gongdaoGrant(
  userId: number,
  delta: number,
  type: GongdaoLedgerType,
  refId: string | null = null,
  meta: Record<string, unknown> | null = null,
  db: Database.Database = getDb(),
): boolean {
  if (!Number.isFinite(delta) || delta <= 0) return false; // 入账必为正整数，防误用
  const amount = Math.trunc(delta);
  return db.transaction(() => {
    const res = db
      .prepare('INSERT OR IGNORE INTO gongdao_ledger (user_id, delta, type, ref_id, meta_json) VALUES (?,?,?,?,?)')
      .run(userId, amount, type, refId, meta ? JSON.stringify(meta) : null);
    if (res.changes === 0) return false; // 命中幂等，余额已入过
    db.prepare('INSERT INTO gongdao (user_id, balance) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET balance = balance + ?')
      .run(userId, amount, amount);
    return true;
  })();
}

/**
 * 公道值结算（负向：任务结束按实际 token 汇总扣一笔）。事务内原子：
 * 消耗流水（幂等 ref）+ 余额扣减。允许扣成负数（最后一单可透支，后续被 gongdaoGate 拦）。
 * 失败结算按「实际已消耗」传 cost（无预扣退费那套）；cost=0 时只落幂等标记不动余额。
 * 幂等：同 refId 重复结算只扣一次（唯一索引 uq_gongdao_ledger_ref）。
 *
 * meta：本笔的审计痕（如「请求 opus 而实际由 sonnet 服务，故按 sonnet 计价」，
 * 见 billing/served-model.ts）。**异常才写，正常轮传 null**——每笔都塞 meta 就没人会去看它。
 * 参数位置与 gongdaoGrant 一致（meta 在 db 之前），两个入账口的形状不该各是各的。
 */
export function gongdaoSettle(
  userId: number,
  cost: number,
  refId: string,
  feature: string | null = null,
  meta: Record<string, unknown> | null = null,
  db: Database.Database = getDb(),
): void {
  const amount = Math.max(0, Math.trunc(cost)); // 结算额非负整数
  db.transaction(() => {
    const res = db
      .prepare(
        'INSERT OR IGNORE INTO gongdao_ledger (user_id, delta, type, ref_id, feature, meta_json) VALUES (?,?,?,?,?,?)',
      )
      .run(userId, -amount, GONGDAO_LEDGER_TYPE.consume, refId, feature, meta ? JSON.stringify(meta) : null);
    if (res.changes === 0) return; // 命中幂等，已扣过
    if (amount !== 0) {
      db.prepare('INSERT INTO gongdao (user_id, balance) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET balance = balance - ?')
        .run(userId, -amount, amount);
    }
  })();
}

/**
 * 公道值退款（正向：定额预扣的任务失败后退还）。镜像 gongdaoSettle 反向：
 * 退款流水（type='退款'，幂等 ref='refund-<chargeRef>'）+ 余额回补。
 * 定额端点（证据固化、材料导出等，见 estimate.FIXED_PRICING）有意背离「按实结算」范式——
 * 它们是定额/确定性操作，先扣后做、失败退还，用户看得懂。幂等：同 chargeRef 重复退款只退一次。
 * @returns true=本次真实退款；false=命中幂等（已退过）或 amount 非正。
 */
export function gongdaoRefund(
  userId: number,
  amount: number,
  chargeRef: string,
  feature: string | null = null,
  db: Database.Database = getDb(),
): boolean {
  const value = Math.max(0, Math.trunc(amount));
  if (value === 0) return false;
  const refId = `refund-${chargeRef}`;
  return db.transaction(() => {
    const res = db
      .prepare('INSERT OR IGNORE INTO gongdao_ledger (user_id, delta, type, ref_id, feature) VALUES (?,?,?,?,?)')
      .run(userId, value, GONGDAO_LEDGER_TYPE.refund, refId, feature);
    if (res.changes === 0) return false; // 命中幂等，已退过
    db.prepare('INSERT INTO gongdao (user_id, balance) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET balance = balance + ?')
      .run(userId, value, value);
    return true;
  })();
}

/** 管理员调整结果：ok=false 表示因「调整不可致负」被拒，此时未写任何行。 */
export interface AdminAdjustResult {
  ok: boolean;
  balance: number;
}

/**
 * 管理员手动调整公道值（可正可负）。不走 ref 幂等（每次调整均有意为之），备注入 meta_json。
 * 与结算不同：调整不可致负。事务内先读余额，balance + delta < 0 即整笔拒绝、不写流水不动余额——
 * 透支只允许由用户自己的最后一单造成，不允许由后台一笔调整凭空造出负债。
 */
export function adminAdjustGongdao(
  userId: number,
  delta: number,
  note: string,
  db: Database.Database = getDb(),
): AdminAdjustResult {
  const d = Math.trunc(delta);
  return db.transaction(() => {
    const balance = getGongdao(userId, db);
    if (d === 0) return { ok: false, balance };
    if (balance + d < 0) return { ok: false, balance }; // 调整不可致负：整笔拒绝
    db.prepare('INSERT INTO gongdao_ledger (user_id, delta, type, ref_id, meta_json) VALUES (?,?,?,NULL,?)')
      .run(userId, d, GONGDAO_LEDGER_TYPE.admin, JSON.stringify({ note }));
    db.prepare('INSERT INTO gongdao (user_id, balance) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET balance = balance + ?')
      .run(userId, d, d);
    return { ok: true, balance: balance + d };
  })();
}

/**
 * 记录一次模型调用的 token 用量（分析/审计流水，非账本事实源——账本以 gongdao_ledger 为准）。
 * 费率按 model 从 model_rates 取当时生效那档（缺行走 DEFAULT_RATES），cost_li 单位 0.001 公道值。
 * plain insert，不设幂等约束：一次任务可分多段记多行，与 ledger 消耗行按 ref_id 对账。
 *
 * model 与 apiModel 是两个串（见 token_usage 表注释）：model 是计费键（决定扣多少），
 * apiModel 是厂商响应回显的实际模型串（决定「真跑了哪个快照」）。调用侧拿到回显就传，
 * 拿不到留空——对账脚本靠它发现厂商把别名重指向新快照造成的计费口径漂移。
 */
export function recordTokenUsage(
  userId: number,
  feature: string,
  model: string,
  tokens: UsageTokens,
  refId: string | null = null,
  apiModel: string | null = null,
  db: Database.Database = getDb(),
): void {
  const rates = getRatesForModel(db, model);
  db.prepare(
    `INSERT INTO token_usage
       (user_id, feature, model, api_model, prompt_tokens, completion_tokens,
        cache_read_tokens, cache_write_tokens, embed_tokens, cost_li, ref_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    userId,
    feature,
    model,
    apiModel,
    tokens.promptTokens ?? 0,
    tokens.completionTokens ?? 0,
    tokens.cacheReadTokens ?? 0,
    tokens.cacheWriteTokens ?? 0,
    tokens.embedTokens ?? 0,
    costLiOfUsage(tokens, rates),
    refId,
  );
}
