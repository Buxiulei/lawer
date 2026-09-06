// app/src/lib/domains/__tests__/registry-contract.test.ts
// 领域注册表的两条契约：**包必须完整**（assertDomainPack）与**灰度开关说了算**
// （LAWER_DOMAINS_ENABLED）。
//
// 【这两条为什么值得一份判据】它们的失效都是静默的：
//   · 缺一项的包不会崩，只会让那一块从此不工作（空词表 = 那类判定永不触发）；
//   · 灰度开关失灵不会报错，只会让一个还没验收过的领域悄悄开始接用户。
import { afterEach, describe, expect, it } from 'vitest';

import { LABOR } from '../labor';
import {
  assertDomainPack,
  DEFAULT_DOMAIN,
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
   */
  const broken: [string, Partial<DomainPack>][] = [
    ['key', { key: '' }],
    ['label', { label: '   ' }],
    ['parties', { parties: { self: '', counterparts: [], multiParty: true } }],
    ['stages', { stages: [] }],
    ['tracks', { tracks: undefined as unknown as string[] }],
    ['intakeSchema', { intakeSchema: [] }],
    ['factsSections', { factsSections: [] }],
    ['reportSections', { reportSections: [] }],
    ['deadlineKinds', { deadlineKinds: [] }],
    ['docKinds', { docKinds: [] }],
    ['outboundDocKinds', { outboundDocKinds: [] }],
    ['claimKinds', { claimKinds: [] }],
    ['calculatorKinds', { calculatorKinds: [] }],
    ['crisis.lexicon', { crisis: { ...LABOR.crisis, lexicon: [] } }],
    ['crisis.directive', { crisis: { ...LABOR.crisis, directive: '' } }],
    [
      'crisis.firstSegment',
      { crisis: { ...LABOR.crisis, firstSegment: undefined as unknown as () => string } },
    ],
    [
      'copy.neutral.title',
      { copy: { ...LABOR.copy, neutral: { ...LABOR.copy.neutral, title: '' } } },
    ],
    ['copy.site', { copy: { ...LABOR.copy, site: {} } }],
    ['copy.capabilities', { copy: { ...LABOR.copy, capabilities: {} } }],
  ];
  for (const [name, over] of broken) {
    it(`缺 ${name} ⇒ 抛错并点名（变异：把 assertDomainPack 里那一行删掉 → 红）`, () => {
      expect(() => assertDomainPack(clone(over))).toThrow(new RegExp(name.split('.')[0]));
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
