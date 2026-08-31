// app/src/lib/company/__tests__/normalize.test.ts
// company_key 的唯一入口。两侧都要钉死：该归一的归一（否则重复收费），
// **不该归一的绝不归一**（否则两家不同主体撞同一个 key，用户付了 A 的钱拿到 B 的档案）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

import { companyKeyOf, normalizeCompanyName } from '../normalize';

describe('该归一的归一', () => {
  test('首尾与中间空白（含全角空格、不间断空格）一律去掉', () => {
    const base = companyKeyOf({ name: '北京甲科技有限公司' });
    for (const variant of [
      ' 北京甲科技有限公司 ',
      '北京甲科技有限公司　',
      '北京 甲 科技 有限公司',
      '北京甲科技有限公司 ',
    ]) {
      expect(companyKeyOf({ name: variant }), `变体「${variant}」未归一`).toBe(base);
    }
  });

  test('全角括号/字母/数字折成半角（NFKC 一步到位，不靠手写标点表）', () => {
    expect(normalizeCompanyName('北京（朝阳）甲科技')).toBe(normalizeCompanyName('北京(朝阳)甲科技'));
    expect(normalizeCompanyName('ＡＢＣ科技')).toBe(normalizeCompanyName('abc科技'));
    expect(normalizeCompanyName('甲１２３')).toBe(normalizeCompanyName('甲123'));
  });

  test('英文大小写归一', () => {
    expect(normalizeCompanyName('ABC Tech')).toBe(normalizeCompanyName('abc tech'));
  });
});

describe('不该归一的绝不归一（误合并方向比误分开严重得多）', () => {
  test('「有限公司」与「有限责任公司」是两个 key——工商登记上可以是两家主体', () => {
    expect(companyKeyOf({ name: '北京甲科技有限公司' })).not.toBe(
      companyKeyOf({ name: '北京甲科技有限责任公司' }),
    );
  });

  test('去掉公司后缀之后同名的两家，仍是两个 key', () => {
    expect(companyKeyOf({ name: '甲' })).not.toBe(companyKeyOf({ name: '甲有限公司' }));
  });

  test('繁简不归一（没有可核对的对照表就不做，凑几个字的假表比不做更危险）', () => {
    expect(normalizeCompanyName('臺北甲')).not.toBe(normalizeCompanyName('台北甲'));
    expect(companyKeyOf({ name: '廣州甲科技有限公司' })).not.toBe(
      companyKeyOf({ name: '广州甲科技有限公司' }),
    );
  });
});

describe('统一社会信用代码优先', () => {
  test('填了 uscc 就完全不看公司名（更名不换档）', () => {
    const a = companyKeyOf({ name: '北京甲科技有限公司', uscc: '91110105MA01ABCD2X' });
    const b = companyKeyOf({ name: '北京甲科技（更名后）有限公司', uscc: '91110105MA01ABCD2X' });
    expect(a).toBe(b);
    expect(a).toBe('91110105MA01ABCD2X');
  });

  test('uscc 归一：去空白、转大写', () => {
    expect(companyKeyOf({ name: '甲', uscc: ' 91110105ma01abcd2x ' })).toBe('91110105MA01ABCD2X');
  });

  test('uscc 为空串/纯空白 → 回落公司名，不产生空 key', () => {
    expect(companyKeyOf({ name: '北京甲科技有限公司', uscc: '  ' })).toBe(
      companyKeyOf({ name: '北京甲科技有限公司' }),
    );
  });
});

describe('空名必须抛，不能产生空 key', () => {
  test('只有空白的公司名 → 抛，且文案三段式', () => {
    let message = '';
    try {
      companyKeyOf({ name: ' 　\t\n' });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain('公司名为空'); // 缺什么
    expect(message).toMatch(/共用同一条档案/); // 为什么不行
    expect(message).toMatch(/公司全称|统一社会信用代码/); // 怎么办
  });
});

describe('结构守卫 · 归一化只有一个入口', () => {
  // 教训「修入口不修五处」：company_key 同时是缓存键与计费键，
  // 两处算法分叉就会出现「报价时判为已有存档、建档时又新建一条」这种一半便宜一半全价的账。
  const SRC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, out);
      else if (/\.tsx?$/.test(entry.name)) out.push(full);
    }
    return out;
  }

  test('全仓只有 normalize.ts 自己在拼 company_key，别处一律调它', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC_DIR)) {
      if (file.endsWith(path.join('company', 'normalize.ts'))) continue;
      if (file.endsWith('normalize.test.ts')) continue;
      const src = fs.readFileSync(file, 'utf-8');
      // 别处出现 NFKC 归一 + 大小写折叠的组合，就是在自己造第二个 company_key
      if (/normalize\(\s*['"]NFKC['"]\s*\)/.test(src)) offenders.push(path.relative(SRC_DIR, file));
    }
    expect(offenders, `这些文件在自己做公司名归一化，应改调 companyKeyOf：${offenders.join(', ')}`).toEqual([]);
  });
});
