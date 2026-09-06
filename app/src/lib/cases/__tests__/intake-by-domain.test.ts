// app/src/lib/cases/__tests__/intake-by-domain.test.ts
// 首诊校验**换包就换表**（设计稿 §13「首诊」行）。
//
// 【证法与危机那条同理】造一个与缺省领域完全不同的假首诊表，看校验器是否照它走。
// 只测缺省领域的形态是：校验器里就算写死了缺省领域的五项必填，测试照样全绿。
import { describe, expect, it } from 'vitest';

import { intakeInputSchema } from '@/lib/capabilities/shared';
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
