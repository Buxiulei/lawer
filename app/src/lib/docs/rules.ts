// app/src/lib/docs/rules.ts
// 来文解读的审查规则库入口：doc_kind → 规则包 → 逐条规则。
//
// 【为什么规则不写在这里】七个规则包（劳动合同 / 竞业限制 / 保密协议 / 规章确认书 /
// 协商解除协议 / offer 入职文件 / 培训服务期）已经在 knowledge/packs/review-rules/ 里，
// 每条带 id / severity / pattern_hint / basis / suggestion / negotiation_tip。
// 在代码里再抄一份的形态是：规则库更新了，解读用的还是抄那天的版本，而两边都不报错。
//
// 【severity 的真源在规则库，不在模型】命中某条规则的坑有多大，是规则库定的常量；
// 模型只负责回答「这份文件里有没有踩到这条」。让模型自己报 severity 的形态是：
// 同一条「试用期超上限」，这次被判 must、下次被判 suggest，用户据此决定签不签。
import * as knowledge from '@/lib/knowledge';

/** 来文的种类。与 company_docs.doc_type 落库值同一份取值。 */
export const DOC_KINDS = ['解除通知', '协议', '调岗通知', '其他'] as const;
export type DocKind = (typeof DOC_KINDS)[number];

/**
 * 每种来文该拿哪几个规则包去比对。
 *
 * 【为什么「其他」是全量而不是空集】拿不准种类时喂全部规则，宁可多比对几条也不漏掉
 * 大坑；空集的形态是——用户把一份竞业协议报成「其他」，解读结果一条规则都没命中，
 * 页面上干干净净，看起来像是这份文件没问题。
 */
const PACKS_BY_KIND: Record<DocKind, readonly string[]> = {
  解除通知: ['review-xieshang-jiechu-xieyi', 'review-laodong-hetong'],
  协议: [
    'review-xieshang-jiechu-xieyi',
    'review-laodong-hetong',
    'review-jingye-xianzhi',
    'review-baomi-xieyi',
    'review-peixun-fuwuqi',
  ],
  调岗通知: ['review-laodong-hetong', 'review-guizhang-querenshu'],
  其他: [
    'review-laodong-hetong',
    'review-xieshang-jiechu-xieyi',
    'review-jingye-xianzhi',
    'review-baomi-xieyi',
    'review-guizhang-querenshu',
    'review-offer-ruzhi-wenjian',
    'review-peixun-fuwuqi',
  ],
};

/** 规则库里的一条规则（字段与 knowledge 卡的 facts.review_rules 同名同义）。 */
export interface ReviewRule {
  id: string;
  severity: 'must' | 'strong' | 'suggest';
  title: string;
  pattern_hint: string;
  basis: string;
  suggestion: string;
  negotiation_tip?: string;
  /** 这条规则出自哪张卡，落库时随 basis 一起留痕，方便回查原文 */
  packId: string;
}

export function isDocKind(value: unknown): value is DocKind {
  return typeof value === 'string' && (DOC_KINDS as readonly string[]).includes(value);
}

/**
 * 取某种来文的候选规则集。
 *
 * 规则包取不到会**抛错**（knowledge.get 的行为），本函数不吞：
 * 吞掉的形态是「这次解读一条规则都没命中」，与「这份文件确实干净」在结果里长得一样。
 * 调用方须在扣费之前先调它，让缺规则库这类故障发生在钱动之前。
 */
export function rulesFor(kind: DocKind): ReviewRule[] {
  const out: ReviewRule[] = [];
  for (const packId of PACKS_BY_KIND[kind]) {
    const pack = knowledge.get(packId);
    for (const rule of pack.facts?.review_rules ?? []) {
      out.push({ ...rule, packId });
    }
  }
  return out;
}
