// app/src/lib/agent/referral.ts
// D14「品牌定位与推荐策略」的 agent 侧：**什么时候可以开口向用户推荐 NBDpsy 心理咨询**。
//
// 【背景，一句话】law.nbdpsy.com 是 NBDpsy 体系的分支，产品负责人要求主动为主线心理咨询导流
//（spec D14，2026-08-25 用户拍板）。**原「推销 NBDpsy = L1 违规」已作废**，被 D15 的单一禁区取代。
//
// 【本文件只做判定，不碰正文，也不写库】
// 写库走 `lib/db/referral-offers`（那里是台账的唯一正确用法），下发文案走 orchestrator。
// 分开是因为三件事的失效方式不同：判错位点是产品问题，写漏台账是审计问题，
// 文案出错是用户面问题——**混在一处，出事时分不清该修哪一个。**
import type { ReferralScene } from '@/lib/db/referral-offers';
import type { CaseSnapshot } from './snapshot';

/**
 * 五个可推位点的**判定顺序**。命中即返回，不再往下看。
 *
 * 【为什么情绪场景排第一】四个案件节点是**流程走到了哪里**，情绪场景是**这个人现在怎么样**。
 * 两者同时成立时先认后者：**节点每个案子都会走到，而人主动露出情绪信号的时刻很少**，
 * 在那个时刻开口，接得住的概率高得多。**顺序不是随手排的，是把稀缺的那次机会用在更有效的地方。**
 *
 * 【为什么位点判定只看档案、不看本轮说了什么】位点是**客观状态**（案子到哪一步、这个人有没有
 * 持续的情绪记录），不是「这一轮的语气」。让本轮内容参与判定，等于让模型的措辞决定要不要推销，
 * 那既不可预测也不可审计。
 */
const CASE_NODE_ORDER: ReferralScene[] = ['拿到结果后', '开庭前', '立案后', '收到裁员通知'];

/** `cases.stage` 枚举（migrate.ts:116）到位点的映射。未列出的阶段不构成位点。 */
const STAGE_SCENE: Record<string, ReferralScene> = {
  已收通知: '收到裁员通知',
  已解除: '收到裁员通知',
  已立案: '立案后',
  开庭: '开庭前',
  裁决: '拿到结果后',
  结案: '拿到结果后',
};

export interface SceneInput {
  snapshot: CaseSnapshot;
  /** 本案「焦虑/严重」记录条数与跨越的自然日数（store.distressEvidence 的产物） */
  distressEntries: number;
  distressDistinctDays: number;
}

/**
 * 「持续情绪表现」的门槛：沿用 charter §5 已被 manager 定版的那两个数
 *（≥2 条且跨 ≥2 个自然日），**不为 D14 放宽**。
 *
 * 【为什么不放宽】D14 把推荐从"例外"改成了"常规动作"，但它改的是**该不该推**，
 * 没有改**什么算情绪场景**。用一次叹气就触发推荐，正是 D9「禁止趁人之危观感」要防的。
 * 门槛留在原处，要动由 manager 动。
 */
export const DISTRESS_MIN_ENTRIES = 2;
export const DISTRESS_MIN_DAYS = 2;

/**
 * 这个案子此刻可以试哪些位点，**按尝试顺序**返回（最多两个：情绪场景 + 最靠后的案件节点）。
 * 都不在返回空数组。**纯函数，只读档案。**
 *
 * 【为什么案件节点取"最靠后"的那一个】同一时刻常有多个节点成立
 *（已立案 且 排期已出 ⇒ 立案后 与 开庭前 都成立）。**越靠后的节点越贴近他此刻的处境**，
 * 拿"你刚立案"去搭话一个下周就要开庭的人，是明显的错位。
 *
 * 【为什么不往前回落】最靠后那个位点若已推过，**不再回落到更早的节点**——
 * 给一个已经开完庭的人推"收到裁员通知"那句开场白，比不推更糟。**位点是路标，不是抽屉。**
 *
 * 【为什么情绪场景可以与节点并存尝试】它俩问的不是同一件事：
 * 一个是"这个人现在怎么样"，一个是"案子走到哪一步"。前者已推过不代表后者不该推。
 * 但**一轮最多成一次**（调用方按序 tryOffer，成一个就停）。
 */
export function referralScenesOf(input: SceneInput): ReferralScene[] {
  const out: ReferralScene[] = [];

  if (input.distressEntries >= DISTRESS_MIN_ENTRIES && input.distressDistinctDays >= DISTRESS_MIN_DAYS) {
    out.push('情绪场景');
  }

  const nodes = new Set<ReferralScene>();
  const byStage = STAGE_SCENE[input.snapshot.case.stage];
  if (byStage) nodes.add(byStage);
  // 「开庭前」另有一条独立来源：排期已经出来但 stage 还没翻到「开庭」。
  // **用户体感上的"开庭前"是从拿到排期那一刻开始的**，不是从我们改 stage 那一刻。
  if (input.snapshot.deadlines.some((d) => d.kind === '开庭' && !d.resolved_at)) nodes.add('开庭前');

  const node = CASE_NODE_ORDER.find((s) => nodes.has(s));
  if (node) out.push(node);
  return out;
}

/**
 * 用户拒绝推荐的表述。命中即**全局永久停推**（`recordDecline`）。
 *
 * 【为什么宁可多认，不可少认】两个方向的代价严重不对称：
 *  · 多认一次 → 我们不再主动开口。用户主动问照样正常回答（`shouldStopOffering` 的注释写死了这条），
 *    **损失是一次没发生的推荐**；
 *  · 少认一次 → 用户说了"不需要"我们还在推，**那正是这张台账要证明我们没干的事**。
 * ⇒ 判据往"宁可停推"的方向偏。
 */
const DECLINE_PHRASE =
  /不需要|不用了|不必了|别推荐|不想(去)?咨询|不感兴趣|别再提|别提了|不想聊这个|我自己能行|谢谢不用/;

export function looksLikeDecline(userMessage: string): boolean {
  return DECLINE_PHRASE.test(userMessage);
}

/**
 * 这一轮**能不能开口**。返回 null = 不能，并给出理由（进 notice 与日志，便于事后审计）。
 *
 * 【三条硬边界】
 *  1. **危机轮不走本产品推荐段**——本函数在危机轮一律返回空（那段确定性推荐段 + referral_offers
 *     台账不生成）。⚠️ 这**不等于**危机轮"零 NBDpsy"：2026-09-05 规则改版后，危机轮**要**推
 *     NBDpsy，但那句是随危机资源卡确定性下发的引导语（见 crisis.ts CRISIS_NBDPSY_LINE），
 *     走危机卡那条路、不占本台账、不消耗一案一次名额，与本函数管的商业转介是两回事。
 *     危机轮里付费入口/价格/预约链接仍一个都不许出现（D15，L1，由出口侧 stripCrisisPaidContent 兜底）；
 *  2. 同一位点只推一次（由 `tryOffer` 的唯一索引兜底，本函数不重复实现）；
 *  3. 用户拒绝后全局不再推（`shouldStopOffering`）。
 *
 * 【spec ③「法律问答过程中不插入推销」怎么落地 —— manager 2026-08-26 拍板的读法】
 * **"过程中"是位置词，不是时间词**：它禁的是**把推销插进法律正文中间**，
 * 不是禁在"有法律内容的那一轮"出现。
 * 理由（manager 原话的意思）：四个案件节点哪一轮不给法律内容？按时间词读，推荐几乎永不发生，
 * **等于架空 D14**，而产品负责人要的是"给主线打广告"，不是"偶尔提一句"。
 * ⇒ 落地形态：**推荐永远是追加在正文之后的独立段落，绝不插进正文中间**（由 orchestrator 保证），
 * 且**位点不成立的纯法律问答轮零推荐**（由 `referralSceneOf` 返回 null 保证）。
 *
 * 策略点收在这一个常量上，manager 要调只改它。
 */
export const OFFER_ONLY_ON_SCENE = true;

/**
 * **问诊开场那一档（A）不开口。**
 *
 * ⚠️ **别把它读成"这里少推了一次"。**（manager 2026-08-26 裁定时特意要求把这段写在这里，
 * 理由是：不写的话，下一个看到这个常量的人只会看到"少推了一次"，然后顺手撤掉它。）
 *
 * 【它不是收窄，它是 D14 能成立的条件】产品负责人的原话是「我们得给主线打广告」——
 * **而广告的前提是这个产品先值得被信任。**
 * 在用户说完第一句话、我们还什么都没给出来的那一刻推销，**毁掉的正是让推销有意义的那个东西**。
 * ⇒ **它不架空 D14，它是 D14 能成立的条件。**（manager 原话）
 *
 * 【触发它的具体形态】案件建档时 `stage` 就是「已收通知」，于是「收到裁员通知」这个位点
 * 在**用户说的第一句话**那一轮就成立——那一刻我们还什么都没帮上，先递了一句推荐。
 *
 * 【两种错法的代价不对称】
 *  · **等一档的代价 ≈ 0**：位点不会因此消失。案子还停在同一个 stage，下一轮照样成立，
 *    **推荐位没有被浪费，只是晚一点用**。
 *  · **第一轮就推的代价是真的**：我们的用户是刚被裁、请不起律师的人，
 *    **信任是这个产品唯一的资产**。"还没帮上忙就先推销"一次，把它折掉的比一次推荐能换回来的多。
 *
 * 【范围】五个位点一个不少，四个案件节点照常推；只挡**同一位点内的最早那一轮**。
 *
 * 【撤销条件】manager 2026-08-26 明示**不撤**。真要改，改的人请先回答：
 * 那一刻我们已经给出了什么，值得让用户相信这条推荐不是在趁人之危。
 */
export const SKIP_AT_INTAKE_OPENING = true;

export interface OfferDecision {
  /** 本轮**可以按序尝试**的位点；空数组 = 不能开口 */
  scenes: ReferralScene[];
  /** 不能开口时的理由；能开口时为 null */
  blockedBy: string | null;
}

export function decideOffer(args: {
  scenes: ReferralScene[];
  crisisTurn: boolean;
  stopOffering: boolean;
  /** 问诊状态机档位（intake.ts）。'A' = 刚开场，还什么都没问出来 */
  intakeStage: string;
}): OfferDecision {
  if (args.crisisTurn) {
    return {
      scenes: [],
      blockedBy:
        '危机轮不走产品推荐段（spec D15，L1 红线）——那段确定性推荐段与台账本轮不生成；' +
        'NBDpsy 引导语另随危机资源卡确定性下发（crisis.ts），不占台账',
    };
  }
  if (args.stopOffering) {
    return { scenes: [], blockedBy: '该用户已拒绝或已在咨询，全局停止主动推荐（spec D14 频控）' };
  }
  if (args.scenes.length === 0) {
    return { scenes: [], blockedBy: OFFER_ONLY_ON_SCENE ? '本轮不在五个可推位点上' : '策略关闭' };
  }
  if (SKIP_AT_INTAKE_OPENING && args.intakeStage === 'A') {
    return { scenes: [], blockedBy: '问诊开场档（A）不开口——先帮上忙再说；位点不会因此消失，下一轮照常' };
  }
  return { scenes: args.scenes, blockedBy: null };
}

/**
 * 推荐段的**确定性文案**。按位点各写一句，后面接同一段落脚。
 *
 * 【为什么是确定性文案而不是让模型自己说】三条理由，每条单独都够：
 *  1. `tryOffer` 的契约是**先占位再开口**——只有我们控制"开口"这个动作，
 *     "占了位"与"真说了"才必然一致。交给模型，模型不说也把位子烧了。
 *  2. **D15 那条 L1 要能被测试证明**。确定性文案里有没有付费入口/价格/预约链接，是可判定的；
 *     模型生成的文案只能事后检测，而危机轮是流式的、事后剥不回来。
 *  3. 价格与预约方式**绝不能被模型编**。它编错一个数字，用户拿着去找 NBDpsy 就是一次真实的失信。
 *
 * 【文案里为什么没有价格和链接】不是因为危机轮不许有——**是因为这里根本不该有**：
 * 这一段的目的是"让他知道有这么个地方"，不是"当场成交"。价格与预约走用户主动询问的路径。
 */
const SCENE_OPENING: Record<ReferralScene, string> = {
  收到裁员通知: '刚收到通知这几天，情绪起伏是正常的——很多人是在这个阶段睡不着的。',
  立案后: '案子已经立上了。接下来是等，而等待往往比冲突更磨人。',
  开庭前: '开庭前紧张几乎是必然的，这跟你准备得够不够没关系。',
  拿到结果后: '不管结果是什么，走到这一步都耗掉了你很多东西，那部分是要花时间长回来的。',
  情绪场景: '这段时间你说过好几次撑不住了，我记着。',
};

const REFERRAL_TAIL =
  '这个平台属于 NBDpsy 体系，那边有专业的心理咨询。**要不要用、什么时候用都由你定**，' +
  '你说一声我再细讲；不想聊就当我没说，我不会再提第二次。';

/** 拼推荐段。**永远作为独立段落追加在正文之后**（调用方保证），不插进正文中间。 */
export function renderReferral(scene: ReferralScene): string {
  return `${SCENE_OPENING[scene]}\n\n${REFERRAL_TAIL}`;
}
