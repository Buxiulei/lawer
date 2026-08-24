// app/src/lib/agent/__tests__/orchestrator.test.ts
// 编排循环。用剧本化的假模型跑完整一轮，断言的是「不管模型怎么答，这些事都必须成立」。
import { describe, expect, it } from 'vitest';

import { CHARTER } from '../charter';
import { runTurn, type RunTurnResult } from '../orchestrator';
import * as agentDb from '@/lib/db/agent';
import { CRISIS_CARD_MARKER, CRISIS_RESOURCE_PACK_ID } from '../crisis';
import { FIXTURE_PACK, fixtureSearcher, makeAgentFixture, makeSink, scriptedProvider, type ScriptedRound } from './fixtures';
import { CORE_ARTICLE_MAP_PACK_ID } from '../citation-block';
import { createKnowledgeSearcher } from '../knowledge-adapter';

const GOOD_CARD = {
  name: 'action_card',
  args: {
    what: '今天 18 点前把解除通知邮件转发到个人邮箱',
    how: '打开公司邮箱 → 找到 20:40 那封《解除劳动合同通知书》→ 转发到你的私人邮箱并截图',
    why: '公司随时可能停你的邮箱权限，停了就取不出来了',
    due_at: '2026-08-19T18:00:00+08:00',
  },
};

async function turn(script: ScriptedRound[], over: Record<string, unknown> = {}) {
  const f = makeAgentFixture();
  const sink = makeSink();
  const provider = scriptedProvider(script);
  const result = await runTurn({
    db: f.db,
    caseId: f.caseId,
    userId: f.userId,
    message: '刚收到辞退邮件，说什么客观情况重大变化，我现在手都是抖的',
    provider,
    searcher: fixtureSearcher(),
    emit: sink.emit,
    now: new Date('2026-08-19T12:40:00Z'),
    ...over,
  });
  return { f, sink, provider, result };
}

describe('上下文组装（manager 契约）', () => {
  it('system = charter 全文 + 案件档案摘要 + 检索到的 pack 逐字原文', async () => {
    const { provider } = await turn([{ text: '好的。', tools: [GOOD_CARD] }]);
    const system = provider.calls[0][0].content;

    expect(provider.calls[0][0].role).toBe('system');
    expect(system).toContain(CHARTER);
    expect(system).toContain('## 案件档案');
    expect(system).toContain('李哲诉某安全公司违法解除');
    // pack 正文一字不改地进了 prompt——摘要过一道就等于让模型转述法条
    expect(system).toContain(FIXTURE_PACK.body);
    expect(system).toContain('可信度：原文核实');
  });

  it('给出当前北京时间，否则行动卡的截止时间只能靠编', async () => {
    const { provider } = await turn([{ text: 'x', tools: [GOOD_CARD] }]);
    expect(provider.calls[0][0].content).toContain('2026-08-19');
    expect(provider.calls[0][0].content).toContain('+08:00');
  });

  it('用户原话作为最后一条 user 消息送出', async () => {
    const { provider } = await turn([{ text: 'x', tools: [GOOD_CARD] }]);
    const last = provider.calls[0].at(-1)!;
    expect(last.role).toBe('user');
    expect(last.content).toContain('手都是抖的');
  });

  it('第二轮把工具结果按 role:tool 回喂，模型才知道自己那一刀落没落下', async () => {
    const { provider } = await turn([
      { text: '先查依据。', tools: [{ name: 'knowledge_search', args: { query: '客观情况重大变化' } }] },
      { text: '据此……', tools: [GOOD_CARD] },
    ]);
    const second = provider.calls[1];
    expect(second.some((m) => m.role === 'assistant')).toBe(true);
    const toolMsg = second.find((m) => m.role === 'tool');
    expect(toolMsg?.content).toContain(FIXTURE_PACK.id);
  });
});

describe('结构化落库 enforcement（charter §9：禁自由文本直写）', () => {
  it('调了工具才落档：正文里说「已记下」而没调工具，档案就是空的', async () => {
    const { f } = await turn([{ text: '我已经把这件事记到你的时间线上了。', tools: [GOOD_CARD] }]);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM timeline_events').get()).toEqual({ n: 0 });
  });

  it('工具调用逐条落到对应的表，并各自发出结构化事件', async () => {
    const { f, sink } = await turn([
      {
        text: '接住你的慌，先固定证据。',
        tools: [
          {
            name: 'timeline_add',
            args: {
              happened_at: '2026-08-19T12:40:00Z',
              kind: '公司动作',
              title: '收到《解除劳动合同通知书》',
              detail: '理由写「客观情况发生重大变化」',
            },
          },
          { name: 'emotion_log', args: { level: '焦虑', note: '用户说「手都是抖的、脑子一片空白」' } },
          { name: 'claims_upsert', args: { kind: '2N', amount_fen: 0, calc_json: '{"status":"待计算"}' } },
          GOOD_CARD,
        ],
      },
      { text: '' },
    ]);

    expect(f.db.prepare('SELECT COUNT(*) AS n FROM timeline_events').get()).toEqual({ n: 1 });
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM emotion_log').get()).toEqual({ n: 1 });
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM claims').get()).toEqual({ n: 1 });
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM action_items').get()).toEqual({ n: 1 });

    expect(sink.of('record').map((e) => e.data.tool)).toEqual(['timeline_add', 'emotion_log', 'claims_upsert']);
    expect(sink.of('action')).toHaveLength(1);
  });

  it('行动卡按 source_message_id 回指本轮 assistant 消息（「这条为什么要做」）', async () => {
    const { f, result } = await turn([{ text: 'x', tools: [GOOD_CARD] }]);
    const row = f.db.prepare('SELECT source_message_id FROM action_items').get() as { source_message_id: number };
    expect(row.source_message_id).toBe((result as RunTurnResult).messageId);
  });

  it('正文与用量回填进 messages，断线重连能分辨「生成中」与「已完成」', async () => {
    const { f, result } = await turn([{ text: '手抖是正常的。', tools: [GOOD_CARD] }]);
    const row = f.db.prepare('SELECT role, content, tokens_json FROM messages ORDER BY id').all() as {
      role: string;
      content: string | null;
      tokens_json: string | null;
    }[];
    expect(row.map((r) => r.role)).toEqual(['user', 'assistant']);
    expect(row[1].content).toBe('手抖是正常的。');
    // 计费键 + 四桶一起存：billing 对账要的是「按哪个键算、各桶多少」。
    // 200/40 = 两次往返（第一次带工具调用，回喂后又跑一次），tool-loop 每一跳都要付钱。
    expect(JSON.parse(row[1].tokens_json!)).toMatchObject({
      model: 'DeepSeek-V4-Pro-0813',
      usage: { prompt: 200, completion: 40 },
    });
    expect((result as RunTurnResult).text).toBe('手抖是正常的。');
  });
});

describe('收口检查：每轮必产出行动卡（charter §2）', () => {
  it('模型忘了开卡 → 补救一轮补上，且补救轮的正文不下发给用户', async () => {
    const { f, sink, result } = await turn([
      { text: '这是一段没有收口的回复。' },
      { text: '不该出现在用户屏幕上的补救话', tools: [GOOD_CARD] },
    ]);
    expect((result as RunTurnResult).actionCards).toBe(1);
    expect((result as RunTurnResult).actionCardMissing).toBe(false);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM action_items').get()).toEqual({ n: 1 });
    expect(sink.text).toBe('这是一段没有收口的回复。');
    expect(sink.text).not.toContain('补救话');
  });

  it('补救轮的指令明确要求「只调 action_card、不要再输出正文」', async () => {
    const { provider } = await turn([{ text: '没收口' }, { tools: [GOOD_CARD] }]);
    const repairPrompt = provider.calls[1].at(-1)!;
    expect(repairPrompt.role).toBe('system');
    expect(repairPrompt.content).toContain('收口检查未通过');
    expect(repairPrompt.content).toContain('只调用 action_card');
  });

  it('补救后仍没有卡 → 如实发 ACTION_CARD_MISSING，绝不自己编一张凑数', async () => {
    const { f, sink, result } = await turn([{ text: '还是没收口' }, { text: '还是没有' }]);
    expect((result as RunTurnResult).actionCardMissing).toBe(true);
    expect(sink.of('notice').map((e) => e.data.code)).toContain('ACTION_CARD_MISSING');
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM action_items').get()).toEqual({ n: 0 });
  });

  it('已经开过卡就不触发补救（不白烧一次调用）', async () => {
    const { provider } = await turn([{ text: '好', tools: [GOOD_CARD] }, { text: '' }]);
    // 第一轮有工具调用 → 回喂后跑第二轮 → 第二轮无工具调用即收尾，总共 2 次，没有第 3 次补救
    expect(provider.rounds).toBe(2);
  });
});

describe('危机响应：心理危机资源卡强制注入（charter §5）', () => {
  const CRISIS = '有时候半夜想，要是人没了是不是就不用还房贷了，也不用对不起爸妈了。就是想想，你别紧张。';
  /** 一张只按 id 取得到、检索关键词完全够不着的资源卡——正是真实世界里的情形 */
  const RESOURCE_PACK = {
    ...FIXTURE_PACK,
    id: CRISIS_RESOURCE_PACK_ID,
    type: '数据卡',
    title: '北京免费求助资源卡',
    // 一卡两面：正文散文服务人与模型（模型要照抄号码给用户），facts 服务代码。
    // 真实卡两面都有号码，夹具必须同形——否则测不出「模型手里有没有号码」。
    body: '## 心理热线\n\n- 12356 全国统一心理援助热线（24 小时）\n- 座机 800-810-1117 / 手机 010-82951332（回龙观医院）',
    // 代码只读这一面
    facts: {
      hotlines: [
        { name: '全国统一心理援助热线', phone: '12356', category: 'crisis' as const, status: 'usable' as const, hours: '24小时' },
        { name: '北京心理援助热线·座机线（回龙观医院）', phone: '800-810-1117', category: 'crisis' as const, status: 'usable' as const },
        { name: '北京心理援助热线·手机线（回龙观医院）', phone: '010-82951332', category: 'crisis' as const, status: 'usable' as const },
      ],
    },
  };
  /** search 恒空（模拟「危机表述与资源卡用词没有交集」），只有 get 拿得到 */
  const idOnlySearcher = {
    search: () => [],
    get: (id: string) => (id === CRISIS_RESOURCE_PACK_ID ? RESOURCE_PACK : undefined),
  };

  /** 跑一轮危机对话，模型段回放指定正文 */
  async function turnCrisis(modelText: string) {
    const f = makeAgentFixture();
    const sink = makeSink();
    const provider = scriptedProvider([{ text: modelText, tools: [GOOD_CARD] }, { text: '' }]);
    const result = await runTurn({
      db: f.db, caseId: f.caseId, userId: f.userId, message: CRISIS,
      provider, searcher: idOnlySearcher, emit: sink.emit,
    });
    return { f, sink, provider, result };
  }

  it('用户说出自伤念头时，资源卡即使检索零命中也会被硬取进 system prompt', async () => {
    const { provider } = await turn([{ text: '我在。', tools: [GOOD_CARD] }], {
      message: CRISIS,
      searcher: idOnlySearcher,
    });
    const system = provider.calls[0][0].content;
    // 三个号码逐字进上下文——C04 S08 的判定是逐字比对，差一个字符即 FAIL
    expect(system).toContain('12356');
    expect(system).toContain('800-810-1117');
    expect(system).toContain('010-82951332');
  });

  it('危机指令排在 charter 之后、案件档案之前（不能被问诊/行动卡纪律稀释）', async () => {
    const { provider } = await turn([{ text: '我在。', tools: [GOOD_CARD] }], {
      message: CRISIS,
      searcher: idOnlySearcher,
    });
    const system = provider.calls[0][0].content;
    expect(system).toContain('【危机响应 · 本轮最高优先级');
    expect(system.indexOf('【危机响应')).toBeLessThan(system.indexOf('## 案件档案'));
    expect(system.indexOf('【危机响应')).toBeLessThan(system.indexOf('## 本轮输出纪律'));
  });

  it('普通倾诉（没有自伤表述）不触发——资源卡一案只有一次，不能浪费在情绪低谷上', async () => {
    const { provider } = await turn([{ text: '我在。', tools: [GOOD_CARD] }], {
      message: '今天又被拒了。我是不是真的很没用，35岁不到就已经废了。',
      searcher: idOnlySearcher,
    });
    const system = provider.calls[0][0].content;
    expect(system).not.toContain('【危机响应');
    expect(system).not.toContain('12356');
  });

  it('资源卡取不到时发 notice——这是知识库故障，不是「没检索到」，必须有人看见', async () => {
    const { sink } = await turn([{ text: '我在。', tools: [GOOD_CARD] }], {
      message: CRISIS,
      searcher: { search: () => [], get: () => undefined },
    });
    const notice = sink.of('notice').find((e) => e.data.message.includes(CRISIS_RESOURCE_PACK_ID));
    expect(notice).toBeDefined();
    expect(notice!.data.code).toBe('KNOWLEDGE_UNAVAILABLE');
  });

  it('窗内也必须注入：本轮触发危机就一定给号码，绝不让用户回头翻记录', async () => {
    const f = makeAgentFixture();
    // 模拟「1 小时前已给过卡」——落在 24h 冷却窗内
    f.db
      .prepare("INSERT INTO timeline_events (case_id, happened_at, kind, title) VALUES (?, datetime('now','-1 hour'), '系统动作', ?)")
      .run(f.caseId, CRISIS_CARD_MARKER);

    const sink = makeSink();
    const provider = scriptedProvider([{ text: '我在。', tools: [GOOD_CARD] }]);
    await runTurn({
      db: f.db,
      caseId: f.caseId,
      userId: f.userId,
      message: CRISIS,
      provider,
      searcher: idOnlySearcher,
      emit: sink.emit,
    });
    const system = provider.calls[0][0].content;
    // 卡照进上下文
    expect(system).toContain('12356');
    expect(system).toContain('800-810-1117');
    // 但指令切换成「别重印整张，用一句话重述号码」——且它紧贴卡本身（见下一条用例）
    expect(system).toContain('不要再整张重复');
    expect(system).toContain('仍然必须出现在这一轮回复里');
  });

  it('「别重印整张卡」紧贴卡内容下发，不散落在通用指令区', async () => {
    const f = makeAgentFixture();
    f.db
      .prepare("INSERT INTO timeline_events (case_id, happened_at, kind, title) VALUES (?, datetime('now','-1 hour'), '系统动作', ?)")
      .run(f.caseId, CRISIS_CARD_MARKER);

    const sink = makeSink();
    const provider = scriptedProvider([{ text: '我在。', tools: [GOOD_CARD] }]);
    await runTurn({
      db: f.db,
      caseId: f.caseId,
      userId: f.userId,
      message: CRISIS,
      provider,
      searcher: idOnlySearcher,
      emit: sink.emit,
    });
    const system = provider.calls[0][0].content;
    const noteAt = system.indexOf('本卡使用限制');
    const cardAt = system.indexOf('800-810-1117');
    expect(noteAt).toBeGreaterThan(-1);
    // 限制说明紧跟在卡的号码之后，而不是飘在开头的通用指令区
    expect(noteAt).toBeGreaterThan(cardAt);
    expect(system.slice(cardAt, noteAt).length).toBeLessThan(400);
    expect(system).toContain('仍然必须出现在这一轮回复里');
  });

  it('确定性首段先行：模型被调用**之前**用户就拿到号码（时序断言）', async () => {
    const f = makeAgentFixture();
    const sink = makeSink();
    const probe = {
      name: 'deepseek' as const,
      model: 'x',
      billingModel: 'x',
      deltasBeforeCall: 0,
      async chatStream() {
        (probe as { deltasBeforeCall: number }).deltasBeforeCall = sink.of('delta').length;
        return (async function* () {
          yield '模型正文';
          return { finishReason: 'stop', toolCalls: [], usage: { model: 'x', usage: { prompt: null, completion: null, cachedRead: null, cachedWrite: null } } };
        })();
      },
    };
    await runTurn({
      db: f.db, caseId: f.caseId, userId: f.userId, message: CRISIS,
      provider: probe as never, searcher: idOnlySearcher, emit: sink.emit,
    });
    // 调模型时已经发过首段，且首段里就有号码
    expect(probe.deltasBeforeCall).toBe(1);
    const first = sink.of('delta')[0];
    expect(first.data.deterministic).toBe(true);
    expect(first.data.text).toContain('12356');
    expect(first.data.text).toContain('800-810-1117');
  });

  it('首段标 deterministic，心跳不因它停（模型段还没开始出字）', async () => {
    const { startHeartbeat } = await import('../events');
    const pings: number[] = [];
    const hb = startHeartbeat((e) => { if (e.event === 'ping') pings.push(1); }, { intervalMs: 1000 });
    hb.observe({ event: 'delta', data: { text: '首段', deterministic: true } });
    // 确定性首段不停心跳
    hb.observe({ event: 'delta', data: { text: '模型正文' } });
    hb.stop();
    expect(pings).toHaveLength(0); // 只验不抛错；停止语义由 heartbeat.test.ts 逐拍验
  });

  it('模型段非流式：过闸干净才一次性下发', async () => {
    const { sink } = await turnCrisis('我听见了，今晚别一个人待着。');
    const modelDeltas = sink.of('delta').filter((d) => !d.data.deterministic);
    expect(modelDeltas).toHaveLength(1); // 一次性，不是逐字
    expect(modelDeltas[0].data.text).toContain('今晚别一个人待着');
  });

  it('闸命中 → 剥除那句，其余照常下发', async () => {
    const { sink, result } = await turnCrisis(
      '我听见了。你走了他们怎么办？现在告诉我你在哪、身边有没有人。',
    );
    const body = sink.of('delta').filter((d) => !d.data.deterministic).map((d) => d.data.text).join('');
    expect(body).not.toContain('你走了他们怎么办');
    expect(body).toContain('现在告诉我你在哪');
    expect((result as RunTurnResult).text).not.toContain('你走了他们怎么办');
    expect(sink.of('notice').map((e) => e.data.code)).toContain('EMOTIONAL_LEVERAGE_DETECTED');
  });

  it('剥完仍命中 → 回落确定性安全回复，模型的话一个字都不下发', async () => {
    // 整段都是杠杆句，剥完为空
    const { sink } = await turnCrisis('你走了他们怎么办。想想你父母怎么办。');
    const body = sink.of('delta').filter((d) => !d.data.deterministic).map((d) => d.data.text).join('');
    expect(body).not.toContain('怎么办');
    expect(body).toContain('告诉我你此刻在哪');
    expect(sink.of('notice').some((e) => e.data.message.includes('回落'))).toBe(true);
  });

  it('正向表述放行，不误伤', async () => {
    const ok = '家人都在等你回家，你身边有人在乎你。现在告诉我你在哪。';
    const { sink } = await turnCrisis(ok);
    const body = sink.of('delta').filter((d) => !d.data.deterministic).map((d) => d.data.text).join('');
    expect(body).toBe(ok);
    expect(sink.of('notice').map((e) => e.data.code)).not.toContain('EMOTIONAL_LEVERAGE_DETECTED');
  });

  it('不够格时**生成前**就禁掉付费咨询推介（流式轮事后剥句救不回已看到的）', async () => {
    const { provider } = await turn([{ text: 'x', tools: [GOOD_CARD] }]);
    const system = provider.calls[0][0].content;
    expect(system).toContain('本轮禁止提及付费心理咨询');
    expect(system).toContain('趁人之危');
    expect(system).toContain('给**免费公益资源**');
  });

  it('同一天两条不算「持续」——前置禁令仍在（持续的语义在时间跨度）', async () => {
    const f = makeAgentFixture();
    for (let i = 0; i < 2; i++) {
      f.db.prepare("INSERT INTO emotion_log (case_id, level, note, created_at) VALUES (?, '严重', 'x', '2026-08-20 09:00:00')").run(f.caseId);
    }
    const sink = makeSink();
    const provider = scriptedProvider([{ text: 'x', tools: [GOOD_CARD] }]);
    await runTurn({
      db: f.db, caseId: f.caseId, userId: f.userId, message: '我最近很难受',
      provider, emit: sink.emit,
    });
    expect(provider.calls[0][0].content).toContain('本轮禁止提及付费心理咨询');
  });

  it('跨两个自然日的两条才算「持续」，前置禁令解除', async () => {
    const f = makeAgentFixture();
    for (const day of ['2026-08-19 22:00:00', '2026-08-20 09:00:00']) {
      f.db.prepare("INSERT INTO emotion_log (case_id, level, note, created_at) VALUES (?, '严重', 'x', ?)").run(f.caseId, day);
    }
    const sink = makeSink();
    const provider = scriptedProvider([{ text: 'x', tools: [GOOD_CARD] }]);
    await runTurn({
      db: f.db, caseId: f.caseId, userId: f.userId, message: '我最近很难受',
      provider, emit: sink.emit,
    });
    expect(provider.calls[0][0].content).not.toContain('本轮禁止提及付费心理咨询');
  });

  it('已转介过则仍然禁止（spec §10 一案最多一次）', async () => {
    const f = makeAgentFixture();
    for (let i = 0; i < 3; i++) {
      f.db.prepare("INSERT INTO emotion_log (case_id, level, note, referred_nbdpsy) VALUES (?, '严重', 'x', ?)").run(f.caseId, i === 0 ? 1 : 0);
    }
    const sink = makeSink();
    const provider = scriptedProvider([{ text: 'x', tools: [GOOD_CARD] }]);
    await runTurn({
      db: f.db, caseId: f.caseId, userId: f.userId, message: '我最近很难受',
      provider, emit: sink.emit,
    });
    expect(provider.calls[0][0].content).toContain('本轮禁止提及付费心理咨询');
  });

  it('模型仍然提了 → 输出侧剥除 + 发 notice（兜底）', async () => {
    const f = makeAgentFixture();
    const sink = makeSink();
    const provider = scriptedProvider([
      { text: '我在。如果你愿意，我可以帮你约 NBDpsy。现在告诉我你在哪。', tools: [GOOD_CARD] },
      { text: '' },
    ]);
    const res = await runTurn({
      db: f.db, caseId: f.caseId, userId: f.userId, message: '我最近很难受',
      provider, emit: sink.emit,
    });
    expect((res as RunTurnResult).text).not.toContain('NBDpsy');
    expect(sink.of('notice').map((e) => e.data.code)).toContain('NBDPSY_PITCH_BLOCKED');
  });

  it('危机轮判为 critical 档（这一轮回错话的代价没有上限）', async () => {
    const { sink } = await turn([{ text: '我在。', tools: [GOOD_CARD] }], {
      message: CRISIS,
      searcher: idOnlySearcher,
    });
    expect(sink.of('meta')[0].data.task_class).toBe('critical');
  });
});

describe('检索缺失降级', () => {
  it('检索器没注入时，工具调用走保守路径并发 KNOWLEDGE_UNAVAILABLE', async () => {
    const { sink } = await turn(
      [{ text: 'x', tools: [{ name: 'knowledge_search', args: { query: '客观情况' } }] }, { text: 'y', tools: [GOOD_CARD] }],
      { searcher: undefined },
    );
    expect(sink.of('notice').map((e) => e.data.code)).toContain('KNOWLEDGE_UNAVAILABLE');
  });

  it('没有检索器时 system prompt 里不会凭空出现依据段', async () => {
    const { provider } = await turn([{ text: 'x', tools: [GOOD_CARD] }], { searcher: undefined });
    expect(provider.calls[0][0].content).not.toContain('本轮检索到的依据');
  });

  // ⭐核心条的 S2/S4 两档要真的接到线上：夹具案子档案是空的（S1 空），
  // 这条走的正是首诊形态。单测只证了函数对，接线断了函数再对也没用。
  describe('首诊⭐核心条（S1 空时由 S2/S4 撑起）', () => {
    /** 带逐字原文的法条卡——S2 的候选池只认 facts.statute_quotes */
    const QUOTED_PACK = {
      ...FIXTURE_PACK,
      id: 'statute-lhtf-jiechu-buchang-core',
      facts: { statute_quotes: [{ law: '劳动合同法', article: '第四十六条', text: '有下列情形之一的，用人单位应当向劳动者支付经济补偿：' }] },
    };

    /** ⭐那一行本身。**不能拿整份 prompt 断言条号**——引用块里本来就印着同一个条号，
     *  那样断言在⭐段整段消失时照样通过（本次要修的正是"⭐段不出现"）。 */
    const starLine = (system: string) => system.split('本轮核心依据条')[1]?.split('\n')[0] ?? '';

    it('首轮空档案 + 检索到带原文的法条卡 → system prompt 里⭐段非空', async () => {
      const { provider } = await turn([{ text: 'x', tools: [GOOD_CARD] }], { searcher: fixtureSearcher([QUOTED_PACK]) });
      expect(provider.calls[0][0].content).toContain('本轮核心依据条');
      expect(starLine(provider.calls[0][0].content)).toContain('第四十六条');
    });

    describe('★S4 用户点名走的是用户原话——原话没接进来这条就会挂', () => {
      // 46 排在得分序第 4 位，占不到 S2 的 3 条上限；进不进⭐**只取决于用户有没有点它的名**
      const searcher = fixtureSearcher([{ ...QUOTED_PACK, facts: { statute_quotes: [
        { law: '劳动合同法', article: '第三十九条', text: '劳动者有下列情形之一的……' },
        { law: '劳动合同法', article: '第四十条', text: '有下列情形之一的……' },
        { law: '劳动合同法', article: '第四十一条', text: '有下列情形之一，需要裁减人员……' },
        { law: '劳动合同法', article: '第四十六条', text: '有下列情形之一的，用人单位应当向劳动者支付经济补偿：' },
      ] } }]);

      it('没点名 → 只有得分序前 3 条，46 不在⭐里', async () => {
        const { provider } = await turn([{ text: 'x', tools: [GOOD_CARD] }], { searcher });
        expect(starLine(provider.calls[0][0].content)).not.toContain('第四十六条');
      });

      it('点名「第46条」→ 46 进⭐，且不挤掉前 3 条', async () => {
        const { provider } = await turn([{ text: 'x', tools: [GOOD_CARD] }], { searcher, message: '公司说按第46条给补偿，这对吗' });
        const star = starLine(provider.calls[0][0].content);
        expect(star).toContain('第四十六条');
        expect(star).toContain('第三十九条');
      });
    });

    it('检索到的卡没有 statute_quotes → 候选池空 → ⭐段照旧不出现', async () => {
      const { provider } = await turn([{ text: 'x', tools: [GOOD_CARD] }]);
      expect(provider.calls[0][0].content).not.toContain('本轮核心依据条');
    });

    // ── A 件：候选池取料面 = 预检索注入包 ∪ 工具通道已注入的卡 ──
    //
    // 【为什么必须补这条通路】8101783 批 S03 三跑的离线复算：预检索 6 张全是话术/SOP/判例卡，
    // **一张带 statute_quotes 的法条卡都没有**；带逐字原文的卡**全部**是模型自己调
    // knowledge_search 拉回来的。只在注入侧标⭐，那一轮模型永远收不到"这条要引全"的指令。
    it('★工具通道拉回来的法条卡也带⭐（注入侧一张 statute 卡都没有时，这是唯一的通路）', async () => {
      const { provider } = await turn(
        [
          { text: '先查依据。', tools: [{ name: 'knowledge_search', args: { query: '经济补偿' } }] },
          { text: '据此……', tools: [GOOD_CARD] },
        ],
        // 预检索恒空 → S1、S2 在 system prompt 侧都空；卡只能从工具通道进来
        { searcher: { search: (q: string) => (q === '经济补偿' ? [QUOTED_PACK] : []), get: () => undefined } },
      );
      // 第二轮的消息里带着工具返回，⭐ 必须在 citation_guide 里
      const toolMsg = provider.calls[1].filter((m) => m.role === 'tool').map((m) => m.content).join('\n');
      expect(toolMsg).toContain('本轮核心依据条');
      expect(toolMsg).toContain('第四十六条');
    });

    // ── B 件：S3 场景映射端到端 ──
    // 夹具案子 stage='已收通知'，映射表该档声明 §40/§46/§87。
    // 单测证了函数对，这条证**映射卡真的被 orchestrator 取到并递进去了**——接线断了函数再对也没用。
    it('★S3 映射端到端：得分序靠前的非核心条被映射挤出⭐', async () => {
      const quotes = [
        { law: '劳动合同法', article: '第三十九条', text: '劳动者有下列情形之一的……' },
        { law: '劳动合同法', article: '第四十一条', text: '有下列情形之一，需要裁减人员……' },
        { law: '劳动合同法', article: '第四十条', text: '有下列情形之一的，用人单位提前三十日……' },
        { law: '劳动合同法', article: '第四十六条', text: '有下列情形之一的，用人单位应当支付经济补偿：' },
        { law: '劳动合同法', article: '第八十七条', text: '用人单位违反本法规定解除或者终止劳动合同的……' },
      ];
      const real = createKnowledgeSearcher();
      const { provider } = await turn([{ text: 'x', tools: [GOOD_CARD] }], {
        searcher: {
          search: () => [{ ...QUOTED_PACK, facts: { statute_quotes: quotes } }],
          // 映射卡按 id 硬取，走真库；其余 id 不供给
          get: (id: string) => (id === CORE_ARTICLE_MAP_PACK_ID ? real.get?.(id) : undefined),
        },
      });
      const star = provider.calls[0][0].content.split('本轮核心依据条')[1]?.split('\n')[0] ?? '';
      expect(star).toContain('第四十条');
      expect(star).toContain('第四十六条');
      expect(star).toContain('第八十七条');
      // 得分序第 1、2 位但不在映射里 → 被挤出
      expect(star).not.toContain('第三十九条');
      expect(star).not.toContain('第四十一条');
    });

    it('工具通道拉回来的卡没有 statute_quotes → 仍然不标⭐（不无中生有）', async () => {
      const { provider } = await turn(
        [
          { text: '先查依据。', tools: [{ name: 'knowledge_search', args: { query: '话术' } }] },
          { text: '据此……', tools: [GOOD_CARD] },
        ],
        { searcher: { search: () => [FIXTURE_PACK], get: () => undefined } },
      );
      const toolMsg = provider.calls[1].filter((m) => m.role === 'tool').map((m) => m.content).join('\n');
      expect(toolMsg).not.toContain('本轮核心依据条');
    });
  });
});

describe('事件流形状与归属', () => {
  it('meta 开头、done 收尾、usage 紧挨在 done 之前', async () => {
    const { sink } = await turn([{ text: 'x', tools: [GOOD_CARD] }]);
    const kinds = sink.events.map((e) => e.event);
    expect(kinds[0]).toBe('meta');
    expect(kinds.at(-1)).toBe('done');
    expect(kinds.at(-2)).toBe('usage');
  });

  it('meta 在**调用模型之前**就发出——推理模型首字前可能静默数分钟，前端靠它渲染等待态', async () => {
    const f = makeAgentFixture();
    const sink = makeSink();
    /** 一个在 chatStream 被调用那一刻断言「meta 已经发过了」的假 provider */
    const probe = {
      name: 'deepseek' as const,
      model: 'deepseek-v4-pro',
      billingModel: 'DeepSeek-V4-Pro-0813',
      metaSeenBeforeCall: false,
      async chatStream() {
        (probe as { metaSeenBeforeCall: boolean }).metaSeenBeforeCall = sink.of('meta').length === 1;
        return (async function* () {
          yield 'x';
          return { finishReason: 'stop', toolCalls: [], usage: { model: 'x', usage: { prompt: null, completion: null, cachedRead: null, cachedWrite: null } } };
        })();
      },
    };
    await runTurn({
      db: f.db,
      caseId: f.caseId,
      userId: f.userId,
      message: '刚收到辞退邮件',
      provider: probe as never,
      emit: sink.emit,
    });
    expect(probe.metaSeenBeforeCall).toBe(true);
    // 且它自带路由结果，一帧两用：既是「已受理」信号，也告诉前端跑在哪个模型上
    expect(sink.of('meta')[0].data).toMatchObject({ model: 'deepseek-v4-pro', degraded: false });
  });

  it('meta 带足前端要的字段，且如实标出是否降级', async () => {
    const { sink, result } = await turn([{ text: 'x', tools: [GOOD_CARD] }]);
    const meta = sink.of('meta')[0].data;
    expect(meta).toMatchObject({ mode: '问诊', intake_stage: 'A', task_class: 'critical', degraded: false });
    expect(meta.message_id).toBe((result as RunTurnResult).messageId);
  });

  it('usage 累加 tool-loop 全部往返，没拿到的桶留 null（不用 0 冒充）', async () => {
    // 一轮 100/20；带工具调用会多跑一次回喂轮，故 200/40。DeepSeek 无缓存写档，恒 null。
    const { sink } = await turn([{ text: 'x', tools: [GOOD_CARD] }]);
    expect(sink.of('usage')[0].data).toMatchObject({ prompt: 200, completion: 40, cached_write: null });
  });

  it('别人的案子按「不存在」拒绝，不承认存在性', async () => {
    const f = makeAgentFixture();
    const sink = makeSink();
    const res = await runTurn({
      db: f.db,
      caseId: f.otherCaseId,
      userId: f.userId,
      message: '看看别人的案子',
      provider: scriptedProvider([]),
      emit: sink.emit,
    });
    expect(res).toMatchObject({ ok: false, status: 404, errorCode: 'CASE_NOT_FOUND' });
    expect(sink.events).toHaveLength(0);
  });

  it('空消息在开流前就拒掉', async () => {
    const f = makeAgentFixture();
    const sink = makeSink();
    const res = await runTurn({
      db: f.db,
      caseId: f.caseId,
      userId: f.userId,
      message: '   ',
      provider: scriptedProvider([]),
      emit: sink.emit,
    });
    expect(res).toMatchObject({ ok: false, errorCode: 'EMPTY_MESSAGE' });
  });
});

describe('模式与会话', () => {
  it('首诊未走完默认「问诊」，走完了默认「陪跑」并给前情提要', async () => {
    const { provider } = await turn([{ text: 'x', tools: [GOOD_CARD] }]);
    expect(provider.calls[0][0].content).toContain('当前会话模式：问诊');

    const f = makeAgentFixture();
    // 把档案填到 done
    f.db.prepare("UPDATE cases SET goal='拿2N', bottom_line='不低于N' WHERE id=?").run(f.caseId);
    f.db.prepare("INSERT INTO company_profiles (case_id, name, role) VALUES (?, '某公司', '签约主体')").run(f.caseId);
    const ins = f.db.prepare('INSERT INTO timeline_events (case_id, happened_at, kind, title) VALUES (?, ?, ?, ?)');
    for (let i = 0; i < 3; i++) ins.run(f.caseId, `2026-08-1${i} 00:00:00`, '公司动作', `事件${i}`);
    // D 档落痕走 threads.intake_stage（WS1 增列），不再是时间线标记
    const intakeThread = agentDb.ensureThread(f.db, f.caseId, '问诊');
    agentDb.updateIntakeStage(f.db, intakeThread.id, 'done');

    const sink = makeSink();
    const provider2 = scriptedProvider([{ text: 'x', tools: [GOOD_CARD] }]);
    const res = await runTurn({
      db: f.db,
      caseId: f.caseId,
      userId: f.userId,
      message: '今天有什么要做的',
      provider: provider2,
      emit: sink.emit,
    });
    expect((res as RunTurnResult).mode).toBe('陪跑');
    expect(provider2.calls[0][0].content).toContain('开场前情提要');
  });

  it('同案同模式复用同一个 thread，第二轮能看见第一轮的对话', async () => {
    const f = makeAgentFixture();
    const script = () => scriptedProvider([{ text: '第一轮回复', tools: [GOOD_CARD] }, { text: '' }]);
    const base = { db: f.db, caseId: f.caseId, userId: f.userId, emit: makeSink().emit, mode: '问诊' };
    const first = (await runTurn({ ...base, message: '第一句', provider: script() })) as RunTurnResult;

    const p2 = scriptedProvider([{ text: '第二轮回复', tools: [GOOD_CARD] }, { text: '' }]);
    const second = (await runTurn({ ...base, message: '第二句', provider: p2 })) as RunTurnResult;

    expect(second.threadId).toBe(first.threadId);
    const history = p2.calls[0].map((m) => m.content);
    expect(history).toContain('第一句');
    expect(history).toContain('第一轮回复');
    // 本轮消息只出现一次，不会因为「先落库再取历史」而重复
    expect(history.filter((c) => c === '第二句')).toHaveLength(1);
  });
});
