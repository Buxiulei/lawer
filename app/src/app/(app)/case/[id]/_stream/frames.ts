/**
 * 对话 SSE 的九帧契约（WS2 定稿 2026-08-19，manager 已批）。
 * 字段一律照抄后端的 snake_case，**不在这一层改形状**——改名会让前后端对不上账。
 *
 * 帧序：meta → (ping|delta|record|action|draft|notice)* → usage → done
 *       任何一步都可能被 error 顶替。
 *       ping 不只在首字前：正文一停流（模型转去跑 tool 轮）满一个间隔就再现，
 *       所以它和正文帧是交替出现的，不是流开头一段独占的前缀。
 *
 * 危机场景多一段：meta 之后毫秒级先到 deterministic=true 的 delta（接住式安抚+求助热线），
 * 模型正文可能还要 2-4 分钟，这期间 ping 照常。
 */

import type { ActionItem } from '@/app/_mock/types';
import type { NoticeCode } from '@/lib/agent/events';

export interface MetaFrame {
  type: 'meta';
  thread_id: string;
  message_id: string;
  mode: string;
  intake_stage: string | null;
  task_class: string;
  model: string;
  /** true = 主力模型不可用，本轮由备用模型完成 */
  degraded: boolean;
}

/** meta 之后**正文没在流的每一段静默期**每 15s 一帧：**非 deterministic** delta 一到即停，
 *  正文再停流（tool 轮）满一个间隔又接上，done 终止。
 *  推理模型首字前可思考 3-4 分钟，首字之后每一轮 tool 往返又是几十秒零帧（产线实测 88.6 秒），
 *  这都不是错误。
 *  `waited_seconds` 恒为本轮开跑至今的总秒数，跨 tool 轮不复位——别拿它当「本段静默多久」。 */
export interface PingFrame {
  type: 'ping';
  waited_seconds: number;
}

export interface DeltaFrame {
  type: 'delta';
  text: string;
  /** true = 危机场景的确定性首段（服务端调模型前毫秒级下发），不代表模型已开口 */
  deterministic?: boolean;
}

export type RecordTool =
  | 'timeline_add'
  | 'claims_upsert'
  | 'emotion_log'
  | 'company_profile_upsert'
  | 'intake_done'
  | 'deadline_set';

export interface RecordFrame {
  type: 'record';
  tool: RecordTool;
  id: string;
  summary: string;
}

export interface ActionFrame {
  type: 'action';
  id: string;
  title: string;
  detail: string;
  due_at: string | null;
  priority: 1 | 2 | 3;
  index: number;
}

export interface DraftFrame {
  type: 'draft';
  id: string;
  kind: string;
  title: string;
  version: number;
  /** 恒 true：草稿一律经确认流，UI 不提供「直接发出」 */
  requires_confirmation: boolean;
}

/**
 * notice 的码表**只有一份**，在服务端 `lib/agent/events.ts`。这里只是把它引过来。
 *
 * 【为什么不再抄一份】抄的那一份少了 10 个码（实测 2026-09-10：后端 26、前端 16），
 * 其中 7 个是后端**每天都在发**的（CORE_ARTICLE_RENDERED / INJECTION_OBSERVED /
 * EMPTY_PACK / REFERRAL_OFFERED 等）。它们每次都掉进下面 `noticeCopy` 的"未知 code"分支，
 * 而那一支只 warn 一行、返回 null——**屏幕上没有任何异样，服务端也没有任何异样**，
 * 两份表脱节这件事只在浏览器控制台里留了一行字，没有人在看。
 * 派生之后，后端加一个码而这里没登记 → `NOTICE_COPY` 的 Record 穷举当场 tsc 红。
 *
 * 只引类型：`import type` 在编译期被抹掉，客户端包里不会多出服务端模块。
 */
export type { NoticeCode };

export interface NoticeFrame {
  type: 'notice';
  code: NoticeCode;
  message: string;
  /**
   * 一键回复 chip 的文本：用户点一下就原样发出去的那句话（真源在服务端各闸，见 events.ts）。
   * 缺席 = 这条通知没有"回一句就能推进"的出路，闸提示行不出现。
   */
  suggest?: string;
}

/** 流末计量。**null = 该桶无数据，不是 0**，展示时必须区分。 */
export interface UsageFrame {
  type: 'usage';
  model: string;
  prompt: number | null;
  completion: number | null;
  cached_read: number | null;
  cached_write: number | null;
}

/**
 * 收尾帧。型号三件套在这一帧而不是 meta：meta 在开跑前就发了，那时只知道我们**请求**了谁，
 * 厂商实际派谁来服务要到流末才回显。三个字段都可选——旧服务端（或演示替身）不带它们时
 * 前端照旧工作，标注不出现而已；**绝不拿 meta.model 顶替**，那是请求值不是实际值。
 */
export interface DoneFrame {
  type: 'done';
  message_id: string;
  finish_reason: string;
  /** 我们请求的型号（API 别名） */
  model?: string;
  /** 厂商回显的**实际**服务型号；null = 这一轮没回显过 */
  served_model?: string | null;
  /** 实际与请求不是同一个型号 */
  served_mismatch?: boolean;
}

/** error 帧只有 code/message；retry_after 来自非流错误体 {ok:false,error_code,message,retry_after?}，
 *  两者在这一层归一成同一个形状给 UI 用。 */
export interface ErrorFrame {
  type: 'error';
  code: string;
  message: string;
  retry_after?: number;
  /**
   * 这一轮的失败已经落成的那条 assistant 行的 id（服务端发的是 number，
   * `toFrame` 统一转成串，见下方 message_id 那段注释）。
   * 点「重试」时把它发回去当 retry_of：服务端据此重发**同一句**问话，且不再插一条新的用户消息。
   */
  message_id?: string;
  /**
   * 公道值余额（只有 `code === 'GONGDAO_EXHAUSTED'` 的那一帧带）。
   * 横幅要照它渲染，**不从 message 里抠数字**：低调模式下横幅换的是整句说法
   * （见 StreamParts 的 GongdaoExhaustedBanner），抠字符串那条路在换词的那一刻就断了。
   */
  balance?: number;
}

/**
 * 余额闸拦下这一轮时服务端给的错误码（HTTP 402）。
 * 前端据它换整块 UI（横幅 + 禁输入框），不是当成又一种「这一轮没说完」。
 * 与服务端 route.ts 里写的那个串必须一致——那边由路由用例按行为钉住（402 + 这个码）。
 */
export const GONGDAO_EXHAUSTED = 'GONGDAO_EXHAUSTED';

/**
 * 在飞占位拦下这一轮时服务端给的错误码（HTTP 409）。
 * **不与 402 归成一个码**：一个等一等就好，一个等多久都没用（得先兑换/充值）。
 * 归一了会把「等一会儿」的人指去兑换页白跑一趟。
 */
export const TURN_IN_FLIGHT = 'TURN_IN_FLIGHT';

/**
 * 服务端**在 runTurn 之前**就拒答的那些码：一个字都没落库——不调模型、不插用户消息、
 * 不记一行账。于是页面上那条本地回显是一条**孤儿**：屏幕上写着「发出去了」，
 * F5 之后它就没了。这些码一律要撤掉回显、把原文还回输入框。
 *
 * 【这是一份登记表，不是两三个特例】route.ts 里 runTurn 之前的**每一个** error_code
 * 都在这里，由那侧的结构守卫按源码逐个核对（见 chat/__tests__/route.test.ts）。
 * 下一个前置 4xx 加进路由却忘了登记，守卫当场点名——而漏掉的后果是静默的：
 * 那一档的回显留在屏幕上，刷新后消失，页面看不出任何异样。
 *
 * 【登记 ≠ 画法相同】「撤回显」是这些码的共同处置。画成什么（横幅 / 提示条 / 失败卡）、
 * 输入框禁不禁用，仍由 Workbench 逐码决定：402 要禁输入框（充值之前打什么都白打），
 * 409 不禁（上一轮答完就能接着问，禁掉等于把唯一的出路也关了）。
 */
export const REFUSED_BEFORE_WRITE: ReadonlySet<string> = new Set([
  GONGDAO_EXHAUSTED,
  TURN_IN_FLIGHT,
  // 以下同为「开流之前就返回、一字未落库」的前置校验（route.ts 里挨着写的那几条）
  'CASE_NOT_FOUND',
  'INVALID_BODY',
  'INVALID_RETRY_OF',
  'EMPTY_MESSAGE',
  'INVALID_MODE',
]);

/** 这个错误码是不是「服务端一字未落库」的那一档（见 REFUSED_BEFORE_WRITE）。 */
export function isRefusedBeforeWrite(code: string | null | undefined): boolean {
  return typeof code === 'string' && REFUSED_BEFORE_WRITE.has(code);
}

export type StreamFrame =
  | MetaFrame
  | PingFrame
  | DeltaFrame
  | RecordFrame
  | ActionFrame
  | DraftFrame
  | NoticeFrame
  | UsageFrame
  | DoneFrame
  | ErrorFrame;

const FRAME_TYPES = new Set([
  'meta',
  'ping',
  'delta',
  'record',
  'action',
  'draft',
  'notice',
  'usage',
  'done',
  'error',
]);

/**
 * 把一条 SSE 事件收成帧。未知帧类型返回 null（调用方忽略并 warn）——
 * 后端加帧不该让老前端崩掉。
 *
 * 【为什么这里要动 message_id】(2026-09-02 真机)
 * 服务端 `events.ts` 里 meta / done 的 `message_id` 是**数据库主键，number**；
 * 这一层的 `MetaFrame`／`DoneFrame` 却把它写成 `string`。两边从来没对过账，
 * 因为末行那个 `as StreamFrame` 是**无校验断言**——TS 于是一路默许，编译全绿。
 *
 * 真机后果：演示替身发的是 `m_<剧本id>_<时间戳>`（真字符串），所以演示页一切正常；
 * 而真对话每一轮收尾时 `mockLawRefs(turn.messageId)` 会对着一个 number 调
 * `.startsWith`，抛 `TypeError: r.startsWith is not a function`。它抛在 React 渲染里，
 * 整棵树垮掉 → **每一轮回答刚渲染完，页面就变成 "This page couldn't load"**。
 * （这正是此前被记在服务端 uncaughtException 名下的那个症状——同一句话，两个病因。）
 *
 * 【为什么修在这里】这是所有帧进入前端的**唯一入口**。在消费点上各自 `String(...)`
 * 是"漏接一个即失效"，而漏掉的那个恰恰只在真对话里走到——演示页永远测不出来。
 */
export function toFrame(event: string | null, data: unknown): StreamFrame | null {
  if (!data || typeof data !== 'object') return null;
  const payload = data as Record<string, unknown>;
  const type = event ?? (typeof payload.type === 'string' ? payload.type : null);
  if (!type || !FRAME_TYPES.has(type)) return null;
  // 归一成本层声明的类型：数字主键照实转成串，其余原样（不存在就不要凭空造一个）
  const normalized =
    typeof payload.message_id === 'number'
      ? { ...payload, message_id: String(payload.message_id) }
      : payload;
  return { ...normalized, type } as StreamFrame;
}

/* ── 展示口径 ────────────────────────────────────────────────── */

/**
 * 型号 → 档位。**档位是型号的注解，不是型号的替身。**
 *
 * 这张表以前叫 MODEL_LABELS，值是「主力模型」这样的中文名，屏幕上只印这个名字。
 * 那等于把用户唯一能核对的事实（他这一轮到底拿到了 opus 还是 flash）换成了一个
 * 我们自己起的好听说法——**换了模型、换了厂商，这行字一个像素都不变**。
 * 用户按型号付费，落款就必须印**型号 id 本身**；档位只作小字跟在后面，帮他知道那是贵的还是快的。
 */
const MODEL_TIERS: Record<string, string> = {
  'claude-opus-5': '深度推理',
  'claude-sonnet-5': '主力',
  'deepseek-v4-pro': '深度推理',
  'deepseek-v4-flash': '快速',
  'qwen3.7-max': '备用主力',
  'qwen3.6-flash': '快速',
};

/** 等待卡的主语：认得出型号就点名，认不出就不硬编一个假名字。 */
export function waitingHeadline(model: string | null | undefined): string {
  const tier = model ? MODEL_TIERS[model] : undefined;
  return tier ? `正在用${tier}模型斟酌` : '正在斟酌';
}

/**
 * 每条回答底下那行「这一轮谁答的」。
 *
 * 【口径：实际优先，没有实际才退回请求】`served` 是厂商回显的**实际**服务型号，
 * `requested` 是我们发出去的。中转按渠道分组路由，请求 opus 完全可能由 sonnet 返回
 * （billing/served-model.ts 文件头的实测），所以拿请求值当"实际"标出去就是在撒谎——
 * 而这一行字的全部意义正是"实际"。两个都没有就一个字都不写：宁可不标，不猜。
 *
 * 【形状：型号 id 为主，档位为辅】`claude-opus-5 · 深度推理`。
 * 主语必须是**型号 id 本身**——用户按型号付费，他要核对的就是这串字；
 * 只印「深度推理模型」的话，把 opus 换成 flash 这行字也不会变，那就不叫核对。
 * 认不出的型号串原样显示（多半是厂商新加的日期快照），后面不缀档位，也不硬编一个好听的假名字。
 * `(替代)` 只在服务端判定换过型号时加——判据同源于记账那一处，前端不自己比字符串。
 */
export function servedModelLabel(input: {
  served?: string | null;
  requested?: string | null;
  mismatch?: boolean;
}): string | null {
  const model = input.served?.trim() || input.requested?.trim() || '';
  if (!model) return null;
  const tier = MODEL_TIERS[model];
  const label = tier ? `${model} · ${tier}` : model;
  return input.mismatch ? `${label}（替代）` : label;
}

/** 「已等待 3 分 12 秒」。不足一分钟只说秒。 */
export function formatWaited(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const min = Math.floor(total / 60);
  const sec = total % 60;
  return min > 0 ? `已等待 ${min} 分 ${sec} 秒` : `已等待 ${sec} 秒`;
}

/** record 帧的档案落点，用于 chip 前缀。 */
const RECORD_LABELS: Record<RecordTool, string> = {
  timeline_add: '时间线',
  claims_upsert: '诉求金额',
  emotion_log: '状态记录',
  company_profile_upsert: '公司信息',
  intake_done: '首诊',
  deadline_set: '期限',
};

export function recordLabel(tool: RecordTool): string {
  return RECORD_LABELS[tool] ?? '档案';
}

/**
 * 后端 message 原文照搬。用于「每轮内容都不一样」的提示——前端写死一句
 * 固定话术只能说废话（例：CALC_FAILED 的「还差哪几项」逐轮不同）。
 */
const PASSTHROUGH = Symbol('notice-passthrough');

/**
 * 这条 notice 走**闸提示行**（GateHintLine）：渲染后端的 message，再附一个一键回复 chip。
 *
 * 【为什么不是又一个 PASSTHROUGH】提示行是一行冷静的字，闸提示要多给一个可点的出口；
 * 两者共用一种渲染的形态是——出路句照样只是一段文字，用户读完仍然要自己把那句话打一遍，
 * 而那句话正是我们已经替他写好了的（`suggest`）。
 */
const GATE_HINT = Symbol('notice-gate-hint');

/**
 * notice 帧展示策略（WS2 词表定稿，manager 已入册）。**键是穷举的**：
 * 后端 events.ts 的码表加一个码而这里没登记，Record 当场 tsc 红。
 *
 * 四种取值，**别用空字符串**：
 *   · 固定文案   —— 每轮都一样的那句话，写死在这里；
 *   · `null`     —— 静默。每一条都要写明「为什么用户不需要看到」；
 *   · PASSTHROUGH—— 用后端原文（每轮内容不同，写死只能说废话）；
 *   · GATE_HINT  —— 闸提示行：后端原文 + 一键回复 chip（禁令配出路）。
 * `''` 会被渲染层的 `if (!copy)` 当成静默吞掉，看着像「配了文案」其实一个字都不显示。
 *
 * 静默那一档尤其不得出现「拦截」类字样（EMOTIONAL_LEVERAGE_DETECTED 等）。
 * 未知 code：丢弃 + console.error 三段式（见 noticeCopy —— 派生之后它只应在两份表脱节时到达）。
 */
const NOTICE_COPY: Record<NoticeCode, string | null | typeof PASSTHROUGH | typeof GATE_HINT> = {
  KNOWLEDGE_MISS:
    '这个点法条库暂无逐字依据，以上是通用口径，已标记待补。',
  KNOWLEDGE_UNAVAILABLE:
    '法条库这一轮没连上，以上按通用口径给你，过一会儿再问一次能拿到逐字原文。',
  // 卡到第 4 张才拒的那一档：前 3 张照常在屏幕上，用户要的东西一件不少
  ACTION_CARD_CAPPED: null,
  // 「补救后仍没产出卡」是运维信号；用户面的纠正由 orchestrator 追加进**归档正文**
  //（notice 是流帧、刷新即消失，而那句承诺永久留在历史里）
  ACTION_CARD_MISSING: null,
  // 一案最多一次的频控。用户没请求过这件事，告诉他"这次被拒了"等于替他记着他没提的诉求
  REFERRAL_ALREADY_USED: null,
  // 模型自己把工具参数写错了，已回喂让它改正——那是我们与模型之间的事
  TOOL_INPUT_REJECTED: null,
  // ⑤ 案号闸 / ⑦ 伪逐字引用闸共用这个码。带 suggest 的那一支（⑤）走闸提示行；
  // ⑦ 的出路已经逐字写在正文的替换句里（「这一条我需要核实原文再引给你」），不另起一行
  CITATION_BLOCKED: GATE_HINT,
  // 「只给条号没给逐字原文」是内部质量信号，不对用户出提示行——
  // 告诉用户「这条引用不完整」既帮不上忙，又会让他怀疑手里已有的内容
  CITATION_INCOMPLETE: null,
  // ⑥⑨ 与 ⑤ 同一条口径：闸开了火，用户要看到一句「下一步」。
  // 正文里的【条号待核验】【数值无来源】说的是"哪一处"，提示行说的是"你回我一句什么"——
  // 两者缺一个都不成其为出路：只有标记，用户不知道该说什么；只有提示行，他不知道该动哪一句。
  STATUTE_UNVERIFIED: GATE_HINT,
  VALUE_UNSOURCED: GATE_HINT,
  // 闸链汇总是纯运维指标，每轮都发。给用户看等于把我们的自检过程摊在他面前
  GATE_REPORT: null,
  // 「号是真的、细节是编的」这一条只留痕不改正文：说了他也无从分辨是哪半句被污染
  PRECEDENT_CONTAMINATED: null,
  // 唯一一条「失败」类的用户可见提示。文案由后端按缺失项拼好直接下发
  // （tools.ts：「还差：入职日期、月工资。你把这几项告诉我，我立刻重算一遍」），
  // 这里不再套一层固定话术——「还差哪几项」每轮都不一样，写死就只能说废话。
  CALC_FAILED: PASSTHROUGH,
  // 杠杆句已经被剥掉、到不了用户——告诉他"刚才拦下了一句劝阻的话"只会让他去想那句话是什么。
  // 尤其不得出现「拦截」类字样（WS2 词表定稿）
  EMOTIONAL_LEVERAGE_DETECTED: null,
  // 同上：被剥掉的是一次不该发生的推销，用户没读到过它，不必知道它存在过
  NBDPSY_PITCH_BLOCKED: null,
  // 同意被记下来了，用户该看得见——这是**他自己刚做的一个决定**，
  // 静默的形态是：他说了「同意记录」，屏幕上什么都没变，只能靠下一轮的行为去猜生没生效。
  CONSENT_RECORDED: PASSTHROUGH,

  /* ── 以下十个码此前**不在这份表里**（前端只有 16 个，后端 26 个）。
        它们不是新增的功能，是一直在发、一直掉进"未知 code"分支的那一批。
        每一个都明写「为什么用户不需要看到」——留白与"忘了填"在下一个人眼里同形。 ── */

  // 按场景定向补入了核心法条卡：补进去的是**依据**，用户在依据区就能看见它本身
  CORE_ARTICLE_INJECTED: null,
  // 核心位光秃 → 自动补上卡内逐字原文。补的内容就在正文里，不必再说一句"我补过了"
  CORE_ARTICLE_RENDERED: null,
  // 「系统这一轮给了模型什么」的可观测留痕，纯运维（三态见 events.ts）
  INJECTION_OBSERVED: null,
  // 空包率是召回质量的度量，给我们看的。用户面的告知另有 KNOWLEDGE_MISS 一条
  EMPTY_PACK: null,
  // 本轮没拿到 token 计量 → 跳过记账。账的事在账本页说，不在对话里说
  USAGE_UNREPORTED: null,
  // 厂商实际派谁来服务与我们请求的不一致。用户面的如实标注在每条回答底下那行型号落款上
  SERVED_MODEL_MISMATCH: null,
  // 提示缓存读数，纯运维（每轮都发，恒为 0 也发）
  PROMPT_CACHE: null,
  // 本轮推荐了心理咨询 → 台账落行。推荐本身就在正文里，用户读到的是那段话，不是这条记录
  REFERRAL_OFFERED: null,
  // 用户说了不需要 → 落 declined。他刚说完，不必再回他一句"我记下了你不需要"
  REFERRAL_DECLINED: null,
  // **事故级**：危机轮出现付费/预约内容，已整句剥除。用户没读到它，也不该在此刻读到
  // 任何与钱有关的字；这条的收件人是运维——服务端落 console.error 三段式并进 gate_json，
  // 见 orchestrator.ts 那一处
  CRISIS_PAID_CONTENT_BLOCKED: null,
};

/** 走闸提示行的那几个码（真源是上面那张表，不另列一份名单）。 */
function isGateHint(code: NoticeCode): boolean {
  return NOTICE_COPY[code] === GATE_HINT;
}

/**
 * 这一轮要画成**闸提示行**的通知：每个码最多一条。
 *
 * 【为什么只收带 `suggest` 的】`suggest` 是服务端说的「这一处用户回一句话就能推进」。
 * 没有它的同码通知（⑦ 伪逐字引用闸）出路已经逐字写在正文的替换句里，
 * 再顶一行等于同一件事在屏幕上说两遍——而用户读到两遍，会以为出了两处问题。
 *
 * 【为什么同码要合并】⑥ 一轮标了 3 处条号就发 1 条通知，但 ⑤/⑦ 共用一个码、
 * 同一轮可能各发一条。逐条画的形态是正文底下叠着两三行长得一模一样的提示，
 * 用户读完只会觉得"这条回复到处都是问题"，而不知道该动哪一句。
 * 合并保留**第一条**的 message 与 suggest（它是这一轮最先开火的那道闸），
 * 多出来的只报条数——把第二条的措辞也拼上去，就成了一段没人读得完的话。
 */
export function gateHints(frames: readonly NoticeFrame[]): NoticeFrame[] {
  const out: NoticeFrame[] = [];
  const extra = new Map<NoticeCode, number>();
  for (const f of frames) {
    if (!isGateHint(f.code) || !f.suggest?.trim() || !f.message?.trim()) continue;
    const at = out.findIndex((x) => x.code === f.code);
    if (at === -1) out.push(f);
    else extra.set(f.code, (extra.get(f.code) ?? 0) + 1);
  }
  return out.map((f) => {
    const more = extra.get(f.code) ?? 0;
    return more === 0 ? f : { ...f, message: `${f.message}（本轮同类提示还有 ${more} 条）` };
  });
}

/**
 * 提示行要显示的字；null = 这一条不画提示行。
 *
 * 闸提示（GATE_HINT）那几个码在这里也返回 null：它们由 `gateHints` + GateHintLine 画，
 * 两处都画就是同一件事在屏幕上说两遍。
 */
export function noticeCopy(frame: NoticeFrame): string | null {
  if (!(frame.code in NOTICE_COPY)) {
    // 【为什么是 error 而不是 warn】码表已经从后端派生（见 NoticeCode 那段），
    // 走到这里只剩一种可能：两份表脱节了，而那是 tsc 本该拦住的事。
    // 三段式：缺什么 / 为什么缺 / 怎么办——裸报错让下一个人把我们推过的这一遍再推一次。
    console.error(
      `[stream] 收到词表里没有的 notice code「${frame.code}」，这一条被丢掉了。` +
        '原因：前端码表派生自 lib/agent/events.ts 的 NoticeCode，这条码不在那份表里 —— ' +
        '要么服务端发了一个没登记的码，要么这份前端产物比服务端旧。' +
        '处置：把它加进 events.ts 的 NoticeCode 与本文件的 NOTICE_COPY（缺一个 tsc 会红），' +
        '并在 NOTICE_COPY 里写明它给不给用户看。',
    );
    return null;
  }
  const copy = NOTICE_COPY[frame.code];
  if (copy === GATE_HINT) return null;
  // 后端原文缺失或全是空白时宁可静默：空提示行比不出提示更让人心慌。
  if (copy === PASSTHROUGH) return frame.message?.trim() || null;
  return copy;
}

/** action 帧 → 现有行动卡数据结构，让 ActionCard/档案面板照旧工作。 */
export function toActionItem(frame: ActionFrame, caseId: string): ActionItem {
  return {
    id: frame.id,
    caseId,
    title: frame.title,
    detail: frame.detail,
    dueAt: frame.due_at,
    priority: frame.priority,
    status: '待办',
    sourceMessageId: null,
    createdAt: new Date().toISOString(),
  };
}
