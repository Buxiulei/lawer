// app/src/lib/agent/__tests__/action-card-promise.test.ts
// 【承诺 = 落库】F-09：回答里说了「行动卡已挂上」，档案里就必须真有卡；
// 真没有的时候，**必须有人当场说出来，且这句话要活过一次刷新**。
//
// ─────────────── 这组补的是哪个缺口 ───────────────
// 真机 staging 库实录（2026-09-02）：case 1 的一轮回答写着
//   「两张行动卡已挂上，系统会按截止时间提醒你。」
// 而该案 `action_items` 一张都没有（timeline_events 有 2 行——工具链本身是通的）。
// 那一轮**正常收尾**（content 非 NULL、记了账），所以它不是 F-02/F-10 那条下发中断的链，
// 是独立的第二条：模型把编号步骤写进正文就当卡挂上了，补救轮也没救回来。
//
// 唯一的信号 `ACTION_CARD_MISSING` 在前端映射表里是 `null`——**屏幕上一个字都不出**。
// 于是用户读到一句承诺、点开档案是空的、没有任何地方说过它失败了。这就是"静默"。
//
// 【为什么纠正要写进归档正文，而不是把那条 notice 改成可见】
// notice 是流帧，刷新即消失；那句骗人的承诺却是归档正文的一部分，永久留着。
// 纠正必须和它同寿命，否则 F5 之后又回到「正文承诺了、档案空的、没人解释」。
//
// 【变异臂】
//  · M-P1 去掉 orchestrator 的纠正段（actionCardMissing 分支）⇒ 「纠正进档案」那几条红
//  · M-P2 纠正只 emit 不进 text（不写 `text += correction`）⇒ 「活过刷新」那条红
//  · M-P3 executeTool 去掉 handler 的 try/catch（写路径断即掀翻整轮）⇒ 「写路径断」整组红
//  · M-P4 prompt 去掉「卡只能由 action_card 产出」那几行 ⇒ 「话术不得承诺」那条红
import { describe, expect, it } from 'vitest';

import { runTurn } from '../orchestrator';
import { fixtureSearcher, makeAgentFixture, makeSink, scriptedProvider, type AgentFixture, type ScriptedRound } from './fixtures';

const GOOD_CARD = {
  name: 'action_card',
  args: {
    what: '今天 18 点前把解除通知邮件转发到个人邮箱',
    how: '打开公司邮箱 → 转发到私人邮箱并截图留存',
    why: '公司随时可能停你的邮箱权限，停了就取不出来了',
    due_at: '2026-08-19T18:00:00+08:00',
  },
};

/** 真机那一轮的原话。承诺写死在这里，是为了让"承诺"这件事本身可断言。 */
const PROMISE = '两张行动卡已挂上，系统会按截止时间提醒你。';

/** 纠正段里必须出现的那句实话（orchestrator 的确定性文案）。 */
const CORRECTION = '这一轮我没能把行动卡挂进你的档案';

async function turn(script: ScriptedRound[], f: AgentFixture = makeAgentFixture()) {
  const sink = makeSink();
  const provider = scriptedProvider(script);
  const result = await runTurn({
    db: f.db,
    caseId: f.caseId,
    userId: f.userId,
    message: 'HR 让我三天内签自愿离职协议，我该不该签？',
    provider,
    searcher: fixtureSearcher(),
    emit: sink.emit,
    now: new Date('2026-08-19T12:40:00Z'),
  });
  return { f, sink, provider, result };
}

/** 这一轮在库里留下的痕迹。 */
function traces(f: AgentFixture) {
  const one = <T>(sql: string, ...args: unknown[]): T => f.db.prepare(sql).get(...(args as [])) as T;
  return {
    content: one<{ content: string | null } | undefined>(
      "SELECT content FROM messages WHERE role = 'assistant' ORDER BY id DESC LIMIT 1",
    )?.content,
    actions: one<{ n: number }>('SELECT COUNT(*) AS n FROM action_items WHERE case_id = ?', f.caseId).n,
    usage: one<{ n: number }>('SELECT COUNT(*) AS n FROM token_usage WHERE user_id = ?', f.userId).n,
    ledger: one<{ n: number }>(
      "SELECT COUNT(*) AS n FROM gongdao_ledger WHERE user_id = ? AND type = '消耗'", f.userId,
    ).n,
  };
}

describe('正对照：卡真挂上了，就不该有纠正段', () => {
  it('action_card 成功 ⇒ 库里 1 张卡，归档正文里没有那句"没能挂上"', async () => {
    const { f, result } = await turn([{ text: '先把最急的一件事做掉。', tools: [GOOD_CARD] }]);
    expect('ok' in result && result.ok).toBe(true);

    const t = traces(f);
    expect(t.actions, '卡该落库').toBe(1);
    expect(t.content).toContain('先把最急的一件事做掉。');
    expect(t.content, '卡挂上了却还道歉，等于自己制造噪音').not.toContain(CORRECTION);
  });
});

describe('★承诺了却没有卡：纠正必须进归档正文（活过一次 F5）', () => {
  /**
   * 与真机同形：模型把编号步骤写进正文、宣称卡已挂上，**一次 action_card 都没调**。
   * 补救轮（剧本已用完 → 空 stop 轮）同样没有卡，于是 actionCardMissing 成立。
   */
  it('模型只在正文里承诺、从没调工具 ⇒ 库里 0 张卡，但归档正文带上了纠正', async () => {
    const { f, sink, result } = await turn([{ text: `先落档。${PROMISE}` }]);
    expect('ok' in result && result.ok).toBe(true);

    const t = traces(f);
    expect(t.actions, '这一轮确实一张卡都没有——这正是要被说出来的事实').toBe(0);

    // ① 承诺仍原样留在档案里（它已经逐字流给用户了，事后抹掉就成了另一种不一致）
    expect(t.content, '承诺不该被偷偷删掉').toContain(PROMISE);
    // ② ★纠正与它同在归档正文里 —— 刷新之后用户还看得到这句实话
    expect(t.content, '纠正只发了流帧没进库 = F5 之后又回到"承诺了、档案空的、没人解释"').toContain(CORRECTION);
    // ③ 直播那一侧同样看得到（同一段文案，两条通道）
    expect(sink.text).toContain(CORRECTION);
    // ④ 纠正排在正文之后，不许插进正文中间
    expect(t.content!.indexOf(CORRECTION)).toBeGreaterThan(t.content!.indexOf(PROMISE));
    // ⑤ 给出路，不是只报错（自述错误三段式的第三段）
    expect(t.content).toContain('记进档案');
  });

  it('ACTION_CARD_MISSING 这条运维信号照旧发（前端静默，但服务端要能查）', async () => {
    const { sink } = await turn([{ text: `先落档。${PROMISE}` }]);
    expect(sink.of('notice').map((e) => e.data.code)).toContain('ACTION_CARD_MISSING');
  });
});

describe('★写路径断了：这一轮照样跑完、照样落库记账，且失败可见', () => {
  /**
   * 故障注入 = 只把**写**这一侧打断（BEFORE INSERT 触发器 RAISE(ABORT)），
   * 让 `store.insertActionItem` 真的抛一个 SqliteError。
   *
   * 【为什么不是 DROP TABLE】那样连**读**也一起断了：`loadCaseSnapshot` 在
   * tool-loop 开跑之前就要 `listActionItems`，于是异常落在编排开头，
   * 测的根本不是"工具写库失败"这条路——判据看着红，量的却是另一段（先审量具再信读数）。
   *
   * 触发器只拦 INSERT，读照常，故障点精确落在 action_card 句柄里那一行 insert 上，
   * 与生产同形：约束冲突、库被锁、磁盘满，走的都是这条"句柄自己抛"的路。
   *
   * 变异臂 M-P3：executeTool 去掉 handler 的 try/catch ⇒ 异常穿出 tool-loop、
   * runTurn 抛、正文停在 NULL、这一轮不记账——本组三条一起红。
   */
  function fixtureWithBrokenActionWrite(): AgentFixture {
    const f = makeAgentFixture();
    f.db.exec(
      "CREATE TRIGGER action_items_write_broken BEFORE INSERT ON action_items " +
        "BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END;",
    );
    return f;
  }

  it('action_card 落库抛异常 ⇒ runTurn 不抛，正文照样回填、账照样记', async () => {
    const { f, result } = await turn(
      [{ text: '先把最急的一件事做掉。', tools: [GOOD_CARD] }],
      fixtureWithBrokenActionWrite(),
    );

    expect('ok' in result && result.ok, '一次写库失败把整轮弄丢了').toBe(true);
    const t = traces(f);
    expect(t.content, '正文停在 NULL = 刷新即永久消失').toContain('先把最急的一件事做掉。');
    expect(t.usage, 'token_usage：模型的钱已经花掉了').toBe(1);
    expect(t.ledger, 'gongdao_ledger 消耗流水').toBe(1);
  });

  it('失败不静默：模型收到的回喂说明"没写进档案"，并明说别原样重试', async () => {
    const { provider } = await turn(
      [{ text: '先把最急的一件事做掉。', tools: [GOOD_CARD] }],
      fixtureWithBrokenActionWrite(),
    );

    // 回喂给模型的 tool 结果里必须写清失败，否则它会继续以为卡挂上了
    const toolReplies = provider.calls.flat().filter((m) => m.role === 'tool').map((m) => m.content);
    const failed = toolReplies.filter((c) => c.includes('没有写进档案'));
    expect(failed.length, '写库失败被咽掉了，模型完全不知情').toBeGreaterThan(0);
    expect(failed[0]).toContain('action_card');
    expect(failed[0], '写库坏了还劝模型重试，只会白烧几轮 token').toContain('不要重复调用');
  });

  it('写路径断 + 没有卡 ⇒ 归档正文同样带上纠正（用户侧不留空白）', async () => {
    const { f } = await turn(
      [{ text: `先把最急的一件事做掉。${PROMISE}`, tools: [GOOD_CARD] }],
      fixtureWithBrokenActionWrite(),
    );
    expect(traces(f).content).toContain(CORRECTION);
  });
});

describe('话术纪律：提示词明写"卡只能由工具产出"', () => {
  it('系统提示里禁止在正文里宣称卡已挂上', async () => {
    const { provider } = await turn([{ text: '好的。', tools: [GOOD_CARD] }]);
    const system = provider.calls[0][0].content;

    expect(system).toContain('卡只能由 action_card 产出');
    expect(system).toContain('已记进档案');
    // 「正文里列编号步骤 ≠ 挂了卡」——真机那一轮正是这么混过去的
    expect(system).toContain('不等于');
  });
});
