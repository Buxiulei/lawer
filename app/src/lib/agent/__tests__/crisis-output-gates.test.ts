/**
 * 【危机轮输出流经的闸 · 登记册】(manager 2026-08-25 点名要的产物，硬门槛不是建议)
 *
 * 【为什么要有这份东西】杠杆闸把**复述用户原话的共情句**整句删掉，在生产上发生了，
 * 而我们是靠 ws2-agent 落码时偶然撞到才知道的——**没有人在维护一份"危机轮的话会经过谁的手"的清单**。
 * 判据误报只是记一笔错账；**闸误报是当场把话删掉，而且用户不知道少了什么**。
 *
 * 【这份清单的规矩】**此后新增任何一道剥除/改写环节，必须在这里登记**，
 * 并给出它在危机轮的实测影响。下面那条元测试会在漏登记时变红——
 * 它扫的是 `orchestrator.ts` 的真实调用，**不是靠人记得来更新**。
 *
 * 【一处纠正】此前口头传的是"已知三道"，**实测是六道**（见下表）。
 * 少数的那三道里，`stripNbdpsyPitch` 与第五闸同样会动危机轮的正文。
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

/**
 * 危机轮正文流经的**全部**剥除/改写环节，按 orchestrator 里的先后顺序。
 * `mutates` = 它会不会改动用户最终看到的正文。
 */
const CRISIS_OUTPUT_GATES = [
  {
    fn: 'stripLeverageSentences',
    what: '情感杠杆句整句剥除（仅危机轮）',
    enabled: true,
    note: '2026-08-25 修：改为来源判别——引号内容来自用户原话＝复述，放行；替他构造的情绪照剥',
  },
  {
    fn: 'CRISIS_SAFE_FALLBACK',
    what: '剥完仍命中或剥空 → 模型段整段丢弃，回落确定性安全回复（仅危机轮）',
    enabled: true,
    note: '影响最大的一道：模型的话一个字都不下发',
  },
  {
    fn: 'stripDuplicateHotlineList',
    what: '与首段重复的整张热线卡剥除（仅危机轮）',
    enabled: false,
    note: '当前 CRISIS_HOTLINE_DEDUP_ENABLED=false，**该函数在产线上不被调用**（已按代码核实，非按注释）',
  },
  {
    fn: 'stripNbdpsyPitch',
    what: '付费心理咨询推介句整句剥除',
    enabled: true,
    note: '不限危机轮，但危机轮同样流经',
  },
  {
    fn: 'stripUnsupportedQuotes',
    what: '第五闸：引号内伪逐字法条引用改口为「待核实」',
    enabled: true,
    note: '唯一一道**留痕**的闸（CITATION_BLOCKED.stripped_articles）——正因为它留痕，§27 那次才定得了案',
  },
  {
    fn: 'renderCoreArticleFallback',
    what: '核心位光秃条号就地补入卡内逐字原文（**增**不是删）',
    enabled: true,
    note: '方向与其余五道相反：它往正文里加内容',
  },
] as const;

describe('危机轮输出流经的闸：登记册与漏登记检测', () => {
  const SRC = readFileSync(new URL('../orchestrator.ts', import.meta.url), 'utf8');

  it('登记册里的每一项都真的出现在 orchestrator 里（防清单与代码脱节）', () => {
    const missing = CRISIS_OUTPUT_GATES.filter((g) => !SRC.includes(g.fn)).map((g) => g.fn);
    expect(missing, `登记了但代码里找不到（改名了？删了？）：${missing.join('、')}`).toEqual([]);
  });

  it('★漏登记检测：orchestrator 里所有 strip* 调用都必须在登记册上', () => {
    // 扫真实调用，不靠人记得更新清单
    const called = [...SRC.matchAll(/\b(strip[A-Z]\w+)\s*\(/g)].map((m) => m[1]);
    const registered = new Set<string>(CRISIS_OUTPUT_GATES.map((g) => g.fn));
    const unregistered = [...new Set(called)].filter((fn) => !registered.has(fn));
    expect(
      unregistered,
      `以下剥除环节在 orchestrator 里被调用但**没有登记**：${unregistered.join('、')}\n` +
        `→ 危机轮的话会经过它而没人知道。请登记并给出它在危机轮的实测影响。`,
    ).toEqual([]);
  });

  it('自证扫得到东西（扫不到时上一条会假绿）', () => {
    expect([...SRC.matchAll(/\bstrip[A-Z]\w+\s*\(/g)].length).toBeGreaterThanOrEqual(3);
  });

  it('停用中的闸确实没在跑（按代码核实，不按注释）', () => {
    // 注释说"已临时停用"不算证据——常量为 false 且是 && 的第一个操作数，才算
    expect(SRC).toContain('const CRISIS_HOTLINE_DEDUP_ENABLED = false');
    const disabled = CRISIS_OUTPUT_GATES.filter((g) => !g.enabled).map((g) => g.fn);
    expect(disabled).toEqual(['stripDuplicateHotlineList']);
  });
});
