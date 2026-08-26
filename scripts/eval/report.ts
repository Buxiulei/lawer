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

import type { Verdict } from './assertions';
import type { JudgeResult } from './judge';
import { findRuling } from './human-review';

export const RESULTS_DIR = path.resolve(import.meta.dirname, 'results');

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
      const ruling = findRuling(scenario, judge.item);
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
        const ruled = j.verdict === 'SPLIT' ? findRuling(s.id, j.item) : undefined;
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
