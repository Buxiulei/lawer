// app/src/lib/llm/pii.ts
// 出境 PII 脱敏（PIPL 第 39 条 / spec §10「服务器若海外：跨境存储须单独同意」）。
//
// 【为什么拦在 lib/llm 出口而不是 lib/agent】
// 出境与否是**供应商属性**，不是业务属性：同一段案情文本走 DeepSeek 不出境、走 Claude 就出境。
// 把判断放在 agent 侧意味着每个新调用方都要重新记得脱敏一次，漏一处就是一次跨境传输事故。
// 放在 createProvider 这个唯一工厂里，则「谁调的、调来干什么」都不影响拦截的完整性。
//
// 【替换范围】provider ∈ {anthropic, openai} 时，**全部出站消息**：system / user / assistant /
// tool 四种角色的 content，以及 assistant 历史轮里 tool_calls 的 arguments（起草类工具的参数
// 本来就装着身份证号，漏掉它等于白拦）。deepseek / dashscope 为境内，原样发出不替换。
//
// 【映射不出站】value→占位符 的对照表只活在单次请求的闭包里，请求结束即随 GC 消失，
// 既不落库也不进日志——出境的只有占位符。
//
// 【反向还原】模型输出必然带回占位符（文书模板里就是要填身份证号），入库/展示前必须还原真值，
// 否则用户拿到的《被迫解除劳动合同通知书》上写的是〔身份证#1〕。还原发生在两处：
// 流式正文（分片可能把占位符切断，见 StreamRestorer）与工具调用 arguments（整段还原）。

import type { ChatMessage, ChatStreamResult, Provider, ProviderName, ToolCall } from './types';

/** 出境供应商：其请求要经过脱敏。境内两家（deepseek/dashscope）直连时不在此列。
 *
 *  relay（第三方中转）必须在列，两条独立理由，任一条成立就够：
 *   ① 它代理的是境外模型（Claude 走 Anthropic/AWS Bedrock 渠道、GPT 走 Azure East US——
 *      2026-08-31 实测响应头 x-ms-region / tool_call id 前缀 toolu_bdrk_ 逐条可证），
 *      中间商自称国内节点不改变数据实际到达境外的事实；
 *   ② 中转出口 IP 2026-08-31 实测在境外（该 IP 会随线路变，别当常量用）——**哪怕开关把 deepseek/qwen
 *      改挂到中转**，那条路上的原文也是出了境的。所以是按 provider 判而不是按型号判，
 *      境内型号走中转一样脱敏。
 *  这一处不会被类型系统或任何现有测试逼着想起来：漏加就是 PII 原文不经脱敏直接发给中转。 */
export const OUTBOUND_PROVIDERS: ReadonlySet<ProviderName> = new Set<ProviderName>([
  'anthropic',
  'openai',
  'relay',
]);

export type PiiKind = '身份证' | '手机号' | '银行卡';

/** 占位符形如 〔身份证#1〕。用全角方头括号而非 [] / {}：
 *  ① 中文文书正文里几乎不出现，误伤概率极低；
 *  ② 不与 JSON / Markdown / 模板占位符【】冲突（knowledge/templates 的填空位用的是【】）。 */
const PLACEHOLDER_RE = /〔(身份证|手机号|银行卡)#(\d+)〕/g;

/** 未闭合尾巴超过这个长度就判定「这个〔不是占位符开头」，直接放行。
 *  〔身份证#1〕是 7 字符，编号涨到四位数也才 10，24 给足余量又不至于长时间卡住输出。 */
const MAX_PLACEHOLDER_LEN = 24;

/**
 * 识别规则。**顺序即优先级**，靠前的先吃掉文本：
 * 身份证（18/15）→ 手机号 → 银行卡。理由是银行卡规则最宽（16-19 位裸数字），
 * 若让它先跑会把 18 位身份证号吞成〔银行卡#1〕，占位符类型错了，还原虽仍正确但语义误导模型。
 *
 * 每条规则两侧都钉 (?<![0-9A-Za-z]) / (?![0-9A-Za-z])：中文没有词边界，\b 在「身份证110101…」
 * 这种紧邻汉字的场景不可靠；而禁止两侧再接字母数字，能挡住「从更长的编号里切出一段」的误伤
 * （统一社会信用代码 91110105MA01… 含字母，因此整体不会被当成银行卡）。
 */
const PATTERNS: { kind: PiiKind; re: RegExp }[] = [
  {
    // 18 位身份证：6 位地址码（首位非 0）+ 8 位出生日期（19xx/20xx + 合法月日）+ 3 位顺序码 + 1 位校验位（数字或 X）。
    // 校验日期而不是简单 \d{17}[\dX]，是为了不把 18 位订单号/流水号当身份证。
    kind: '身份证',
    re: /(?<![0-9A-Za-z])[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?![0-9A-Za-z])/g,
  },
  {
    // 15 位老式身份证：6 位地址码 + 6 位出生日期（yymmdd，无世纪位）+ 3 位顺序码，无校验位。
    kind: '身份证',
    re: /(?<![0-9A-Za-z])[1-9]\d{5}\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}(?![0-9A-Za-z])/g,
  },
  {
    // 手机号 11 位，允许 +86/86 前缀与 3-4-4 分段的空格/横线（用户从通讯录粘贴常带）。
    kind: '手机号',
    re: /(?<![0-9A-Za-z])(?:\+?86[\s-]?)?1[3-9]\d[\s-]?\d{4}[\s-]?\d{4}(?![0-9A-Za-z])/g,
  },
  {
    // 银行卡分组形态：4-4-4-4 (+末段 1-3 位)，即 16-19 位带分隔符。放在裸数字形态之前，
    // 否则裸数字规则会先匹配掉第一段 4 位以外的部分，留下断片。
    kind: '银行卡',
    re: /(?<![0-9A-Za-z])\d{4}(?:[\s-]\d{4}){3}(?:[\s-]\d{1,3})?(?![0-9A-Za-z])/g,
  },
  {
    // 银行卡裸数字形态：16-19 位连续数字。
    // 【刻意的过度替换】不做 Luhn 校验。Luhn 能把「16-19 位数字」的误伤率压到 1/10，
    // 但代价是用户打错一位的卡号会**漏**脱敏——那是真的把银行卡号送出境。
    // 漏替换是合规事故，多替换只是模型少看见一个订单号，且出站前后各还原一次、用户无感。
    // 方向明确：宁可多替，不可漏替。（此项请 manager 在隐私政策措辞中核对，见汇报）
    kind: '银行卡',
    re: /(?<![0-9A-Za-z])\d{16,19}(?![0-9A-Za-z])/g,
  },
];

/** 归一化成「同值」判据：去掉空格/横线，手机号再去掉 +86 前缀。
 *  「138 1234 5678」与「13812345678」是同一个号码，必须落到同一个占位符
 *  （否则模型会以为用户给了两个电话）。 */
function normalize(kind: PiiKind, raw: string): string {
  const digits = raw.replace(/[\s-]/g, '');
  if (kind === '手机号') return digits.replace(/^\+?86/, '');
  return digits;
}

export interface PiiSession {
  /** 出站方向：把真值换成占位符（同值同占位符，按单次会话内首现顺序编号） */
  redact(text: string): string;
  /** 入站方向：整段把占位符换回真值。占位符不在映射表里（模型自己编的）则原样保留 */
  restore(text: string): string;
  /** 入站方向：流式还原，处理占位符被 SSE 分片切断的情形 */
  createStreamRestorer(): StreamRestorer;
  /** 本次会话认出的 PII 条目数，供测试与日志（只报数量，不报值） */
  readonly size: number;
}

/**
 * 一次 chatStream 调用 = 一个 session。映射表的作用域故意做得这么窄：
 * 跨请求复用会让占位符编号变成一个长期存在的、以真值为键的内存表——那本身就是个 PII 库。
 */
export function createPiiSession(): PiiSession {
  /** 归一化真值 → 占位符 */
  const byValue = new Map<string, string>();
  /** 占位符 → 还原用的原始字面量（取首现那次的写法，保留用户自己的分段格式） */
  const byPlaceholder = new Map<string, string>();
  /** 每类各自从 1 开始编号 */
  const counters: Record<PiiKind, number> = { 身份证: 0, 手机号: 0, 银行卡: 0 };

  function placeholderFor(kind: PiiKind, raw: string): string {
    const key = `${kind}:${normalize(kind, raw)}`;
    const existing = byValue.get(key);
    if (existing) return existing;
    const placeholder = `〔${kind}#${++counters[kind]}〕`;
    byValue.set(key, placeholder);
    byPlaceholder.set(placeholder, raw);
    return placeholder;
  }

  function redact(text: string): string {
    let out = text;
    for (const { kind, re } of PATTERNS) {
      // 每次用字面量新建游标：模块级 /g 正则带 lastIndex 状态，跨调用复用会随机漏匹配
      out = out.replace(new RegExp(re.source, re.flags), (m) => placeholderFor(kind, m));
    }
    return out;
  }

  function restore(text: string): string {
    return text.replace(PLACEHOLDER_RE, (m) => byPlaceholder.get(m) ?? m);
  }

  return {
    redact,
    restore,
    createStreamRestorer: () => new StreamRestorer(restore),
    get size() {
      return byPlaceholder.size;
    },
  };
}

/**
 * 流式还原缓冲。
 *
 * 问题：模型把「〔身份证#1〕」写进正文，SSE 分片可能切成「…〔身份」+「证#1〕…」，
 * 逐片 replace 两片都匹配不上，用户屏幕上就出现半截占位符。
 *
 * 取舍：**缓冲至闭合**，而不是「整段收完再一次性还原」。
 * 整段还原实现最简单，但会让首字延迟等于整轮生成时长——流式就白做了，
 * 而这个产品的用户正处在「HR 五分钟后要我回会议室」的场景里，首字延迟是要命的。
 * 缓冲法只在检测到未闭合的「〔」时扣住尾巴（最多 24 字符），其余照常即时下发。
 */
export class StreamRestorer {
  private buf = '';

  constructor(private readonly restore: (text: string) => string) {}

  /** 喂一片增量，返回本片可安全下发的文本（可能为空串 = 全被扣住了） */
  push(chunk: string): string {
    this.buf += chunk;
    let safeEnd = this.buf.length;
    const open = this.buf.lastIndexOf('〔');
    // 尾部存在未闭合的「〔」，且长度还在占位符可能的范围内 → 扣住等下一片
    if (open >= 0 && !this.buf.includes('〕', open) && this.buf.length - open <= MAX_PLACEHOLDER_LEN) {
      safeEnd = open;
    }
    const out = this.restore(this.buf.slice(0, safeEnd));
    this.buf = this.buf.slice(safeEnd);
    return out;
  }

  /** 流末冲刷：把扣住的尾巴交出来（此时不可能再等到闭合了） */
  flush(): string {
    const out = this.restore(this.buf);
    this.buf = '';
    return out;
  }
}

/** 消息脱敏：content 与 assistant 轮的 tool_calls.arguments 都要过一遍 */
function redactMessage(m: ChatMessage, session: PiiSession): ChatMessage {
  const next: ChatMessage = { ...m, content: session.redact(m.content) };
  if (m.tool_calls?.length) {
    next.tool_calls = m.tool_calls.map((tc) => redactToolCall(tc, session));
  }
  return next;
}

function redactToolCall(tc: ToolCall, session: PiiSession): ToolCall {
  return { ...tc, function: { ...tc.function, arguments: session.redact(tc.function.arguments) } };
}

function restoreToolCall(tc: ToolCall, session: PiiSession): ToolCall {
  return { ...tc, function: { ...tc.function, arguments: session.restore(tc.function.arguments) } };
}

async function* restoreStream(
  inner: AsyncGenerator<string, ChatStreamResult, void>,
  session: PiiSession,
): AsyncGenerator<string, ChatStreamResult, void> {
  const restorer = session.createStreamRestorer();
  for (;;) {
    const step = await inner.next();
    if (step.done) {
      const tail = restorer.flush();
      if (tail) yield tail;
      // 工具调用参数整段还原：draft_write 的正文、timeline_add 的 detail 都可能含占位符，
      // 这些是要直接落库的，绝不能带着占位符进 drafts / timeline_events。
      return { ...step.value, toolCalls: step.value.toolCalls.map((tc) => restoreToolCall(tc, session)) };
    }
    const out = restorer.push(step.value);
    if (out) yield out;
  }
}

/**
 * 给出境 provider 套上脱敏壳；境内 provider 原样返回（连包装对象都不建，零开销）。
 * 由 providers/index.ts 的 createProvider 统一调用——那是 lib/llm 唯一的实例出口。
 */
export function withPiiRedaction(provider: Provider): Provider {
  if (!OUTBOUND_PROVIDERS.has(provider.name)) return provider;

  const wrapped: Provider = {
    name: provider.name,
    model: provider.model,
    billingModel: provider.billingModel,
    async chatStream(messages, opts) {
      const session = createPiiSession();
      const inner = await provider.chatStream(
        messages.map((m) => redactMessage(m, session)),
        opts,
      );
      return restoreStream(inner, session);
    },
  };

  if (provider.chatJSON) {
    wrapped.chatJSON = async (messages, opts) => {
      const session = createPiiSession();
      const raw = await provider.chatJSON!(
        messages.map((m) => redactMessage(m, session)),
        opts,
      );
      return session.restore(raw);
    };
  }

  return wrapped;
}
