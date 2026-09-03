// app/src/app/api/v1/cases/[id]/chat/route.ts
// POST 与律师 agent 对话一轮 → SSE（正文增量 + 结构化事件帧 + usage 帧）。
//
// 路由只做四件事：鉴权 → 取参数 → 开流 → 把 lib/agent 的事件写进流（spec §3.2：路由不写业务逻辑）。
// 编排、状态机、工具、落库全在 lib/agent；事件帧形状在 lib/agent/events.ts。
import { NextResponse } from 'next/server';

import { createKnowledgeSearcher, createSseSink, runTurn, startHeartbeat, THREAD_MODES, type AgentEvent, type SseSink } from '@/lib/agent';
import { requireIdentity, parseId } from '@/lib/auth/guard';
import { readJsonBody } from '@/lib/auth/http';
// 余额闸：**判定不在本文件**，只调 lib/billing 那一个入口（主理人 2026-09-03「拦」）。
// 路由不许自己 SELECT gongdao——门槛与余额口径长在 lib/billing，抄第二份就会各自演化。
import { canStartTurn, gongdaoExhaustedMessage } from '@/lib/billing';
// 会员档决定路由到哪个模型（routing.config.ts 的 Plan）。lib/billing 的 barrel 未导出
// getMembership，故直取该文件——本路由只读不写，不碰账本。
import { getMembership } from '@/lib/billing/fulfillment';
import * as cases from '@/lib/cases';
import { getDb } from '@/lib/db/client';
import { toUserFacingError } from '@/lib/errors/user-facing';

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
  // retry_of = 「重试这一轮」，值是失败那条 assistant 消息的 id（messages.failed_code 非空的那行）。
  // 带了它就不看 message：问题原文由编排层从库里那条用户行取（重试的定义是**重发上一条用户消息**，
  // 让客户端回传就等于允许它传别的，那时档案里那一问一答会对不上）。
  const retryOf =
    body.retry_of === undefined || body.retry_of === null ? undefined : Number(body.retry_of);
  if (retryOf !== undefined && (!Number.isInteger(retryOf) || retryOf <= 0)) {
    return NextResponse.json(
      { ok: false, error_code: 'INVALID_RETRY_OF', message: 'retry_of 必须是消息 id' },
      { status: 400 },
    );
  }

  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (!message && retryOf === undefined) {
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

  // 余额闸：**开流之前**判完（spec：开了流状态码就定死 200，402 再也发不出去）。
  // 拦下时不调模型、不插用户消息、不记一行账——这一轮从没发生过。
  // 已经开始的那一轮不受影响（闸在 runTurn 之前，不进编排层），所以最多欠一轮。
  // 会员同规则：会员的额度是买来入账的公道值，不是绕闸的资格。
  const gate = canStartTurn(guard.identity.uid, db);
  if (!gate.ok) {
    return NextResponse.json(
      {
        ok: false,
        error_code: 'GONGDAO_EXHAUSTED',
        message: gongdaoExhaustedMessage(gate.balance),
        // 余额单独成字段：页面要照它渲染横幅（低调模式下换中性词，不能靠拆 message 取数）
        balance: gate.balance,
      },
      { status: 402 },
    );
  }

  const plan = getMembership(db, guard.identity.uid).plan ?? 'entry';
  // 检索器无状态（lib/knowledge 自带进程级索引缓存），每次建一个即可，不必挂全局
  const searcher = createKnowledgeSearcher();

  // 下发口。客户端一断开，controller 就是关的，再 enqueue 一律抛 Invalid state——
  // 而它从心跳的 setInterval 里抛出去时没有任何调用栈接得住（uncaughtException，
  // 会把 next 进程带走）。所以判可写做在这一个出口上，见 sse-sink.ts 文件头。
  let sink: SseSink | null = null;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const out = createSseSink(controller);
      sink = out;
      const emit = out.emit;
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
          retryOf,
        });
        // 流已经开了，此时的失败只能以 error 帧告知（前置校验已经拦掉了绝大多数）。
        // message_id 是这一轮的失败**已经落成的那条 assistant 行**（runTurn 落的）：
        // 前端点「重试」时拿它当 retry_of，才不会重复插一条用户消息。
        if (!result.ok) {
          emit({
            event: 'error',
            data: {
              code: result.errorCode,
              message: result.message,
              ...(result.failedMessageId === undefined ? {} : { message_id: result.failedMessageId }),
            },
          });
        }
      } catch (e) {
        // 模型侧异常（连接失败、非 2xx、流内错误）必须告知：
        // 用户宁可看见「模型这会儿连不上」，也不该看着一个永远转圈的光标。
        // 但这里的 e.message 是工程向的——llm/router 缺 key 时会把环境变量名写进去，
        // 那是当事人看不懂也做不了的东西。原文进服务端日志，出去的是三段式文案。
        const u = toUserFacingError(e, { code: 'AGENT_FAILED', where: 'chat.runTurn' });
        emit({ event: 'error', data: { code: u.code, message: u.message } });
      } finally {
        heartbeat.stop();
        // 断开后流已经是关的，close() 同样抛 Invalid state——而这里是 async start 的
        // finally，抛出去就是一条没人接的 unhandledRejection。sink.close() 自己判。
        out.close();
      }
    },
    // 客户端断开的第一手信号：拿到它就一帧都不再往里塞（不必等第一次 enqueue 抛）
    cancel() {
      sink?.markGone();
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
