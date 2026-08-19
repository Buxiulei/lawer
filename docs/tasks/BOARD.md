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

## 检查点快照（2026-08-19 额度临界）
- 已合并 PR：#1 scaffold+crypto / #2 29表 / #3 auth+notify / #5 sidecar+deploy / #6 llm路由 / #7 52知识卡 / #8 billing账本+费率种子。main 全绿。
- PR #9 已合并（清理后复验 315测试+tsc 干净）：api_keys 鉴权+手写 MCP+7 工具+REST。calc_json 类型已批准。WS3 五大页面已合入 ws/frontend（build 零报错），最后一波页面在途今天内提 PR。
- 在途（各分支持久化，不怕掉线）：WS2 三线=lib/agent（C04验收+PII脱敏+反向还原）、MCP骨架、evidence链，另带 otp/sms 的 nowSql 收尾；WS1 calc 纯函数首批（类型先送审）；WS4 A09+A04 约70卡+loader；WS3 三分支（骨架已好，intake-evidence 完成待复核，workbench/docs-drafts 在途）→合并集成→最后一波页面→PR。
- 等用户：Anthropic key、服务器选址、退款A案终审、知乎cookie（可选）、援助律师问诊单（公司名→触发调研员公司调查）。
- 上线前 OPS：两通人工电话核验、LAWER_DATA_KEY 异地备份登记（值已在 .secrets-backup/）。

## 已完成
- 2026-08-19 PR #10 合并：evidence 链（上传/去重/加密/TSA固化/存证订单/验证）+ fromSql 时区修复（canonical 无时区标记裸解析漂移8h的真坑）+ otp 切 toSql，349 测试绿
- 2026-08-19 PR #7 合并：52 张知识卡（SOP27/计算10/数据5/法条4/模板4/话术2），534号单点事实源卡逐字对照官方PDF；C03 资源定案落卡
- 2026-08-19 调研员：C04 评测场景集（15剧本+8全局断言，定为 lib/agent 验收基准）结项，转 C05 法务文书三件草稿
- 2026-08-19 PR #5 合并：sidecar（TSA/PAdES/OCR/ASR，GlobalSign 真通路）+ deploy 三件套（仅 Caddy 暴露端口），22 pytest 绿
- 2026-08-19 manager：律师 agent 行为准则 v1.0 供稿（docs/agent/lawyer-agent-charter.md）；MCP五工具归属裁决（calc→WS1、knowledge→WS4、agent/evidence→WS2）
- 2026-08-19 PR #3 合并：auth（OTP双验证/JWT/限流四规则）+notify（短信/邮件+中性文案层），69测试绿；ADR-002 时间戳约定
- 2026-08-19 WS5-2：C01 四家模型官方定价核定（curl原始页取数）、C02 公司调查SOP 13渠道验活（gsxt等政务源服务器代查不可行→产品形态改"清单+用户自查+回传解读"）
- 2026-08-19 WS5：A05 律师实务65源、A04b 判例核实91项零编造、A13 朝阳官方实操+官方模板37件、534号解答官方PDF、插单7项基数口径全办结
- 2026-08-19 PR #1 合并（scaffold+crypto）；PR #2 合并：29 表全量 schema（4处评审修订落地，28测试绿）
- 2026-08-19 原12维度调研 workflow 停止（A05 一路挂起，产出已被 WS5 超越）
- 2026-08-19 manager：12维度调研~150万字落盘 research/raw/；问爻计费+NBDpsy基建调查存档 research/synthesis/；spec v1.0 批准入库
