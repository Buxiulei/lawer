// scripts/replay-render-fallback.ts
// 核心位保底渲染的**产物回放**。用法：
//   cd app && npx tsx ../scripts/replay-render-fallback.ts                       # 人读摘要
//   cd app && npx tsx ../scripts/replay-render-fallback.ts --json > before.json  # 机读指纹
//   （改完代码再跑一次 > after.json，diff 两份即得逐轮产物差异）
//   结果目录默认取仓库内 scripts/eval/results，可用 RESULTS_DIRS=/a:/b 覆盖（冒号分隔）。
//
// 【为什么要这个东西，2026-08-25 manager 点名的区分】
// 改 `bareArticleSpans` / `citationSite` 时，回放**判据的判定结果**是不够的——
// `renderCoreArticleFallback` 直接消费它们，**判定变了 → 补进正文的原文集合变了 → 用户看到的东西变了**。
// 判定回放与产物回放是两件事；而产物回放与**重跑模型**又是两件事：
// 渲染在 buildSystemPrompt 之后执行，模型输入逐字节不变，所以产物回放**不需要重跑模型**，
// 但也**替代不了**重跑（前者验确定性产物，后者验随机性行为）。
//
// 【判别力自证（A9）】本脚本先打三个命中量：有注入包的轮 / 手上真有逐字原文的轮 / 渲染真开火的轮。
// 这三个数任一为 0 时，"零差异"就是两个空集互比，不构成证据——脚本会显式告警。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { articleKey, bareArticleSpans, renderCoreArticleFallback } from '../app/src/lib/agent/citation-block';
import * as knowledge from '../app/src/lib/knowledge';
import type { KnowledgePack } from '../app/src/lib/agent/retrieval';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIRS = (process.env.RESULTS_DIRS ?? path.join(HERE, 'eval', 'results')).split(':').filter(Boolean);
const AS_JSON = process.argv.includes('--json');
const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);

interface Turn { file: string; scenario: string; index: number; text: string; ids: string[] }

const turns: Turn[] = [];
let badFiles = 0;
let scanned = 0;
for (const dir of DIRS) {
  if (!fs.existsSync(dir)) {
    console.error(`[回放] 结果目录不存在，跳过：${dir}`);
    continue;
  }
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.json'))) {
    scanned += 1;
    try {
      const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
      for (const sc of d.scenarios ?? []) {
        (sc.turns ?? []).forEach((t: { text?: string; retrievedIds?: string[] }, i: number) => {
          if (typeof t?.text === 'string' && t.text.trim()) {
            turns.push({ file: f, scenario: sc.id, index: i + 1, text: t.text, ids: t.retrievedIds ?? [] });
          }
        });
      }
    } catch (e) {
      // 逐文件独立 try：一个文件读不了不许变成"干净的零"（A21）
      badFiles += 1;
      console.error(`[回放] 读不了 ${f}：${(e as Error).message}`);
    }
  }
}

const cache = new Map<string, KnowledgePack | null>();
function getPack(id: string): KnowledgePack | null {
  if (!cache.has(id)) {
    try {
      const h = knowledge.get(id);
      cache.set(id, {
        id: h.id, type: h.type, title: h.title, keywords: h.keywords, applies_to: h.applies_to,
        region: h.region, confidence: h.confidence, updated: h.updated, body: h.content, facts: h.facts,
      } as KnowledgePack);
    } catch {
      cache.set(id, null); // 卡不存在是正常未命中，不是故障
    }
  }
  return cache.get(id)!;
}

interface Fingerprint {
  scenario: string;
  index: number;
  file: string;
  /** 实际补进正文的条（renderCoreArticleFallback 的 added） */
  added: string[];
  /** 渲染后正文指纹 */
  textSha: string;
  /**
   * **候选集合**：核心位光秃 ∧ 该条逐字原文在本轮包里。
   * 它才是判定变化的落点——归档正文已是渲染产物，`added` 会被「全文已有该原文就不重复补」
   * 压成空，只看 added 会低估差异（这正是"零差异"最容易骗人的地方）。
   */
  candidates: string[];
}

let withPacks = 0;
let withStatute = 0;
let fired = 0;
let withCandidates = 0;
const out: Fingerprint[] = [];

for (const t of turns) {
  const packs: KnowledgePack[] = [];
  for (const id of t.ids) {
    const p = getPack(id);
    if (p) packs.push(p);
  }
  if (packs.length) withPacks += 1;
  const avail = new Set<string>();
  for (const p of packs) {
    for (const q of p.facts?.statute_quotes ?? []) {
      if (q?.law && q?.article && q?.text?.trim()) avail.add(articleKey(q.law, q.article));
    }
  }
  if (avail.size) withStatute += 1;

  const candidates = [
    ...new Set(
      bareArticleSpans(t.text)
        .filter((s) => s.site === '核心位')
        .map((s) => [...avail].find((k) => k === articleKey(null, s.raw.replace(/《[^》]{2,40}》/, '')) || k.endsWith(`|${s.article}`)))
        .filter((x): x is string => !!x),
    ),
  ].sort();
  if (candidates.length) withCandidates += 1;

  // core 传空集：它只在候选超过一轮上限时影响**优先序**，不影响哪些候选合格。
  const r = renderCoreArticleFallback(t.text, new Set<string>(), packs);
  if (r.added.length) fired += 1;
  out.push({ scenario: t.scenario, index: t.index, file: t.file, added: [...r.added].sort(), textSha: sha(r.text), candidates });
}

const summary = {
  结果文件: scanned, 读失败: badFiles, 轮数: turns.length,
  有注入包的轮: withPacks, 手上有逐字原文的轮: withStatute,
  渲染真开火的轮: fired, 候选非空的轮: withCandidates,
};
if (AS_JSON) {
  console.log(JSON.stringify({ summary, turns: out }, null, 2));
} else {
  console.log('[回放] ' + Object.entries(summary).map(([k, v]) => `${k}=${v}`).join('｜'));
  if (turns.length === 0) console.error('[回放] ⚠️ 样本命中量为 0：先查结果目录路径，别拿空集出结论');
  else if (withStatute === 0 || fired === 0) {
    console.error('[回放] ⚠️ 没有一轮手上有逐字原文（或没有一轮开火）——此时任何"零差异"都是空集互比，不构成证据');
  }
  const byScenario = new Map<string, number>();
  for (const r of out) if (r.added.length) byScenario.set(r.scenario, (byScenario.get(r.scenario) ?? 0) + 1);
  console.log('[回放] 开火轮按剧本：' + ([...byScenario].sort().map(([s, n]) => `${s}:${n}`).join(' ') || '无'));
}
