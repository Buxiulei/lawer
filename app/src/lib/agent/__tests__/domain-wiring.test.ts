// app/src/lib/agent/__tests__/domain-wiring.test.ts
// **这个案子的领域，一路传到了每一个消费点吗**（设计稿 §13）。
//
// 【为什么单开一份，而不是并进 crisis-by-domain】那一份问的是"换包会不会换话"，
// 问的对象是**纯函数**（assessCrisis / buildCrisisOpener / splitCrisisOpener），
// 它们各自都是对的。本份问的是完全不同的一件事：**编排层有没有真的把包传下去**。
//
// 【它防的是哪一类"一半接上了"】(复审 2026-09-06 实测出来的形态)
// 判定与首段按案件领域走了，而同一轮里的出口闸（切分、剥空兜底）、
// 注入给模型的危机指令与资源卡 id、事实卡抬头、站内注入的领域过滤仍取缺省领域——
// **同一轮里两套口径并存**：号码是对的、格式是对的、结构是对的，没有一处会报错，
// 只是那些话在跟另一个行当的人说。复审官逐条改坏（事实卡抬头恒取缺省包、
// 注入不按领域过滤），lib/agent 整套测试**一条都没红**。
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { CaseRow } from '@/lib/db/cases';
import {
  DEFAULT_DOMAIN,
  DOMAINS,
  type DomainCrisis,
  type DomainPack,
} from '@/lib/domains/registry';

import { buildCaseFacts, renderCaseFacts } from '../case-facts';
import { assembleCrisisOpener, type CrisisOpenerText, type HotlineFact } from '../crisis-opener';
import { applyLeverageGate, leverageSubject } from '../crisis';
import { runTurn } from '../orchestrator';
import { LAWYER_MANDATORY_HEADING, renderLawyerMandatory } from '../lawyer-mandatory';
import { buildSystemPrompt } from '../prompt';
import type { KnowledgePack, KnowledgeSearcher } from '../retrieval';
import type { CaseSnapshot } from '../snapshot';
import { makeAgentFixture, makeSink, scriptedProvider } from './fixtures';

// ========== 一个与缺省领域没有一个字重合的假领域 ==========

const FAKE_KEY = '假领域-接线判据专用';
const FAKE_CARD_ID = 'fake-crisis-resource-card';

const OPENER: CrisisOpenerText = {
  head: ['假领域首段第一行。', '假领域首段第二行：'],
  tail: '假领域收束句。',
  after: '假领域附加句。',
};

const FAKE_CRISIS: DomainCrisis = {
  lexicon: ['甲乙丙'],
  negations: ['并非'],
  resourcePackId: FAKE_CARD_ID,
  directive: '假领域的危机强制指令原文。',
  openerText: OPENER,
  safeFallback: '假领域的确定性兜底正文。',
  firstSegment: (ctx) => assembleCrisisOpener(OPENER, ctx.facts, { compact: ctx.compact }),
  repeatCardNote: (numbers) => `假领域的窗内限制句：${numbers.join(' / ')}`,
};

/** 假包的事实卡抬头：每一节都换成一望即知不是缺省领域的字。 */
const FAKE_FACTS_SECTIONS = DOMAINS[DEFAULT_DOMAIN].factsSections.map((s) => ({
  key: s.key,
  title: `假领域·${s.key}`,
}));

const LABOR_PACK = DOMAINS[DEFAULT_DOMAIN];
const FAKE_PACK: DomainPack = {
  ...LABOR_PACK,
  key: FAKE_KEY,
  crisis: FAKE_CRISIS,
  factsSections: FAKE_FACTS_SECTIONS,
  // 「法律上只能由执业律师做的那几件事」也要与缺省领域一个字都不重合：
  // 沿用缺省包那两条的话，下面那条判据分不出"按领域取"和"恒取缺省包"。
  lawyerMandatory: [
    {
      key: 'fake-only',
      label: '假领域·只能由执业律师做的那一件',
      why: '假领域的理由句，以及我们仍然替他做完了哪一半。',
      basis: '《假领域法》第一条',
    },
  ],
};

/**
 * 假领域的危机资源卡（首段的号码从它的结构化 facts 里取）。
 * 写成具名常量而不是内联字面量：`KnowledgePack.facts.hotlines` 的类型里没有 `category`
 *（既有状态），而首段的取数器 `crisisHotlines` 只认 category==='crisis' 的那几条。
 * 具名成 HotlineFact 之后两边都成立，不用在测试里塞一个 as 断言把这件事糊过去。
 */
const FAKE_HOTLINE: HotlineFact = {
  name: '假热线',
  phone: '12345',
  category: 'crisis',
  status: 'usable',
  hours: '全天',
};


const FAKE_CARD: KnowledgePack = {
  id: FAKE_CARD_ID,
  type: '情绪指南',
  title: '假领域危机资源卡',
  keywords: ['甲乙丙'],
  applies_to: [],
  region: '全国',
  confidence: '原文核实',
  updated: '2026-09-06',
  body: '假领域资源卡正文。',
  facts: { hotlines: [FAKE_HOTLINE] },
};

beforeAll(() => {
  DOMAINS[FAKE_KEY] = FAKE_PACK;
});
afterAll(() => {
  delete DOMAINS[FAKE_KEY];
});

// ========== 事实卡抬头 ==========

const CASE_BASE: CaseRow = {
  id: 2,
  user_id: 2,
  title: '一个案子',
  stage: DOMAINS[DEFAULT_DOMAIN].stages[0],
  domain: DEFAULT_DOMAIN,
  track: null,
  district: '朝阳',
  goal: null,
  bottom_line: null,
  status: '进行中',
  employed_from: null,
  monthly_wage_fen: null,
  position: null,
  contract_count: null,
  created_at: '2026-09-01 10:00:00',
};

function snapshotOf(domain: string): CaseSnapshot {
  return {
    case: { ...CASE_BASE, domain },
    identity: { realName: null, authStatus: '未认证', nameUnreadable: false },
    evidence: [],
    historyStats: { total: 0, firstAt: null },
    timeline: [],
    timelineStats: { total: 0, earliest: null },
    claims: [],
    companies: [],
    openActions: [],
    closedActions: [],
    deadlines: [],
    storedIntakeStage: null,
    referredNbdpsy: false,
    report: { state: null, since: null, changes: 0, detail: '' },
    crisisHits72h: 0,
  };
}

describe('事实卡抬头按 cases.domain 取（变异：heading 恒取缺省包 → 红）', () => {
  it('假领域的案子：每一节抬头都来自假包，一句缺省领域的抬头都不剩', () => {
    const fake = renderCaseFacts(buildCaseFacts(snapshotOf(FAKE_KEY)));
    // 比对**抬头那一行**（`### X`）而不是裸标题：缺省领域的几个标题（「证据」「时间线」…）
    // 同时也是正文里的普通词，按裸串比会把正文当成抬头，这条断言就分不出对错了。
    for (const spec of FAKE_FACTS_SECTIONS) expect(fake).toContain(`### ${spec.title}`);
    // 反向：缺省领域那几个抬头一个都不许再当抬头出现
    for (const spec of LABOR_PACK.factsSections) expect(fake).not.toContain(`### ${spec.title}`);
  });

  it('缺省领域的案子照旧（自证上一条不是"抬头整个失效"）', () => {
    const base = renderCaseFacts(buildCaseFacts(snapshotOf(DEFAULT_DOMAIN)));
    for (const spec of LABOR_PACK.factsSections) expect(base).toContain(`### ${spec.title}`);
  });

  it('domain 写坏的一行：退回缺省领域的抬头，而不是渲染出一张空事实卡', () => {
    // 读路径的政策（registry.domainPackOrDefault）：一行写坏的 domain 不该让用户
    // 连自己的档案都读不出来。这条钉的是"退回"这个行为本身是刻意的。
    const broken = renderCaseFacts(buildCaseFacts(snapshotOf('一个从没注册过的领域')));
    for (const spec of LABOR_PACK.factsSections) expect(broken).toContain(`### ${spec.title}`);
  });
});

// ========== system prompt 的危机指令与资源卡 id ==========

describe('危机指令与资源卡 id 按 cases.domain 取（变异：prompt 里写回 CRISIS_* 常量 → 红）', () => {
  const promptOf = (domain: string, over: Parameters<typeof buildSystemPrompt>[0] | null = null) =>
    buildSystemPrompt({
      snapshot: snapshotOf(domain),
      mode: '陪跑',
      stage: 'D',
      packs: [FAKE_CARD],
      now: new Date('2026-09-06T02:00:00Z'),
      crisis: true,
      crisisCardAlreadyGiven: true,
      ...(over ?? {}),
    } as Parameters<typeof buildSystemPrompt>[0]);

  it('假领域的危机轮：注入的是假包的指令，缺省领域的指令一个字都不进 prompt', () => {
    const p = promptOf(FAKE_KEY);
    expect(p).toContain(FAKE_CRISIS.directive);
    expect(p).not.toContain(LABOR_PACK.crisis.directive);
  });

  it('缺省领域的危机轮照旧注入缺省领域的指令（自证上一条不是"指令整个没了"）', () => {
    expect(promptOf(DEFAULT_DOMAIN)).toContain(LABOR_PACK.crisis.directive);
  });

  /**
   * 【本条在 P4-W3 改过口径，原因写在这里】原来断言的是共用层写死的那句
   *「本案 24 小时内已经给过一次这张卡」——而那句话连同**缺省领域的三个号码**一起
   * 写死在 lib/agent/prompt.ts 里，第二个领域的用户在危机窗内读到的就是上一个行当的号码
   *（设计稿 §13-6：共用层不许写死领域内容）。搬进 DomainPack.crisis.repeatCardNote 之后，
   * 断言共用层那句话等于把刚拆掉的耦合又钉回来。改成钉**这句话来自这个包自己**。
   */
  it('「别重印整张卡」那条贴附指令贴在**假包自己的**资源卡上，且话是假包自己的', () => {
    // 贴错卡的形态是：那句话贴在缺省领域的资源卡后面，而本轮上下文里根本没有那张卡——
    // 于是这条指令谁也没约束到，而 prompt 看起来完全正常。
    const p = promptOf(FAKE_KEY);
    const at = p.indexOf(`### [${FAKE_CARD_ID}]`);
    expect(at, '假包的资源卡没进 prompt').toBeGreaterThan(-1);
    // 号码从**假包自己那张卡**的 facts 里抽（12345），不是共用层写死的那三个
    expect(p.slice(at)).toContain(FAKE_CRISIS.repeatCardNote(['12345']));
  });

  it('危机窗内的号码不串领域：假领域的贴附指令里，缺省领域的号码一个都不出现', () => {
    // 这条钉的是本票真正修掉的那件事：号码原来写死在共用层，于是**任何**领域的用户
    // 在危机窗内都会读到缺省领域的三个号码——号码本身是对的，只是不属于他这件事，
    // 而这一轮回复照常生成、格式完全正常、没有一处会报错。
    const p = promptOf(FAKE_KEY);
    const at = p.indexOf(`### [${FAKE_CARD_ID}]`);
    const attached = p.slice(at);
    for (const phone of ['12356', '800-810-1117', '010-82951332']) {
      expect(attached, `假领域的危机窗内出现了缺省领域的号码 ${phone}`).not.toContain(phone);
    }
    expect(attached, '假包自己那张卡上的号码反而没出现').toContain('12345');
  });

  it('缺省领域的危机窗内那句话逐字不变（自证上一条不是"贴附指令整个没了"）', () => {
    // 贴附指令只贴在**这个领域自己那张卡**上，所以要把缺省领域的卡也放进注入包，
    // 否则这条测的是"卡不在包里"而不是"话对不对"。
    const laborCard: KnowledgePack = { ...FAKE_CARD, id: LABOR_PACK.crisis.resourcePackId };
    const p = promptOf(DEFAULT_DOMAIN, { packs: [laborCard] } as never);
    expect(p).toContain(LABOR_PACK.crisis.repeatCardNote([]));
    expect(p).toContain('热线还是这三个，随时能打：12356 / 座机 800-810-1117 / 手机 010-82951332');
  });
});

// ========== 杠杆闸的回落兜底 ==========

describe('杠杆闸回落用这个领域的兜底正文（变异：applyLeverageGate 里写死缺省包 → 红）', () => {
  // 一句纯杠杆、剥完一句不剩 ⇒ 必落 fallback
  const LEVERAGE = '想想你爸妈，他们该多伤心。';

  it('传了假包 ⇒ 回落到假包的兜底；缺省领域那段一个字都不出现', () => {
    const got = applyLeverageGate(
      leverageSubject({ modelBody: LEVERAGE, userTurns: ['我撑不住了'] }),
      FAKE_CRISIS,
    );
    expect(got.outcome).toBe('fallback');
    expect(got.text).toBe(FAKE_CRISIS.safeFallback);
    expect(got.text).not.toBe(LABOR_PACK.crisis.safeFallback);
  });

  it('不传 ⇒ 仍是缺省领域那段（既有调用方行为逐字不变）', () => {
    const got = applyLeverageGate(leverageSubject({ modelBody: LEVERAGE, userTurns: ['我撑不住了'] }));
    expect(got.outcome).toBe('fallback');
    expect(got.text).toBe(LABOR_PACK.crisis.safeFallback);
  });
});

// ========== 编排层端到端 ==========

/** 记下每次检索收到的 options，用来断言注入那条通路真的按领域过滤 */
function recordingSearcher(packs: KnowledgePack[]) {
  const calls: { query: string; options: Record<string, unknown> }[] = [];
  const searcher: KnowledgeSearcher = {
    search: (query, options = {}) => {
      calls.push({ query, options: options as Record<string, unknown> });
      return packs;
    },
    get: (id: string) => packs.find((p) => p.id === id),
  };
  return { searcher, calls };
}

/** 本组的每一轮都不该失败：先把联合类型窄掉，失败时把原因说清楚而不是在断言里炸。 */
async function mustSucceed(input: Parameters<typeof runTurn>[0]) {
  const res = await runTurn(input);
  if (!res.ok) throw new Error(`本轮不该失败：${res.errorCode} ${res.message}`);
  return res;
}

function caseInDomain(domain: string) {
  const f = makeAgentFixture();
  f.db.prepare('UPDATE cases SET domain=? WHERE id=?').run(domain, f.caseId);
  return f;
}

describe('runTurn 的危机轮：整条链路都用这个案子的领域包', () => {
  /**
   * 【这一条同时钉住四处】危机词表（orchestrator 取包）、确定性首段、
   * 出口闸的首段切分（D15 那两处 splitCrisisOpener）、剥空后的兜底正文。
   * 剧本让模型只说一句付费内容 ⇒ D15 整句剥掉 ⇒ 剥空 ⇒ 回落兜底。
   * 若切分仍按缺省领域的首段，`opener` 会切不出来（首段整段被当成模型段），
   * 那么"剥空"就不成立、兜底也不会是假包那段——一处接错，这条就红。
   */
  it('假领域：首段/切分/兜底全用假包，缺省领域的话一个字都不出现', async () => {
    const f = caseInDomain(FAKE_KEY);
    const { searcher } = recordingSearcher([FAKE_CARD]);
    const sink = makeSink();
    const provider = scriptedProvider([{ text: '扫码就能约上，一次 600 元。' }]);

    const res = await mustSucceed({
      db: f.db,
      caseId: f.caseId,
      userId: f.userId,
      message: '我最近总是甲乙丙',
      provider,
      searcher,
      emit: sink.emit,
      now: new Date('2026-09-06T02:00:00Z'),
    });

    // 首段：假包的
    expect(res.text).toContain(OPENER.head[0]);
    expect(res.text).toContain(OPENER.tail);
    expect(res.text).toContain('12345');
    // 出口闸剥空 → 回落假包的兜底（不是缺省领域那段）
    expect(res.text).toContain(FAKE_CRISIS.safeFallback);
    expect(res.text).not.toContain(LABOR_PACK.crisis.safeFallback);
    expect(res.text).not.toContain(LABOR_PACK.crisis.openerText.tail);
    // 剥掉的那句确实没留在正文里，且 L1 的 notice 报了出来
    expect(res.text).not.toContain('600');
    expect(sink.of('notice').map((n) => n.data.code)).toContain('CRISIS_PAID_CONTENT_BLOCKED');
  });

  it('缺省领域的案子行为逐字不变（自证上一条不是"危机轮整个改了"）', async () => {
    const f = caseInDomain(DEFAULT_DOMAIN);
    const { searcher } = recordingSearcher([FAKE_CARD]);
    const sink = makeSink();
    // 缺省领域的词表里的一个词；假包的词在这个案子里不该触发
    const term = LABOR_PACK.crisis.lexicon[0];
    const res = await mustSucceed({
      db: f.db,
      caseId: f.caseId,
      userId: f.userId,
      message: `我最近总觉得${term}`,
      provider: scriptedProvider([{ text: '我在，先别急。' }]),
      searcher,
      emit: sink.emit,
      now: new Date('2026-09-06T02:00:00Z'),
    });
    expect(res.text).toContain(LABOR_PACK.crisis.openerText.head[0]);
    expect(res.text).not.toContain(OPENER.head[0]);
  });

  it('假领域的案子不认缺省领域的危机词（词表真的换了，不是两份并集）', async () => {
    const f = caseInDomain(FAKE_KEY);
    const { searcher } = recordingSearcher([FAKE_CARD]);
    const sink = makeSink();
    const res = await mustSucceed({
      db: f.db,
      caseId: f.caseId,
      userId: f.userId,
      message: `我最近总觉得${LABOR_PACK.crisis.lexicon[0]}`,
      provider: scriptedProvider([{ text: '好的，我们继续。' }]),
      searcher,
      emit: sink.emit,
      now: new Date('2026-09-06T02:00:00Z'),
    });
    expect(res.text).not.toContain(OPENER.head[0]);
    expect(res.text).not.toContain(LABOR_PACK.crisis.openerText.head[0]);
  });

  it('站内注入按案件领域过滤（变异：orchestrator 里把 domain 参数删掉 → 红）', async () => {
    const f = caseInDomain(FAKE_KEY);
    const { searcher, calls } = recordingSearcher([FAKE_CARD]);
    const sink = makeSink();
    await runTurn({
      db: f.db,
      caseId: f.caseId,
      userId: f.userId,
      message: '公司要我签一份东西',
      provider: scriptedProvider([{ text: '收到。' }]),
      searcher,
      emit: sink.emit,
      now: new Date('2026-09-06T02:00:00Z'),
    });
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0].options.domain).toBe(FAKE_KEY);
  });
});

describe('工具通路：知识检索也按案件领域过滤', () => {
  it('模型自己调 knowledge_search ⇒ 检索器收到的仍是这个案子的领域', async () => {
    const f = caseInDomain(FAKE_KEY);
    const { searcher, calls } = recordingSearcher([FAKE_CARD]);
    const sink = makeSink();
    await runTurn({
      db: f.db,
      caseId: f.caseId,
      userId: f.userId,
      message: '帮我查一下',
      provider: scriptedProvider([
        { text: '我查一下。', tools: [{ name: 'knowledge_search', args: { query: '甲乙丙' } }] },
        { text: '查到了。' },
      ]),
      searcher,
      emit: sink.emit,
      now: new Date('2026-09-06T02:00:00Z'),
    });
    // 预检索一次 + 工具一次，两条通路都必须带同一个领域（少一条就是"从那个通道绕过去"）
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const c of calls) expect(c.options.domain).toBe(FAKE_KEY);
  });
});

// ========== 「只能由执业律师做」的闭合清单 ==========

/**
 * 主理人 2026-09-07 裁决落到 system prompt 上的那一段：能我们做完的都我们做完，
 * 只有清单里的事项才说明法律上必须由执业律师做。
 *
 * 【这里为什么要按领域验一遍】清单是**领域包的对外承诺**。共用层写死一份的形态是：
 * 第二个领域的用户读到的是上一个行当的清单——每一句都通顺、法条也是真的，
 * 只是那几件事不是他这件事，而这一轮回复照常生成、没有一处会报错。
 */
describe('「只能由执业律师做」的闭合清单按 cases.domain 取（变异：把 prompt.ts 里那行 renderLawyerMandatory 删掉 → 红）', () => {
  const plainPrompt = (domain: string) =>
    buildSystemPrompt({
      snapshot: snapshotOf(domain),
      mode: '陪跑',
      stage: 'D',
      packs: [FAKE_CARD],
      now: new Date('2026-09-06T02:00:00Z'),
    } as Parameters<typeof buildSystemPrompt>[0]);

  it('假领域：进 prompt 的是假包那一条，缺省领域的两条一个字都不进', () => {
    const p = plainPrompt(FAKE_KEY);
    expect(p).toContain(FAKE_PACK.lawyerMandatory[0].label);
    expect(p).toContain(FAKE_PACK.lawyerMandatory[0].why);
    expect(p).toContain(FAKE_PACK.lawyerMandatory[0].basis);
    for (const item of LABOR_PACK.lawyerMandatory) {
      expect(p, `缺省领域的「${item.label}」串到假领域去了`).not.toContain(item.label);
    }
  });

  it('缺省领域照旧逐条进 prompt（自证上一条不是"整段没了"）', () => {
    const p = plainPrompt(DEFAULT_DOMAIN);
    for (const item of LABOR_PACK.lawyerMandatory) {
      expect(p).toContain(item.label);
      expect(p).toContain(item.why);
      expect(p).toContain(item.basis);
    }
  });

  /**
   * 【为什么要单钉"普通轮也在"】这一段防的是**模型的默认收尾**（顺手加一句
   *「建议咨询专业律师」），不是某一种输入。做成"命中才注入"的形态是：
   * 用户没问、模型自己收了这么一句尾，而那一轮与其它轮看起来没有任何区别。
   */
  it('普通轮（非危机、非空包）也带这一段，且带着那三条通用纪律（第 4 条只给声明了待复核节的领域）', () => {
    const p = plainPrompt(DEFAULT_DOMAIN);
    expect(p).toContain(LAWYER_MANDATORY_HEADING);
    expect(p).toContain('清单以外的每一件事，都由你做完');
    expect(p).toContain('禁止用「建议咨询律师」');
  });
});

/**
 * 【这一组补的是"同一份 prompt 里两条指令互斥"】有的领域另有一节
 * 「待律师书面确认」（DomainPack.lawyerReview）：那几条每轮随事实卡渲染，
 * 逐条写着"待律师书面确认"；而闭合清单那一段写着"清单以外的每一件事都由你做完"
 * 「不许用建议咨询律师收尾」。
 *
 * 两条都进了同一份 system prompt 而**没有写明谁优先**时，模型对着同一个问题
 * （比如"我们机构算不算强制报告主体"）两种做法都说得通，两种都不会报错：
 * 按清单那段办就给出是/否结论（正是待复核那一节要禁的），
 * 按待复核那一节办就把人指向了律师（正是清单那段要禁的）。
 * 所以先后必须**写在下发给模型的字里**，而不是留在设计稿或复审记录里。
 */
describe('待复核那一节与闭合清单的先后写在同一段里（变异：删掉 lawyerReviewTiebreak 那几行 → 红）', () => {
  const plainPrompt = (domain: string) =>
    buildSystemPrompt({
      snapshot: snapshotOf(domain),
      mode: '陪跑',
      stage: 'D',
      packs: [FAKE_CARD],
      now: new Date('2026-09-06T02:00:00Z'),
    } as Parameters<typeof buildSystemPrompt>[0]);

  const REVIEW = {
    title: '假领域·风险与待核',
    items: ['假领域待确认的那一条——待律师书面确认。'],
    discipline: '假领域的纪律句：未经书面确认不得作为结论输出。',
  };

  it('声明了这一节的领域：清单段里点名它，并写死"它限制结论、不是转介理由"', () => {
    const seg = renderLawyerMandatory({ ...FAKE_PACK, lawyerReview: REVIEW });
    expect(seg, '清单段没点名那一节的名字，模型不知道说的是哪一节').toContain(REVIEW.title);
    expect(seg).toContain('不得**当成把用户支给律师的理由');
    expect(seg, '只说了"不是转介理由"却没说"那该怎么办"，等于只堵不给出路').toContain('照第 1 条由你写清楚');
  });

  /**
   * 反方向：没有这一节的领域**一个字都不多**。无条件渲染的形态是——
   * 缺省领域的模型读到"本领域另有一节……"，而那一节不存在，
   * 于是它照着这句话编一个出来，读起来完全通顺。
   */
  it('没有这一节的领域一个字都不多（变异：把它改成无条件渲染 → 红）', () => {
    const seg = renderLawyerMandatory(FAKE_PACK);
    expect(FAKE_PACK.lawyerReview, '假包本来就该没有这一节，否则下面这条恒真').toBeUndefined();
    expect(seg).not.toContain('本领域另有一节');
    expect(seg).not.toContain(REVIEW.title);
  });

  it('缺省领域（同样没有这一节）的 prompt 里也不多这一句', () => {
    expect(LABOR_PACK.lawyerReview).toBeUndefined();
    expect(plainPrompt(DEFAULT_DOMAIN)).not.toContain('本领域另有一节');
  });
});
