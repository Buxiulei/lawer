// app/src/lib/agent/__tests__/task-class.test.ts
// task_class 判定。判成 critical 只多花几分钱，判成 standard 却可能让用户拿便宜模型的答案
// 去做不可逆决定——所以这里逐条守的是「这些话必须进 critical」。
import { describe, expect, it } from 'vitest';

import { classifyTask, criticalReasons } from '../task-class';

const chat = (message: string, mode = '问诊') => classifyTask({ message, mode });

describe('critical：签不签 / 金额 / 期限 / 文书定稿', () => {
  it.each([
    ['HR 给我协议让我今天下班前签，说今天不签明天名额就没了', '不可逆动作'],
    ['明天我就把辞职信一交不干了', '不可逆动作'],
    ['我到底签不签？不去保定算旷工吗', '不可逆动作'],
    ['像我这情况，公司到底应该赔我多少钱？', '金额'],
    ['帮我算一下 N 是几个月', '金额'],
    ['仲裁时效是多久，过了还能申请吗', '期限'],
    ['裁决下来 20 天了公司一分钱没给', '期限'],
    ['帮我起草一份被迫解除劳动合同通知书', '文书'],
    ['这份异议函能定稿发给公司了吗', '文书'],
    ['刚收到辞退邮件，说什么客观情况重大变化', '解除定性'],
    ['HR 突然把我叫进会议室约谈', '解除定性'],
    ['有时候半夜想，要是人没了是不是就不用还房贷了', '危机'],
  ])('「%s」→ critical（命中 %s）', (message, reason) => {
    expect(chat(message)).toBe('critical');
    expect(criticalReasons({ message, mode: '问诊' })).toContain(reason);
  });

  it('文书模式整条线都是 critical，与用户说了什么无关', () => {
    expect(chat('嗯', '文书')).toBe('critical');
    expect(criticalReasons({ message: '嗯', mode: '文书' })).toContain('文书');
  });
});

describe('standard：日常陪跑对话', () => {
  it.each([
    '今天没啥事，就是想聊聊',
    '我同事也被这么搞过，他后来去别的公司了',
    '谢谢你，我心里舒服多了',
  ])('「%s」→ standard', (message) => {
    expect(chat(message)).toBe('standard');
    expect(criticalReasons({ message, mode: '陪跑' })).toEqual([]);
  });

  it('永不返回 bulk：面向用户的对话轮没有便宜到可以走 bulk 的东西', () => {
    for (const m of ['随便说说', '签字', '算钱', '起草']) {
      expect(chat(m)).not.toBe('bulk');
    }
  });
});
