// app/src/lib/cases/stages.ts
// 案件阶段词表。**单独一个文件、零 import**：既要给服务端领域层用，
// 又要给客户端（首诊页按阶段取那三件事）用——放在 lib/cases/index.ts 里的话，
// 客户端引一个词表会连带把整个 lib/db 拖进浏览器包。

/** 与 migrate.ts cases.stage 注释逐字对齐 */
export const CASE_STAGES = [
  '风声',
  '约谈中',
  '已收通知',
  '已解除',
  '仲裁准备',
  '已立案',
  '开庭',
  '裁决',
  '一审',
  '二审',
  '执行',
  '结案',
] as const;

export type CaseStage = (typeof CASE_STAGES)[number];
