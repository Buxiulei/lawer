// app/src/lib/notify/__tests__/copy.test.ts
// copy.ts 顶部那条产品约束是给旁边同事看的手机横幅兜底的，用测试钉死：
// 默认模式下敏感词一个都不许出现。将来谁往文案里加一句"仲裁"，这里会红。
import { describe, expect, test } from 'vitest';

import {
  deadlineReminder,
  emailNotRegistered,
  emailVerifyCode,
  realnameReviewResult,
  smsVerifyTemplateParam,
  watchBillingNotice,
} from '../copy';

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

describe('emailNotRegistered（陌生邮箱引导信）', () => {
  test('不含敏感词，也不含平台名——收件人可能根本不是我们的用户', () => {
    const { subject, text } = emailNotRegistered();
    for (const word of [...SENSITIVE, '土八鼠', '土拨鼠', '裁员应对专员']) {
      expect(subject).not.toContain(word);
      expect(text).not.toContain(word);
    }
  });

  /**
   * 【这封信是那条 404 的替身，替的是它「有用」的那一半】
   * 接口对注册状态一个字都不说（同形响应，见 lib/auth 的 single-factor 判据），
   * 于是打错字的用户失去了唯一的解释来源——补回来的地方只能是收件箱：
   * 只有邮箱的主人看得到它，拿别人邮箱去探的人什么也拿不到。
   */
  test('🔴 三段式仍在：撞到的是什么、为什么会撞到、现在能怎么办', () => {
    const { text } = emailNotRegistered();
    expect(text).toContain('还没有账号'); // 撞到的是什么
    expect(text).toContain('绑定'); // 为什么会撞到
    expect(text).toContain('手机号'); // 现在能怎么办
  });

  test('🔴 信里没有六位码——它不是验证码信，收到它的人登不进去', () => {
    const { subject, text } = emailNotRegistered();
    expect(subject).not.toMatch(/\d{6}/);
    expect(text).not.toMatch(/\d{6}/);
  });
});

describe('smsVerifyTemplateParam', () => {
  test('只传 code 变量，正文措辞留给阿里云模板', () => {
    expect(smsVerifyTemplateParam('654321')).toBe('{"code":"654321"}');
  });
});

describe('deadlineReminder（期限提醒，2026-08-29 新增）', () => {
  // 【为什么这道闸要覆盖到新模板】manager 派单时点名：出站敏感词禁令照旧生效。
  // 而这封邮件比验证码更危险——验证码泄露的是"他在注册什么"，
  // 期限提醒泄露的是**他正在维权，且时间紧迫**。
  test('默认（中性）模式：主题与正文均不含敏感词，也不含平台名', () => {
    for (const kind of ['仲裁时效', '起诉15日', '申请执行2年', '开庭', '答辩期']) {
      for (const d of [30, 7, 3, 1, 0]) {
        const c = deadlineReminder(d, kind);
        for (const w of SENSITIVE) {
          expect(c.subject, `${kind}/${d}天/主题/${w}`).not.toContain(w);
          expect(c.text, `${kind}/${d}天/正文/${w}`).not.toContain(w);
        }
      }
    }
  });

  test('🔴 中性模式连事项类型都不给 —— 连"开庭"两个字都不许出现', () => {
    // 【为什么比敏感词表更严】"开庭"不在 SENSITIVE 表里，但它一样会暴露。
    // 中性模式的判据不是"避开某张词表"，是**除了紧急度什么都不说**。
    const c = deadlineReminder(3, '开庭');
    expect(c.subject).not.toContain('开庭');
    expect(c.text).not.toContain('开庭');
  });

  test('中性模式仍要给出剩余天数 —— 那是他判断紧急度的最小必要信息', () => {
    expect(deadlineReminder(3, '仲裁时效').subject).toContain('3');
    expect(deadlineReminder(0, '仲裁时效').subject).toContain('今天');
  });

  test('detailed 模式（用户自己开的 notify_verbose）才允许出现事项类型', () => {
    const c = deadlineReminder(3, '开庭', { detailed: true });
    expect(c.subject).toContain('开庭');
  });
});

describe('watchBillingNotice（守望计费通知，spec v3 §2.2）', () => {
  // 【为什么这封也要过中性闸】收件人多半还在原公司上班。一封写着「某某公司守望监控欠费暂停」
  // 被工位旁人瞟见，暴露的是**他在背地里盯着这家公司**——和暴露"他在维权"一样不可逆。
  test('默认（中性）模式：欠费/暂停两态，主题与正文均不含敏感词、不含平台名', () => {
    for (const paused of [false, true]) {
      const c = watchBillingNotice(paused);
      for (const word of [...SENSITIVE, '土八鼠', '土拨鼠', '裁员应对专员']) {
        expect(c.subject, `paused=${paused}/主题/${word}`).not.toContain(word);
        expect(c.text, `paused=${paused}/正文/${word}`).not.toContain(word);
      }
    }
  });

  test('🔴 中性模式连"监控/守望/公司"都不给 —— 只说"一项服务"', () => {
    // 判据不是避开某张词表，是**除了"有项服务要处理"什么都不说**：连它盯的是不是公司都不暴露。
    for (const paused of [false, true]) {
      const c = watchBillingNotice(paused);
      for (const w of ['监控', '守望', '公司', '盯']) {
        expect(c.subject).not.toContain(w);
        expect(c.text).not.toContain(w);
      }
    }
  });

  test('暂停态与欠费态措辞可区分（暂停必须明说"已暂停"，绝不静默停盯）', () => {
    expect(watchBillingNotice(true).subject).toContain('暂停');
    expect(watchBillingNotice(false).subject).not.toContain('暂停');
  });

  test('detailed 模式才带平台名，且仍不出现业务敏感词', () => {
    for (const paused of [false, true]) {
      const c = watchBillingNotice(paused, { detailed: true });
      expect(c.subject).toContain('土八鼠');
      for (const word of SENSITIVE) {
        expect(c.subject, `paused=${paused}/主题/${word}`).not.toContain(word);
        expect(c.text, `paused=${paused}/正文/${word}`).not.toContain(word);
      }
    }
  });
});

describe('realnameReviewResult（实名审核结果通知，2026-09-03 新增）', () => {
  test('默认（中性）模式：主题与正文不含敏感词，也不含平台名', () => {
    const c = realnameReviewResult();
    for (const word of [...SENSITIVE, '土八鼠', '土拨鼠', '裁员应对专员']) {
      expect(c.subject, `主题/${word}`).not.toContain(word);
      expect(c.text, `正文/${word}`).not.toContain(word);
    }
  });

  test('🔴 中性模式连"实名/认证/护照/审核"都不给 —— 只说"有结果了，去看看"', () => {
    // 判据不是避开某张词表：一封写着「实名审核未通过」的邮件被工位旁人瞟见，
    // 暴露的是他在某个需要实名固化证据的平台上办事。
    const c = realnameReviewResult();
    for (const w of ['实名', '认证', '护照', '审核', '通过', '驳回']) {
      expect(c.subject, `主题/${w}`).not.toContain(w);
      expect(c.text, `正文/${w}`).not.toContain(w);
    }
  });

  test('🔴 函数不接受结论/原因参数：无论通过还是驳回，发出去的是同一封', () => {
    // 变异对照：给它加一个 passed/reason 入口，这条断言（长度=1，且只有 options）会红。
    expect(realnameReviewResult.length).toBeLessThanOrEqual(1);
    expect(realnameReviewResult()).toEqual(realnameReviewResult({}));
  });

  test('detailed 模式才带平台名与事项类型，且仍不出现业务敏感词', () => {
    const c = realnameReviewResult({ detailed: true });
    expect(c.subject).toContain('土八鼠');
    expect(c.subject).toContain('实名');
    for (const word of SENSITIVE) {
      expect(c.subject, `主题/${word}`).not.toContain(word);
      expect(c.text, `正文/${word}`).not.toContain(word);
    }
  });
});
