// app/src/lib/paste/opener.ts
// 「陪跑开场白」：无工具模式下用户复制给自己聊天客户端的第一条消息（设计稿 §15 路径 D ①）。
//
// 组成（顺序即重要度，裁剪从后往前）：
//   P0 指南     —— 精简陪跑指南（guide.ts）
//   P0 回填约定 —— 结构块协议（protocol.ts）
//   P1 事实卡   —— 与站内每轮同一渲染函数（lib/agent/case-facts）
//   P2 个案报告 —— 尚未上线，退回「以上面那张事实卡为准」的说明（见下）
//   P3 证据简报 —— 每件证据的简报摘要
//
// 【为什么 P0 两段在预算之外】三档预算（30k / 12k / 5k 字）是按客户端上下文窗口定的，
// 裁剪必须从**最不致命**的那头开始。裁掉简报，助手少知道几件材料能证明什么；
// 裁掉指南，助手会凭记忆写条号、会替用户把文书发出去、会在危机轮继续讲流程——
// 而它答得依然流畅，用户看不出任何异常。所以指南与回填约定先摆上，剩下的预算才拿去分。
// 判据：opener.test.ts；变异臂把指南挪进可裁分区 ⇒ 红。
//
// 【为什么裁剪要留痕】被裁掉的东西必须让模型知道「有但没给你」，否则它当成「不存在」，
// 然后据此断言「你没有别的证据」。同 case-facts.ts 的同一条纪律。
import type { Identity } from '@/lib/auth/identity';
import { getCapability } from '@/lib/capabilities';
import * as cases from '@/lib/cases';
import type { DomainFailure } from '@/lib/cases';
import { getDomainPack } from '@/lib/domains/registry';
import { BRIEF_SUMMARY_MAX, briefSummary, parseBrief } from '@/lib/evidence/brief';
import type { Database } from 'better-sqlite3';

import { NO_TOOL_GUIDE } from './guide';
import { buildProtocolSection } from './protocol';

/**
 * 三档字数预算（字符数，含标点与换行）。
 *
 * 依据 rd-mcp-design/agent-clients.md 的查证：这几家网页版都不公布确切的单条输入上限，
 * 实测能吃下的量差一个数量级。所以这里给的是**保守可用**的三档，由用户按客户端选，
 * 而不是替他猜某一家今天的上限。设置页给的默认值见 clients.ts。
 */
export const OPENER_TIERS = {
  long: 30_000,
  medium: 12_000,
  short: 5_000,
} as const;

export type OpenerTier = keyof typeof OPENER_TIERS;

export function isOpenerTier(v: unknown): v is OpenerTier {
  return typeof v === 'string' && v in OPENER_TIERS;
}

/** 分区之间的空行分隔 */
const SEP = '\n\n';

/** 一个分区少于这么多字就别放了——半张事实卡比没有更误导 */
const MIN_ROOM = 200;

/** 简报摘要单条长度：档位越宽给得越细 */
const BRIEF_LEN: Record<OpenerTier, number> = { long: 240, medium: 120, short: BRIEF_SUMMARY_MAX };

/** 事实卡自带标题（case-facts 的 HEADER），这里只在整段没放下时用它点名 */
const FACTS_HEADING = '## 案件事实卡';
const REPORT_HEADING = '## 个案报告';
const BRIEF_HEADING = '## 证据简报摘要';

export interface OpenerResult {
  ok: true;
  tier: OpenerTier;
  budget: number;
  text: string;
  /** 因预算没放进去的分区标题，供网页提示用户换一档 */
  omitted: string[];
}

/**
 * 按行截到 room 字符以内，并留痕。
 *
 * 【为什么按行切而不是按字符硬切】硬切会在句子中间断开，模型把半句话当整句用；
 * 按行切最坏也只是少一条完整的条目，而少了多少写在留痕里。
 */
function fitToRoom(body: string, room: number, whatWasCut: string): string | null {
  if (body.length <= room) return body;
  const note = `\n（此处按篇幅截断，${whatWasCut}未附；需要时直接问用户，不要当成不存在。）`;
  const keep = room - note.length;
  if (keep < MIN_ROOM) return null;
  const lines = body.split('\n');
  const out: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length + 1 > keep) break;
    out.push(line);
    used += line.length + 1;
  }
  if (out.length === 0) return null;
  return out.join('\n') + note;
}

/** 证据简报摘要段。没有任何简报时回 null（空段位不占预算）。 */
function briefSection(
  evidence: { name: string; category: string; brief_json: string | null }[],
  perItem: number,
): string | null {
  const lines: string[] = [];
  for (const e of evidence) {
    const brief = parseBrief(e.brief_json);
    if (!brief) continue;
    lines.push(`- 《${e.name}》（${e.category}）：${briefSummary(brief, perItem)}`);
  }
  if (lines.length === 0) return null;
  return [
    BRIEF_HEADING,
    '',
    '这几件材料的内容服务端读过了，下面是每件能证明什么。**要引用材料里的具体原话**',
    '（条款、金额、录音原话）之前，先让用户回网页把原文取出来核对——简报是结论，不是原文。',
    '',
    ...lines,
  ].join('\n');
}

/**
 * 个案报告段。
 *
 * 【它现在是一句说明，不是一份报告】个案报告（每案一份的结构化长期记忆，设计稿 §4.3）
 * 还没上线。这里**不拿事实卡再渲染一遍充数**：那样开场白里会有两份内容相同、
 * 措辞略有出入的「当前状况」，而模型会把它们当成两个信息源去调和。
 * 报告落地后把这一段换成真报告即可，位置与优先级不变。
 */
function reportSection(): string {
  return [
    REPORT_HEADING,
    '',
    '这个案子还没有个案报告（长期记忆那一份），所以**上面那张事实卡就是全部档案**：',
    '时间线、行动卡、诉求、期限、证据五张表的当前状态都汇总在里面。',
    '别去回忆更早的对话——这类客户端记不住，你手上只有这一份。',
  ].join('\n');
}

/**
 * 生成开场白。归属校验走 lib/cases（非本人案件一律 CASE_NOT_FOUND，不区分不存在与不是你的）。
 */
export function buildOpener(
  db: Database,
  input: { caseId: number; identity: Identity; tier: OpenerTier },
): OpenerResult | DomainFailure {
  const owned = cases.getCase(db, {
    caseId: input.caseId,
    userId: input.identity.uid,
    timelineLimit: 1,
  });
  if (!owned.ok) return owned;

  const pack = getDomainPack(owned.case.domain);
  if (!pack) {
    return {
      ok: false,
      status: 500,
      errorCode: 'UNKNOWN_DOMAIN',
      message: `这个案件的领域是「${owned.case.domain}」，但没有对应的领域包，生成不了开场白。`,
    };
  }

  const budget = OPENER_TIERS[input.tier];

  // 事实卡走 case_facts 能力，不在这里自己渲染一遍：那一层已经把归属校验、取快照、
  // 预算裁剪串好了，而全站**只允许两处出口**调 renderCaseFacts（case-facts.test 的 G-F0
  // 逐文件点名）。自己再渲一份的形态是：同一个案子在网页、在 MCP、在这条路上
  // 各有一份「当前事实」，三份都长得很正常。
  const factsCap = getCapability('case_facts');
  const factsRes = factsCap ? (factsCap.run(db, input.identity, { case_id: input.caseId }) as
    | { case_facts: string }
    | DomainFailure) : undefined;
  if (factsRes && 'ok' in factsRes && factsRes.ok === false) return factsRes;
  const facts = factsRes && 'case_facts' in factsRes ? factsRes.case_facts : null;

  const evidence = cases.listEvidence(db, { caseId: input.caseId, userId: input.identity.uid });

  const head = [
    '# 陪跑开场白（土八鼠）',
    '',
    '把这一整段作为**新对话的第一条消息**发给你的助手，然后再说你的事。',
  ].join('\n');

  // P0：先占位，剩下的才是可分预算
  const fixed = [head, NO_TOOL_GUIDE, buildProtocolSection({ pack, timelineKinds: cases.TIMELINE_KINDS })];
  const blocks = [...fixed];
  let used = fixed.reduce((n, b) => n + b.length + SEP.length, 0);
  const omitted: string[] = [];

  // P1 → P3：按重要度顺序填，填不下的整段换成一行留痕
  const optional: { heading: string; body: string | null; cut: string }[] = [
    { heading: FACTS_HEADING, body: facts, cut: '事实卡尾部的部分内容' },
    { heading: REPORT_HEADING, body: reportSection(), cut: '' },
    {
      heading: BRIEF_HEADING,
      body: evidence.ok ? briefSection(evidence.evidence, BRIEF_LEN[input.tier]) : null,
      cut: '其余证据的简报',
    },
  ];

  for (const sec of optional) {
    if (sec.body === null) continue;
    // 每段的标题都在 body 里（事实卡用的是 renderCaseFacts 自带的那一行）
    const fitted = fitToRoom(sec.body, budget - used - SEP.length, sec.cut);
    if (fitted === null) {
      const note = `${sec.heading}\n\n（这一段因为篇幅没有附上。想看的话，回网页换一档更长的开场白重新复制。）`;
      if (note.length + SEP.length <= budget - used) {
        blocks.push(note);
        used += note.length + SEP.length;
      }
      omitted.push(sec.heading);
      continue;
    }
    blocks.push(fitted);
    used += fitted.length + SEP.length;
  }

  return { ok: true, tier: input.tier, budget, text: blocks.join(SEP), omitted };
}
