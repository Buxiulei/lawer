// app/src/lib/knowledge/types.ts
// 知识卡类型枚举的**唯一真源**。零 import，只有常量——检索器、站内 agent 的工具 schema、
// MCP 的工具 schema 三处共用这一份。
//
// 【为什么要收成一份】此前这十类各处手抄：lib/agent/tools.ts 的 AGENT_TOOLS 一份、
// lib/capabilities/families/knowledge.ts 一份、lib/knowledge 的 TYPE_TIEBREAK 又一份。
// 抄漏的形态是**静默的**：库里有 218 张卡，其中 7 张审查规则、2 张方法卡；
// 三份枚举都只列到 8 类，于是「按 type 检索审查规则」在 MCP 那侧根本传不进去
//（enum 里没有这个值），而检索器照常返回 200 与一个空 packs 数组——
// 没有任何一处会报错，只是那两类卡在工具面上不存在。
//
// 【怎么加一类】只改这里：加进 KNOWLEDGE_TYPES，并在 TYPE_TIEBREAK 里给它排位
//（两处一致由 __tests__/types.test.ts 机检）。

/**
 * 知识卡的十类。取值与 knowledge/index.json 里 `type` 字段的实际取值一一对应
 *（同源判据：__tests__/types.test.ts 拿 index.json 实测比对，多一类少一类都红）。
 */
export const KNOWLEDGE_TYPES = [
  '法条卡',
  '判例卡',
  '计算规则',
  '流程SOP',
  '文书模板',
  '话术卡',
  '情绪指南',
  '数据卡',
  '审查规则',
  '方法卡',
] as const;

export type KnowledgeType = (typeof KNOWLEDGE_TYPES)[number];

/**
 * 同分时的类型优先序（依据优先）：agent 的重要结论必须引法条/算法依据（charter §3），
 * 所以法条卡、计算规则先于案例与话术出现；判例是佐证不是依据，排后。
 *
 * 【新增两类的排位理由】
 * - **审查规则**排在数据卡之后、流程SOP之前：它是「拿到一份文件该挑什么毛病」的
 *   判据清单，与法条/计算规则同属**依据**，不是操作步骤。
 * - **方法卡**排**最后**：它讲的是「这套知识库自己该怎么用」（如核心条映射），
 *   是给 agent 看的元知识，不是给用户的依据。同分时它挤掉一张真依据是纯损失。
 */
export const TYPE_TIEBREAK: readonly string[] = [
  '法条卡',
  '计算规则',
  '数据卡',
  '审查规则',
  '流程SOP',
  '文书模板',
  '话术卡',
  '判例卡',
  '情绪指南',
  '方法卡',
];

/** 类型在优先序里的位次；不认识的类型排在所有已知类型之后（而不是排到最前） */
export function typeRank(type: string): number {
  const i = TYPE_TIEBREAK.indexOf(type);
  return i < 0 ? TYPE_TIEBREAK.length : i;
}
