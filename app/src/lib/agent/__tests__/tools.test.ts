// app/src/lib/agent/__tests__/tools.test.ts
// 工具层的闸门。这些断言对应 charter 里能机械判定的红线——
// 挡不住就不是「模型没遵守提示词」，是我们的代码放它过去了。
import { describe, expect, it } from 'vitest';

import * as agentStore from '@/lib/db/agent';
import { CitationGuard } from '../citation-guard';
import { executeTool, MAX_ACTION_CARDS, newTurnState, type AgentToolContext } from '../tools';
import { KNOWLEDGE_MISS_DIRECTIVE } from '../retrieval';
import { FIXTURE_PACK, fixtureSearcher, makeAgentFixture, makeSink } from './fixtures';

function makeCtx(over: Partial<AgentToolContext> = {}) {
  const f = makeAgentFixture();
  const sink = makeSink();
  const ctx: AgentToolContext = {
    db: f.db,
    caseId: f.caseId,
    userId: f.userId,
    threadId: 1,
    sourceMessageId: null,
    citations: new CitationGuard(),
    crisisCardAlreadyGiven: false,
    searcher: fixtureSearcher(),
    state: newTurnState(),
    emit: sink.emit,
    ...over,
  };
  return { f, sink, ctx };
}

/** 一张合规的行动卡参数 */
function card(n: number) {
  return {
    what: `第 ${n} 件事`,
    how: '照读："请公司出具书面通知。" 绝不能说："我确实做得不好。"',
    why: '书面材料是后续举证的基础（statute-lhtf-38-beipo-jiechu）',
    due_at: '2026-08-19T18:00:00+08:00',
    priority: n,
  };
}

function run(ctx: AgentToolContext, name: string, args: Record<string, unknown>) {
  return executeTool(name, JSON.stringify(args), ctx);
}

describe('action_card：每轮 ≤3 张（charter §2）', () => {
  it('前 3 张落库，第 4 张被拒且不写库', () => {
    const { f, sink, ctx } = makeCtx();
    for (let i = 1; i <= MAX_ACTION_CARDS; i++) expect(run(ctx, 'action_card', card(i)).ok).toBe(true);

    const fourth = run(ctx, 'action_card', card(4));
    expect(fourth.ok).toBe(false);
    expect(fourth.content).toContain('上限');

    const rows = f.db.prepare('SELECT * FROM action_items WHERE case_id = ?').all(f.caseId);
    expect(rows).toHaveLength(MAX_ACTION_CARDS);
    expect(sink.of('notice').map((e) => e.data.code)).toContain('ACTION_CARD_CAPPED');
    // 事件也只发了 3 个，前端不会渲染出第 4 张幽灵卡
    expect(sink.of('action')).toHaveLength(MAX_ACTION_CARDS);
  });

  it('做什么/怎么做/为什么/截止时间缺一不可', () => {
    const { ctx } = makeCtx();
    const base = card(1);
    for (const missing of ['what', 'how', 'why'] as const) {
      const args = { ...base, [missing]: '' };
      expect(run(ctx, 'action_card', args).ok).toBe(false);
    }
    expect(run(ctx, 'action_card', { ...base, due_at: '今天下班前' }).ok).toBe(false);
  });

  it('detail 里同时留下「怎么做」与「为什么」，下轮追问才有依据可讲', () => {
    const { f, ctx } = makeCtx();
    run(ctx, 'action_card', card(1));
    const row = f.db.prepare('SELECT detail FROM action_items WHERE case_id = ?').get(f.caseId) as { detail: string };
    expect(row.detail).toContain('怎么做：');
    expect(row.detail).toContain('为什么：');
    expect(row.detail).toContain('绝不能说');
  });
});

describe('draft_write：发给公司的文书必须附发送后果（charter 红线 5）', () => {
  const draft = { kind: '被迫解除通知', title: '被迫解除劳动合同通知书', content: '致：某公司……' };

  it('缺 send_consequences 直接拒绝，且一个字都不写库', () => {
    const { f, ctx } = makeCtx();
    const res = run(ctx, 'draft_write', draft);
    expect(res.ok).toBe(false);
    expect(res.content).toContain('send_consequences');
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM drafts').get()).toEqual({ n: 0 });
  });

  it('给了后果说明才落库，正文自动带上「发出前必读」四条', () => {
    const { f, sink, ctx } = makeCtx();
    const res = run(ctx, 'draft_write', { ...draft, send_consequences: '发出即解除劳动关系，不可撤回' });
    expect(res.ok).toBe(true);

    const row = f.db.prepare('SELECT * FROM drafts WHERE case_id = ?').get(f.caseId) as {
      content: string;
      status: string;
    };
    expect(row.content).toContain('【发出前必读】');
    expect(row.content).toContain('发出即解除劳动关系，不可撤回');
    expect(row.content).toContain('无法撤回');
    expect(row.content).toContain('本系统不会替你发出');
    // status 恒 draft：不存在「已发出」这个状态，发不发只有用户能决定
    expect(row.status).toBe('draft');
    expect(sink.of('draft')[0].data.requires_confirmation).toBe(true);
  });

  it('给用户自己用的文书（谈判话术）不强制后果说明，也不加尾注', () => {
    const { f, ctx } = makeCtx();
    expect(run(ctx, 'draft_write', { kind: '谈判话术', title: '明天约谈话术', content: '只听多问少答' }).ok).toBe(true);
    const row = f.db.prepare('SELECT content FROM drafts WHERE case_id = ?').get(f.caseId) as { content: string };
    expect(row.content).not.toContain('【发出前必读】');
  });

  it('同类文书再写一次是新版本，旧稿留着', () => {
    const { f, ctx } = makeCtx();
    const args = { ...draft, send_consequences: '不可撤回' };
    run(ctx, 'draft_write', args);
    run(ctx, 'draft_write', { ...args, content: '改过的第二稿' });
    const rows = f.db.prepare('SELECT version FROM drafts WHERE case_id = ? ORDER BY version').all(f.caseId);
    expect(rows).toEqual([{ version: 1 }, { version: 2 }]);
  });
});

describe('emotion_log：心理转介一案最多一次（spec §10）', () => {
  it('第一次严重档转介成功，第二次被拒并发 notice', () => {
    const { f, sink, ctx } = makeCtx();
    expect(JSON.parse(run(ctx, 'emotion_log', { level: '严重', note: '提到不想活', refer_nbdpsy: true }).content).referred).toBe(true);

    const second = JSON.parse(run(ctx, 'emotion_log', { level: '严重', note: '仍然低落', refer_nbdpsy: true }).content);
    expect(second.referred).toBe(false);
    expect(sink.of('notice').map((e) => e.data.code)).toContain('REFERRAL_ALREADY_USED');
    expect(agentStore.hasReferredNbdpsy(f.db, f.caseId)).toBe(true);
  });

  it('情绪只是「低落」时不许转介（引流红线：不趁人之危）', () => {
    const { ctx } = makeCtx();
    const res = JSON.parse(run(ctx, 'emotion_log', { level: '低落', refer_nbdpsy: true }).content);
    expect(res.referred).toBe(false);
    expect(res.note).toContain('引流红线');
  });
});

describe('knowledge_search：呈现规则覆盖工具通道（去重对象是用户看到了什么）', () => {
  const CARD = {
    id: 'data-beijing-qiuzhu-ziyuan',
    type: '数据卡',
    title: '北京免费求助资源卡',
    keywords: [],
    applies_to: [],
    region: '北京',
    confidence: '待核实',
    updated: '2026-08-19',
    body: '回龙观医院·北京心理危机研究与干预中心：12356 / 座机 800-810-1117 / 手机 010-82951332，7×24 人工接听',
  };

  it('已给过时，搜索结果里的资源卡也切成紧凑版——堵住模型自取整卡这条通道', () => {
    const { ctx } = makeCtx({ searcher: fixtureSearcher([CARD]), crisisCardAlreadyGiven: true });
    const res = JSON.parse(run(ctx, 'knowledge_search', { query: '心理热线' }).content);
    expect(res.packs[0].body).toContain('12356');
    expect(res.packs[0].body).not.toContain('回龙观'); // 整卡描述被裁掉
    expect(res.packs[0].body).toContain('不要再整张重印');
  });

  it('还没给过时，搜索结果照常给整张卡（首次需要完整信息）', () => {
    const { ctx } = makeCtx({ searcher: fixtureSearcher([CARD]), crisisCardAlreadyGiven: false });
    const res = JSON.parse(run(ctx, 'knowledge_search', { query: '心理热线' }).content);
    expect(res.packs[0].body).toContain('回龙观');
  });

  it('其余卡不受影响（规则只针对危机资源卡）', () => {
    const { ctx } = makeCtx({ crisisCardAlreadyGiven: true });
    const res = JSON.parse(run(ctx, 'knowledge_search', { query: '被迫解除' }).content);
    expect(res.packs[0].body).toBe(FIXTURE_PACK.body);
  });
});

describe('knowledge_search：检索缺失的降级路径（charter §3）', () => {
  it('命中时返回逐字原文，不做任何摘要', () => {
    const { ctx } = makeCtx();
    const res = JSON.parse(run(ctx, 'knowledge_search', { query: '被迫解除' }).content);
    expect(res.packs[0].body).toBe(FIXTURE_PACK.body);
    expect(res.packs[0].confidence).toBe('原文核实');
  });

  it('同一张卡在一轮里第二次命中只回指针，不重发全文（省 token 也省首字延迟）', () => {
    const { ctx } = makeCtx();
    run(ctx, 'knowledge_search', { query: '被迫解除' });
    const again = JSON.parse(run(ctx, 'knowledge_search', { query: '拖欠工资' }).content);
    expect(again.packs[0].body).toBeUndefined();
    expect(again.packs[0].body_omitted).toContain('已经在你的 system prompt');
    expect(again.packs[0].id).toBe(FIXTURE_PACK.id);
    // 卡本身仍算「本轮检索到的依据」，G1 的编造判定要靠它
    expect(ctx.state.retrieved).toHaveLength(1);
  });

  it('零命中时回「需要核实、先按保守做法」指令，并发 KNOWLEDGE_MISS', () => {
    const { sink, ctx } = makeCtx({ searcher: fixtureSearcher([]) });
    const res = JSON.parse(run(ctx, 'knowledge_search', { query: '查不到的东西' }).content);
    expect(res.packs).toEqual([]);
    expect(res.note).toBe(KNOWLEDGE_MISS_DIRECTIVE);
    expect(res.note).toContain('禁止写出任何具体条号');
    expect(sink.of('notice').map((e) => e.data.code)).toContain('KNOWLEDGE_MISS');
  });

  it('检索器整个没注入（lib/knowledge 未交付）时走同一条保守路径', () => {
    const { sink, ctx } = makeCtx({ searcher: undefined });
    const res = JSON.parse(run(ctx, 'knowledge_search', { query: '任意' }).content);
    expect(res.note).toBe(KNOWLEDGE_MISS_DIRECTIVE);
    expect(sink.of('notice').map((e) => e.data.code)).toContain('KNOWLEDGE_UNAVAILABLE');
  });
});

describe('deadline_set / deadline_resolve：日期由代码算，履行后停提醒', () => {
  it('模型只给锚点与类型，到期日由 lib/deadline 算出并直落 deadlines', () => {
    const { f, sink, ctx } = makeCtx();
    const res = JSON.parse(run(ctx, 'deadline_set', { rule: '起诉15日', anchor_date: '2026-08-19' }).content);
    expect(res.due_date).toBe('2026-09-03');

    const row = f.db.prepare('SELECT kind, date(due_at) AS d, derived_from, resolved_at FROM deadlines WHERE case_id = ?').get(f.caseId) as {
      kind: string; d: string; derived_from: string; resolved_at: string | null;
    };
    expect(row).toMatchObject({ kind: '起诉15日', d: '2026-09-03', resolved_at: null });
    // 推算依据可自查，且带条号原文
    expect(row.derived_from).toContain('次日起算');
    expect(row.derived_from).toContain('第五十条');
    expect(sink.of('record').map((e) => e.data.tool)).toContain('deadline_set');
  });

  it('答辩期直接落字面值 kind（deadlines.kind 无 CHECK 约束）', () => {
    const { f, ctx } = makeCtx();
    run(ctx, 'deadline_set', { rule: '答辩期15日', anchor_date: '2026-08-19' });
    const row = f.db.prepare("SELECT kind, derived_from FROM deadlines WHERE case_id = ?").get(f.caseId) as {
      kind: string; derived_from: string;
    };
    expect(row.kind).toBe('答辩期');
    expect(row.derived_from).toContain('答辩');
  });

  it('回喂内容要求模型把「未含法定节假日顺延」讲给用户', () => {
    const { ctx } = makeCtx();
    const res = JSON.parse(run(ctx, 'deadline_set', { rule: '仲裁时效', anchor_date: '2026-08-19' }).content);
    expect(res.caveats.join()).toContain('未含法定节假日顺延');
    expect(res.note).toContain('未含节假日顺延');
  });

  it('举证期限不给天数直接拒绝（不替仲裁委猜）', () => {
    const { ctx } = makeCtx();
    expect(run(ctx, 'deadline_set', { rule: '举证期限', anchor_date: '2026-08-19' }).ok).toBe(false);
    expect(run(ctx, 'deadline_set', { rule: '举证期限', anchor_date: '2026-08-19', days: 10 }).ok).toBe(true);
  });

  it('同案同类同日不重复落行（用户问两遍不该出现两条）', () => {
    const { f, ctx } = makeCtx();
    run(ctx, 'deadline_set', { rule: '起诉15日', anchor_date: '2026-08-19' });
    run(ctx, 'deadline_set', { rule: '起诉15日', anchor_date: '2026-08-19' });
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM deadlines WHERE case_id = ?').get(f.caseId)).toEqual({ n: 1 });
  });

  it('非法锚点日期回喂错误让模型改正', () => {
    const { ctx } = makeCtx();
    expect(run(ctx, 'deadline_set', { rule: '起诉15日', anchor_date: '去年八月' }).ok).toBe(false);
    expect(run(ctx, 'deadline_set', { rule: '瞎写的期限', anchor_date: '2026-08-19' }).ok).toBe(false);
  });

  it('deadline_resolve 置 resolved_at 停止提醒，重复标记被拒', () => {
    const { f, ctx } = makeCtx();
    const set = JSON.parse(run(ctx, 'deadline_set', { rule: '起诉15日', anchor_date: '2026-08-19' }).content);
    expect(run(ctx, 'deadline_resolve', { deadline_id: set.id, note: '已递起诉状' }).ok).toBe(true);

    const row = f.db.prepare('SELECT resolved_at FROM deadlines WHERE id = ?').get(set.id) as { resolved_at: string | null };
    expect(row.resolved_at).not.toBeNull();
    // 已了结的不刷新时间戳
    expect(run(ctx, 'deadline_resolve', { deadline_id: set.id }).ok).toBe(false);
  });

  it('别人案子的期限标记不了，且按「不存在」拒绝', () => {
    const { f, ctx } = makeCtx();
    const other = Number(
      f.db.prepare("INSERT INTO deadlines (case_id, kind, due_at) VALUES (?, '仲裁时效', '2027-08-19 00:00:00')").run(f.otherCaseId).lastInsertRowid,
    );
    expect(run(ctx, 'deadline_resolve', { deadline_id: other }).ok).toBe(false);
    const row = f.db.prepare('SELECT resolved_at FROM deadlines WHERE id = ?').get(other) as { resolved_at: string | null };
    expect(row.resolved_at).toBeNull();
  });
});

describe('claim_calc：算钱走计算器，结果直接落 claims', () => {
  /** C04 S14 人设：2019-03 入职、月应得 19,000 元（到手 14,000 + 报税 16,500 + 年终奖 3 万分摊） */
  const S14 = { avg_monthly_wage_fen: 1_900_000, employed_from: '2019-03-01', terminated_at: '2026-08-19' };

  it('算 N：返回金额 + 算式 + 分步 + 法条依据，并写进 claims（calc_json 留痕）', () => {
    const { f, sink, ctx } = makeCtx();
    const res = JSON.parse(run(ctx, 'claim_calc', { kind: 'N', ...S14 }).content);

    expect(res.ok).toBe(true);
    expect(res.amount_fen).toBeGreaterThan(0);
    expect(res.formula).toContain('=');
    expect(res.steps.length).toBeGreaterThan(0);
    expect(res.basis.length).toBeGreaterThan(0);

    const row = f.db.prepare('SELECT kind, amount_fen, calc_json, basis FROM claims WHERE case_id = ?').get(f.caseId) as {
      kind: string;
      amount_fen: number;
      calc_json: string;
      basis: string;
    };
    expect(row.kind).toBe('N');
    expect(row.amount_fen).toBe(res.amount_fen);
    // calc_json 必须能复算：算式与输入快照都在里面
    const stored = JSON.parse(row.calc_json);
    expect(stored.formula).toBe(res.formula);
    expect(stored.inputs.employedFrom).toBe('2019-03-01');
    expect(row.basis).toBeTruthy();
    expect(sink.of('record').map((e) => e.data.tool)).toContain('claims_upsert');
  });

  it('2N 恰为 N 的两倍（同一套输入）', () => {
    const { ctx } = makeCtx();
    const n = JSON.parse(run(ctx, 'claim_calc', { kind: 'N', ...S14 }).content);
    const n2 = JSON.parse(run(ctx, 'claim_calc', { kind: '2N', ...S14 }).content);
    expect(n2.amount_fen).toBe(n.amount_fen * 2);
  });

  it('N+1 缺 last_month_wage_fen 直接拒绝（不拿平均工资顶替）', () => {
    const { ctx } = makeCtx();
    const res = run(ctx, 'claim_calc', { kind: 'N+1', ...S14 });
    expect(res.ok).toBe(false);
    expect(res.content).toContain('last_month_wage_fen');
  });

  it('N+1 给全参数后 = N + 上月工资', () => {
    const { ctx } = makeCtx();
    const n = JSON.parse(run(ctx, 'claim_calc', { kind: 'N', ...S14 }).content);
    const n1 = JSON.parse(run(ctx, 'claim_calc', { kind: 'N+1', ...S14, last_month_wage_fen: 1_800_000 }).content);
    expect(n1.amount_fen).toBe(n.amount_fen + 1_800_000);
  });

  it('输入默认全标「用户自述」，显式声明有证据的才改标（charter §3 待证标注）', () => {
    const { ctx } = makeCtx();
    const res = JSON.parse(run(ctx, 'claim_calc', { kind: 'N', ...S14 }).content);
    expect(res.input_sources.avgMonthlyWageFen).toBe('用户自述');

    const backed = JSON.parse(
      run(ctx, 'claim_calc', { kind: 'N', ...S14, evidence_backed: ['avg_monthly_wage_fen'] }).content,
    );
    expect(backed.input_sources.avgMonthlyWageFen).toBe('证据佐证');
    expect(backed.input_sources.employedFrom).toBe('用户自述');
  });

  it('回喂内容要求模型把算式与待证状态讲给用户', () => {
    const { ctx } = makeCtx();
    const res = JSON.parse(run(ctx, 'claim_calc', { kind: 'N', ...S14 }).content);
    expect(res.note).toContain('formula');
    expect(res.note).toContain('待证');
  });

  it('非法输入（到手工资填成 0 / 日期乱写）回喂错误让模型改正，不炸整轮', () => {
    const { ctx } = makeCtx();
    expect(run(ctx, 'claim_calc', { kind: 'N', ...S14, avg_monthly_wage_fen: 0 }).ok).toBe(false);
    expect(run(ctx, 'claim_calc', { kind: 'N', ...S14, employed_from: '去年三月' }).ok).toBe(false);
  });

  it('未实装的公式（年假/加班费）明确拒绝，不返回一个瞎算的数', () => {
    const { ctx } = makeCtx();
    const res = run(ctx, 'claim_calc', { kind: '年假', ...S14 });
    expect(res.ok).toBe(false);
    expect(res.content).toContain('N');
  });
});

describe('落库工具：枚举与归属', () => {
  it('timeline_add 的 kind 不在枚举里就拒绝', () => {
    const { ctx } = makeCtx();
    const res = run(ctx, 'timeline_add', { happened_at: '2026-08-19T12:00:00Z', kind: '瞎写', title: 'x' });
    expect(res.ok).toBe(false);
    expect(res.content).toContain('公司动作');
  });

  it('case_id 由服务端注入，模型即使编一个别人的案件号也没用', () => {
    const { f, ctx } = makeCtx();
    run(ctx, 'timeline_add', {
      case_id: f.otherCaseId, // 模型硬塞的参数，schema 里根本没有这个字段
      happened_at: '2026-08-19T12:00:00Z',
      kind: '公司动作',
      title: '越权写入尝试',
    });
    const mine = f.db.prepare('SELECT COUNT(*) AS n FROM timeline_events WHERE case_id = ?').get(f.caseId);
    const theirs = f.db.prepare('SELECT COUNT(*) AS n FROM timeline_events WHERE case_id = ?').get(f.otherCaseId);
    expect(mine).toEqual({ n: 1 });
    expect(theirs).toEqual({ n: 0 });
  });

  it('资金范式：N/N+1/2N 的金额不许模型自己填，必须走 claim_calc', () => {
    const { f, ctx } = makeCtx();
    for (const kind of ['N', 'N+1', '2N']) {
      const res = run(ctx, 'claims_upsert', { kind, amount_fen: 3_100_000 });
      expect(res.ok).toBe(false);
      expect(res.content).toContain('claim_calc');
    }
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM claims').get()).toEqual({ n: 0 });

    // 传 0 只登记诉求项是允许的（还没算出来时的正常用法）
    expect(run(ctx, 'claims_upsert', { kind: '2N', amount_fen: 0, calc_json: '{"status":"待计算"}' }).ok).toBe(true);
  });

  it('资金范式：用户自述的事实性金额（欠薪本金）照常允许', () => {
    const { f, ctx } = makeCtx();
    expect(run(ctx, 'claims_upsert', { kind: '欠薪', amount_fen: 3_800_000, calc_json: '{"source":"用户自述待证"}' }).ok).toBe(true);
    const row = f.db.prepare("SELECT amount_fen FROM claims WHERE kind = '欠薪'").get();
    expect(row).toEqual({ amount_fen: 3_800_000 });
  });

  it('claims_upsert 同 kind 只留一条，再调是更新不是新增', () => {
    const { f, ctx } = makeCtx();
    run(ctx, 'claims_upsert', { kind: '欠薪', amount_fen: 0, calc_json: '{"status":"待计算"}' });
    run(ctx, 'claims_upsert', { kind: '欠薪', amount_fen: 3_100_000, basis: 'statute-lhtf-38 §38' });
    const rows = f.db.prepare('SELECT amount_fen, basis FROM claims WHERE case_id = ?').all(f.caseId);
    expect(rows).toEqual([{ amount_fen: 3_100_000, basis: 'statute-lhtf-38 §38' }]);
  });

  it('company_profile_upsert 同名公司是补充信息而不是再开一行', () => {
    const { f, ctx } = makeCtx();
    run(ctx, 'company_profile_upsert', { name: '某安全科技有限公司' });
    run(ctx, 'company_profile_upsert', { name: '某安全科技有限公司', uscc: '91110105MA01ABCD2X', role: '用工主体' });
    const rows = f.db.prepare('SELECT name, uscc, role FROM company_profiles WHERE case_id = ?').all(f.caseId);
    expect(rows).toEqual([{ name: '某安全科技有限公司', uscc: '91110105MA01ABCD2X', role: '用工主体' }]);
  });

  it('参数不是合法 JSON 时回喂错误让模型改正，不炸掉整轮', () => {
    const { ctx } = makeCtx();
    const res = executeTool('action_card', '{坏掉的 json', ctx);
    expect(res.ok).toBe(false);
    expect(res.content).toContain('合法 JSON');
  });

  it('不存在的工具名回可用工具清单', () => {
    const { ctx } = makeCtx();
    const res = executeTool('rm_rf', '{}', ctx);
    expect(res.ok).toBe(false);
    expect(res.content).toContain('knowledge_search');
  });
});
