// app/src/lib/db/referral-offers.ts
// referral_offers 表的封装（spec §6：lib/db 是唯一 SQL 层）。表结构与五条产品语义见 migrate.ts。
//
// 这一层不做归属校验，只忠实读写；"这个案件是不是这个用户的"由 lib/cases 把关。
//
// 本文件是品牌推荐频控（spec D14）的**唯一正确用法**——推荐方不要自己拼 INSERT。
// 台账只追加不修改：offered / declined / accepted 各落各的行，永不 UPDATE 旧行。
// 这张表将来可能要用来证明"我们没有反复骚扰用户"，改写过的台账不成其为证据。
//
// **拒绝的是被推销，不是拒绝服务**：本文件管的是我们**主动开口**这个动作。
// declined / accepted 之后 agent 不再主动提，但页脚/关于页的常驻入口照旧对所有人可见，
// 用户主动问"你们有心理咨询吗"时照常正常回答并给入口——那不经过本层，也不算违反频控。
//
// D15 危机轮禁令（危机轮只给免费热线、不得出现任何付费信息）是**当轮即时判定**，
// 由 lib/agent 判，不落本表：shouldStopOffering 返回 false 不等于"这一轮可以推"。
import type { Database } from 'better-sqlite3';

/** 可推位点：四个案件节点 + 情绪场景，各只推一次。 */
export type ReferralScene = '收到裁员通知' | '立案后' | '开庭前' | '拿到结果后' | '情绪场景';

/** offered=我们开口推了；declined=用户说不需要；accepted=用户真去咨询了。 */
export type ReferralOutcome = 'offered' | 'declined' | 'accepted';

export interface ReferralOfferRow {
  id: number;
  user_id: number;
  case_id: number | null;
  scene: string;
  outcome: string;
  thread_id: number | null;
  note: string | null;
  created_at: string;
}

/** 落一行推荐台账所需的全部信息；caseId / threadId / note 可缺省（情绪场景可能不挂案件）。 */
export interface ReferralParams {
  userId: number;
  caseId?: number | null;
  scene: ReferralScene | string;
  threadId?: number | null;
  note?: string | null;
}

function insert(db: Database, params: ReferralParams, outcome: ReferralOutcome, orIgnore = false) {
  return db
    .prepare(
      `INSERT ${orIgnore ? 'OR IGNORE ' : ''}INTO referral_offers
         (user_id, case_id, scene, outcome, thread_id, note)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      params.userId,
      params.caseId ?? null,
      params.scene,
      outcome,
      params.threadId ?? null,
      params.note ?? null,
    );
}

/**
 * 这个人是否已经**不该再被主动推荐**了：declined 或 accepted 任一即为 true。
 * 跨案件、跨场景、**永久生效，不设 TTL**。
 *
 * 三件事必须说清：
 *
 * 1) 它管的是**我们主动开口**的动作，**不管被动应答**。declined / accepted 之后，
 *    用户主动问"你们有心理咨询吗"时照常正常回答并给入口；页脚/关于页的常驻入口
 *    对所有人始终可见。写死这句是因为**将来一定会有人把它实现成"拒绝过的人连问都
 *    问不到"，那就从克制变成了赌气**。本函数返回 true 只意味着"别再主动提"。
 *
 * 2) accepted 也停推：这个人**已经在接受心理支持了**，他此刻最不需要的就是再被
 *    提醒一次"你需要心理帮助"——对刚迈出那一步的人，重复推荐是一种否定。
 *
 * 3) declined 与 accepted 语义相反（一个是反感、一个是导流成功），后续动作却相同，
 *    仍分两态存：将来要能分辨「导流有效」与「用户反感」，合并成一个标志位就再也分不出来了。
 *
 * 把频控做成「一次查询」而非「一串规则」，是它可能被真正遵守的前提：
 * 规范的可执行性取决于遵守它的成本。agent 在开口推荐之前只需要查这一个函数。
 */
export function shouldStopOffering(db: Database, userId: number): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS hit FROM referral_offers
        WHERE user_id = ? AND outcome IN ('declined', 'accepted') LIMIT 1`,
    )
    .get(userId) as { hit: number } | undefined;
  return row !== undefined;
}

/**
 * 抢占"这个人这个案件这个位点的推荐位"。返回 true 才可以向用户开口；
 * false = 该位点已经推过、或这个人已经全局停推（拒绝过 / 已在咨询），调用方**不得**推。
 *
 * 先占位再开口：本函数必须在真正向用户说出推荐语之前调用，返回 true 才说。
 * 倒过来（先说后记）一旦记录那步失败，下一轮会再推一遍——反复骚扰就是这么来的。
 *
 * 两道闸门：先查 shouldStopOffering（已停推直接返回 false，**不落行**——停推之后连
 * "推过"都不该有记录）；否则 INSERT OR IGNORE 落 offered，靠 uq_referral_offer_scene 挡重复。
 */
export function tryOffer(db: Database, params: ReferralParams): boolean {
  if (shouldStopOffering(db, params.userId)) return false;
  return insert(db, params, 'offered', true).changes > 0;
}

/**
 * 用户说"不需要"。不去重：同一个人在不同场景各拒一次都各留一行痕迹
 * （一个人拒了几次、在哪些场景拒的，是我们该看见的东西）。
 * 落行之后 shouldStopOffering 即恒为 true，全站不再主动推。
 */
export function recordDecline(db: Database, params: ReferralParams): void {
  insert(db, params, 'declined');
}

/**
 * 用户真去咨询了。用户**主动**找上门成交也记这里——那不视为频控被绕过：
 * 频控约束的是我们主动开口，不是拦着用户不让来。
 * 落行之后 shouldStopOffering 亦恒为 true：已经在接受心理支持的人，
 * 不该再被提醒一次"你需要心理帮助"。
 */
export function recordAccept(db: Database, params: ReferralParams): void {
  insert(db, params, 'accepted');
}

/** 审计/管理端视图：这个人的全部推荐往来，最新在前。 */
export function listByUser(db: Database, userId: number, limit = 100): ReferralOfferRow[] {
  return db
    .prepare('SELECT * FROM referral_offers WHERE user_id = ? ORDER BY id DESC LIMIT ?')
    .all(userId, limit) as ReferralOfferRow[];
}
