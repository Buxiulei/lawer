// app/src/lib/agent/case-facts.ts
// 案件事实卡：把 CaseSnapshot 渲染成每轮 system prompt 里的那一段「我手上有什么」。
//
// 【它替掉了什么】原来的 prompt.caseDigest 只渲染案件抬头/公司/时间线/诉求/行动卡/期限六项，
// 用户是谁、有哪些证据、首诊四项、历史看得全不全，一概不在里面。模型看不见「没有」，
// 就会假设「有」——真机事故：文书里写「【你的姓名】（已使用档案中的真实姓名）」，
// 一个空占位符被包装成"已完成"。所以本文件的两条铁律是：
//
//   ① **零编造**：每一个数字、名称都来自 snapshot 的同值字段。缺就写「未记录」，
//      绝不用默认值（0 元 / "用户" / 空占位符）替代——默认值一旦进 prompt 就成了事实。
//   ② **缺失显式化**：「档案里没有」必须写出来，而且要写成「档案里没有」而不是「没有」。
//      证据分类里 0 件的类别照列——"合同 0 条"正是模型最需要知道、也最容易自己脑补的那条。
//
// 【为什么是纯函数、不碰 DB】取数一律留在 snapshot.ts（现有约定：状态机与 prompt 都只吃
// snapshot）。本文件出现任何 SQL 都意味着「同一段事实有两个取数口径」，两边迟早不一致。
// 这条有判据钉着（case-facts.test.ts G-F0 直接读本文件源码，出现 SQL 驱动名或预编译语句即红）。
//
// 【预算】渲染结果硬上限 CASE_FACTS_BUDGET 字符，由 renderCaseFacts 后置保证：
// 先区内裁（条数上限 + 单条截断），再按 P3→P2→P1 把整区压成统计行，P0 永不降级。
// 每一次裁剪都留痕——被裁掉的东西必须让模型知道「有但没给你」，否则它会当成「不存在」。
import { crisisStatusMark } from '@/lib/cases/crisis-hits';
import { isDocumented, noDocumentedFact, normalizeSourceTier, tierMark } from '@/lib/cases/source-tier';
import { basicsMissing } from '@/lib/cases/report';
import { BRIEF_SUMMARY_MAX, briefSummary, parseBrief } from '@/lib/evidence/brief';
import {
  buildElementSheet,
  ELEMENT_STATUSES,
  type ElementStatus,
} from '@/lib/cases/elements';
import { EVIDENCE_CATEGORIES } from '@/lib/evidence/categories';
import { precedentLine } from '@/lib/knowledge/precedent-line';
import {
  DEFAULT_DOMAIN,
  DOMAINS,
  domainPackOrDefault,
  type DomainPack,
  type FactsSectionKey,
} from '@/lib/domains/registry';
import { toDisplayDay, toDisplayTime } from '@/lib/time';

import type { CaseSnapshot } from './snapshot';

/** 事实卡渲染结果的字符硬上限。renderCaseFacts 的后置断言，不依赖数据形态。 */
export const CASE_FACTS_BUDGET = 4600;

/** 时间线分区软预算。manager 裁决：按「一个字都不能少」定 2400（uid=2 现状 2182 全进）。 */
const TIMELINE_BUDGET = 2400;
/** 证据明细分区软预算（免责句与分类计数不占，它们是统计行的一部分，永不被裁）。 */
const EVIDENCE_BUDGET = 900;

const GOAL_MAX = 400;
const TITLE_MAX = 60;
const ACTION_TITLE_MAX = 40;
const EVIDENCE_NAME_MAX = 30;
const EVIDENCE_PURPOSE_MAX = 45;
const TIMELINE_DETAIL_MAX = 120;
const ACTIONS_MAX = 8;
const CLAIMS_MAX = 10;
const DEADLINES_MAX = 6;
const COMPANIES_MAX = 5;
const EVIDENCE_ITEMS_MAX = 20;
/** 要件表最多列几行。四项诉求全开时现有卡片一共 17 行，留一点余量；超出照样留痕。 */
const ELEMENTS_MAX = 24;
/** 「需补」那一列的单行上限：它是给人照着做的一句话，不是清单全文。 */
const ELEMENT_NEED_MAX = 60;

/**
 * 证据区免责句，常驻、一字不改。
 *
 * 【为什么这句话改过一次】它原本写的是「我没有读过这些文件的内容（系统目前不做文件文本提取）」——
 * 那在内容提取接线之前是真的。接线之后照旧说这句，就会出现「提取都做完了、简报也写好了，
 * agent 还在说自己没读过」的**新版本的同一类事故**：免责声明本身过期了，而它看起来仍然很谨慎。
 *
 * 所以现在这句话按条分岔：**带简报的**条目，内容是真读过的，简报里的判断可以直接用；
 * **标「未提取」的**条目，手上仍然只有文件名与用户自述，一个字都不许从文件名推测。
 * 两种状态在下面逐条标出来，模型不必猜自己到底读过没有。
 */
export const EVIDENCE_DISCLAIMER =
  '- 每条后面的**「简报」是系统读过文件内容之后写下的结论**，可以直接用它判断这份材料能干什么；' +
  '但要在对外文书里引用文件中的具体原话（合同条款、流水金额、录音原话）之前，先用 evidence_get 读回原文逐字核对。' +
  '- 标着**「未提取」**的条目，我手上只有文件名、类别和用户自己填的证明目的，**没有读过内容**。' +
  '需要里面的信息时**必须先问用户，或先做内容提取**，不许根据文件名推测。';

/** 整区明细被预算压掉时的留痕。压掉的是明细，统计行仍在——模型必须知道「有但没给」。 */
const DETAIL_DROPPED = '- （明细因预算未注入——需要时直接问用户，不要假设不存在）';

/**
 * 事实卡**首行状态区**（设计稿 §4.3）：这一轮开口之前，先说清"手上这份东西还能不能直接用"。
 *
 * 【为什么必须是唯一一个函数】首行会陆续挂上好几种标记（报告过期、基本盘缺项、
 * R2 的近 72h 危机标记……）。每加一种就在渲染处多写一个三元的形态是：
 * 四处判断各有各的"什么时候不显示"，于是某种组合下整行消失，而每一处看起来都没错。
 * 追加标记一律往 `extra` 里塞，这里统一决定顺序与"全空就整行省略"。
 *
 * 【正常时省略整行，不写"一切正常"】常驻的"正常"提示会被当成模板噪音跳过去，
 * 于是真出状况那次也一起被跳过去了。没有这一行，就是没事。
 *
 * @returns 状态行；无话可说时 null（调用方据此整行不渲染）
 */
export function buildFactsStatusLine(input: {
  report: CaseSnapshot['report'];
  /** 基本盘缺几项（口径与个案报告的风险节同一份，见 lib/cases/report.basicsMissing） */
  basicsMissing: number;
  /** 预留给后续标记（R2 的危机标记等）；原样按序追加在后面 */
  extra?: readonly string[];
}): string | null {
  const parts: string[] = [];
  const r = input.report;
  if (r.state === 'changed') {
    parts.push(
      `报告过期：自 ${r.since} 起 ${r.changes} 条变动（${r.detail}）——先整理再回答`,
    );
  } else if (r.state === 'idle') {
    parts.push(`报告过期：${r.detail}（最后整理于 ${r.since}）——先整理再回答`);
  }
  if (input.basicsMissing > 0) parts.push(`基本盘缺 ${input.basicsMissing} 项`);
  for (const e of input.extra ?? []) if (e.trim()) parts.push(e.trim());
  return parts.length ? `> **状态**：${parts.join('；')}` : null;
}

const HEADER = [
  '## 案件事实卡（服务端从档案读出的当前事实，以此为准；用户说法与此矛盾时先核对再改档）',
  '',
  // 【这段说明从「三种标签」改成「四档 + 两种非档位标记」】旧版把"这一区大概都是自述"
  // 整段贴在区抬头上，是渲染时猜的；现在每条事实后面那一个〔〕是**从库里那一列读出来的**，
  // 所以说明也必须逐档写清楚——四档的分别（尤其"对方认可"改变举证负担）是这套东西的全部作用。
  '每条事实后面的〔〕是它的**来源档位**，由档案里的记录推出，不是措辞：' +
    '〔自述〕= 只有当事人自己的说法，没有第三方支撑，引用时要标出来；' +
    '〔书证#12〕= 有落库材料支撑，# 后面是那件材料的编号；' +
    '〔对方认可·timeline#8〕= 对方书面认过这件事（· 后面是出处），**这一档的事实不必再由用户举证**；' +
    '〔裁审认定〕= 办案机构已经认定过。',
  '另有两种不是档位的标记：〔已核验〕= 系统自己登记或推算的（不是当事人主张的事实）；' +
    '〔未记录〕= **档案里没有这一项，不是"事实上没有"**——需要就直接问用户，' +
    '不许拿它当"不存在"来推理，更不许自己补一个值。',
  '',
  // 【时间一律北京时间】不写这句的形态是：模型看到一串没有时区标记的时间，按它自己
  // 训练时的默认（多半是 UTC）去算"还剩几天"，跨日那一段整整错一天。
  // 与 REST / MCP 回包同源（都经 lib/time 的 +08:00 口径）。
  '本卡里的日期与时刻**一律是北京时间（UTC+08:00）**，与接口回包同一口径。',
].join('\n');

type Priority = 0 | 1 | 2 | 3;

export interface FactSection {
  /** 降级时点名用 */
  key: string;
  /** 0 = 永不降级 */
  priority: Priority;
  heading: string;
  /** 统计行（可多行）：整区降级后唯一幸存的部分，只放计数与常驻纪律，不放明细 */
  stat: string;
  /** 明细行：区内已按条数上限/单条上限裁过；仍超预算时整段被 DETAIL_DROPPED 顶掉 */
  detail: string[];
  /**
   * 「按剩余预算重裁」的能力。有它的分区**不整段丢**，只缩到 room 字符——
   * 时间线用它：整段丢会连最早 1 条起点锚点一起丢掉（裁决③要求永远保留），
   * 而且会白白空出两千多字预算（复审 MF-1：卡只剩 2300 字、2200 字预算空置）。
   */
  refit?: (room: number) => string[];
}

export interface FactCard {
  header: string;
  sections: FactSection[];
}

// ========== 小工具 ==========

function trunc(v: string, max: number): string {
  return v.length <= max ? v : `${v.slice(0, max)}……`;
}

/**
 * 一行档案事实的档位后缀。**唯一入口**：三处（时间线、诉求、对方主体）都经它，
 * 各写一遍 `tierMark(normalizeSourceTier(x))` 的形态是——某一处漏了归一，
 * 一个写坏的档位值在那一处被原样印进 prompt，而它读起来像一个新档位。
 *
 * 【认不出档位时说的是实话】不折成〔自述〕、也不折成〔未记录〕：前者把故障伪装成事实，
 * 后者把"这条事实存在但档位读不出"说成"档案里没有这条事实"——后一句会被模型读成"不存在"。
 * 按最弱档处理是**行为**，那句话是**告知**，两者都要有。
 */
function rowTier(row: { source_tier: string }, ref?: string | number | null): string {
  const tier = normalizeSourceTier(row.source_tier);
  return tier ? tierMark(tier, ref) : '〔来源档位读不出，按最弱档处理〕';
}

/** goal/bottom_line 这类长自由文本：截断要说清截了多少，不然模型会把半句话当全句用 */
function truncField(v: string, max: number): string {
  return v.length <= max ? v : `${v.slice(0, max)}……（原文共 ${v.length} 字，此处只给前 ${max} 字；要全文直接问用户）`;
}

/**
 * 裁剪留痕。格式固定（判据 G-F4 认这一串）：**裁了必须说裁了多少**。
 * 只裁不说 = 模型看到 5 条就以为一共 5 条，然后据此断言「你没有别的证据」。
 */
function trimmedNote(total: number, shown: number, extra = ''): string {
  return `- （共 ${total} 条，此处只列 ${shown} 条${extra}；其余未注入——需要时直接问用户，不要假设不存在）`;
}

function sumLen(lines: string[]): number {
  return lines.reduce((n, l) => n + l.length + 1, 0);
}

// ========== 分区 ==========

/**
 * 这一节的抬头，从**这个案件所属领域**的包里取（DomainPack.factsSections）。
 *
 * 【为什么不写死中文字面】写死的形态是：第二个领域接进来，事实卡每一节的抬头都还在
 * 讲上一个行当的事——而每一行数据都是对的，模型照常作答，没有一处会报错。
 *
 * 领域包认不出来时退回缺省领域那一份：一条 cases.domain 写坏的行不该让整张事实卡失败
 * （那一轮用户就彻底没有档案了）。**键一定取得到**——assertDomainPack 要求每个包
 * 覆盖全部 FACTS_SECTION_KEYS，缺一个在装载时就点名了。
 */
function heading(s: CaseSnapshot, key: FactsSectionKey): string {
  const pack = domainPackOrDefault(s.case.domain);
  return (pack.factsSections.find((x) => x.key === key) ??
    DOMAINS[DEFAULT_DOMAIN].factsSections.find((x) => x.key === key)!).title;
}

/** P0 当事人。姓名是这次事故的正中心，三条分支各说各的话，一条都不许含糊。 */
function identitySection(s: CaseSnapshot): FactSection {
  const id = s.identity;
  if (id.nameUnreadable) {
    return {
      key: 'parties',
      priority: 0,
      heading: heading(s, 'parties'),
      stat:
        '- 姓名：档案里有实名记录，但这一轮没能把姓名解出来（服务端解密失败）〔读取失败〕。' +
        '**按"我没有姓名"处理**：文书里我不会替他填，需要就问用户。',
      detail: [],
    };
  }
  // 第二道闸：姓名明文出境的条件是 manager 裁决①的**两条**——已实名 **且** 解得开。
  // snapshot.loadIdentity 已经卡过一次；这里再卡一次是因为渲染器拿到什么就印什么，
  // 上游哪天把 auth_status 条件删了（复审 RV-F2 的变异 A），这一行是最后一道门。
  if (id.realName && id.authStatus === '已实名') {
    return {
      key: 'parties',
      priority: 0,
      heading: heading(s, 'parties'),
      stat: `- 姓名：${trunc(id.realName, 30)}〔已实名｜已核验〕`,
      detail: [
        '- 这个姓名只用于用户明确要求的文书填写（仲裁申请书、通知函、授权书等）；' +
          '正文对话里不复述、不拿它当称呼。',
      ],
    };
  }
  // 已实名却没有姓名记录（real_name_enc 为 NULL：认证流程过了但姓名没落库）。
  // 说成「未实名」是把我们这边的空档栽给用户——他刚做完实名，读到"你未实名"只会认为系统在骗人。
  // 两态各说各的话：这一态该做的是补一次姓名，不是再去实名一遍。
  if (id.authStatus === '已实名') {
    return {
      key: 'parties',
      priority: 0,
      heading: heading(s, 'parties'),
      stat: '- 姓名：实名已通过，但档案里没有姓名记录，文书里我不会替你填〔未记录〕',
      detail: [
        '- 需要姓名的文书，先问用户要——' +
          '**不许在文书里放任何形式的姓名占位符，也不许声称已经用上了档案里的真名**（真机事故原句就是这么写的）。',
      ],
    };
  }
  return {
    key: 'parties',
    priority: 0,
    heading: heading(s, 'parties'),
    // 这一句是 manager 定的原文，不许改写成留白或占位符
    stat: '- 姓名：未实名，档案里没有你的姓名，文书里我不会替你填〔未记录〕',
    detail: [
      '- 需要姓名的文书，先问用户要，或让用户先去实名——' +
        '**不许在文书里放任何形式的姓名占位符，也不许声称已经用上了档案里的真名**（真机事故原句就是这么写的）。',
    ],
  };
}

/**
 * 「当前轨」那一行（设计稿 §16）。**只有声明了并行轨的领域才有这一行**——
 * 没有并行轨的领域印一行「当前轨：主线」是纯噪音，而常驻噪音会被连同真信息一起跳过去。
 *
 * 【为什么它必须与阶段并排出现，而不是等模型去问】并行轨的语义是"主线不动、另一条线
 * 同时在走"。不印这一行的形态是：模型只看见 stage，于是把一个正在危机处置里的案子
 * 当成"还在协商阶段"，接着谈退费——而 stage 那一格自始至终都是对的。
 */
function trackLine(s: CaseSnapshot): string | null {
  const pack = domainPackOrDefault(s.case.domain);
  if (pack.tracks.length === 0) return null;
  const on = s.case.track;
  return on
    ? `- 当前轨：**${on}**〔已核验〕——这是与主线**并行**的一条线，主线阶段仍是「${s.case.stage}」，没有被它覆盖。`
    : `- 当前轨：主线（没有并行轨在走）〔已核验〕。本领域的并行轨：${pack.tracks.join(' / ')}。`;
}

/** P0 案件抬头 + 目标底线。goal/bottom_line 是用户自己说的，标注不能省。 */
function caseHeadSection(s: CaseSnapshot): FactSection {
  const c = s.case;
  const track = trackLine(s);
  return {
    key: 'header',
    priority: 0,
    heading: heading(s, 'header'),
    stat: `- 案件：#${c.id}《${trunc(c.title, TITLE_MAX)}》 阶段：${c.stage} 地区：${c.district}区〔已核验〕`,
    detail: [
      ...(track ? [track] : []),
      // 目标与底线**没有档位可言**（它们是意愿不是事实），所以走〔未记录〕/〔自述〕两态：
      // 给一句"我想要 2N"盖上书证章是没有意义的，但"档案里根本没问过"必须说出来。
      `- 用户目标：${c.goal ? `${truncField(c.goal, GOAL_MAX)}${tierMark('自述')}` : `未记录${tierMark(null)}`}`,
      `- 用户底线：${c.bottom_line ? `${truncField(c.bottom_line, GOAL_MAX)}${tierMark('自述')}` : `未记录${tierMark(null)}`}`,
    ],
  };
}

/**
 * P0 本案对话的确定性统计。**这不是摘要，是计数**——
 * 不给这个数，模型会把手上这一段历史当成全部，然后理直气壮地说「你从没提过」。
 */
function historySection(s: CaseSnapshot): FactSection {
  const { total, firstAt } = s.historyStats;
  return {
    key: 'history',
    priority: 0,
    heading: heading(s, 'history'),
    stat:
      total === 0
        ? '- 本案还没有已落库的历史消息〔已核验〕'
        : `- 本案历史消息共 ${total} 条（最早 ${firstAt ? toDisplayDay(firstAt) : '时间未记录'}）〔已核验〕`,
    detail: [
      '- 你在本轮上下文里看到的对话历史**只是其中最近的一段，不是全部**；' +
        '更早的内容我看不到，涉及时让用户复述，不要凭印象补。',
      '- 历史消息开头的方括号标记（如 [问诊]、[陪跑]）是系统加的模式标签，不是用户打的字——' +
        '同一个案子跨模式的对话都在这一条时间轴上。',
    ],
  };
}

/** P0 法定期限。0 条要明说「档案里没登记 ≠ 没有期限」——超期不可逆。 */
function deadlineSection(s: CaseSnapshot): FactSection {
  const rows = s.deadlines;
  const shown = rows.slice(0, DEADLINES_MAX);
  return {
    key: 'deadlines',
    priority: 0,
    heading: heading(s, 'deadlines'),
    stat: rows.length
      ? `- 生效中（未解决）的法定期限：${rows.length} 条〔已核验〕`
      : '- 生效中的法定期限：0 条〔未记录〕——档案里没登记，**不等于没有期限**，别据此说"时效没问题"。',
    detail: [
      ...shown.map(
        (d) => `- ${d.kind}：${toDisplayDay(d.due_at)}${d.derived_from ? `（推算依据：${trunc(d.derived_from, 40)}）` : ''}`,
      ),
      ...(rows.length > shown.length ? [trimmedNote(rows.length, shown.length)] : []),
    ],
  };
}

/**
 * 首诊四列的「真的填了吗」。
 *
 * 【为什么不能只判 != null】库里允许写进空串与 0（cases 的四列没有 CHECK 约束，
 * 表单空提交与整数默认值都进得来），而 `?? '未记录'` 只挡 null：
 * employed_from='' 渲染成「入职日期：」（后面什么都没有，模型会把它当成"有个日期我没看清"），
 * monthly_wage_fen=0 渲染成「月工资：0.00 元」——一个会一路算进赔偿金额的假事实，
 * 两者还都被计进「已记录 N/4」，于是首诊状态机也以为这一项问过了。
 */
function hasValue(v: string | number | null | undefined): boolean {
  if (v == null) return false;
  if (typeof v === 'number') return v > 0;
  return v.trim().length > 0;
}

/**
 * P1 首诊四项。有值必现、无值写「未记录」——省略等于让模型以为没问过。
 *
 * 【四行的抬头必须按领域取（DomainPack.factsBasics）】这四列在不同行当里装的**不是同一个量**：
 * monthly_wage_fen 在一个行当里是按月发的，在另一个行当里是按次收的；employed_from
 * 在一个行当里是入职那天，在另一个行当里是服务关系开始那天。抬头写死一份的形态是——
 * 模型每一轮都把这四个数**读成别的东西**，然后拿它去算钱、去写文书，
 * 而值一个都没错、格式完全正常、没有任何一处会报错。
 */
function employmentSection(s: CaseSnapshot): FactSection {
  const c = s.case;
  const labels = domainPackOrDefault(s.case.domain).factsBasics;
  const wage = hasValue(c.monthly_wage_fen) ? `${(c.monthly_wage_fen! / 100).toFixed(2)} 元` : '未记录';
  const filled = [c.employed_from, c.position, c.monthly_wage_fen, c.contract_count].filter(hasValue).length;
  return {
    key: 'basics',
    priority: 1,
    heading: heading(s, 'basics'),
    stat: `- 首诊四项已记录 ${filled}/4${tierMark('自述')}——这四项是用户自己报的，没有材料支撑`,
    detail: [
      `- ${labels.employedFrom}：${hasValue(c.employed_from) ? c.employed_from : '未记录'}`,
      `- ${labels.position}：${hasValue(c.position) ? trunc(c.position!, 40) : '未记录'}`,
      `- ${labels.monthlyWage}：${wage}`,
      `- ${labels.contractCount}：${hasValue(c.contract_count) ? trunc(c.contract_count!, 20) : '未记录'}`,
    ],
  };
}

/** P1 公司主体。0 行要点破「时间线里提过 ≠ 档案已知」——这正是知识图谱那条缺口。 */
function companySection(s: CaseSnapshot): FactSection {
  const rows = s.companies;
  const shown = rows.slice(0, COMPANIES_MAX);
  return {
    key: 'counterparts',
    priority: 1,
    heading: heading(s, 'counterparts'),
    stat: rows.length
      ? `- 已登记的公司主体：${rows.length} 个〔已核验〕`
      : '- 已登记的公司主体：0 个〔未记录〕——时间线的自由文本里可能提到过公司名，' +
        '但没被登记成主体前**不算档案已知**：要用公司全称就先问用户核对，不许从时间线里猜一个。',
    detail: [
      ...shown.map((p) => {
        const bits = [
          p.role,
          p.uscc ? `统一社会信用代码 ${p.uscc}` : null,
          p.legal_rep ? `法定代表人 ${p.legal_rep}` : null,
        ]
          .filter(Boolean)
          .join('，');
        return `- ${trunc(p.name, 40)}（${bits}）${p.risk_notes ? ` 风险：${trunc(p.risk_notes, 60)}` : ''}${rowTier(p)}`;
      }),
      ...(rows.length > shown.length ? [trimmedNote(rows.length, shown.length)] : []),
    ],
  };
}

/** P1 未完成行动卡（charter §9 要求本轮跟踪） */
function actionSection(s: CaseSnapshot): FactSection {
  const rows = s.openActions;
  const shown = rows.slice(0, ACTIONS_MAX);
  return {
    key: 'actions',
    priority: 1,
    heading: heading(s, 'actions'),
    stat: `- 未完成的行动卡：${rows.length} 张〔已核验〕（charter §9 要求本轮逐张跟踪）`,
    detail: [
      ...shown.map(
        (a) => `- #${a.id}《${trunc(a.title, ACTION_TITLE_MAX)}》${a.due_at ? ` 截止 ${toDisplayDay(a.due_at)}` : ''}`,
      ),
      ...(rows.length > shown.length ? [trimmedNote(rows.length, shown.length)] : []),
    ],
  };
}

/** P2 金额诉求 */
function claimSection(s: CaseSnapshot): FactSection {
  const rows = s.claims;
  const shown = rows.slice(0, CLAIMS_MAX);
  return {
    key: 'claims',
    priority: 2,
    heading: heading(s, 'claims'),
    stat: rows.length
      ? `- 已登记的金额诉求：${rows.length} 项〔已核验〕`
      : '- 已登记的金额诉求：0 项〔未记录〕——只是还没落库，不代表用户没有诉求。',
    detail: [
      ...shown.map((cl) => {
        const amount = cl.amount_fen > 0 ? `${(cl.amount_fen / 100).toFixed(2)} 元` : '待计算';
        return `- ${cl.kind}：${amount}${cl.basis ? `｜依据 ${trunc(cl.basis, 40)}` : ''}${
          cl.calc_json ? `｜算式 ${trunc(cl.calc_json, 80)}` : ''
        }${rowTier(cl)}`;
      }),
      ...(rows.length > shown.length ? [trimmedNote(rows.length, shown.length)] : []),
    ],
  };
}

/**
 * **P1 要件表**（设计稿 §3 中间产物 `element_sheet` / §6 S6）。
 *
 * 【为什么它是 P1 而不是 P2】它回答的是本产品目标函数里的第一件事——"我的诉求靠哪几条事实
 * 成立、哪几条还缺"（设计稿 §1.1）。P2 的形态是：档案越厚它越先消失，而档案厚的案子
 * 正是要件最多、最需要这张表的那些。它排在诉求之后：先说"我要什么"，再说"这几样各差什么"。
 *
 * 【只画已登记诉求的那几项】没有诉求就整节不出现（`rendered:false`）。
 * 画全表的形态是：一个只主张欠薪的人读到一整屏别的要件全标着「缺失」——
 * 他要么以为自己什么都不成立，要么去补一堆与他这件事无关的材料。
 *
 * 【〔未记录〕那一格只许说"需补什么"】这一节最贵的一条纪律：缺失 ≠ 不成立。
 * 状态由来源档位程序推出（lib/cases/elements.ts），不是这一轮的判断；
 * 缺失格的下一步恒是"补哪一张"，措辞来自要件卡的 typicalEvidence。
 */
function elementSection(s: CaseSnapshot): FactSection | null {
  const pack = domainPackOrDefault(s.case.domain);
  const cards = pack.elementCards ?? [];
  const labels = pack.burdenLabels;
  const title = pack.elementSheetTitle;
  // 三样缺一个就把整节收掉。有卡没措辞（或反过来）在装载时已被 assertDomainPack 拦了；
  // 这里再判一次是因为类型上三者都是可选的——渲染一列 undefined 比不渲染坏得多。
  if (cards.length === 0 || !labels || !title) return null;

  const kinds = [...new Set(s.claims.map((c) => c.kind))];
  const sheet = buildElementSheet(s, cards, kinds);
  // 【一项诉求都没登记时说一句话，不画空表】零行的表读起来像"你一个要件都不成立"；
  // 整节消失又等于没人告诉他这里本来该有什么。所以给一句带出路的话（§7.7 禁令配出路）。
  if (!sheet.rendered) {
    return {
      key: 'elements',
      priority: 1,
      heading: title,
      stat:
        '- 本案还没有登记任何诉求，所以这张表现在是空的。**这不是"你没有诉求"**——' +
        '把用户想要的那几项登记进来（能算的走 claim_calc，只是登记名目的走 claims_upsert），' +
        '这张表会自动列出每一项各靠哪几个要件成立、现在缺什么。',
      detail: [],
    };
  }

  const tally = new Map<ElementStatus, number>();
  for (const r of sheet.rows) tally.set(r.status, (tally.get(r.status) ?? 0) + 1);
  const tallyText = ELEMENT_STATUSES.filter((st) => tally.get(st)).map((st) => `${st} ${tally.get(st)}`).join('、');

  const shown = sheet.rows.slice(0, ELEMENTS_MAX);
  return {
    key: 'elements',
    priority: 1,
    heading: title,
    stat: [
      `- 本表覆盖已登记的 ${kinds.length} 项诉求、${sheet.rows.length} 个要件：${tallyText}。` +
        '每行的格式是「要件：状态｜谁来证｜下一步」。',
      '- 状态由档案里那几条事实的**来源档位程序推出**（不是这一轮的判断，也不是模型的估计）：' +
        '支撑它的事实全部在档且最弱一条有书证 ⇒ 成立；全部在档但含纯自述 ⇒ 成立·待证；' +
        '有一条**档案里没有** ⇒ 缺失。',
      '- **「缺失」是〔未记录〕，不是「不满足」**：档案里没有这一项 ≠ 事实上没有。' +
        '这几行只允许说「需补什么」，**不许**写成「不满足 / 不成立 / 这一项你没有」，' +
        '也不许据此说这项诉求提不了——照着「下一步」问用户或落一张行动卡。',
    ].join('\n'),
    detail: [
      ...shown.map((r) => {
        const need = r.typicalEvidence.filter((e) => e.trim()).join('、');
        const unresolved = r.unresolvedSlots.length
          ? `（这几个槽位系统不认识、已按缺失处理：${r.unresolvedSlots.join('、')}）`
          : '';
        const tail =
          r.status === '成立'
            ? '支撑它的事实都有书证，这一项不用再补'
            : `需补：${trunc(need, ELEMENT_NEED_MAX)}`;
        return `- 〔${r.claimKind}·${r.id}〕${r.name}：${r.status}｜${labels[r.burden]}｜${tail}${unresolved}`;
      }),
      ...(sheet.rows.length > shown.length ? [trimmedNote(sheet.rows.length, shown.length)] : []),
    ],
  };
}

/**
 * P2 时间线。裁剪时**永远保留最早 1 条**（入职/起点锚点）+ 最新若干条：
 * 最早那条是年限计算的起点，裁掉它，模型算工龄就只能从"最近发生的事"往回猜。
 */
const TIMELINE_ANCHOR = '- （下面这条是本卡收到的最早一条事件，起点锚点，永不裁掉）';

/**
 * 时间线明细按给定字符预算重裁。**room 再小也返回三行**（留痕 + 锚点说明 + 最早 1 条），
 * 绝不返回空数组：那正是复审 MF-1 指出的悬崖——整区一丢，工龄起点就没了，
 * 模型只能从"最近发生的事"往回猜入职时间。
 *
 * @param lines   窗口内的事件行（倒序，最新在前）
 * @param total   **全案真总数**，不是 lines.length：留痕的「共 N 条」写窗口长度，
 *                就是拿被截过一刀的数字冒充全部（45 条的库会写成「共 30 条」）。
 * @param anchor  **真最早 1 条**的行；窗口内已经含着它时传 null，避免同一条印两遍。
 */
function timelineDetail(lines: string[], room: number, total: number, anchor: string | null): string[] {
  if (lines.length === 0) return [];
  // 窗口内已含最早事件时，锚点就是窗口末行，它不再重复占一行
  const earliest = anchor ?? lines[lines.length - 1];
  const body = anchor === null ? lines.slice(0, -1) : lines;
  const kept: string[] = [];
  // 先把锚点与留痕的位置留出来，再拿剩下的预算装最新的几条
  let used = earliest.length + TIMELINE_ANCHOR.length + 120;
  for (const l of body) {
    if (used + l.length + 1 > room) break;
    kept.push(l);
    used += l.length + 1;
  }
  // 窗口就是全部、且一条都没被预算挤掉：没有裁剪，也就没有留痕可留
  if (anchor === null && total === lines.length && kept.length === body.length && sumLen(lines) <= room) {
    return lines;
  }
  return [
    ...kept,
    trimmedNote(total, kept.length + 1, `（最新 ${kept.length} 条 + 最早 1 条）`),
    TIMELINE_ANCHOR,
    earliest,
  ];
}

/**
 * 一条事件的**类型标签**（登记时选的那一格）。没选过 ⇒ 空串，那一行与本列落地前逐字相同。
 *
 * 【为什么认不出来的取值要印出来，而不是当作没选】那一格已经压过了谓词：判定不会再去读
 * 这条记录写的字，也不会认它是任何一格（它不在任何 acceptsType 里），于是这个槽从此恒缺。
 * 静默的形态是——要件表说缺、时间线上这条记录看起来好端端的，没有一处说得出为什么。
 */
function eventTypeMark(pack: DomainPack, kind: string, id: string | null): string {
  const value = typeof id === 'string' && id.trim() ? id.trim() : null;
  if (value === null) return '';
  const spec = (pack.timelineEventTypes[kind] ?? []).find((t) => t.id === value);
  return spec
    ? `〔类型：${spec.label}〕`
    : `〔类型：${value}——本领域已不认识这个取值，按类型的判定一条都不会认它〕`;
}

function timelineSection(s: CaseSnapshot): FactSection {
  const pack = domainPackOrDefault(s.case.domain);
  const fmt = (e: CaseSnapshot['timeline'][number]) =>
    `- ${toDisplayTime(e.happened_at)}｜${e.kind}｜${e.title}${e.detail ? `：${trunc(e.detail, TIMELINE_DETAIL_MAX)}` : ''}${eventTypeMark(pack, e.kind, e.event_type)}${rowTier(e)}`;
  const lines = s.timeline.map(fmt);
  // 真总数 / 真最早 1 条来自 timelineStats（独立取数），不从被窗口截过的 timeline 推。
  // 窗口已经含住最早那条时传 null：重复印一遍会让模型以为同一件事发生了两次。
  const { total, earliest } = s.timelineStats;
  const inWindow = earliest != null && s.timeline.some((e) => e.id === earliest.id);
  const anchor = earliest && !inWindow ? fmt(earliest) : null;
  // 【这一行此前是渲染时猜的】原文是「〔用户自述待核实——全部是用户口述落档，没有第三方证据支撑〕」，
  // 整段贴在区抬头上、与真实数据无关：哪怕整条时间线都由证据提取写入，它照样这么说。
  // 现在数出来：有几条有书证及以上支撑，逐条的档位在每一行末尾。
  const documented = s.timeline.filter((e) => {
    const tier = normalizeSourceTier(e.source_tier);
    return tier !== null && isDocumented(tier);
  }).length;
  const stat = lines.length
    ? `- 档案里最近的 ${lines.length} 条事件（倒序，最新在前）；其中有书证及以上支撑的 ${documented} 条，` +
      `其余只有当事人的说法——逐条档位见每行末尾的〔〕`
    : `- 时间线：0 条${tierMark(null)}——还没有任何已落档的事件。`;

  return {
    key: 'timeline',
    priority: 2,
    heading: heading(s, 'timeline'),
    stat,
    detail: timelineDetail(lines, TIMELINE_BUDGET, total, anchor),
    refit: (room: number) => timelineDetail(lines, room, total, anchor),
  };
}

/**
 * P3 证据。**全 8 类计数照列，0 也列**——"合同 0 条"是模型最需要知道的那条否定事实：
 * 不列，它只会看见"有 19 条证据"，然后理所当然地以为合同在里面。
 */
function evidenceSection(s: CaseSnapshot): FactSection {
  const rows = s.evidence;
  const counts = EVIDENCE_CATEGORIES.map(
    (cat) => `${cat} ${rows.filter((r) => r.category === cat).length}`,
  ).join(' / ');
  const known = rows.filter((r) => (EVIDENCE_CATEGORIES as readonly string[]).includes(r.category)).length;
  const unknown = rows.length - known;

  const briefed = rows.filter((r) => parseBrief(r.brief_json) !== null).length;
  const extracted = rows.filter((r) => r.extraction_status === EXTRACTION_DONE).length;
  // 出证后自动补的简报让「未提取」的条目也带上了简报——三个数各自独立数，谁都不是谁的子集：
  // 旧写法「已提取 N、其中 M 有简报」把 briefed 当成 extracted 的子集，M>N 时算术自相矛盾。
  const briefedNotExtracted = rows.filter(
    (r) => parseBrief(r.brief_json) !== null && r.extraction_status !== EXTRACTION_DONE,
  ).length;

  // 明细按**最近更新**排序（提取过的以提取时间为准，没提取过的以入库时间为准）：
  // 预算压不下时被裁掉的应该是最旧的那些，而不是碰巧 id 小的那些。
  const ordered = [...rows].sort((a, b) =>
    (b.extracted_at ?? b.created_at).localeCompare(a.extracted_at ?? a.created_at),
  );

  // 【敏感级：只给元数据，不给读过内容之后的结论】声明了 sensitive 的领域，档案里写的是
  // **第三人**的健康与心理信息（个保法 §28 那一类）。简报是"系统读过文件内容之后写下的
  // 结论"，逐条印进每一轮 prompt 的形态是：那个人最不愿被人知道的东西，在他从不知情、
  // 也没有任何一次调用记录的情况下，被复制进了每一轮对话——而这一轮可能只是在问退费怎么算。
  // 所以这里退回"读没读过"这一个比特，真要用内容时按 id 单取（那一次是有据可查的一次动作）。
  const sensitive = domainPackOrDefault(s.case.domain).sensitive;
  const lines = ordered
    .slice(0, EVIDENCE_ITEMS_MAX)
    .map(
      (e) =>
        `- 《${trunc(e.name, EVIDENCE_NAME_MAX)}》｜${e.category}｜${e.status}｜证明目的：${
          e.prove_purpose ? trunc(e.prove_purpose, EVIDENCE_PURPOSE_MAX) : '用户未填'
        }｜${sensitive ? evidenceReadState(e) : evidenceContentNote(e)}`,
    );
  const kept: string[] = [];
  let used = 0;
  for (const l of lines) {
    if (used + l.length + 1 > EVIDENCE_BUDGET) break;
    kept.push(l);
    used += l.length + 1;
  }

  return {
    key: 'evidence',
    priority: 3,
    heading: heading(s, 'evidence'),
    stat: [
      `- 证据共 ${rows.length} 条〔文件名/类别已核验；证明目的是用户自述待核实〕`,
      `- 分类计数（0 条的类别也列出来——"合同 0" 正是最容易被脑补成"有"的那种事实）：${counts}` +
        (unknown > 0 ? ` / 枚举外分类 ${unknown}` : ''),
      `- 已提取内容 ${extracted} 条；有简报 ${briefed} 条（含 ${briefedNotExtracted} 条未提取、按元数据写成）；未提取 ${rows.length - extracted} 条**没读过内容**`,
      // 敏感级的那句纪律由领域包给，且**紧挨着明细出现**——写在别处的形态是，
      // 模型读到逐条明细时早已翻过那句话
      ...(sensitive ? [sensitive.factsNotice] : []),
      EVIDENCE_DISCLAIMER,
    ].join('\n'),
    detail: [
      ...kept,
      ...(rows.length > kept.length ? [trimmedNote(rows.length, kept.length)] : []),
    ],
  };
}

/** extraction_status 的「已完成」档，与 lib/jobs/extraction-worker 的状态机同名同物。 */
const EXTRACTION_DONE = 'done';

/**
 * 敏感级下的「内容读没读过」那一格：**只回状态，不回简报正文**。
 *
 * 与 evidenceContentNote 的差别只有一处——有简报时不印简报，改成告诉模型
 * 「有简报，但按敏感级不在这里给；要用就 evidence_get 按 id 读」。
 * 不说"有简报但不给你"而直接印成"未提取"的形态是：模型以为这份材料没人读过，
 * 于是去催用户做提取，而提取早就做完了。
 */
function evidenceReadState(e: CaseSnapshot['evidence'][number]): string {
  if (parseBrief(e.brief_json)) {
    return `已有简报（敏感级：正文不在卡里给，要用先 evidence_get 按 id 读）${briefTier(e)}`;
  }
  if (e.extraction_status === EXTRACTION_DONE) return '已提取内容、简报未生成（要用内容先 evidence_get 读全文）';
  return '未提取（没读过内容）';
}

/**
 * 一条证据的「内容读没读过」那一格。三态分得开：
 *   · 有简报 ⇒ 印简报摘要（≤60 字，超了截断）——这是模型真正能拿去用的那句话；
 *   · 提取完成但还没有简报 ⇒ 明说"已提取、简报未生成"，让它知道去 evidence_get 拿全文；
 *   · 其余（从没提过、排队中、失败）⇒ 一律「未提取」。
 *     排队中与失败不单独成档：对"能不能引用里面的内容"这个问题，它们的答案与"没提过"完全一样，
 *     多一档只会让模型以为等一等就有了，然后按"快有了"去组织回答。
 */
function evidenceContentNote(e: CaseSnapshot['evidence'][number]): string {
  const brief = parseBrief(e.brief_json);
  if (brief) return `简报：${briefSummary(brief, BRIEF_SUMMARY_MAX)}${briefTier(e)}`;
  if (e.extraction_status === EXTRACTION_DONE) return '已提取内容、简报未生成（要用内容先 evidence_get 读全文）';
  return '未提取（没读过内容）';
}

/**
 * **简报结论**的档位（不是这份材料本身的档位）。锚点用证据行 id，所以读到
 *〔书证#12〕时可以直接 evidence_get 12 去核原文。
 *
 * 【为什么它必须标出来】简报有两种来源：读过原文写下的结论，与没读过原文、
 * 按文件名和类别写下的推测。两者在卡上此前长得一模一样，而后者过两轮就被当成
 * 这份材料里写着的话（migrate.ts brief_updated_by 那段注释讲的是同一件事）。
 */
function briefTier(e: CaseSnapshot['evidence'][number]): string {
  const tier = normalizeSourceTier(e.brief_source_tier);
  return tier ? tierMark(tier, e.id) : '〔来源档位读不出，按最弱档处理〕';
}

// ========== 组装与预算 ==========

/**
 * 「本问题现行法律解释存疑：只给依据原文与分歧点，不下结论」的那几条（设计稿 §16）。
 * **没有声明 interpretationDisputed 的领域根本不出这一节**——所以第一个领域的事实卡逐字不变。
 *
 * 【为什么它是 P0（永不被预算降级）】它挡的是模型的默认行为：这几件事恰恰是它最容易
 * 给出干脆答案的那几件。被预算压掉的形态是——档案越厚这一节越先消失，
 * 而档案厚的案子正是最需要它的那些。
 *
 * 【为什么放在事实卡而不只放在个案报告里】报告是用户主动去整理时才生成的；事实卡是
 * **每一轮**都在的。只放报告的形态是：模型在没读过报告的那一轮里，把"是不是强制报告主体"
 * 直接答了——而那一轮看起来与其它轮没有任何区别。
 */
function interpretationDisputedSection(s: CaseSnapshot): FactSection | null {
  const review = domainPackOrDefault(s.case.domain).interpretationDisputed;
  if (!review) return null;
  return {
    key: 'interpretationDisputed',
    priority: 0,
    heading: review.title,
    // 纪律那句话进 stat：stat 是整区降级后唯一幸存的部分，而这一节里最不能丢的正是这句
    stat: `- ${review.discipline}`,
    detail: review.items.flatMap((x) => [`- ${x.text}`, `  - ${precedentLine(x.precedents)}`]),
  };
}

/**
 * **取证闸**（设计稿 §4.2-2）：进了取证窗口，而带档位的关键事实**一条书证都没有**时，
 * 在事实卡首行说出来，并由服务端落一张强制取证的行动卡（落卡在 lib/cases.updateCase）。
 *
 * 【为什么按「组」数而不是「条」数】按条数报的形态是：一个记了三十条时间线的案子
 * 读到"30 项关键事实仍无书证"，那句话读起来像在骂人，而它要传达的是
 *「哪几类事实还立不住」。组 = 事实卡里带档位的那三节（时间线 / 金额主张 / 对方主体），
 * 上限三组，名字从领域包取（factsSections），共用层不写行当名词。
 *
 * 【已知的取数缺口，方向是"宁可多报"】时间线只看得到窗口内最近 TIMELINE_WINDOW 条
 *（snapshot 就是这么取的）。窗口外有一条带书证的老事件时，这里会误判成"全无书证"而多报一次。
 * 误差方向是刻意的：多提醒一次的代价是用户多看一行字，少提醒一次的代价是他带着
 * 一堆只有自己说法的事实进入取证窗口（评测官口径：取不准时一律偏向报警）。
 *
 * @returns 首行要追加的那句话；不该开闸时 null（整句不出现，不写"证据充分"那类常驻噪音）
 */
export function evidenceGapMark(s: CaseSnapshot): string | null {
  const gate = domainPackOrDefault(s.case.domain).evidenceGate;
  if (!gate || !gate.stages.includes(s.case.stage)) return null;

  const groups: { key: FactsSectionKey; rows: readonly { source_tier: string }[] }[] = [
    { key: 'timeline', rows: s.timeline },
    { key: 'claims', rows: s.claims },
    { key: 'counterparts', rows: s.companies },
  ];
  const present = groups.filter((g) => g.rows.length > 0);
  // 判据本身在 lib/cases/source-tier.noDocumentedFact（写侧的落卡条件读的是同一个函数）
  if (!noDocumentedFact(present.map((g) => g.rows))) return null;

  return gate.notice
    .replace('{n}', String(present.length))
    .replace('{groups}', present.map((g) => heading(s, g.key)).join('、'));
}

/** 取值 + 标注来源，不做裁剪（裁剪归 renderCaseFacts）。 */
export function buildCaseFacts(s: CaseSnapshot): FactCard {
  const status = buildFactsStatusLine({
    report: s.report,
    basicsMissing: basicsMissing(s.case).length,
    // 危机标记排在报告过期与基本盘缺项之后（extra 原样按序追加）：前两项讲的是
    // "手上这份东西还能不能用"，这一项讲的是"跟你说话的这个人最近怎么样"——
    // 后者不该被前者挤掉，也不该把前者顶开，两句都在同一行里说完。
    // 取证闸排在危机标记之后：前一句讲"跟你说话的这个人最近怎么样"，
    // 这一句讲"手上这套事实还立不立得住"。两句都在同一行里说完，谁都不顶开谁。
    extra: [crisisStatusMark(s.crisisHits72h) ?? '', evidenceGapMark(s) ?? ''],
  });
  return {
    // 状态区在抬头之上：它是"先别急着答"的那句话，排在使用说明后面就没人先读到了
    header: status ? `${status}\n\n${HEADER}` : HEADER,
    sections: [
      identitySection(s),
      caseHeadSection(s),
      historySection(s),
      deadlineSection(s),
      employmentSection(s),
      companySection(s),
      actionSection(s),
      claimSection(s),
      // 要件表紧跟诉求。**可能整节不出现**（本领域还没有要件卡、或本案一项诉求都没登记）——
      // 那时它不该是一张零行的表：用户读到"要件：（空）"，那看起来像"你一个要件都不成立"。
      ...([elementSection(s)].filter((x): x is FactSection => x !== null)),
      timelineSection(s),
      evidenceSection(s),
      // 排在最后：前面每一节说的都是"手上有什么"，这一节说的是"哪几件事不许下结论"，
      // 它该是读完全部事实之后的最后一句话。没有这类条目的领域这里是空数组。
      ...([interpretationDisputedSection(s)].filter((x): x is FactSection => x !== null)),
    ],
  };
}

function compose(card: FactCard, dropped: Set<string>): string {
  const blocks = [card.header];
  for (const sec of card.sections) {
    const lines = [`### ${sec.heading}`, sec.stat];
    if (dropped.has(sec.key)) {
      if (sec.detail.length) lines.push(DETAIL_DROPPED);
    } else {
      lines.push(...sec.detail);
    }
    blocks.push(lines.join('\n'));
  }
  return blocks.join('\n\n');
}

/** 降级顺序：P3 → P2 → P1，同优先级里先压明细最长的那一区。P0 不在候选里。 */
function degradeOrder(card: FactCard): string[] {
  return card.sections
    .filter((s) => s.priority > 0 && s.detail.length > 0)
    .sort((a, b) => b.priority - a.priority || sumLen(b.detail) - sumLen(a.detail))
    .map((s) => s.key);
}

/**
 * 渲染并保证 ≤ CASE_FACTS_BUDGET。
 *
 * 【为什么上限必须是后置保证而不是"估算够用"】milestone-a3 那次就是按数据形态估的，
 * 实际数据一变就把 25k 字符灌进了 prompt。这里的三段裁剪把上限变成与数据形态无关的性质：
 * 区内裁 → 整区降级（P3→P2→P1；带 refit 的分区改为按剩余预算重裁）→ 兜底硬截。
 * P0 永不降级，所以「我是谁、案子是哪个、期限还剩几天、历史我看不全」这四件事
 * 在任何数据形态下都在；时间线因为带 refit，最早 1 条锚点也一样在。
 */
export function renderCaseFacts(input: FactCard): string {
  // 浅拷贝一份分区：refit 会就地改写 detail，不能污染调用方手里的卡
  const card: FactCard = { header: input.header, sections: input.sections.map((s) => ({ ...s })) };
  const dropped = new Set<string>();
  let out = compose(card, dropped);
  if (out.length <= CASE_FACTS_BUDGET) return out;

  for (const key of degradeOrder(card)) {
    const sec = card.sections.find((s) => s.key === key)!;
    if (sec.refit) {
      // 按剩余预算重裁而不是整段丢：把超出的那部分从本区明细里扣掉，锚点与留痕仍在
      sec.detail = sec.refit(Math.max(sumLen(sec.detail) - (out.length - CASE_FACTS_BUDGET), 0));
    } else {
      dropped.add(key);
    }
    out = compose(card, dropped);
    if (out.length <= CASE_FACTS_BUDGET) return out;
  }

  // 兜底：P0 自身撑爆预算（超长标题+超长 goal+一堆期限）时也不许越界，
  // 但要留痕——静默截断会让模型把半句话当完整事实用。
  const note = '\n\n（事实卡超出注入预算，尾部已截断；被截掉的部分需要时直接问用户。）';
  return out.slice(0, CASE_FACTS_BUDGET - note.length) + note;
}
