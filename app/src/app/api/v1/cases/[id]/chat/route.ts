// app/src/app/api/v1/cases/[id]/chat/route.ts
// POST 与律师 agent 对话一轮 → SSE（正文增量 + 结构化事件帧 + usage 帧）。
//
// 路由只做四件事：鉴权 → 取参数 → 开流 → 把 lib/agent 的事件写进流（spec §3.2：路由不写业务逻辑）。
// 编排、状态机、工具、落库全在 lib/agent；事件帧形状在 lib/agent/events.ts。
import { NextResponse } from 'next/server';

import { createKnowledgeSearcher, encodeSse, runTurn, startHeartbeat, THREAD_MODES, type AgentEvent } from '@/lib/agent';
import { requireIdentity, parseId } from '@/lib/auth/guard';
import { readJsonBody } from '@/lib/auth/http';
// 会员档决定路由到哪个模型（routing.config.ts 的 Plan）。lib/billing 的 barrel 未导出
// getMembership，故直取该文件——本路由只读不写，不碰账本。
import { getMembership } from '@/lib/billing/fulfillment';
import * as cases from '@/lib/cases';
import { getDb } from '@/lib/db/client';

const NOT_FOUND = { ok: false, error_code: 'CASE_NOT_FOUND', message: '案件不存在' };

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const db = getDb();
  const guard = requireIdentity(db, req, 'case:write');
  if (!guard.ok) return guard.response;

  const caseId = parseId((await params).id);
  if (caseId === null) return NextResponse.json(NOT_FOUND, { status: 404 });

  const body = await readJsonBody(req);
  if (!body) {
    return NextResponse.json({ ok: false, error_code: 'INVALID_BODY', message: '请求体格式不正确' }, { status: 400 });
  }
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (!message) {
    return NextResponse.json({ ok: false, error_code: 'EMPTY_MESSAGE', message: 'message 不能为空' }, { status: 400 });
  }
  // mode 是用户可控输入，且会直接写进 threads.mode。在开流之前校验，
  // 否则这个错误只能变成「200 + 流里一帧 error」，客户端拿不到 400。
  const mode = body.mode === undefined ? undefined : String(body.mode);
  if (mode !== undefined && !(THREAD_MODES as readonly string[]).includes(mode)) {
    return NextResponse.json(
      { ok: false, error_code: 'INVALID_MODE', message: `mode 只能是 ${THREAD_MODES.join(' / ')}` },
      { status: 400 },
    );
  }

  // 归属校验前置：案件不属于本人时要给 404 而不是「200 + 流里一帧 error」——
  // 一旦开了流，HTTP 状态码就定死在 200 了，客户端再也拿不到正确的失败语义。
  const owned = cases.getCase(db, { caseId, userId: guard.identity.uid, timelineLimit: 1 });
  if (!owned.ok) {
    return NextResponse.json(
      { ok: false, error_code: owned.errorCode, message: owned.message },
      { status: owned.status },
    );
  }

  const plan = getMembership(db, guard.identity.uid).plan ?? 'entry';
  // 检索器无状态（lib/knowledge 自带进程级索引缓存），每次建一个即可，不必挂全局
  const searcher = createKnowledgeSearcher();
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (e: AgentEvent) => controller.enqueue(encoder.encode(encodeSse(e)));
      // 正文没在流的每一段静默期都发心跳：首字前推理模型可能想三四分钟，首字之后
      // 每一轮 tool 往返又是几十秒零帧（实测 88.6s）。期间连接必须保持活跃、
      // 前端也需要一个「还在跑」的信号。正文一续上自动停，done 终止。
      const heartbeat = startHeartbeat(emit);
      const emitAndWatch = (e: AgentEvent) => {
        emit(e);
        heartbeat.observe(e);
      };
      try {
        const result = await runTurn({
          db,
          caseId,
          userId: guard.identity.uid,
          message,
          mode,
          plan,
          searcher,
          emit: emitAndWatch,
        });
        // 流已经开了，此时的失败只能以 error 帧告知（前置校验已经拦掉了绝大多数）
        if (!result.ok) emit({ event: 'error', data: { code: result.errorCode, message: result.message } });
      } catch (e) {
        // 模型侧异常（连接失败、非 2xx、流内错误）如实透出：
        // 用户宁可看见「模型这会儿连不上」，也不该看着一个永远转圈的光标。
        emit({
          event: 'error',
          data: { code: 'AGENT_FAILED', message: e instanceof Error ? e.message : String(e) },
        });
      } finally {
        heartbeat.stop();
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Caddy/nginx 缓冲会把「流式」变成「等全部生成完再一次性吐出」，明确关掉
      'x-accel-buffering': 'no',
    },
  });
}
