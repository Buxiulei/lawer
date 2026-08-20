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
  turns: {
    input: string;
    text: string;
    actionCards: { title: string; detail: string; due_at: string | null }[];
    retrievedIds: string[];
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

function renderMarkdown(run: RunEvidence): string {
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

    lines.push('### 机械断言', '');
    lines.push('| 结果 | 断言 | 说明 |', '|---|---|---|');
    for (const v of s.mechanical) lines.push(`| ${verdictMark(v.pass)} | ${v.id} | ${v.detail.replace(/\|/g, '\\|')} |`);
    lines.push('');

    if (s.semantic.length) {
      lines.push('### 语义断言（judge 两票详情）', '');
      lines.push('| 结论 | 两票 | 条目 | 理由 |', '|---|---|---|---|');
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
        lines.push(`| ${mark} | ${j.votes.join(' + ')} | ${j.item.replace(/\|/g, '\\|')} | ${reasons} |`);
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
        `模型：${t.model}（${t.taskClass}${t.degraded ? '，**已降级**' : '，未降级'}）｜检索到的依据：${t.retrievedIds.join('、') || '（无）'}`,
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
