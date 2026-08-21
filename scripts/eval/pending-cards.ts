// scripts/eval/pending-cards.ts
// 补卡需求清单：把「判据想判、知识库还没依据」的条文汇成一份可交外勤的单子，并跨批追踪。
//
// 【为什么要有这个文件】G4 光秃条号断言改成三分支之后，缺卡的条文不再判 FAIL 而是判
// N/A(pending_card)。这一改让判据**从"打分器"升级成"缺口发现器"**——它开始回答
// 「我们的知识库缺哪一块」。但**缺口发现器只有配上闭环才成立**：不汇总、不追踪，
// N/A 就会安静地沉在成绩单角落，缺卡永远补不上，而判定永远"延迟"。
//
// 【连续 3 批未补要升级告警】manager 点名：**长期红灯会训练所有人无视红灯**。
// 一份越来越长、谁也不看的清单，比没有清单更糟——它会让人产生"我们已经在管这件事"的错觉。
// 所以同一条文连续 3 批仍在清单里，成绩单要升级告警，把它从"待办"顶成"问题"。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { Verdict } from './assertions';

/** 连续多少批仍未补卡就升级告警 */
export const PENDING_ESCALATE_BATCHES = 3;

export interface PendingCardState {
  /** 条号 → 连续出现在清单里的批次数 */
  streak: Record<string, number>;
  /** 最近一次写入的批次 id，用于避免同一批重复累加 */
  lastRunId?: string;
}

export interface PendingCardItem {
  article: string;
  /** 出现场次（剧本 id 去重） */
  scenarios: string[];
  /** 出现次数（逐轮计） */
  hits: number;
  /** 引用原文摘录，供外勤核「该补卡」还是「引用不当」 */
  excerpts: string[];
  /** 连续第几批仍未补 */
  streak: number;
}

/** 从本批全部判定里汇出待补卡条文 */
export function collectPending(
  verdicts: { scenarioId: string; verdict: Verdict; excerpt?: string }[],
): Map<string, { scenarios: Set<string>; hits: number; excerpts: string[] }> {
  const out = new Map<string, { scenarios: Set<string>; hits: number; excerpts: string[] }>();
  for (const { scenarioId, verdict, excerpt } of verdicts) {
    if (verdict.naKind !== 'pending_card' || !verdict.pendingArticle) continue;
    const cur = out.get(verdict.pendingArticle) ?? { scenarios: new Set<string>(), hits: 0, excerpts: [] };
    cur.scenarios.add(scenarioId);
    cur.hits += 1;
    if (excerpt && cur.excerpts.length < 3) cur.excerpts.push(excerpt);
    out.set(verdict.pendingArticle, cur);
  }
  return out;
}

function loadState(file: string): PendingCardState {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as PendingCardState;
  } catch {
    return { streak: {} };
  }
}

/**
 * 更新跨批计数：本批仍在清单里的 +1，本批已消失的（补卡到位）清零。
 * 清零很重要——补上了却还在涨的计数会把已解决的问题一直顶在告警里。
 */
export function updateStreaks(state: PendingCardState, articles: string[], runId: string): PendingCardState {
  if (state.lastRunId === runId) return state; // 同一批重复调用不重复累加
  const next: Record<string, number> = {};
  for (const a of articles) next[a] = (state.streak[a] ?? 0) + 1;
  return { streak: next, lastRunId: runId };
}

/** 写出清单文件；返回需要升级告警的条文 */
export function writePendingCardList(
  dir: string,
  runId: string,
  collected: ReturnType<typeof collectPending>,
): { items: PendingCardItem[]; escalated: string[] } {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const stateFile = path.join(dir, 'pending-cards-state.json');
  const state = updateStreaks(loadState(stateFile), [...collected.keys()], runId);
  writeFileSync(stateFile, JSON.stringify(state, null, 2));

  const items: PendingCardItem[] = [...collected.entries()]
    .map(([article, v]) => ({
      article,
      scenarios: [...v.scenarios].sort(),
      hits: v.hits,
      excerpts: v.excerpts,
      streak: state.streak[article] ?? 1,
    }))
    .sort((a, b) => b.streak - a.streak || b.hits - a.hits);

  const escalated = items.filter((i) => i.streak >= PENDING_ESCALATE_BATCHES).map((i) => i.article);

  const lines = [
    `# 补卡需求清单（${runId}）`,
    '',
    '本清单由评测自动汇出：这些条文**被引用了，但知识库里没有逐字原文**，',
    '因此 G4 光秃条号判定对它们**延迟**（N/A，不计过不计挂），补卡落地即自动转回 FAIL 判定。',
    '',
    '> **每条须外勤人工核**，结论写回本文件留痕，不接受口头答复：',
    '> - 判「**该补卡**」→ 进补卡单，补齐 `facts.statute_quotes`；',
    '> - 判「**引用不当**」→ 该条不该在这个场景被引，转回 FAIL 类训练样本。',
    '',
    `> 连续 ${PENDING_ESCALATE_BATCHES} 批仍未处理的条文会升级告警——**长期红灯会训练所有人无视红灯**，`,
    '> 一份越来越长、谁也不看的清单比没有清单更糟。',
    '',
    '| 条文 | 连续批次 | 出现次数 | 场次 | 人核结论（外勤填） | 引用原文摘录 |',
    '|---|---|---|---|---|---|',
    ...items.map(
      (i) =>
        `| ${i.article} | ${i.streak}${i.streak >= PENDING_ESCALATE_BATCHES ? ' ⚠️' : ''} | ${i.hits} | ${i.scenarios.join(' ')} | | ${i.excerpts
          .map((e) => e.replace(/\|/g, '\\|').slice(0, 60))
          .join(' / ')} |`,
    ),
    '',
    items.length === 0 ? '（本批无待补卡条文——全线有源）' : '',
  ];
  writeFileSync(path.join(dir, `pending-cards-${runId}.md`), lines.join('\n'));
  return { items, escalated };
}
