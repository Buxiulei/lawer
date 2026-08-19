# 任务板（只读看板：manager 根据各窗口汇报统一维护，其他分支不要改本文件）

> 汇报三件套：状态（开发中/自测中/待审）+ 量级预估（一小时内/今天内/明天）+ 需配合事项
> 契约变更（表结构/API/目录/费率）必须先问 manager

| WS | 窗口 | 任务 | 分支 | 状态 | 预估 | 需配合 |
|----|------|------|------|------|------|--------|
| WS1 | 数据表管理 | schema+migrate+公道值账本移植+对账脚本 | ws/db | 开发中（表结构PR今天内，billing明天内） | 今天内 | - |
| WS2 | 后台技术 | app骨架+auth(OTP/邮箱)+sidecar(TSA/PAdES/OCR/ASR)+llm路由+MCP/API | ws/backend | 开发中（scaffold+crypto已并入main；sidecar/auth/llm在途） | 今天内 | MCP依赖WS1表结构；Claude key待用户 |
| WS3 | 前端页面 | 对话工作台+档案面板+证据页+移动端(先mock后接) | ws/frontend | 开发中（设计已定，首批页面在途） | 今天内 | 待rebase到main骨架 |
| WS4 | 执行者 | research→knowledge packs 编译+文书模板库 | ws/knowledge | 开发中（规范v1.0已批，批量编译A07+A03中） | 今天内 | 待核实项走WS5 |
| WS5 | 调研员 | A05律师帖补齐+判例案号核实+朝阳实操细节 | 本地research/ | 开发中（批次1核实17/19；插单534号已交付） | 今天内 | - |
| - | 援助律师 | 用户本人案件陪跑（不写代码） | - | 已委任，待用户问诊 | - | 需求转发manager |

## 已完成
- 2026-08-19 manager：12维度调研~150万字落盘 research/raw/；问爻计费+NBDpsy基建调查存档 research/synthesis/；spec v1.0 批准入库
