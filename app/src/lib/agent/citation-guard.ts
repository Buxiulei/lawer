// app/src/lib/agent/citation-guard.ts
// 案号运行时闸门（manager 2026-08-19 裁断，最高优先级）。
//
// 【为什么必须是运行时而不是事后评测】
// C04 全量跑实测：S15 输出了「（2023）京0105民初88888号」——知识库里查无此号。
// 而同一剧本此前连过两次。也就是说**零编造这条红线是概率性的**，不是「过了就守住了」。
// 提示词里写十遍「不许编造」也只是降低概率；真正守得住的只有确定性代码。
// 与危机层同范式：能机械判定的红线，一律在代码里挡，不赌模型。
//
// 【为什么在流上挡，而不是事后拒绝】
// 正文是流式下发的。等整轮跑完再发现编了案号，用户早就看见了——「事后撤回」救不回
// 已经被读进去的一个假案号，而这个用户明天就要拿它去跟 HR 谈判。
// 所以用与 PII 占位符还原同一套技术：**在流上缓冲可能成形的案号，验证通过才放行**，
// 验不过的原地替换成【案号待核实】。用户永远看不到一个查无此号的案号。
//
// 【判据】本轮 knowledge_search 实际返回的 pack 正文里出现过的案号才算真。
// 不是「看起来像真的」，是「检索原文里逐字有」——与评测侧 G1 同一条判据。

/**
 * 案号形态：（2023）京03民终15407号 / (2023)京0105民初6093号。
 *
 * 【必须带案件类型字才算案号】括号年份后面要出现 民初/民终/执/劳人仲 这类**案件类型字**。
 * 不这么限的话会误伤**文号**——「京高法发〔2024〕534号」结构上也是「括号+年份+数字+号」，
 * 而它恰恰是本知识库被引用最多的那份文件（534 号解答）。把它换成【案号待核实】，
 * 等于把最该引用的依据毁掉，比放过一个假案号还糟。
 */
const CASE_TYPE = '(?:民初|民终|民申|民再|民特|民辖|刑初|刑终|行初|行终|执行|执异|执|赔|劳人仲|仲字|仲案)';
const CASE_NO_SOURCE = `[（(〔]\\s*\\d{4}\\s*[）)〕][一-龥A-Za-z0-9]{0,10}${CASE_TYPE}[一-龥A-Za-z0-9]{0,14}号`;
const CASE_NO_RE = new RegExp(CASE_NO_SOURCE, 'g');
/** 可能正在成形的案号前缀：左括号 + 最多 4 位数字（还没闭合） */
const PARTIAL_HEAD_RE = /[（(〔]\s*\d{0,4}\s*$|[（(〔]\s*\d{4}\s*[）)〕][一-龥A-Za-z0-9]{0,24}$/;

/** 缓冲上限：案号最长约 25 字符，40 给足余量。超过就判定「这不是案号」，放行。 */
const MAX_PENDING = 40;

/** 验不过的案号在正文里替换成这个。留痕而不是删掉——用户要看得见这里本来有个引用。 */
export const UNVERIFIED_CITATION = '【案号待核实】';

/**
 * 明显是占位/编造的流水号：全相同数字（88888）、连续升降序（12345 / 54321）。
 *
 * 【为什么要这条启发式】（manager 2026-08-19 补充）
 * 这类号不用查库就知道是假的——实测 S15 编的正是「（2023）京0105民初**88888**号」。
 * 它与白名单是**两道独立的闸**：白名单答的是「库里有没有」，这条答的是「这个号本身像不像编的」。
 * 即便某张卡的正文里出现过示例性质的 88888，也照拦不误——真实案号不长这样。
 */
export function isObviousPlaceholderSerial(caseNo: string): boolean {
  // 取末尾那段连续数字（流水号），案号形如 …民初88888号
  const m = /(\d{4,})号?$/.exec(normalizeCaseNo(caseNo));
  if (!m) return false;
  const digits = m[1];
  if (/^(\d)\1+$/.test(digits)) return true; // 88888 / 11111
  const asc = [...digits].every((c, i, a) => i === 0 || +c === +a[i - 1] + 1);
  const desc = [...digits].every((c, i, a) => i === 0 || +c === +a[i - 1] - 1);
  return asc || desc; // 12345 / 54321
}

/** 归一化：抹掉全半角括号与空白，只比对「年份+法院+字号+号」的实质内容 */
export function normalizeCaseNo(raw: string): string {
  return raw.replace(/[\s（）()〔〕]/g, '');
}

/** 从一段文本里抽出全部案号形态的串 */
export function extractCaseNumbers(text: string): string[] {
  return [...new Set(text.match(CASE_NO_RE) ?? [])];
}

export interface CitationViolation {
  /** 模型写出来的原串 */
  cited: string;
  /** 出现在哪里：正文 / 某份文书 */
  where: string;
}

/**
 * 案号闸门。allowed 集合随本轮检索到的 pack 增长——
 * 模型先检索再引用是正常顺序，所以放行判据必须能中途扩充。
 */
export class CitationGuard {
  /** 归一化后的真案号集合 */
  private allowed = new Set<string>();
  private pending = '';
  private readonly violations: CitationViolation[] = [];

  /** 把这些 pack 正文里出现的案号并入白名单 */
  allowFrom(packs: { id: string; body: string; title?: string }[]): void {
    for (const p of packs) {
      for (const n of extractCaseNumbers(`${p.body}\n${p.title ?? ''}`)) {
        this.allowed.add(normalizeCaseNo(n));
      }
    }
  }

  /**
   * 这个案号放不放行。两道闸都要过：
   *   ① 本轮检索原文里逐字有；
   *   ② 流水号不是 88888 / 12345 这类明显占位（即便库里出现过示例也拦）。
   */
  isSupported(caseNo: string): boolean {
    if (isObviousPlaceholderSerial(caseNo)) return false;
    return this.allowed.has(normalizeCaseNo(caseNo));
  }

  /** 本轮拦下的全部违规（供 notice 与日志；空数组＝干净） */
  get found(): readonly CitationViolation[] {
    return this.violations;
  }

  /**
   * 检查一整段文本（文书正文用）。返回查无此号的案号列表，空数组即通过。
   * 不改写内容——文书是要落库的东西，该由模型改正后重写，而不是我们替它打补丁。
   */
  check(text: string, where: string): string[] {
    const bad = extractCaseNumbers(text).filter((n) => !this.isSupported(n));
    for (const cited of bad) this.violations.push({ cited, where });
    return bad;
  }

  /**
   * 流式过滤：喂一片增量，返回可安全下发的文本。
   * 可能正在成形的案号会被扣住，等它闭合（或确定不是案号）再决定放行还是替换。
   */
  push(chunk: string): string {
    this.pending += chunk;
    // 尾部还可能长成案号 → 扣住尾巴，其余先放
    const m = PARTIAL_HEAD_RE.exec(this.pending);
    let safeEnd = this.pending.length;
    if (m && this.pending.length - m.index <= MAX_PENDING) safeEnd = m.index;

    const out = this.sanitize(this.pending.slice(0, safeEnd));
    this.pending = this.pending.slice(safeEnd);
    return out;
  }

  /** 流末冲刷：扣住的尾巴此时不可能再闭合了，按现状判定后交出 */
  flush(): string {
    const out = this.sanitize(this.pending);
    this.pending = '';
    return out;
  }

  private sanitize(text: string): string {
    return text.replace(new RegExp(CASE_NO_SOURCE, 'g'), (cited) => {
      if (this.isSupported(cited)) return cited;
      this.violations.push({ cited, where: '正文' });
      return UNVERIFIED_CITATION;
    });
  }
}

/** 回喂给模型的改正指令。说清违规的是哪个号、为什么不行、该怎么办。 */
export function citationCorrectionDirective(bad: string[]): string {
  return [
    `【案号校验未通过】你输出了知识库里不存在的案号：${bad.join('、')}。`,
    '这些号在本轮 knowledge_search 返回的原文里查无此串——按 charter §7.1，编造案号是事故级错误。',
    '请立刻改正：删掉它，或替换成检索结果里**逐字出现过**的真实案号；',
    '拿不出真案号就不要给号，改用「北京市人社局 XX 年典型案例」这类可查的名头，',
    '或直接说「这一点我需要核实」。不要用「示例」「格式仅供参考」等说法变相给出编造的号。',
  ].join('\n');
}
