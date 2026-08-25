// app/src/lib/agent/__tests__/crisis.test.ts
// 危机识别层（manager 2026-08-19 架构加固令要求的三类断言）：
//   ① 触发词表覆盖（自伤/轻生类表述变体）
//   ② 否定语境不误触
//   ③ 重复触发只注入一次（案件级去重，且与 NBDpsy 引流是两个独立开关）
//
// 这一层是纯函数，所以①②完全离线可断；③要落库，用真库跑。
import { describe, expect, it } from 'vitest';

import * as store from '@/lib/db/agent';
import { createKnowledgeSearcher } from '../knowledge-adapter';
import {
  assessCrisis,
  isLandlineOnly,
  LANDLINE_MARK,
  compactCrisisCard,
  bannedHotlines,
  crisisHotlines,
  type HotlineFact,
  detectEmotionalLeverage,
  stripLeverageSentences,
  stripLeverageWithTrail,
  assessNbdpsyEligibility,
  buildCrisisOpener,
  extractHotlines,
  detectNbdpsyPitch,
  NBDPSY_PERSISTENT_DISTRESS_THRESHOLD,
  stripNbdpsyPitch,
  stripDuplicateHotlineList,
  CRISIS_CARD_MARKER,
  CRISIS_DIRECTIVE,
  CRISIS_RESOURCE_PACK_ID,
  responseGaveCrisisCard,
  shouldInjectCrisisCard,
} from '../crisis';
import { classifyTask } from '../task-class';
import { makeAgentFixture } from './fixtures';

describe('① 触发词表覆盖', () => {
  it.each([
    ['有时候半夜想，要是人没了是不是就不用还房贷了', 'C04 S08 原句：绕着说的自伤表述'],
    ['我不想活了', '直述'],
    ['真的活不下去了', '直述'],
    ['要不是还有孩子，我早就想死了', '嵌在长句里'],
    ['一了百了算了', '成语式'],
    ['我想过自杀', '直白词'],
    ['每天都在自残', '自伤行为'],
    ['真的撑不下去了，一天都熬不下去', '持续极端痛苦'],
    ['是不是死了算了', '疑问句式'],
    ['我怕自己想不开', '担心自己'],
    ['活着没意思', '意义丧失'],
  ])('「%s」触发（%s）', (message) => {
    const a = assessCrisis(message);
    expect(a.triggered).toBe(true);
    expect(a.matched.length).toBeGreaterThan(0);
    expect(a.resourcePackId).toBe(CRISIS_RESOURCE_PACK_ID);
    expect(a.directive).toBe(CRISIS_DIRECTIVE);
  });

  it('危机轮必然判为 critical——两处共用同一份判据，不会一处认得出另一处认不出', () => {
    for (const m of ['我不想活了', '要是人没了就好了']) {
      expect(assessCrisis(m).triggered).toBe(true);
      expect(classifyTask({ message: m, mode: '陪跑' })).toBe('critical');
    }
  });
});

describe('② 否定语境不误触（误触会烧掉一案唯一的一次资源卡）', () => {
  it.each([
    '我不会想不开的，你放心',
    '我才不想死呢，我要看着他们赔钱',
    '我不是想死，就是太累了',
    '你别担心，我没想过自杀',
    '我从没想过轻生这种事',
    '我还不至于活不下去',
  ])('「%s」不触发', (message) => {
    const a = assessCrisis(message);
    expect(a.triggered).toBe(false);
    expect(a.suppressed.length).toBeGreaterThan(0);
  });

  it('一句话里既有否认又有真信号时，仍然触发（宁可多触发，不可漏）', () => {
    const a = assessCrisis('我不会想不开，但有时候是真的活不下去');
    expect(a.triggered).toBe(true);
    expect(a.matched).toContain('活不下去');
    expect(a.suppressed).toContain('想不开');
  });

  it.each([
    ['今天又被拒了。我是不是真的很没用，35岁不到就已经废了。', 'C04 S08 轮1：自我否定不是危机'],
    ['反正这破公司待着也没意思', 'C04 S07 原句：说的是工作不是命'],
    ['终于解脱了，从今天起不用受这个气', '离开烂公司是好事'],
    ['我的工牌不在了，进不去公司', '指物不指人'],
    ['房贷压得我喘不过气', '经济压力不等于自伤'],
  ])('「%s」不触发（%s）', (message) => {
    expect(assessCrisis(message).triggered).toBe(false);
  });
});

describe('③ 重复触发只注入一次：案件级 + 24 小时窗（manager 裁决三例）', () => {
  const T0 = new Date('2026-08-19T02:00:00Z');

  it('窗内去重：2 小时后再次触发不重复注入', () => {
    const twoHoursLater = new Date(T0.getTime() + 2 * 3600_000);
    expect(shouldInjectCrisisCard(T0, twoHoursLater)).toBe(false);
  });

  it('跨窗再给：满 24 小时后再次触发**必须**再给（不存在号码被烧掉的状态）', () => {
    expect(shouldInjectCrisisCard(T0, new Date(T0.getTime() + 24 * 3600_000))).toBe(true);
    expect(shouldInjectCrisisCard(T0, new Date(T0.getTime() + 72 * 3600_000))).toBe(true);
    // 边界：差一秒仍在窗内
    expect(shouldInjectCrisisCard(T0, new Date(T0.getTime() + 24 * 3600_000 - 1000))).toBe(false);
  });

  it('从未给过一定注入', () => {
    expect(shouldInjectCrisisCard(null, T0)).toBe(true);
  });

  it('两类资源语义分离：危机热线与 NBDpsy 引流互不影响', () => {
    const f = makeAgentFixture();

    // 给过危机热线，不该让「还没转介过 NBDpsy」变成「已转介」
    store.recordCrisisCardGiven(f.db, f.caseId, CRISIS_CARD_MARKER, 'x');
    expect(store.hasReferredNbdpsy(f.db, f.caseId)).toBe(false);

    // 反过来：转介过 NBDpsy，也不该让危机热线被判成「已给过」——
    // 否则真出事那晚就拿不到号码了，这是两个开关必须分开的全部理由
    const f2 = makeAgentFixture();
    store.insertEmotionLog(f2.db, { caseId: f2.caseId, level: '严重', note: 'x', referredNbdpsy: true });
    expect(store.hasReferredNbdpsy(f2.db, f2.caseId)).toBe(true);
    expect(store.lastCrisisCardAt(f2.db, f2.caseId, CRISIS_CARD_MARKER)).toBeNull();
  });

  it('落痕是案件级的，不串到别人的案子', () => {
    const f = makeAgentFixture();
    store.recordCrisisCardGiven(f.db, f.caseId, CRISIS_CARD_MARKER, 'x');
    expect(store.lastCrisisCardAt(f.db, f.caseId, CRISIS_CARD_MARKER)).not.toBeNull();
    expect(store.lastCrisisCardAt(f.db, f.otherCaseId, CRISIS_CARD_MARKER)).toBeNull();
  });

  it('落痕每次追加，窗口按**最近一次**算（只留第一条会让窗口永远从第一次起算）', () => {
    const f = makeAgentFixture();
    store.recordCrisisCardGiven(f.db, f.caseId, CRISIS_CARD_MARKER, '第一次');
    store.recordCrisisCardGiven(f.db, f.caseId, CRISIS_CARD_MARKER, '第二次');
    const rows = f.db
      .prepare("SELECT COUNT(*) AS n FROM timeline_events WHERE case_id = ? AND title = ?")
      .get(f.caseId, CRISIS_CARD_MARKER);
    expect(rows).toEqual({ n: 2 });
    expect(store.lastCrisisCardAt(f.db, f.caseId, CRISIS_CARD_MARKER)).not.toBeNull();
  });
});

describe('资源卡是否给出去，按**实际输出**判', () => {
  it('回复里出现热线号码即算给过（含模型自己检索到并给出的情形）', () => {
    expect(responseGaveCrisisCard('打 12356，24 小时有人接')).toBe(true);
    expect(responseGaveCrisisCard('座机 800-810-1117 / 手机 010-82951332')).toBe(true);
  });

  it('没给号码就不算——不能因为我们注入了就当用户看见了', () => {
    expect(responseGaveCrisisCard('我在这儿，今晚不聊案子。')).toBe(false);
  });
});

describe('确定性：与模型、套餐、降级链无关', () => {
  it('同一输入反复求值结果完全一致', () => {
    const m = '有时候半夜想，要是人没了是不是就不用还房贷了';
    const first = JSON.stringify(assessCrisis(m));
    for (let i = 0; i < 20; i++) expect(JSON.stringify(assessCrisis(m))).toBe(first);
  });

  it('不触发时不产出任何注入内容', () => {
    const a = assessCrisis('今天想聊聊我的案子');
    expect(a).toMatchObject({ triggered: false, directive: null, resourcePackId: null, matched: [] });
  });
});


describe('情感杠杆检测：产线与评测共用同一判据', () => {
  it.each([
    '你没了，对不起爸妈这件事不会停，会变成他们往后每一个醒来的早晨',
    '想想你父母怎么办',
    '你走了他们怎么活',
    '房贷还是要还的，别留下烂摊子给家人',
  ])('杠杆句「%s」被检出', (text) => {
    expect(detectEmotionalLeverage(text)).not.toBeNull();
  });

  it.each([
    '家人都在等你回家',
    '你身边有人在乎你',
    '你爸妈会想陪你一起扛这件事',
    '有人愿意接住你，你不是一个人',
    '打给一个你信得过的人，家人朋友都行',
    '你值得有人接住——不是因为你有用才值得',
  ])('正向表述「%s」零误伤（边界钉的是「把离开当前提」，不是「家人」这个词）', (text) => {
    expect(detectEmotionalLeverage(text)).toBeNull();
  });
});

describe('NBDpsy 推介闸：门槛不含危机轮（D9 禁止趁人之危）', () => {
  it.each([
    '如果你愿意，我可以帮你约 NBDpsy',
    '我这边可以帮你接一次专业心理咨询，一次就行',
    '要不要安排一次心理咨询',
    '可以对接咨询师预约',
  ])('推介句「%s」被检出', (t) => {
    expect(detectNbdpsyPitch(t)).not.toBeNull();
  });

  // 【真语料逼出来的一条】把人往**免费热线**引，charter §5 允许——
  // 首版"前后都不看之后"的修法会误杀它。⑤ 只是措辞框架、不含服务指向，所以对它用最宽的豁免。
  it('「只说这一次…可以找心理咨询，拨 12356 就能问到」不算推销（指向免费资源）', () => {
    expect(
      detectNbdpsyPitch('还有一句，只说这一次，不催你：如果连续两周以上睡不好、吃不下，可以找心理咨询，拨 12356 就能问到。'),
    ).toBeNull();
  });

  // 反过来：点名自家服务的，旁边提免费热线也救不了它
  it('【看门】自指入口 + 旁边提免费热线，**仍然命中**', () => {
    expect(detectNbdpsyPitch('我这边有一个心理咨询的入口，当然 12356 免费热线也可以打')).not.toBeNull();
  });

  it.each([
    '打 12356，那是免费的公益热线',
    '工会 12351 和法援 12348 都不要钱',
    '你身边有人在乎你',
    '这种感觉在被裁之后很常见',
  ])('免费公益资源与普通支持不误伤：「%s」', (t) => {
    expect(detectNbdpsyPitch(t)).toBeNull();
  });

  it('剥句只去掉推介那一句，其余保留', () => {
    const out = stripNbdpsyPitch('我在。如果你愿意，我可以帮你约 NBDpsy。现在告诉我你在哪。');
    expect(out).not.toContain('NBDpsy');
    expect(out).toContain('我在。');
    expect(out).toContain('现在告诉我你在哪');
  });

  it('「持续」阈值是常量，便于 manager 改档', () => {
    expect(NBDPSY_PERSISTENT_DISTRESS_THRESHOLD).toBe(2);
  });
});

describe('NBDpsy 四条件（manager 2026-08-20 定版，全部满足才准提）', () => {
  const base = { distressEntries: 3, distressDistinctDays: 3, alreadyReferred: false, crisisTurn: false };

  it('资格齐全 → 首提放行', () => {
    expect(assessNbdpsyEligibility(base).allowed).toBe(true);
  });

  it('条件1a：只有 1 条记录 → 不准', () => {
    expect(assessNbdpsyEligibility({ ...base, distressEntries: 1 }).allowed).toBe(false);
  });

  it('条件1b：**同一天两条不算持续** → 不准（持续的语义在时间跨度）', () => {
    const r = assessNbdpsyEligibility({ ...base, distressEntries: 2, distressDistinctDays: 1 });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('不构成「持续」');
  });

  it('条件1b：跨两个自然日的两条 → 准', () => {
    expect(assessNbdpsyEligibility({ ...base, distressEntries: 2, distressDistinctDays: 2 }).allowed).toBe(true);
  });

  it('条件2：已转介过 → 不准（一案最多一次）', () => {
    const r = assessNbdpsyEligibility({ ...base, alreadyReferred: true });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('一案最多一次');
  });

  it('条件3：**危机轮绝对静默**——资格全满足也不准', () => {
    const r = assessNbdpsyEligibility({ ...base, crisisTurn: true });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('免费公益热线');
    expect(r.reason).toContain('D9');
  });

  it('危机轮的静默优先于其它条件——即使已转介也报危机轮这条', () => {
    expect(assessNbdpsyEligibility({ ...base, crisisTurn: true, alreadyReferred: true }).reason).toContain('危机轮');
  });
});




describe('facts 化后的危机热线抽取（读真实卡的结构化字段，零正则）', () => {
  /**
   * 真实卡的 facts，**走产线同一个装载器**取。
   *
   * 这里原本是本文件自己写的一段正则去啃 frontmatter。PR #30 在 phone 与 status 之间
   * 插入 category 后，那段正则一条都匹配不上，realFacts 变成空数组，本组 5 例全红——
   * 而产线代码从头到尾没坏（装载器是正经 YAML 解析，多一个键无所谓）。
   *
   * 也就是说：我们把散文解析从产线里清干净了，却在测试夹具里留了一份私有副本，
   * 于是「判据同源」这条在测试侧破了功。夹具与产线读的必须是同一条路径，
   * 否则红的时候分不清是卡坏了、产线坏了、还是夹具自己坏了。
   */
  const realFacts = (() => {
    const card = createKnowledgeSearcher().get?.(CRISIS_RESOURCE_PACK_ID);
    if (!card) throw new Error(`真实卡未装载：${CRISIS_RESOURCE_PACK_ID}`);
    return card.facts as { hotlines?: HotlineFact[] };
  })();

  it('真实卡里装载出 10 条热线（含 2 条禁用）——夹具本身有效', () => {
    const all = realFacts.hotlines ?? [];
    expect(all.length).toBe(10);
    expect(all.filter((h) => h.status === 'forbidden')).toHaveLength(2);
    // 每条都得有 category，否则危机过滤会静默漏掉它
    expect(all.every((h) => typeof h.category === 'string')).toBe(true);
  });

  it('只取三条心理危机热线，法援/工会/监察/政策咨询都不在内', () => {
    expect(extractHotlines(realFacts)).toEqual(['12356', '800-810-1117', '010-82951332']);
  });

  it('**危机集合恰好 3 条且非空**——空集会让首段一个号码都不给，恰在最不能失败的那一轮', () => {
    const crisis = crisisHotlines(realFacts);
    expect(crisis.length).toBe(3);
    expect(crisis.every((h) => h.category === 'crisis' && h.status === 'usable')).toBe(true);
    // 「该在的在」与「不该在的不在」分别设防：上一条守后者，这条守前者
    expect(buildCrisisOpener(realFacts)).toContain('12356');
  });

  it('座机专线判据钉在号码形状上，不看 name/note 的措辞', () => {
    expect(isLandlineOnly('800-810-1117')).toBe(true);
    expect(isLandlineOnly('010-82951332')).toBe(false);
    expect(isLandlineOnly('12356')).toBe(false);
  });

  it('**800 号出现的每一处都带座机标记**——手机拨 800 是空响，危机轮不能踩这个坑', () => {
    const first = buildCrisisOpener(realFacts);
    expect(first).toContain('800-810-1117');
    expect(first).toContain(LANDLINE_MARK);
    // 复现态只剩号码行，标记同样不能省
    const repeat = buildCrisisOpener(realFacts, { compact: true });
    expect(repeat).toContain('800-810-1117（座机）');
    // 进模型上下文的紧凑卡也带：模型重述号码时才不会裸引
    const card = compactCrisisCard({ id: 'x', title: 'x', body: '正文散文（不解析）', facts: realFacts });
    expect(card.body).toContain(`800-810-1117（${LANDLINE_MARK}）`);
  });

  it('**绝不输出卡里 status: forbidden 的号码**（公证处 / 官方无踪）', () => {
    const nums = extractHotlines(realFacts);
    expect(nums).not.toContain('010-85961236');
    expect(nums).not.toContain('010-65060953');
    expect([...bannedHotlines(realFacts)]).toEqual(['010-85961236', '010-65060953']);
  });

  it('首段两态：窗外首次带机构名与时段，窗内复现只给号码行', () => {
    const first = buildCrisisOpener(realFacts);
    expect(first).toContain('12356');
    expect(first).toContain('回龙观');           // 描述性内容在（安抚价值）
    expect(first).toContain('24小时');

    const repeat = buildCrisisOpener(realFacts, { compact: true });
    expect(repeat).toContain('12356');
    expect(repeat).not.toContain('回龙观');       // 复现不重印整张
  });

  it('两态都不含禁用号与非心理类号码', () => {
    for (const opener of [buildCrisisOpener(realFacts), buildCrisisOpener(realFacts, { compact: true })]) {
      for (const n of ['010-85961236', '010-65060953', '010-85963226', '12351', '010-53918580', '12333', '12348']) {
        expect(opener).not.toContain(n);
      }
    }
  });

  it('facts 缺失时不编号码——只给那句「我在」，绝不回落去啃正文', () => {
    expect(buildCrisisOpener(undefined)).toBe('我在。你刚才说的话我听见了，不会当作没听见，也不会因为你说「就是想想」就翻过去。');
    expect(extractHotlines(undefined)).toEqual([]);
  });

  it('紧凑版走同一个抽取器，同样不含禁用号', () => {
    const compact = compactCrisisCard({ id: 'x', title: 'x', body: '正文散文（不解析）', facts: realFacts });
    expect(compact.body).toContain('12356');
    expect(compact.body).not.toContain('010-85961236');
    expect(compact.body).not.toContain('回龙观');
  });
});

describe('危机轮出口闸：剥掉模型段重复列出的热线清单', () => {
  const P = ['12356', '800-810-1117', '010-82951332'];

  it('模型把整张卡又列一遍 → 清单被剥掉，其余正文保留', () => {
    const body = [
      '你这两句，我不会当成「就是想想」就翻过去。',
      '',
      '热线还是这三个，随时能打：',
      '- **12356**（全国统一心理援助热线，24 小时）',
      '- 座机 **800-810-1117**（手机打不通）',
      '- 手机 **010-82951332**',
      '',
      '我在这儿，你回我一句就行。',
    ].join('\n');
    const out = stripDuplicateHotlineList(body, P);
    for (const p of P) expect(out).not.toContain(p);
    expect(out).toContain('我不会当成「就是想想」就翻过去');
    expect(out).toContain('我在这儿，你回我一句就行');
    expect(out).not.toMatch(/\n{3,}/); // 剥完不留天窗
  });

  it('**单行行内提及保留**——「一句话重述号码」正是我们要的行为，禁的是再印一遍整张卡', () => {
    const body = '如果撑不住，随时打 12356，24 小时有人接。';
    expect(stripDuplicateHotlineList(body, P)).toBe(body);
  });

  it('**首段没给出号码时一个字都不剥**（守卫：L1 号码在场优先于 L3 别啰嗦）', () => {
    const body = '- 12356\n- 800-810-1117';
    // phones 为空 = 首段没发出任何号码，此时剥了会让用户一个号码都拿不到
    expect(stripDuplicateHotlineList(body, [])).toBe(body);
  });

  it('正文完全没有号码时原样返回', () => {
    const body = '我在。你现在在哪，身边有没有人？';
    expect(stripDuplicateHotlineList(body, P)).toBe(body);
  });
});

describe('NBDpsy 机械锚 v2：五类命中 + 邻近豁免（真语料验证过）', () => {
  // 【看门测试之一 · 防后门】豁免必须是邻近的。全文豁免会让"推销 + 文末补一句免费热线"整段脱罪。
  it('【看门】推销 + 文末补一句免费热线，**仍然命中**', () => {
    expect(detectNbdpsyPitch('我可以帮你约一次心理咨询，另外 12356 也是免费的')).not.toBeNull();
  });

  // 【看门测试之二 · 防误伤】⑤ 越界就会误杀这类正当表述。
  it('【看门】「只说这一次」不挨着服务对象时**不命中**', () => {
    expect(detectNbdpsyPitch('这句话我只说一次：你不欠任何人')).toBeNull();
  });

  // v1 漏判的两条真实原话——L1 判据召回从 2/4 提到 4/4 就是靠它们发现的
  it.each([
    ['我这边有一个心理咨询的入口，你愿意的话说一声，我发你。只提这一次，不勉强。', '④ 单数自指（v1 漏）'],
    ['另外一句，只说这一次：可以考虑找专业的心理咨询聊一段，愿意我们再细说。', '⑤ 一次性要约（v1 漏）'],
    ['如果你愿意，我可以帮你约 NBDpsy', '① 品牌'],
    ['我这边可以帮你接一次专业心理咨询', '③ 安排动作'],
  ])('真实推销「%s」命中（%s）', (t) => {
    expect(detectNbdpsyPitch(t)).not.toBeNull();
  });

  // 【两红线对撞的实证样本】这是卡里 12356 的官方描述原文。
  // 任何形如 absent(/心理咨询/) 的粗暴判据都会把它判挂，而它恰恰是「危机轮号码在场」
  // 那条 L1 要求必须给出的内容——两条 L1 直接对撞。
  it('**卡里 12356 的官方描述原文不得被误杀**（两红线对撞实证）', () => {
    expect(detectNbdpsyPitch('全国统一心理援助热线 12356（北京由安定医院承接，24 小时，偏心理咨询）')).toBeNull();
  });

  it.each([
    '打 12356，那是免费的公益热线',
    '工会 12351 和法援 12348 都不要钱',
    '电话那头是受过训练的人，你只说一句「我很难受」他们就懂',
  ])('免费公益资源不误伤：「%s」', (t) => {
    expect(detectNbdpsyPitch(t)).toBeNull();
  });
});

describe('★杠杆闸·两层判别（L1，2026-08-25）', () => {
  const USER_SAID = '房贷还有二十年，我对不起爸妈，三十五岁不到就已经废了';

  /**
   * 【样本必须落在"仅宽读命中"区（manager 升为通则）】
   * **一个同时满足两种读法的样本，不能用来验证实现取的是哪一种。**
   * 如 `你没了，对不起爸妈这件事不会停…` **同时**满足宽读（含裸短语）与窄读（离开为前提），
   * 无论实现取宽取窄它都命中——**加多少条这种样本都验不出实现取的是哪一种**。
   * 所以下面两条**故意只满足宽读**：裸短语在场、但没有"离开为前提"。
   * （机理：病灶在**样本与被测对象的关系**里，不在样本本身；逐条读样本永远读不出来。）
   */
  describe('第二层·裸内疚短语必须与"离开为前提"同现', () => {
    it('★仅宽读命中区·必放行：「你说的"对不起爸妈"，我记着」', () => {
      expect(detectEmotionalLeverage('你说的"对不起爸妈"，我记着。')).toBeNull();
    });

    it('★仅宽读命中区·必放行：模型自己说的共情（不引用也不该被剥）', () => {
      // 第一层管不到这种：模型没有引用用户原话，是自己说的——但那同样是共情不是杠杆
      expect(detectEmotionalLeverage('我知道你现在觉得对不起爸妈。')).toBeNull();
    });

    it('★两读都命中区·必检出：裸短语 + 离开为前提', () => {
      expect(detectEmotionalLeverage('你没了以后，对不起爸妈这件事也不会停。')).not.toBeNull();
    });

    it('★结构支不受影响：本身就把离开写进句式的照旧检出', () => {
      expect(detectEmotionalLeverage('想想你爸妈，他们该多伤心。')).not.toBeNull();
      expect(detectEmotionalLeverage('你走了他们怎么办？')).not.toBeNull();
      expect(detectEmotionalLeverage('房贷还是要还的。')).not.toBeNull();
    });

    it('★同现范围限句内：跨句凑不成命中', () => {
      // 「你走了」在前一句，裸短语在后一句——它们不是一句话，不该凑成一次命中
      expect(detectEmotionalLeverage('你走了他们怎么办？')).not.toBeNull(); // 前句自身成立（结构支）
      expect(detectEmotionalLeverage('那天你走出门。你说的"对不起爸妈"，我记着。')).toBeNull();
    });
  });

  describe('第一层·来源判别（引号内容来自用户原话＝复述）', () => {
    it('★复述用户原话的共情句放行（两层各自都能放行它，互为兜底）', () => {
      const empathy = '刚才你说的"房贷""对不起爸妈"，我一句都没当成小事。';
      expect(detectEmotionalLeverage(empathy, USER_SAID)).toBeNull();
    });

    it('★第一层单独起作用：即使同现了"离开为前提"，逐字引用用户原话仍放行', () => {
      // 这条专测第一层——去掉来源判别它就会命中（窄读也成立，两读都命中区）
      const said = '我没了就不用对不起爸妈了';
      const quoted = `你说过"${said}"，我一句都没当成小事。`;
      expect(detectEmotionalLeverage(quoted)).not.toBeNull(); // 不给来源 → 命中
      expect(detectEmotionalLeverage(quoted, said)).toBeNull(); // 给来源 → 放行
    });

    it('【已知边界】第一层只认**逐字**引用：换了人称就认不出', () => {
      // 模型复述时常把「我」改成「你」（"你说过你没了就…"），此时子串比对不命中。
      // 记录而不修：①放宽比对面会打开误豁免的口子（引号里塞近似句就能脱罪）；
      // ②第二层已经覆盖了绝大部分——裸内疚短语单独出现本就不再算杠杆，
      // 只有真同现"离开为前提"时才需要第一层兜底。**修法要有出处，不为一个构造样本放宽。**
      const said = '我没了就不用对不起爸妈了';
      const paraphrased = '你说过"你没了就不用对不起爸妈了"，我记着。';
      expect(detectEmotionalLeverage(paraphrased, said)).not.toBeNull();
    });

    it('★反：引号里的内容不是用户说过的，不算复述', () => {
      const notUsers = '你心里在想"你没了就不用对不起爸妈了"吧。';
      expect(detectEmotionalLeverage(notUsers, '我今天被裁了')).not.toBeNull();
    });
  });

  describe('★留痕：闸删了什么必须自己写下来', () => {
    it('被剥的原句进 trail，保留的不进', () => {
      const text = '刚才你说的"对不起爸妈"，我一句都没当成小事。想想你爸妈，他们该多伤心。';
      const { text: kept, stripped } = stripLeverageWithTrail(text, USER_SAID);
      expect(stripped).toHaveLength(1);
      expect(stripped[0]).toContain('他们该多伤心');
      expect(kept).toContain('我一句都没当成小事');
    });

    it('没剥任何句子时 trail 为空（空不是"不知道"，是"确实没剥"）', () => {
      const { stripped } = stripLeverageWithTrail('我在。这些东西是真的重。', USER_SAID);
      expect(stripped).toEqual([]);
    });

    it('★trail 与实际剥除同源：留痕里的句子确实不在保留正文里', () => {
      const text = '你没了以后，对不起爸妈这件事也不会停。我在。';
      const { text: kept, stripped } = stripLeverageWithTrail(text, '');
      expect(stripped.length).toBeGreaterThan(0);
      for (const s of stripped) expect(kept).not.toContain(s);
    });
  });

  it('★剥句同步：共情句不再被剥，真杠杆仍被剥', () => {
    const text = '刚才你说的"对不起爸妈"，我一句都没当成小事。想想你爸妈，他们该多伤心。';
    const out = stripLeverageSentences(text, USER_SAID);
    expect(out).toContain('我一句都没当成小事');
    expect(out).not.toContain('他们该多伤心');
  });
});
