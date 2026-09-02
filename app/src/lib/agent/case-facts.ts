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
import { EVIDENCE_CATEGORIES } from '@/lib/evidence/categories';

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

/**
 * 证据区免责句，常驻、一字不改。
 *
 * 【为什么是硬文本而不是"看情况说"】evidence 表没有任何文本列，全站也没有 OCR 接线——
 * 「我读过这些文件」在今天**永远**是假的。把这句写死在 prompt 里，编造的成本才高于如实说。
 * 它直接对着那次事故：模型拿着文件名推测文件内容，用户当场发现对不上。
 */
export const EVIDENCE_DISCLAIMER =
  '- 以下只有证据的**文件名、类别和用户自己填写的证明目的**。我**没有读过这些文件的内容**（系统目前不做文件文本提取）。' +
  '需要引用文件里的具体内容（合同条款、流水金额、录音原话）时，**必须先问用户**，不许根据文件名推测。';

/** 整区明细被预算压掉时的留痕。压掉的是明细，统计行仍在——模型必须知道「有但没给」。 */
const DETAIL_DROPPED = '- （明细因预算未注入——需要时直接问用户，不要假设不存在）';

const HEADER = [
  '## 案件事实卡（服务端从档案读出的当前事实，以此为准；用户说法与此矛盾时先核对再改档）',
  '',
  '每处〔〕标的是来源与核验状态：〔已核验〕= 系统自己登记或推算的；' +
    '〔用户自述待核实〕= 用户口述落档、没有第三方证据支撑，引用时要标出来；' +
    '〔未记录〕= **档案里没有这一项，不是"事实上没有"**——需要就直接问用户，' +
    '不许拿它当"不存在"来推理，更不许自己补一个值。',
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

/** P0 当事人。姓名是这次事故的正中心，三条分支各说各的话，一条都不许含糊。 */
function identitySection(s: CaseSnapshot): FactSection {
  const id = s.identity;
  if (id.nameUnreadable) {
    return {
      key: 'identity',
      priority: 0,
      heading: '当事人',
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
      key: 'identity',
      priority: 0,
      heading: '当事人',
      stat: `- 姓名：${trunc(id.realName, 30)}〔已实名｜已核验〕`,
      detail: [
        '- 这个姓名只用于用户明确要求的文书填写（仲裁申请书、通知函、授权书等）；' +
          '正文对话里不复述、不拿它当称呼。',
      ],
    };
  }
  return {
    key: 'identity',
    priority: 0,
    heading: '当事人',
    // 这一句是 manager 定的原文，不许改写成留白或占位符
    stat: '- 姓名：未实名，档案里没有你的姓名，文书里我不会替你填〔未记录〕',
    detail: [
      '- 需要姓名的文书，先问用户要，或让用户先去实名——' +
        '**不许在文书里放任何形式的姓名占位符，也不许声称已经用上了档案里的真名**（真机事故原句就是这么写的）。',
    ],
  };
}

/** P0 案件抬头 + 目标底线。goal/bottom_line 是用户自己说的，标注不能省。 */
function caseHeadSection(s: CaseSnapshot): FactSection {
  const c = s.case;
  return {
    key: 'case',
    priority: 0,
    heading: '案件抬头',
    stat: `- 案件：#${c.id}《${trunc(c.title, TITLE_MAX)}》 阶段：${c.stage} 地区：${c.district}区〔已核验〕`,
    detail: [
      `- 用户目标：${c.goal ? truncField(c.goal, GOAL_MAX) : '未记录'}〔用户自述待核实〕`,
      `- 用户底线：${c.bottom_line ? truncField(c.bottom_line, GOAL_MAX) : '未记录'}〔用户自述待核实〕`,
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
    heading: '本案对话',
    stat:
      total === 0
        ? '- 本案还没有已落库的历史消息〔已核验〕'
        : `- 本案历史消息共 ${total} 条（最早 ${firstAt ? firstAt.slice(0, 10) : '时间未记录'}）〔已核验〕`,
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
    heading: '法定期限',
    stat: rows.length
      ? `- 生效中（未解决）的法定期限：${rows.length} 条〔已核验〕`
      : '- 生效中的法定期限：0 条〔未记录〕——档案里没登记，**不等于没有期限**，别据此说"时效没问题"。',
    detail: [
      ...shown.map(
        (d) => `- ${d.kind}：${d.due_at}${d.derived_from ? `（推算依据：${trunc(d.derived_from, 40)}）` : ''}`,
      ),
      ...(rows.length > shown.length ? [trimmedNote(rows.length, shown.length)] : []),
    ],
  };
}

/** P1 首诊四项。有值必现、无值写「未记录」——省略等于让模型以为没问过。 */
function employmentSection(s: CaseSnapshot): FactSection {
  const c = s.case;
  const wage = c.monthly_wage_fen == null ? '未记录' : `${(c.monthly_wage_fen / 100).toFixed(2)} 元`;
  const filled = [c.employed_from, c.position, c.monthly_wage_fen, c.contract_count].filter(
    (v) => v != null,
  ).length;
  return {
    key: 'employment',
    priority: 1,
    heading: '用工基本盘（首诊四项）',
    stat: `- 首诊四项已记录 ${filled}/4〔用户自述待核实〕`,
    detail: [
      `- 入职日期：${c.employed_from ?? '未记录'}`,
      `- 岗位：${c.position ? trunc(c.position, 40) : '未记录'}`,
      `- 月工资：${wage}`,
      `- 合同签订次数：${c.contract_count ? trunc(c.contract_count, 20) : '未记录'}`,
    ],
  };
}

/** P1 公司主体。0 行要点破「时间线里提过 ≠ 档案已知」——这正是知识图谱那条缺口。 */
function companySection(s: CaseSnapshot): FactSection {
  const rows = s.companies;
  const shown = rows.slice(0, COMPANIES_MAX);
  return {
    key: 'companies',
    priority: 1,
    heading: '公司主体',
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
        return `- ${trunc(p.name, 40)}（${bits}）${p.risk_notes ? ` 风险：${trunc(p.risk_notes, 60)}` : ''}`;
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
    heading: '未完成的行动卡',
    stat: `- 未完成的行动卡：${rows.length} 张〔已核验〕（charter §9 要求本轮逐张跟踪）`,
    detail: [
      ...shown.map(
        (a) => `- #${a.id}《${trunc(a.title, ACTION_TITLE_MAX)}》${a.due_at ? ` 截止 ${a.due_at}` : ''}`,
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
    heading: '诉求（claims）',
    stat: rows.length
      ? `- 已登记的金额诉求：${rows.length} 项〔已核验〕`
      : '- 已登记的金额诉求：0 项〔未记录〕——只是还没落库，不代表用户没有诉求。',
    detail: [
      ...shown.map((cl) => {
        const amount = cl.amount_fen > 0 ? `${(cl.amount_fen / 100).toFixed(2)} 元` : '待计算';
        return `- ${cl.kind}：${amount}${cl.basis ? `｜依据 ${trunc(cl.basis, 40)}` : ''}${
          cl.calc_json ? `｜算式 ${trunc(cl.calc_json, 80)}` : ''
        }`;
      }),
      ...(rows.length > shown.length ? [trimmedNote(rows.length, shown.length)] : []),
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
 */
function timelineDetail(lines: string[], room: number): string[] {
  if (lines.length === 0) return [];
  if (sumLen(lines) <= room) return lines;
  const earliest = lines[lines.length - 1];
  const kept: string[] = [];
  // 先把锚点与留痕的位置留出来，再拿剩下的预算装最新的几条
  let used = earliest.length + TIMELINE_ANCHOR.length + 120;
  for (const l of lines.slice(0, -1)) {
    if (used + l.length + 1 > room) break;
    kept.push(l);
    used += l.length + 1;
  }
  return [
    ...kept,
    trimmedNote(lines.length, kept.length + 1, `（最新 ${kept.length} 条 + 最早 1 条）`),
    TIMELINE_ANCHOR,
    earliest,
  ];
}

function timelineSection(s: CaseSnapshot): FactSection {
  const lines = s.timeline.map(
    (e) =>
      `- ${e.happened_at}｜${e.kind}｜${e.title}${e.detail ? `：${trunc(e.detail, TIMELINE_DETAIL_MAX)}` : ''}`,
  );
  const stat = lines.length
    ? `- 档案里最近的 ${lines.length} 条事件（倒序，最新在前）〔用户自述待核实——全部是用户口述落档，没有第三方证据支撑〕`
    : '- 时间线：0 条〔未记录〕——还没有任何已落档的事件。';

  return {
    key: 'timeline',
    priority: 2,
    heading: '时间线',
    stat,
    detail: timelineDetail(lines, TIMELINE_BUDGET),
    refit: (room: number) => timelineDetail(lines, room),
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

  const lines = rows
    .slice(0, EVIDENCE_ITEMS_MAX)
    .map(
      (e) =>
        `- 《${trunc(e.name, EVIDENCE_NAME_MAX)}》｜${e.category}｜${e.status}｜证明目的：${
          e.prove_purpose ? trunc(e.prove_purpose, EVIDENCE_PURPOSE_MAX) : '用户未填'
        }`,
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
    heading: '证据',
    stat: [
      `- 证据共 ${rows.length} 条〔文件名/类别已核验；证明目的是用户自述待核实〕`,
      `- 分类计数（0 条的类别也列出来——"合同 0" 正是最容易被脑补成"有"的那种事实）：${counts}` +
        (unknown > 0 ? ` / 枚举外分类 ${unknown}` : ''),
      EVIDENCE_DISCLAIMER,
    ].join('\n'),
    detail: [
      ...kept,
      ...(rows.length > kept.length ? [trimmedNote(rows.length, kept.length)] : []),
    ],
  };
}

// ========== 组装与预算 ==========

/** 取值 + 标注来源，不做裁剪（裁剪归 renderCaseFacts）。 */
export function buildCaseFacts(s: CaseSnapshot): FactCard {
  return {
    header: HEADER,
    sections: [
      identitySection(s),
      caseHeadSection(s),
      historySection(s),
      deadlineSection(s),
      employmentSection(s),
      companySection(s),
      actionSection(s),
      claimSection(s),
      timelineSection(s),
      evidenceSection(s),
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
