// app/src/lib/agent/value-guard.ts
// 数值运行时闸门（⑨，设计稿 §4.3 / §1.3「编造数字」）。
//
// 【它挡的是哪一类事故】charter §3 要求"一切金额走 claim_calc"，而实测里模型会顺手
// 在正文里写「封顶大概 60 万」「你这种情况一般按 3N 谈」。这些数**结构上完全合格**：
// 有单位、在句子里读得通、周围还常常有条号。用户拿着「60 万」去跟 HR 谈，
// 谈崩了才知道那个数是模型顺口说的——而我们的算钱器从头到尾没被调用过。
//
// 【判据】(设计稿 §1.2「数值有来源」，目标 100%)
//   带单位的金额/倍数/百分比 ∈ 本轮 claim_calc 出参 ∪ 本轮 retrieved 的 facts.values
//     ∪ 本轮 retrieved 的 statute_quotes 原文里写着的数（法定倍数/比例）
//     ∪ 档案里的结构化事实 ∪ 用户自己说过的话
// 前三份是**结构化事实**，后两份是**用户自己的事实**——模型复述它们不是编造，
// 判它们无来源就是系统在质疑用户对自己的事的陈述（见 ValueSources 的注释）。
//
// ── 捕获面：一条明说的缺口（不是遗漏）──
// 捕：`12345 元` `3.5 万元` `1.5 倍` `30%` `百分之三十` `2N` `3N` `N+1`
// **不捕裸 `N`**：在这个行当里 `N` 是"经济补偿"的通称（「先把 N 算清楚」），
// 不是一个数值断言；而单字符 `N` 在中英混排的正文里到处都是。
// 捕它的误伤面远大于收益，会直接顶穿 2% 的替换率预算——**闸误伤比漏一条更贵**，
// 因为误伤会让人去改一个本来正确的输出。带系数的形态（`2N`/`3N`/`N+1`）才是断言，
// 设计稿点名的负样本「按 3N」正是这一类。
//
// ── 免检面 ──
//   · 引号内与 markdown 引用块内的文本：那是**逐字原文**，里面的数字是立法者写的
//     （「不超过……三倍」「二倍工资」）。判它无来源等于要求法条自己带来源。
//   · ⑧ 核心位保底渲染补进来的原文段：它以 `「…」` 形态插入，天然落在上一条里。
//     这是 ⑧→⑨ 那条交互用例钉住的不变量——**⑧ 补一条原文，⑨ 不许因此多开一次火**。
//     **必须跨行**：真库 318 条 statute_quotes 有 164 条是多行的，按行算免检的形态是
//     不变量只在单行原文上成立，而多行原文从第 2 行起条条开火。免检面用共用实现
//     （citation-block 的 `insideVerbatim`），不在这里另抄一份。
//
// **不做**闸标记内的免检：上游三种标记（【案号待核实】【条号待核验】【已修正，见新版】）
// 里一个数字都没有，⑨ 自己的标记又是一次性批量插入、不回读。写一层免检去挡一个不存在的
// 情况，代价是一条**恒真的测试**——它看起来是覆盖，实际什么都没验。真到 ⑩ 那天再加。
//
// ── 为什么是标记而不是剥除 ──
// 与第五闸的「改口」不同：一个数被剥掉，整句话就读不通了（「你大概能拿到 」）。
// 标记保留了数、同时告诉用户"这个数没有来源"，并给出出路（用 claim_calc 算）。
// 禁令必配出路（设计稿 §7.7）。

import { cnNumeral, insideVerbatim } from './citation-block';
import type { KnowledgePack } from './retrieval';

/** 不在任何来源里 */
export const VALUE_UNSOURCED = '【数值无来源】';
/** 与来源卡差一点点（容差内但不相等）——比"无来源"更可疑：它像是抄错了一位 */
export const VALUE_MISMATCH = '【数值与来源卡不一致】';

/**
 * 容差（设计稿 §4.3）。**只用来分类，不用来放行**：
 * 落在 ±0.5% 内却不逐字相等的数，走【数值与来源卡不一致】而不是【数值无来源】——
 * 前者是"你抄的这个数和卡里那个差一点"，后者是"这个数哪儿来的没人知道"，
 * 两句话对用户的意思完全不同，合并就等于把"抄错"说成"编造"。
 */
const TOLERANCE = 0.005;

/**
 * 数值 token 的形态。四类各一段，**分开写是为了让 unit 可判**——
 * 合成一条大正则之后就分不出"这是金额还是倍数"，而两者的来源判定不同。
 */
const MONEY = '\\d[\\d,]*(?:\\.\\d+)?\\s*(?:万元|万|元)';
const PERCENT = '\\d+(?:\\.\\d+)?\\s*%|百分之\\s*[一二三四五六七八九十百零〇0-9]{1,5}';
const TIMES = '\\d+(?:\\.\\d+)?\\s*倍';
/** 带系数的 N 记号。裸 N 不在此列（见文件头的缺口声明） */
const N_FORM = '\\d+(?:\\.\\d+)?\\s*[Nn](?:\\s*[+＋]\\s*\\d+)?|[Nn]\\s*[+＋]\\s*\\d+';

const VALUE_TOKEN = new RegExp(`${MONEY}|${PERCENT}|${TIMES}|${N_FORM}`, 'g');

/**
 * 日期形态。**只在期限语境里捕**（设计稿：「模型自算的日期（时效到期日）只认 deadline_list 出参」）。
 *
 * 【为什么必须限语境】正文里的日期绝大多数是**用户自己说的事实**（入职、解除、收到通知），
 * 它们的来源是档案时间线，不是期限推算。不限语境地判，会把用户自己讲的日期
 * 标成【数值无来源】——那是系统在质疑用户对自己的事的陈述，比不判还糟。
 */
const DATE_TOKEN = /\d{4}\s*[-年/]\s*\d{1,2}\s*[-月/]\s*\d{1,2}\s*日?/g;
/** 期限语境线索，出现在日期**之前** 24 字内才算这是一个期限断言 */
const DEADLINE_CUE = /(到期|届满|截止|最后一天|最迟|时效[^。！？\n]{0,6}(?:到|止|截))/;
const DEADLINE_CUE_WINDOW = 24;

export type ValueKind = '金额' | '百分比' | '倍数' | '倍数记号' | '日期';
export type ValueMark = 'unsourced' | 'mismatch';

export interface ValueViolation {
  /** 模型写出来的原串 */
  token: string;
  kind: ValueKind;
  mark: ValueMark;
  /** mismatch 时：卡里那个最接近的数 */
  nearest?: string;
}

/**
 * ⑨ 的放行原料。**没有一份靠解析模型自己的正文得来**——那样闸就是拿被审的东西当依据。
 *
 * 【为什么是五份而不是设计稿字面的两份（2026-09-08 修）】设计稿写的判据是
 *「∈ claim_calc 出参 ∪ retrieved 的 facts.values」。照字面实现跑出来的形态是：
 * 用户说「我月薪 2 万、公司裁了 3 万人里的 1%」，模型把这几个数**复述**回去，
 * 三处全被标【数值无来源】——而 value-guard 自己在日期那一段写着要避免的正是这件事：
 * **系统去质疑用户对自己的事的陈述**。同理，「未签合同可主张 2 倍工资」里的 2 倍
 * 是法条原文里的数，不是模型编的。
 *
 * 漏这两类的代价不是"多标几处"：它们是每一轮几乎必现的数字类别，
 * 2% 的替换率预算会被顶穿，而超预算的处置是"按闸误伤查闸"——
 * 于是闸每天都在给自己制造一次复查。
 */
export interface ValueSources {
  /**
   * 本轮 `claim_calc` 的出参（`persistCalc` 的 payload）。**没算过就是空数组**——
   * 空 ≠ 放行，空就是"本轮没有任何算出来的数"，正文里的金额一律无来源。
   */
  calcPayloads: unknown[];
  /** 本轮检索到的卡（读 `facts.values` 与 `facts.statute_quotes` 的逐字原文） */
  retrieved: Pick<KnowledgePack, 'facts'>[];
  /** 本案生效中的期限（`deadlines.due_at`）。日期类只认它 */
  deadlines: { due_at: string }[];
  /**
   * 档案里的结构化数值（如月工资，**已折成正文单位**）。
   * 它们是用户自己填进档案的事实，模型复述它不是编造。
   */
  caseFacts?: number[];
  /**
   * 用户自己说过的话（本轮原话 + 本 thread 的历史用户消息）。
   * **取材面与杠杆闸的 `userTurns` 是同一份**：复述用户原话在那边不算杠杆，
   * 在这边同样不算无来源——两道闸对"用户自己说的"给出相反判断是产品自相矛盾。
   */
  userTurns?: string[];
}

/** 归一：抹掉千分位与空白，好让「47,103.25」与「47103.25」是同一个数 */
function normNumber(s: string): string {
  return s.replace(/[,\s　]/g, '');
}

/** 从任意 JSON 值里把所有数字串抠出来（calc 出参的形状随算法而异，不逐字段列） */
function numbersIn(value: unknown, out: Set<string>): void {
  if (value === null || value === undefined) return;
  if (typeof value === 'number') {
    out.add(String(value));
    // 分→元：出参里金额恒以「分」存，而正文里说的是「元」。两个都收，
    // 否则算对了的金额在正文里照样被标无来源（**闸误伤模型算对的那一次**）
    out.add(String(value / 100));
    out.add((value / 100).toFixed(2));
    return;
  }
  if (typeof value === 'string') {
    for (const m of value.match(/\d[\d,]*(?:\.\d+)?/g) ?? []) out.add(normNumber(m));
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) numbersIn(v, out);
    return;
  }
  if (typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) numbersIn(v, out);
  }
}

/** 把 `12.30` 与 `12.3` 视作同一个数（尾零不是差异） */
function canonical(n: number): string {
  return String(n);
}

/**
 * 汉字写法的数值 token。**只用来读来源语料，不进捕获面**——
 * 法条原文写「二倍」「百分之四十五」，用户说「我们全公司三万人」，
 * 而模型转手写成「2 倍」「45%」「3 万」。不认汉字写法的形态是：
 * **模型逐字抄对了，闸把它标成无来源**，因为两边用的是两套数字体系。
 * 捕获面（`VALUE_TOKEN`）不动：那边多捕一种形态就是多一类误伤，两件事的方向相反。
 */
const CN_DIGITS = '[一二三四五六七八九十百零〇两]';
const CORPUS_CN_TOKEN = new RegExp(`${CN_DIGITS}{1,8}\\s*(?:万元|万|元)|${CN_DIGITS}{1,6}\\s*倍`, 'g');

/**
 * 一个数值 token 的**归一身份**：`类别:数`（金额一律折到「元」）。
 * 取不到数（形态不是数值）返回 null。
 *
 * 【为什么要带类别】`3 元` 与 `3 倍` 与 `3%` 是三件事。只比数字的形态是：
 * 卡里有个「3 倍」，模型写「3 元」也放行——闸变成了一张只看数字的白名单。
 */
function canonicalId(token: string): string | null {
  const kind = kindOf(token);
  const flat = token.replace(/[\s　,]/g, '');
  const cn = /^百分之(.+)$/.exec(flat);
  let n: number | null;
  if (cn) n = cnNumeral(cn[1]);
  else {
    const ar = /\d+(?:\.\d+)?/.exec(flat);
    n = ar ? Number(ar[0]) : cnNumeral(flat.replace(/(万元|万|元|倍|%)/g, ''));
  }
  if (n === null || !Number.isFinite(n)) return null;
  if (kind === '金额') return `金额:${canonical(/万/.test(flat) ? n * 10000 : n)}`;
  if (kind === '百分比') return `百分比:${canonical(n)}`;
  if (kind === '倍数') return `倍数:${canonical(n)}`;
  return null;
}

/** 从一段来源语料里收全部数值 token 的归一身份（阿拉伯与汉字两套写法都收） */
function idsInCorpus(text: string, out: Set<string>): void {
  for (const m of text.matchAll(VALUE_TOKEN)) {
    const id = canonicalId(m[0]);
    if (id) out.add(id);
  }
  for (const m of text.matchAll(CORPUS_CN_TOKEN)) {
    const id = canonicalId(m[0]);
    if (id) out.add(id);
  }
}

interface Allowed {
  /** 逐字放行的数字串（归一后） */
  exact: Set<string>;
  /** 归一身份放行集（`类别:数`）：来自法条原文与用户自述这两份**语料型**来源 */
  ids: Set<string>;
  /** 卡里的数值，用来算容差与约写判定 */
  cardValues: number[];
  /** 本轮算过钱没有。倍数记号（2N/3N）只认这个 */
  calcRan: boolean;
  /** 期限日期（归一成 `YYYY-M-D`） */
  dueDates: Set<string>;
}

function normDate(y: string, m: string, d: string): string {
  return `${Number(y)}-${Number(m)}-${Number(d)}`;
}

function collect(sources: ValueSources): Allowed {
  const exact = new Set<string>();
  for (const p of sources.calcPayloads) numbersIn(p, exact);
  const cardValues: number[] = [];
  const ids = new Set<string>();
  for (const p of sources.retrieved) {
    for (const v of p.facts?.values ?? []) {
      if (typeof v?.value !== 'number') continue;
      cardValues.push(v.value);
      exact.add(canonical(v.value));
      exact.add(v.value.toFixed(2));
      // 卡里存「47103.25 元」，正文常写「4.71 万元」——万元换算同收，理由同分/元
      exact.add(canonical(v.value / 10000));
    }
    // 【本轮取到的法条原文里写着的数】法定倍数/比例（「二倍」「百分之四十五」）的来源
    // 就是条文本身。不收它的形态是：模型引对了条、也抄对了数，闸照样标【数值无来源】，
    // 而给出的出路是「用 claim_calc 算」——算钱器算不出一个法定倍数。
    for (const q of p.facts?.statute_quotes ?? []) if (q?.text) idsInCorpus(q.text, ids);
  }
  // 档案里的结构化事实（工资等）。**这是用户自己填的**，复述它不是编造。
  for (const n of sources.caseFacts ?? []) {
    if (!Number.isFinite(n)) continue;
    cardValues.push(n);
    exact.add(canonical(n));
    exact.add(n.toFixed(2));
    ids.add(`金额:${canonical(n)}`);
  }
  // 用户自己说过的话。取材面与杠杆闸的 userTurns 同源。
  for (const t of sources.userTurns ?? []) if (t) idsInCorpus(t, ids);
  const dueDates = new Set<string>();
  for (const d of sources.deadlines) {
    const m = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(d.due_at ?? '');
    if (m) dueDates.add(normDate(m[1], m[2], m[3]));
  }
  return { exact, ids, cardValues, calcRan: sources.calcPayloads.length > 0, dueDates };
}

/**
 * 这个 token 是不是卡里那个数的**约写**（按它自己写的位数四舍五入后逐字相等）。
 *
 * 【为什么约写必须放行】封顶数在真语料里几乎总以万元约写出现：卡里 47103.25，
 * 正文写「约 4.71 万元」「4.7 万」。按容差判，它们落在 ±0.5% 内却不相等 →
 * 【数值与来源卡不一致】。那句标记对读者说的是"你抄错了"，而他抄对了、只是四舍五入。
 * **每提一次封顶就开一次火**，这是把正确写法判成错误。
 *
 * 判据是位数而不是"差得少"：`47100 元`（写到个位却不等于 47103）仍然是不一致——
 * 它声称的精度就是个位，那一位是错的。约写声称的精度是它写出来的那几位。
 */
function isRoundedForm(token: string, n: number, values: readonly number[]): boolean {
  const dec = /\.(\d+)/.exec(token.replace(/[\s　,]/g, ''))?.[1].length ?? 0;
  const scale = /万/.test(token) ? 10000 : 1;
  return values.some((v) => Number((v / scale).toFixed(dec)) === n);
}

/**
 * 这处 token 在不在免检区（引号内 / markdown 引用块行）。
 *
 * 【为什么直接用 ⑥⑦⑧ 那个函数，不再在这里写第二份（2026-09-08 修）】
 * 原先这里手抄了一份"按行数引号奇偶"的同款实现。抄出来的那份漏掉了**跨行**：
 * ⑧ 是把卡内原文以 `「…」` 内联插进正文的，而真库 318 条 statute_quotes 里 164 条是多行的。
 * 于是「⑧ 补进来的原文段 ⑨ 免检」这条不变量**只在单行原文上成立**，
 * 多行原文从第 2 行起，条文里立法者写的每一个数字都会被标【数值无来源】。
 * 免检面是三道闸共用的判断，它只能有一份实现。
 */
function exempt(text: string, at: number): boolean {
  return insideVerbatim(text, at);
}

function kindOf(token: string): ValueKind {
  if (/[Nn]/.test(token)) return '倍数记号';
  if (/倍/.test(token)) return '倍数';
  if (/%|百分之/.test(token)) return '百分比';
  return '金额';
}

/** token 里的那个数（取不到返回 null，如「百分之三十」这种汉字写法） */
function numberOf(token: string): number | null {
  const m = /\d[\d,]*(?:\.\d+)?/.exec(token);
  if (!m) return null;
  const n = Number(normNumber(m[0]));
  return Number.isFinite(n) ? n : null;
}

/**
 * ⑨ ValueGuard。返回标注后的正文 + 逐条留痕。
 *
 * 【为什么是纯函数而不是像 ⑤⑥ 那样的流上类】它排在 ⑧ 之后，而 ⑧ 是**整段改写**
 * （要在正文里找核心位、倒序插入原文）。⑨ 想在流上跑就得抢在 ⑧ 前面，
 * 那样它会判到一段 ⑧ 还没补原文的正文——顺序表把它定在 ⑨，就是定它吃 ⑧ 的产物。
 */
export function applyValueGuard(
  text: string,
  sources: ValueSources,
): { text: string; violations: ValueViolation[]; seen: number } {
  const allow = collect(sources);
  const violations: ValueViolation[] = [];
  let seen = 0;
  /** 倒序插入，免得前面的标记把后面的偏移顶掉 */
  const inserts: { at: number; mark: string }[] = [];

  for (const m of text.matchAll(VALUE_TOKEN)) {
    const at = m.index ?? 0;
    if (exempt(text, at)) continue;
    seen += 1;
    const token = m[0];
    const kind = kindOf(token);
    // 倍数记号（2N/3N/N+1）只认「本轮算过钱」：它断言的是一个**算法结论**，
    // 而这个结论只有 claim_calc 出得来。没算过就是模型自己按经验说的。
    if (kind === '倍数记号') {
      if (allow.calcRan) continue;
      violations.push({ token, kind, mark: 'unsourced' });
      inserts.push({ at: at + token.length, mark: VALUE_UNSOURCED });
      continue;
    }
    const raw = normNumber(token.replace(/[^\d.,]/g, ''));
    if (raw && allow.exact.has(raw)) continue;
    // 归一身份放行：法条原文与用户自述这两份语料型来源，跨数字体系、跨单位写法比对
    const id = canonicalId(token);
    if (id && allow.ids.has(id)) continue;
    const n = numberOf(token);
    if (n === null) {
      // 汉字数字（「百分之三十」）：来源语料里也没有这个写法 → 按无来源处理。
      // **宁可标记也不放行**——闸漏拦是把编造的数交到用户手上（citation-guard 同一条纪律）
      violations.push({ token, kind, mark: 'unsourced' });
      inserts.push({ at: at + token.length, mark: VALUE_UNSOURCED });
      continue;
    }
    // 万元/万：正文的单位换算回卡的口径再比一次
    const scaled = /万/.test(token) ? n * 10000 : n;
    if (allow.exact.has(canonical(scaled)) || allow.exact.has(scaled.toFixed(2))) continue;
    // 约写（「约 4.71 万元」之于 47103.25）：按它自己写的位数四舍五入后相等即放行
    if (isRoundedForm(token, n, allow.cardValues)) continue;
    const near = allow.cardValues.find(
      (v) => v !== 0 && (Math.abs(v - n) / Math.abs(v) <= TOLERANCE || Math.abs(v - scaled) / Math.abs(v) <= TOLERANCE),
    );
    if (near !== undefined) {
      violations.push({ token, kind, mark: 'mismatch', nearest: canonical(near) });
      inserts.push({ at: at + token.length, mark: VALUE_MISMATCH });
      continue;
    }
    violations.push({ token, kind, mark: 'unsourced' });
    inserts.push({ at: at + token.length, mark: VALUE_UNSOURCED });
  }

  // 日期：只判期限语境里的那些
  for (const m of text.matchAll(DATE_TOKEN)) {
    const at = m.index ?? 0;
    if (exempt(text, at)) continue;
    const before = text.slice(Math.max(0, at - DEADLINE_CUE_WINDOW), at);
    const after = text.slice(at + m[0].length, at + m[0].length + DEADLINE_CUE_WINDOW);
    if (!DEADLINE_CUE.test(before) && !DEADLINE_CUE.test(after)) continue;
    seen += 1;
    const parts = /(\d{4})\s*[-年/]\s*(\d{1,2})\s*[-月/]\s*(\d{1,2})/.exec(m[0]);
    if (parts && allow.dueDates.has(normDate(parts[1], parts[2], parts[3]))) continue;
    violations.push({ token: m[0], kind: '日期', mark: 'unsourced' });
    inserts.push({ at: at + m[0].length, mark: VALUE_UNSOURCED });
  }

  let out = text;
  for (const ins of inserts.sort((a, b) => b.at - a.at)) {
    out = `${out.slice(0, ins.at)}${ins.mark}${out.slice(ins.at)}`;
  }
  return { text: out, violations, seen };
}

/**
 * 用户侧 notice 文案。**每一条标记都带出路**（设计稿 §7.7）：
 * 只说"这个数没来源"而不说他能做什么，等于把问题丢回给一个本来就不懂的人。
 */
export function valueNoticeMessage(violations: readonly ValueViolation[]): string {
  const unsourced = [...new Set(violations.filter((v) => v.mark === 'unsourced').map((v) => v.token))];
  const mismatch = violations.filter((v) => v.mark === 'mismatch');
  const lines: string[] = [];
  if (unsourced.length) {
    lines.push(
      `本轮有 ${unsourced.length} 处数字既不是这一轮算出来的、也不在来源卡里：${unsourced.join('、')}，已标注${VALUE_UNSOURCED}。` +
        '出路：回我一句「帮我算一下」，我用 claim_calc 按你档案里的入职日期与工资重算一遍，' +
        '算式、每一项输入的来源、依据条文会一起给你——那个数才是能拿去谈的数。',
    );
  }
  if (mismatch.length) {
    lines.push(
      `本轮有 ${mismatch.length} 处数字与来源卡差了一点：` +
        mismatch.map((v) => `${v.token}（卡里是 ${v.nearest}）`).join('、') +
        `，已标注${VALUE_MISMATCH}。出路：以来源卡的数为准，点开回复里的来源卡可以看到它的生效期间。`,
    );
  }
  return lines.join('\n');
}
