// app/src/lib/cases/elements.ts
// **要件三态与举证责任的类型层**（设计稿 §2 A3 / §6 S4「先类型后内容」）。
//
// 【本票只给类型与推导，不写任何一条要件卡的内容】要件卡内容（哪几个要件、条号锚点、
// 典型证据）在 S6，且要走「AI 多路独立推导 + 官方原文机械比对 + 对抗复审」（§9.3）。
// 先落类型的理由是 A3：**三态必须由来源档程序推导，不能由模型每轮现判**——
// 模型现判的形态是同一个案子这一轮说"成立"、下一轮说"待证"，两轮都言之凿凿。
//
// 【三态怎么推（这就是全部规则）】
//   · satisfiedBy 的事实**全部在档**且最弱的那条 ≥ 书证 ⇒ 成立
//   · satisfiedBy 的事实全部在档、但其中有纯自述       ⇒ 成立·待证
//   · satisfiedBy 里有事实**不在档**（〔未记录〕）      ⇒ 缺失
//   · negatedBy 命中且 ≥ 书证                          ⇒ 不成立
// 「缺失」与「不成立」是两件事，且是这套东西存在的理由：〔未记录〕= 档案里没有这一项，
// **不是**"事实上没有"。把它读成不成立的形态是——模型据此说"你没有这份记录，所以这一项不成立"，
// 而用户手机里就有半年的截图，只是没上传（设计稿 §1.2「未记录误判」= 0，红线）。
//
// 【本文件零领域内容】要件名、条号、举证责任的**用户可见措辞**一律走 DomainPack；
// 这里的 Burden 取值是中立编码（claimant / respondent / …），渲染时才换成本行当的说法。
import {
  isDocumented,
  normalizeSourceTier,
  tierRank,
  type SourceTier,
} from './source-tier';

/**
 * 要件三态（实为四态：三个"还在推进"的档 + 一个终态）。
 *
 * 【为什么「成立·待证」不能并进「成立」】它们对用户的下一步动作完全相反：
 * 「成立」什么都不用做，「成立·待证」要去补一张具体的证。合成一档的形态是——
 * 一个全靠自述撑起来的主张在页面上显示为"成立"，用户带着它去开庭。
 */
export const ELEMENT_STATUSES = ['成立', '成立·待证', '缺失', '不成立'] as const;
export type ElementStatus = (typeof ELEMENT_STATUSES)[number];

/**
 * 举证责任落在谁身上。**中立编码**，用户可见的说法由 DomainPack 给
 *（同一个 respondent 在不同行当里叫法完全不同）。
 *
 * · claimant                 —— 主张方（我方）自己举证。
 * · respondent               —— 对方举证。
 * · reversed_interpretation  —— 由司法解释倒置到对方。
 * · reversed_procedure_rules —— 由程序规则（办案机构的证据规则）倒置到对方。
 * · unverified               —— **条号还没核实**，现在说不出它落在谁身上。
 *
 * 【为什么必须有 unverified 这一档，而且是强制的】举证责任讲反是本产品最贵的一类错：
 * 用户据此决定"这件事我不用证"，而开庭那天没人替他证。条号没核实过就填一个方向的形态是——
 * 那个方向读起来和核实过的一模一样。所以 buildElementSheet **强制**把 basis 未核实的
 * 要件的 burden 压成 unverified，卡片自己填了什么都不算（设计稿 §1.3「举证责任讲反」行）。
 */
export const BURDENS = [
  'claimant',
  'respondent',
  'reversed_interpretation',
  'reversed_procedure_rules',
  'unverified',
] as const;
export type Burden = (typeof BURDENS)[number];

/** 条号锚点。`verified` = 这条法源的原文已取回并逐字核对过（登记簿口径，设计稿 §4.1-2）。 */
export interface ElementBasis {
  /** law@article@version 形态的锚点串；空串不算锚点 */
  anchor: string;
  /** 原文已取回并核对过？未核实的锚点会把整条要件的 burden 压成 unverified */
  verified: boolean;
}

/**
 * 事实槽的寻址串：`<表>:<该表在本行当里的取值>`。
 *
 * 表前缀是**跨领域固定**的五个（claim / timeline / company / evidence / basics），
 * 冒号后面的部分由领域自己的词表决定（诉求种类、事件类别、主体角色、证据类别、基本盘列名）。
 * 这样寻址串本身不含行当知识，而它指向的东西完全是行当的。
 */
export const FACT_SLOT_SOURCES = ['claim', 'timeline', 'company', 'evidence', 'basics'] as const;
export type FactSlotSource = (typeof FACT_SLOT_SOURCES)[number];

/** 基本盘四列——`basics:` 后面只认这四个列名（写错一个会被当作不认识的槽，见 resolveSlot） */
export const BASICS_FIELDS = ['employed_from', 'position', 'monthly_wage_fen', 'contract_count'] as const;
export type BasicsField = (typeof BASICS_FIELDS)[number];

/**
 * 一个事实槽的**取值判定**。
 *
 * 【为什么需要它】`resolveSlot` 对 `basics:` 只判**填没填**（首诊那几项是自由文本）。
 * 于是「合同签订次数」填了「2 次」，也算「自用工之日起满一个月仍没有订立书面合同」
 * 这个要件有自述支撑——用户明说签过两次合同，要件表还写着这一项「成立·待证」。
 * **字段有值 ≠ 事实成立**：要看取值的槽在卡片里写一句怎么看，看不过按〔未记录〕算。
 *
 * 【本文件零领域内容】`accepts` 怎么认那串字是行当知识，函数体在领域包里；
 * 这里只定义"有这么一格判定"，一个字面量都不认识。
 */
export interface SlotValueCheck {
  /** 这一格的取值算不算支撑本要件。收的是用户自述的那串原字（已确认非空） */
  accepts: (raw: string) => boolean;
  /** 这一项在「还差什么」清单里的名字（用户可见，措辞归领域包）——看不过、或这一格还空着时都用它点名 */
  missingAs: string;
}

/** 一张要件卡。内容由领域包给（S6 已填 labor 四诉求），本文件只定形状。 */
export interface ElementCard {
  id: string;
  /**
   * 这个要件属于**哪一项诉求**（取值须在该领域包的 claimKinds 里，assertDomainPack 机检）。
   *
   * 【为什么要件要挂在诉求上，而不是一张平表】要件表是按诉求读的：「我要 2N，还差哪几件事」。
   * 平表的形态是——一个只主张欠薪的人，读到一整屏关于违法解除的要件全标着「缺失」，
   * 于是他要么以为自己什么都不成立，要么去补一堆与他这件事无关的材料。
   */
  claimKind: string;
  /** 要件名，逐字对外（用户可见，措辞归领域包） */
  name: string;
  /** 卡片自报的举证责任；basis 未全部核实时**会被强制压成 unverified** */
  burden: Burden;
  /** 法条锚点。空数组 = 没有锚点 ⇒ burden 一律 unverified */
  basis: readonly ElementBasis[];
  /** 支撑这个要件的事实槽（**全部**在档才谈得上成立） */
  satisfiedBy: readonly string[];
  /**
   * 个别槽位的取值判定（省略 = 每个槽都只判"填没填"）。key 必须是 `satisfiedBy` 里的槽串，
   * 且只有 `basics:` 那几格有"取值"这回事（其余四张表的槽，冒号后面写的是筛选条件，
   * 不是用户填的字）——挂错地方会被当作配置错误点名，不静默。
   */
  slotChecks?: Readonly<Record<string, SlotValueCheck>>;
  /** 命中即推翻这个要件的事实槽（省略 = 本要件没有可机械判定的反证） */
  negatedBy?: readonly string[];
  /**
   * 这一项**通常拿什么去证**（用户可见，措辞归领域包）。**不许为空**。
   *
   * 【为什么它是必填的】要件表最贵的一格是「缺失」：它告诉用户"这一项现在立不住"。
   * 只说缺、不说补什么的形态是把人堵在原地（设计稿 §7.7 禁令配出路），而且
   * 「争点 → 行动卡/追问」的链接率判据就是靠这一列做到 100% 的——空了那条争点就没有出路。
   */
  typicalEvidence: readonly string[];
}

/** 推导出来的一行。`note` 只在有话要说时出现（不认识的槽、被压过的 burden）。 */
export interface ElementRow {
  id: string;
  /** 这一行属于哪一项诉求（原样取自卡片，渲染按它分组） */
  claimKind: string;
  name: string;
  status: ElementStatus;
  burden: Burden;
  /** burden 被强制压成 unverified 了吗（卡片自报的是别的值） */
  burdenForced: boolean;
  /** 还差哪几个槽的事实（status='缺失' 时非空）——「补哪张证」的清单就是它 */
  missingSlots: readonly string[];
  /** 已在档但只有自述档的槽（status='成立·待证' 时非空） */
  selfReportedSlots: readonly string[];
  /** 寻址串解析不出来的槽。**不静默**：不认识的槽会连带把状态压成缺失并在这里点名 */
  unresolvedSlots: readonly string[];
  /** 这一项通常拿什么去证（原样取自卡片）。「缺失」行的出路就是它 */
  typicalEvidence: readonly string[];
  /** 卡片声明的法条锚点（原样透传，供报告「依据清单」与争点表引用） */
  basis: readonly ElementBasis[];
}

export interface ElementSheet {
  rows: readonly ElementRow[];
  /**
   * 要件表**渲染不渲染**。空要件卡（本领域还没做 S6）时为 false——
   * 渲染一张零行的要件表的形态是：用户读到"要件：（空）"，那看起来像"你一个要件都不成立"。
   * 降级的正确形状是**整节不出现**，由调用方据此判断（判据钉的就是这一条）。
   */
  rendered: boolean;
}

/**
 * 推导要件表要读的那部分档案。**结构化子集，不是 CaseSnapshot 本身**——
 * 写成 CaseSnapshot 的形态是 lib/cases 反向依赖 lib/agent；写成子集则 CaseSnapshot
 * 天然满足它（结构化类型），调用方直接把 snapshot 传进来即可。
 */
export interface ElementFactsView {
  case: {
    employed_from: string | null;
    position: string | null;
    monthly_wage_fen: number | null;
    contract_count: string | null;
  };
  claims: readonly { kind: string; source_tier: string }[];
  timeline: readonly { kind: string; source_tier: string }[];
  companies: readonly { role: string; source_tier: string }[];
  /** 证据行本身就是**在档的材料**：有一件在这个类别下，这个槽就是书证档 */
  evidence: readonly { category: string; voided_at?: string | null }[];
}

/** 基本盘的一格算不算"填了"。与事实卡的 hasValue 同口径：空串与 0 都不算。 */
function basicsFilled(v: string | number | null | undefined): boolean {
  if (v == null) return false;
  if (typeof v === 'number') return v > 0;
  return v.trim().length > 0;
}

/**
 * 一组行里最弱 / 最强的那个档。**两个函数都在认不出档位时跳过那一行**，
 * 全组都认不出就回 null（＝按〔未记录〕处理）：一个写坏的档位值不该被当成"有支撑"。
 */
function weakestTier(rows: readonly { source_tier: string }[]): SourceTier | null {
  let weakest: SourceTier | null = null;
  for (const r of rows) {
    const t = normalizeSourceTier(r.source_tier);
    if (t === null) continue;
    if (weakest === null || tierRank(t) < tierRank(weakest)) weakest = t;
  }
  return weakest;
}

function strongestTier(rows: readonly { source_tier: string }[]): SourceTier | null {
  let best: SourceTier | null = null;
  for (const r of rows) {
    const t = normalizeSourceTier(r.source_tier);
    if (t === null) continue;
    if (best === null || tierRank(t) > tierRank(best)) best = t;
  }
  return best;
}

/**
 * 一个槽当前的档位。
 *
 * @returns `undefined` = 寻址串不认识（不是"没有这条事实"，两者要分开报）；
 *   `null` = 认识这个槽，但档案里没有这条事实（〔未记录〕）；否则是档位。
 */
export function resolveSlot(slot: string, facts: ElementFactsView): SourceTier | null | undefined {
  const at = slot.indexOf(':');
  if (at <= 0) return undefined;
  const source = slot.slice(0, at);
  const value = slot.slice(at + 1).trim();
  if (!(FACT_SLOT_SOURCES as readonly string[]).includes(source) || value === '') return undefined;

  switch (source as FactSlotSource) {
    // claim / company：同一个 kind（或角色）在库里只该有一行，多行时按**最弱**算——
    // 拿最强的那行代表全体，等于让一条有书证的行把旁边那条纯自述的盖过去。
    case 'claim':
      return weakestTier(facts.claims.filter((c) => c.kind === value));
    case 'timeline':
      // 时间线相反，取**最强**的那条：同一件事被记了两遍（一遍自述、一遍由提取写入），
      // 按最弱算等于把已经有的书证当没有。两处方向不同是刻意的——
      // 上面那两张表一行一物，时间线一物可多行。
      return strongestTier(facts.timeline.filter((e) => e.kind === value));
    case 'company':
      return weakestTier(facts.companies.filter((c) => c.role === value));
    case 'evidence': {
      // 已作废的材料不算数：作废的定义就是"从所有对外视图里摘出去"（migrate.ts void_reason）。
      const live = facts.evidence.filter((e) => e.category === value && !e.voided_at);
      return live.length === 0 ? null : '书证';
    }
    case 'basics': {
      if (!(BASICS_FIELDS as readonly string[]).includes(value)) return undefined;
      const v = facts.case[value as BasicsField];
      // 首诊四项是用户自己报的，填了就是自述档；没填就是〔未记录〕。
      return basicsFilled(v) ? '自述' : null;
    }
  }
}

/**
 * 一个槽的**原始取值**（只给 `slotChecks` 用）。
 *
 * @returns `undefined` = 这个槽没有"取值"这回事（不是 `basics:`，或列名不认识）——
 *   这是配置错误，与"用户还没填"要分开报；`null` = 认识这一格，但它还空着；否则是那串原字。
 */
function rawBasicsValue(slot: string, facts: ElementFactsView): string | null | undefined {
  const at = slot.indexOf(':');
  if (at <= 0 || slot.slice(0, at) !== 'basics') return undefined;
  const field = slot.slice(at + 1).trim();
  if (!(BASICS_FIELDS as readonly string[]).includes(field)) return undefined;
  const v = facts.case[field as BasicsField];
  return basicsFilled(v) ? String(v) : null;
}

/** 卡片的 basis 全部核实过了吗。空 basis 一律算没核实（"没有锚点"不比"锚点存疑"更可信）。 */
export function basisVerified(basis: readonly ElementBasis[]): boolean {
  return basis.length > 0 && basis.every((b) => b.verified && b.anchor.trim() !== '');
}

/**
 * 要件表推导。**纯函数**：同一份档案 + 同一批卡片恒得同一张表，不看时间、不看模型、不查库。
 *
 * @param facts 档案的结构化子集（CaseSnapshot 直接传得进来）
 * @param cards 本领域的要件卡。**空数组 = 本领域还没有要件卡**，
 *   回 `rendered:false`，调用方据此整节不渲染。
 * @param only 只画这几项诉求的要件（省略 = 全画）。过滤后一行不剩时同样 `rendered:false`。
 */
export function buildElementSheet(
  facts: ElementFactsView,
  cards: readonly ElementCard[],
  only?: readonly string[],
): ElementSheet {
  // 【为什么按诉求过滤，而不是恒画全表】要件表是"我这几项诉求各差什么"，
  // 不是"这个行当一共有多少种要件"。不过滤的形态是：一个只主张欠薪的人读到一整屏
  // 违法解除的要件全标着「缺失」——他要么以为自己什么都不成立，要么去补一堆无关材料。
  // `only` 省略 = 不过滤（评测夹具与依据清单要的是全表）；给空数组 = 一项诉求都没有 ⇒ 整节不渲染。
  const picked = only === undefined ? cards : cards.filter((c) => only.includes(c.claimKind));
  if (picked.length === 0) return { rows: [], rendered: false };

  const rows = picked.map((card): ElementRow => {
    const unresolved: string[] = [];
    const missing: string[] = [];
    const selfReported: string[] = [];
    let weakest: SourceTier | null = null;

    for (const slot of card.satisfiedBy) {
      const tier = resolveSlot(slot, facts);
      if (tier === undefined) {
        // 不认识的槽**不当作缺失静默处理**：它是配置错误，与"用户还没上传"是两回事。
        // 两处都点名（unresolvedSlots 说是什么、missingSlots 说它挡住了哪一格）。
        unresolved.push(slot);
        missing.push(slot);
        continue;
      }
      // 【取值判定优先于"填没填"】卡片给了 slotChecks 的槽，填了字不等于这件事成立
      //（见 SlotValueCheck）。看不过就按〔未记录〕算，并以卡片给的名字点名——
      // 沿用槽串点名的形态是：用户读到「还差 basics:contract_count」，
      // 而他刚刚填过那一格，于是这行字读起来像系统没收到他的话。
      const check = card.slotChecks?.[slot];
      if (check) {
        const raw = rawBasicsValue(slot, facts);
        if (raw === undefined) {
          // 判定挂在一个没有"取值"的槽上 = 配置错误，与上面那一格同一条纪律：点名，不静默。
          unresolved.push(slot);
          missing.push(slot);
          continue;
        }
        if (raw === null || !check.accepts(raw)) {
          missing.push(check.missingAs);
          continue;
        }
      }
      if (tier === null) {
        missing.push(slot);
        continue;
      }
      if (!isDocumented(tier)) selfReported.push(slot);
      if (weakest === null || tierRank(tier) < tierRank(weakest)) weakest = tier;
    }

    // 反证优先于正面推导：拿得出书证以上的反证时，这个要件不是"还差点"，是不成立。
    const negated = (card.negatedBy ?? []).some((slot) => {
      const tier = resolveSlot(slot, facts);
      return tier != null && isDocumented(tier);
    });

    const status: ElementStatus = negated
      ? '不成立'
      : missing.length > 0
        ? '缺失'
        : card.satisfiedBy.length === 0 || weakest === null || !isDocumented(weakest)
          ? '成立·待证'
          : '成立';

    // 条号未核实 ⇒ 强制待核实。卡片自报什么都不算（设计稿 §1.3「举证责任讲反」）。
    const verified = basisVerified(card.basis);
    return {
      id: card.id,
      claimKind: card.claimKind,
      name: card.name,
      status,
      burden: verified ? card.burden : 'unverified',
      burdenForced: !verified && card.burden !== 'unverified',
      missingSlots: missing,
      selfReportedSlots: selfReported,
      unresolvedSlots: unresolved,
      typicalEvidence: card.typicalEvidence,
      basis: card.basis,
    };
  });

  return { rows, rendered: true };
}
