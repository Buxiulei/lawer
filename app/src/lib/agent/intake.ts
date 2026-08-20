// app/src/lib/agent/intake.ts
// 问诊状态机（charter §4）：A 基本盘 → B 事态进展 → C 目标底线 → D 特殊保护 → done。
//
// 【设计要点】A/B/C 三档**从案件档案推出来，不存游标**。
// 理由是这两者必须永远一致：另存一个游标就会出现「游标说 C 已完成、但 cases.goal 是空的」
// 这种档案与状态打架的情形，而用户看到的永远是档案。推导式没有这个失配空间，
// 顺带还让它成了纯函数——15 个评测剧本的问诊行为可以完全离线断言。
//
// 只有 D 档例外，必须落痕：用户答「我没怀孕也没工伤」时档案里什么都不会变，
// 但这一问确实已经完成，推不出来。落点是 threads.intake_stage（WS1 2026-08-19 增列），
// 由 intake_done 工具写入。
//
// 每一档的完成判据都刻意选了**档案里看得见的东西**，且与 spec §8 的 agent 验收标准对齐
// （「首诊后自动建档：时间线≥3 事件、诉求初算、行动卡≥3」）。
import type { CaseSnapshot } from './snapshot';

export type IntakeStage = 'A' | 'B' | 'C' | 'D' | 'done';

/** B 档的完成线：时间线攒够 3 条事件（spec §8 验收标准同一个数） */
export const TIMELINE_DONE_THRESHOLD = 3;

/**
 * 当前该问哪一档。顺序判定，第一个没完成的档就是当前档。
 *
 * A 基本盘：连是哪家公司、发生过什么都不知道，什么都谈不了。
 * B 事态进展：单条事件说明不了「走到哪一步了」，够 3 条才拼得出时间线骨架。
 * C 目标底线：goal 与 bottom_line 是谈判与文书全程的锚（migrate.ts cases 注释），缺一不可。
 * D 特殊保护：孕产/工伤/医疗期/临近退休这类情形改变全部结论，必须显式问过一次。
 */
export function intakeStage(s: CaseSnapshot): IntakeStage {
  if (s.companies.length === 0 || s.timeline.length === 0) return 'A';
  if (s.timeline.filter((e) => e.kind !== '系统动作').length < TIMELINE_DONE_THRESHOLD) return 'B';
  if (!s.case.goal || !s.case.bottom_line) return 'C';
  // D 档是档案里推不出来的那一档（用户答「我没怀孕也没工伤」时什么表都不会变），
  // 只认 threads.intake_stage 的落痕（WS1 2026-08-19 增列）。
  if (s.storedIntakeStage !== 'done') return 'D';
  return 'done';
}

/** 每档要问到的东西。写进 system prompt 供模型挑 1-3 个最关键的问，不是让它照单全问。 */
const STAGE_CHECKLIST: Record<Exclude<IntakeStage, 'done'>, { name: string; items: string[] }> = {
  A: {
    name: '基本盘',
    items: [
      '签劳动合同的公司全称（与工资发放主体、实际用工主体是否同一家）',
      '入职日期与当前是否已离职（离职日期）',
      '岗位、工作地点（合同约定地点与实际办公地点）',
      '月工资构成（基本/绩效/补贴，税前应发口径）与发薪日',
      '有无书面劳动合同、社保是否正常缴纳',
    ],
  },
  B: {
    name: '事态进展',
    items: [
      '公司到目前为止做了哪些动作（约谈/调岗/停权限/发通知/催签），各在哪天',
      '有没有拿到书面文件，文件叫什么、写了什么理由',
      '自己已经做过什么回应（签过什么、说过什么、发过什么）',
      '现在的处境（还在岗/在家等/已被停发工资）',
    ],
  },
  C: {
    name: '目标底线',
    items: [
      '最想要的结果（拿钱走人 / 保住工作 / 要个说法）',
      '最低能接受的条件（金额底线、时间底线）',
      '能扛多久（经济与精力上的承受期限）',
    ],
  },
  D: {
    name: '特殊保护情形',
    items: [
      '孕期/产期/哺乳期',
      '工伤、职业病或正在医疗期内',
      '在本单位连续工作满 15 年且距法定退休不足 5 年',
      '工会成员/职工代表、或曾举报公司违法',
      '非全日制、劳务派遣、外包等特殊用工形态',
    ],
  },
};

/**
 * 本轮问诊指令。charter §4：每轮只问 1-3 个最关键的问题，禁止问卷式轰炸。
 * 这条上限写死在指令里而不是靠模型自觉——C04 的 G7 是逐条硬断言。
 */
export function intakeDirective(stage: IntakeStage): string {
  if (stage === 'done') {
    return [
      '【问诊状态：首诊清单已走完】档案基本盘、事态、目标底线、特殊保护情形均已落档。',
      '本轮不做例行问诊，只在出现新事实、或已有档案与用户所述矛盾时才追问（同样 ≤3 问）。',
    ].join('\n');
  }
  const { name, items } = STAGE_CHECKLIST[stage];
  const lines = [
    `【问诊状态：${stage} ${name}】本轮的问诊重点在这一档。清单：`,
    ...items.map((t, i) => `  ${i + 1}. ${t}`),
    `纪律（charter §4）：从上面挑**最关键的 1-3 个**问，问完即止；已经知道的不要再问一遍。`,
    '用户先倒情绪时，先接住情绪再问；情绪极重时本轮可以一个问题都不问。',
    '把用户答案当轮落档：事件走 timeline_add，金额要素走 claims_upsert，公司主体走 company_profile_upsert。',
  ];
  if (stage === 'C') {
    lines.push('用户说出目标或底线后，调 case_update 之外没有别的落点——本轮先把原话完整写进正文，并追问到具体数字/条件。');
  }
  if (stage === 'D') {
    // D 档没有「档案里自然留痕」的落点：用户答「我没怀孕也没工伤」时什么表都不会变，
    // 但这一问确实已经完成。所以要求模型显式调工具落痕（写 threads.intake_stage）。
    lines.push(
      '用户答复特殊保护情形后（无论有没有），调 intake_done 记一笔，summary 写用户的答复摘要。' +
        '记上这一笔，首诊清单即告走完；不记的话下一轮还会再问一遍同样的问题。',
    );
  }
  return lines.join('\n');
}

/**
 * 陪跑/补充问诊的开场前情提要（charter §4 末条）。
 * 给的是**素材**不是成稿：让模型用自己的话说一句，而不是拼接出机器味的模板句。
 */
export function recapBrief(s: CaseSnapshot): string {
  const lines = [`案件当前阶段：${s.case.stage}。`];
  if (s.openActions.length) {
    lines.push(`上次留下的待办还有 ${s.openActions.length} 件未完成：${s.openActions.map((a) => a.title).join('；')}。`);
  } else if (s.closedActions.length) {
    lines.push(`上次留下的待办已全部处理完（最近：${s.closedActions.map((a) => a.title).join('；')}）。`);
  } else {
    lines.push('目前没有跟踪中的待办。');
  }
  if (s.deadlines.length) {
    lines.push(`生效中的期限：${s.deadlines.map((d) => `${d.kind} 到 ${d.due_at}`).join('；')}。`);
  }
  return [
    '【开场前情提要（charter §4）】先用一句话把下面这些说给用户听并请他确认有无偏差，再进正题：',
    ...lines.map((l) => `  · ${l}`),
    '未完成的待办要问障碍，不要指责（charter §9）。',
  ].join('\n');
}
