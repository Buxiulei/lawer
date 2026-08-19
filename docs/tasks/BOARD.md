# 任务板（只读看板：manager 根据各窗口汇报统一维护，其他分支不要改本文件）

> 汇报三件套：状态（开发中/自测中/待审）+ 量级预估（一小时内/今天内/明天）+ 需配合事项
> 契约变更（表结构/API/目录/费率）必须先问 manager

| WS | 窗口 | 任务 | 分支 | 状态 | 预估 | 需配合 |
|----|------|------|------|------|------|--------|
| WS1 | 数据表管理 | schema+migrate+公道值账本移植+对账脚本 | ws/billing | 表结构已合并(PR#2)；billing移植中 | 明天内 | - |
| WS2 | 后台技术 | app骨架+auth(OTP/邮箱)+sidecar(TSA/PAdES/OCR/ASR)+llm路由+MCP/API | ws/backend | 开发中（scaffold+crypto已并入main；sidecar/auth/llm在途） | 今天内 | MCP依赖WS1表结构；Claude key待用户 |
| WS3 | 前端页面 | 对话工作台+档案面板+证据页+移动端(先mock后接) | ws/frontend | 开发中（设计已定，首批页面在途） | 今天内 | 待rebase到main骨架 |
| WS4 | 执行者 | research→knowledge packs 编译+文书模板库 | ws/knowledge | 开发中（规范v1.0已批，批量编译A07+A03中） | 今天内 | 待核实项走WS5 |
| WS5 | 调研员 | WS5-2 结项（C01定价/C02公司调查SOP）→ C03 求助资源核实 | 本地research/ | 进行中 | 今天内 | - |
| - | 援助律师 | 用户本人案件陪跑（不写代码） | - | 已委任，待用户问诊 | - | 需求转发manager |

## 已完成
- 2026-08-19 WS5-2：C01 四家模型官方定价核定（curl原始页取数）、C02 公司调查SOP 13渠道验活（gsxt等政务源服务器代查不可行→产品形态改"清单+用户自查+回传解读"）
- 2026-08-19 WS5：A05 律师实务65源、A04b 判例核实91项零编造、A13 朝阳官方实操+官方模板37件、534号解答官方PDF、插单7项基数口径全办结
- 2026-08-19 PR #1 合并（scaffold+crypto）；PR #2 合并：29 表全量 schema（4处评审修订落地，28测试绿）
- 2026-08-19 原12维度调研 workflow 停止（A05 一路挂起，产出已被 WS5 超越）
- 2026-08-19 manager：12维度调研~150万字落盘 research/raw/；问爻计费+NBDpsy基建调查存档 research/synthesis/；spec v1.0 批准入库
