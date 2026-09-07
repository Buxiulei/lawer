// app/src/lib/cases/intake-params.ts
// 首诊提交的**请求体参数名 → 内部键**对照表。**单独一个文件、零 import**，
// 理由与同目录的 stages.ts / milestones.ts 相同：首诊页（客户端）也要按它拼请求体，
// 而页面引 lib/cases/intake.ts 会把整个 lib/db 拖进浏览器包。
//
// 【为什么要有这份表】首诊提交这条路上「body 上叫什么」原先只写在 REST 路由里的一段
// 手抄清单（`stage: body.stage, company_name: body.company_name, …`）。手抄的形态是：
// 领域包的 intakeSchema 多了一个字段，页面老老实实把它填进请求体，
// **路由不读它、也不报错**——用户填的那一格一路消失，回包还是 201。
// 收成一份之后，路由按它读、页面按它拼、判据按它核对「每个领域包的每个首诊字段都有人接」
// （见 lib/cases/__tests__/intake-params.test.ts），三处不再各写一遍。
//
// 【为什么不直接用 intakeSchema 的 param】那一列是 **MCP 面**的参数名，与 REST 面不总是同名：
// 月工资对 MCP 收「元」（monthly_wage_yuan，换算在能力壳里做），对 REST 收「分」
// （monthly_wage_fen）。拿 param 当 body 键的形态是：REST 调用方按工具清单填 yuan，
// 服务端读 fen 读到 undefined，于是回一句「月工资要填一个大于 0 的数字」——
// 而他明明填了。两个面各有各的名字是事实，这份表记的是 REST 这一面。

/**
 * REST 首诊路由认的 body 键 → IntakeInput 上的字段名。
 * **值这一列就是「这条路能接住哪些首诊字段」的全集**，判据按它核对领域包。
 */
export const INTAKE_BODY_PARAMS = {
  stage: 'stage',
  company_name: 'companyName',
  employed_from: 'employedFrom',
  monthly_wage_fen: 'monthlyWageFen',
  position: 'position',
  contract_count: 'contractCount',
  events: 'events',
  free_text: 'freeText',
  company_docs: 'companyDocs',
  company_wording: 'companyWording',
  goals: 'goals',
  bottom_line: 'bottomLine',
} as const;

export type IntakeBodyParam = keyof typeof INTAKE_BODY_PARAMS;
export type IntakeFieldKey = (typeof INTAKE_BODY_PARAMS)[IntakeBodyParam];

/** 内部键 → REST body 键。页面按 intakeSchema 拼请求体时走它。 */
export const INTAKE_PARAM_OF_KEY: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(INTAKE_BODY_PARAMS).map(([param, key]) => [key, param]),
);
