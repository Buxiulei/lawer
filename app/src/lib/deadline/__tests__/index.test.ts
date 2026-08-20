// app/src/lib/deadline/__tests__/index.test.ts
// 法定期限推算。这些用例守的是「错过即权利灭失」的那条线——
// 算错一天不是精度问题，是用户的案子没了。
import { describe, expect, it } from 'vitest';

import { computeDeadline, DEADLINE_RULES, HOLIDAY_CAVEAT } from '../index';

describe('起算规则：当日起算 vs 次日起算（差的这一天就是生死线本身）', () => {
  it('起诉15日：从签收**次日**起算（北京《解答（一）》第 12 条）', () => {
    // 8/19 签收 → 次日 8/20 是第 1 日 → 第 15 日是 9/3
    expect(computeDeadline('起诉15日', '2026-08-19').dueDate).toBe('2026-09-03');
  });

  it('上诉15日：从送达次日起算，与起诉期同口径', () => {
    expect(computeDeadline('上诉15日', '2026-08-19').dueDate).toBe('2026-09-03');
  });

  it('答辩期15日：收到起诉状副本次日起算', () => {
    expect(computeDeadline('答辩期15日', '2026-08-19').dueDate).toBe('2026-09-03');
  });

  it('仲裁时效：年期间取锚点的周年对应日', () => {
    // 2026-08-19 解除 → 2027-08-19（周四，无需顺延）
    expect(computeDeadline('仲裁时效', '2026-08-19').dueDate).toBe('2027-08-19');
  });

  it('两种起算方式确实差一天（同锚点、同 15 日跨度对照）', () => {
    const nextDay = computeDeadline('起诉15日', '2026-08-19').dueDate;
    const sameDay = computeDeadline('举证期限', '2026-08-19', { days: 15 }).dueDate;
    expect(nextDay).toBe('2026-09-03');
    expect(sameDay).toBe('2026-09-02');
  });
});

describe('跨年与大小月边界', () => {
  it('15 日跨年（末日 2027-01-09 是周六 → 顺延至周一）', () => {
    expect(computeDeadline('起诉15日', '2026-12-25').dueDate).toBe('2027-01-11');
  });

  it('15 日跨 31 天月与 30 天月', () => {
    expect(computeDeadline('起诉15日', '2026-01-25').dueDate).toBe('2026-02-09');
    // 2026-05-10 是周日 → 顺延至 05-11
    expect(computeDeadline('起诉15日', '2026-04-25').dueDate).toBe('2026-05-11');
  });

  it('平年 2 月：2/20 + 15 日落在 3/7（周六）→ 顺延至 3/9', () => {
    expect(computeDeadline('起诉15日', '2026-02-20').dueDate).toBe('2026-03-09');
  });

  it('闰年 2 月多一天，结果相应后移', () => {
    expect(computeDeadline('起诉15日', '2028-02-20').dueDate).toBe('2028-03-06');
  });

  it('仲裁时效跨闰日：2024-02-29 起算，一年后平年无 29 日 → 收敛到 02-28，绝不滑到 3 月', () => {
    expect(computeDeadline('仲裁时效', '2024-02-29').dueDate).toBe('2025-02-28');
  });

  it('申请执行 2 年跨闰年', () => {
    expect(computeDeadline('申请执行2年', '2026-03-01').dueDate).toBe('2028-03-01');
  });

  it('年末最后一天起算', () => {
    expect(computeDeadline('仲裁时效', '2026-12-31').dueDate).toBe('2027-12-31');
    expect(computeDeadline('起诉15日', '2026-12-31').dueDate).toBe('2027-01-15');
  });
});

describe('末日顺延：周末确定性编码，法定节假日如实标注为未含', () => {
  it('末日落在周六 → 顺延至周一（+2 天）', () => {
    // 2026-08-17 + 15（次日起算）= 2026-09-01 周二，不顺延；换个落周六的锚点
    const sat = computeDeadline('起诉15日', '2026-02-20'); // 原 3/7 周六
    expect(sat.dueDate).toBe('2026-03-09');
    expect(sat.derivedFrom).toContain('周六');
    expect(sat.derivedFrom).toContain('顺延');
  });

  it('末日落在周日 → 顺延至周一（+1 天）', () => {
    const sun = computeDeadline('起诉15日', '2026-04-25'); // 原 5/10 周日
    expect(sun.dueDate).toBe('2026-05-11');
    expect(sun.derivedFrom).toContain('周日');
  });

  it('末日是工作日则原样，不画蛇添足', () => {
    const r = computeDeadline('起诉15日', '2026-08-19');
    expect(r.dueDate).toBe('2026-09-03');
    expect(r.derivedFrom).not.toContain('顺延至下一工作日');
  });

  it('顺延后的日期一定不是周末', () => {
    for (let d = 1; d <= 28; d++) {
      const anchor = `2026-06-${String(d).padStart(2, '0')}`;
      const due = new Date(computeDeadline('起诉15日', anchor).dueDate + 'T00:00:00Z');
      expect([0, 6]).not.toContain(due.getUTCDay());
    }
  });

  it('caveat 明说「已按周末顺延、未含法定节假日」，并要求人工核对', () => {
    const c = computeDeadline('起诉15日', '2026-08-19').caveats.join();
    expect(c).toContain('已按周末顺延');
    expect(c).toContain('未含法定节假日顺延');
    expect(c).toContain('人工核对');
  });
});

describe('期间计算通则（依据 WS4 补的通则卡，逐字）', () => {
  it('推算依据带民诉法 §85 逐字原文与办案规则 §19 桥接', () => {
    const r = computeDeadline('起诉15日', '2026-08-19');
    expect(r.derivedFrom).toContain('期间开始的时和日，不计算在期间内');
    expect(r.derivedFrom).toContain('第八十五条');
    expect(r.derivedFrom).toContain('第十九条');
  });

  it('如实带上依据卡的「待核实」可信度（charter §3）', () => {
    expect(computeDeadline('起诉15日', '2026-08-19').derivedFrom).toContain('待核实');
  });

  it('每次推算都给「交邮不算过期」的兜底提醒——用户自己跑流程，最后一天常赶不到窗口', () => {
    const c = computeDeadline('起诉15日', '2026-08-19').caveats.join();
    expect(c).toContain('在期满前交邮');
    expect(c).toContain('详情单存根');
  });
});

describe('举证期限：天数由仲裁委指定，不是法定固定值', () => {
  it('照通知书天数算', () => {
    expect(computeDeadline('举证期限', '2026-08-19', { days: 10 }).dueDate).toBe('2026-08-28');
    expect(computeDeadline('举证期限', '2026-08-19', { days: 7 }).dueDate).toBe('2026-08-25');
  });

  it('不给天数直接抛错——绝不替仲裁委猜一个默认值', () => {
    expect(() => computeDeadline('举证期限', '2026-08-19')).toThrow(/天数/);
    expect(() => computeDeadline('举证期限', '2026-08-19', { days: 0 })).toThrow(/天数/);
  });
});

describe('依据与如实标注（charter §3）', () => {
  it('每条规则的 basis 都带条号与逐字原文，不是转述', () => {
    for (const rule of Object.values(DEADLINE_RULES)) {
      expect(rule.basis).toMatch(/第[一二三四五六七八九十百零]+条|《举证须知》/);
      expect(rule.basis).toContain('「');
    }
  });

  it('推算依据可自查：写清锚点、起算方式、跨度与结果', () => {
    const r = computeDeadline('起诉15日', '2026-08-19');
    expect(r.derivedFrom).toContain('2026-08-19');
    expect(r.derivedFrom).toContain('次日起算');
    expect(r.derivedFrom).toContain('15 日');
    expect(r.derivedFrom).toContain('2026-09-03');
    expect(r.derivedFrom).toContain('第五十条');
  });

  it('每次推算都带「未含节假日顺延」标注——不假装精确', () => {
    for (const key of ['仲裁时效', '起诉15日', '上诉15日', '申请执行2年', '答辩期15日']) {
      expect(computeDeadline(key, '2026-08-19').caveats).toContain(HOLIDAY_CAVEAT);
    }
    expect(computeDeadline('举证期限', '2026-08-19', { days: 10 }).caveats).toContain(HOLIDAY_CAVEAT);
  });

  it('答辩期直接落字面值 kind（无 DB CHECK，不必借「自定义」占位）', () => {
    const r = computeDeadline('答辩期15日', '2026-08-19');
    expect(r.rule.storedKind).toBe('答辩期');
    expect(r.rule.label).toContain('答辩');
  });

  it('上诉规则显式提醒「对裁定是 10 日不是 15 日」', () => {
    expect(computeDeadline('上诉15日', '2026-08-19').caveats.join()).toContain('10 日');
  });
});

describe('输入校验', () => {
  it('未知期限类型报错并列出可选值', () => {
    expect(() => computeDeadline('随便什么期限', '2026-08-19')).toThrow(/仲裁时效/);
  });

  it.each(['去年三月', '2026/08/19', '2026-13-01', '2026-02-30', ''])('非法日期「%s」抛错', (bad) => {
    expect(() => computeDeadline('起诉15日', bad)).toThrow();
  });

  it('接受带时间的串，只取日期部分（不受时区影响）', () => {
    expect(computeDeadline('起诉15日', '2026-08-19 23:30:00').dueDate).toBe('2026-09-03');
    expect(computeDeadline('起诉15日', '2026-08-19T00:00:00Z').dueDate).toBe('2026-09-03');
  });
});

describe('确定性：不读时钟', () => {
  it('同一输入反复求值结果完全一致', () => {
    const first = computeDeadline('仲裁时效', '2026-08-19').dueDate;
    for (let i = 0; i < 20; i++) expect(computeDeadline('仲裁时效', '2026-08-19').dueDate).toBe(first);
  });
});
