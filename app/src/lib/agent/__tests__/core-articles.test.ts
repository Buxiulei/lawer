// app/src/lib/agent/__tests__/core-articles.test.ts
// 核心依据条标注（解 S03#2 真挂）。
//
// 【为什么不是"每条必须带原文"】那条粗规则会盖掉核心/辅助分层与 pending 三分支。
// S03#2 的真实形态是：模型对结论句同句的那条只给了条号——它不是不会引，
// 是**不知道哪条值得引全**。所以修法是**把"哪条是核心"从模型的判断变成注入的事实**：
// 降低正确行为的成本，而不是提高错误行为的代价。
import { describe, expect, it } from 'vitest';

import { coreArticleKeys, packCitationGuide } from '../citation-block';
import type { KnowledgePack } from '../retrieval';

const pack = (quotes: { law: string; article: string; text: string }[]): KnowledgePack =>
  ({
    id: 'statute-x', title: '法条卡', type: '法条卡', region: '北京',
    confidence: '原文核实', updated: '2026-08-19', body: '正文',
    facts: { statute_quotes: quotes },
  }) as KnowledgePack;

describe('核心条判定：只认结构化事实，不让模型自己勾', () => {
  it('从 claims.basis 取（这是钱的依据，用户会拿它去主张）', () => {
    const keys = coreArticleKeys({ claims: [{ basis: '《劳动合同法实施条例》第二十七条；《劳动合同法》第四十七条' }] });
    expect(keys.has('劳动合同法实施条例|第二十七条')).toBe(true);
    expect(keys.has('劳动合同法|第四十七条')).toBe(true);
  });

  it('从行动卡 detail 取（行动卡是"现在做什么"，其依据必然核心）', () => {
    const keys = coreArticleKeys({ openActions: [{ detail: '为什么：依据《劳动争议调解仲裁法》第二十七条，时效一年' }] });
    expect(keys.has('劳动争议调解仲裁法|第二十七条')).toBe(true);
  });

  it('从期限推算依据取', () => {
    expect(coreArticleKeys({ deadlines: [{ derived_from: '《民事诉讼法》第八十五条' }] }).has('民事诉讼法|第八十五条')).toBe(true);
  });

  it('全称简称互认（卡写全称、档案写简称也要认出来）', () => {
    const keys = coreArticleKeys({ claims: [{ basis: '《中华人民共和国劳动合同法》第四十七条' }] });
    expect(keys.has('劳动合同法|第四十七条')).toBe(true);
  });

  it('档案为空时不产出核心条——**不猜**', () => {
    expect(coreArticleKeys({}).size).toBe(0);
  });
});

describe('引用块里的核心条标注', () => {
  const p = pack([
    { law: '劳动合同法实施条例', article: '第二十七条', text: '经济补偿的月工资按照劳动者应得工资计算……' },
    { law: '劳动争议调解仲裁法', article: '第二十七条', text: '劳动争议申请仲裁的时效期间为一年……' },
  ]);

  // S03#2 的正解：档案里的诉求金额依赖实施条例§27，于是它被标为核心、要求带原文
  it('核心条被显式标出并要求带逐字原文', () => {
    const guide = packCitationGuide(p, coreArticleKeys({ claims: [{ basis: '《劳动合同法实施条例》第二十七条' }] }));
    expect(guide).toContain('本轮核心依据条');
    expect(guide).toContain('《劳动合同法实施条例》第二十七条');
    expect(guide).toContain('必须带逐字原文');
    // 非核心条不被点名（其余可只给条号）
    expect(guide.split('本轮核心依据条')[1].split('\n')[0]).not.toContain('调解仲裁法');
  });

  it('没有核心条时不加这一段——**不制造噪音**', () => {
    const guide = packCitationGuide(p, new Set());
    expect(guide).not.toContain('本轮核心依据条');
  });

  it('同号不同法不得互相冒充（与 G4 复合键同一判据）', () => {
    const guide = packCitationGuide(p, coreArticleKeys({ claims: [{ basis: '《劳动争议调解仲裁法》第二十七条' }] }));
    const named = guide.split('本轮核心依据条')[1].split('\n')[0];
    expect(named).toContain('调解仲裁法');
    expect(named).not.toContain('实施条例');
  });
});
