// app/src/lib/billing/__tests__/served-model.test.ts
// 「请求的型号 vs 实际服务的型号」对账（评测遗留②）。这里钉的是**钱算在谁头上**：
// 中转把 opus 请求路由到 sonnet 返回时，按 opus 收钱就是让用户为没拿到的高档付费。
import { describe, expect, it } from 'vitest';
import { reconcileServedModel } from '../served-model';
import { MODELS, billingKey } from '@/lib/llm/routing.config';

/** 高配 critical 的真实目标：opus 经中转。两个串不同是设计如此（api 别名 vs 计费锁定串）。 */
const OPUS = { api: MODELS.CLAUDE_OPUS.api, key: billingKey({ provider: 'relay', model: MODELS.CLAUDE_OPUS }) };
const SONNET = { api: MODELS.CLAUDE_SONNET.api, key: billingKey({ provider: 'relay', model: MODELS.CLAUDE_SONNET }) };

describe('回显与请求一致 / 未回显：原样计价，不制造噪声', () => {
  it('一致 → 计费键不变、无审计痕', () => {
    const r = reconcileServedModel(OPUS.key, OPUS.api);
    expect(r.verdict).toBe('match');
    expect(r.billingModel).toBe(OPUS.key);
    expect(r.trace).toBeNull();
  });

  it('未回显（null）→ 走既有兜底，不崩、不改价、不告警', () => {
    const r = reconcileServedModel(OPUS.key, null);
    expect(r.verdict).toBe('absent');
    expect(r.billingModel).toBe(OPUS.key);
    expect(r.trace).toBeNull();
  });

  it('回显空串/纯空白按「没回显」处理（不是「服务模型叫空字符串」）', () => {
    for (const empty of ['', '   ']) {
      const r = reconcileServedModel(OPUS.key, empty);
      expect(r.verdict).toBe('absent');
      expect(r.billingModel).toBe(OPUS.key);
    }
  });
});

describe('回显是另一个已登记型号：按**实际服务的**计价（命脉判据）', () => {
  it('请求 opus 实际由 sonnet 服务 → 计费键换成 sonnet，并留下 requested/served 审计痕', () => {
    const r = reconcileServedModel(OPUS.key, SONNET.api);
    expect(r.verdict).toBe('substituted');
    // 换的是型号，**不是通路**：经的还是中转那条线，relay/ 前缀必须留着，
    // 否则会拿直连价给中转记账（routing.config.RELAY_BILLING_PREFIX 原话）。
    expect(r.billingModel).toBe(SONNET.key);
    expect(r.billingModel.startsWith('relay/')).toBe(true);
    expect(r.trace).toEqual({
      requested: OPUS.key,
      served: SONNET.api,
      billed: SONNET.key,
      verdict: 'substituted',
    });
  });

  it('直连侧同样成立（没有 relay/ 前缀就不要凭空加一个）', () => {
    const req = billingKey({ provider: 'deepseek', model: MODELS.DEEPSEEK_PRO });
    const r = reconcileServedModel(req, MODELS.DEEPSEEK_FLASH.api);
    expect(r.verdict).toBe('substituted');
    expect(r.billingModel).toBe(MODELS.DEEPSEEK_FLASH.priced);
    expect(r.billingModel.includes('relay/')).toBe(false);
  });

  it('计费维度变体后缀跟着走：变体是我们下发的请求参数，换谁服务都照样发出去了', () => {
    const req = billingKey({ provider: 'relay', model: MODELS.QWEN_MAX, variant: 'nothink' });
    expect(req).toBe('relay/qwen3.7-max:nothink'); // 前提没变才谈得上后面的断言
    const r = reconcileServedModel(req, MODELS.DEEPSEEK_FLASH.api);
    expect(r.billingModel).toBe(`relay/${MODELS.DEEPSEEK_FLASH.priced}:nothink`);
  });

  it('换出来的键必须是 api→priced 反查的结果，不是把回显串原样当计费键', () => {
    // deepseek 的 api 别名与 priced 串**长得完全不一样**（前者是调用串，后者是定价页产品名）。
    // 直接拿回显串当计费键会查不到 model_rates，静默掉进 DEFAULT_RATES 兜底价。
    const req = billingKey({ provider: 'deepseek', model: MODELS.DEEPSEEK_FLASH });
    const r = reconcileServedModel(req, MODELS.DEEPSEEK_PRO.api);
    expect(r.billingModel).toBe('DeepSeek-V4-Pro-0813');
    expect(r.billingModel).not.toBe(MODELS.DEEPSEEK_PRO.api);
  });
});

describe('回显是没登记过的串：不猜价，但必须留痕', () => {
  // 厂商给别名追加日期后缀是最常见的形态（routing.config 文件头点名的那条残留风险）。
  const SNAPSHOT = 'claude-opus-5-20260514';

  it('维持请求价（兜底价不是价格，拿它计 opus 等于每次漏收一个数量级）', () => {
    const r = reconcileServedModel(OPUS.key, SNAPSHOT);
    expect(r.verdict).toBe('unrecognized');
    expect(r.billingModel).toBe(OPUS.key);
  });

  it('但这一轮要被标出来——留痕是它与「一切正常」的唯一区别', () => {
    const r = reconcileServedModel(OPUS.key, SNAPSHOT);
    expect(r.trace).toEqual({
      requested: OPUS.key,
      served: SNAPSHOT,
      billed: OPUS.key,
      verdict: 'unrecognized',
    });
  });
});
