// app/src/lib/agent/events.ts
// SSE 事件帧契约（spec §3.5「LLM 响应一律 SSE 流式」）。
//
// 【为什么正文与结构化事件走同一条流】用户看到「今天 18 点前导出这三样」的同时，
// 右侧行动卡就该亮出来。分成两条通道（流式正文 + 事后拉一次档案）会让卡片永远慢半拍，
// 而且断流时对不上账：正文流到一半断了，档案接口却已经把卡返回了。
//
// 【命名原则】事件名按**前端拿它干什么**分，不按后端产生它的工具分：
// action / draft 各自独占一个事件名，是因为前端要为它们渲染专门的卡片组件；
// timeline / claims / emotion / company 合并进 record，是因为前端对它们的处理一模一样
// （在档案区打个「已记录」的点）。多一个事件名就多一处前后端要对齐的地方。
//
// ⚠️ 本文件是前后端契约，改动需 manager 审（同 routing.config.ts 的纪律）。

import type { TaskClass } from '@/lib/llm';
import type { IntakeStage } from './intake';

/** 结构化落库事件覆盖的工具（action / draft 另有专用事件，不在此列） */
export type RecordTool = 'timeline_add' | 'claims_upsert' | 'emotion_log' | 'company_profile_upsert' | 'intake_done' | 'deadline_set';

/** notice 的 code 词表。前端按 code 决定要不要给用户看、以什么口气看。 */
export type NoticeCode =
  /** 本轮知识库零命中，回复已按「需要核实」保守路径生成（charter §3） */
  | 'KNOWLEDGE_MISS'
  /** knowledge 检索器未注入（lib/knowledge 未交付），本轮无依据可引 */
  | 'KNOWLEDGE_UNAVAILABLE'
  /** 本轮行动卡已达 3 张上限，第 4 张起被拒（charter §2） */
  | 'ACTION_CARD_CAPPED'
  /** 补救后仍未产出行动卡，本轮违反 charter §2，已记录 */
  | 'ACTION_CARD_MISSING'
  /** 本案已转介过心理咨询，本次转介请求被拒（spec §10：一案最多一次） */
  | 'REFERRAL_ALREADY_USED'
  /** 模型请求的工具调用参数不合法，已回喂错误让它改正 */
  | 'TOOL_INPUT_REJECTED'
  /** 模型输出了知识库里不存在的案号，已被运行时闸门拦下（charter §7.1 零编造） */
  | 'CITATION_BLOCKED'
  /** 危机轮回复里检出情感杠杆劝阻（charter §5）。**只告警不阻断**，理由见 orchestrator */
  | 'EMOTIONAL_LEVERAGE_DETECTED';

export type AgentEvent =
  | {
      event: 'meta';
      data: {
        thread_id: number;
        message_id: number;
        mode: string;
        intake_stage: IntakeStage;
        task_class: TaskClass;
        /** 实际使用的模型（API 串） */
        model: string;
        /** 首选模型缺 key 而降级时为 true，前端应如实展示（router.ts 的硬要求） */
        degraded: boolean;
      };
    }
  /** 正文增量。PII 占位符已在 lib/llm 出口还原成真值（见 llm/pii.ts） */
  | {
      event: 'delta';
      data: {
        text: string;
        /**
         * true = 由代码直接下发的确定性文本（危机轮首段），不是模型产出。
         * 心跳据此判断「模型还没开始出字」，继续跑——否则首段一到就把心跳停了，
         * 而危机轮的模型段恰恰是非流式的，那 2-4 分钟正是心跳的主场。
         */
        deterministic?: boolean;
      };
    }
  /**
   * 心跳。**只在 meta 之后、首个 delta 之前**按固定间隔发。
   *
   * 推理模型首字前可能思考三四分钟，这段时间流上一个字节都没有，后果有两个：
   * 前端分不清「还在想」和「后端挂了」；中间代理按空闲超时把连接掐断。
   * 心跳同时解决这两件事，并给前端一个「已等待 N 秒」可显示。
   * 正文一开始流就停发——那时候连接自己会保持活跃，再发就是噪音。
   */
  | { event: 'ping'; data: { waited_seconds: number } }
  | {
      event: 'record';
      data: {
        tool: RecordTool;
        /** 落库行 id */
        id: number;
        /** 一句话说明落了什么，前端直接显示 */
        summary: string;
      };
    }
  | {
      event: 'action';
      data: {
        id: number;
        title: string;
        detail: string;
        due_at: string | null;
        priority: number;
        /** 本轮第几张（1-3），前端据此排序 */
        index: number;
      };
    }
  | {
      event: 'draft';
      data: {
        id: number;
        kind: string;
        title: string;
        version: number;
        /**
         * 恒为 true。charter §7.2/§7.5：发给公司的文书是不可逆动作，
         * 前端必须把它渲染成「需要你确认后自行发出」，不得提供任何一键发送。
         */
        requires_confirmation: true;
      };
    }
  | { event: 'notice'; data: { code: NoticeCode; message: string } }
  | {
      event: 'usage';
      data: {
        /** 计费键（billingModel），billing 侧拿它查 model_rates */
        model: string;
        /** 四桶，null 表示本次流未回报——不可当 0 结算（types.ts TokenUsage） */
        prompt: number | null;
        completion: number | null;
        cached_read: number | null;
        cached_write: number | null;
      };
    }
  | { event: 'done'; data: { message_id: number; finish_reason: string | null } }
  | { event: 'error'; data: { code: string; message: string } };

export type AgentEventSink = (event: AgentEvent) => void;

/** 心跳间隔。15 秒远小于常见反代 60-120 秒的空闲超时，留足余量。 */
export const HEARTBEAT_INTERVAL_MS = 15_000;

export interface Heartbeat {
  /** 观察下行事件：见到首个 delta 即自动停发 */
  observe(event: AgentEvent): void;
  /** 流结束时调用，确保定时器不泄漏 */
  stop(): void;
}

/**
 * 起一个心跳。**属于传输层而不是编排层**：runTurn 只管产出领域事件，
 * 「连接会不会被代理掐断」是 SSE 那一层的事，所以由路由启停它。
 *
 * @param emit 与业务事件同一个下发口，保证心跳与正文的顺序天然一致
 * @param opts.now 注入时钟供测试；默认 Date.now
 */
export function startHeartbeat(
  emit: AgentEventSink,
  opts: { intervalMs?: number; now?: () => number } = {},
): Heartbeat {
  const now = opts.now ?? Date.now;
  const startedAt = now();
  let timer: ReturnType<typeof setInterval> | null = setInterval(() => {
    emit({ event: 'ping', data: { waited_seconds: Math.floor((now() - startedAt) / 1000) } });
  }, opts.intervalMs ?? HEARTBEAT_INTERVAL_MS);

  const stop = () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };
  return {
    observe: (event) => {
      // 确定性首段不算「模型开始出字」——它由代码毫秒级下发，模型还在跑
      if (event.event === 'delta' && !event.data.deterministic) stop();
    },
    stop,
  };
}

/** 编码成 SSE 线格式。event 行 + 单行 JSON data 行 + 空行。
 *  data 恒为一行 JSON（JSON.stringify 不产出裸换行），故无需多行 data 拼接。 */
export function encodeSse(e: AgentEvent): string {
  return `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`;
}
