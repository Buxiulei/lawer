// app/src/lib/evidence/__tests__/mask-cert.test.ts
// 证件号掩码。**这个值印在《存证证明》PDF 上，是一份对外出示的文件**，
// 所以这里的判据是"露了几位"，不是"函数没抛错"。
import { describe, expect, test } from 'vitest';

import { CERT_TYPE, maskCertNo } from '../attest';

/**
 * 露出来的字符数。
 * 【写错过一次，记在这】第一版写的是 `replace(/[^*]/g, '')`——那是**删掉非星号**、
 * 留下星号，数出来的是"遮了几位"。量尺反了，于是实现明明对的、5 条断言全红，
 * 看起来像掩码函数坏了。**判据自己的量尺错了，报出来的是被测对象的错。**
 */
const revealed = (s: string | null) => (s ?? '').replace(/\*/g, '').length;

describe('身份证：保持既有行为（已发出的证不改格式）', () => {
  test('18 位留头 4 尾 4', () => {
    expect(maskCertNo('110101199001011234', CERT_TYPE.idCard)).toBe('1101**********1234');
  });
  test('露 8 位、遮 10 位', () => {
    const m = maskCertNo('110101199001011234', CERT_TYPE.idCard);
    expect(revealed(m)).toBe(8);
    expect(m).toHaveLength(18);
  });
});

describe('🔴 护照：这条是本次的病灶', () => {
  test('9 位护照不得再露 8 位', () => {
    // 旧规则（留头 4 尾 4）会给出 'E123*5678' —— 露 8/9，等于没打码
    const m = maskCertNo('E12345678', CERT_TYPE.passport);
    expect(m).not.toBe('E123*5678');
    expect(revealed(m)).toBeLessThanOrEqual(3);
    expect(m).toHaveLength(9);
  });

  test('露出的比例必须低于一半', () => {
    for (const no of ['E12345678', 'EA1234567', 'G12345678', 'PE1234567']) {
      const m = maskCertNo(no, CERT_TYPE.passport)!;
      expect(revealed(m) / no.length, no).toBeLessThan(0.5);
    }
  });

  test('仍留头尾各一点，本人认得出是自己那本', () => {
    expect(maskCertNo('E12345678', CERT_TYPE.passport)).toBe('E******78');
  });
});

describe('🔑 cert_type 缺失时走最保守规则，不按长度猜', () => {
  test('未知类型的 9 位号，按护照规则遮', () => {
    // 【为什么不猜】猜错不报错，只是发出去的证上多露几位，没有任何人会发现。
    // 误差方向必须偏向"少露"：露得少不造成伤害，露得多会。
    expect(maskCertNo('E12345678', null)).toBe('E******78');
    expect(maskCertNo('E12345678', undefined)).toBe('E******78');
  });

  test('未知类型的 18 位号也按保守规则——宁可比身份证遮得更多', () => {
    const m = maskCertNo('110101199001011234', null)!;
    expect(revealed(m)).toBe(3);
    // 对照：显式声明是身份证时才露 8 位
    expect(revealed(maskCertNo('110101199001011234', CERT_TYPE.idCard))).toBe(8);
  });

  test('空串/null 原样传回 null，不产出一串星号冒充有值', () => {
    expect(maskCertNo(null, CERT_TYPE.passport)).toBeNull();
    expect(maskCertNo('   ', CERT_TYPE.passport)).toBeNull();
  });
});

describe('极短输入不许越界', () => {
  test('3 位及以下全遮', () => {
    expect(maskCertNo('AB', CERT_TYPE.passport)).toBe('**');
    expect(maskCertNo('ABC', CERT_TYPE.passport)).toBe('***');
    expect(revealed(maskCertNo('ABC', CERT_TYPE.passport))).toBe(0);
  });
});
