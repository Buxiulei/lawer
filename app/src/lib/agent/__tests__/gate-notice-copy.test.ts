// app/src/lib/agent/__tests__/gate-notice-copy.test.ts
//
// 【三道出口闸对用户说的话里，不许出现我们自己的东西的名字】
//
// ─────────────── 这组补的是哪个缺口 ───────────────
// 出路话术 v1 落地时，⑥ 的出路句写的是「我用 citation_check 把原文取回来」，
// ⑨ 写的是「我用 claim_calc 按你档案里的入职日期与工资重算一遍」「以 claim_calc 的算式为准」。
// 那两个词是**我们内部的工具名**：读到它的人刚被告知"这一处的依据有问题"，
// 紧接着看到一个他从没见过的英文标识符——他既不知道那是什么，也无从判断该不该信它。
// 更实际的形态是：工具改了名（真发生过一次，见 tools.ts 的能力表），
// 用户面上这几句话仍在报一个已经不存在的名字，而**渲染、判据、类型检查一处都不会红**。
//
// 【为什么按形态扫，而不是列一张工具名的黑名单】黑名单要有人在加工具时记得更新它，
// 而"忘了更新"与"没有违规"在输出上完全同形。`snake_case` 是这个仓里标识符的统一写法
//（工具名、能力名、事件码的小写形态、数据库列名），按形态扫等于把整类东西一次拦住。
// 代价是将来某句正当文案里出现下划线时这道闸会红——那时**把它写进 PINNED 并说明理由**，
// 而不是放宽形态：形态一放宽就没人知道它还在拦什么。
//
// 【扫描面：只扫到用户眼前的那几句】
//   · GATE_MARK_HINTS —— 正文里五个标记的悬停解释；
//   · citationNoticeMessage / statuteNoticeMessage / valueNoticeMessage —— 三条提示行的正文；
//   · SUGGEST_* —— 一键回复 chip 上的字（用户点一下就原样发出去的那句）。
// **不扫**回喂给模型的改正指令（statuteCorrectionDirective）：那一段的收件人是模型，
// 「请先用 knowledge_search 取到该条原文」正是它该说的话。把它一起扫的形态是——
// 为了让判据变绿，去把一句写给模型的话改得模型看不懂。
import { describe, expect, it } from 'vitest';

import {
  citationNoticeMessage,
  GATE_MARK_HINTS,
  GATE_MARKS,
  SUGGEST_CHECK_STATUTE,
  SUGGEST_FETCH_CURRENT,
  SUGGEST_FIND_CASE,
  SUGGEST_RECALC,
  SUGGEST_REPEAT_CALC,
  SUGGEST_USE_CARD,
} from '../gate-marks';
import { statuteNoticeMessage } from '../statute-guard';
import { valueNoticeMessage } from '../value-guard';

/**
 * 标识符的形态：小写字母段 + 下划线 + 小写字母段（`claim_calc` / `citation_check` /
 * `knowledge_search` / `gate_json`）。
 *
 * 【为什么不连大写的常量名一起收】`VALUE_UNSOURCED` 这类码只出现在**结构化字段**里
 *（notice.code、gate_json.codes），不进这几句话；而把大写也收进来会撞上正文里的
 * 中英混排（这道闸要拦的是"用户读不懂的我们的名字"，不是"出现了英文"）。
 */
const IDENTIFIER = /[a-z_]+_[a-z]+/;

/** ⑤ 的样本案号（形态取自 citation-guard 的判定面，内容是编的） */
const CITED = '（2023）京0105民初88888号';

/** ⑥ 两种判定各一条：两支的出路句完全不同，只扫其中一支等于漏掉另一支。 */
const STATUTE_VIOLATIONS = [
  { cited: '《某某某某法》第四十八条', where: '正文', verdict: 'unverified' as const },
  { cited: '《某某某某法》第四十六条', where: '正文', verdict: 'superseded' as const },
];

/** ⑨ 三支各一条（无来源 / 与卡不一致 / 与算式不一致）——三支的出路句各不相同。 */
const VALUE_VIOLATIONS = [
  { token: '60 万', kind: '金额' as const, mark: 'unsourced' as const },
  { token: '47100 元', kind: '金额' as const, mark: 'mismatch' as const, nearest: '47103.25', nearestFrom: 'card' as const },
  { token: '47100 元', kind: '金额' as const, mark: 'mismatch' as const, nearest: '47103.25', nearestFrom: 'calc' as const },
];

/**
 * 用户面上的每一句话，各带一个说得出口的名字。
 * **逐句列而不是拼成一大串**：报错里要能直接看出是哪一句犯规。
 */
const USER_FACING: Array<[string, string]> = [
  ...GATE_MARKS.map((m): [string, string] => [`GATE_MARK_HINTS[${m}]`, GATE_MARK_HINTS[m]]),
  ['citationNoticeMessage', citationNoticeMessage([CITED])],
  ['statuteNoticeMessage', statuteNoticeMessage(STATUTE_VIOLATIONS)],
  ['valueNoticeMessage(rewrite)', valueNoticeMessage(VALUE_VIOLATIONS, 'rewrite')],
  // 观察期那一支的措辞不同（不说「已标注」），它同样到得了归档与离线统计
  ['valueNoticeMessage(observe)', valueNoticeMessage(VALUE_VIOLATIONS, 'observe')],
  ...[
    SUGGEST_FIND_CASE,
    SUGGEST_CHECK_STATUTE,
    SUGGEST_FETCH_CURRENT,
    SUGGEST_RECALC,
    SUGGEST_REPEAT_CALC,
    SUGGEST_USE_CARD,
  ].map((s): [string, string] => [`SUGGEST「${s}」`, s]),
];

describe('三道闸的用户面文案里不许出现内部标识符（2026-09-10 复审 minor）', () => {
  it.each(USER_FACING)(
    '%s 里没有 snake_case 的名字（变异：把「我用 claim_calc 重算」写回去 → 红）',
    (where, text) => {
      const hit = IDENTIFIER.exec(text);
      expect(
        hit?.[0] ?? null,
        `${where} 里出现了内部标识符「${hit?.[0]}」：\n  ${text}\n` +
          '缺什么：用户读到的是一个他从没见过的英文名字，而这句话正好是在告诉他"这一处的依据有问题"。\n' +
          '为什么缺：工具名是写这句话时手边最现成的词，读起来还很具体；' +
          '而它改名那天，用户面上这句话会安静地报一个已经不存在的名字。\n' +
          '怎么办：改成不带名字的第一人称（「我去把原文取回来」「我按你档案里的数重算一遍」）。' +
          '若确认是一句正当文案而被误判，把它钉进本文件并写下理由，不要放宽 IDENTIFIER 的形态。',
      ).toBeNull();
    },
  );

  /**
   * 【自证：这把尺子真的量得出东西】写坏的正则不会报错，只会**静默永绿**——
   * 它从此谁也拦不住，而"谁也拦不住"在上面那组里的表现与"文案很干净"完全一样。
   * 这三条就是被改掉的那三句原话。
   */
  it.each([
    '我用 citation_check 把原文取回来再引给你',
    '我用 claim_calc 按你档案里的入职日期与工资重算一遍',
    '以 claim_calc 的算式为准',
  ])('尺子自证：改掉之前的那几句仍然判红「%s」', (old) => {
    expect(IDENTIFIER.test(old)).toBe(true);
  });

  it('扫描面不是空的，且三道闸各在里面（空名单会让上面那条永远绿）', () => {
    expect(USER_FACING.length).toBeGreaterThanOrEqual(12);
    for (const [, text] of USER_FACING) expect(text.trim().length).toBeGreaterThan(0);
    for (const key of ['citationNoticeMessage', 'statuteNoticeMessage', 'valueNoticeMessage(rewrite)']) {
      expect(USER_FACING.map(([k]) => k)).toContain(key);
    }
  });

  /**
   * 【反方向：写给模型的那一段不在扫描面里】这条不是豁免的登记，是**边界的自证**：
   * 它一旦变红，说明有人把回喂指令也拉进了上面那组，而修法会是把一句写给模型的话
   * 改得模型看不懂。
   */
  it('回喂给模型的改正指令不受这道闸约束（收件人是模型，不是用户）', async () => {
    const { statuteCorrectionDirective } = await import('../statute-guard');
    const directive = statuteCorrectionDirective(STATUTE_VIOLATIONS, '某某申请书');
    expect(IDENTIFIER.test(directive), '这一段本来就该点名工具').toBe(true);
    expect(USER_FACING.map(([, t]) => t)).not.toContain(directive);
  });
});
