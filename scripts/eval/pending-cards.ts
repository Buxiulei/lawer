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

import { UNSTRUCTURED_DISPATCH_NOTE, type Verdict } from './assertions';

/** 连续多少批仍未补卡就升级告警 */
export const PENDING_ESCALATE_BATCHES = 3;

export interface PendingCardState {
  /** 条号 → 连续出现在清单里的批次数 */
  streak: Record<string, number>;
  /** 最近一次写入的批次 id，用于避免同一批重复累加 */
  lastRunId?: string;
}

/**
 * 清单**机检预分拣**（agent2 供，manager 转批）：按「该部法律在不在库」分两栏。
 *
 *  - `missing_card`「疑似真缺卡」：该法在库（别的卡引过它），只是这一条没有 statute_quotes；
 *  - `out_of_domain`「疑似引用不当」：**该法整部不在库** —— 模型开始往域外引，
 *    比缺卡严重得多，优先人核。
 *
 * **分栏本身是信号**：第二栏变长意味着引用在离开我们的知识域，
 * 而这类问题补卡是补不完的——该查的是模型为什么引到域外去。
 * 预分拣只排序省时，**不替代人核**：两栏都仍需外勤逐条核。
 */
export type PendingKind = 'missing_card' | 'out_of_domain' | 'law_unbound';

export interface PendingCardItem {
  article: string;
  law?: string;
  kind: PendingKind;
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
): Map<string, { scenarios: Set<string>; hits: number; excerpts: string[]; law?: string }> {
  const out = new Map<string, { scenarios: Set<string>; hits: number; excerpts: string[]; law?: string }>();
  for (const { scenarioId, verdict, excerpt } of verdicts) {
    if (verdict.naKind !== 'pending_card' || !verdict.pendingArticle) continue;
    const cur = out.get(verdict.pendingArticle) ?? { scenarios: new Set<string>(), hits: 0, excerpts: [] };
    cur.scenarios.add(scenarioId);
    cur.hits += 1;
    if (verdict.pendingLaw) cur.law = verdict.pendingLaw;
    if (excerpt && cur.excerpts.length < 3) cur.excerpts.push(excerpt);
    out.set(verdict.pendingArticle, cur);
  }
  return out;
}

/**
 * 机检预分拣：该法在库=疑似真缺卡；整部不在库=疑似引用不当；取不到法名=法名待定。
 *
 * 【`law_unbound` 与判据的同名是有意的（缺陷⑨）】判据侧「法名待定」态与本栏**同一个名字**，
 * 因为它们是**同一个堆**：一件事两个标签，读的人就要在脑子里维护一张对照表，
 * 而对照表迟早会有一边先改。判据落 `law_unbound` 的条目根本不会流到 pending_card，
 * 本栏因此退化成安全网——真空了是对的，不空说明有路径绕过了判据侧那道分流。
 */
export function classifyPending(law: string | undefined, libraryLaws: Set<string>): PendingKind {
  if (!law) return 'law_unbound';
  return libraryLaws.has(law.replace(/[《》\s]/g, '')) ? 'missing_card' : 'out_of_domain';
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
  libraryLaws: Set<string> = new Set(),
): { items: PendingCardItem[]; escalated: string[]; byKind: Record<PendingKind, number> } {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const stateFile = path.join(dir, 'pending-cards-state.json');
  const state = updateStreaks(loadState(stateFile), [...collected.keys()], runId);
  writeFileSync(stateFile, JSON.stringify(state, null, 2));

  const items: PendingCardItem[] = [...collected.entries()]
    .map(([article, v]) => ({
      article,
      ...(v.law ? { law: v.law } : {}),
      kind: classifyPending(v.law, libraryLaws),
      scenarios: [...v.scenarios].sort(),
      hits: v.hits,
      excerpts: v.excerpts,
      streak: state.streak[article] ?? 1,
    }))
    .sort((a, b) => b.streak - a.streak || b.hits - a.hits);

  const escalated = items.filter((i) => i.streak >= PENDING_ESCALATE_BATCHES).map((i) => i.article);

  const byKind: Record<PendingKind, number> = { missing_card: 0, out_of_domain: 0, law_unbound: 0 };
  for (const i of items) byKind[i.kind] += 1;
  const KIND_LABEL: Record<PendingKind, string> = {
    missing_card: '疑似真缺卡（该法在库、此条无原文）',
    out_of_domain: '⚠️ 疑似引用不当（**该法整部不在库**）',
    law_unbound: '法名待定（引用处取不到法名，且按条号回绑零命中）',
  };
  const table = (kind: PendingKind) => {
    const rows = items.filter((i) => i.kind === kind);
    if (rows.length === 0) return [];
    return [
      `### ${KIND_LABEL[kind]}　共 ${rows.length} 条`,
      '',
      '| 条文 | 所属法律 | 连续批次 | 出现次数 | 场次 | 人核结论（外勤填） | 引用原文摘录 |',
      '|---|---|---|---|---|---|---|',
      ...rows.map(
        (i) =>
          `| ${i.article} | ${i.law ?? '（未知）'} | ${i.streak}${i.streak >= PENDING_ESCALATE_BATCHES ? ' ⚠️' : ''} | ${i.hits} | ${i.scenarios.join(' ')} | | ${i.excerpts
            .map((e) => e.replace(/\|/g, '\\|').slice(0, 60))
            .join(' / ')} |`,
      ),
      '',
    ];
  };
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
    `> **乙态（有原文未结构化）派 WS4 时**：${UNSTRUCTURED_DISPATCH_NOTE}。`,
    '> 理由：节选闸认的是卡自己的标记，**没标注的节选闸会漏**——这是闸之外的人工兜底。',
    '',
    '> 下面两栏是**机检预分拣**，只为排序省时，**不替代人核**——两栏都要逐条核。',
    '> **分栏本身是信号**：第二栏变长意味着模型开始往域外引，比缺卡严重得多，',
    '> 这类问题补卡是补不完的，该查的是模型为什么引到域外去。',
    '',
    `> 连续 ${PENDING_ESCALATE_BATCHES} 批仍未处理的条文会升级告警——**长期红灯会训练所有人无视红灯**，`,
    '> 一份越来越长、谁也不看的清单比没有清单更糟。',
    '',
    ...table('out_of_domain'),
    ...table('missing_card'),
    ...table('law_unbound'),
    items.length === 0 ? '（本批无待补卡条文——全线有源）' : '',
  ];
  writeFileSync(path.join(dir, `pending-cards-${runId}.md`), lines.join('\n'));
  return { items, escalated, byKind };
}
