// app/src/lib/referral/neutral.ts
// 转介数据包的**中立化过滤**（设计稿 §14 决定 4）：情绪状态摘要里
// 不得出现对方公司名，也不得出现案情细节。
//
// 【为什么不能只靠 prompt 里那句「不要写公司名」】那是一句请求，不是一道闸。
// 模型照做九次、第十次把公司全称原样抄进去——而那一次的产物会被发到站外另一家机构，
// 从此不在我们手里。所以摘要生成完之后再机器过一遍：**prompt 负责让它一般不写，
// 本文件负责让它写了也出不去**。
//
// 【过滤而不是拒收】命中就把那几个字换成「（略）」，不把整份摘要丢掉。
// 丢掉的形态是：接收方拿到一份空摘要，看起来像这个人没什么情绪问题。
//
// 【本文件不是共用层】词表天然带着本站服务的那类纠纷的措辞。它不在
// lib/capabilities / lib/jobs / lib/cases/report* 之列，故允许出现领域字面量。
/** 命中后替换成的占位。用中文全角括号，读的人一眼知道这里被我们挡掉了一段。 */
export const REDACTED = '（略）';

/**
 * 案情词表：出现其一即认为摘要越过了「只谈情绪状态」的边界。
 *
 * 【收词的口径】收的是**只可能出自案情**的词。像「压力」「睡不着」「难受」这类
 * 描述状态的词一律不收——它们正是这份摘要该说的东西，收进来等于把摘要清空。
 *
 * 【为什么连「加班」「工资」这种也收】接收方是心理咨询机构，他们要的是这个人的状态，
 * 不是这个人的案子。一句「因为公司拖欠三个月工资而焦虑」既没必要，也让对方多知道了
 * 一件与咨询无关、却足以指认具体事件的事。
 */
export const NEUTRAL_FORBIDDEN_TERMS: readonly string[] = [
  // 纠纷与程序
  '劳动仲裁',
  '仲裁',
  '劳动争议',
  '诉讼',
  '起诉',
  '开庭',
  '立案',
  '裁决',
  '判决',
  '答辩',
  '举证',
  '证据',
  '律师',
  '被申请人',
  '申请人',
  '劳动合同',
  '劳动关系',
  // 事件与金额
  '裁员',
  '辞退',
  '解雇',
  '开除',
  '离职',
  '解除',
  '赔偿',
  '补偿金',
  '工资',
  '薪资',
  '年终奖',
  '加班',
  '社保',
  '公积金',
  '竞业',
  '试用期',
  'N+1',
  '2N',
  // 组织称谓（公司名本身另由 companyTerms 动态加）
  '公司',
  '单位',
  '雇主',
  'HR',
  '人事',
  '领导',
  '老板',
];

/** 公司名里这些后缀去掉之后剩下的字号，才是摘要里最可能出现的那几个字。 */
const COMPANY_SUFFIXES = [
  '股份有限公司',
  '有限责任公司',
  '有限公司',
  '集团公司',
  '分公司',
  '子公司',
  '集团',
  '公司',
  '科技',
  '网络',
  '信息',
  '技术',
  '服务',
];

/**
 * 把一个公司全称拆成要拦的若干串：全称本身 + 去掉常见后缀之后的字号。
 *
 * 【为什么必须拦字号】摘要里几乎不会出现「蓝海科技有限公司」这种全称，出现的是「蓝海」。
 * 只拦全称的形态是：过滤器每次都报「没有命中」，而公司仍然被点名了。
 *
 * 一个字的字号不拦（「京」「华」这类单字会把正常句子打成马赛克）。
 */
export function companyTerms(names: readonly string[]): string[] {
  const out = new Set<string>();
  for (const raw of names) {
    const name = raw.trim();
    if (name.length < 2) continue;
    out.add(name);
    let core = name;
    // 反复剥后缀：「蓝海科技有限公司」→「蓝海科技」→「蓝海」
    for (;;) {
      const hit = COMPANY_SUFFIXES.find((s) => core.length > s.length && core.endsWith(s));
      if (!hit) break;
      core = core.slice(0, -hit.length);
    }
    if (core.length >= 2) out.add(core);
  }
  return [...out];
}

export interface NeutralResult {
  /** 过滤后的正文 */
  text: string;
  /** 被挡下来的词，去重后按出现顺序。空数组 = 这份摘要本来就是干净的 */
  redacted: string[];
}

/** 长词优先，避免「劳动合同」先被「劳动仲裁」之外的短词切碎后漏网。 */
function byLengthDesc(terms: readonly string[]): string[] {
  return [...new Set(terms.filter((t) => t.length > 0))].sort((a, b) => b.length - a.length);
}

/**
 * 找出文本里命中的禁用词（不改文本）。判据与断言都用它，**不要另写一份 includes**。
 */
export function findForbidden(text: string, extraTerms: readonly string[] = []): string[] {
  const hay = text.toUpperCase();
  return byLengthDesc([...NEUTRAL_FORBIDDEN_TERMS, ...extraTerms]).filter((t) =>
    hay.includes(t.toUpperCase()),
  );
}

/**
 * 中立化一段摘要：命中的词换成「（略）」，并压掉连成一片的占位。
 *
 * 大小写不敏感（`n+1` 与 `N+1` 是同一件事），按原文长度从长到短依次替换。
 */
export function sanitizeNeutral(text: string, extraTerms: readonly string[] = []): NeutralResult {
  const redacted: string[] = [];
  let out = text;
  for (const term of byLengthDesc([...NEUTRAL_FORBIDDEN_TERMS, ...extraTerms])) {
    // 转义正则元字符：词表里有 `N+1` 这种带 + 的
    const re = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    if (!re.test(out)) continue;
    redacted.push(term);
    out = out.replace(re, REDACTED);
  }
  // 「（略）（略）」读起来像出了故障，压成一个
  out = out.replace(new RegExp(`(?:${REDACTED}){2,}`, 'g'), REDACTED);
  return { text: out, redacted };
}

/** 摘要上限（设计稿 §14：≤200 字）。按 Unicode 码点数，不按 UTF-16 长度。 */
export const SUMMARY_MAX_CHARS = 200;

/** 截到 200 字。截断是最后一步：先过滤再截，反过来会把已经露出的公司名留在前 200 字里。 */
export function clampSummary(text: string): string {
  const chars = Array.from(text.trim());
  return chars.length <= SUMMARY_MAX_CHARS ? chars.join('') : chars.slice(0, SUMMARY_MAX_CHARS).join('');
}
