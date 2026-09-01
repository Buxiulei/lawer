// app/src/lib/billing/__tests__/served-model.test.ts
// 「请求的型号 vs 实际服务的型号」对账（评测遗留②）。这里钉的是**钱算在谁头上**：
// 中转把 opus 请求路由到 sonnet 返回时，按 opus 收钱就是让用户为没拿到的高档付费。
import { describe, expect, it } from 'vitest';
import { reconcileServedModel } from '../served-model';
import type { TokenRates } from '../pricing';
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

describe('换型号取两者较低价（billed = min(requested, served)）：传 rateOf 才做方向裁决', () => {
  // 量纲对齐 modelRates 种子（opus $5/$25、sonnet $2/$10）：这里只需相对大小对得上。
  const RATE: Record<string, TokenRates> = {
    [OPUS.key]: { in: 5, out: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    [SONNET.key]: { in: 2, out: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  };
  const rateOf = (m: string): TokenRates => RATE[m];

  it('降档（请求 opus 回 sonnet）：按 served=sonnet 收——用户不为没拿到的高档付', () => {
    const r = reconcileServedModel(OPUS.key, SONNET.api, rateOf);
    expect(r.verdict).toBe('substituted');
    expect(r.billingModel).toBe(SONNET.key);
    expect(r.trace).toEqual({ requested: OPUS.key, served: SONNET.api, billed: SONNET.key, verdict: 'substituted' });
  });

  it('升档（请求 sonnet 回 opus）：按 requested=sonnet 收——用户不为中转擅自的升档买单', () => {
    const r = reconcileServedModel(SONNET.key, OPUS.api, rateOf);
    expect(r.verdict).toBe('substituted');
    // billed 落在较低的 sonnet 上；但实情如实留痕：这一轮确实由 opus 服务的。
    expect(r.billingModel).toBe(SONNET.key);
    expect(r.trace).toEqual({ requested: SONNET.key, served: OPUS.api, billed: SONNET.key, verdict: 'substituted' });
  });

  it('不传 rateOf：退回「按 served」的身份口径（只解析服务了谁、不做方向裁决）', () => {
    // 升档方向下这一档确实会多扣——正因如此生产两个记账点必须传 rateOf，本条钉住这条契约边界。
    expect(reconcileServedModel(SONNET.key, OPUS.api).billingModel).toBe(OPUS.key);
    expect(reconcileServedModel(OPUS.key, SONNET.api).billingModel).toBe(SONNET.key);
  });
});
