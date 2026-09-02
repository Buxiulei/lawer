// app/src/lib/cap/sanbei.ts
// 北京经济补偿「三倍社平封顶基数」的**唯一定义**。
//
// 【为什么要收成一处】此前这个数在仓里有两个互不相干的出处：
//   ① 对话/计算侧：数据卡 data-beijing-shepin-fengding 的 facts.fengding_jishu_monthly
//      （47103.25 元/月，卡自己标着「待核实」）；
//   ② 首诊结果页：`_mock/demo.ts` 的 `BJ_CAP_YUAN = 11761 × 3 = 35283`——
//      一个写在演示素材里、给演示案件叙事用的数，却被真实用户的首诊金额表当成了法定封顶线。
// 同一个人在首诊页看到 35283、在对话里看到 47103.25，两处都不说自己是哪来的。
// 而这个数直接决定赔偿金额的上限，**它不是排版问题，是给劳动者的错误答案**。
//
// 所以：值只有一个出处（知识库那张数据卡），口径只有一份（本文件的 facts/caveat），
// 首诊结果页与对话共用它们。**本文件不写死任何金额**——写死就等于把「逐年会变的数」
// 又抄了一遍，卡更新了这里不会变。
//
// 【值待核实这件事要一路带到用户面前】卡上 confidence=待核实：数值多方一致但未取得
// 统计局原始页，且 2024 年度官方值尚未发布。引用时必须原样带上这个状态与生效期间，
// 不能因为「有数」就当它坐实了（charter §3）。核实完成后改的是**那张卡**，不是本文件。

/** 数据卡 id。值逐年更新，代码里不留兜底数字。 */
export const SANBEI_CAP_PACK_ID = 'data-beijing-shepin-fengding';

/** 封顶基数在数据卡 facts.values 里的 key */
export const SANBEI_CAP_VALUE_KEY = 'fengding_jishu_monthly';

/** 数据卡结构化事实里的一条「值」。只声明本模块要读的那一部分，多余字段不管。 */
export interface CardValue {
  key: string;
  value: number;
  unit: string;
  effective_from: string;
  confidence: string;
}

export interface CardFacts {
  values?: CardValue[];
}

export interface CardValueHit {
  /** 换算成分之后的值 */
  fen: number;
  /** 卡上原样的元值，展示用 */
  yuan: number;
  /** 原文核实 | 二手转述 | 待核实 */
  confidence: string;
  /** 生效期间起点 YYYY-MM-DD */
  effectiveFrom: string;
}

/** 三倍封顶基数一条读数：分/元/可信度/生效期间四项一起走，不许只取数字丢掉状态。 */
export interface SanbeiCap extends CardValueHit {
  capFen: number;
}

/**
 * 从数据卡的**结构化 facts** 里读一个「元/月」的钱数，换算成分。
 *
 * 【为什么换算写在这一处】卡的单位是元、calc 全程用分。两边各换一次迟早差一个百倍，
 * 而这个数最后会写进仲裁申请书。单位不是预期值时**返回 null 走兜底，绝不猜**。
 *
 * 【为什么这些数不写死在代码里】最低工资、社平封顶、生活费标准每年都会调。
 * 纯函数保持纯、数据活性归卡（manager 2026-08-20 裁决）——calc 只保留内置缺省值当兜底，
 * 当前值一律现取，卡更新了产品自动跟随，不用改代码。
 *
 * 【只读 facts，不解析正文】不再犯「让代码去猜散文」那个错（见 crisis.ts 的号码事故）。
 */
export function readCardValueFen(
  facts: CardFacts | undefined,
  key: string,
): CardValueHit | null {
  const hit = facts?.values?.find((v) => v?.key === key);
  if (!hit || typeof hit.value !== 'number' || !(hit.value > 0)) return null;
  if (hit.unit !== '元/月') return null; // 单位不是预期的就别猜，走兜底
  return {
    fen: Math.round(hit.value * 100),
    yuan: hit.value,
    confidence: hit.confidence,
    effectiveFrom: hit.effective_from,
  };
}

/** 从数据卡读当前三倍封顶基数。读不到返回 null——调用方必须处理，不许拿旧常量顶上。 */
export function readSanbeiCap(facts: CardFacts | undefined): SanbeiCap | null {
  const hit = readCardValueFen(facts, SANBEI_CAP_VALUE_KEY);
  return hit ? { capFen: hit.fen, ...hit } : null;
}

/**
 * 三项事实的统一表述：**值 + 生效期间 + 可信度**，一项都不许省。
 * 首诊结果页与对话都从这里取，两处措辞可以不同，但这三项的说法必须是同一份。
 */
export function sanbeiCapFacts(cap: SanbeiCap): string {
  return `${cap.yuan} 元/月（生效期间 ${cap.effectiveFrom}，可信度「${cap.confidence}」）`;
}

/** 可信度不是「原文核实」时必须一并说出口的那句话。 */
export const SANBEI_CAP_UNVERIFIED_CAVEAT = '该值仍待核实、以最新公布值为准';

/** 这条读数是否还带着待核实状态。 */
export function isSanbeiCapVerified(cap: SanbeiCap): boolean {
  return cap.confidence === '原文核实';
}
