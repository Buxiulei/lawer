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
//  · M-S1 claimsActionCardExists 去掉否定排除   ⇒ 纠正段自己那一段红
//  · M-S2 claimsActionCardExists 去掉两组动作词 ⇒ 如实组 7 条红
//  · M-S4 CLAIM_DONE 把裸「了」加回              ⇒ prompt.ts:136 与「…列进去就好了。」红（句末助词）
//  · A1  去掉 CLAIM_SECOND_PERSON               ⇒ **本表上绿**（A2 的白名单独立挡住同族），见 A3
//  · A2  CLAIM_VERB_MOVE 的「进」放宽回光杆      ⇒ 「材料已经进档案了…」红（光杆「进」收了用户动作）
//  · A3  A1 + A2 同时回退                        ⇒ 再红 3 条「你把…传进档案了」——施事约束是「进」放宽时的最后一道
//  · A4  CLAIM_OBJECT 加回裸「清单」             ⇒ workbench.ts:69 与 jujie-xinhuo:59 红（产线语料里的「清单」是用户那份纸）
//  · A5  CLAIM_VERB_MAKE 允许配「档案」          ⇒ welcome:24 与 IntakeFlow:137 红（建档是产品真事件）
//  · M-S3 CLAIM_VERB_MAKE 加回裸「建」           ⇒ **本表上绿**（A4 把裸「清单」摘出对象词后，
//        「建议…清单」那条通路整条没了；裸「建」仍不收，属冗余防线，与 A1 同类）
//
// 【两条绿臂是量出来的，不是没量】A1 与 M-S3 单独回退时判据表全绿：本轮两处收窄
// （对象词摘掉裸「清单」、动作词摘掉光杆「进」）各自就已经独立挡住了同一族误伤，
// 施事约束与裸「建」成了第二道。A3（A1+A2 同时回退）再红 3 条「你把…传进档案了」，
// 证的正是"第二道确实在那儿"——只是第一道没塌时量不出它。绿臂照记，不假装成红。
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
   * ── 如实组 ①：**产线真实语料**，逐句抄自仓里已有的产品文案与提示词，注释标出处 ──
   *
   * 【为什么如实句不许自己造】(manager 2026-09-02 终局裁决) 四轮下来每一次收窄都把误伤
   * 搬到另一族如实句上：第一轮修「建议」、第二轮修「列进去就好了」、这一轮又冒出
   * 「你把材料传进档案了吗」。原因是自造的如实句只长成**我已经想到的那种误伤**；
   * 产线语料才长成我没想到的那种——本组 37 条里有 5 条是机械扫描全仓当场扫出来的真误伤
   * （workbench.ts:69、jujie-xinhuo:59、welcome:24、IntakeFlow:137，加 prompt.ts:136 在 M-S4 下红）。
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
    // ↓ 已经 + 生成（产出动作词），只差一个对象词 —— 对象词那一组的松紧靠它量
    /* EvidenceDetailSheet.tsx:22  */ '《存证证明》已经生成，上面有存证编号、哈希值和时间戳。对方可以拿编号到验证页自己复核。',
    /* EvidenceDetailSheet.tsx:111 */ '证明文件已经生成好了，下载入口还在接。现在先把下面的验证链接给对方，编号和时间戳一样可以当场核。',
    /* EvidenceLibrary.tsx:85   */ '已经上传的材料还在，只是这次没读出来。',
    // ↓ 已 + 存进（搬运动作词），同样只差对象词
    /* EvidenceLibrary.tsx:256  */ '已存进证据库，还没固化',

    // ── 行动卡 / 工作台 / 落地页文案 ──
    // ↓ 机械扫描当场扫出的真误伤之一：已 + 生成 + 「清单」。裸「清单」因此从对象词里去掉（A4 臂）
    /* _mock/workbench.ts:69  */ '收到解除通知（立案材料清单已按此生成）',
    /* _mock/workbench.ts:372 */ '拿到逐字案号后我会补进档案。',
    /* _mock/workbench.ts:415 */ '材料方面你档案里已经有八件证据，缺的只有公司主体信息查询页，这一步在网上就能做完，不用出门。',
    /* _mock/demo.ts:818 */ '今天剩下的时间做两件事就够了，都在下面的行动卡里：一封确认邮件，和明天照常打卡。',
    /* _mock/demo.ts:978 */ '三件事在下面的行动卡里。',
    /* _mock/demo.ts:980 */ '档案已经更新：时间线 20 条，证据 8 件（2 件已出证、5 件已固化、1 件待固化），诉求初算两项合计 23.01 万。材料清单还差工资流水的盖章版和考勤最后一次导出。',
    // ↓ 已经 + 替你 + 档案，三样里齐了两样，**只差动作词**——动作词那一组的松紧靠它量（M-S2 臂）
    /* app/page.tsx:40  */ '向朝阳区劳动人事争议仲裁委员会提交申请。申请书和证据清单，档案里已经替你备着。',
    // ↓ 「排进你的档案」正好撞上 CLAIM_VERB_MOVE 里的「进你的档案」，**只差完成标记**
    /* app/page.tsx:54  */ '公司起诉的，你就是被告：答辩、举证、开庭，每一步照样排进你的档案。',
    /* app/page.tsx:173 */ '说清楚现在走到哪一步、公司给了什么说法，几分钟就能有一份属于你的档案。该拿的钱、在跑的期限、能直接改的文书草稿，都排在上面。',
    // ↓ 两条建档文案：已 + 建好 + 档案。产出动作词不许配「档案」就是为它们立的（A5 臂）
    /* welcome/page.tsx:24 */ '手机号和邮箱都验证过了，你的档案已经建好',
    /* (app)/intake/_components/IntakeFlow.tsx:137 */ '档案已建好，正在打开驾驶舱',

    // ── prompt.ts 输出纪律 ──
    // ↓ 挂 + 了 + 行动卡 三样俱全，只因「了」没挂在对象词后面才 MISS（M-S4 臂）
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
    // ↓ 已经 + 写进 + 清单，三样按老口径全齐——机械扫描扫出的第二条真误伤（A4 臂）
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
    // ↓ 四条如实报告：三个条件都凑得齐，全靠否定排除挡住（M-S1 去掉即红）
    '这一轮我没能把行动卡挂进你的档案。',
    '抱歉，我没有把这三件事写进档案。',
    '我无法直接生成行动卡，需要你确认截止时间。',
    '档案里现在没有这几张卡，你回我一句我就补上。',
    // ↓ 两条无关话：没有动作词 / 没有对象词（M-S2 去掉动作词组，第一条即红）
    '你可以在档案页面看到已经落库的材料清单。',
    '先把解除通知邮件转发到个人邮箱，这件事最急。',
    // ↓ RV3-1 那两句：裸「建」命中「建议」、裸「了」是句末助词（M-S4 加回裸「了」，第二条即红）
    '建议你把材料清单准备好了再去社保中心。',
    '你可以自己建一份待办清单，把这三件事列进去就好了。',
    '你可以自己建一份行动卡。',
    '建议先建个清单。',
    '你的材料清单我已经看过了，建议你先去社保中心一趟。',
  ])('复核历次抓到的如实句必须判 MISS——「%s」', (body) => {
    expect(claimsActionCardExists(body), '判宽了：系统会对着一句老实话追加一段道歉').toBe(false);
  });

  /**
   * ── 如实组 ③：本轮（复核 RV4-1）实测判 HIT 的一族 ──
   *
   * 六句全是**在说用户做了什么、或在给用户派活**，系统一个字都没承诺。
   * 病根有两处：光杆「进」把用户动作（传进/上传进/发进）一起收了；判定完全不管主语是谁。
   */
  it.each([
    '你把工资流水传进档案了吗？',
    '你已经把解除通知传进档案了，很好。',
    '材料已经进档案了，下一步我们谈补偿数额。',
    '等你把材料上传进档案了，我再帮你逐项核对。',
    '你上次说已经把材料清单发进公司邮箱了，那份也带上。',
    '你先把这三件事安排好，清单我看过了再说。',
  ])('本轮抓到的施事误伤必须判 MISS——「%s」', (body) => {
    expect(claimsActionCardExists(body), '判宽了：系统对着用户自己做的事，给自己追加了一段自我指控').toBe(false);
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
