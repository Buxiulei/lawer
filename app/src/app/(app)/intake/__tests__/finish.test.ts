// app/src/app/(app)/intake/__tests__/finish.test.ts
// 首诊末步：**「存好了」这句话只能出现在真的存好了的那一支。**
//
// 旧代码三件事同时错：没发任何请求、跳 /case/demo、还弹「档案已建好」。
// 三个错各自都能单独复发（有人改回 demo、有人把 toast 提到 try 外面），
// 所以三条都各有一句断言，且每条都能被对应的变异打红。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { destinationForFinish, toIntakePayload, wageFenOf } from '../_components/submit';
import { advanceBlock } from '../_components/validate';
import { EMPTY_DRAFT, type IntakeDraft } from '../_components/draft';

const COMPONENTS = join(process.cwd(), 'src/app/(app)/intake/_components');
const read = (f: string) => readFileSync(join(COMPONENTS, f), 'utf8');

describe('末步四种结局', () => {
  it('存好了 → 去**自己的**案件，地址里不含 demo，并且允许清草稿', () => {
    const dest = destinationForFinish({ kind: 'saved', caseId: 7 });
    expect(dest.href).toBe('/case/7');
    expect(dest.href).not.toContain('demo');
    expect(dest.notice.tone).toBe('success');
    expect(dest.clearDraft).toBe(true);
  });

  it('没存下 → 留在原地、**不弹成功提示**、**不清草稿**', () => {
    const dest = destinationForFinish({ kind: 'failed', message: '网络没连上，检查一下再试。' });
    expect(dest.href).toBeNull();
    expect(dest.notice.tone).not.toBe('success');
    expect(dest.notice.message).not.toContain('已建好');
    expect(dest.notice.message).not.toContain('存进你的档案');
    // 自述三段式：出了什么事 / 东西还在不在 / 接下来怎么办
    expect(dest.notice.message).toContain('网络没连上');
    expect(dest.notice.message).toContain('还在这台设备上');
    expect(dest.clearDraft).toBe(false);
  });

  it('名下没有案件 → 也不许说存好了，更不许送去演示案件', () => {
    const dest = destinationForFinish({ kind: 'no-case' });
    expect(dest.href).toBeNull();
    expect(dest.notice.tone).not.toBe('success');
    expect(dest.clearDraft).toBe(false);
  });

  it('未登录 → 去登录页，草稿留着', () => {
    const dest = destinationForFinish({ kind: 'signed-out' });
    expect(dest.href).toBe('/login');
    expect(dest.clearDraft).toBe(false);
  });

  it('四种结局里没有任何一种通向 demo', () => {
    const all = [
      destinationForFinish({ kind: 'saved', caseId: 3 }),
      destinationForFinish({ kind: 'failed', message: 'x' }),
      destinationForFinish({ kind: 'no-case' }),
      destinationForFinish({ kind: 'signed-out' }),
    ];
    for (const d of all) expect(d.href ?? '').not.toContain('demo');
  });
});

/**
 * 结构守卫：**这条是「必须能红」的那条。**
 * 有人把 `router.push('/case/demo')` 写回首诊页（哪怕只是"先跑起来"），这里立刻红。
 */
describe('首诊页不许再把人送进演示案件', () => {
  it('正对照：文件读得到且确实有 router.push', () => {
    expect(read('IntakeFlow.tsx')).toContain('router.push');
  });

  it('IntakeFlow.tsx 里没有 demo 字样', () => {
    expect(read('IntakeFlow.tsx')).not.toContain('demo');
  });

  it('去处只由 destinationForFinish 决定，页面不自己拼案件地址', () => {
    const src = read('IntakeFlow.tsx');
    expect(src).toContain('destinationForFinish');
    // 唯一的 push 参数是那份去处，不是任何字面量路径
    expect(src).toContain('router.push(dest.href)');
    expect(src).not.toMatch(/router\.push\(['"`]\/case\//);
  });
});

describe('草稿 → 请求体', () => {
  const draft: IntakeDraft = {
    ...EMPTY_DRAFT,
    stage: '已收通知',
    hiredOn: '2021-04-12',
    monthlyWage: '22000',
    companyName: '华衡永泰',
    goals: ['违法解除赔偿金（2N）'],
  };

  it('月工资按分传，且不是把元当分', () => {
    expect(wageFenOf('22000')).toBe(2_200_000);
    expect(wageFenOf('22000.5')).toBe(2_200_050);
    expect(wageFenOf('')).toBeNull();
    expect(wageFenOf('两万')).toBeNull();
    expect(wageFenOf('0')).toBeNull();
  });

  it('六步的字段一个都不落下', () => {
    const body = toIntakePayload(draft);
    expect(body).toMatchObject({
      stage: '已收通知',
      company_name: '华衡永泰',
      employed_from: '2021-04-12',
      monthly_wage_fen: 2_200_000,
      goals: ['违法解除赔偿金（2N）'],
    });
    for (const k of ['events', 'free_text', 'company_docs', 'company_wording', 'bottom_line', 'position', 'contract_count']) {
      expect(Object.keys(body)).toContain(k);
    }
  });
});

/* ── 逐步校验：三态各验一次，去掉任一条都会红 ─────────────────── */

describe('逐步校验', () => {
  const TODAY = '2026-09-02';
  const base: IntakeDraft = { ...EMPTY_DRAFT, stage: '已收通知' };

  it('第 1 步：没选阶段过不去，选了就能走', () => {
    expect(advanceBlock(0, EMPTY_DRAFT, TODAY)).toContain('阶段');
    expect(advanceBlock(0, base, TODAY)).toBeNull();
  });

  it('第 2 步：入职日期 / 月工资 / 公司名各自有各自的提示，不是一句通用话', () => {
    const blank = advanceBlock(1, base, TODAY);
    expect(blank).toContain('入职时间');

    const noWage = advanceBlock(1, { ...base, hiredOn: '2021-04-12' }, TODAY);
    expect(noWage).toContain('月工资');

    const noCompany = advanceBlock(1, { ...base, hiredOn: '2021-04-12', monthlyWage: '22000' }, TODAY);
    expect(noCompany).toContain('公司名称');

    const filled = advanceBlock(
      1,
      { ...base, hiredOn: '2021-04-12', monthlyWage: '22000', companyName: '华衡永泰' },
      TODAY,
    );
    expect(filled).toBeNull();
  });

  it('第 2 步：日期与金额的格式都要挡（参与算钱的两格）', () => {
    const withRest = { ...base, monthlyWage: '22000', companyName: '华衡永泰' };
    expect(advanceBlock(1, { ...withRest, hiredOn: '2026-02-31' }, TODAY)).toContain('不存在');
    expect(advanceBlock(1, { ...withRest, hiredOn: '2027-01-01' }, TODAY)).toContain('晚于今天');
    expect(
      advanceBlock(1, { ...base, hiredOn: '2021-04-12', monthlyWage: '两万五', companyName: '华衡永泰' }, TODAY),
    ).toContain('只填数字');
  });

  it('第 5 步：一项诉求都没选过不去', () => {
    expect(advanceBlock(4, base, TODAY)).toContain('至少选一项');
    expect(advanceBlock(4, { ...base, goals: ['拖欠的工资'] }, TODAY)).toBeNull();
  });

  it('不参与算钱的第 3、4 步不拦：记不清也该让人往下走', () => {
    expect(advanceBlock(2, base, TODAY)).toBeNull();
    expect(advanceBlock(3, base, TODAY)).toBeNull();
  });
});
