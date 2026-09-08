import { describe, expect, it } from 'vitest';

import type { AgentEvent } from '../../app/src/lib/agent';

import type { Verdict } from './assertions';
import {
  archiveCrisisPaid,
  archiveGateReport,
  archiveLeverage,
  archiveStatuteGate,
  renderMarkdown,
  type RunEvidence,
} from './report';

/**
 * 看门测试：**markdown 成绩单不许把第三态渲染成绿勾。**
 *
 * 【事故来历·2026-08-26 评测官全量对账】`renderMarkdown` 此前只读 `pass`，
 * 而产出 N/A 的断言普遍写 `pass: true`（源码原注：「让旧的布尔消费者不炸；真正的判定看 na」）。
 * 结果：同一条 verdict，控制台显示 `N/A`、md 显示 `✅ PASS`。
 * `results/` 下 45 个批次共 65 条 N/A 断言，**在 md 里 100% 显示成 ✅ PASS**——
 * 其中含 `pending_card` / `pending_injection` 这两类**缺口**。
 *
 * 【为什么测真渲染而不是只测 assertionMark】这个 bug 的形状是**调用点用错了函数**。
 * 只测标记函数本身，挡不住有人把调用点改回 `verdictMark(v.pass)`——
 * 那正是它当初的样子。**看门测试要站在事故真正发生的那条路径上。**
 */
describe('成绩单渲染：N/A 不得显示成 PASS', () => {
  const run = (mechanical: Verdict[]): RunEvidence => ({
    runId: 'TEST',
    startedAt: '2026-08-26T00:00:00Z',
    finishedAt: '2026-08-26T00:01:00Z',
    plan: 'pro',
    routing: [{ taskClass: 'critical', model: 'deepseek/deepseek-v4-pro' }],
    judgeEnabled: false,
    runNotes: [],
    scenarios: [
      {
        id: 'S99',
        title: '渲染看门',
        redline: false,
        pass: true,
        turns: [],
        mechanical,
        semantic: [],
      },
    ],
  });

  const row = (md: string, id: string): string => {
    const m = new RegExp(`^\\|[^|]*\\|([^|]+)\\|\\s*${id}\\s*\\|`, 'm').exec(md);
    expect(m, `成绩单里找不到断言 ${id} 那一行`).not.toBeNull();
    return m![1].trim();
  };

  // 三态必须三种写法，且**两两不同**——否则"分列统计"在人读的那一份里就不成立
  it('N/A（pass:true）显示 N/A 而不是 PASS，并带出成因分类', () => {
    const md = renderMarkdown(
      run([
        // 真实形状：N/A 断言普遍写 pass:true 兼容旧消费者
        { id: 'NA-1', tier: 'L2', pass: true, na: true, naKind: 'pending_card', detail: '库里还没有这张卡' },
      ]),
    );
    const mark = row(md, 'NA-1');
    expect(mark).not.toContain('PASS');
    expect(mark).toContain('N/A');
    expect(mark).toContain('pending_card');
  });

  it('N/A（pass:false）同样显示 N/A 而不是 FAIL', () => {
    const md = renderMarkdown(
      run([{ id: 'NA-2', tier: 'L1', pass: false, na: true, naKind: 'observability_missing', detail: '判不了' }]),
    );
    const mark = row(md, 'NA-2');
    expect(mark).not.toContain('FAIL');
    expect(mark).toContain('N/A');
  });

  it('真 PASS 与真 FAIL 照旧（证明上面两条不是靠"全都不显示 PASS"换来的）', () => {
    const md = renderMarkdown(
      run([
        { id: 'OK-1', tier: 'L1', pass: true, detail: '过' },
        { id: 'NG-1', tier: 'L1', pass: false, detail: '挂' },
      ]),
    );
    expect(row(md, 'OK-1')).toContain('PASS');
    expect(row(md, 'NG-1')).toContain('FAIL');
  });
});

describe('闸留痕 → 转录的映射（三态；抽成纯函数才测得到）', () => {
  /* 【为什么这组测试是补上来的，来历要留下】
   * 2026-08-28 我加 `crisisPaid` 那一格时，这段映射是**内联 IIFE**，没有任何测试覆盖。
   * 我当时主动打了折：「代码在树上 ≠ 它会写下来，零批次产出过这个字段」。
   * **但打折不是处置**——正确的处置是把它变成不跑批也能测的，而不是等下一批替我验。
   * （评测官的批已钉在 ff0fa12 上验这一格；这组测试与那次验证是**两条独立的路**，
   *   一条静态一条实跑，都过才算数。） */
  const notice = (code: string, data: Record<string, unknown> = {}) =>
    ({ event: 'notice' as const, data: { code, message: 'm', ...data } }) as unknown as AgentEvent;

  it('★闸没开火 ⇒ 必须是 null，不是 undefined（否则与"旧转录没这一层"分不开）', () => {
    expect(archiveCrisisPaid([])).toBeNull();
    expect(archiveLeverage([])).toBeNull();
    // 有别的 notice 但不是这一条，同样是 null
    expect(archiveCrisisPaid([notice('ACTION_CARD_MISSING')])).toBeNull();
    expect(archiveLeverage([notice('CITATION_BLOCKED')])).toBeNull();
  });

  it('★D15 闸开火 ⇒ 带出 message', () => {
    const got = archiveCrisisPaid([notice('CRISIS_PAID_CONTENT_BLOCKED', { message: '危机轮出现付费/预约内容「一次 600 元」，已整句剥除。' })]);
    expect(got).not.toBeNull();
    expect(got!.message).toContain('一次 600 元');
  });

  it('★杠杆闸开火 ⇒ 带出处置、被剥原句、**闸前正文**', () => {
    const got = archiveLeverage([
      notice('EMOTIONAL_LEVERAGE_DETECTED', {
        leverage_outcome: 'stripped',
        stripped_sentences: ['想想你爸妈，他们该多伤心。'],
        model_body_raw: '想想你爸妈，他们该多伤心。我在。',
      }),
    ]);
    expect(got).toMatchObject({ outcome: 'stripped', stripped: ['想想你爸妈，他们该多伤心。'] });
    expect(got!.bodyRaw).toContain('我在。');
  });

  it('★旧代码跑出来的 notice 缺字段时不许塌成假值', () => {
    // outcome 缺 → 记「未记」而不是 undefined；stripped 缺 → 空数组而不是 undefined；
    // 但 bodyRaw 缺 **必须留 undefined**——它是三态里的"不知道"，判据据此写「本条判定不完整」。
    const got = archiveLeverage([notice('EMOTIONAL_LEVERAGE_DETECTED')]);
    expect(got).toMatchObject({ outcome: '未记', stripped: [] });
    expect(got!.bodyRaw, 'bodyRaw 缺失是"不知道"，不能被兜成空串').toBeUndefined();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * ⑥ 条号闸留痕 + 闸链两率列（S2 闸链补齐 2026-09-08）
 * ═══════════════════════════════════════════════════════════════════════════ */

function gateNotice(code: string, data: Record<string, unknown>): AgentEvent {
  return { event: 'notice', data: { code, message: '', ...data } } as AgentEvent;
}

describe('归档映射：⑥ 与闸链汇总的三态', () => {
  it('这一层根本没跑 → null（旧产物）：判据据此产 N/A，不计过不计挂', () => {
    expect(archiveStatuteGate([])).toBeNull();
    expect(archiveGateReport([])).toBeNull();
  });

  it('别的 notice 不算数（按 code 取，不按顺序取）', () => {
    expect(archiveStatuteGate([gateNotice('CITATION_BLOCKED', {})])).toBeNull();
  });

  /**
   * 【放行集读的是 GATE_REPORT，不是 STATUTE_UNVERIFIED（2026-09-08 复审 major）】
   * 后者**只在闸开火时发**。从它取放行集的形态是：模型全引对的干净轮没有这条 notice →
   * 归档 `statuteGate: null` → 判据读成"放行集为空" → 用户面每一处**真放行**的条号
   * 都被判成漏网，L1 在最理想的一轮恒红，还与同轮 `gate_report.leaked = 0` 打架。
   */
  it('干净轮（⑥ 没开火）照样落盘放行集，且 marked 为空（放行集挂在开火那条上 → 红）', () => {
    const got = archiveStatuteGate([gateNotice('GATE_REPORT', { gate_report: { statute_allowed: ['某某某某法|第46条'] } })]);
    expect(got).toEqual({ marked: [], allowed: ['某某某某法|第46条'] });
  });

  it('开火 → 标注清单来自 ⑥ 自己那条，放行集来自无条件发的那条（两条各管一半）', () => {
    const got = archiveStatuteGate([
      gateNotice('STATUTE_UNVERIFIED', {
        statute_marked: [{ cited: '《某某某某法》第四十八条', verdict: 'unverified' }],
      }),
      gateNotice('GATE_REPORT', { gate_report: { statute_allowed: ['某某某某法|第46条'] } }),
    ]);
    expect(got).toEqual({
      marked: [{ cited: '《某某某某法》第四十八条', verdict: 'unverified' }],
      allowed: ['某某某某法|第46条'],
    });
  });

  it('闸链汇总原样落盘（率在服务端算好，报告不重算——重算就是第二个真源）', () => {
    const gr = {
      gates: { statute_guard: { seen: 10, fired: 1 } },
      seen: 10,
      fired: 1,
      replace_rate: 0.1,
      leaked: 0,
      leak_rate: 0,
      budget: 0.02,
      over_budget: true,
      source_status_unknown: 3,
      statute_ambiguous: 2,
      statute_doc_rejected: 1,
      statute_allowed: ['某某某某法|第46条'],
    };
    expect(archiveGateReport([gateNotice('GATE_REPORT', { gate_report: gr })])).toEqual(gr);
  });
});

describe('成绩单：替换率与漏网率并列成两列', () => {
  const withTurns = (gateReport: unknown): RunEvidence =>
    ({
      runId: 'TEST',
      startedAt: '2026-09-08T00:00:00Z',
      finishedAt: '2026-09-08T00:01:00Z',
      plan: 'pro',
      routing: [{ taskClass: 'critical', model: 'deepseek/deepseek-v4-pro' }],
      judgeEnabled: false,
      runNotes: [],
      scenarios: [
        {
          id: 'S03',
          title: '两率',
          redline: false,
          pass: true,
          turns: [
            {
              input: '问',
              text: '答',
              actionCards: [],
              retrievedIds: [],
              gateStrippedArticles: [],
              model: 'deepseek-v4-pro',
              degraded: false,
              taskClass: 'critical',
              gateReport,
            },
          ],
          mechanical: [],
          semantic: [],
        },
      ],
    }) as unknown as RunEvidence;

  const BASE = {
    gates: { statute_guard: { seen: 10, fired: 1 } },
    seen: 10,
    fired: 1,
    replace_rate: 0.1,
    leaked: 0,
    leak_rate: 0,
    budget: 0.02,
    over_budget: false,
    source_status_unknown: 0,
  };

  it('两个率都出现在同一张表里（只渲染替换率 → 红）', () => {
    const md = renderMarkdown(withTurns(BASE));
    expect(md).toContain('闸链替换率 / 漏网率');
    expect(md).toContain('| 轮 | 候选 | 动手 | 替换率 | 漏网 | 漏网率 | 逐闸（seen/fired） |');
    expect(md).toContain('10.0%');
    expect(md).toContain('statute_guard 10/1');
  });

  it('超预算被点名，且明写「按闸误伤处理」（改成阻断口径或删掉点名 → 红）', () => {
    const md = renderMarkdown(withTurns({ ...BASE, over_budget: true }));
    expect(md).toContain('超预算');
    expect(md).toContain('按闸误伤处理');
    expect(md).toContain('不阻断发版');
  });

  it('漏网不为 0 打叉（0 与非 0 在纸上必须一眼可分）', () => {
    const md = renderMarkdown(withTurns({ ...BASE, leaked: 2, leak_rate: 0.2 }));
    expect(md).toContain('| 2 ❌ |');
  });

  it('登记簿未接上的条目单列一行（合进"没问题"就等于接上那天报表一个字不变）', () => {
    const md = renderMarkdown(withTurns({ ...BASE, source_status_unknown: 4 }));
    expect(md).toContain('`source_status` 未接上的条目共 4 处');
    expect(md).toContain('不是"它是现行"');
  });

  it('⑥ 形态歧义放过去的处数单列（缺口只写在注释里 = 与"没有这个缺口"在纸上同形）', () => {
    const md = renderMarkdown(withTurns({ ...BASE, statute_ambiguous: 3 }));
    expect(md).toContain('放过 3 处');
    expect(md).toContain('明说的洞');
    // 为 0 时不占版面（每一行都写会把真正要看的东西挤下去）
    expect(renderMarkdown(withTurns(BASE))).not.toContain('明说的洞');
  });

  it('文书通道拒收数单列，并写明它不在替换率里（合进去 → 闸做对的事被记成误伤）', () => {
    const md = renderMarkdown(withTurns({ ...BASE, statute_doc_rejected: 2 }));
    expect(md).toContain('文书通道拒收** 2 处');
    expect(md).toContain('不在上面的替换率里');
  });

  it('留痕缺失的那一轮显示 —，**不显示 0**（"不知道"与"一处都没动"不许同形）', () => {
    const md = renderMarkdown(withTurns(null));
    // 整节不出现（本场没有任何一轮有 gate_report）
    expect(md).not.toContain('闸链替换率 / 漏网率');
  });
});
