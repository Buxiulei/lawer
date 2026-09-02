// app/src/lib/agent/__tests__/stream-sink-broken.test.ts
// 【下发断了，这一轮照样跑完、照样落库、照样记账】
//
// ─────────────── 这组补的是哪个缺口 ───────────────
// 真机事故（2026-09-02，naive-qa server2.log 实录）：用户读完回答后离开或刷新，
// SSE 的 controller 随之关闭，此后每一次 `controller.enqueue` 抛
// `TypeError: Invalid state: Controller is already closed`。服务端栈原文：
//
//     at ReadableStreamDefaultController.enqueue (node:internal/webstreams/readablestream)
//     at Object.emit …
//     at timeline_add …            ← 从工具里的 ctx.emit 抛出来
//     at runTurn …
//
// 于是**一个"给用户看"的故障掀翻了"记进档案"的整条链**，一次坏三样：
//   F-09 时间线写进去了，排在它后面的 action_card / deadline_set 再也没执行 → 行动卡恒空；
//   F-02 `finalizeMessage` 走不到 → assistant 行 content 停在 NULL，刷新后那一轮永久消失；
//   F-10 `chargeTurn` 走不到 → 账本一行不落（实测约七成轮次不记账）。
//
// 这三条是**同一个病因**，所以钉在同一个文件里：只要「下发」还能中断「落库」，
// 三条随时会一起复发。判据形状 = 给 runTurn 一个**会抛的 sink**（等价于 controller 已关），
// 断言库里该有的一样不少。
//
// 【变异臂】
//  · M-A orchestrator 里的 emit 不包一层（直接用 input.emit）⇒ 本文件几乎全红
//  · M-C 断开后跳过记账（chargeTurn 前加 `if (sinkBroken) return`）⇒ 「照样记账」那几条红
//  · M-D 把 finalizeMessage 挪到 done 帧之后 ⇒ 「done 之前正文已经在库里」那条红
import { describe, expect, it } from 'vitest';

import { runTurn } from '../orchestrator';
import type { AgentEvent } from '../events';
import { fixtureSearcher, makeAgentFixture, scriptedProvider, type AgentFixture, type ScriptedRound } from './fixtures';

const CARD = {
  name: 'action_card',
  args: {
    what: '今天 18 点前把解除通知邮件转发到个人邮箱',
    how: '打开公司邮箱 → 转发到私人邮箱并截图留存',
    why: '公司随时可能停你的邮箱权限，停了就取不出来了',
    due_at: '2026-08-19T18:00:00+08:00',
  },
};

const TIMELINE = {
  name: 'timeline_add',
  args: {
    happened_at: '2026-08-19T09:00:00+08:00',
    kind: '公司动作',
    title: 'HR 口头通知解除',
  },
};

const DEADLINE = { name: 'deadline_set', args: { rule: '仲裁时效', anchor_date: '2026-08-19' } };

/**
 * 剧本刻意把 timeline_add 排在最前面——真机栈里抛的就是它。
 * 排在它后面的 action_card / deadline_set 是这组的"证人"：
 * 只要它们的行还在，就说明工具循环没有被一次下发失败掀翻。
 */
const SCRIPT: ScriptedRound[] = [
  { text: '先把这件事记进档案。', tools: [TIMELINE, CARD, DEADLINE] },
  { text: '接下来按上面那张卡做。' },
];

/** 第 n 次下发开始抛（n 从 1 起）。n=Infinity 即"从不抛"，做正对照用。 */
function brokenSink(breakAt: number) {
  const seen: AgentEvent[] = [];
  let calls = 0;
  return {
    seen,
    get delivered() {
      return seen.length;
    },
    emit(e: AgentEvent) {
      calls += 1;
      if (calls >= breakAt) {
        // 与生产同形：Node webstreams 在 controller 关闭后抛的就是这个 TypeError
        throw new TypeError('Invalid state: Controller is already closed');
      }
      seen.push(e);
    },
  };
}

async function turn(sink: { emit: (e: AgentEvent) => void }, f: AgentFixture = makeAgentFixture()) {
  const result = await runTurn({
    db: f.db,
    caseId: f.caseId,
    userId: f.userId,
    message: '刚收到辞退邮件，说什么客观情况重大变化，我现在手都是抖的',
    provider: scriptedProvider(SCRIPT),
    searcher: fixtureSearcher(),
    emit: sink.emit,
    now: new Date('2026-08-19T12:40:00Z'),
  });
  return { f, result };
}

const one = <T>(f: AgentFixture, sql: string, ...args: unknown[]): T =>
  f.db.prepare(sql).get(...(args as [])) as T;

/** 这一轮在库里应该留下的全部痕迹。三处一起看——它们本来就是一起丢的。 */
function traces(f: AgentFixture) {
  return {
    assistant: one<{ content: string | null } | undefined>(
      f, "SELECT content FROM messages WHERE role = 'assistant' ORDER BY id DESC LIMIT 1",
    ),
    actions: one<{ n: number }>(f, 'SELECT COUNT(*) AS n FROM action_items WHERE case_id = ?', f.caseId).n,
    deadlines: one<{ n: number }>(f, 'SELECT COUNT(*) AS n FROM deadlines WHERE case_id = ?', f.caseId).n,
    timeline: one<{ n: number }>(f, 'SELECT COUNT(*) AS n FROM timeline_events WHERE case_id = ?', f.caseId).n,
    usage: one<{ n: number }>(f, 'SELECT COUNT(*) AS n FROM token_usage WHERE user_id = ?', f.userId).n,
    ledger: one<{ n: number }>(
      f, "SELECT COUNT(*) AS n FROM gongdao_ledger WHERE user_id = ? AND type = '消耗'", f.userId,
    ).n,
  };
}

describe('正对照：sink 好好的时候，这一轮到底该留下什么', () => {
  it('正文入库、三张工具产物齐、用量与消耗流水各一行', async () => {
    const { f, result } = await turn(brokenSink(Number.POSITIVE_INFINITY));
    expect('ok' in result && result.ok).toBe(true);

    const t = traces(f);
    expect(t.assistant?.content).toBe('先把这件事记进档案。接下来按上面那张卡做。');
    expect(t.timeline).toBeGreaterThanOrEqual(1);
    expect(t.actions).toBe(1);
    expect(t.deadlines).toBe(1);
    expect(t.usage).toBe(1);
    expect(t.ledger).toBe(1);
  });
});

describe('★下发中断（controller 已关）：跑完、落库、记账三样都不许少', () => {
  /**
   * 断点挑在**第一个 record 帧**上——也就是真机栈里 timeline_add 那一次。
   * 这是最坏也最真实的位置：时间线已经写进去了，用户档案里从此有一半的记录。
   */
  it('从 timeline_add 那一帧开始抛 ⇒ 后面的行动卡/期限照样落库', async () => {
    // meta(1) → delta 逐字… → record(timeline_add)。逐字 yield，故先数出真实序号。
    const probe = brokenSink(Number.POSITIVE_INFINITY);
    await turn(probe);
    const firstRecordAt = probe.seen.findIndex((e) => e.event === 'record') + 1;
    expect(firstRecordAt, '剧本必须真的产生 record 帧，否则这条是空跑').toBeGreaterThan(0);

    const { f, result } = await turn(brokenSink(firstRecordAt));

    // ① runTurn 不许把这个异常抛出去——route 的 catch 会把它变成一帧 AGENT_FAILED，
    //    而用户屏幕上那段回答明明已经读完了
    expect('ok' in result && result.ok, '下发失败被当成了整轮失败').toBe(true);

    const t = traces(f);
    // ② F-09：排在抛出点后面的工具照样执行
    expect(t.timeline, '时间线（抛出点之前）').toBeGreaterThanOrEqual(1);
    expect(t.actions, '行动卡：承诺了就必须真落库').toBe(1);
    expect(t.deadlines, '期限：同一条工具链上的第三件产物').toBe(1);
    // ③ F-02：正文回填，刷新之后还在
    expect(t.assistant?.content, '正文停在 NULL = 刷新即永久消失').toBe(
      '先把这件事记进档案。接下来按上面那张卡做。',
    );
    // ④ F-10：模型的钱已经花掉了，用户走开与记不记账无关
    expect(t.usage, 'token_usage').toBe(1);
    expect(t.ledger, 'gongdao_ledger 消耗流水').toBe(1);
  });

  it('第一帧（meta）就抛 ⇒ 一帧都没送出去，库里该有的照样一样不少', async () => {
    const { f, result } = await turn(brokenSink(1));
    expect('ok' in result && result.ok).toBe(true);

    const t = traces(f);
    expect(t.assistant?.content).toBe('先把这件事记进档案。接下来按上面那张卡做。');
    expect(t.actions).toBe(1);
    expect(t.deadlines).toBe(1);
    expect(t.usage).toBe(1);
    expect(t.ledger).toBe(1);
  });

  it('断一次就彻底停发：不会对着一条死连接把后面每一帧都再抛一遍', async () => {
    const sink = brokenSink(2);
    let thrown = 0;
    await turn({
      emit: (e) => {
        try {
          sink.emit(e);
        } catch (err) {
          thrown += 1;
          throw err;
        }
      },
    });
    expect(thrown, '连接已经没了，后面每一帧都再试一次只会刷屏并淹掉第一现场').toBe(1);
  });
});

describe('落库与收尾帧的先后：done 发出去的时候，正文必须已经在库里', () => {
  /**
   * 变异臂 M-D：把 finalizeMessage 挪到 done 之后 ⇒ 这条红。
   * done 是前端"这轮完了，可以刷新了"的信号；它比落库早一步，
   * 用户就有一个真实窗口能刷出一条空回答。
   */
  it('收到 done 帧的那一刻去查库，assistant 正文已经非 NULL', async () => {
    const f = makeAgentFixture();
    let contentAtDone: string | null | undefined = undefined;
    await turn(
      {
        emit: (e) => {
          if (e.event !== 'done') return;
          contentAtDone = (
            f.db
              .prepare("SELECT content FROM messages WHERE role = 'assistant' ORDER BY id DESC LIMIT 1")
              .get() as { content: string | null } | undefined
          )?.content;
        },
      },
      f,
    );
    expect(contentAtDone, 'done 帧发出时正文还没落库').toBe('先把这件事记进档案。接下来按上面那张卡做。');
  });
});
