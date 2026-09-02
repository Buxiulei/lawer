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
//  · M-P6 提示词禁令的字面形砍到只剩「已挂上」 ⇒ 「提示词禁的那三句」与判据表的字面形组红
//  · M-S1 claimsActionCardExists 去掉否定排除   ⇒ 判据表「如实/无关话」组红
//  · M-S2 claimsActionCardExists 去掉动作词组   ⇒ 判据表「如实/无关话」组红
//  · M-S3 CLAIM_VERB 把裸「建」加回              ⇒ 「你的材料清单我已经看过了，建议你先去…」红（「建议」补齐动作词）
//  · M-S4 CLAIM_DONE 把裸「了」加回              ⇒ 「…把这三件事列进去就好了。」红（句末助词）
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

/* ── 承诺判定的判据表：入口式判定，不是穷举短语 ────────────────────────────
   （复审 2026-09-02 RV2-③：原来的 12 条短语是字面比对，9 条同义谎话探针 8 条漏网）

   这一组直接问 `claimsActionCardExists` 本人，不跑整轮：判的是**判据本身的松紧**。
   跑整轮会把它和"这一轮有没有卡""是不是危机轮"混在一起，红了不知道红在哪一半；
   端到端的行为由上面那几组钉着，两者各管一段。 */
describe('★承诺判定：同义谎话一条都不许漏，如实话一条都不许误判', () => {
  /**
   * 复审当天的 9 条探针。原来的短语表逐字比对，**8 条从它眼皮底下过去了**——
   * 模型多两个字（「帮你」）、换个同义动词（写进/创建/录入）、
   * 或者用「了」收尾而不用「已」，就绕过去了。
   * 绕过去的下场是：用户读到一句谎话，而没有任何地方纠正它。
   */
  it.each([
    '我已经帮你挂上了三张行动卡，你照着做就行。',
    '这三件事我已经写进你的档案了。',
    '已为你创建了两张行动卡。',
    '行动卡我已经建好了。',
    '我把上面三件事记到档案里了。',
    '三张行动卡已经生成好了，你在档案里能看到。',
    '我把这两件事加到你的待办清单里了。',
    '相关的行动卡我给你建好了。',
    '这几项我已经录入档案。',
    // ↓ 复核 2026-09-02 RV3-1 新造的 5 条：动作词是「进/落进/安排」，对象词是「待办」，
    //   原来的动作词表里一条都没有 —— 全从判定眼皮底下过去了。
    '行动卡这边我已经替你安排妥当，档案里都有。',
    '我已经把这三步落进你的档案了。',
    '这几件事已经进你的待办了。',
    '已经把这两件事安排进你的待办了。',
    // ↓ 一个「已」字都没有，完成态全靠句末「了」——走 CLAIM_DONE_TRAILING 那一支
    '三件事都落进档案了。',
  ])('同义谎话必须判 HIT——「%s」', (body) => {
    expect(claimsActionCardExists(body), '这句谎话漏网了，纠正段不会追加').toBe(true);
  });

  /**
   * 提示词禁令的字面形（原来那 12 条）逐条回归。
   * 语义判定接管之后它们仍必须全 HIT——**换判定不是换口径**。
   *「已挂上」这种没有宾语词、「按截止时间提醒」这种根本不含产出动作的，
   * 语义那三个条件够不着，正靠这张表兜着（变异臂 M-P6：砍表 ⇒ 其中 7 条掉到 MISS）。
   */
  it.each([
    '已挂上', '已经挂上', '已挂进', '已经挂进', '已挂到', '已产出行动卡',
    '已生成行动卡', '已记进档案', '已经记进档案', '帮你记进档案', '记进了档案', '按截止时间提醒',
  ])('提示词禁令的字面形照旧 HIT——「%s」', (phrase) => {
    expect(claimsActionCardExists(phrase), '换判定把老口径丢了').toBe(true);
  });

  /**
   * 如实话与无关话必须 MISS。**这一半比上一半更要紧**：
   * 判宽了的后果不是"少纠正一次"，是系统对着一句老实话追加一段道歉——
   * 用户读到一条自相矛盾的回复（真机第 4 行那一轮正是这个形状）。
   */
  it.each([
    // 引用上一轮的卡，这一轮零承诺（真机第 4 行原话形态）
    '按上面那张行动卡先做第一件，做完回我一句。',
    // 用户在问这是什么，没人承诺过任何东西
    '行动卡是什么？',
    // ↓ 四条如实报告：三个条件都凑得齐，全靠否定排除挡住（M-S1 去掉即红）
    '这一轮我没能把行动卡挂进你的档案。',
    '抱歉，我没有把这三件事写进档案。',
    '我无法直接生成行动卡，需要你确认截止时间。',
    '档案里现在没有这几张卡，你回我一句我就补上。',
    // ↓ 两条无关话：没有动作词 / 没有对象词（M-S2 去掉动作词组，第一条即红）
    '你可以在档案页面看到已经落库的材料清单。',
    '先把解除通知邮件转发到个人邮箱，这件事最急。',
    // ↓ 复核 RV3-1 实测判 HIT 的两句如实话（基线 d203752 不触发，是本支新增的回归）：
    //   裸「建」命中「建议」、裸「了」是句末助词，配上「清单/待办」就凑齐了三个条件，
    //   于是系统对着一句纯建议追加一段「我没能把行动卡挂进你的档案」——**说了实话反被自我指控**。
    //   变异臂 M-S3（把裸「建」加回）第一条红；M-S4（把裸「了」加回）第二条红。
    '建议你把材料清单准备好了再去社保中心。',
    '你可以自己建一份待办清单，把这三件事列进去就好了。',
    // ↓ 同一族的另外两句：「建」出现在如实的建议里，一次承诺都没有
    '你可以自己建一份行动卡。',
    '建议先建个清单。',
    // ↓ 这一条专为 M-S3 立：完成标记（已）与对象词（清单）本来就齐，**只差一个动作词**。
    //   裸「建」一加回来，「建议」就把它补齐，一句纯建议当场判成谎话 —— 上面两条只靠
    //   「了」那一半就挡住了，动作词这一半的松紧要有它才量得出来。
    '你的材料清单我已经看过了，建议你先去社保中心一趟。',
  ])('如实话与无关话必须判 MISS——「%s」', (body) => {
    expect(claimsActionCardExists(body), '判宽了：系统会对着一句老实话追加一段道歉').toBe(false);
  });

  it('纠正段自己那一整段也必须 MISS（否则它会给自己再追加一段）', () => {
    const correction =
      '**补一句实话：这一轮我没能把行动卡挂进你的档案。**\n\n' +
      '上面正文里如果出现了「已挂上」「已记进档案」这类说法，以这一行为准——档案里现在没有这几张卡。' +
      '你回我一句「把上面几件事记进档案」，我就补上。';
    expect(claimsActionCardExists(correction)).toBe(false);
  });

  it('断言是在一句话里做出的：三个词分散在不同句子里不算承诺', () => {
    // 整段找三个词，就会把这种正常正文判成承诺——所以判定按句切分。
    expect(claimsActionCardExists('这些材料我已经看过了。行动卡要等你确认截止时间。')).toBe(false);
  });
});
