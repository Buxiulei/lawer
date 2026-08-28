// scripts/eval/report.ts
// 评测证据产物落盘（manager 验收 M1 红线要看的证据链）。
//
// 为什么必须落文件：stdout 滚过去就没了，而红线剧本的结论是「一票 FAIL 即不可发版」这种
// 要被引用的判断。证据得能在几天后被翻出来逐条核对——尤其 judge 的两票分歧，
// 那正是需要人复核的地方，光看一个 PASS/FAIL 汇总数字没有意义。
//
// 两份产物，各有各的读者：
//   <runId>.json  机器可读全量：含每轮完整原文、每条 judge 的两票与两条理由。用于比对与回溯。
//   <runId>.md    人读摘要：manager 打开就能看红线过没过、哪条挂了、分歧在哪。
// 目录进 .gitignore：里面是大段模型原文与案情夹具，留服务器上供查，不进仓库。
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { AgentEvent } from '../../app/src/lib/agent';
import type { Verdict } from './assertions';
import type { JudgeResult } from './judge';
import { findRuling } from './human-review';
import { summarizeCrossChecks } from './cross-checks';

export const RESULTS_DIR = path.resolve(import.meta.dirname, 'results');

/* ═══════════════════════════════════════════════════════════════════════════
 * 闸留痕 → 转录的映射：**抽成纯函数，因为原来它是内联 IIFE，测不到**
 * ═══════════════════════════════════════════════════════════════════════════
 * 【为什么抽】2026-08-28 我补 `crisisPaid` 那一格时，自己给自己打了折：
 * 「tsc 干净、1743 绿——**但没有一条测试跑过这段归档映射**（它是内联的），
 *  零批次产出过这个字段。⇒ 我能说的只有『代码在树上』，不能说『它会写下来』。」
 * 那句打折是对的，**但打折不是处置**：正确的处置是把它变成可测的，而不是等下一批替我验。
 *
 * 这与今天同一族的三条是同一个动作：判据同源要共用**原语**、
 * 整卡计数要抽 `cardOccurrences`、危机首段切分要抽 `splitCrisisOpener`——
 * **凡是"只有跑一遍才知道对不对"的逻辑，先想办法把它变成"不跑也能测"。**
 *
 * 【三态，两个函数都一样】
 *   对象      = 闸开过火
 *   `null`    = 这一层跑了、闸没开火
 *   字段缺失  = 这份转录**根本没有这一层**（旧产物）
 * 调用方必须**无条件写**（`null` 也写）——否则后两者在归档里长得一模一样，
 * 而 `events` 不进归档，离线回放就只剩这一格可依。
 */
type NoticeEvent = Extract<AgentEvent, { event: 'notice' }>;

function findNotice(events: AgentEvent[], code: string): NoticeEvent | undefined {
  return events.find((e) => e.event === 'notice' && e.data.code === code) as NoticeEvent | undefined;
}

/** 杠杆闸留痕（含**闸前模型段原文**——没有它，那条 L1 结构上只能报绿）。 */
export function archiveLeverage(events: AgentEvent[]): ScenarioEvidence['turns'][number]['leverage'] {
  const ev = findNotice(events, 'EMOTIONAL_LEVERAGE_DETECTED');
  if (!ev) return null;
  return {
    outcome: ev.data.leverage_outcome ?? '未记',
    stripped: ev.data.stripped_sentences ?? [],
    bodyRaw: ev.data.model_body_raw,
  };
}

/**
 * 注入产物可观测（⭐机制）的留痕。**2026-08-28 补，这是同形态的第三次。**
 *
 * 【怎么被发现的】评测官想拿归档语料扫"哪个剧本 ⭐候选 > 0"，脚本当场炸：
 * `TypeError: t.events is not iterable` —— 因为**归档 turn 里根本没有 `events` 这个键**。
 * ⇒ ⭐断言实跑时读得到（events 在内存里），**它的判定从归档里永远重放不出来**：
 * 任何离线回放都会走 `!obs` 分支 → `na(observability_missing)`。
 *
 * **这是"留痕不进归档"的第三处**（08-26 `leverage` / 08-28 `crisisPaid` / 本条）。
 * 三次都是同一个形状：**判据读 `t.events`，而 `events` 不进归档**。
 * 前两次是查出来的，这次是**想拿数据做别的事时炸出来的**——
 * **想用一份数据做点别的，是发现它缺什么最便宜的方式。**（评测官语）
 *
 * 【三态照旧】对象=机制跑了且有产出；`null`=这一层跑了、本轮没有 INJECTION_OBSERVED；
 * 字段缺失=这份转录没有这一层。**注意与 `injection` 内部字段的三态是两层**：
 * 外层管"有没有这条 notice"，内层的 `[]`/`0` 管"机制跑了但产出为空"——**两层都不许塌。**
 */
export function archiveInjection(events: AgentEvent[]): ScenarioEvidence['turns'][number]['injection'] {
  const ev = findNotice(events, 'INJECTION_OBSERVED');
  return ev?.data.injection ?? null;
}

/** D15 危机轮付费禁令那道闸的留痕。 */
export function archiveCrisisPaid(events: AgentEvent[]): ScenarioEvidence['turns'][number]['crisisPaid'] {
  const ev = findNotice(events, 'CRISIS_PAID_CONTENT_BLOCKED');
  return ev ? { message: ev.data.message } : null;
}

export interface ScenarioEvidence {
  id: string;
  title: string;
  redline: boolean;
  pass: boolean;
  error?: string;
  /** 本场安全闸门触发次数（质量指标，不构成 FAIL——用户面零编造才是红线口径） */
  gateHits?: { citation: number; leverage: number };
  turns: {
    input: string;
    text: string;
    actionCards: { title: string; detail: string; due_at: string | null }[];
    retrievedIds: string[];
    /**
     * 本轮第五闸剥掉原文的那些 `法名|条号`（闸自己写下的留痕）。
     *
     * 【为什么必须落进转录】8101783 批 S03 复盘时，转录只有 post-gate 正文——
     * "这处光秃是模型没给还是闸拿走的"**无法离线判定**，只能记到模型账上。
     * 留痕落盘之后，同一份转录下次回放就能分账（态⑤ gate_stripped）。
     */
    gateStrippedArticles: string[];
    /**
     * 杠杆闸的留痕：处置 + 被剥原句 + **闸前模型段原文**。
     *
     * 【为什么闸前原文必须进转录】归档 `text` 是闸后产物，于是「危机轮无情感杠杆」这条 L1
     * 在结构上只能绿——模型真说了、闸剥掉了、判据看不见（评测官 2026-08-26 对账：
     * 归档 130 批里产出过这条断言的 12 批 / 12 个实例 / 0 次报红）。**那个绿是被剥出来的，不是模型守规矩换来的。**
     * 字段缺失 = 这份转录跑在没留它的旧代码上，判据须写明「判定不完整」，不许当"没有"。
     */
    /**
     * D15 危机轮付费禁令那道闸的留痕（三态同 `leverage`）：
     * 对象=开过火；`null`=这一层跑了、闸没开火；字段缺失=旧转录没有这一层。
     *
     * 【2026-08-28 补，来历要写清】此前它一格留痕都没有，于是
     * 「这条 L1 从没报过红」与「这条 L1 从没被执行过」在归档里是同一个观察——
     * 而后者当天刚被评测官在 `nbdpsyPitchAssertions` 上实证发生过一次（登记+单测+import 齐全，唯独没接线）。
     */
    crisisPaid?: { message: string } | null;
    /**
     * ⭐注入产物可观测的留痕（2026-08-28 补）。没有它，`injectionObservability` 的判定
     * **在任何归档转录上都重放不出来**——它读 `t.events`，而 `events` 不进归档。
     */
    injection?: {
      coreCandidateKeys: string[];
      coreBlockRendered: string[];
      renderAdded: string[];
      substantiveHitCount: number;
    } | null;
    leverage?: { outcome: string; stripped: string[]; bodyRaw?: string } | null;
    /** 这一轮实际跑在哪个模型上——证据必须自证，不能靠「我记得是 deepseek」 */
    model: string;
    degraded: boolean;
    taskClass: string;
  }[];
  mechanical: Verdict[];
  semantic: JudgeResult[];
}

export interface RunEvidence {
  runId: string;
  startedAt: string;
  finishedAt: string;
  plan: string;
  /** 开跑前解析出的路由（已断言未降级），形如 critical→deepseek/deepseek-v4-pro */
  routing: { taskClass: string; model: string }[];
  /** judge 关掉时为 false，报告里必须写清楚——否则会被误读成「全套都过了」 */
  judgeEnabled: boolean;
  /**
   * 本次运行的披露说明（EVAL_RUN_NOTE 环境变量，多条用 ` | ` 分隔）。
   * 用于记录「这一轮跑的代码与当前主干有什么差异」这类**读结果的人必须知道**的事——
   * 比如某道防线是在本轮启动之后才加的。披露写进产物比写进某条消息可靠：
   * 消息会被翻过去，而产物是日后回看这次运行的唯一依据。
   */
  runNotes: string[];
  scenarios: ScenarioEvidence[];
}

/** 文件名用的时间戳：冒号在部分文件系统上不合法，换成短横 */
export function newRunId(now = new Date()): string {
  return now.toISOString().replace(/[:.]/g, '-').slice(0, 19) + 'Z';
}

function verdictMark(pass: boolean): string {
  return pass ? '✅ PASS' : '❌ FAIL';
}

/**
 * 机械断言行的标记。**必须先看 `na`**——这是第三态，既不计过也不计挂
 *（`eval-agent.ts` 的 `failed: !v.na && !v.pass` 就是这么算的）。
 *
 * 【为什么补这条·2026-08-26 评测官实测】此前这里只读 `pass`，而**产出 N/A 的断言
 * 普遍写 `pass: true`**（代码里原注：「让旧的布尔消费者不炸；真正的判定看 na」）。
 * 于是同一条 verdict：**控制台显示 `N/A`，markdown 成绩单显示 `✅ PASS`。**
 * 全量对账：`results/` 下 45 个批次共 65 条 N/A 断言，**在 md 里 100% 显示成 ✅ PASS**，
 * 其中含 `pending_card`（库里缺这张卡）与 `pending_injection`（召回没给到）——
 * **这两类恰恰是"缺口"，是要被追踪的，却在人读的那份产物里长成了绿勾。**
 *
 * manager 2026-08-21 的两条硬规矩之一是「N/A 与 PASS 分列统计」；控制台照办了，
 * **而 md 是 manager 实际打开的那一份**。两个产物对同一份数据说两套话，
 * 比其中任何一份单独说错都糟：看的人无从知道自己在读哪一套。
 */
function assertionMark(v: Verdict): string {
  if (v.na) return `➖ N/A${v.naKind ? `·${v.naKind}` : ''}`;
  return verdictMark(v.pass);
}

/** 导出仅为可测：这条渲染路径出过一次"N/A 被显示成 PASS"的事故，看门测试必须走真渲染，
 *  只测 assertionMark 本身挡不住"调用点被改回 verdictMark"这种改法。 */
export function renderMarkdown(run: RunEvidence): string {
  const lines: string[] = [
    `# C04 评测证据 · ${run.runId}`,
    '',
    `- 运行时间：${run.startedAt} → ${run.finishedAt}`,
    `- 套餐档：${run.plan}`,
    `- **实际模型路由**：${run.routing.map((r) => `${r.taskClass} → ${r.model}`).join('；')}（开跑前已断言未降级）`,
    `- 语义断言（judge 两票制）：${run.judgeEnabled ? '已启用' : '**未启用**（本次只跑机械断言，不构成完整验收）'}`,
    ...(run.runNotes.length ? ['', '### 本次运行说明（披露）', '', ...run.runNotes.map((n) => `- ${n}`)] : []),
    `- 剧本：${run.scenarios.length} 个，通过 ${run.scenarios.filter((s) => s.pass).length} 个`,
    '',
  ];

  const redlines = run.scenarios.filter((s) => s.redline);
  if (redlines.length) {
    lines.push('## 红线剧本结论（一票 FAIL 即整场 FAIL，不加权）', '');
    for (const s of redlines) lines.push(`- **${s.id} ${s.title}**：${verdictMark(s.pass)}`);
    lines.push('');
  }

  // 人工复核清单：把所有 SPLIT 集中列出，已裁定的带结论与理由，未裁的显式写「待复核」。
  // 单独成节而不是散在各剧本里——验收的人要的是「还有几条没人看过」这一个答案。
  const splits = run.scenarios.flatMap((s) =>
    s.semantic.filter((j) => j.verdict === 'SPLIT').map((j) => ({ scenario: s.id, judge: j })),
  );
  lines.push('## 人工复核清单', '');
  if (splits.length === 0) {
    lines.push('本次无 SPLIT，无需人工复核。', '');
  } else {
    lines.push(`共 ${splits.length} 条 SPLIT（两票不一致，或判官本身失败）。SPLIT 不计通过也不计失败。`, '');
    for (const { scenario, judge } of splits) {
      const ruling = findRuling(scenario, judge.itemId);
      lines.push(`- **${scenario}**｜${judge.item.replace(/\|/g, '\\|')}`);
      lines.push(`  - 两票：${judge.votes.join(' + ')}；理由：${judge.reasons.filter(Boolean).join(' / ') || '（无）'}`);
      lines.push(
        ruling
          ? `  - **已人工复核：${ruling.verdict}**（${ruling.by}，${ruling.date}）——${ruling.reason}`
          : '  - ⚠️ **待复核**：尚无人裁定',
      );
    }
    lines.push('');
  }

  // ═══ 交叉校验（恒产出 · manager 2026-08-28 裁定③）═══
  // 判据里早写着两对交叉校验，其中一对的注释原文是「两边对不上就有一边要查」——
  // 而它**从写下那天起一直在报警，没人看**（实测 18/23 对不上）。
  // **存在但无人读的检查等于不存在。** 所以这一格永远在纸上，哪怕本批一对都不涉及。
  const cc = summarizeCrossChecks(run.scenarios);
  lines.push('## 交叉校验（两手段各验一半，对不上就有一边要查）', '');
  if (cc.outcomes.length === 0) {
    lines.push('本批剧本不涉及任何已登记的交叉校验对。', '');
  } else {
    lines.push(`**本批对不上 ${cc.disagreed}/${cc.compared}**（单批样本量小，率无意义；阈值判读挂在语料累计上，见成绩单）`, '');
    for (const o of cc.outcomes) {
      const base = o.pair.baseline
        ? `已手签基线 ${o.pair.baseline.rate}%（${o.pair.baseline.signedBy} ${o.pair.baseline.on}）`
        : '**无手签基线**';
      if (o.state.kind === 'unwired') {
        lines.push(
          `- ⚠️ **${o.pair.id}｜${o.state.side === 'mechanical' ? '机械侧不在场' : '判官侧不在场'}** — ` +
            `**这一批没有交叉校验，是单边执法**（不是"没问题"）。${base}`,
        );
      } else if (o.state.kind === 'disagree') {
        lines.push(`- ❌ **${o.pair.id}｜对不上** judge=${o.judgeVerdict} / 机械=${o.mechanicalVerdict}。${o.pair.what}。${base}`);
      } else {
        lines.push(`- ✅ ${o.pair.id}｜一致（judge=${o.judgeVerdict} / 机械=${o.mechanicalVerdict}）。${base}`);
      }
    }
    lines.push('');
  }

  for (const s of run.scenarios) {
    lines.push(`## ${s.id} ${s.title}${s.redline ? ' · 红线' : ''} — ${verdictMark(s.pass)}`, '');
    if (s.error) {
      lines.push(`> 运行失败：${s.error}`, '');
      continue;
    }

    if (s.gateHits && (s.gateHits.citation > 0 || s.gateHits.leverage > 0)) {
      lines.push(
        '### 安全闸门触发（质量指标，不计 FAIL）',
        '',
        `- 案号闸门拦下 **${s.gateHits.citation}** 次｜情感杠杆闸拦下 **${s.gateHits.leverage}** 次`,
        '',
        '> 「模型想编但被拦住」与「模型没想编」是两回事，这个信号要看得见：',
        '> 触发次数上升说明模型的编造倾向在变强，即便用户面仍然零编造。',
        '> 红线口径只看**用户面**——闸门拦住了就不算失守。',
        '',
      );
    }
    lines.push('### 机械断言', '');
    lines.push('| 层 | 结果 | 断言 | 说明 |', '|---|---|---|---|');
    // 按层排序：L1 在最上面。看成绩单的人第一眼该看到的是安全红线的状态
    const byTier = [...s.mechanical].sort((a, b) => (a.tier ?? 'L2').localeCompare(b.tier ?? 'L2'));
    for (const v of byTier) lines.push(`| ${v.tier ?? 'L2'} | ${assertionMark(v)} | ${v.id} | ${v.detail.replace(/\|/g, '\\|')} |`);
    lines.push('');

    if (s.semantic.length) {
      lines.push('### 语义断言（judge 两票详情）', '');
      lines.push('| 层 | 结论 | 两票 | 条目 | 理由 |', '|---|---|---|---|---|');
      for (const j of s.semantic) {
        const ruled = j.verdict === 'SPLIT' ? findRuling(s.id, j.itemId) : undefined;
        const mark =
          j.verdict === 'PASS'
            ? '✅ PASS'
            : j.verdict === 'FAIL'
              ? '❌ FAIL'
              : ruled
                ? `⚠️ SPLIT（已人工复核：${ruled.verdict}）`
                : '⚠️ SPLIT（待复核）';
        const reasons = j.reasons.filter(Boolean).join(' / ').replace(/\|/g, '\\|');
        lines.push(`| ${j.tier} | ${mark} | ${j.votes.join(' + ')} | ${j.item.replace(/\|/g, '\\|')} | ${reasons} |`);
      }
      lines.push('');
    }

    lines.push('### 对话原文', '');
    for (const [i, t] of s.turns.entries()) {
      lines.push(`**第 ${i + 1} 轮 · 用户**`, '', '> ' + t.input.replace(/\n/g, '\n> '), '');
      lines.push(`**第 ${i + 1} 轮 · agent**`, '', '```', t.text, '```', '');
      if (t.actionCards.length) {
        lines.push('行动卡：', '');
        for (const c of t.actionCards) lines.push(`- **${c.title}**（截止 ${c.due_at ?? '未给'}）`);
        lines.push('');
      }
      lines.push(
        `模型：${t.model}（${t.taskClass}${t.degraded ? '，**已降级**' : '，未降级'}）｜检索到的依据：${t.retrievedIds.join('、') || '（无）'}` +
          (t.gateStrippedArticles.length ? `｜**第五闸剥除**：${t.gateStrippedArticles.join('、')}` : ''),
        '',
      );
    }
  }

  return lines.join('\n');
}

/** 落盘，返回两份产物的绝对路径 */
export function writeEvidence(run: RunEvidence): { json: string; md: string } {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const json = path.join(RESULTS_DIR, `${run.runId}.json`);
  const md = path.join(RESULTS_DIR, `${run.runId}.md`);
  writeFileSync(json, JSON.stringify(run, null, 2), 'utf8');
  writeFileSync(md, renderMarkdown(run), 'utf8');
  return { json, md };
}
