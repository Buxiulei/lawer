// app/src/lib/agent/__tests__/prompt-prefix-stability.test.ts
// **提示缓存前缀：静态段严格排最前、且逐字节恒定。**（2026-09-07 台账 backlog「提示缓存前缀稳定化」）
//
// 【它守的是什么事故】中转账单上每轮记 3–27 万 token 的「缓存写」、几乎零「缓存读」——
// 上游按前缀缓存，而 system prompt 的前缀在第一个变动处就断了。**这条缺陷没有任何症状**：
// 请求正常、回复正常、账本正常，只有月底的账单知道我们每轮都在为同一段 charter 重新付全价。
// 所以它必须有一条判据：**前缀稳定性不是靠肉眼看顺序看得出来的**，
// 往静态段里塞一个日期、一个案件 id、一句按案情变的话，成品读起来一模一样。
//
// 【判据的三条腿，缺一条就测不出东西】
//   ① 静态段**在最前**（system.startsWith(staticPrefix)）——它排第二就不是前缀了；
//   ② 静态段**跨案件、跨轮次逐字节相同**——这是"恒定"唯一说得清的定义；
//   ③ 静态段里**没有本轮的日期/时刻**——①②在同一天同一批夹具上跑，都可能被
//      "两次刚好一样"蒙混过去；这一条按内容判，与前两条互为对照。
// 每一条都配了变异样本（见文末 describe）：判据自己也要能分得出对错。
import { describe, expect, it } from 'vitest';

import type { CaseRow } from '@/lib/db/cases';
import { DEFAULT_DOMAIN, DOMAINS } from '@/lib/domains/registry';

import { CHARTER } from '../charter';
import { LAWYER_MANDATORY_HEADING } from '../lawyer-mandatory';
import {
  buildSystemPromptSegments,
  buildSystemPromptWithBreakpoints,
  SEGMENT_SEPARATOR,
  staticPrefixOf,
  type BuildSystemPromptInput,
} from '../prompt';
import type { KnowledgePack } from '../retrieval';
import type { CaseSnapshot } from '../snapshot';
import { runTurn } from '../orchestrator';
import { fixtureSearcher, makeAgentFixture, makeSink, scriptedProvider } from './fixtures';

/* ═══════════════════════════ 夹具 ═══════════════════════════ */

const CASE_BASE: CaseRow = {
  id: 1,
  user_id: 1,
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

function snapshotOf(over: Partial<CaseRow> = {}, rest: Partial<CaseSnapshot> = {}): CaseSnapshot {
  return {
    case: { ...CASE_BASE, ...over },
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
    ...rest,
  };
}

/** 两张卡，**故意按 id 倒序传进去**：渲染要按 id 排，不按传入名次。 */
const PACK_B: KnowledgePack = {
  id: 'statute-bbb',
  type: 'statute',
  title: '乙卡',
  keywords: [],
  applies_to: [],
  region: '北京',
  confidence: '原文核实',
  updated: '2026-01-02',
  body: '乙卡正文。',
};
const PACK_A: KnowledgePack = { ...PACK_B, id: 'statute-aaa', title: '甲卡', body: '甲卡正文。' };

function inputOf(over: Partial<BuildSystemPromptInput> = {}): BuildSystemPromptInput {
  return {
    snapshot: snapshotOf(),
    mode: '陪跑',
    stage: 'D',
    packs: [],
    now: new Date('2026-09-07T02:00:00Z'),
    ...over,
  } as BuildSystemPromptInput;
}

/* ═══════════════════════════ 判据本体（纯函数，变异样本走同一条路）═══════════════════════════ */

/** 一份「组装结果」：判据只认这三个串，不认它是怎么来的——变异样本才能手工构造。 */
interface Assembled {
  system: string;
  staticPrefix: string;
  dynamic: string;
}

/** ① 静态段必须**就是** system 的前缀。返回违规说明，空数组=过。 */
function checkStaticIsPrefix(a: Assembled): string[] {
  if (!a.staticPrefix.trim()) return ['静态段是空串——空串是任何串的前缀，这条判据会永远绿'];
  return a.system.startsWith(a.staticPrefix) ? [] : ['静态段不在 system 最前（前缀被别的段抢了位）'];
}

/** ② 一组组装结果的静态段必须逐字节相同。 */
function checkStaticStable(list: Assembled[]): string[] {
  const first = list[0].staticPrefix;
  const bad = list.findIndex((a) => a.staticPrefix !== first);
  return bad < 0 ? [] : [`第 ${bad + 1} 份的静态段与第 1 份不逐字节相同（长度 ${list[bad].staticPrefix.length} vs ${first.length}）`];
}

/**
 * ③ 动态段里出现的**日期与时刻**，一个都不许出现在静态段里。
 *
 * 【为什么按"动态段里有的"扫，而不是无差别禁掉 `20\d\d-`】charter 正文里写着几处
 * 「主理人 2026-09-05 规则」这类**与本轮无关的常量日期**，无差别禁会把它们一起判红，
 * 于是判据只能被放松掉。要禁的是**本轮的时间戳漏进恒定段**，那正好等于
 *「动态段里那几个日期/时刻」与静态段的交集。
 */
function checkNoTurnClock(a: Assembled): string[] {
  const tokens = new Set([...(a.dynamic.match(/20\d\d-\d\d-\d\d/g) ?? []), ...(a.dynamic.match(/\d\d:\d\d/g) ?? [])]);
  const leaked = [...tokens].filter((t) => a.staticPrefix.includes(t));
  return leaked.length ? [`本轮时间戳漏进了静态段：${leaked.join('、')}`] : [];
}

/** 把一次真实组装收成 Assembled。 */
function assemble(over: Partial<BuildSystemPromptInput> = {}): Assembled {
  const input = inputOf(over);
  const segs = buildSystemPromptSegments(input);
  return {
    system: buildSystemPromptWithBreakpoints(input).system,
    staticPrefix: segs.staticPrefix,
    dynamic: segs.dynamic,
  };
}

/* ═══════════════════════════ 正样本 ═══════════════════════════ */

describe('静态段：严格排最前，且逐字节恒定', () => {
  // 同一领域的两个不同案件：id / 标题 / 区 / 阶段 / 档案量全不一样
  const caseOne = assemble({ snapshot: snapshotOf({ id: 1, title: '甲案', district: '朝阳' }) });
  const caseTwo = assemble({
    snapshot: snapshotOf(
      { id: 8823, title: '乙案-独一无二的串', district: '海淀', stage: DOMAINS[DEFAULT_DOMAIN].stages[1] },
      { historyStats: { total: 17, firstAt: '2026-08-01 09:00:00' }, crisisHits72h: 2 },
    ),
    mode: '文书',
    now: new Date('2026-09-09T11:30:00Z'),
  });
  // 同一案件相邻两轮：事实卡变了（多了一次危机命中、多了一段历史），时刻也往前走了
  const turnOne = assemble({ snapshot: snapshotOf({ id: 42 }), now: new Date('2026-09-07T02:00:00Z') });
  const turnTwo = assemble({
    snapshot: snapshotOf({ id: 42 }, { historyStats: { total: 6, firstAt: '2026-09-07 10:00:00' }, crisisHits72h: 1 }),
    now: new Date('2026-09-07T03:17:00Z'),
  });

  it('先自证四份样本确实不一样（否则下面的"相同"全是废话）', () => {
    // 两个案件、两轮之间的**动态段**必须真的不同——它们要是碰巧一样，
    // "静态段相同"这句话就什么都没证明（比的是同一份输入）。
    expect(caseOne.dynamic).not.toBe(caseTwo.dynamic);
    expect(turnOne.dynamic).not.toBe(turnTwo.dynamic);
    expect(caseOne.system).not.toBe(caseTwo.system);
    expect(turnOne.system).not.toBe(turnTwo.system);
  });

  it('① 静态段就是 system 的前缀（四份都是）', () => {
    for (const a of [caseOne, caseTwo, turnOne, turnTwo]) expect(checkStaticIsPrefix(a)).toEqual([]);
  });

  it('② 两个案件 / 相邻两轮的静态段逐字节相同', () => {
    expect(checkStaticStable([caseOne, caseTwo])).toEqual([]);
    expect(checkStaticStable([turnOne, turnTwo])).toEqual([]);
    expect(checkStaticStable([caseOne, caseTwo, turnOne, turnTwo])).toEqual([]);
  });

  it('③ 本轮的日期与时刻一个都没漏进静态段', () => {
    for (const a of [caseOne, caseTwo, turnOne, turnTwo]) expect(checkNoTurnClock(a)).toEqual([]);
    // 自证扫描器真的扫到了东西：动态段里本来就该有当前时刻（运行环境那一行）
    expect(caseOne.dynamic).toMatch(/20\d\d-\d\d-\d\d/);
    expect(caseOne.dynamic).toMatch(/\d\d:\d\d/);
  });

  it('静态段装的就是那三段：charter + 输出纪律 + 闭合清单（且不含案件信息）', () => {
    const s = caseTwo.staticPrefix;
    expect(s).toBe(staticPrefixOf(DOMAINS[DEFAULT_DOMAIN]));
    expect(s.startsWith(CHARTER)).toBe(true);
    expect(s).toContain('## 本轮输出纪律（硬性）');
    expect(s).toContain(LAWYER_MANDATORY_HEADING);
    // 案件信息一个字都不许在里面（这一条是 staticPrefixOf 只收 DomainPack 的机械保证的复核）
    for (const leak of ['乙案-独一无二的串', '海淀', '8823']) expect(s).not.toContain(leak);
  });

  it('危机轮 / 空包轮同样不动静态段（本轮指令全在动态段）', () => {
    const crisisTurn = assemble({ crisis: true, emptyPack: false });
    const emptyTurn = assemble({ emptyPack: true });
    const plain = assemble({ nbdpsyEligible: false });
    expect(checkStaticStable([caseOne, crisisTurn, emptyTurn, plain])).toEqual([]);
    // 自证这三种轮次真的改了 prompt，不是三次都走了同一条分支
    expect(crisisTurn.dynamic).not.toBe(plain.dynamic);
    expect(emptyTurn.dynamic).not.toBe(plain.dynamic);
  });
});

describe('半静态段：packs 按卡 id 排，同一批卡逐字节相同', () => {
  it('传入名次互换不改变渲染（变异：去掉排序 → 红）', () => {
    const one = buildSystemPromptSegments(inputOf({ packs: [PACK_A, PACK_B] }));
    const two = buildSystemPromptSegments(inputOf({ packs: [PACK_B, PACK_A] }));
    expect(one.packsBlock).toBe(two.packsBlock);
    expect(one.packsBlock.indexOf('[statute-aaa]')).toBeLessThan(one.packsBlock.indexOf('[statute-bbb]'));
  });

  it('半静态段排在静态段之后、动态段之前', () => {
    const { system } = buildSystemPromptWithBreakpoints(inputOf({ packs: [PACK_B, PACK_A] }));
    const segs = buildSystemPromptSegments(inputOf({ packs: [PACK_B, PACK_A] }));
    expect(system.startsWith(segs.staticPrefix)).toBe(true);
    expect(system.indexOf(segs.packsBlock)).toBeLessThan(system.indexOf(segs.dynamic));
    // 事实卡仍先于用户消息（它在 system prompt 里），只是排到了 packs 之后——见 prompt.ts 文件头
    expect(segs.dynamic).toContain('## 案件事实卡');
  });
});

describe('缓存断点：落在静态段末尾与半静态段末尾', () => {
  it('有 packs 时两个断点，且切出来的第一块逐字就是静态段', () => {
    const input = inputOf({ packs: [PACK_A, PACK_B] });
    const { system, breakpoints } = buildSystemPromptWithBreakpoints(input);
    const segs = buildSystemPromptSegments(input);
    expect(breakpoints).toHaveLength(2);
    expect(system.slice(0, breakpoints[0])).toBe(segs.staticPrefix);
    expect(system.slice(0, breakpoints[1])).toBe(segs.staticPrefix + SEGMENT_SEPARATOR + segs.packsBlock);
    expect(breakpoints[0]).toBeLessThan(breakpoints[1]);
    expect(breakpoints[1]).toBeLessThan(system.length); // 断点不许落在末尾（那样最后一块是空的）
  });

  it('无 packs 时只有一个断点（不留一个切出空块的断点）', () => {
    const { system, breakpoints } = buildSystemPromptWithBreakpoints(inputOf({ packs: [] }));
    expect(breakpoints).toHaveLength(1);
    expect(system.slice(0, breakpoints[0])).toBe(staticPrefixOf(DOMAINS[DEFAULT_DOMAIN]));
  });

  it('断点数不超过 Anthropic 的 4 个上限', () => {
    const { breakpoints } = buildSystemPromptWithBreakpoints(inputOf({ packs: [PACK_A, PACK_B] }));
    expect(breakpoints.length).toBeLessThanOrEqual(4);
  });
});

/* ═══════════════════════════ 变异：判据自己分得出对错 ═══════════════════════════ */

describe('★变异样本：三条判据各自都能报红', () => {
  const good = assemble({ snapshot: snapshotOf({ id: 7 }) });

  it('把事实卡挪到 charter 之前 → ① 红', () => {
    const factsFirst: Assembled = {
      ...good,
      // 这就是改动之前那一版的形状：事实卡（每轮都变）夹在恒定的几段中间
      system: '## 案件事实卡（挪到最前）\n\n---\n\n' + good.system,
    };
    expect(checkStaticIsPrefix(factsFirst)).not.toEqual([]);
    expect(checkStaticIsPrefix(good)).toEqual([]); // 正对照
  });

  it('静态段里混进案件 id → ② 红（两个案件的静态段不再相同）', () => {
    const one = assemble({ snapshot: snapshotOf({ id: 1 }) });
    const two = assemble({ snapshot: snapshotOf({ id: 2 }) });
    const polluted = [
      one,
      { ...two, staticPrefix: `${two.staticPrefix}\n\n（本案编号：${two.system.length}）` },
    ];
    expect(checkStaticStable(polluted)).not.toEqual([]);
    expect(checkStaticStable([one, two])).toEqual([]); // 正对照
  });

  it('静态段里混进本轮时间戳 → ③ 红', () => {
    const stamp = good.dynamic.match(/20\d\d-\d\d-\d\d/)![0];
    const polluted: Assembled = { ...good, staticPrefix: `${good.staticPrefix}\n\n（生成于 ${stamp}）` };
    expect(checkNoTurnClock(polluted)).not.toEqual([]);
    expect(checkNoTurnClock(good)).toEqual([]); // 正对照
  });

  it('静态段被清空 → ① 红（空串是任何串的前缀，不许判成"过"）', () => {
    expect(checkStaticIsPrefix({ ...good, staticPrefix: '' })).not.toEqual([]);
  });
});

/* ═══════════════════════════ 假上游：连着两轮真跑编排 ═══════════════════════════ */

/**
 * 【为什么纯函数判据不够，还要跑一遍编排】上面那些比的是 `buildSystemPrompt*` 的产出，
 * 而**真正发出去的**是 orchestrator 拼的那个消息数组。两者之间隔着一次接线，
 * 接线断了的形态是：段函数照常返回稳定前缀，发出去的 system 却是另一种拼法——
 * 判据全绿、账单照贵。所以这一节按**发出去的那一份**判。
 */
describe('★假上游：连着两轮，发出去的 system 前 N 字节逐字相同（N = 静态段长度）', () => {
  const CARD = {
    name: 'action_card',
    args: {
      what: '今天 18 点前把解除通知邮件转发到个人邮箱',
      how: '打开公司邮箱找到那封通知，转发到私人邮箱并截图',
      why: '公司随时可能停你的邮箱权限',
      due_at: '2026-08-19T18:00:00+08:00',
    },
  };

  it('两轮之间事实卡变了（多了一张行动卡、多了一段历史），静态段前缀一个字节都没动', async () => {
    const f = makeAgentFixture();
    // 【一轮一个假模型】同一个 scriptedProvider 跨两轮时，`calls[1]` 是**第一轮的工具续轮**
    //（有工具调用就必然再发一次），不是第二轮的首发。拿它当第二轮比，比的是同一份 system——
    // 判据会绿，而它什么都没验。所以两轮各给一个，各取自己的 calls[0]。
    const one = scriptedProvider([{ text: '第一轮。', tools: [CARD] }]);
    const two = scriptedProvider([{ text: '第二轮。', tools: [CARD] }]);
    const common = { db: f.db, caseId: f.caseId, userId: f.userId, searcher: fixtureSearcher(), emit: makeSink().emit };
    await runTurn({ ...common, provider: one, message: '刚收到辞退邮件，手都是抖的', now: new Date('2026-08-19T12:40:00Z') });
    await runTurn({ ...common, provider: two, message: '那我明天该做什么', now: new Date('2026-08-19T13:05:00Z') });

    const [first, second] = [one.calls[0][0], two.calls[0][0]];
    expect(first.role).toBe('system');
    expect(second.role).toBe('system');

    const n = staticPrefixOf(DOMAINS[DEFAULT_DOMAIN]).length;
    // 自证两轮真的不同（否则"前缀相同"是拿同一份输入自比）
    expect(first.content).not.toBe(second.content);
    expect(first.content.slice(0, n)).toBe(second.content.slice(0, n));
    expect(first.content.slice(0, n)).toBe(staticPrefixOf(DOMAINS[DEFAULT_DOMAIN]));
    // 前缀之后必须真的还有东西——N 若等于全长，上面那句就成了「整串相同」的另一种写法
    expect(first.content.length).toBeGreaterThan(n);
  });

  it('缓存断点随请求下发，且第一个断点就是静态段末尾', async () => {
    const f = makeAgentFixture();
    const provider = scriptedProvider([{ text: 'x', tools: [CARD] }]);
    await runTurn({
      db: f.db,
      caseId: f.caseId,
      userId: f.userId,
      message: '公司让我签自愿离职',
      provider,
      searcher: fixtureSearcher(),
      emit: makeSink().emit,
      now: new Date('2026-08-19T12:40:00Z'),
    });
    const bp = provider.optsCalls[0]?.cacheBreakpoints;
    expect(bp, 'cacheBreakpoints 没随请求下发——断点在 opts 里，消息数组不变，漏了不会有任何症状').toBeDefined();
    expect(bp![0]).toBe(staticPrefixOf(DOMAINS[DEFAULT_DOMAIN]).length);
    expect(bp!.length).toBeLessThanOrEqual(4);
    // 断点必须严格递增且都落在 system 之内，否则 provider 侧会整批忽略（那是静默失效）
    const system = provider.calls[0][0].content;
    for (const [i, x] of bp!.entries()) {
      expect(x).toBeGreaterThan(i === 0 ? 0 : bp![i - 1]);
      expect(x).toBeLessThan(system.length);
    }
  });

  it('本轮缓存读数进运维通道（PROMPT_CACHE），三态分得开', async () => {
    const f = makeAgentFixture();
    const sink = makeSink();
    // 两轮都要写死用量：有工具调用就必然还有一次续轮，续轮走夹具缺省用量（prompt 100）
    // 会把下面的数字全部搅乱——一轮的账是**这一轮所有往返之和**（orchestrator.addUsage）。
    const provider = scriptedProvider([
      { text: 'x', tools: [CARD], usage: { prompt: 300, completion: 20, cachedRead: 700, cachedWrite: null } },
      { text: '好了。', usage: { prompt: 0, completion: 5, cachedRead: 0, cachedWrite: null } },
    ]);
    await runTurn({
      db: f.db,
      caseId: f.caseId,
      userId: f.userId,
      message: '公司让我签自愿离职',
      provider,
      searcher: fixtureSearcher(),
      emit: sink.emit,
      now: new Date('2026-08-19T12:40:00Z'),
    });
    const notice = sink.events.find((e) => e.event === 'notice' && e.data.code === 'PROMPT_CACHE');
    expect(notice, '没有 PROMPT_CACHE 留痕：命中率就只剩月底的中转账单可依').toBeDefined();
    const pc = (notice as { data: { prompt_cache?: Record<string, number | null> } }).data.prompt_cache!;
    expect(pc.cached_read).toBe(700);
    // 上游没给写桶 → null，**不许用 0 冒充**（0 = 报了就是 0，是另一件事）
    expect(pc.cached_write).toBeNull();
    expect(pc.fresh).toBe(300);
    expect(pc.hit_rate).toBeCloseTo(0.7, 6);
  });
});
