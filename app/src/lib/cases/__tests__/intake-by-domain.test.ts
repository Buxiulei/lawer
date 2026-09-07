// app/src/lib/cases/__tests__/intake-by-domain.test.ts
// 首诊校验**换包就换表**（设计稿 §13「首诊」行）。
//
// 【证法与危机那条同理】造一个与缺省领域完全不同的假首诊表，看校验器是否照它走。
// 只测缺省领域的形态是：校验器里就算写死了缺省领域的五项必填，测试照样全绿。
import { describe, expect, it } from 'vitest';

import { intakeArgsToInput, intakeInputSchema } from '@/lib/capabilities/shared';
import { validateIntake } from '@/lib/cases/intake';
import { DEFAULT_DOMAIN, DOMAINS, type DomainPack, type IntakeFieldSpec } from '@/lib/domains/registry';

const DEFAULT_PACK = DOMAINS[DEFAULT_DOMAIN];

/** 只有两项必填、且问法与缺省领域毫无重合的假首诊表 */
const FAKE_SCHEMA: IntakeFieldSpec[] = [
  {
    key: 'companyName', // 键名是跨领域不变的对外契约，换的是问法与那句话
    param: 'company_name',
    kind: 'text',
    required: true,
    description: '对方的名字',
    errorCode: 'INVALID_COUNTERPART',
    invalidMessage: '对方的名字不能空着',
  },
  {
    key: 'stage',
    param: 'stage',
    kind: 'enum',
    required: true,
    values: ['甲阶段', '乙阶段'],
    description: '走到哪一步了',
    errorCode: 'INVALID_STAGE',
    invalidMessage: '只能是 {values}',
  },
  { key: 'goals', param: 'goals', kind: 'stringList', required: false, description: '不填也行' },
];

const FAKE: DomainPack = { ...DEFAULT_PACK, intakeSchema: FAKE_SCHEMA };

const TODAY = '2026-09-06';

describe('首诊校验按领域包的 intakeSchema 走', () => {
  it('假包只验它列出来的两项：缺省领域的必填项在它这里不再必填（变异：把必填清单写死 → 红）', () => {
    const got = validateIntake(
      { companyName: '对面那家', stage: '甲阶段' } as never,
      TODAY,
      FAKE,
    );
    expect(got.ok).toBe(true);
    // 缺省领域会因为缺 employed_from / 月工资 / 诉求而拒收同一份入参
    expect(validateIntake({ companyName: '对面那家', stage: '甲阶段' } as never, TODAY, DEFAULT_PACK).ok)
      .toBe(false);
  });

  it('错误码与那句话逐字来自包（变异：把 message 写死在校验器里 → 红）', () => {
    const got = validateIntake({ companyName: '  ', stage: '甲阶段' } as never, TODAY, FAKE);
    expect(got.ok).toBe(false);
    if (got.ok) return;
    expect(got.errorCode).toBe('INVALID_COUNTERPART');
    expect(got.message).toBe('对方的名字不能空着');
  });

  it('enum 的取值集合与 {values} 占位符都来自包', () => {
    const got = validateIntake({ companyName: '对面那家', stage: '丙阶段' } as never, TODAY, FAKE);
    expect(got.ok).toBe(false);
    if (got.ok) return;
    expect(got.message).toBe('只能是 甲阶段 / 乙阶段');
  });

  it('顺序即包里的顺序：同时错两项时，先报排在前面的那一项', () => {
    const got = validateIntake({ companyName: '', stage: '丙阶段' } as never, TODAY, FAKE);
    expect(got.ok).toBe(false);
    if (got.ok) return;
    expect(got.errorCode).toBe('INVALID_COUNTERPART'); // 它在假表里排第一
  });

  it('工具入参 schema 与校验读的是同一份表（变异：手写第二份 inputSchema → 红）', () => {
    const schema = intakeInputSchema(FAKE) as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(Object.keys(schema.properties)).toEqual(['case_id', 'company_name', 'stage', 'goals']);
    expect(schema.required).toEqual(['case_id', 'company_name', 'stage']);
    expect(schema.properties.stage).toEqual({
      type: 'string',
      enum: ['甲阶段', '乙阶段'],
      description: '走到哪一步了',
    });
  });
});


/**
 * 说明书（intakeInputSchema）解决的是「对外宣告哪些参数」；**壳里那份 param→key 对照表**
 * 是同一份定义的第二个读者。两份都从 intakeSchema 派生，才没有「宣告了却被壳丢掉」的缝。
 */
describe('首诊入参映射也按领域包的 intakeSchema 走（intakeArgsToInput）', () => {
  it('键名照包给的 key，不照参数名（变异：把某一项写死成 args.company_name → 红）', () => {
    const got = intakeArgsToInput(FAKE, { company_name: '对面那家', stage: '甲阶段' });
    // 假包只列了三项，映射出来的就只有这三个键——多一个都说明有人手写了第二份
    expect(Object.keys(got)).toEqual(['companyName', 'stage', 'goals']);
    expect(got.companyName).toBe('对面那家');
    expect(got.stage).toBe('甲阶段');
    expect(got.goals).toBeUndefined();
  });

  it('param 与 key 不同名时按包里的 param 取值（变异：用 key 当参数名取 → 红）', () => {
    const renamed: DomainPack = {
      ...FAKE,
      intakeSchema: [{ ...FAKE_SCHEMA[0], param: '对方名字' }, FAKE_SCHEMA[1], FAKE_SCHEMA[2]],
    };
    const got = intakeArgsToInput(renamed, { 对方名字: '换了个问法', company_name: '旧参数名' });
    expect(got.companyName).toBe('换了个问法');
  });

  it('kind==="money" 的字段对外收元、映射成分（变异：删掉元→分那一支 → 红）', () => {
    const money: DomainPack = {
      ...FAKE,
      intakeSchema: [
        { key: 'monthlyWageFen', param: 'monthly_wage_yuan', kind: 'money', required: false, description: '钱' },
      ],
    };
    expect(intakeArgsToInput(money, { monthly_wage_yuan: 30000 }).monthlyWageFen).toBe(3_000_000);
    // 没填 / 填了个不是数的东西一律 NaN，交给领域层报字段级错，不在壳里兜底成某个数
    expect(Number.isNaN(intakeArgsToInput(money, {}).monthlyWageFen as number)).toBe(true);
  });

  it('kind==="record" 没填时补 {}，不是 undefined（落库那一步直接取键）', () => {
    const rec: DomainPack = {
      ...FAKE,
      intakeSchema: [
        {
          key: 'companyDocs',
          param: 'company_docs',
          kind: 'record',
          required: false,
          description: '给过哪些文件',
          fields: [{ key: 'a', label: 'A' }],
        },
      ],
    };
    expect(intakeArgsToInput(rec, {}).companyDocs).toEqual({});
    expect(intakeArgsToInput(rec, { company_docs: { a: '有' } }).companyDocs).toEqual({ a: '有' });
  });

  it('说明书宣告的每个参数，映射都认识（变异：把映射改回手写对照表并漏掉其中一项 → 红）', () => {
    const schema = intakeInputSchema(DEFAULT_PACK) as { properties: Record<string, unknown> };
    // case_id 来自调用者身份、不在首诊表里；除它以外，宣告出去的参数就是首诊表的 param 集
    const declared = Object.keys(schema.properties).filter((p) => p !== 'case_id');
    expect(declared).toEqual(DEFAULT_PACK.intakeSchema.map((f) => f.param));

    const args = Object.fromEntries(declared.map((p) => [p, `填了-${p}`]));
    const mapped = intakeArgsToInput(DEFAULT_PACK, args);
    // 一个宣告出去的参数被壳丢掉 = mapped 里少一个键。这条就是那个观察点。
    expect(Object.keys(mapped)).toEqual(DEFAULT_PACK.intakeSchema.map((f) => f.key));
    for (const f of DEFAULT_PACK.intakeSchema) {
      if (f.kind === 'money') continue; // 元→分换算过，值不再是原样
      expect(mapped[f.key], f.param).toBe(`填了-${f.param}`);
    }
  });
});
