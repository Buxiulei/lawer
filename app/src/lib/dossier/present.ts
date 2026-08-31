// app/src/lib/dossier/present.ts
// 档案呈现的**唯一措辞入口 + 渲染守卫**。
//
// 【为什么这些句子不散在组件里】设计 §1.2 的几条诚实红线（样本不足不出数字、
// 指标名不叫"胜诉率"、四段时长不合成一个平均值）如果各组件各写一遍，
// 就是「独立写 N 次忘 N 次」——那不是疏忽，是默认形态。
// 收成一个入口后，改口径只有一处可改，测试也只需钉这一处。
//
// 【守卫为什么在这里而不在调用方】`hasProvenance` 是渲染前的硬闸：
// 缺样本量/截止日/来源三件套任一，就不许出数字。写在组件里靠"调用方记得判"，
// 等于把红线交给下一个写页面的人去记。

import type {
  DurationSegment,
  DurationSegmentKey,
  OutcomeStats,
  StatProvenance,
} from './contract';

/* ── 渲染守卫 ─────────────────────────────────────────── */

/**
 * 三件套齐不齐。齐了才准渲染数字。
 *
 * 注意 `sampleN === 0` 是**齐的**（"这张卡样本量是 0"是一句有信息的话），
 * 只有 null 才算缺。用 `!p.sampleN` 判会把 0 也当缺失——那会让
 * "我们查了，一条都没有" 和 "我们没查" 在界面上长成同一个样子。
 */
export function hasProvenance(p: StatProvenance): boolean {
  return p.sampleN !== null && p.asOf !== null && p.source !== null;
}

/** 结果比例能不能出：三件套齐 **且** 可判定样本达到门槛。 */
export function canShowOutcomeRatio(s: OutcomeStats): boolean {
  return hasProvenance(s) && s.docsOutcomeDecided >= s.minSample;
}

/** 某一段时长能不能出：三件套齐 **且** 该段自己的 n 达到门槛。一段不足不牵连别段。 */
export function canShowSegment(seg: DurationSegment, minSample: number): boolean {
  return hasProvenance(seg) && seg.n >= minSample && seg.medianDays !== null;
}

/* ── 措辞 ─────────────────────────────────────────────── */

/**
 * 指标名。**不叫"胜诉率"**——不区分程序位置（谁是申请人）的胜诉率是错的数，
 * 而"胜诉"二字会让用户默认自己站在申请人一侧。
 */
export const OUTCOME_METRIC_LABEL = '劳动者全部或部分获支持的比例';

export const DURATION_SEGMENT_LABEL: Record<DurationSegmentKey, string> = {
  arbitration: '仲裁受理→裁决',
  firstInstance: '一审立案→判决',
  secondInstance: '二审立案→判决',
  execution: '判决生效→执行立案',
};

/**
 * 样本不足时替代比例的那句话（设计 §1.2 逐字）。
 *
 * 四个数字全给，是因为"为什么出不了这个数"本身就是用户该知道的信息：
 * 入档 60 条却只有 3 条可判定，说明的是文书公开率，不是这家公司干净。
 * 门槛数取自 `minSample`（来自 pricing_config），**不写死**。
 */
export function outcomeShortSentence(s: OutcomeStats): string {
  return (
    `样本不足：已入档 ${s.docsTotal} 条，` +
    `其中取到全文 ${s.docsFulltext} 篇、可判定结果 ${s.docsOutcomeDecided} 篇，` +
    `不足 ${s.minSample} 篇不出比例`
  );
}

/** 某一段时长样本不足时的那句话。同样带上门槛，且只说这一段。 */
export function segmentShortSentence(seg: DurationSegment, minSample: number): string {
  return `样本不足：这一段只有 ${seg.n} 篇载明日期的文书，不足 ${minSample} 篇不出中位数`;
}

/** 三件套缺项时的那句话。跟"样本不够"是两回事，不能混成同一句。 */
export function provenanceMissingSentence(p: StatProvenance): string {
  const missing = [
    p.sampleN === null ? '样本量' : null,
    p.asOf === null ? '采集截止日' : null,
    p.source === null ? '来源' : null,
  ].filter((x): x is string => x !== null);
  return `这张卡缺${missing.join('、')}，在补齐之前不出数字（没有这几项的数字无从判断可信度）`;
}

/**
 * 未覆盖的仲裁地（设计 §1.4 逐字）。
 * 首发只做北京朝阳；别处一律这一句，**不给任何风格描述**。
 */
export const VENUE_NOT_COVERED =
  '本档案暂不含该仲裁地的实操与判案风格（我们只对已逐字核实的辖区出这一块）';

/**
 * 在职年限的诚实标注。它只用于判例呈现排序，不进任何统计——
 * 不写这一句，用户会以为自己填的年限影响了公司那些数字。
 */
export const TENURE_DISCLAIMER =
  '你填的在职年限不参与上面任何公司数据的计算，只用来把工龄相近的判例排在前面。';

export const BLOCK_LABEL: Record<string, string> = {
  graph: '谱系',
  litigation: '判例采集',
  stats: '统计',
  patterns: '套路归纳',
};

export const BLOCK_STATE_LABEL: Record<string, string> = {
  queued: '排队中',
  running: '进行中',
  done: '已完成',
  failed: '未完成',
  skipped: '未做',
  expired: '超期已退款',
};
