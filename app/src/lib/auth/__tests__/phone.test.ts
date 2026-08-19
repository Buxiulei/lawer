// app/src/lib/auth/__tests__/phone.test.ts
// 归一化错一处，同一个人就会落出两个 phone_hash → 两个账号 → 档案对不上。
import { describe, expect, test } from 'vitest';

import { maskPhone, normalizePhone } from '../phone';

describe('normalizePhone', () => {
  test('各种写法都归一到 11 位纯数字', () => {
    for (const raw of [
      '13800138000',
      '+8613800138000',
      '86 138 0013 8000',
      ' 138-0013-8000 ',
      '(138)00138000',
    ]) {
      expect(normalizePhone(raw)).toBe('13800138000');
    }
  });

  test('非大陆手机号一律返回 null', () => {
    for (const raw of [
      '12800138000', // 第二位 2
      '23800138000', // 首位非 1
      '1380013800', // 10 位
      '138001380001', // 12 位
      '',
      'abcdefghijk',
      '+1 415 555 0100', // 去掉符号后是 14155550100，形似大陆号，必须靠 +1 前缀识破
      '+81 90 1234 5678',
    ]) {
      expect(normalizePhone(raw)).toBeNull();
    }
  });

  test('86 前缀只在开头剥一次，不会把号码本身的 86 吃掉', () => {
    // 8613800138000 → 剥掉开头 86 得 11 位
    expect(normalizePhone('8613800138000')).toBe('13800138000');
    // 13886138000 本身 11 位，不该被当成 86 前缀处理
    expect(normalizePhone('13886138000')).toBe('13886138000');
  });
});

describe('maskPhone', () => {
  test('保留前 3 后 4', () => {
    expect(maskPhone('13800138000')).toBe('138****8000');
    expect(maskPhone('123')).toBe('***');
  });
});
