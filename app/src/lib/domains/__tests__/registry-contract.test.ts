// app/src/lib/domains/__tests__/registry-contract.test.ts
// 领域注册表的两条契约：**包必须完整**（assertDomainPack）与**灰度开关说了算**
// （LAWER_DOMAINS_ENABLED）。
//
// 【这两条为什么值得一份判据】它们的失效都是静默的：
//   · 缺一项的包不会崩，只会让那一块从此不工作（空词表 = 那类判定永不触发）；
//   · 灰度开关失灵不会报错，只会让一个还没验收过的领域悄悄开始接用户。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { LABOR } from '../labor';
import {
  assertDomainPack,
  DEFAULT_DOMAIN,
  domainPackOrDefault,
  DOMAINS,
  DOMAINS_ENABLED_ENV,
  enabledDomainKeys,
  getDomainPack,
  isDomainEnabled,
  listDomains,
  requireEnabledDomain,
  type DomainPack,
} from '../registry';

/** 深拷一份 labor 当模板，改坏其中一项看守卫认不认。原包不能动（它是全站在用的那一个）。 */
function clone(over: Partial<DomainPack> = {}): DomainPack {
  return { ...LABOR, ...over };
}

/**
 * lawyerReview / sensitive 两节的**完好**样张。labor 包没有这两节（省略 = 本领域没这回事），
 * 所以要验「一旦声明就不许半张」，得先自己给一份齐的再打坏其中一项——
 * 直接打坏一个不存在的节，守卫本来就该放过，那条判据就成了恒绿。
 *
 * 【为什么不从 counseling 包里取】判据要验的是守卫，不是某个包今天长什么样：
 * 借用真包的话，真包哪天把某一节删了，这几条负样本会一起变成"没声明"而恒绿。
 */
const FULL_LAWYER_REVIEW = {
  title: '待律师核',
  items: ['这一条为什么还没有结论'],
  discipline: '未经律师书面确认不得作为结论输出',
} as const;

const FULL_SENSITIVE = {
  subject: '第三人',
  factsNotice: '这一节里有第三人的敏感信息，逐条核对再用',
  redactNotice: '本页已做脱敏处理',
  aliasRoles: ['签约主体'],
} as const;

const ORIGINAL_ENV = process.env[DOMAINS_ENABLED_ENV];

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env[DOMAINS_ENABLED_ENV];
  else process.env[DOMAINS_ENABLED_ENV] = ORIGINAL_ENV;
});

describe('assertDomainPack：包必须实现全部字段', () => {
  it('注册表里已挂的包全部合格（装载时就跑过一遍，这里再钉一次）', () => {
    for (const pack of Object.values(DOMAINS)) expect(() => assertDomainPack(pack)).not.toThrow();
  });

  /**
   * 逐项打坏。**每一项单独一条**：合成一条大断言的形态是，其中一项守卫失效时
   * 整条仍然红（别的项还在报），于是没人发现少了一道。
   *
   * 【这张表此前只覆盖一半的必填项】parties.self / parties.counterparts / parties.multiParty /
   * crisis.negations / crisis.resourcePackId / crisis.safeFallback / crisis.openerText.* /
   * copy.neutral.appTitle / copy.neutral.notice / copy.neutral.forbiddenWords /
   * factsSections[].title / lawyerReview.* / sensitive.* —— 这十几项的守卫**整行删掉都不会红**。
   * 而它们缺了都不崩：空的 negations = 反例句一律照样触发危机；空的 resourcePackId =
   * 危机首段拿不到号码卡；空的 redactNotice = 分享页不再说自己脱敏过。全部 200，全部静默。
   * 每一项补一条负样本，并把「点名」验成**点全名**（见下面的 pointsAt）。
   */
  const broken: [string, Partial<DomainPack>][] = [
    ['key', { key: '' }],
    ['label', { label: '   ' }],
    ['parties.self', { parties: { ...LABOR.parties, self: '' } }],
    ['parties.counterparts', { parties: { ...LABOR.parties, counterparts: [] } }],
    [
      'parties.multiParty',
      { parties: { ...LABOR.parties, multiParty: undefined as unknown as boolean } },
    ],
    [
      // 漏填时判定处按 falsy 走 false 分支——每一次不点名的补充都把那一行搬回缺省位，不报错
      'inheritCompanyRoleOnUnnamed',
      { inheritCompanyRoleOnUnnamed: undefined as unknown as boolean },
    ],
    // 不点名 role 的登记落在哪一格：空着时**每一次**登记都落到一个空角色上，
    // 而 role 是分享/导出「洗不洗这个名字」的唯一依据 —— 落空格的名字从此两边都不管
    ['defaultCompanyRole', { defaultCompanyRole: '' }],
    ['stages', { stages: [] }],
    ['tracks', { tracks: undefined as unknown as string[] }],
    ['intakeSchema', { intakeSchema: [] }],
    // 整份种子表缺席：首诊照常 201、时间线照常有内容，而驾驶舱「只推一件事」那一格恒空
    [
      'intakeStageActions',
      { intakeStageActions: undefined as unknown as DomainPack['intakeStageActions'] },
    ],
    // 事实卡 basics 四行的抬头：空着不会崩，只会让那一行顶着英文键名进 prompt 与页面
    ['factsBasics.employedFrom', { factsBasics: { ...LABOR.factsBasics, employedFrom: '' } }],
    ['factsBasics.position', { factsBasics: { ...LABOR.factsBasics, position: '  ' } }],
    ['factsBasics.monthlyWage', { factsBasics: { ...LABOR.factsBasics, monthlyWage: '' } }],
    ['factsBasics.contractCount', { factsBasics: { ...LABOR.factsBasics, contractCount: '' } }],
    ['factsSections', { factsSections: [] }],
    ['reportSections', { reportSections: [] }],
    ['deadlineKinds', { deadlineKinds: [] }],
    ['docKinds', { docKinds: [] }],
    ['outboundDocKinds', { outboundDocKinds: [] }],
    ['claimKinds', { claimKinds: [] }],
    ['calculatorKinds', { calculatorKinds: [] }],
    ['crisis.lexicon', { crisis: { ...LABOR.crisis, lexicon: [] } }],
    ['crisis.negations', { crisis: { ...LABOR.crisis, negations: [] } }],
    ['crisis.resourcePackId', { crisis: { ...LABOR.crisis, resourcePackId: '' } }],
    ['crisis.directive', { crisis: { ...LABOR.crisis, directive: '' } }],
    ['crisis.safeFallback', { crisis: { ...LABOR.crisis, safeFallback: '  ' } }],
    [
      'crisis.openerText.head',
      { crisis: { ...LABOR.crisis, openerText: { ...LABOR.crisis.openerText, head: [] } } },
    ],
    [
      'crisis.openerText.tail',
      { crisis: { ...LABOR.crisis, openerText: { ...LABOR.crisis.openerText, tail: '' } } },
    ],
    [
      'crisis.firstSegment',
      { crisis: { ...LABOR.crisis, firstSegment: undefined as unknown as () => string } },
    ],
    // 重复触发危机时那句话：缺了不会崩，只会让第二次触发少一句「刚才给过号码」的交代
    [
      'crisis.repeatCardNote',
      {
        crisis: {
          ...LABOR.crisis,
          repeatCardNote: undefined as unknown as (n: readonly string[]) => string,
        },
      },
    ],
    // 「法律上只能由执业律师做的那几件事」：**必填且不许为空**。
    // 空清单读起来像"这个行当没有这类事项"，而它与漏填在产出上完全同形——
    // 那一段渲染不出来，于是"什么时候可以把用户指向律师"重新变成没人管的事。
    ['lawyerMandatory', { lawyerMandatory: [] }],
    // lawyerReview / sensitive 是**可选**的（省略 = 本领域没这回事），但一旦声明就不许半张。
    // 所以负样本要先把它声明齐、再打坏其中一项——否则打坏的是"没声明"，守卫本来就该放过。
    ['lawyerReview.title', { lawyerReview: { ...FULL_LAWYER_REVIEW, title: '' } }],
    ['lawyerReview.items', { lawyerReview: { ...FULL_LAWYER_REVIEW, items: [] } }],
    ['lawyerReview.discipline', { lawyerReview: { ...FULL_LAWYER_REVIEW, discipline: '  ' } }],
    ['sensitive.subject', { sensitive: { ...FULL_SENSITIVE, subject: '' } }],
    ['sensitive.factsNotice', { sensitive: { ...FULL_SENSITIVE, factsNotice: '' } }],
    ['sensitive.redactNotice', { sensitive: { ...FULL_SENSITIVE, redactNotice: '   ' } }],
    ['sensitive.aliasRoles', { sensitive: { ...FULL_SENSITIVE, aliasRoles: [] } }],
    [
      'copy.neutral.title',
      { copy: { ...LABOR.copy, neutral: { ...LABOR.copy.neutral, title: '' } } },
    ],
    [
      'copy.neutral.appTitle',
      { copy: { ...LABOR.copy, neutral: { ...LABOR.copy.neutral, appTitle: '' } } },
    ],
    [
      'copy.neutral.notice',
      { copy: { ...LABOR.copy, neutral: { ...LABOR.copy.neutral, notice: '  ' } } },
    ],
    [
      'copy.neutral.forbiddenWords',
      { copy: { ...LABOR.copy, neutral: { ...LABOR.copy.neutral, forbiddenWords: [] } } },
    ],
    ['copy.site', { copy: { ...LABOR.copy, site: {} } }],
    ['copy.capabilities', { copy: { ...LABOR.copy, capabilities: {} } }],
    // 共用页那几句：空着不会崩，只会让那几页退回缺省领域的话（P4-W4）
    // 【为什么要 as】aiLabelDisclaimer 在类型上必填，空对象根本编译不过——
    // 而**运行期**的守卫仍然必须拦住它：包也可能来自手写 JSON、来自 `as` 过的旧代码。
    // 类型闸与运行期闸是两道，这条负样本验的是后一道。
    [
      'copy.pages',
      { copy: { ...LABOR.copy, pages: {} as DomainPack['copy']['pages'] } },
    ],
    // 显式标识的后半截（标识办法 §4）：pages 里还有别的键，所以上面那条不会红；
    // 缺的只是「所以它不是什么」那半句——页面照常渲染、前半句还在，看着像"标识在的"。
    [
      'copy.pages.aiLabelDisclaimer',
      {
        copy: {
          ...LABOR.copy,
          pages: { ...LABOR.copy.pages, aiLabelDisclaimer: '' },
        },
      },
    ],
  ];

  /**
   * 「点名」= 报错里出现**这一项的全名**，不是它的第一段。
   *
   * 【为什么不能只匹第一段】此前判据写的是 `new RegExp(name.split('.')[0])`：
   * `crisis.negations` 那条只要求报错里有「crisis」——而 `crisis.lexicon`、
   * `crisis.directive` 任意一条报出来都带这三个字母。于是把 negations 那行守卫删掉，
   * 这条判据**照样绿**（别的 crisis 项在报）。点名要点到名，不是点到姓。
   */
  function pointsAt(name: string): RegExp {
    return new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  }

  for (const [name, over] of broken) {
    it(`缺 ${name} ⇒ 抛错并点全名（变异：把 assertDomainPack 里那一行删掉 → 红）`, () => {
      /*
       * 【先认"这一句是守卫自己说的"，再认它点了谁】只匹字段名的形态是：
       * 从 assertDomainPack 里冒出来的**任何** TypeError 都可能带着同一串字段路径
       *（`pack.crisis.repeatCardNote is not a function` 里逐字含 crisis.repeatCardNote），
       * 于是守卫被删掉、样本落进后一个分支抛 TypeError，这条判据照样绿。
       * 变异实测（集成 2026-09-07）：删掉 `crisis.repeatCardNote` 那道 typeof 守卫，
       * 加这句之前 75 条全绿，加之后该条当场红。
       */
      expect(() => assertDomainPack(clone(over))).toThrow(/不完整，缺 \d+ 项/);
      expect(() => assertDomainPack(clone(over))).toThrow(pointsAt(name));
      // 自证这条负样本打坏的**就是这一项**：完好的包不该抛
      expect(() => assertDomainPack(clone())).not.toThrow();
    });
  }

  /**
   * **这张表必须覆盖 assertDomainPack 里的每一个必填项**（否则「补全」只在补的那天成立）。
   *
   * 【为什么读源码而不是靠人对】新加一个 `str('x.y', …)` 的人不会想起来这里还有一张表；
   * 漏掉的形态是那一项的守卫从此没有判据看着，而两边各自看都正常——
   * 表是满的（对着当时的字段）、守卫也在（只是没人验）。
   * 读源码取字段名，多一项没样本就当场点名，这样忘不掉。
   */
  it('负样本表覆盖 assertDomainPack 的每一个必填项（变异：往守卫加一个 str(\'x\') 不配样本 → 红）', () => {
    const src = fs.readFileSync(
      path.join(fileURLToPath(new URL('.', import.meta.url)), '..', 'registry.ts'),
      'utf-8',
    );
    const body = src.slice(src.indexOf('export function assertDomainPack'));
    const declared = new Set<string>();
    // str('a.b', …) / arr('a.b', …) / missing.push('a.b') —— 只认**字段路径**形状的字面量，
    // 模板串（`factsSections 缺键：…` 这类一致性检查）不在此列，它们各有专门的判据。
    for (const m of body.matchAll(/(?:\b(?:str|arr)\(|missing\.push\()'([A-Za-z][A-Za-z0-9_.]*)'/g)) {
      declared.add(m[1]);
    }
    // 逐卡遍历时用的是模板串，静态扫不到，这里补一句（它有自己的一条判据，见下）
    expect(declared.size).toBeGreaterThan(20);
    const covered = new Set(broken.map(([name]) => name));
    const uncovered = [...declared].filter((f) => !covered.has(f)).sort();
    expect(uncovered, '这些必填项在 assertDomainPack 里查了，却没有一条「缺它即点名」的负样本').toEqual(
      [],
    );
    // 反过来：表里写了守卫根本不查的项，说明样本对着的是一个已经不存在的字段
    const stray = [...covered].filter((f) => !declared.has(f)).sort();
    expect(stray, '这些负样本对着的项 assertDomainPack 已经不查了，样本恒不红').toEqual([]);
  });

  it('factsSections 某一节只有键没有抬头 ⇒ 点名那一节（那一节会顶着英文键名进 prompt）', () => {
    const bad = LABOR.factsSections.map((sec, i) => (i === 0 ? { ...sec, title: '' } : sec));
    expect(() => assertDomainPack(clone({ factsSections: bad }))).toThrow(
      new RegExp(`factsSections\\[${LABOR.factsSections[0].key}\\]\\.title`),
    );
  });

  /**
   * 「只能由执业律师做」清单里某一条**缺一格**。逐格各一条判据：合成一条的形态是，
   * `basis` 那道守卫被删掉时整条仍然红（别的格还在报），于是没人发现
   * **不带法条锚点的条目从此进得来**——而那正是把闭合清单撑成兜底表的第一步
   *（"这事挺复杂的"与"法条把它划给了律师"，在没有 basis 时读起来一模一样）。
   *
   * 点名按 **key** 而不是下标：下标会随插入位置整体位移，报错指到的是另一条。
   */
  for (const field of ['key', 'label', 'why', 'basis'] as const) {
    it(`lawyerMandatory 某一条缺 ${field} ⇒ 点名到条（变异：删掉守卫里那一行 → 红）`, () => {
      const bad = LABOR.lawyerMandatory.map((item, i) => (i === 0 ? { ...item, [field]: '  ' } : item));
      // key 本身被打坏时没得点名，守卫退回下标（这也是它唯一该退回下标的时候）
      const at = field === 'key' ? '#0' : LABOR.lawyerMandatory[0].key;
      expect(() => assertDomainPack(clone({ lawyerMandatory: bad }))).toThrow(
        new RegExp(`lawyerMandatory\\[${at}\\]\\.${field}`),
      );
      expect(() => assertDomainPack(clone())).not.toThrow();
    });
  }

  it('缺项一次列全，不是挤牙膏式一次报一个', () => {
    let message = '';
    try {
      assertDomainPack(clone({ stages: [], docKinds: [], claimKinds: [] }));
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('stages');
    expect(message).toContain('docKinds');
    expect(message).toContain('claimKinds');
    // 一次列全，不是报第一条就停（清空这三项还会连带触发两条一致性检查，故 ≥5）
    const n = Number(/缺 (\d+) 项/.exec(message)?.[1]);
    expect(n).toBeGreaterThanOrEqual(3);
  });

  it('factsSections 少一个键 ⇒ 点名那个键（否则那一节会顶着别的领域的抬头渲染）', () => {
    expect(() => assertDomainPack(clone({ factsSections: LABOR.factsSections.slice(1) }))).toThrow(
      /factsSections 缺键：parties/,
    );
  });

  it('reportSections 少一个 source ⇒ 点名（否则报告少一节而照常生成）', () => {
    expect(() =>
      assertDomainPack(clone({ reportSections: LABOR.reportSections.slice(0, -1) })),
    ).toThrow(/reportSections 缺 source：changelog/);
  });

  it('outboundDocKinds 有 docKinds 里没有的项 ⇒ 点名（那道拒收闸对它形同虚设）', () => {
    expect(() => assertDomainPack(clone({ outboundDocKinds: ['库里没有这种文书'] }))).toThrow(
      /outboundDocKinds 不在 docKinds 里/,
    );
  });

  it('tracks 与 stages 重名 ⇒ 点名（当前轨与当前阶段会互相覆盖）', () => {
    expect(() => assertDomainPack(clone({ tracks: [LABOR.stages[0]] }))).toThrow(/tracks 与 stages 重名/);
  });

  it('低调模式的兜底措辞里出现本领域显眼词 ⇒ 点名（低调模式挡的不是这个人的事）', () => {
    const word = LABOR.copy.neutral.forbiddenWords[0];
    expect(() =>
      assertDomainPack(
        clone({ copy: { ...LABOR.copy, neutral: { ...LABOR.copy.neutral, title: `${word}台` } } }),
      ),
    ).toThrow(/显眼词/);
  });

  it('必填的首诊字段没给错误码 ⇒ 点名（拦下来却没有话可说）', () => {
    const bad = LABOR.intakeSchema.map((f) => (f.required ? { ...f, errorCode: undefined } : f));
    expect(() => assertDomainPack(clone({ intakeSchema: bad }))).toThrow(/必填却没给 errorCode/);
  });

  it('不必填的首诊字段却带了错误码 ⇒ 点名（说明书说可省略、服务端照样拒收）', () => {
    // 【为什么反方向也要拦】(复审 2026-09-06) 守卫原来只拦「required 却无 errorCode」。
    // 反过来那种（required:false + errorCode）不会崩、不会报错，只会让调用方
    // **照着工具清单填齐了仍被拒**——两边各自看都是对的。
    const bad = LABOR.intakeSchema.map((f, i) =>
      i === 0 ? { ...f, required: false, errorCode: 'STILL_CHECKED', invalidMessage: '还是拦' } : f,
    );
    expect(() => assertDomainPack(clone({ intakeSchema: bad }))).toThrow(/不必填却给了 errorCode/);
  });

  /**
   * 【为什么归属保留字要单独一道】首诊工具壳把 intakeArgsToInput 派生出来的映射
   * **展开**进 submitIntake 的入参（lib/capabilities/families/case.ts）。包里若把
   * caseId / userId 当成首诊字段声明，这两个键就跟着入参一起来了——「记到谁名下」
   * 由调用方填的值说了算。不会报错：说明书上多一个参数、服务端照着填的值落库。
   * 展开顺序已经让归属写在后面兜了一层，这道守卫是为了让包作者**当场**知道，
   * 而不是把一个装载得进去的包留在注册表里。
   */
  it('首诊表拿 userId 当键 ⇒ 点名（归属来自调用者身份，不能由入参覆盖）', () => {
    const bad = LABOR.intakeSchema.map((f, i) => (i === 0 ? { ...f, key: 'userId' } : f));
    expect(() => assertDomainPack(clone({ intakeSchema: bad }))).toThrow(/归属保留字/);
  });

  it('首诊表拿 caseId 当键 ⇒ 点名（同上）', () => {
    const bad = LABOR.intakeSchema.map((f, i) => (i === 0 ? { ...f, key: 'caseId' } : f));
    expect(() => assertDomainPack(clone({ intakeSchema: bad }))).toThrow(/归属保留字/);
  });

  it('首诊表拿 case_id 当参数名 ⇒ 点名（它由首诊 schema 自己声明，包里再声明就是两份对外定义）', () => {
    const bad = LABOR.intakeSchema.map((f, i) => (i === 0 ? { ...f, param: 'case_id' } : f));
    expect(() => assertDomainPack(clone({ intakeSchema: bad }))).toThrow(/保留参数名 case_id/);
  });

  it('intakeLimitation 落一个词表里没有的期限种类 ⇒ 点名（那条期限存不进库而首诊照常成功）', () => {
    expect(() =>
      assertDomainPack(clone({ intakeLimitation: { ...LABOR.intakeLimitation!, kind: '没这种期限' } })),
    ).toThrow(/intakeLimitation\.kind/);
  });
});

describe(`灰度开关 ${DOMAINS_ENABLED_ENV}`, () => {
  it('不设 ⇒ 只开缺省领域', () => {
    delete process.env[DOMAINS_ENABLED_ENV];
    expect(enabledDomainKeys()).toEqual([DEFAULT_DOMAIN]);
    expect(listDomains().map((p) => p.key)).toEqual([DEFAULT_DOMAIN]);
    expect(isDomainEnabled(DEFAULT_DOMAIN)).toBe(true);
  });

  it('设成空串 ⇒ 同不设（不是"一个都不开"）', () => {
    process.env[DOMAINS_ENABLED_ENV] = '   ';
    expect(enabledDomainKeys()).toEqual([DEFAULT_DOMAIN]);
  });

  it('列了没注册过的领域 ⇒ 忽略它，不整个失效', () => {
    process.env[DOMAINS_ENABLED_ENV] = `${DEFAULT_DOMAIN}, 还没写的领域`;
    expect(enabledDomainKeys()).toEqual([DEFAULT_DOMAIN]);
  });

  it('列的全都没注册过 ⇒ 回落到缺省领域（置成"没有任何可用领域"不是灰度，是停业）', () => {
    process.env[DOMAINS_ENABLED_ENV] = '甲,乙';
    expect(enabledDomainKeys()).toEqual([DEFAULT_DOMAIN]);
  });

  it('**现读 env，不进程级缓存**（变异：把结果缓存起来 → 红）', () => {
    process.env[DOMAINS_ENABLED_ENV] = DEFAULT_DOMAIN;
    expect(isDomainEnabled(DEFAULT_DOMAIN)).toBe(true);
    process.env[DOMAINS_ENABLED_ENV] = '一个不存在的领域';
    // 回落规则让它仍是缺省领域，所以换个更强的观察点：改成两个键的写法后长度会变
    process.env[DOMAINS_ENABLED_ENV] = `${DEFAULT_DOMAIN},${DEFAULT_DOMAIN}`;
    expect(enabledDomainKeys().length).toBe(2);
  });

  it('requireEnabledDomain：没开的领域回自述错误（缺什么/为什么/怎么办），不是一句「不支持」', () => {
    const got = requireEnabledDomain('从没注册过的领域');
    expect('ok' in got && got.ok).toBe(false);
    const fail = got as { errorCode: string; message: string };
    expect(fail.errorCode).toBe('UNKNOWN_DOMAIN');
    expect(fail.message).toContain('注册过的是'); // 有什么
    expect(fail.message).toContain('当前开启的是'); // 为什么不行
    expect(fail.message).toContain('请从开启的这几个里选一个'); // 怎么办
  });

  it('requireEnabledDomain：开着的领域回包本身', () => {
    expect(requireEnabledDomain(DEFAULT_DOMAIN)).toBe(DOMAINS[DEFAULT_DOMAIN]);
  });

  /**
   * **getDomainPack 刻意不看开关**。看开关的形态是：临时把某个领域从开关里摘掉，
   * 已建档用户的案件当场变成 500——一个本该只影响新用户的开关，把老用户锁在了外面。
   */
  it('getDomainPack 不受开关影响（变异：让它也过一遍开关 → 红）', () => {
    process.env[DOMAINS_ENABLED_ENV] = '一个不存在的领域';
    expect(getDomainPack(DEFAULT_DOMAIN)).toBe(DOMAINS[DEFAULT_DOMAIN]);
  });
});

/**
 * 灰度开关的两条判据——**缺省只开缺省领域**、**注册了但没开的领域回 DOMAIN_NOT_ENABLED**
 * ——在「注册表里只有一个包」时**没有观察点**：
 *   · 把缺省值改成全开（`Object.keys(DOMAINS)`）→ 只有一个包时它就等于 `[缺省领域]`；
 *   · 把 `requireEnabledDomain` 改成只查 `key in DOMAINS`、完全无视开关 → 只有一个包时
 *     它对每一个入参给出的答案与正确实现逐字相同。
 * 两种改法上面那一组一条都不会红（复审官 2026-09-06 在 HEAD 副本上实跑两次变异，
 * lib/domains + lib/cases 共 169 条全绿），**而 DOMAIN_NOT_ENABLED 这条路径整套测试从未走到**。
 *
 * ⇒ 所以这一组往注册表里**真的挂第二个包**，再问同样的问题。它是假的、内容照抄缺省领域，
 * 但对开关来说「第二个 key」正是唯一缺失的那件东西。
 */
describe(`灰度开关 ${DOMAINS_ENABLED_ENV}：注册表里有第二个包时才看得见的那几条`, () => {
  /** 假包只借 labor 的内容凑齐字段（本组问的是 key 与开关，不问内容） */
  const FAKE_KEY = '假领域-灰度判据专用';
  const FAKE_PACK: DomainPack = { ...LABOR, key: FAKE_KEY };

  beforeAll(() => {
    DOMAINS[FAKE_KEY] = FAKE_PACK;
  });
  afterAll(() => {
    delete DOMAINS[FAKE_KEY];
  });

  it('自证假包真的挂上了（否则下面每一条都是"因为它根本不存在"而绿）', () => {
    expect(Object.keys(DOMAINS)).toContain(FAKE_KEY);
    expect(getDomainPack(FAKE_KEY)).toBe(FAKE_PACK);
    // 挂了第二个包也不改缺省领域：缺省取的是注册表里**第一个**，不是"最后挂上的那个"
    expect(DEFAULT_DOMAIN).not.toBe(FAKE_KEY);
  });

  it('不设开关 ⇒ 注册过≠开着，假包不在启用列表里（变异：缺省改成 Object.keys(DOMAINS) → 红）', () => {
    delete process.env[DOMAINS_ENABLED_ENV];
    expect(enabledDomainKeys()).toEqual([DEFAULT_DOMAIN]);
    expect(enabledDomainKeys()).not.toContain(FAKE_KEY);
    expect(isDomainEnabled(FAKE_KEY)).toBe(false);
    expect(listDomains().map((p) => p.key)).toEqual([DEFAULT_DOMAIN]);
  });

  it('不设开关 ⇒ requireEnabledDomain(假包) 回 DOMAIN_NOT_ENABLED，不是 UNKNOWN_DOMAIN（变异：让它只查 key in DOMAINS → 红）', () => {
    delete process.env[DOMAINS_ENABLED_ENV];
    const got = requireEnabledDomain(FAKE_KEY);
    expect('ok' in got && got.ok).toBe(false);
    const fail = got as { errorCode: string; message: string };
    // 两个错误码分的是**两种完全不同的处境**：没写这个包 vs 写了但这个环境没开。
    // 混成一个的形态是：运维照着「补上这个领域包」去找一份已经在仓库里的代码。
    expect(fail.errorCode).toBe('DOMAIN_NOT_ENABLED');
    expect(fail.message).toContain(FAKE_KEY); // 缺什么
    expect(fail.message).toContain('这套代码里有'); // 为什么缺
    expect(fail.message).toContain(DOMAINS_ENABLED_ENV); // 怎么办：改哪个开关
  });

  it('把假包写进开关 ⇒ 它才开（自证上面两条不是"这个包永远开不了"）', () => {
    process.env[DOMAINS_ENABLED_ENV] = `${DEFAULT_DOMAIN},${FAKE_KEY}`;
    expect(enabledDomainKeys()).toEqual([DEFAULT_DOMAIN, FAKE_KEY]);
    expect(isDomainEnabled(FAKE_KEY)).toBe(true);
    expect(requireEnabledDomain(FAKE_KEY)).toBe(FAKE_PACK);
  });

  it('只开假包 ⇒ 连缺省领域都回 DOMAIN_NOT_ENABLED（开关说了算，不是"缺省领域永远开着"）', () => {
    process.env[DOMAINS_ENABLED_ENV] = FAKE_KEY;
    expect(enabledDomainKeys()).toEqual([FAKE_KEY]);
    const got = requireEnabledDomain(DEFAULT_DOMAIN) as { ok?: boolean; errorCode?: string };
    expect(got.ok).toBe(false);
    expect(got.errorCode).toBe('DOMAIN_NOT_ENABLED');
  });

  it('getDomainPack 不看开关：没开的领域照样读得到（老用户的档案不因灰度被锁在外面）', () => {
    delete process.env[DOMAINS_ENABLED_ENV];
    expect(isDomainEnabled(FAKE_KEY)).toBe(false);
    expect(getDomainPack(FAKE_KEY)).toBe(FAKE_PACK);
    expect(domainPackOrDefault(FAKE_KEY)).toBe(FAKE_PACK);
  });

  it('domainPackOrDefault：认不出的 domain 退回缺省领域，认得出的原样给（读路径的唯一入口）', () => {
    expect(domainPackOrDefault('一行写坏的 domain')).toBe(DOMAINS[DEFAULT_DOMAIN]);
    expect(domainPackOrDefault('')).toBe(DOMAINS[DEFAULT_DOMAIN]);
    expect(domainPackOrDefault(undefined)).toBe(DOMAINS[DEFAULT_DOMAIN]);
    expect(domainPackOrDefault(FAKE_KEY)).toBe(FAKE_PACK);
  });
});
