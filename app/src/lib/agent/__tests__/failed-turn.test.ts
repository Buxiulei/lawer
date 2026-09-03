// app/src/lib/agent/__tests__/failed-turn.test.ts
// 【一轮失败也要留下痕迹】模型不可用 / 超时 / 断连时，这一轮必须在库里留一条
// **看得见的** assistant 行，而不是只在前端闪一张卡。
//
// ─────────────── 这组补的是哪个缺口 ───────────────
// naive-qa-2 F-203 真机：`/case/5/ask` 连发 3 轮（本地无模型 key，全走 AGENT_FAILED），
// 刷新前屏幕上有「这一轮没能生成回答… / 错误码 / 重试」；**刷新后横幅和按钮全没了**，
// 只剩用户自己的问题一句挨一句排着。对一个在等仲裁的人，那个形状与
// "我讲的话被系统吞了" 分辨不出来——他会从头再讲一遍。
//
// 病因两截，缺一截就修不干净：
//  ① 缺 key 时 `getProvider` 在**占位行落库之前**就抛了 ⇒ 库里连一行 assistant 都没有；
//  ② 占位行落住之后再抛，行是有了，但 content 停在 NULL ⇒ `listCaseMessages`
//     按 `content IS NOT NULL` 取数，那一行照样不会出现在历史里。
// 所以两支都要落成 failed_code 非空 + content 是三段式失败文案（**不许 NULL**）。
//
// 【重试为什么不是"把原文再发一遍"】那样每重试一次档案里就多一句一模一样的问话，
// 用户翻历史时看见自己把同一件事讲了两遍。重试走 retry_of（失败那行的 id），
// 问题原文由服务端从库里那条用户行取。
//
// 【变异臂】
//  · M-F1 runTurn 外壳不落失败行（catch 里直接 rethrow）          ⇒「失败落行」整组红
//  · M-F2 失败行 content 传 null（只写 failed_code）              ⇒「content 非 NULL / 回显得到」红
//  · M-F3 失败轮照常记账（把 chargeTurn 提到模型调用之前）        ⇒「零记账」红
//  · M-F4 重试仍插一条新的用户消息（去掉 `if (retry === null)`）  ⇒「用户消息不重复」红
//  · M-F5 findRetryTarget 不校验 case_id                          ⇒「别人的失败轮重试不了」红
//  · M-F6 toHistory 不滤失败轮                                    ⇒「失败文案不进模型历史」红
//  · M-F7 外壳的 catch 不看 `progress.settled`                    ⇒「结清之后再抛不许改写」红
import { describe, expect, it } from 'vitest';
import type { Database } from 'better-sqlite3';

import { USER_FACING_COPY } from '@/lib/errors/user-facing';
import type { ChatStreamResult, Provider } from '@/lib/llm';
import { runTurn } from '../orchestrator';
import { fixtureSearcher, makeAgentFixture, makeSink, scriptedProvider, type AgentFixture } from './fixtures';

const ASK = '公司让我今天签自愿离职，说不签就走违纪，我该怎么办？';

/** 模型这会儿连不上：`chatStream` 一调就抛（连接失败 / 非 2xx / 流内错误都是这个形状） */
function brokenProvider(): Provider {
  return {
    name: 'deepseek',
    model: 'deepseek-v4-pro',
    billingModel: 'DeepSeek-V4-Pro-0813',
    async chatStream(): Promise<AsyncGenerator<string, ChatStreamResult, void>> {
      throw new Error('connect ECONNREFUSED 127.0.0.1:443 （DEEPSEEK_API_KEY 未配置）');
    },
  } as unknown as Provider;
}

async function turn(f: AgentFixture, opts: { provider?: Provider; retryOf?: number; message?: string } = {}) {
  const sink = makeSink();
  const result = await runTurn({
    db: f.db,
    caseId: f.caseId,
    userId: f.userId,
    message: opts.message ?? ASK,
    provider: opts.provider,
    retryOf: opts.retryOf,
    searcher: fixtureSearcher(),
    emit: sink.emit,
    now: new Date('2026-09-02T10:00:00Z'),
  });
  return { sink, result };
}

/** 这个案子在库里的样子：一行不多一行不少地数出来 */
function rowsOf(db: Database, caseId: number) {
  return db
    .prepare(
      `SELECT m.id, m.role, m.content, m.model, m.failed_code FROM messages m
         JOIN threads t ON t.id = m.thread_id
        WHERE t.case_id = ? ORDER BY m.id`,
    )
    .all(caseId) as {
    id: number;
    role: string;
    content: string | null;
    model: string | null;
    failed_code: string | null;
  }[];
}

function billing(f: AgentFixture) {
  const one = (sql: string, ...args: unknown[]) =>
    (f.db.prepare(sql).get(...(args as [])) as { n: number }).n;
  return {
    usage: one('SELECT COUNT(*) AS n FROM token_usage WHERE user_id = ?', f.userId),
    ledger: one("SELECT COUNT(*) AS n FROM gongdao_ledger WHERE user_id = ? AND type = '消耗'", f.userId),
  };
}

/* ── 〇、正对照：正常轮长什么样 ─────────────────────────────
   没有它，下面每一条"失败轮如何如何"都可能只是因为这条链根本没跑起来。 */

describe('正对照：一轮正常跑完', () => {
  it('两行（问 + 答），答那行 failed_code 为空，且照常记账', async () => {
    const f = makeAgentFixture();
    const { result } = await turn(f, { provider: scriptedProvider([{ text: '先别签。把通知拍照留存。' }]) });
    expect(result.ok).toBe(true);

    const rows = rowsOf(f.db, f.caseId);
    expect(rows.map((r) => r.role)).toEqual(['user', 'assistant']);
    expect(rows[1].failed_code, '正常轮不许被标成失败').toBeNull();
    expect(rows[1].content).toContain('先别签');
    expect(billing(f)).toEqual({ usage: 1, ledger: 1 });
  });
});

/* ── 一、失败落行 ────────────────────────────────────────── */

describe('★模型调用失败 ⇒ 库里多一条失败的 assistant 行', () => {
  it('占位行已落之后才断 ⇒ 就地回填成失败态，content 是三段式文案而不是 NULL', async () => {
    const f = makeAgentFixture();
    const { result, sink } = await turn(f, { provider: brokenProvider() });

    expect(result.ok, '失败不再靠抛异常表达，它现在是有结构的').toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.errorCode).toBe('AGENT_FAILED');

    const rows = rowsOf(f.db, f.caseId);
    expect(rows.map((r) => r.role), '一问一答两行，答那行是失败态').toEqual(['user', 'assistant']);
    expect(rows[1].failed_code).toBe('AGENT_FAILED');
    expect(rows[1].content, 'content 停在 NULL = 刷新后这一轮整个消失（F-203 原样复发）').not.toBeNull();
    expect(rows[1].content).toBe(USER_FACING_COPY.AGENT_FAILED);
    // 对照上面那条「缺 key」：这一支是**就地回填**，占位行那时已经带上型号了
    expect(rows[1].model).toBe('deepseek-v4-pro');
    // 失败行的 id 要交给调用方：前端点「重试」时靠它说出重试的是哪一轮
    expect(result.failedMessageId).toBe(rows[1].id);
    // 用户屏幕上的那句话与库里那句是同一句（刷新前后不该长得不一样）
    expect(result.message).toBe(USER_FACING_COPY.AGENT_FAILED);
    expect(sink.of('done'), '没跑完就没有收尾帧').toHaveLength(0);
  });

  it('★缺 key：占位行都还没落就抛 ⇒ 照样补插一整行（F-203 的真实现场）', async () => {
    // 不传 provider ⇒ 走真 getProvider ⇒ 降级链上的 key 全缺 ⇒ 在插占位行**之前**抛
    for (const name of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'DASHSCOPE_API_KEY', 'RELAY_API_KEY', 'RELAY_BASE_URL']) {
      delete process.env[name];
    }
    const f = makeAgentFixture();
    const { result } = await turn(f);

    expect(result.ok).toBe(false);
    const rows = rowsOf(f.db, f.caseId);
    expect(rows.map((r) => r.role), '此前这里只有用户那一行，屏幕上就是一句问题干晾着').toEqual([
      'user',
      'assistant',
    ]);
    expect(rows[1].failed_code).toBe('AGENT_FAILED');
    expect(rows[1].content).toBe(USER_FACING_COPY.AGENT_FAILED);
    // 【量具自证】走的确实是"补插"那一支而不是"就地回填"：占位行是带 model 的
    //（`insertMessage(..., model: routed.client.model)`），补插的那行没有型号可填。
    // 不钉这一句，这条用例在"其实还是回填"的实现上照样绿——那时 F-203 的真实现场并没修好。
    expect(rows[1].model, '这一支的前提是占位行还没落，所以它没有型号').toBeNull();
  });

  it('★失败轮零记账：token_usage 与 gongdao_ledger 一行都不许有', async () => {
    const f = makeAgentFixture();
    await turn(f, { provider: brokenProvider() });
    expect(billing(f), '没生成出东西就不该收钱').toEqual({ usage: 0, ledger: 0 });
  });

  it('对外文案里不许出现 key 名 / 主机 / 异常原文（它会渲染在当事人屏幕上）', async () => {
    const f = makeAgentFixture();
    const { result } = await turn(f, { provider: brokenProvider() });
    const shown = `${rowsOf(f.db, f.caseId)[1].content} ${result.ok ? '' : result.message}`;
    for (const leak of ['DEEPSEEK_API_KEY', 'ECONNREFUSED', '127.0.0.1']) {
      expect(shown, `内部实现漏到了用户屏幕上：${leak}`).not.toContain(leak);
    }
  });
});

describe('★故障注入：连"标记失败"这一步也写不进去', () => {
  /**
   * 落库失败不许换掉用户看到的那个错误。原始病因是"模型连不上"，
   * 把它变成"UNIQUE constraint failed…"就是让排障的人去追一个假线索，
   * 而真正断掉的那一环在日志里再也找不到。分层与唯一入口见 orchestrator 的 bestEffort。
   */
  it('标记失败自己抛了 ⇒ 用户拿到的仍是 AGENT_FAILED 那句三段式', async () => {
    const f = makeAgentFixture();
    f.db.exec(
      "CREATE TRIGGER fail_mark_broken BEFORE UPDATE ON messages " +
        "WHEN NEW.failed_code IS NOT NULL " +
        "BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END;",
    );
    const { result } = await turn(f, { provider: brokenProvider() });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.errorCode, '真病因被落库那一步的异常盖掉了').toBe('AGENT_FAILED');
    expect(result.message).toBe(USER_FACING_COPY.AGENT_FAILED);
    // 没落成行 ⇒ 也就没有可重试的那一行，别编一个 id 出来
    expect(result.failedMessageId).toBeUndefined();
    expect(billing(f)).toEqual({ usage: 0, ledger: 0 });
  });
});

describe('★结清之后再抛，不许回头把回答改写成失败', () => {
  /**
   * 变异臂 M-F7。这是"给失败留痕"这层外壳自己带来的风险：它包住的是**整轮**，
   * 而 `finalizeMessage` 之后还有一行 `chargeTurn`——记账的写库真会抛（磁盘满、
   * 锁超时）。不设闸的话，那一抛会把一条**已经生成、已经计过量**的回答就地改写成
   * 「这一轮没能生成回答」：用户眼睁睁看着刚拿到的答复变成一句失败文案，
   * 而且它再也找不回来了。宁可把异常原样交回上游（路由那层照旧报 AGENT_FAILED），
   * 也不许动那一行。
   */
  it('记账写库抛了 ⇒ 回答原样留着、不标失败，异常交回上游', async () => {
    const f = makeAgentFixture();
    f.db.exec(
      "CREATE TRIGGER charge_broken BEFORE INSERT ON token_usage " +
        "BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END;",
    );
    await expect(
      turn(f, { provider: scriptedProvider([{ text: '先别签。把通知拍照留存。' }]) }),
    ).rejects.toThrow(/disk is full/);

    const rows = rowsOf(f.db, f.caseId);
    expect(rows.map((r) => r.role)).toEqual(['user', 'assistant']);
    expect(rows[1].content, '已经生成出来的回答被改写成了失败文案').toContain('先别签');
    expect(rows[1].failed_code, '一条答出来了的回答不许被标成失败轮').toBeNull();
    // 记账那一笔整体回滚（两笔同事务），不是"用量记了、流水没记"的漏账
    expect(billing(f)).toEqual({ usage: 0, ledger: 0 });
  });
});

/* ── 二、失败轮进得了历史回显，进不了模型上下文 ─────────────── */

describe('失败轮的两个去处', () => {
  it('回显得到：listCaseMessages 取得出它（否则页面还是画不出横幅）', async () => {
    const f = makeAgentFixture();
    await turn(f, { provider: brokenProvider() });
    const shown = (await import('@/lib/db/agent')).listCaseMessages(f.db, f.caseId, 50);
    expect(shown.map((r) => r.role)).toEqual(['user', 'assistant']);
    expect(shown[1].failed_code).toBe('AGENT_FAILED');
  });

  /** 变异臂 M-F6 */
  it('★不进模型历史：下一轮的上下文里没有那段失败文案', async () => {
    const f = makeAgentFixture();
    await turn(f, { provider: brokenProvider() });

    const next = scriptedProvider([{ text: '我们接着说。' }]);
    await turn(f, { provider: next, message: '那我先别签，对吗？' });

    const context = next.calls[0].map((m) => `${m.role}:${m.content}`).join('\n');
    expect(context, '把"这一轮没能生成回答"当成模型说过的话重放，它会照着再来一遍').not.toContain(
      USER_FACING_COPY.AGENT_FAILED,
    );
    expect(context, '用户那句问话本身仍在历史里（丢的只是那条失败行）').toContain(ASK);
  });
});

/* ── 三、重试 ───────────────────────────────────────────── */

async function failedThenRetry(f: AgentFixture) {
  const first = await turn(f, { provider: brokenProvider() });
  if (first.result.ok) throw new Error('前提没成立：第一轮本该失败');
  const failedId = first.result.failedMessageId!;
  const good = scriptedProvider([{ text: '别签。先把通知要到手。' }]);
  const retried = await turn(f, { provider: good, retryOf: failedId, message: '' });
  return { failedId, good, retried };
}

describe('★重试 = 重发上一条用户消息', () => {
  /** 变异臂 M-F4：这是整条修法里最容易退化的一处 */
  it('重试成功 ⇒ 多一条 assistant 行，用户消息**不重复**', async () => {
    const f = makeAgentFixture();
    const { retried } = await failedThenRetry(f);
    expect(retried.result.ok).toBe(true);

    const rows = rowsOf(f.db, f.caseId);
    expect(rows.filter((r) => r.role === 'user'), '重试插了第二句一模一样的问话').toHaveLength(1);
    expect(rows.map((r) => r.role)).toEqual(['user', 'assistant', 'assistant']);
    // 失败那一行留在原地：这一轮确实失败过，抹掉它就是改历史
    expect(rows[1].failed_code).toBe('AGENT_FAILED');
    expect(rows[2].failed_code).toBeNull();
    expect(rows[2].content).toContain('别签');
    expect(billing(f), '重试成功这一轮照常记账（跑的是真模型）').toEqual({ usage: 1, ledger: 1 });
  });

  it('问题原文从库里取：客户端传什么都不影响重发的那一句', async () => {
    const f = makeAgentFixture();
    const { good } = await failedThenRetry(f);
    const sent = good.calls[0];
    expect(sent[sent.length - 1]).toEqual({ role: 'user', content: ASK });
  });

  it('重试的上下文里那句问话只出现一次（失败行与旧用户行都截掉了）', async () => {
    const f = makeAgentFixture();
    const { good } = await failedThenRetry(f);
    const context = good.calls[0].map((m) => m.content).join('\n');
    expect(context.split(ASK).length - 1, '同一个问题在上下文里出现了两次').toBe(1);
    expect(context).not.toContain(USER_FACING_COPY.AGENT_FAILED);
  });

  it('重试又失败 ⇒ 再落一条失败行，用户消息仍然只有一条', async () => {
    const f = makeAgentFixture();
    const first = await turn(f, { provider: brokenProvider() });
    if (first.result.ok) throw new Error('unreachable');
    const again = await turn(f, { provider: brokenProvider(), retryOf: first.result.failedMessageId, message: '' });
    expect(again.result.ok).toBe(false);

    const rows = rowsOf(f.db, f.caseId);
    expect(rows.filter((r) => r.role === 'user')).toHaveLength(1);
    expect(rows.filter((r) => r.failed_code === 'AGENT_FAILED')).toHaveLength(2);
    expect(billing(f)).toEqual({ usage: 0, ledger: 0 });
  });
});

describe('重试的归属与取值：拿不准就当不存在', () => {
  /** 变异臂 M-F5：消息主键全局自增，只按 id 取就能读到别人案子里的话 */
  it('★别人案子里的失败轮重试不了，且一个字都不带出来', async () => {
    const f = makeAgentFixture();
    const mine = await turn(f, { provider: brokenProvider() });
    if (mine.result.ok) throw new Error('unreachable');

    const sink = makeSink();
    const stolen = await runTurn({
      db: f.db,
      caseId: f.otherCaseId,
      userId: f.otherUserId,
      message: '',
      retryOf: mine.result.failedMessageId,
      provider: scriptedProvider([{ text: '不该走到这儿' }]),
      searcher: fixtureSearcher(),
      emit: sink.emit,
    });
    expect(stolen.ok).toBe(false);
    if (stolen.ok) throw new Error('unreachable');
    expect(stolen.errorCode).toBe('RETRY_TARGET_NOT_FOUND');
    expect(JSON.stringify(stolen)).not.toContain(ASK);
    // 别人的案子里不许因此长出任何行
    expect(rowsOf(f.db, f.otherCaseId)).toHaveLength(0);
  });

  it('retry_of 指向一条正常的回答（不是失败轮）⇒ 同样当不存在，不重跑', async () => {
    const f = makeAgentFixture();
    await turn(f, { provider: scriptedProvider([{ text: '正常答完了。' }]) });
    const okRow = rowsOf(f.db, f.caseId)[1];

    const { result } = await turn(f, { retryOf: okRow.id, message: '', provider: scriptedProvider([{ text: 'x' }]) });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.errorCode).toBe('RETRY_TARGET_NOT_FOUND');
    expect(rowsOf(f.db, f.caseId), '什么都不该多出来').toHaveLength(2);
  });
});
