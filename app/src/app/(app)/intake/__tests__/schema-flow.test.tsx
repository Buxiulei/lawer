// app/src/app/(app)/intake/__tests__/schema-flow.test.tsx
// 首诊页按 DomainPack.intakeSchema 排步与校验（设计稿 §13「首诊」行、§16 分期 W4）。
//
// ─────────────── 这组守的是什么 ───────────────
// 「按 schema 问」这条路的全部坏法都是**静默**的：
//   · 排步用了别的顺序 / 少一步        ⇒ 那一格从此没人问，回包照常 201；
//   · body 键拿了 intakeSchema.param   ⇒ 服务端读不到那一格，却回一句「这项要填」，
//                                        而用户明明填了（元/分那一格就是这么错的）；
//   · 拦人的话写成一句通用的「有必填项未填」⇒ 用户照原样再交一次，再收到同一句；
//   · 草稿跨领域没作废                 ⇒ 上一个领域的答案按这个领域的 schema 交上去，
//                                        每一格都对得上某个键，服务端照收。
// 四种都不会让页面报错，所以逐条钉在这里。
//
// 【为什么造一个假包，而不是只用注册表里那几个】注册表里的包会变（W3 之后 counseling
// 的问法还会改），拿它们当"某个 kind 该怎么问"的样本，判据就跟着内容一起漂。
// 假包只声明**形状**：每种 kind 各一格、必填与选填各有、param 与 key 故意不同名。
// 与此同时，凡是"每个包都必须成立"的那几条（下半部分）逐包跑，一个都不放过。
import { describe, expect, it } from 'vitest';

import { INTAKE_PARAM_OF_KEY } from '@/lib/cases/intake-params';
import { DEFAULT_DOMAIN, DOMAINS, type DomainPack, type IntakeFieldSpec } from '@/lib/domains/registry';

import { EMPTY_DRAFT, draftForDomain, type IntakeDraft } from '../_components/draft';
import {
  HANDWRITTEN_DOMAINS,
  emptyValue,
  fenOf,
  fieldBlock,
  hasHandwrittenFlow,
  isFilled,
  isRealDate,
  schemaPayload,
  stepTitleOf,
  type FieldValue,
} from '../_components/schemaFlow';
import { HANDWRITTEN_FLOWS, schemaSteps } from '../_components/IntakeFlow';
import { toIntakePayload } from '../_components/submit';

const TODAY = '2026-09-07';

/** 只声明形状的假包：每种 kind 一格，必填/选填各有，param 与 key 故意不同名。 */
const FAKE_SCHEMA: IntakeFieldSpec[] = [
  {
    key: 'stage',
    param: 'stage',
    kind: 'enum',
    required: true,
    values: ['甲', '乙'],
    description: '现在到哪一步了，选一个（后面按它排事）',
    errorCode: 'INVALID_STAGE',
    invalidMessage: 'stage 只能是 {values}',
  },
  {
    key: 'companyName',
    param: 'company_name',
    kind: 'text',
    required: true,
    description: '对面那一方怎么称呼',
    errorCode: 'INVALID_NAME',
    invalidMessage: '这一项不能空着，后面每一份材料都靠它指认是谁',
  },
  {
    key: 'employedFrom',
    param: 'employed_from',
    kind: 'date',
    required: true,
    description: '哪一天开始的',
    errorCode: 'INVALID_DATE',
    invalidMessage: '日期要写成 YYYY-MM-DD',
    futureMessage: '这个日子还没到，填一个已经发生过的',
  },
  {
    // 对外收元、内部存分：param 与 key 故意不同名，body 键拿错就读不到
    key: 'monthlyWageFen',
    param: 'monthly_wage_yuan',
    kind: 'money',
    required: true,
    description: '一次多少钱，单位元',
    errorCode: 'INVALID_MONEY',
    invalidMessage: '要填一个大于 0 的数字',
  },
  {
    key: 'goals',
    param: 'goals',
    kind: 'stringList',
    required: true,
    description: '你想要的结果，至少一项',
    errorCode: 'INVALID_GOALS',
    invalidMessage: '至少写一项',
  },
  {
    key: 'events',
    param: 'events',
    kind: 'eventList',
    required: false,
    description: '发生过哪些事，可省略',
  },
  {
    key: 'companyDocs',
    param: 'company_docs',
    kind: 'record',
    required: false,
    description: '手上有哪几份材料',
    fields: [
      { key: 'terminationNotice', label: '第一份' },
      { key: 'settlementAgreement', label: '第二份' },
    ],
  },
  {
    key: 'bottomLine',
    param: 'bottom_line',
    kind: 'text',
    required: false,
    description: '你的底线，可省略',
  },
];

const FAKE_PACK = { key: '假领域', intakeSchema: FAKE_SCHEMA } as unknown as DomainPack;
const field = (key: string) => FAKE_SCHEMA.find((f) => f.key === key)!;

/* ── 一、一格没填时长什么样 ─────────────────────────────── */

describe('emptyValue：按 kind 给空值（给 undefined 会让受控输入框变成非受控）', () => {
  it.each([
    ['stage', ''],
    ['companyName', ''],
    ['employedFrom', ''],
    ['monthlyWageFen', ''],
  ])('%s → 空串', (key, want) => {
    expect(emptyValue(field(key))).toBe(want);
  });

  it('stringList / eventList → 空数组；record → 空对象', () => {
    expect(emptyValue(field('goals'))).toEqual([]);
    expect(emptyValue(field('events'))).toEqual([]);
    expect(emptyValue(field('companyDocs'))).toEqual({});
  });
});

/* ── 二、拦不拦、拦下来说什么 ───────────────────────────── */

describe('fieldBlock：拦下来说的是**这个包自己那句话**', () => {
  it('词表外的取值被拦，且 {values} 换成了这一格的取值集合', () => {
    expect(fieldBlock(field('stage'), '丙', TODAY)).toBe('stage 只能是 甲 / 乙');
    expect(fieldBlock(field('stage'), '甲', TODAY)).toBeNull();
  });

  it('必填的一行字：空白（含全是空格）被拦', () => {
    expect(fieldBlock(field('companyName'), '   ', TODAY)).toBe(field('companyName').invalidMessage);
    expect(fieldBlock(field('companyName'), '来访A', TODAY)).toBeNull();
  });

  it('日期：格式不对说格式，**指向将来说的是另一句**（回同一句的话，用户照着改格式还是被拒）', () => {
    expect(fieldBlock(field('employedFrom'), '2026/01/09', TODAY)).toBe(
      field('employedFrom').invalidMessage,
    );
    // 格式合法但不存在的一天
    expect(fieldBlock(field('employedFrom'), '2026-02-31', TODAY)).toBe(
      field('employedFrom').invalidMessage,
    );
    expect(fieldBlock(field('employedFrom'), '2026-09-08', TODAY)).toBe(
      field('employedFrom').futureMessage,
    );
    expect(fieldBlock(field('employedFrom'), TODAY, TODAY)).toBeNull();
  });

  it('金额：0、负数、不是数字都被拦', () => {
    for (const bad of ['0', '-3', '', 'abc']) {
      expect(fieldBlock(field('monthlyWageFen'), bad, TODAY)).toBe(
        field('monthlyWageFen').invalidMessage,
      );
    }
    expect(fieldBlock(field('monthlyWageFen'), '800', TODAY)).toBeNull();
  });

  it('诉求：一项都没有（或只有空白项）被拦', () => {
    expect(fieldBlock(field('goals'), [], TODAY)).toBe(field('goals').invalidMessage);
    expect(fieldBlock(field('goals'), ['  '], TODAY)).toBe(field('goals').invalidMessage);
    expect(fieldBlock(field('goals'), ['退一半'], TODAY)).toBeNull();
  });

  it('不必填的一格一律放行（不必填却拦下来 = 照说明书填齐了仍被拒）', () => {
    for (const key of ['events', 'companyDocs', 'bottomLine']) {
      expect(fieldBlock(field(key), emptyValue(field(key)), TODAY)).toBeNull();
    }
  });
});

describe('isRealDate / fenOf / isFilled', () => {
  it('2 月 31 号不是一天（只查格式的形态是把它一路放到后端）', () => {
    expect(isRealDate('2026-02-31')).toBe(false);
    expect(isRealDate('2026-02-28')).toBe(true);
    expect(isRealDate('2026-2-8')).toBe(false);
  });

  it('元 → 分：小数按分四舍五入，非正数回 null', () => {
    expect(fenOf('800')).toBe(80000);
    expect(fenOf('800.55')).toBe(80055);
    expect(fenOf('0')).toBeNull();
  });

  it('isFilled：空白字符串 / 只有空白项的数组 / 值全空的 record 都算没填', () => {
    expect(isFilled('  ')).toBe(false);
    expect(isFilled([])).toBe(false);
    expect(isFilled([{ id: 'a', date: '', text: '  ' }])).toBe(false);
    expect(isFilled({ a: '' })).toBe(false);
    expect(isFilled([{ id: 'a', date: '', text: '有事' }])).toBe(true);
  });
});

/* ── 三、拼请求体：body 键取自对照表，不取 param ─────────── */

describe('schemaPayload：body 键取自对照表（拿 param 当键 = 服务端读不到那一格）', () => {
  const values: Record<string, FieldValue> = {
    stage: '甲',
    companyName: ' 来访A ',
    employedFrom: '2025-03-04',
    monthlyWageFen: '800',
    goals: [' 退一半 ', '  '],
    events: [
      { id: 'e1', date: '2026-01-09', text: '发生过一件事' },
      { id: 'e2', date: '', text: '   ' },
    ],
    companyDocs: { terminationNotice: '有' },
    bottomLine: '',
  };

  it('月工资那一格的键是 monthly_wage_fen（不是 schema 上的 monthly_wage_yuan），值是**分**', () => {
    const body = schemaPayload(FAKE_PACK, values);
    expect(Object.keys(body)).toContain('monthly_wage_fen');
    expect(Object.keys(body)).not.toContain('monthly_wage_yuan');
    expect(body.monthly_wage_fen).toBe(80000);
  });

  it('一行字去空白、诉求丢掉空项、事件丢掉没正文的那条', () => {
    const body = schemaPayload(FAKE_PACK, values);
    expect(body.company_name).toBe('来访A');
    expect(body.goals).toEqual(['退一半']);
    expect(body.events).toEqual([{ date: '2026-01-09', text: '发生过一件事' }]);
  });

  it('一格都没填也把每个键发出去（服务端才说得出「这项要填」是哪一项）', () => {
    const body = schemaPayload(FAKE_PACK, {});
    expect(Object.keys(body).sort()).toEqual(
      FAKE_SCHEMA.map((f) => INTAKE_PARAM_OF_KEY[f.key] ?? f.param).sort(),
    );
  });
});

/* ── 四、排步：顺序即 schema 的顺序 ─────────────────────── */

describe('schemaSteps：一格一步，末步是「你的档案」', () => {
  const steps = schemaSteps(FAKE_PACK);

  it('步数 = 字段数 + 1，说明逐字是包里那句 description', () => {
    expect(steps.length).toBe(FAKE_SCHEMA.length + 1);
    steps.slice(0, -1).forEach((step, i) => {
      expect(step.reassurance).toBe(FAKE_SCHEMA[i].description);
    });
  });

  it('抬头取 description 的第一句（整句摆进 20px 标题会折成三行）', () => {
    expect(stepTitleOf(field('stage'))).toBe('现在到哪一步了');
    expect(steps[0].title).toBe('现在到哪一步了');
    expect(steps[steps.length - 1].title).toBe('你的档案');
  });

  it('每一步只拦自己那一格（第 i 步的拦人话 = 第 i 个字段的话）', () => {
    FAKE_SCHEMA.forEach((f, i) => {
      const blank: IntakeDraft = { ...EMPTY_DRAFT, fields: { [f.key]: emptyValue(f) } };
      const want = f.required
        ? (f.invalidMessage ?? '').replace('{values}', (f.values ?? []).join(' / '))
        : null;
      expect(steps[i].block?.(blank, TODAY) ?? null, `第 ${i + 1} 步`).toBe(want);
    });
  });
});

/* ── 五、草稿换了领域就整份作废 ─────────────────────────── */

describe('draftForDomain：换了领域整份作废（上一个领域的答案不许被这个领域交上去）', () => {
  const filled: IntakeDraft = {
    ...EMPTY_DRAFT,
    domain: '甲领域',
    step: 3,
    fields: { companyName: '上一个领域填的' },
  };

  it('同一个领域 → 原样接着填（连对象都不换，React 才认得出没变）', () => {
    expect(draftForDomain(filled, '甲领域')).toBe(filled);
  });

  it('存量草稿没记领域 → 只补上领域，填过的一格不动', () => {
    const legacy: IntakeDraft = { ...filled, domain: '' };
    const next = draftForDomain(legacy, '乙领域');
    expect(next.domain).toBe('乙领域');
    expect(next.fields).toEqual(legacy.fields);
    expect(next.step).toBe(legacy.step);
  });

  it('换了领域 → 答案与步数一起清空（变异：把这一支改成保留 fields → 红）', () => {
    const next = draftForDomain(filled, '乙领域');
    expect(next.fields).toEqual({});
    expect(next.step).toBe(0);
    expect(next.domain).toBe('乙领域');
  });

  /*
   * 【空串是"还不知道"，不是"某个领域"】首诊页问「我名下那个案子属于哪个领域」是挂载
   * 之后的一次请求，在它回来之前这一页手里只有空串，而 packOf 在那一帧退回的是缺省领域。
   * 少了这一支的形态是：第二个领域的用户**每刷新一次就被清一次档**——
   * 第一帧按缺省领域比对判成"换了领域"整份作废，第二帧问到了自己的领域，
   * 而那时上次填的每一格已经没了。屏幕上只是显示"从头开始"，一处报错都没有。
   */
  it('领域还没问出来（空串）→ 一格都不动（变异：删掉 `domain === "" ` 那一支 → 红）', () => {
    expect(draftForDomain(filled, '')).toBe(filled);
  });

  it('刷新那两帧走完，第二个领域上次填的一格不少（先「还不知道」，后「就是它自己」）', () => {
    const saved: IntakeDraft = {
      ...EMPTY_DRAFT,
      domain: '乙领域',
      step: 3,
      fields: { companyName: '上次填到一半' },
    };
    // 第一帧：probe 还没回来，页面手里是空串（packOf 那一帧退回的是缺省领域）
    const frame1 = draftForDomain(saved, '');
    // 第二帧：问到了，正是这份草稿自己的领域
    const frame2 = draftForDomain(frame1, '乙领域');
    expect(frame2.fields, '刷新一次就把上次填的清空了').toEqual(saved.fields);
    expect(frame2.step, '步数也被打回第一步').toBe(3);
  });
});

/* ── 五之二、「有没有手写稿」只有一份名单 ───────────────── */

/*
 * 这条分流有两个隔着文件的读者：排步（IntakeFlow 的 HANDWRITTEN_FLOWS）与拼请求体
 *（submit.toIntakePayload）。它们分叉的形态是——第二个领域也有了手写稿之后，
 * 页面按那份稿子问、请求体按 schema 拼，每一格都是空的而回包照常 201。
 * 名单收在 schemaFlow.HANDWRITTEN_DOMAINS，这里钉住那张表的键与它逐字相同。
 */
describe('手写向导：登记表与名单是同一份', () => {
  it('HANDWRITTEN_FLOWS 的键 = HANDWRITTEN_DOMAINS（变异：往表里加一个键不加进名单 → 红）', () => {
    expect(Object.keys(HANDWRITTEN_FLOWS).sort()).toEqual([...HANDWRITTEN_DOMAINS].sort());
  });

  it('名单不是空的，也不是"人人有份"（空了 = 所有领域都走 schema，满了 = 都走手写）', () => {
    expect(HANDWRITTEN_DOMAINS.length).toBeGreaterThan(0);
    expect(HANDWRITTEN_DOMAINS.length).toBeLessThan(Object.keys(DOMAINS).length + 1);
    for (const key of HANDWRITTEN_DOMAINS) {
      expect(DOMAINS[key], `名单里的「${key}」不是注册表里的领域`).toBeTruthy();
    }
  });
});

/* ── 六、逐包成立的那几条 ───────────────────────────────── */

describe.each(Object.keys(DOMAINS))('%s 包', (key) => {
  const pack = DOMAINS[key];

  // 「每个首诊字段都有人接」那条在 lib/cases/__tests__/intake-params.test.ts：
  // 它同时钉住服务端那半（收进去之后真的落了库），比只查一张表更有牙。

  it('必填项都带着自己那句话（带 required 不带 invalidMessage = 拦下来无话可说）', () => {
    for (const f of pack.intakeSchema) {
      if (!f.required) continue;
      expect(f.invalidMessage, `${f.key} 必填却没有 invalidMessage`).toBeTruthy();
    }
  });

  it('抬头切出来不是空的（description 以标点开头时会切成空串，那一步就顶着一个空标题）', () => {
    for (const f of pack.intakeSchema) {
      expect(stepTitleOf(f).length, `${f.key} 的步骤抬头是空的`).toBeGreaterThan(0);
    }
  });
});

/* ── 七、缺省领域零变化 ─────────────────────────────────── */

describe('缺省领域：这一版一个字节都不许动它', () => {
  it('仍然走手写的那份向导，不走 schema 排步', () => {
    expect(hasHandwrittenFlow(DEFAULT_DOMAIN)).toBe(true);
  });

  it('请求体与不传领域包时逐字节一致（走的是同一份手写映射）', () => {
    const draft: IntakeDraft = {
      ...EMPTY_DRAFT,
      stage: '风声',
      companyName: '某公司',
      hiredOn: '2024-01-08',
      monthlyWage: '18000',
      position: '后端',
      contractCount: '只签过一次',
      events: [{ id: 'e1', date: '2026-01-09', text: 'HR 找我谈' }],
      freeText: '整段经过',
      terminationNotice: '有',
      settlementAgreement: '没有',
      otherPaper: '不确定',
      companyWording: '口头说的',
      goals: ['拿到 2N'],
      bottomLine: '不低于 N',
    };
    expect(JSON.stringify(toIntakePayload(draft, DOMAINS[DEFAULT_DOMAIN]))).toBe(
      JSON.stringify(toIntakePayload(draft)),
    );
    // 而且它读的是手写那些字段，不是 draft.fields——读错了这里会变成一份空请求体
    expect(toIntakePayload(draft).company_name).toBe('某公司');
    expect(toIntakePayload(draft).monthly_wage_fen).toBe(1800000);
  });
});
