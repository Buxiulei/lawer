// app/src/lib/agent/__tests__/billing-wiring.test.ts
// 公道值账本接线（2026-08-25 P0）。生产冒烟发现 token_usage / gongdao_ledger / model_rates
// 三表全 0 行——设施全都写好了，**只是没人调**。本文件钉的是「一轮对话必须在三处各留下痕迹」，
// 防它再次静默空着：接线漏了不会报错、不会崩，只会安安静静地不记账。
import { describe, expect, it } from 'vitest';
import { runTurn } from '../orchestrator';
import { reconcile } from '@/lib/db/reconcile';
import { getRatesForModel } from '@/lib/db/modelRates';
import { costLiOfUsage, costOfUsage, DEFAULT_RATES } from '@/lib/billing/pricing';
import { makeAgentFixture, makeSink, scriptedProvider, fixtureSearcher, type AgentFixture, type ScriptedRound } from './fixtures';

const CARD = {
  name: 'action_card',
  args: {
    what: '今天 18 点前把解除通知邮件转发到个人邮箱',
    how: '打开公司邮箱 → 转发到私人邮箱并截图',
    why: '公司随时可能停你的邮箱权限',
    due_at: '2026-08-19T18:00:00+08:00',
  },
};

// 【轮次口径，别再想当然】发起工具调用的那一轮之后，编排循环**必然再跑一轮**把结果讲给用户，
// 所以「一次对话」= 至少 2 次模型往返，四桶按 addUsage 累加：默认剧本 = prompt 100×2、completion 20×2。
// 账要按**对话**记一笔，不按往返次数记——下面的期望值就是照这个口径写死的。
const ROUNDS_PER_TURN = 2;
const PROMPT_PER_ROUND = 100;
const COMPLETION_PER_ROUND = 20;

async function turn(script: ScriptedRound[] = [{ text: '好的。', tools: [CARD] }], over: Record<string, unknown> = {}) {
  const f = makeAgentFixture();
  const sink = makeSink();
  const result = await runTurn({
    db: f.db,
    caseId: f.caseId,
    userId: f.userId,
    message: '刚收到辞退邮件，说什么客观情况重大变化，我现在手都是抖的',
    provider: scriptedProvider(script),
    searcher: fixtureSearcher(),
    emit: sink.emit,
    now: new Date('2026-08-19T12:40:00Z'),
    ...over,
  });
  if (!('ok' in result) || !result.ok) throw new Error(`本轮未成功：${JSON.stringify(result)}`);
  return { f, sink, result };
}

const rows = <T>(f: AgentFixture, sql: string): T[] => f.db.prepare(sql).all() as T[];

describe('一轮对话在三处各留下账（manager 点名：防它再次静默空着）', () => {
  it('messages / token_usage / gongdao_ledger 三处行数与内容都对得上', async () => {
    const { f, result } = await turn();

    // ① messages：模型回复落库
    const msgs = rows<{ id: number; role: string }>(f, "SELECT id, role FROM messages WHERE role='assistant'");
    expect(msgs).toHaveLength(1);
    expect(msgs[0].id).toBe(result.messageId);

    // ② token_usage：四桶 + 双串 + 成本
    const usage = rows<{
      user_id: number; feature: string; model: string; api_model: string | null;
      prompt_tokens: number; completion_tokens: number; cost_li: number; ref_id: string;
    }>(f, 'SELECT * FROM token_usage');
    expect(usage).toHaveLength(1);
    expect(usage[0].user_id).toBe(f.userId);
    expect(usage[0].feature).toBe('intake'); // mode=问诊 → 已登记的 feature 键
    expect(usage[0].model).toBe('DeepSeek-V4-Pro-0813'); // priced 计费键
    expect(usage[0].api_model).toBe('deepseek-v4-pro'); // 厂商回显串：两串不同是设计如此
    expect(usage[0].prompt_tokens).toBe(PROMPT_PER_ROUND * ROUNDS_PER_TURN);
    expect(usage[0].completion_tokens).toBe(COMPLETION_PER_ROUND * ROUNDS_PER_TURN);
    expect(usage[0].cost_li).toBeGreaterThan(0);

    // ③ gongdao_ledger：一条消耗流水，ref 与用量同键（对账靠它）
    const ledger = rows<{ delta: number; type: string; ref_id: string; feature: string }>(
      f, "SELECT * FROM gongdao_ledger WHERE type='消耗'",
    );
    expect(ledger).toHaveLength(1);
    expect(ledger[0].ref_id).toBe(usage[0].ref_id);
    expect(ledger[0].feature).toBe('intake');
    expect(ledger[0].delta).toBeLessThan(0); // 消耗恒为负
  });

  it('陪跑模式记到 companion 键（feature 必须是 features.ts 登记过的键）', async () => {
    const { f } = await turn(undefined, { mode: '陪跑' });
    const [u] = rows<{ feature: string }>(f, 'SELECT feature FROM token_usage');
    expect(u.feature).toBe('companion');
  });

  it('扣的钱与四桶×费率一致（不是拍脑袋的固定值）', async () => {
    const { f } = await turn();
    const rates = getRatesForModel(f.db, 'DeepSeek-V4-Pro-0813');
    const tokens = {
      promptTokens: PROMPT_PER_ROUND * ROUNDS_PER_TURN,
      completionTokens: COMPLETION_PER_ROUND * ROUNDS_PER_TURN,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    const [u] = rows<{ cost_li: number }>(f, 'SELECT cost_li FROM token_usage');
    const [l] = rows<{ delta: number }>(f, "SELECT delta FROM gongdao_ledger WHERE type='消耗'");
    expect(u.cost_li).toBe(costLiOfUsage(tokens, rates));
    expect(-l.delta).toBe(costOfUsage(tokens, rates)); // 账本记整数（向上取整），用量记厘
  });

  it('费率取自 model_rates 种子行，而不是 DEFAULT_RATES 兜底（种子真的被播过）', async () => {
    const { f } = await turn();
    const seeded = getRatesForModel(f.db, 'DeepSeek-V4-Pro-0813');
    // C01 核定：DeepSeek-V4-Pro 输入 9.0 元/百万 ≠ 兜底用的 Flash 档 3.0 元/百万
    expect(seeded.in).not.toBe(DEFAULT_RATES.in);
    expect(rows(f, "SELECT 1 FROM model_rates WHERE model='DeepSeek-V4-Pro-0813'")).not.toHaveLength(0);
  });

  it('跑完一轮后对账器报绿——空账本告警与接线是同一件事的两面', async () => {
    const { f } = await turn();
    expect(reconcile(f.db).problems).toEqual([]);
  });

  it('多轮工具调用只结算一次（一轮对话 = 一笔账，不按模型往返次数收钱）', async () => {
    const { f } = await turn([
      { text: '先查依据。', tools: [{ name: 'knowledge_search', args: { query: '客观情况重大变化' } }] },
      { text: '据此……', tools: [CARD] },
    ]);
    expect(rows(f, 'SELECT 1 FROM token_usage')).toHaveLength(1);
    expect(rows(f, "SELECT 1 FROM gongdao_ledger WHERE type='消耗'")).toHaveLength(1);
    // 三次往返（查依据 → 给行动卡 → 收口）的用量累加进同一行（addUsage 的口径），不是只记最后一轮
    const [u] = rows<{ prompt_tokens: number }>(f, 'SELECT prompt_tokens FROM token_usage');
    expect(u.prompt_tokens).toBe(PROMPT_PER_ROUND * 3);
  });
});

describe('未回报计量的轮：不许拿 0 冒充（types.ts 铁律「桶为 null 不可当 0 结算」）', () => {
  it('四桶全 null → 不记账不扣费，改发 notice 让它可见', async () => {
    // 两轮都必须显式写成「未回报」：只写第一轮的话，第二轮按默认回报 100/20，
    // 本条就永远测不到未回报那条路——样本进不了被测代码 = 永远绿的空测试。
    const { f, sink } = await turn([
      { text: '好的。', tools: [CARD], usage: null },
      { text: '这就是全部。', usage: null },
    ]);
    expect(rows(f, 'SELECT 1 FROM token_usage')).toHaveLength(0);
    expect(rows(f, "SELECT 1 FROM gongdao_ledger WHERE type='消耗'")).toHaveLength(0);
    const notices = sink.events.filter((e) => e.event === 'notice') as { data: { code: string } }[];
    expect(notices.some((n) => n.data.code === 'USAGE_UNREPORTED')).toBe(true);
  });

  it('部分桶 null（厂商无该档）照常记账，null 桶按 0 落行', async () => {
    const { f } = await turn([
      { text: '好的。', tools: [CARD], usage: { prompt: 100, completion: null, cachedRead: null, cachedWrite: null } },
      { text: '这就是全部。', usage: { prompt: 0, completion: null, cachedRead: null, cachedWrite: null } },
    ]);
    const [u] = rows<{ prompt_tokens: number; completion_tokens: number }>(f, 'SELECT * FROM token_usage');
    expect(u.prompt_tokens).toBe(100);
    expect(u.completion_tokens).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 型号对账（评测遗留②）：**请求 opus 不等于拿到 opus**。
// 中转按渠道分组路由（providers/relay.ts 文件头实测），回显的 served model 才是真相。
// 在此之前记账一律按请求型号计价——中转把 opus 路由到 sonnet 返回时，
// 我们照 opus 的价（$5/$25）收钱而用户拿到 sonnet（$2/$10）：2.5 倍，方向朝着用户吃亏。
// ─────────────────────────────────────────────────────────────────────────────
const RELAY_OPUS = { name: 'relay' as const, model: 'claude-opus-5', billingModel: 'relay/claude-opus-5' };
const RELAY_SONNET = { name: 'relay' as const, model: 'claude-sonnet-5', billingModel: 'relay/claude-sonnet-5' };

/** 高配 critical 的真实形态：型号经中转。servedModel 由剧本逐轮指定；relay 身份默认 opus。 */
async function relayTurn(served: string | null | undefined, relay = RELAY_OPUS) {
  const script: ScriptedRound[] = [
    { text: '好的。', tools: [CARD], ...(served === undefined ? {} : { servedModel: served }) },
    { text: '这就是全部。', ...(served === undefined ? {} : { servedModel: served }) },
  ];
  return turn(script, { provider: scriptedProvider(script, relay), plan: 'pro' });
}

const TURN_TOKENS = {
  promptTokens: PROMPT_PER_ROUND * ROUNDS_PER_TURN,
  completionTokens: COMPLETION_PER_ROUND * ROUNDS_PER_TURN,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

describe('served_model 与请求型号对账（不对账＝算错钱，命脉）', () => {
  it('中转把 opus 路由到 sonnet：按 **sonnet** 计价，不按请求的 opus', async () => {
    const { f } = await relayTurn('claude-sonnet-5');

    const [u] = rows<{ model: string; api_model: string | null; cost_li: number }>(f, 'SELECT * FROM token_usage');
    expect(u.model).toBe('relay/claude-sonnet-5'); // 计费键换成了实际服务的那个
    expect(u.api_model).toBe('claude-sonnet-5'); // 回显串落列，供对账探针用

    // 钱要真的按 sonnet 的费率算出来——不是「换了个键但仍照 opus 收」。
    const sonnet = getRatesForModel(f.db, 'relay/claude-sonnet-5');
    const opus = getRatesForModel(f.db, 'relay/claude-opus-5');
    expect(opus.in).toBeGreaterThan(sonnet.in); // 前提：两档确有价差，否则本条测不出东西
    const [l] = rows<{ delta: number }>(f, "SELECT delta FROM gongdao_ledger WHERE type='消耗'");
    expect(u.cost_li).toBe(costLiOfUsage(TURN_TOKENS, sonnet));
    expect(-l.delta).toBe(costOfUsage(TURN_TOKENS, sonnet));
    // 反向钉死：**绝不能**等于按 opus 算出来的那个数
    expect(-l.delta).not.toBe(costOfUsage(TURN_TOKENS, opus));
  });

  // ── 升档方向（manager 点名的主路判据）：请求 sonnet、上游回 opus ──
  // billed = min(rate(sonnet), rate(opus)) = sonnet：用户不为中转擅自的升档买单。
  // 【这条为什么不可省】降档方向即便摘掉记账点的 rateOf、退回「按 served 计价」，billed 仍是较低的 served，
  // 上面几条照样绿——唯独升档方向 rateOf 缺席会滑成「按 served(=opus) 多扣」。所以只有本条能钉住
  // 「orchestrator 真把 rateOf 接进了 reconcileServedModel」：摘掉 chargeTurn 里那个 rateOf 参数，本条即红。
  it('中转把 sonnet 升档到 opus：仍按 **sonnet**（请求价，较低），用户不为擅自升档买单', async () => {
    const { f, sink } = await relayTurn('claude-opus-5', RELAY_SONNET);

    const [u] = rows<{ model: string; api_model: string | null; cost_li: number }>(f, 'SELECT * FROM token_usage');
    expect(u.model).toBe('relay/claude-sonnet-5'); // 计费键维持请求的 sonnet（较低价）
    expect(u.api_model).toBe('claude-opus-5'); // 回显串照实落列，供对账探针用

    const sonnet = getRatesForModel(f.db, 'relay/claude-sonnet-5');
    const opus = getRatesForModel(f.db, 'relay/claude-opus-5');
    expect(opus.in).toBeGreaterThan(sonnet.in); // 前提：两档确有价差，否则本条测不出东西
    const [l] = rows<{ delta: number }>(f, "SELECT delta FROM gongdao_ledger WHERE type='消耗'");
    expect(u.cost_li).toBe(costLiOfUsage(TURN_TOKENS, sonnet));
    expect(-l.delta).toBe(costOfUsage(TURN_TOKENS, sonnet));
    // 反向钉死：摘掉 rateOf 会让这一行变成 opus 的价（多扣），必须不等于它
    expect(-l.delta).not.toBe(costOfUsage(TURN_TOKENS, opus));

    // 升档同样是 substituted：留痕 requested/served/billed 与 notice（对账脚本 + 盯流的人都要看得见）
    const [lm] = rows<{ meta_json: string | null }>(f, "SELECT meta_json FROM gongdao_ledger WHERE type='消耗'");
    expect(JSON.parse(lm.meta_json!)).toEqual({
      requested: 'relay/claude-sonnet-5',
      served: 'claude-opus-5',
      billed: 'relay/claude-sonnet-5',
      verdict: 'substituted',
    });
    const notices = sink.events.filter((e) => e.event === 'notice') as { data: { code: string } }[];
    expect(notices.some((n) => n.data.code === 'SERVED_MODEL_MISMATCH')).toBe(true);
  });

  it('降档必须留下审计痕：ledger.meta_json 记 requested vs served', async () => {
    const { f, sink } = await relayTurn('claude-sonnet-5');

    const [l] = rows<{ meta_json: string | null }>(f, "SELECT meta_json FROM gongdao_ledger WHERE type='消耗'");
    expect(l.meta_json).not.toBeNull();
    expect(JSON.parse(l.meta_json!)).toEqual({
      requested: 'relay/claude-opus-5',
      served: 'claude-sonnet-5',
      billed: 'relay/claude-sonnet-5',
      verdict: 'substituted',
    });
    // 当场也要出声：meta 是给对账脚本看的，notice 是给正在盯这条流的人看的
    const notices = sink.events.filter((e) => e.event === 'notice') as { data: { code: string } }[];
    expect(notices.some((n) => n.data.code === 'SERVED_MODEL_MISMATCH')).toBe(true);
  });

  it('回显未登记的新快照：维持请求价，但同样留痕待核（不拿兜底价凭空造一个低价）', async () => {
    const { f, sink } = await relayTurn('claude-opus-5-20260514');

    const [u] = rows<{ model: string; api_model: string | null }>(f, 'SELECT * FROM token_usage');
    expect(u.model).toBe('relay/claude-opus-5'); // 认不出就不猜价
    expect(u.api_model).toBe('claude-opus-5-20260514'); // 但回显串照实落列 —— 对账探针靠它发现换快照
    const [l] = rows<{ delta: number; meta_json: string | null }>(f, "SELECT * FROM gongdao_ledger WHERE type='消耗'");
    expect(-l.delta).toBe(costOfUsage(TURN_TOKENS, getRatesForModel(f.db, 'relay/claude-opus-5')));
    expect(JSON.parse(l.meta_json!).verdict).toBe('unrecognized');
    const notices = sink.events.filter((e) => e.event === 'notice') as { data: { code: string } }[];
    expect(notices.some((n) => n.data.code === 'SERVED_MODEL_MISMATCH')).toBe(true);
  });

  it('回显与请求一致：原样计价、meta 留空（正常轮不塞噪声，否则没人会去看 meta）', async () => {
    const { f, sink } = await relayTurn('claude-opus-5');

    const [u] = rows<{ model: string; api_model: string | null }>(f, 'SELECT * FROM token_usage');
    expect(u.model).toBe('relay/claude-opus-5');
    expect(u.api_model).toBe('claude-opus-5');
    const [l] = rows<{ delta: number; meta_json: string | null }>(f, "SELECT * FROM gongdao_ledger WHERE type='消耗'");
    expect(l.meta_json).toBeNull();
    expect(-l.delta).toBe(costOfUsage(TURN_TOKENS, getRatesForModel(f.db, 'relay/claude-opus-5')));
    const notices = sink.events.filter((e) => e.event === 'notice') as { data: { code: string } }[];
    expect(notices.some((n) => n.data.code === 'SERVED_MODEL_MISMATCH')).toBe(false);
  });

  it('厂商没回显（老网关/保活行）：走既有兜底——照常记账、不崩、不告警', async () => {
    const { f, sink } = await relayTurn(null);

    const [u] = rows<{ model: string; api_model: string | null }>(f, 'SELECT * FROM token_usage');
    expect(u.model).toBe('relay/claude-opus-5');
    expect(u.api_model).toBeNull(); // 没回显就留 NULL，**不拿请求串冒充**
    const [l] = rows<{ delta: number; meta_json: string | null }>(f, "SELECT * FROM gongdao_ledger WHERE type='消耗'");
    expect(l.meta_json).toBeNull();
    expect(-l.delta).toBe(costOfUsage(TURN_TOKENS, getRatesForModel(f.db, 'relay/claude-opus-5')));
    const notices = sink.events.filter((e) => e.event === 'notice') as { data: { code: string } }[];
    expect(notices.some((n) => n.data.code === 'SERVED_MODEL_MISMATCH')).toBe(false);
  });

  // 两个记账点之间的接缝：实时记账落 messages.tokens_json，回填**只**读它。
  // orchestrator 少写一个 servedModel，回填那条路就永远只看到「未回显」，
  // 于是「实时按 sonnet 算、补记按 opus 算」——同一笔账两个数，而且没有任何测试会红。
  it('回显串要落进 messages.tokens_json —— 回填那条路只认得它', async () => {
    const { f } = await relayTurn('claude-sonnet-5');
    const [m] = rows<{ tokens_json: string }>(f, "SELECT tokens_json FROM messages WHERE role='assistant'");
    expect(JSON.parse(m.tokens_json).servedModel).toBe('claude-sonnet-5');
  });

  it('tool-loop 中途换渠道：以**最后一次**回显为准（一轮一笔账，只能挂一个计费键）', async () => {
    const script: ScriptedRound[] = [
      { text: '先查依据。', tools: [{ name: 'knowledge_search', args: { query: '客观情况重大变化' } }], servedModel: 'claude-opus-5' },
      { text: '据此……', tools: [CARD], servedModel: 'claude-sonnet-5' },
      { text: '收口。', servedModel: 'claude-sonnet-5' },
    ];
    const { f } = await turn(script, { provider: scriptedProvider(script, RELAY_OPUS), plan: 'pro' });
    const [u] = rows<{ model: string; api_model: string | null }>(f, 'SELECT * FROM token_usage');
    expect(u.model).toBe('relay/claude-sonnet-5');
    expect(u.api_model).toBe('claude-sonnet-5');
  });

  it('某轮没回显不算「换回请求型号」：此前见过的回显要保留住', async () => {
    const script: ScriptedRound[] = [
      { text: '好的。', tools: [CARD], servedModel: 'claude-sonnet-5' },
      { text: '这就是全部。', servedModel: null }, // 末轮没回显
    ];
    const { f } = await turn(script, { provider: scriptedProvider(script, RELAY_OPUS), plan: 'pro' });
    const [u] = rows<{ model: string }>(f, 'SELECT * FROM token_usage');
    expect(u.model).toBe('relay/claude-sonnet-5'); // 不是 relay/claude-opus-5
  });
});

/**
 * done 帧必须带上「这一轮**实际**是谁答的」。
 *
 * ─────────────── 这组补的是哪个缺口 ───────────────
 * 前端要在每条回答底下标出实际服务的型号，而它手上唯一现成的值是 `meta.model`——
 * 那是**开跑前**我们请求的那个。实际派谁来服务要到流末才回显，
 * 服务端不把它随 done 帧发下去，前端就只能拿请求值冒充实际值：
 * 请求 opus、实际 sonnet 的那一轮，用户会读到「深度推理模型」。
 * **标错比不标更坏**——不标只是缺信息，标错是给了一个假答案，而他是按型号付费的。
 *
 * 变异臂：orchestrator 的 done 帧里 `served_model: servedModel` 换成 `null`
 *        （或把这三个字段整个删掉）⇒ 下面第一条与第三条红。
 */
describe('done 帧带得出「实际是谁答的」（前端那行落款的唯一来源）', () => {
  const doneOf = (sink: ReturnType<typeof makeSink>) => sink.of('done')[0].data;

  it('中转把 opus 路由到 sonnet ⇒ served_model 是 sonnet，且判定为替代', async () => {
    const { sink } = await relayTurn('claude-sonnet-5');
    const done = doneOf(sink);
    expect(done.model).toBe('claude-opus-5'); // 我们请求的
    expect(done.served_model).toBe('claude-sonnet-5'); // 实际服务的
    expect(done.served_mismatch).toBe(true);
  });

  it('回显与请求一致 ⇒ 不算替代（前端据此不加「（替代）」）', async () => {
    const { sink } = await relayTurn('claude-opus-5');
    const done = doneOf(sink);
    expect(done.served_model).toBe('claude-opus-5');
    expect(done.served_mismatch).toBe(false);
  });

  /** 没回显是常态（不是每个网关都回显），此时前端退回请求值，不该被标成替代 */
  it('整轮都没回显 ⇒ served_model 为 null，且不算替代', async () => {
    const { sink } = await relayTurn(null);
    const done = doneOf(sink);
    expect(done.model).toBe('claude-opus-5');
    expect(done.served_model).toBeNull();
    expect(done.served_mismatch).toBe(false);
  });

  /** 未登记的新快照串：认不出也要如实报出去，不能悄悄换成请求值 */
  it('回显一个没登记过的串 ⇒ 原样报出，并判为替代（留痕待核）', async () => {
    const { sink } = await relayTurn('claude-opus-5-20260901');
    const done = doneOf(sink);
    expect(done.served_model).toBe('claude-opus-5-20260901');
    expect(done.served_mismatch).toBe(true);
  });
});
