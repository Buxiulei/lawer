// app/src/lib/cases/issue-table.ts
// **争点表**（设计稿 §3 中间产物链 `element_sheet` → `issue_table`）。
//
// ───────────────── ⚠️ 本文件是共用层 ⚠️ ─────────────────
// 不得出现任何具体领域的字面量（守卫：lib/capabilities/__tests__/registry-guard.test.ts
// 的 SHARED_FILES 名单点着本文件）。争点的**措辞模板**在这里是通用的，
// 每一行里那些行当名词（要件名、该拿什么去证、对方那份书面决定叫什么）
// 全部原样来自要件卡（DomainPack.elementCards），本文件一个都不认识。
// ─────────────────────────────────────────────────────
//
// 【它解决的是什么】"这一轮到底在争什么"此前只活在模型每一轮的自由发挥里：同一个案子
// 这一轮说争的是 A，下一轮说争的是 B，两轮都言之凿凿，而没有任何一处能说出"为什么它是争点"。
// 争点表是**从要件表机械派生**的那一份：三条规则，每一行都留着它是被哪条规则捞进来的。
// 判据（设计稿 §1.2「争点回声」）因此才能成立——正文提到的争点 ⊆ 争点表，
// 多出来的就是发明争点，少了的就是漏答。
//
// 【为什么是纯函数】同一张要件表 + 同一份档案标记恒得同一张争点表：不看时间、不看模型、不查库。
// 掺一点运行时状态进来的形态是——回放同一轮对话得到不同的争点表，于是"模型发明了争点"
// 与"派生逻辑当时给了这条"再也分不开。
import {
  representativeElementIds,
  resolveSlot,
  type Burden,
  type ElementFactsView,
  type ElementRow,
  type ElementStatus,
} from './elements';

/**
 * 一行争点是被哪条规则捞进来的。**逐条留痕，不合并成一个 boolean**：
 * 三条规则的下一步动作完全不同（补证 / 回应对方的说法 / 把对方的书面依据固定下来），
 * 合并的形态是争点表上每一行都对，而用户不知道该干什么。
 *
 * · element_unsettled     —— 这个要件还没成立（缺失 / 成立·待证 / 不成立）。
 *                            **「任选其一」分组里只算代表行**：同组另一条路已经走通了，
 *                            这一条的「缺失」＝〔那条路你没走〕，不是争点
 *                            （见 lib/cases/elements.ts 的 representativeElementIds）。
 * · counterparty_asserted —— 对方就这个要件主张过什么（对方的说法与我方事实分开存，
 *                            见 §1.3「顺着用户的错误前提走」那一行）。
 * · burden_on_other_side  —— 举证责任**整条**在对方（对方举证 / 限定事项的倒置），
 *                            而档案里已经有对方的书面决定：那份决定里写的理由就是庭上要打的那一点。
 */
export const ISSUE_REASONS = [
  'element_unsettled',
  'counterparty_asserted',
  'burden_on_other_side',
] as const;
export type IssueReason = (typeof ISSUE_REASONS)[number];

/**
 * 规则三只认这两个编码：**举证责任整条落在对方**的那两种。
 *
 * 【为什么 reversed_procedure_rules（证据偏在）不在里面】规则三给的下一步是
 * 「把他那份书面决定与上面写的理由原样固定下来」——那句话只有在"这件事该由对方证"时成立。
 * 偏在讲的是另一件事：一般规则仍是谁主张谁举证，只不过**那份记录**在对方手里、
 * 他应当提供、不提供的承担不利后果。把它一起捞进来的形态是：
 * 档案里随便有一份公司文件，「计算基数（工资流水）」也进争点表并被指示去固定那份书面决定——
 * 而那份决定上一个字都不会写工资基数，用户照着做等于白跑一趟。
 */
const DECISION_BURDENS: readonly Burden[] = ['respondent', 'reversed_interpretation'];

export interface IssueRow {
  /** 稳定 id = 要件 id（一个要件最多一行争点）。报告与正文按它对账，不认中文措辞 */
  id: string;
  /** 属于哪一项诉求（原样取自要件行） */
  claimKind: string;
  /** 争点，用户可见。行当名词全部来自要件卡 */
  issue: string;
  /** 被哪几条规则捞进来的（≥1 条，按 ISSUE_REASONS 的顺序） */
  reasons: readonly IssueReason[];
  status: ElementStatus;
  burden: Burden;
  /** 对应核心条锚点（原样取自要件卡 basis），供引用块与报告「依据清单」对账 */
  anchors: readonly string[];
  /**
   * 出路，用户可见。**恒非空**——判据「争点 → 行动卡/追问 链接率 100%」钉的就是这一列
   *（设计稿 §7.7 禁令配出路：说了"这一项立不住"就必须同时说"那先做什么"）。
   */
  nextStep: string;
  /** 还差哪几个槽（缺失行非空），供行动卡与追问定位 */
  missingSlots: readonly string[];
}

export interface IssueTable {
  rows: readonly IssueRow[];
  /**
   * 渲染不渲染。要件表整节不渲染（本领域还没有要件卡 / 本案一项诉求都没有）时为 false——
   * 与要件表同一条纪律：渲染一张零行的争点表，用户读到的是"本案没有争议"，
   * 而真相是"这套东西还没接上"。
   */
  rendered: boolean;
}

/**
 * 派生争点表要的、要件表之外的那两样档案标记。
 *
 * 【为什么它们是入参而不是在这里查库】本函数是纯函数（见文件头）；这两样怎么从档案里读出来
 * 由调用方按领域包的声明去做（`DomainPack.counterpartyDecisionSlot`），
 * 那是行当知识，不该长在共用层。
 */
export interface IssueTableMarks {
  /**
   * 对方就这几个要件主张过什么（要件 id → 对方的说法，逐字）。
   *
   * 【它现在多半是空的，这是实情不是遗漏】档案里还**没有**独立的「对方主张」槽位
   *（设计稿 §1.3 要求它与事实槽分开存，那是另一片的事）。入参先留在这里，
   * 是因为规则二的判定必须落在一个**结构化字段**上：先接一个"暂时总是空"的入参，
   * 与先用模型每轮现判、日后再改结构，是两种完全不同的失效方式——
   * 后者在接上真字段之前，每一轮都在无声地发明争点。
   */
  counterpartyAssertions?: Readonly<Record<string, string>>;
  /**
   * 档案里已经有对方的**书面决定**（那张写着理由的纸）。规则三的第二个条件。
   *
   * 【为什么规则三要这个条件，而不是"举证责任在对方就报争点"】举证责任在对方是**常态**，
   * 不加条件的形态是：每一项这类要件永远挂在争点表上，争点表因此永远读不完，
   * 于是它和没有争点表是同一个东西。有了对方的书面决定，才有"那张纸上写的理由"这个
   * 具体的、打得着的靶子。
   */
  counterpartyDecisionOnFile?: boolean;
}

/**
 * 对方那份书面决定在不在档（规则三的第二个条件）。**唯一入口**。
 *
 * 【为什么它在这里，而不是在两个调用方各写一遍】此前报告（lib/cases/report.ts）与
 * 要件族能力（lib/capabilities/families/elements.ts）各有一份同形的三行判断。
 * 两份同形代码的失效方式是：判据钉住其中一份，另一份被改坏了没有任何东西会红——
 * 复审第三条点的正是这个（把 report 那份换成常量 `true`，report-derived 仍 9/9 绿）。
 *
 * @param slot 领域包声明的 `counterpartyDecisionSlot`。**共用层不认识它在某个行当里叫什么**，
 *   所以这里只收一个槽串；省略（领域没声明）⇒ 恒 false，规则三整条不生效。
 * @param facts 与要件表**同一份**档案子集：绕开 resolveSlot 自己写一遍"这个槽有没有被填上"的形态是，
 *   那份判断与要件表用的不是同一把尺，于是规则三会在要件表说"缺"的时候说"在档"。
 */
export function counterpartyDecisionOnFile(
  slot: string | undefined,
  facts: ElementFactsView,
): boolean {
  if (slot === undefined) return false;
  return resolveSlot(slot, facts) != null;
}

/** 出路那一句的通用模板。行当名词由调用方从要件卡带进来，这里只管句式。 */
function nextStepOf(row: ElementRow, reasons: readonly IssueReason[]): string {
  const evidence = row.typicalEvidence.filter((e) => e.trim()).join('、');
  // 【补什么恒有话说】typicalEvidence 由 assertDomainPack 保证非空；万一某张卡漏了，
  // 这里也不许交出一个空串——空的出路与"没有出路"在页面上长得一模一样。
  const fallback = '先把这一项的书面材料找出来上传；确实一张都没有的，如实说，不要用"应该有"代替"已经有"。';
  const supply = evidence ? `补：${evidence}。` : fallback;

  if (row.status === '缺失') {
    return `档案里还没有这一项的记录（不是"没有这回事"）。${supply}`;
  }
  if (row.status === '成立·待证') {
    return `这一项目前只有你自己的说法，庭上撑不住。${supply}`;
  }
  if (row.status === '不成立') {
    return `档案里有一份材料指向相反的结论，先把它调出来看清楚写的是什么，再决定这一项还提不提。${supply}`;
  }
  // 状态是「成立」还进了争点表 ⇒ 只可能由规则二或规则三捞进来
  if (reasons.includes('counterparty_asserted')) {
    return `这一项你这边是立得住的，争的是对方那套说法。把对方原话与你的反证并排列出来。${supply}`;
  }
  return `这一项按法律该由对方举证。你要做的不是替他证，而是把他那份书面决定与上面写的理由原样固定下来。${supply}`;
}

/** 争点那一句。同样只管句式。 */
function issueOf(row: ElementRow, marks: IssueTableMarks): string {
  const asserted = marks.counterpartyAssertions?.[row.id];
  if (asserted && asserted.trim()) {
    return `${row.name}——对方的说法是「${asserted.trim()}」`;
  }
  return row.name;
}

/**
 * 要件表 → 争点表。三条规则，命中任意一条即入表。
 *
 * @param rows 要件表的行（buildElementSheet 的产出）
 * @param marks 档案侧的两个标记，见 IssueTableMarks
 * @param rendered 要件表渲染不渲染。false 时争点表同样不渲染（不是"没有争点"）
 */
export function buildIssueTable(
  rows: readonly ElementRow[],
  marks: IssueTableMarks = {},
  rendered = true,
): IssueTable {
  if (!rendered) return { rows: [], rendered: false };

  // 【规则一按"任选其一"分组取代表行】互斥的几条路径里，已经有一条走通时，
  // 另一条的「缺失」不是争点：把它捞进来的形态是——一个拿着《解除通知》的用户
  // 在争议焦点里读到「路径二（你依照第三十八条被迫解除）：缺失」，
  // 于是去准备一份他从来没发过、也不需要发的通知书。
  // 规则二、三不看分组：对方主张过什么、对方那份书面决定在不在档，与走哪条路无关。
  const represents = representativeElementIds(rows);

  const out: IssueRow[] = [];
  for (const row of rows) {
    const reasons: IssueReason[] = [];
    if (row.status !== '成立' && represents.has(row.id)) reasons.push('element_unsettled');
    const asserted = marks.counterpartyAssertions?.[row.id];
    if (asserted !== undefined && asserted.trim() !== '') reasons.push('counterparty_asserted');
    if (marks.counterpartyDecisionOnFile === true && DECISION_BURDENS.includes(row.burden)) {
      reasons.push('burden_on_other_side');
    }
    if (reasons.length === 0) continue;
    out.push({
      id: row.id,
      claimKind: row.claimKind,
      issue: issueOf(row, marks),
      reasons,
      status: row.status,
      burden: row.burden,
      anchors: row.basis.map((b) => b.anchor).filter((a) => a.trim() !== ''),
      nextStep: nextStepOf(row, reasons),
      missingSlots: row.missingSlots,
    });
  }
  return { rows: out, rendered: true };
}

/**
 * 报告里那两节的**派生条目标记**：`〔争点 <id>〕`。
 *
 * 【为什么条目要带一个机器认得的记号】那两节允许模型改措辞（把机械句式写成人话），
 * 但不许增删条目——增一条就是发明争点，删一条就是漏答。判定"有没有增删"必须落在
 * 一个**不随措辞变**的东西上；靠比对整段文本的形态是：模型换一个说法，服务端判成"改了条目"，
 * 于是这道闸要么天天误报、要么被关掉。
 */
export function issueMarker(id: string): string {
  return `〔争点 ${id}〕`;
}

/** 一段文本里出现过的派生条目 id 集合（顺序不计）。 */
export function issueMarkersIn(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/〔争点\s*([^〕\s]+)\s*〕/g)) out.add(m[1]);
  return out;
}
