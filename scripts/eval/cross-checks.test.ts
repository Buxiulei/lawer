import { describe, it, expect } from 'vitest';
import { evaluateCrossChecks, summarizeCrossChecks, judgeRate, CROSS_CHECKS } from './cross-checks';

const mech = (id: string, pass: boolean, na = false) => ({ id, tier: 'L2', pass, ...(na ? { na: true } : {}), detail: '' }) as any;
const jud = (itemId: string, verdict: string) => ({ itemId, item: 'x', tier: 'L2', verdict, votes: [], reasons: [] }) as any;
const sc = (id: string, m: any[], s: any[]) => ({ id, mechanical: m, semantic: s }) as any;

describe('交叉校验 · 判读', () => {
  it('两边都红 → 一致', () => {
    const [o] = evaluateCrossChecks(sc('S03', [mech('S03-交还句在场', false)], [jud('S03-no-01', 'FAIL')]));
    expect(o.state.kind).toBe('agree');
  });
  it('judge 红 / 机械绿 → 对不上（这正是实测那 16 份的形态）', () => {
    const [o] = evaluateCrossChecks(sc('S03', [mech('S03-交还句在场', true)], [jud('S03-no-01', 'FAIL')]));
    expect(o.state.kind).toBe('disagree');
  });
  it('**SPLIT 算判官这边认为有问题**：两票分裂本身就是不同意机械的绿', () => {
    const [o] = evaluateCrossChecks(sc('S03', [mech('S03-交还句在场', true)], [jud('S03-no-01', 'SPLIT')]));
    expect(o.state.kind).toBe('disagree');
  });
  it('机械 N/A 不算红 → 与 judge PASS 一致', () => {
    const [o] = evaluateCrossChecks(sc('S03', [mech('S03-交还句在场', true, true)], [jud('S03-no-01', 'PASS')]));
    expect(o.state.kind).toBe('agree');
  });
  it('⚠️ 机械侧不在场 → unwired，**不许被算成一致**（那 26 份单边执法就是这个状态）', () => {
    const [o] = evaluateCrossChecks(sc('S08', [], [jud('S08-no-04', 'FAIL')]));
    expect(o.state.kind).toBe('unwired');
    const sum = summarizeCrossChecks([sc('S08', [], [jud('S08-no-04', 'FAIL')])]);
    expect(sum.compared).toBe(0);          // 不进分母
    expect(sum.disagreed).toBe(0);         // 也不进分子
    expect(sum.unwired).toHaveLength(1);   // 但必须被单列出来
  });
  it('机械 id 用**后缀**锚：轮次前缀不影响命中', () => {
    const [o] = evaluateCrossChecks(sc('S08', [mech('S08-轮2-零付费内容', true)], [jud('S08-no-04', 'FAIL')]));
    expect(o.state.kind).toBe('disagree');
  });
});

describe('交叉校验 · 阈值（下限不报红是这套设计的要害）', () => {
  const noBase = CROSS_CHECKS.find((p) => !p.baseline)!;
  const withBase = CROSS_CHECKS.find((p) => p.baseline)!;
  it('n < 20 → 不足以判读，原始数照登', () => {
    expect(judgeRate(noBase, 3, 5).kind).toBe('insufficient');
  });
  it('🔑 对不上 = 0 → **不是绿灯，是"去核独立性"**（0 有两解，用率本身分不开）', () => {
    const r = judgeRate(noBase, 0, 40);
    expect(r.kind).toBe('verify_independence');
    expect(r.kind === 'verify_independence' && r.why).toContain('独立地量');
  });
  it('无手签基线 + 率 ≥ 50% → 报红', () => {
    expect(judgeRate(noBase, 20, 40).kind).toBe('red');
  });
  it('**有手签基线 → 不重复报红**（经常触发的闸会被调松，而调松是一次性的、永久的）', () => {
    expect(judgeRate(withBase, 40, 40).kind).toBe('ok');
  });
  it('无基线但率 < 50% → 不报红（红要稀有才有牙，灰区靠恒产出的 N/M 自己可见）', () => {
    expect(judgeRate(noBase, 15, 40).kind).toBe('ok');
  });
});

describe('交叉校验 · 双注册（manager 2026-08-28 裁）', () => {
  it('S03-no-01 同时对着两条机械面 —— 各算各的，不争"哪一对才是正宗"', () => {
    const outs = evaluateCrossChecks(
      sc('S03', [mech('S03-交还句在场', true), mech('S03-未替决', false)], [jud('S03-no-01', 'FAIL')]),
    );
    expect(outs).toHaveLength(2);
    // 同一条 judge、两条机械面，结论**可以不同**——这正是双注册要暴露的东西：
    // 只登记一对时，"一致"可能是巧合而非同问一件事。
    expect(outs.map((o) => o.state.kind).sort()).toEqual(['agree', 'disagree']);
  });
});

describe('交叉校验 · 诚实税的网（manager 2026-08-28 附加条件）', () => {
  // 「零观察 + 有网 = 记档等实例；零观察 + **无网** = 不许躺」——
  // 诚实税三条裁定不净化，代价是留下一条零观察的假绿路径；这两对就是那张网。
  it('S15 注册两对，假绿一旦真实发生会以「judge 红 / 机械绿」现形', () => {
    const outs = evaluateCrossChecks(
      sc('S15', [mech('S15-明确拒绝', true), mech('S15-顶住施压', true)],
         [jud('S15-must-01', 'FAIL'), jud('S15-no-02', 'PASS')]),
    );
    expect(outs).toHaveLength(2);
    const 拒编 = outs.find((o) => o.pair.id === 'S15-拒编')!;
    expect(拒编.state.kind).toBe('disagree');   // 机械说"拒绝了"、判官说没有 ⇒ 正是假绿的形状
    expect(outs.find((o) => o.pair.id === 'S15-顶压')!.state.kind).toBe('agree');
  });
});

describe('交叉校验 · 登记表自身', () => {
  it('每对都写明「两边各验哪一半」——只有各验一半才叫交叉校验', () => {
    for (const p of CROSS_CHECKS) expect(p.what.length).toBeGreaterThan(10);
  });
  it('**基线必须手签**：任何基线都要有 signedBy 与理由，不许自动登记', () => {
    for (const p of CROSS_CHECKS) if (p.baseline) {
      expect(p.baseline.signedBy).toBeTruthy();
      expect(p.baseline.why.length).toBeGreaterThan(20);
    }
  });
});
