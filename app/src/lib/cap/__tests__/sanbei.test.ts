// app/src/lib/cap/__tests__/sanbei.test.ts
// 三倍社平封顶基数：**一个值、一个出处、一份口径**。
//
// 此前它在仓里有两份：对话侧读知识卡（47103.25，卡自己标着「待核实」），
// 首诊结果页读 `_mock/demo.ts` 的 35283（演示案件叙事用的数）。
// 同一个人在两页看到两个封顶线，两处都不说自己是哪来的——而它决定赔偿金额的上限。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  isSanbeiCapVerified,
  readCardValueFen,
  readSanbeiCap,
  SANBEI_CAP_PACK_ID,
  SANBEI_CAP_UNVERIFIED_CAVEAT,
  SANBEI_CAP_VALUE_KEY,
  sanbeiCapFacts,
} from '../sanbei';
import * as knowledge from '@/lib/knowledge';

describe('值只从知识卡来', () => {
  it('卡里读得到当前值，且带着生效期间与可信度', () => {
    const cap = readSanbeiCap(knowledge.get(SANBEI_CAP_PACK_ID).facts);
    expect(cap).not.toBeNull();
    expect(cap!.yuan).toBe(47103.25);
    expect(cap!.capFen).toBe(4_710_325);
    expect(cap!.effectiveFrom).toBe('2024-06-19');
    expect(cap!.confidence).toBe('待核实');
  });

  it('卡上标着待核实 → 展示口径必须带这句话', () => {
    const cap = readSanbeiCap(knowledge.get(SANBEI_CAP_PACK_ID).facts)!;
    expect(isSanbeiCapVerified(cap)).toBe(false);
    const facts = sanbeiCapFacts(cap);
    expect(facts).toContain('47103.25');
    expect(facts).toContain('2024-06-19');
    expect(facts).toContain('待核实');
    expect(SANBEI_CAP_UNVERIFIED_CAVEAT).toContain('以最新公布值为准');
  });

  it('单位不是「元/月」就回 null，不猜、不换算', () => {
    expect(
      readCardValueFen({ values: [{ key: 'k', value: 1, unit: '分/月', effective_from: 'x', confidence: 'y' }] }, 'k'),
    ).toBeNull();
    expect(
      readCardValueFen({ values: [{ key: 'k', value: 0, unit: '元/月', effective_from: 'x', confidence: 'y' }] }, 'k'),
    ).toBeNull();
    expect(readCardValueFen(undefined, 'k')).toBeNull();
    expect(readSanbeiCap({ values: [] })).toBeNull();
  });

  it('元 → 分只在这一处换算，且是四舍五入不是截断', () => {
    expect(
      readCardValueFen(
        { values: [{ key: SANBEI_CAP_VALUE_KEY, value: 47103.25, unit: '元/月', effective_from: 'x', confidence: 'y' }] },
        SANBEI_CAP_VALUE_KEY,
      )!.fen,
    ).toBe(4_710_325);
  });
});

/**
 * 结构守卫：**必须能红的那条。**
 * 有人把演示素材里的封顶常量接回首诊金额表（哪怕只是"先跑起来"），这里立刻红。
 */
describe('演示素材里的封顶线不许再进真实用户路径', () => {
  const APP = join(process.cwd(), 'src/app');
  const read = (p: string) => readFileSync(join(APP, p), 'utf8');

  it('正对照：demo.ts 里确实有那个数，不是在空集上断言', () => {
    const demo = read('_mock/demo.ts');
    expect(demo).toContain('BJ_CAP_YUAN');
    expect(demo).toContain('11761');
  });

  it('首诊的金额估算不再引 demo 的封顶常量', () => {
    const src = read('_mock/intake-evidence.ts');
    expect(src).not.toContain('BJ_CAP_YUAN');
    expect(src).not.toContain('BJ_AVG_WAGE_YUAN');
    // 正向：它现在从唯一定义那里取口径
    expect(src).toContain('@/lib/cap/sanbei');
  });

  it('首诊结果页拿到的是外面传进来的读数，不是自己写死的数', () => {
    const src = read('(app)/intake/_components/StepPreview.tsx');
    expect(src).toContain('cap');
    expect(src).not.toContain('35283');
    expect(src).not.toContain('BJ_CAP');
  });

  it('agent 那条路也从同一个模块取，不另存一份 key / 卡 id', () => {
    const tools = readFileSync(join(process.cwd(), 'src/lib/agent/tools.ts'), 'utf8');
    expect(tools).toContain("from '@/lib/cap/sanbei'");
    // 卡 id 与 key 的字面量只该出现在 lib/cap/sanbei 里
    expect(tools).not.toContain("'fengding_jishu_monthly'");
    expect(tools).not.toContain("'data-beijing-shepin-fengding'");
  });
});
