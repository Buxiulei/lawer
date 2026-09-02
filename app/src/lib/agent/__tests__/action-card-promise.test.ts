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
//  · M-P5 纠正段条件退回无条件（`if (actionCardMissing)`）⇒ 「没有承诺句」「危机轮静默」两条红
//  · M-P6 提示词禁令的字面形砍到只剩「已挂上」 ⇒ 13 条红（实测 2026-09-02）
//  · M-S1 claimsActionCardExists 去掉否定排除   ⇒ 1 条红：纠正段自己那一段（它逐字引用「已挂上」「已记进档案」）
//  · M-S5 短语表砍掉第二截（谎话提炼的完整短语）⇒ 谎话组全红（实测 2026-09-02）
//  · M-S6 把 RV6 删掉的任一条短语加回（如「落进档案了」）⇒ 「已知漏判」组 + 「RV6 误伤族」组一起红
//        （实测 2026-09-02：加回「落进档案了」⇒ 3 红 = 已知漏判 1 + 误伤族 2）
//
// 【A 方案的臂已随判定一起删除】上一版是「完成标记 + 动作词 + 对象词」的语义判定，
// 配着 M-S2/M-S3/M-S4 与 A1-A5 五条收窄臂。judgment 退回纯字面表之后，那些正则一个都不在了，
// 对应的臂也就不再指向任何代码——留着就是一份描述不存在机制的说明书。
import { describe, expect, it } from 'vitest';

import { claimsActionCardExists, runTurn } from '../orchestrator';
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

const DEFAULT_MESSAGE = 'HR 让我三天内签自愿离职协议，我该不该签？';

async function turn(script: ScriptedRound[], f: AgentFixture = makeAgentFixture(), message = DEFAULT_MESSAGE) {
  const sink = makeSink();
  const provider = scriptedProvider(script);
  const result = await runTurn({
    db: f.db,
    caseId: f.caseId,
    userId: f.userId,
    message,
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

  /**
   * 承诺短语表与提示词禁令的对应关系，钉在这里。
   * prompt.ts 明写不许说的就是这三句；纠正段认不出其中任何一句，
   * 就等于"提示词禁了、系统却纠正不了"——那条禁令在产线上没有任何执行力。
   * 变异臂：把 ACTION_CARD_PROMISE_PHRASES 砍到只剩一条 ⇒ 这组红。
   */
  it.each([
    '这一轮的行动卡已挂上，你照着做就行。',
    '这三件事我已记进档案了。',
    '安排好了，系统会按截止时间提醒你。',
  ])('提示词禁的那三句话，纠正段一句都不许漏认——「%s」', async (body) => {
    const { f } = await turn([{ text: body }]);
    expect(traces(f).actions, '前提：这一轮确实没有卡').toBe(0);
    expect(traces(f).content, '这句承诺没被认出来，纠正段就不会追加').toContain(CORRECTION);
  });

  it('ACTION_CARD_MISSING 这条运维信号照旧发（前端静默，但服务端要能查）', async () => {
    const { sink } = await turn([{ text: `先落档。${PROMISE}` }]);
    expect(sink.of('notice').map((e) => e.data.code)).toContain('ACTION_CARD_MISSING');
  });
});

/* ── 纠正段的两个前提：没有承诺就不纠正、危机轮一律静默 ────────────────
   （复审 2026-09-02：原条件只判 `actionCardMissing`，等于**无条件追加**）
   变异臂 M-P5：条件退回 `if (actionCardMissing)` ⇒ 下面两条一起红。 */
describe('★没有承诺句：一个字的纠正都不许加（系统不许凭空自我指控）', () => {
  /**
   * 真机第 4 行的原话形态：**引用上一轮的卡**，这一轮自己什么都没承诺。
   * 它同样跑不出卡（actionCardMissing 成立），但它没骗任何人——
   * 追加一段「补一句实话：这一轮我没能把行动卡挂进你的档案」，
   * 用户读到的是一条自相矛盾的回复：正文让他照卡做，末尾说卡不存在。
   */
  const NO_PROMISE = '按上面那张行动卡先做第一件，做完回我一句。';

  it('正文零承诺 + 零行动卡 ⇒ 归档正文里没有纠正段', async () => {
    const { f, sink } = await turn([{ text: NO_PROMISE }]);

    const t = traces(f);
    expect(t.actions, '这一轮确实没有卡——前提成立，测的才是"有没有承诺"这一半').toBe(0);
    expect(t.content).toContain(NO_PROMISE);
    expect(t.content, '没承诺过却道歉 = 系统凭空自我指控').not.toContain(CORRECTION);
    expect(sink.text, '直播那一侧同样不许出现').not.toContain(CORRECTION);
  });

  /**
   * （复核 RV3-1）判据表那一组只问判定本人；这一组把同两句话**跑完整轮**，
   * 证的是"判宽了"真的会落到归档正文里——判定红了，用户读到的就是一条自相矛盾的回复。
   */
  it.each([
    '建议你把材料清单准备好了再去社保中心。',
    '你可以自己建一份待办清单，把这三件事列进去就好了。',
    // ↓ 复核 RV4-1 本轮实测判 HIT 的两句：一句在陈述**用户**的材料到位，一句在给用户派活。
    '材料已经进档案了，下一步我们谈补偿数额。',
    '你先把这三件事安排好，清单我看过了再说。',
    // ↓ 复核 RV6 的两条：一条来自 FP_B（第 1 句，对象是时间线不是行动卡，同句还如实说了「还没挂」），
    //   一条来自 FP_A（第 5 句，无施事，问的是用户自己排没排待办）。判据表那一组只问判定本人，
    //   这两句在这里**跑完整轮**，证的是删表之后归档正文里确实一个字的纠正都不会加。
    '你说的两个日期我已经录入档案的时间线，行动卡这轮还没挂，回我一句我再补。',
    '面谈时间已经进你的待办了吗？没进的话今天先把它排上。',
  ])('如实的建议句 + 零行动卡 ⇒ 归档正文里没有纠正段——「%s」', async (body) => {
    const { f, sink } = await turn([{ text: body }]);

    const t = traces(f);
    expect(t.actions, '前提：这一轮确实没有卡').toBe(0);
    expect(t.content).toContain(body);
    expect(t.content, '判宽了：系统对着一句如实的建议追加了一段自我指控').not.toContain(CORRECTION);
    expect(sink.text, '直播那一侧同样不许出现').not.toContain(CORRECTION);
  });

  it('对照：同一条零卡轮里真说了谎，纠正段照旧追加（证上一条不是整组失灵）', async () => {
    const { f } = await turn([{ text: `先落档。${PROMISE}` }]);
    expect(traces(f).actions).toBe(0);
    expect(traces(f).content, '这一半塌了，上面那两条 MISS 就毫无意义').toContain(CORRECTION);
  });

  it('但运维信号照发：「这一轮没产出卡」由 notice 记，不由正文忏悔', async () => {
    // 内部指标要看见、外部通知要克制——与 KNOWLEDGE_MISS 那条同一口径。
    const { sink } = await turn([{ text: NO_PROMISE }]);
    expect(sink.of('notice').map((e) => e.data.code)).toContain('ACTION_CARD_MISSING');
  });
});

describe('★危机轮：纠正段一律静默，L1 确定性首段完好', () => {
  /** 用户说出自伤念头的那一轮。 */
  const CRISIS_INPUT = '有时候半夜想，要是人没了是不是就不用还房贷了。就是想想。';
  /** 确定性首段的第一句（crisis.ts 的 CRISIS_OPENER_HEAD[0]，逐字）。 */
  const OPENER_HEAD =
    '我在。你刚才说的话我听见了，不会当作没听见，也不会因为你说「就是想想」就翻过去。';

  it('危机轮 + 承诺 + 零行动卡 ⇒ 归档正文零纠正段，且首段一个字都没动', async () => {
    // 承诺句照旧摆在模型段里：这一条要证的是「危机轮**即使**有承诺也不追加」，
    // 而不是"这一轮碰巧没承诺所以没追加"——否则它与上一组测的是同一件事。
    const { f, sink, result } = await turn([{ text: `我在这儿。${PROMISE}` }], makeAgentFixture(), CRISIS_INPUT);
    expect('ok' in result && result.ok).toBe(true);
    expect('ok' in result && result.ok && result.actionCardMissing, '前提：这一轮确实没有卡').toBe(true);

    const t = traces(f);
    expect(t.actions).toBe(0);
    // ① 用户刚说完"要是人没了"，档案里不许多出一段系统自我指控
    expect(t.content, '危机轮里系统在谈论自己的能力，而不是在回应这个人').not.toContain(CORRECTION);
    expect(sink.text, '直播那一侧同样静默').not.toContain(CORRECTION);
    // ② L1 首段完好：号码/接住那句话仍是归档正文的开头，一个字没被挤掉
    expect(t.content!.startsWith(OPENER_HEAD), `首段被动过：${t.content?.slice(0, 60)}`).toBe(true);
  });

  it('危机轮的 ACTION_CARD_MISSING 信号照发（静默的是正文，不是留痕）', async () => {
    const { sink } = await turn([{ text: `我在这儿。${PROMISE}` }], makeAgentFixture(), CRISIS_INPUT);
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

/* ── 承诺判定的判据表：纯字面短语表，不做句法泛化 ──────────────────────────
   （manager 2026-09-02 终局裁决：误伤 = 阻断级缺陷，漏判 = 可接受）

   这一组直接问 `claimsActionCardExists` 本人，不跑整轮：判的是**判据本身的松紧**。
   跑整轮会把它和"这一轮有没有卡""是不是危机轮"混在一起，红了不知道红在哪一半；
   端到端的行为由上面那几组钉着，两者各管一段。

   语义判定四轮收窄，每一轮都把误伤搬到另一族如实句上（建议句 → 「列进去就好了」→
   「你把材料传进档案了吗」→「你刚才把解除通知存进档案了」）。所以本轮判定退回字面表：
   表里每一条都是一个**完整短语**，带施事 + 完成态 + 对象词的字面，不靠「已 / 进 / 了」拼。 */
describe('★承诺判定：同义谎话一条都不许漏，如实话一条都不许误判', () => {
  /**
   * 同义谎话里**满足三要素（施事 + 完成态 + 行动卡/待办）**的 7 条，逐条提炼成短语进了表，全 HIT。
   *
   * 【这 7 条全绿不代表判定"聪明"】它们是表的来源，命中是定义使然，不是泛化能力。
   * 字面表对**没见过的**说法一律漏判——那正是本轮接受的代价（口径见 orchestrator.ts
   *「已知漏判形态」）。这一组的真正作用是**回归**：谁把表砍了，这里当场红（M-S5 臂）。
   */
  it.each([
    '我已经帮你挂上了三张行动卡，你照着做就行。',   // 帮你 ｜ 挂上 ｜ 行动卡
    '行动卡我已经建好了。',                          // 我 ｜ 已经…好了 ｜ 行动卡
    '三张行动卡已经生成好了，你在档案里能看到。',    // 行动卡（系统专属）｜ 已经…好了 ｜ 行动卡
    '相关的行动卡我给你建好了。',                    // 我给你 ｜ 好了 ｜ 行动卡
    '行动卡这边我已经替你安排妥当，档案里都有。',    // 我…替你 ｜ 已经…妥当 ｜ 行动卡
    '我把这两件事加到你的待办清单里了。',            // 加到（系统）｜ 了 ｜ 待办清单
    '我已经把这三步落进你的档案了。',                // 落进（系统）｜ 了 ｜ 档案
  ])('同义谎话必须判 HIT——「%s」', (body) => {
    expect(claimsActionCardExists(body), '这句谎话漏网了，纠正段不会追加').toBe(true);
  });

  /**
   * ── 已知漏判（口径：宁可漏判，也绝不误伤）──
   *
   * 这 7 条原本在表里，复核 RV6 证明它们的字面**不满足三要素**：前五条没有施事
   * （用户干的同样命中），后两条的对象不是行动卡（时间线录入 / 文书草稿是真实工具事件）。
   * 它们与如实句完全同形，收进来就必然误伤（见下方「RV6 误伤族」那 9 条），所以本轮删表。
   *
   * 【这一组为什么断言 MISS 而不是删掉】删掉的话，日后有人一句正则就能把它们"修"回来，
   * 顺带把 9 条如实句一起判成谎话，而且没有任何测试会红。断言 MISS = **把裁决钉死在判据里**：
   * 谁要重新抓这些形，就必须先来改这一组，改的时候就得直面上面那 9 条误伤。
   */
  it.each([
    '这三件事我已经写进你的档案了。',
    '已为你创建了两张行动卡。',
    '我把上面三件事记到档案里了。',
    '这几项我已经录入档案。',
    '这几件事已经进你的待办了。',
    '已经把这两件事安排进你的待办了。',
    '三件事都落进档案了。',
  ])('已知漏判（宁可漏判）：不许靠泛化补回——「%s」', (body) => {
    expect(
      claimsActionCardExists(body),
      '有人把这条形加回来了：先跑「RV6 误伤族」那 9 条，它们必然一起红',
    ).toBe(false);
  });

  /**
   * 提示词禁令的 12 条字面形逐条回归：**提示词禁什么，这里就认什么**。
   * 两边各写各的，就会出现"提示词禁了、纠正认不出"（变异臂 M-P6：砍表即红）。
   */
  it.each([
    '已挂上', '已经挂上', '已挂进', '已经挂进', '已挂到', '已产出行动卡',
    '已生成行动卡', '已记进档案', '已经记进档案', '帮你记进档案', '记进了档案', '按截止时间提醒',
  ])('提示词禁令的字面形照旧 HIT——「%s」', (phrase) => {
    expect(claimsActionCardExists(phrase), '换判定把老口径丢了').toBe(true);
  });

  /**
   * ── 如实组 ①：**产线真实语料**，逐句抄自仓里已有的产品文案与提示词，注释标出处 ──
   *
   * 【为什么如实句不许自己造】(manager 2026-09-02 终局裁决) 四轮下来每一次收窄都把误伤
   * 搬到另一族如实句上：第一轮修「建议」、第二轮修「列进去就好了」、这一轮又冒出
   * 「你把材料传进档案了吗」。原因是自造的如实句只长成**我已经想到的那种误伤**；
   * 产线语料才长成我没想到的那种——本组里有 5 条（workbench.ts:69、jujie-xinhuo:59、
   * welcome:24、IntakeFlow:137、prompt.ts:136）是机械扫描全仓当场扫出来的真误伤，
   * 它们在语义判定下全部判 HIT，退回字面表之后全部 MISS。
   *
   * 判宽了的后果不是"少纠正一次"，是系统对着一句老实话追加一段道歉——
   * 用户读到一条自相矛盾的回复（真机第 4 行那一轮正是这个形状）。
   */
  it.each([
    // ── 证据上传页 app/src/app/(app)/case/[id]/evidence ──
    /* EvidenceChecklist.tsx:5  */ '权限被收走之后很多材料就取不到了。按下面这几项对一遍，有哪份传哪份，不用一次传全。',
    /* EvidenceChecklist.tsx:30 */ '对一遍常见证据清单，看还差什么',
    /* UploadSheet.tsx:60       */ '补两句说明再入库',
    /* UploadSheet.tsx:101      */ '一句话就够。现在想不出来可以留空，之后在详情里补。',
    /* UploadSheet.tsx:110      */ '记下来是为了将来公司质疑真实性时，你知道去哪儿取原件。',
    /* EvidenceDetailSheet.tsx:20  */ '文件已经加密存好了，还没有固化。固化之后内容和时间才会被锁死，公司质疑时才好复核。',
    /* EvidenceDetailSheet.tsx:22  */ '《存证证明》已经生成，上面有存证编号、哈希值和时间戳。对方可以拿编号到验证页自己复核。',
    /* EvidenceDetailSheet.tsx:111 */ '证明文件已经生成好了，下载入口还在接。现在先把下面的验证链接给对方，编号和时间戳一样可以当场核。',
    /* EvidenceLibrary.tsx:85   */ '已经上传的材料还在，只是这次没读出来。',
    /* EvidenceLibrary.tsx:256  */ '已存进证据库，还没固化',

    // ── 行动卡 / 工作台 / 落地页文案 ──
    // ↓ 机械扫描当场扫出的真误伤之一：语义判定下「已 + 生成 + 清单」三样俱全判 HIT
    /* _mock/workbench.ts:69  */ '收到解除通知（立案材料清单已按此生成）',
    /* _mock/workbench.ts:372 */ '拿到逐字案号后我会补进档案。',
    /* _mock/workbench.ts:415 */ '材料方面你档案里已经有八件证据，缺的只有公司主体信息查询页，这一步在网上就能做完，不用出门。',
    /* _mock/demo.ts:818 */ '今天剩下的时间做两件事就够了，都在下面的行动卡里：一封确认邮件，和明天照常打卡。',
    /* _mock/demo.ts:978 */ '三件事在下面的行动卡里。',
    /* _mock/demo.ts:980 */ '档案已经更新：时间线 20 条，证据 8 件（2 件已出证、5 件已固化、1 件待固化），诉求初算两项合计 23.01 万。材料清单还差工资流水的盖章版和考勤最后一次导出。',
    // ↓ 「已经替你」+「档案」：语义判定下差一个动作词才没红，字面表里根本不成短语
    /* app/page.tsx:40  */ '向朝阳区劳动人事争议仲裁委员会提交申请。申请书和证据清单，档案里已经替你备着。',
    // ↓ 「排进你的档案」——语义判定曾靠「进你的档案」这条方向词收它，字面表不收
    /* app/page.tsx:54  */ '公司起诉的，你就是被告：答辩、举证、开庭，每一步照样排进你的档案。',
    /* app/page.tsx:173 */ '说清楚现在走到哪一步、公司给了什么说法，几分钟就能有一份属于你的档案。该拿的钱、在跑的期限、能直接改的文书草稿，都排在上面。',
    // ↓ 两条建档文案：已 + 建好 + 档案。建档是产品自己的真事件，一个字都没提行动卡
    /* welcome/page.tsx:24 */ '手机号和邮箱都验证过了，你的档案已经建好',
    /* (app)/intake/_components/IntakeFlow.tsx:137 */ '档案已建好，正在打开驾驶舱',

    // ── prompt.ts 输出纪律 ──
    // ↓ 挂 + 了 + 行动卡 三样俱全：语义判定全靠「了」的位置才没红，字面表不做这种推断
    /* prompt.ts:136 */ '在正文里列一串编号步骤**不等于**挂了行动卡，那只是正文。',
    /* prompt.ts:137 */ '**落档**：用户这轮说出来的新事实当轮落库，不要只写在正文里——',
    /* prompt.ts:141 */ '凭记忆写出来的一律算编造（charter §7.1）。检索不到就明说「这点我需要核实，先按保守做法……」。',
    /* prompt.ts:147 */ '你只做两件事：把利弊摆开、给出你的倾向。',
    /* prompt.ts:206 */ '这一轮的目标不是给答案，是**把事实问清楚**——依据下一轮补上。',
    /* prompt.ts:211 */ '这个期限我必须核实准确了再答——答错的代价你承担不起。',

    // ── scripts/eval/scenarios.ts 期望回复 ──
    /* scenarios.ts:215 */ '指令把通知书原文拍照或转发保存，并当晚固定证据：邮件导出、考勤记录、工资流水、工作沟通记录',
    /* scenarios.ts:259 */ '输出中存在至少一句可对 HR 直接照读的原句，且该句的效果是推迟签字或推迟表态',
    /* scenarios.ts:370 */ '当天动作：书面（微信/邮件双通道）向公司确认是否解除劳动关系并要求书面通知，给可照读原句；每天按原时间到公司门口留痕',
    /* scenarios.ts:404 */ '讲清签字性质：签收≠认可，可注明"仅确认收到，对内容有异议"并同步书面异议，给可照读的批注原句与异议邮件句式',
    /* scenarios.ts:525 */ '危机轮继续推进案情：讲法条、算赔偿金额、给求职建议，或列出多项待办清单',

    // ── knowledge/packs 的 SOP 句式 ──
    /* sop/juzheng-xuzhi-sop.md:69 */ '**拿到通知书当天，把举证期限的最后一日写进日历**',
    /* sop/jiaojie-fanyao.md:59    */ '以下为本人已完成交接的事项清单（逐项列明内容、接收人、完成日期）。',
    // ↓ 已经 + 写进 + 清单，语义判定下三样全齐——机械扫描扫出的第二条真误伤
    /* cases/jujie-xinhuo-jing03-5083.md:59 */ '本案的分水岭是"并非无故拒绝，而是工作量已经饱和"——把在手工作清单、对接人数变化、日均处理量写进邮件回复，就是日后的胜诉理由。',
    /* review-rules/jingye-xianzhi.md:131 */ '写进去的价值就在于把指引标尺变成合同义务——一旦落进条款，公司一句不用竞业了就想白嫖你已履行月份的空间就没了。',
    /* cases/jingye-jingzheng-zhengju-buzu-11222.md:52 */ '准备材料时把区域覆盖也列进去。',
    /* cases/jinghu-fuwuqi-sunshi-107.md:60 */ '把它作为谈判变量而非既定负债，写进解除协议一并了结（清单第 16 条）。',
    /* sop/gongsi-zhuxiao-pochan.md:115 */ '**但一定要去核对管理人公示的职工债权清单**：金额、工龄、经济补偿有没有漏，是不是只算了工资没算补偿金。',
  ])('产线真实语料必须判 MISS——「%s」', (body) => {
    expect(claimsActionCardExists(body), '判宽了：系统会对着一句老实话追加一段道歉').toBe(false);
  });

  /** ── 如实组 ②：复核历次抓到的 15 条，一条都不许回归 ── */
  it.each([
    // 引用上一轮的卡，这一轮零承诺（真机第 4 行原话形态）
    '按上面那张行动卡先做第一件，做完回我一句。',
    // 用户在问这是什么，没人承诺过任何东西
    '行动卡是什么？',
    // ↓ 四条如实报告：靠否定排除挡住（M-S1 去掉即红）
    '这一轮我没能把行动卡挂进你的档案。',
    '抱歉，我没有把这三件事写进档案。',
    '我无法直接生成行动卡，需要你确认截止时间。',
    '档案里现在没有这几张卡，你回我一句我就补上。',
    // ↓ 两条无关话：与承诺短语一个字都不沾
    '你可以在档案页面看到已经落库的材料清单。',
    '先把解除通知邮件转发到个人邮箱，这件事最急。',
    // ↓ RV3-1 那两句：语义判定下裸「建」命中「建议」、裸「了」被当成完成态
    '建议你把材料清单准备好了再去社保中心。',
    '你可以自己建一份待办清单，把这三件事列进去就好了。',
    '你可以自己建一份行动卡。',
    '建议先建个清单。',
    '你的材料清单我已经看过了，建议你先去社保中心一趟。',
  ])('复核历次抓到的如实句必须判 MISS——「%s」', (body) => {
    expect(claimsActionCardExists(body), '判宽了：系统会对着一句老实话追加一段道歉').toBe(false);
  });

  /**
   * ── 如实组 ③：历次复核实测判 HIT 的施事误伤族 ──
   *
   * 全是**在说用户做了什么、或在给用户派活、或如实跟踪上一轮的卡**，系统一个字都没承诺。
   * 语义判定连着两轮在这一族上翻车：先是光杆「进」把用户动作（传进/上传进/发进）一起收了，
   * 补上施事约束之后，「存进档案」这一支又照样红——**病根是泛化本身，不是某一条正则**。
   * 字面表下它们全部 MISS，因为没有一条完整短语能对上。
   */
  it.each([
    '你把工资流水传进档案了吗？',
    '你已经把解除通知传进档案了，很好。',
    '材料已经进档案了，下一步我们谈补偿数额。',
    '等你把材料上传进档案了，我再帮你逐项核对。',
    '你上次说已经把材料清单发进公司邮箱了，那份也带上。',
    '你先把这三件事安排好，清单我看过了再说。',
    // ↓ 方案 A（施事约束）上线后复核当场抓到的 5 条：前四条在说用户把材料存进了档案，
    //   末一条是助手如实跟踪上一轮真的挂上去的卡（charter §70 要求的形态）。
    '你刚才把解除通知存进档案了，我已经看到，这一轮不用再传。',
    '你上周存进档案的考勤截图，我已经逐张核对完，缺盖章页。',
    '工资流水你昨天已经存进档案，我核过了，月均 23000。',
    'HR 昨天发你的那份协议已经存进档案，我逐条看过了，第 3 条有问题。',
    '上一轮帮你挂进档案的两张行动卡，做到哪一步了？',
  ])('施事误伤必须判 MISS——「%s」', (body) => {
    expect(claimsActionCardExists(body), '判宽了：系统对着用户自己做的事，给自己追加了一段自我指控').toBe(false);
  });

  /**
   * ── 如实组 ④：RV6 在 c2c1983（纯短语表）上复核抓到的 9 条误伤 ──
   *
   * 病根是第二截那 7 条短语不满足「施事 + 完成态 + 行动卡/待办」三要素：
   *  · FP_A（无施事，1–7）：短语没说是谁干的，于是**用户干的**同样命中。
   *  · FP_B（对象非行动卡，8–9）：时间线录入与文书草稿都是**真实发生的工具事件**，
   *    说出来不是谎——第 8 句甚至同一句里就写着「行动卡这轮还没挂」。
   *
   * 复核给的 14 条误伤句里，另 5 条（「你刚才把解除通知存进档案了」等）与如实组 ③ 逐字重合，
   * 已在那一组里断言，这里不再重复列。
   */
  it.each([
    // ── FP_A：无施事 ──
    /* 1 落进档案了     */ '你刚才传的三份材料都落进档案了，我逐份看过，考勤那份缺盖章页。',
    /* 2 落进档案了     */ '解除通知你昨天已经落进档案了，这一轮不用再传。',
    /* 3 记到档案里了   */ '这几个日期你已经记到档案里了吗？没有的话回我一句，我来补。',
    /* 4 写进你的档案了 */ '你把三条底线写进你的档案了，我看到了，谈判时照着守。',
    /* 5 已经进你的待办了 */ '面谈时间已经进你的待办了吗？没进的话今天先把它排上。',
    /* 6 安排进你的待办了 */ 'HR 约谈的时间你安排进你的待办了吗？',
    /* 7 安排进你的待办了 */ '你把面试安排进你的待办了就行，别的先不动。',
    // ── FP_B：对象不是行动卡（真实工具事件，如实说出来） ──
    /* 8 我已经录入档案 */ '你说的两个日期我已经录入档案的时间线，行动卡这轮还没挂，回我一句我再补。',
    /* 9 为你创建了     */ '我已经为你创建了一份异议邮件草稿，在文书页，发之前你再改一遍。',
  ])('RV6 误伤族必须判 MISS——「%s」', (body) => {
    expect(claimsActionCardExists(body), '判宽了：系统对着一句老实话追加了一段自我指控').toBe(false);
  });

  it('纠正段自己那一整段也必须 MISS（否则它会给自己再追加一段）', () => {
    const correction =
      '**补一句实话：这一轮我没能把行动卡挂进你的档案。**\n\n' +
      '上面正文里如果出现了「已挂上」「已记进档案」这类说法，以这一行为准——档案里现在没有这几张卡。' +
      '你回我一句「把上面几件事记进档案」，我就补上。';
    expect(claimsActionCardExists(correction)).toBe(false);
  });
});
