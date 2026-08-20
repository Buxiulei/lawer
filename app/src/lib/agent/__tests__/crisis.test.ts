// app/src/lib/agent/__tests__/crisis.test.ts
// 危机识别层（manager 2026-08-19 架构加固令要求的三类断言）：
//   ① 触发词表覆盖（自伤/轻生类表述变体）
//   ② 否定语境不误触
//   ③ 重复触发只注入一次（案件级去重，且与 NBDpsy 引流是两个独立开关）
//
// 这一层是纯函数，所以①②完全离线可断；③要落库，用真库跑。
import { describe, expect, it } from 'vitest';

import * as store from '@/lib/db/agent';
import {
  assessCrisis,
  compactCrisisCard,
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

describe('窗内注入紧凑版资源卡（模型印不出没见过的整张卡）', () => {
  const FULL = {
    id: CRISIS_RESOURCE_PACK_ID,
    title: '北京免费求助资源卡',
    body: [
      '## 心理热线（成对给出，缺一不可）',
      '| 全国统一心理援助热线（北京由安定医院承接） | **12356** | 24 小时 |',
      '| 北京心理援助热线（回龙观医院·北京心理危机研究与干预中心） | 座机 **800-810-1117** / 手机 **010-82951332** | 7×24 人工接听 |',
      '## 法律援助（朝阳）',
      '- 朝阳区公共法律服务中心：电话 010-85963226',
    ].join('\n'),
  };

  it('裁完只剩号码，整张卡的描述性内容不再出现——模型无从重印', () => {
    const c = compactCrisisCard(FULL);
    expect(c.body).toContain('12356');
    expect(c.body).toContain('800-810-1117');
    expect(c.body).toContain('010-82951332');
    expect(c.body).not.toContain('回龙观');
    expect(c.body).not.toContain('安定医院');
    expect(c.body).not.toContain('人工接听');
    expect(c.body).toContain('不要再整张重印');
  });

  it('id 与 title 不变（仍是同一张卡，只是这一轮只给号码）', () => {
    expect(compactCrisisCard(FULL).id).toBe(FULL.id);
    expect(compactCrisisCard(FULL).title).toBe(FULL.title);
  });

  it('号码从卡里抽，不写死在代码里——卡改了裁出来的也跟着改', () => {
    const changed = { ...FULL, body: '热线 12356 与 座机 800-810-9999 / 手机 010-11112222' };
    const c = compactCrisisCard(changed);
    expect(c.body).toContain('800-810-9999');
    expect(c.body).not.toContain('800-810-1117');
  });

  it('抽不出足够号码时原样退回整张卡——宁可重印一次，也不能让危机轮少了号码', () => {
    const noNumbers = { ...FULL, body: '这张卡里没有任何号码' };
    expect(compactCrisisCard(noNumbers)).toBe(noNumbers);
  });
});
