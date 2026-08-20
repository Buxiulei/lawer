'use client';

/**
 * 演示传输：把剧本按九帧契约吐出来，节奏与真链路一致
 * （受理即 meta → 思考期每 15s 一 ping → delta 逐 chunk → 流末 usage/done）。
 *
 * 默认在 workbenchReplies 里轮转；`?mock=rs_long` 这类参数可点名跑演示剧本
 * （长考等待态 / 降级 / 草稿确认 / 提示 / 断流 / 危机确定性首段），供人工验收用。
 */

import {
  DEFAULT_THINK_MS,
  findScript,
  workbenchReplies,
  type ReplyScript,
} from '@/app/_mock/workbench';
import type { StreamFrame } from './frames';
import type { ChatRequest, ChatTransport } from './transport';

/** 契约规定 meta 后每 15s 一帧，mock 照搬，不为演示提速 */
const PING_INTERVAL_MS = 15_000;
/** 受理到 meta 的耗时 */
const ACCEPT_DELAY_MS = 150;
/** meta 到确定性首段的耗时：这一段不过模型，是毫秒级 */
const DETERMINISTIC_DELAY_MS = 80;
const CHUNK_MIN_MS = 30;
const CHUNK_MAX_MS = 60;
const CHUNK_MIN_CHARS = 2;
const CHUNK_MAX_CHARS = 5;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

function scenarioFromUrl(): ReplyScript | undefined {
  if (typeof window === 'undefined') return undefined;
  const id = new URLSearchParams(window.location.search).get('mock');
  return id ? findScript(id) : undefined;
}

export function createMockTransport(): ChatTransport {
  let turn = 0;

  return {
    kind: 'mock',
    async *send({ signal }: ChatRequest): AsyncGenerator<StreamFrame> {
      const script =
        scenarioFromUrl() ?? workbenchReplies[turn++ % workbenchReplies.length];
      const messageId = `m_${script.id}_${Date.now()}`;

      await sleep(ACCEPT_DELAY_MS, signal);
      if (signal.aborted) return;

      yield {
        type: 'meta',
        thread_id: 'th_1',
        message_id: messageId,
        mode: '陪跑',
        intake_stage: script.intakeStage ?? null,
        task_class: script.taskClass ?? 'standard',
        model: script.model,
        degraded: script.degraded ?? false,
      };

      const startedAt = Date.now();

      // 危机场景：调模型前先把确定性首段发出去，人不用干等
      if (script.deterministic) {
        await sleep(DETERMINISTIC_DELAY_MS, signal);
        if (signal.aborted) return;
        yield { type: 'delta', text: script.deterministic, deterministic: true };
      }

      // 思考期：每 15s 一 ping，首个非 deterministic delta 到即停
      const think = script.thinkMs ?? DEFAULT_THINK_MS;
      while (Date.now() - startedAt < think) {
        const remaining = think - (Date.now() - startedAt);
        await sleep(Math.min(PING_INTERVAL_MS, remaining), signal);
        if (signal.aborted) return;
        if (Date.now() - startedAt < think) {
          yield {
            type: 'ping',
            waited_seconds: Math.round((Date.now() - startedAt) / 1000),
          };
        }
      }

      for (const record of script.records ?? []) {
        yield { type: 'record', ...record };
        await sleep(120, signal);
        if (signal.aborted) return;
      }

      const full = script.content;
      if (script.blockDelivery) {
        // 危机轮真实形态：正文非流式，过闸后单个大 delta 整块到达
        yield { type: 'delta', text: full };
      } else {
        const failAtChars = script.failAt
          ? Math.floor(full.length * script.failAt.ratio)
          : Infinity;
        let sent = 0;
        while (sent < full.length) {
          const size =
            CHUNK_MIN_CHARS +
            Math.floor(Math.random() * (CHUNK_MAX_CHARS - CHUNK_MIN_CHARS + 1));
          const next = Math.min(sent + size, full.length);
          yield { type: 'delta', text: full.slice(sent, next) };
          sent = next;
          if (script.failAt && sent >= failAtChars) {
            yield {
              type: 'error',
              code: script.failAt.code,
              message: script.failAt.message,
              retry_after: script.failAt.retryAfter,
            };
            return;
          }
          await sleep(
            CHUNK_MIN_MS + Math.random() * (CHUNK_MAX_MS - CHUNK_MIN_MS),
            signal,
          );
          if (signal.aborted) return;
        }
      }

      for (const notice of script.notices ?? []) {
        yield { type: 'notice', ...notice };
      }

      let index = 0;
      for (const action of script.actions) {
        yield {
          type: 'action',
          id: action.id,
          title: action.title,
          detail: action.detail,
          due_at: action.dueAt,
          priority: action.priority,
          index: index++,
        };
      }

      for (const draft of script.drafts ?? []) {
        yield { type: 'draft', ...draft };
      }

      yield {
        type: 'usage',
        model: script.model,
        prompt: 3120,
        completion: Math.max(1, Math.round(full.length / 1.6)),
        cached_read: 2048,
        // 只有 Anthropic 有缓存写计量；null 表示这一桶没数据，不是 0
        cached_write: script.model.startsWith('claude') ? 512 : null,
      };

      yield { type: 'done', message_id: messageId, finish_reason: 'stop' };
    },
  };
}
