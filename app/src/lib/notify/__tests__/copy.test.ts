// app/src/lib/notify/__tests__/copy.test.ts
// copy.ts 顶部那条产品约束是给旁边同事看的手机横幅兜底的，用测试钉死：
// 默认模式下敏感词一个都不许出现。将来谁往文案里加一句"仲裁"，这里会红。
import { describe, expect, test } from 'vitest';

import { emailVerifyCode, smsVerifyTemplateParam } from '../copy';

/** 被旁人瞟一眼就会暴露用户在维权的词 */
const SENSITIVE = ['裁员', '仲裁', '开庭', '劳动', '律师', '赔偿', '解除', '离职', '维权'];

describe('emailVerifyCode', () => {
  test('默认（中性）模式：主题与正文不含敏感词，也不含平台名', () => {
    const { subject, text } = emailVerifyCode('123456', 5);
    // 历史品牌名一并钉住：改名不该让旧名字从某个没改到的地方漏出来
    for (const word of [...SENSITIVE, '土八鼠', '土拨鼠', '裁员应对专员']) {
      expect(subject).not.toContain(word);
      expect(text).not.toContain(word);
    }
    expect(subject).toBe('验证码：123456');
    expect(text).toContain('5 分钟内有效');
  });

  test('detailed 模式才带平台名，且仍不出现业务敏感词', () => {
    const { subject, text } = emailVerifyCode('123456', 10, { detailed: true });
    expect(subject).toContain('土八鼠');
    // 旧品牌名一个都不许出现——改名漏改会在这里报红
    for (const old of ['土拨鼠劳动仲裁', '土拨鼠', '裁员应对专员']) {
      expect(subject).not.toContain(old);
      expect(text).not.toContain(old);
    }
    // **不需要「先摘掉平台名再查」**：品牌名本身不含敏感词，断言直接查全文。
    // 这一条同时是**改名的闸**：将来若换成带「劳动」「仲裁」等字样的名字，这里会红。
    for (const word of SENSITIVE) {
      expect(subject).not.toContain(word);
      expect(text).not.toContain(word);
    }
    expect(text).toContain('10 分钟内有效');
  });
});

describe('smsVerifyTemplateParam', () => {
  test('只传 code 变量，正文措辞留给阿里云模板', () => {
    expect(smsVerifyTemplateParam('654321')).toBe('{"code":"654321"}');
  });
});
