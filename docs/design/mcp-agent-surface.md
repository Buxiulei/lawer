# MCP 工具面重设计 · 设计稿 v1

状态：**待主理人评审**（PR）。批准后按 §11 分期拆票。
起因：主理人 2026-09-05 指令——「mcp 工具需要你进行重新的设计，需要思考到 agent 在于客户进行法律咨询的交互中，所有需要用到的东西。在网页上沟通时，所有需要用到的东西，都需要具备……先做设计，写 pr，尽可能的不重不漏，再做 mcp、api、后台系统、表格、配置、skill 的完善」。
依据：现状盘点 `rd-mcp-design/inventory.md`（九块 + 十条缺口，全部带文件:行）。本文只引用结论，不重复盘点。

---

## 0. 目标与七条原则

**目标**：用户自己的 agent（任意厂商，经 MCP 或 REST）能完成站内对话里 agent 能做的一切，并覆盖劳动争议陪跑全旅程的诉求；网页退为展示与录入层。

| # | 原则 | 含义 | 现状违反处 |
|---|---|---|---|
| P1 | **单一领域层** | MCP / REST / 站内 agent 三个入口共用 `lib/cases` + `lib/db` 的同一套读写函数，工具只是薄壳；任何能力只实现一次 | 站内 10 个写工具里 8 个 MCP 没有（缺口 1） |
| P2 | **写入幂等** | 每个写工具带 `client_ref`；没带时按领域自然键去重；重放返回既有对象 + `deduped:true` | case 2 事件双写、行动卡双写 |
| P3 | **闸门在服务端** | 归属（案件必须本人）、实名（证据/出证/文书导出/分享）、余额与报价确认（耗算力动作）、危机词表（确定性首段）——一律服务端判定，不靠 agent 自觉 | 危机拦截只在站内 chat 生效（缺口 9） |
| P4 | **时间线只追加** | 更正走追加一条 `kind=更正` 事件并引用原事件 id | 已有约束，保持 |
| P5 | **计费三段式** | 读写档案免费；耗算力或外部资源的动作（背调、OCR/ASR、出证 TSA+签名、文书 PDF 导出）走 **报价→确认→扣费**，报价永远免费、确认才扣 | 出证全链路无计费（缺口 8），OCR/ASR 未接线（缺口 7） |
| P6 | **长期记忆由 agent 维护、过期由服务端管** | 个案报告（case report）是每案一份的结构化长期记忆；写入即置 stale，事实卡首行提示 | 无叙事层，档案=五张扁平表 |
| P7 | **一个注册表生成一切** | 工具注册表是唯一真源，`/api/manifest`、接入说明能力表、Claude skill 变体全部由它生成，禁止手写第二份 | manifest 漏 25 条（缺口 4），knowledge 类型枚举漏两类（缺口 5），claude-skill.md 手动同步 |

---

## 1. 旅程 × 诉求矩阵（不重不漏的依据）

行 = 用户所处阶段（与 `cases.stage` 枚举对齐，加两个前后端点）；列 = 诉求族。格子里是该阶段该诉求最常用的工具族（详见 §2）。空格表示该阶段一般不涉及。

| 阶段 \ 诉求 | A 档案与事实 | B 证据 | C 法律依据 | D 金额 | E 文书 | F 期限 | G 行动 | H 公司情报 | I 情绪与危机 | J 来文与录音 | K 身份与账户 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| S0 风闻/焦虑 | 建档 intake | 开始留存 | 知识检索 | 预估 N | — | — | 行动卡 | 公司探查 | 情绪记录 | — | 实名引导 |
| S1 约谈/施压 | 时间线、报告 | 录音、聊天记录登记 | 话术卡、SOP | N/N+1/2N | 回复邮件草稿 | — | 行动卡 | 背调报价 | 危机词表 | 来文解读、录音转写 | — |
| S2 协商 | 诉求与底线 | 证据固化 | 判例 | 全口径计算 | 异议函、协议审查 | — | 行动卡 | 关联主体 | 情绪记录 | 协议解读 | 余额 |
| S3 解除（被裁/被迫/自离） | 阶段变更、报告 | 解除通知固化 | 法条逐字 | 2N、待岗、未休年假 | 被迫解除通知书 | 时效起算 | 行动卡 | — | 危机词表 | 来文解读 | — |
| S4 仲裁前准备 | 报告定稿 | 证据清单与出证 | 判例核验 | 诉求金额登记 | 仲裁申请书 | 仲裁时效、举证期限 | 清单 | 被申请人主体 | — | — | 实名（出证/导出） |
| S5 仲裁（开庭/调解） | 时间线 | 质证 | 判例 | 调解底线 | 质证意见、代理词 | 开庭、举证 | 行动卡 | — | 情绪记录 | 录音转写 | — |
| S6 裁决后（履行/执行/起诉） | 阶段变更 | 裁决书固化 | 执行 SOP | 利息 | 执行申请、起诉状 | 起诉 15 日、申请执行 | 行动卡 | 财产线索 | — | — | — |
| S7 应诉（公司起诉） | 时间线 | 证据 | 法条 | 反请求 | 答辩状 | 答辩期 | 行动卡 | — | — | 来文解读 | — |

**不重不漏的检查方法**：§2 每个工具至少落在矩阵一个格子；矩阵每个非空格子至少被一个工具覆盖；盘点缺口 1–10 每条在 §2 或 §4 有对应条目（对照表见 §10）。

---

## 2. 工具目录（按诉求族）

约定：所有 `case_id` 入参必须为本人案件，否则统一 `CASE_NOT_FOUND`（不区分"不存在"与"不是你的"）。所有写工具接受可选 `client_ref`（同案同工具唯一）。标 ★ 的是新增，标 ↑ 的是既有工具扩展，无标记为既有不变。标 💰 的走报价确认。标 🪪 的需已实名。

### A. 档案与事实

| 工具 | scope | 读/写 | 入参 | 出参 | 幂等/去重 | 备注 |
|---|---|---|---|---|---|---|
| `case_list` | read | 读 | — | cases[{case_id,title,stage,created_at}] | — | 单案直接用，不问用户 |
| `case_get` | read | 读 | case_id, timeline_limit | 档头 + 最近时间线 | — | |
| `case_update` ↑ | write | 写 | case_id, stage?, goal?, bottom_line?, **employed_from?, monthly_wage_yuan?, position?, contract_count?** | 更新后的档头 | 幂等（同值不变） | 四项基本盘可零散补齐 |
| `intake_submit` ★ | write | 写 | 对齐 `IntakeInput`（company_name, employed_from, monthly_wage_yuan, position, contract_count, stage, events[], free_text, company_docs, company_wording, goals, bottom_line） | `IntakeResult`（与网页首诊相同） | events 按时间线去重规则 | agent 引导建档；校验失败回字段级原因 |
| `case_facts` ↑ | read | 读 | case_id | 事实卡全文；**首行状态区**：报告过期/基本盘缺项/近期危机标记 | — | 与站内每轮同一渲染函数 |
| `case_report_get` ★ | read | 读 | case_id, section? | 结构化分节 + 渲染稿 + updated_at/updated_by/stale_since/stale_reason | — | 见 §4.3 |
| `case_report_update` ★ | write | 写 | case_id, section, content, reason, base_version | 新版本号 | base_version 乐观锁 | 按节补丁；必带 reason；记 updated_by=agent(key id) |
| `timeline_add` ↑ | write | 写 | case_id, happened_at, kind, title, detail?, evidence_ids?, **client_ref?**, **corrects_event_id?** | 事件 + deduped | client_ref；无则 同案+同日+同 kind+标题规范化相等 ⇒ 复用 | `corrects_event_id` 时 kind 固定为「更正」 |
| `timeline_list` ★ | read | 读 | case_id, since?, kind?, limit | 事件列表 | — | 站内 `case_get` 只带最近 N 条，长案需分页 |
| `timeline_milestone` ★ | write | 写 | case_id, event_id, milestone:true/false | — | 幂等 | 对应 REST `POST /timeline/{id}/milestone` |

### B. 证据

| 工具 | scope | 读/写 | 入参 | 出参 | 前置 | 备注 |
|---|---|---|---|---|---|---|
| `evidence_list` | read | 读 | case_id, category? | 条目元数据 + 固化状态 + **extraction_status** | — | |
| `evidence_get` ★ | read | 读 | evidence_id, include_text? | 元数据 + 已提取文本（OCR/ASR 结果，若有）+ 证明目的 | — | 文件二进制不经 MCP；文本进对话 |
| `evidence_register` ★ | write | 写 | case_id, name, category, prove_purpose, original_medium, **upload_token** | 条目 | client_ref | 二进制走 REST `POST /evidence`（multipart）；MCP 给 `evidence_upload_url` 返回一次性上传地址与 token，agent 或用户端上传后再 register。**上传与登记都受实名闸** 🪪 |
| `evidence_upload_url` ★ 🪪 | write | — | case_id, filename, mime, size | 一次性 PUT 地址 + token（10 分钟） | 实名 | 解决 MCP 传不了大文件 |
| `evidence_extract` ★ 💰 | write | 写 | evidence_id, mode: ocr/asr | 报价 或 提取结果（见 §4.2 两步） | 实名；余额 | 走 sidecar /ocr /asr；结果落 `evidence.extracted_text` |
| `evidence_attest_quote` ★ | read | 读 | evidence_ids[] | 报价（每件 X 公道值，含 TSA+签名） | — | 出证是否计费待拍板（§9-①）；若免费，报价恒 0 但流程保留 |
| `evidence_attest` ★ 🪪 💰 | write | 写 | evidence_ids[], quote_id | 订单与状态 | 实名；余额 | 幂等（同证据不二次下单，中途失败续跑，与 REST 一致） |
| `attest_verify` ★ | read | 读 | order_no | 验签裁决 JSON | 公开 | 对应 `GET /verify/{orderNo}` |

### C. 法律依据

| 工具 | scope | 读/写 | 入参 | 出参 | 备注 |
|---|---|---|---|---|---|
| `knowledge_search` ↑ | read | 读 | query, type?（**十类全收**：法条卡/判例卡/计算规则/流程SOP/文书模板/话术卡/情绪指南/数据卡/审查规则/方法卡）, court?, stage?, limit, **full_text?** | 命中卡（默认摘要 1200 字；`full_text=true` 逐字全文，单卡上限 8000 字）+ citation_guide | 与站内同一检索器；方法卡默认不返回给用户面，但 agent 可查 |
| `knowledge_get` ★ | read | 读 | id | 单卡全文 + facts 结构化字段（statute_quotes/values/hotlines/review_rules） | 引用前必读原文 |
| `citation_check` ★ | read | 读 | citations[{law, article}] / precedent ids | 每条：库内有/无、逐字原文、核验四步结论 | 落地「判例核验四步法」方法卡为代码，杜绝编条号 |

### D. 金额

| 工具 | scope | 读/写 | 入参 | 出参 | 备注 |
|---|---|---|---|---|---|
| `claim_calc` ★ | write | 写 | case_id, kind（N/N+1/2N/未休年假/双倍工资/加班费/待岗/加付赔偿金/竞业补偿/病假工资）, inputs | 金额 + 算式 + 依据卡 id + 封顶提示；同时 upsert 到 claims | 与站内 `calcNonSeverance`/`persistCalc` 同一函数；北京封顶口径唯一定义处 |
| `claims_upsert` ★ | write | 写 | case_id, kind, amount_yuan, basis, note | 诉求 | 同案同 kind 一条 |
| `claims_list` ★ | read | 读 | case_id | 诉求清单 + 合计 | 对应事实卡「诉求金额」 |

### E. 文书

| 工具 | scope | 读/写 | 入参 | 出参 | 前置 | 备注 |
|---|---|---|---|---|---|---|
| `draft_list` ★ | read | 读 | case_id, kind? | 草稿列表（不含正文） | — | 对应 `GET /drafts` |
| `draft_get` ★ | read | 读 | draft_id | 正文 + 版本 + 发送后果 | — | |
| `draft_write` ★ | write | 写 | case_id, kind, title, body, **send_consequences**（对外 5 类必填）, based_on_draft_id? | 草稿 | client_ref；同题新版本而非新草稿 | 对外文书**服务端拒收缺 send_consequences 的请求**（P3） |
| `draft_export` ★ 🪪 💰 | write | 写 | draft_id, format: pdf | 报价 / 文件下载地址（限时） | 实名；余额 | 二期；PDF 走 sidecar |
| `share_create` ★ 🪪 | write | 写 | draft_id 或 evidence_id, expires_in | 免登录只读链接 | 实名 | 对应 `share_links` 表 |
| `template_fill` ★ | read | 读 | template_id, case_id | 用档案字段填好的模板文本（不落库） | — | 文书模板卡 + 事实卡合成，agent 再改 |

### F. 期限

| 工具 | scope | 读/写 | 入参 | 出参 | 备注 |
|---|---|---|---|---|---|
| `deadline_list` | read | 读 | case_id, include_resolved? | 期限（服务端算到期与剩余天数） | |
| `deadline_set` ★ | write | 写 | case_id, kind（仲裁时效/起诉 15 日/举证期限/开庭/答辩期/申请执行/自定义）, anchor_date, days?, note | 期限 | 同案同 kind 同 anchor 去重；举证期限必带 days |
| `deadline_resolve` ★ | write | 写 | deadline_id, outcome（已履行/作废）, note | — | 幂等 |
| `deadline_explain` ★ | read | 读 | kind, anchor_date | 该期限的法条依据、起算规则、常见误区 | 纯知识合成，不落库 |

### G. 行动

| 工具 | scope | 读/写 | 入参 | 出参 | 备注 |
|---|---|---|---|---|---|
| `action_list` | read | 读 | case_id, status? | 行动卡 | |
| `action_create` ★ | write | 写 | case_id, title, detail, due_at?, priority | 行动卡 | client_ref；同案同题待办不双建；每次调用 ≤3 张（与站内一致） |
| `action_complete` | write | 写 | action_id, status（完成/放弃）, note? | — | |

### H. 公司情报

| 工具 | scope | 读/写 | 入参 | 出参 | 前置 | 备注 |
|---|---|---|---|---|---|---|
| `company_profile_upsert` ★ | write | 写 | case_id, role（签约/用工/关联）, name, uscc?, note | 主体 | 同案同 name 一条 | |
| `company_probe` ★ | read | 读 | name | 免费概况（涉诉计数、成立、状态，走缓存） | — | 对应 `POST /company/probe` |
| `dossier_quote` ★ | read | 读 | case_id, name, blocks[] | 报价（每块价格、算式、退款承诺） | — | 报价免费 |
| `dossier_confirm` ★ 💰 | write | 写 | quote_id | 订单 + 进度 | 余额 | 会员赠送块自动抵扣（entitlements） |
| `dossier_get` ★ | read | 读 | case_id | 谱系/统计/套路/辖区卡 | — | 对应 `GET /cases/{id}/dossier` |
| `company_graph_get` ★ | read | 读 | case_id | 关系图节点与边 | — | |
| `company_watch_set` ★ 💰 | write | 写 | case_id, name, tier（199/60/0） | 守望订阅 | 余额 | 对应 `POST /cases/{id}/watch`；月费按守望三档 |

### I. 情绪与危机

| 工具 | scope | 读/写 | 入参 | 出参 | 备注 |
|---|---|---|---|---|---|
| `emotion_log` ★ | write | 写 | case_id, level, note, refer_nbdpsy? | 记录；refer 一案一次 | 与站内同频控 |
| `crisis_check` ★ | read | 读 | text | `{hit:bool, first_segment, hotlines[]}` | **服务端确定性词表**（`crisis.ts` 同一函数），命中即返回必须原样先说的首段与可用热线（forbidden 号码永不出现）。陪跑指南规定：用户每条消息先过它，命中则首段照抄 |

### J. 来文与录音（二期，依赖 OCR/ASR 接线）

| 工具 | scope | 读/写 | 入参 | 出参 | 前置 | 备注 |
|---|---|---|---|---|---|---|
| `doc_submit` ★ 💰 | write | 写 | case_id, evidence_id 或 text, doc_kind（解除通知/协议/调岗通知/其他） | 报价 / 解读（要点、风险、审查规则命中、建议） | 余额 | 落 `company_docs` + `contract_reviews`/`review_findings`（今日空表） |
| `doc_list` / `doc_get` ★ | read | 读 | case_id / doc_id | 解读结果 | — | |
| `transcript_submit` ★ 💰 | write | 写 | evidence_id（录音） | 报价 / 转写 + 说话人分离 + 要点，并建议时间线事件（不自动写） | 余额 | sidecar /asr |

### K. 身份与账户

| 工具 | scope | 读/写 | 入参 | 出参 | 备注 |
|---|---|---|---|---|---|
| `me_get` ★ | read | 读 | — | auth_status（未认证/待审/已实名）、plan、balance、storage、connected_agent | agent 据此决定要不要引导实名、提示余额 |
| `quote_list` ★ | read | 读 | case_id | 未过期报价与订单状态 | 统一看所有 💰 动作 |

**明确不进 MCP 的**：密钥管理（网页会话专属，防自我增殖）、后台管理、支付下单（无支付通道；兑换码走网页）、聊天接口本身（站内对话是兜底，不是 agent 的工具）。

---

## 3. 与站内 agent 的对齐（P1 落法）

站内 `AGENT_TOOLS`（10）与 MCP `TOOLS`（10，重设计后约 45）共用一张**能力注册表** `lib/capabilities/registry.ts`：每条 = {name, family, scope, kind: read|write|spend, precondition: [], idempotency, handler(db, identity, args), rest: {method, path}, doc}。

- 站内 orchestrator 从注册表挑它需要的子集（`exposeTo: ['site']`），MCP 暴露 `exposeTo: ['mcp']`，REST 路由由同一 handler 包一层。三处不再各写一份 schema。
- 站内 agent 也补上今天缺的：`action_complete`、`case_update`（限 stage 提议）、`deadline_list`——对话里 agent 同样需要（缺口 2 反向项）。
- `knowledge_search` 类型枚举、`crisis_check` 词表、`claim_calc` 封顶口径、事实卡渲染，全部只有一处实现。

---

## 4. 横切机制

### 4.1 幂等与去重
- `client_ref`：字符串 ≤64，唯一键 (case_id, tool, client_ref)；重放返回首次结果 + `deduped:true`。
- 自然键去重（无 client_ref 时）：时间线 = 同案+同日+同 kind+标题规范化；行动卡 = 同案+标题规范化+待办；诉求 = 同案同 kind；期限 = 同案同 kind 同 anchor；公司主体 = 同案同 name；草稿 = 同案同 kind 同 title ⇒ 新版本。
- 落库：新表 `agent_writes`（see §5）记录每次写工具调用（key_id、tool、client_ref、target_id、deduped、at），既是幂等索引也是审计。

### 4.2 报价→确认→扣费（P5）
- 所有 💰 工具两步：先 `xxx_quote`（免费，返回 quote_id、金额、算式、有效期 30 分钟、退款承诺）；再 `xxx`/`xxx_confirm`（带 quote_id）。确认时余额不足 ⇒ `402 GONGDAO_EXHAUSTED`（与网页同码同文案）；报价过期 ⇒ `409 QUOTE_EXPIRED`。
- 统一表 `service_quotes`（今日 dossier 的报价逻辑泛化），`pricing_config` 增键（§6）。
- 会员赠送额度（`entitlements`）在确认时自动抵扣，回包写明抵扣了什么。

### 4.3 个案报告（P6，主理人 09-04 要求）
- 表 `case_reports`：每案一行；`sections_json`（基本盘/案情主线/争议焦点/各方立场与谈判纪律/证据地图/时间线摘要/期限/待办与下一步/风险与未定项/变更日志）、`rendered_md`、`version`、`updated_at`、`updated_by`（web|agent:<key_id>|system）、`stale_since`、`stale_reason`。
- 过期触发（服务端）：timeline_add / evidence 登记或出证 / stage 变更 / deadline 变更 / claims 变更 ⇒ stale + 原因；7 天无更新 ⇒ stale「超过 7 天未整理」。
- 事实卡首行：「报告过期：自 9/1 起 3 条变动（新证据 2、时间线 1）——先整理再回答」。陪跑指南把「开工先看报告、结束前更新报告」定为纪律。
- 网页档案页只渲染 `rendered_md` + 更新者与时间 + 过期标（展示层定位）。
- 首次生成：服务端提供 `case_report_bootstrap`（system 身份）从五张表生成初稿，agent 在其上修。

### 4.4 危机与红线在 MCP 侧的强制力（P3）
- `crisis_check` 为确定性纯函数（与站内 `crisis.ts` 同一实现）；事实卡首行带「近 72h 危机标记」（来自 emotion_log/crisis 命中记录）。
- 服务端硬拦：对外文书缺 `send_consequences` 拒收；`refer_nbdpsy` 一案一次；forbidden 热线号码在任何回包中不得出现（沿用知识库校验）。
- 不能硬拦的（agent 说了什么），靠 skill 纪律 + 抽样审计（后台可查 agent_writes 与 emotion_log 的时间关系）。拍板项见 §9-⑤。

### 4.5 错误约定
沿用接入说明的错误码；新增 `QUOTE_EXPIRED`、`REALNAME_REQUIRED`（已有）、`REPORT_VERSION_CONFLICT`、`DEDUPED`（非错误，作为 result 字段）。

---

## 5. 表结构变更

| 表 | 变更 | 用途 |
|---|---|---|
| `case_reports` ★ | 新表（§4.3） | 长期记忆 |
| `agent_writes` ★ | 新表：id, case_id, key_id?, tool, client_ref?, target_table, target_id, deduped, created_at；唯一 (case_id, tool, client_ref) | 幂等 + 审计 |
| `service_quotes` ★ | 新表：id, user_id, case_id, service（attest/ocr/asr/dossier/export/watch）, payload_json, amount, entitlement_id?, expires_at, confirmed_at, order_ref | 报价确认统一 |
| `evidence` ↑ | 加 `extraction_status`（none/queued/done/failed）、`extracted_text`、`extracted_at` | OCR/ASR 结果 |
| `timeline_events` ↑ | 加 `client_ref`、`corrects_event_id` | 幂等、更正链 |
| `action_items` ↑ | 加 `client_ref` | 幂等 |
| `drafts` ↑ | 加 `version`、`based_on`、`send_consequences`（若尚未有列）、`exported_at` | 版本与导出 |
| `crisis_hits` ★ | 新表：case_id, source（site/mcp）, matched_terms_hash, at | 事实卡「近 72h 危机标记」来源 |
| `api_keys` ↑ | scope 集合扩为 read / write / spend | 💰 动作需 spend |

迁移全部 additive；`ensure*` 风格幂等；无回填任务（报告首稿由 bootstrap 惰性生成）。

---

## 6. 配置（`pricing_config` 键与 env）

| 键 | 含义 | 建议初值（待拍板 §9） |
|---|---|---|
| `attest.per_item` | 每件证据出证（TSA+签名） | 0 或 30 公道值 |
| `ocr.per_page` | 图片/PDF 每页 OCR | 5 |
| `asr.per_minute` | 录音每分钟转写 | 8 |
| `doc_review.per_doc` | 来文解读（含 OCR 与审查规则） | 20 |
| `draft_export.per_pdf` | 文书导出 PDF | 0 |
| `quote.ttl_minutes` | 报价有效期 | 30 |
| `report.stale_days` | 报告多少天不更新即过期 | 7 |
| env `LAWER_MCP_SPEND_ENABLED` | 💰 工具总开关（灰度） | 0 → 1 |

---

## 7. 后台（/woo）

- **agent 写入审计**：按用户/案件看 `agent_writes`（工具、时间、去重命中、key 名），用于排查双写与异常写回。
- **报告状态**：每案报告 updated_at/stale 概览；超过 N 天过期的用户列表（运营可催）。
- **报价与订单**：`service_quotes` 视图（已确认/过期/退款）。
- **定价配置**：`pricing_config` 只读展示（改价仍走代码与台账，避免后台误改）。
- 现有：账号、实名审核、兑换码不变。

---

## 8. skill 三份的改法（P7）

- **接入说明.md**：能力表、REST 表、错误码表、计费段由 `scripts/gen-skill-docs.ts` 从注册表生成，文件顶部标「生成区，勿手改」；手写区只保留「这是什么/凭据/边界红线/接入步骤」。`variants/claude-skill.md` 同脚本生成。
- **SKILL.md**：开工顺序改为 `case_list → case_report_get（过期则先整理）→ case_facts → 用户消息先 crisis_check → 回答`；结束顺序 `写回（timeline/claims/actions/deadlines）→ case_report_update`。
- **陪跑指南.md**：新增四条纪律——报告维护义务（开工看、收工写）、写回带 client_ref、💰 动作先报价再确认且向用户报数、引用前 `citation_check`。
- **manifest**：由注册表生成，含全部 REST（缺口 4 清零），带版本号；`GET /api/manifest` 加 `tools_version`，agent 可据此判断说明书是否过期。
- 守卫测试：生成物与注册表一致（快照）；SKILL.md 含开工/收工顺序；接入说明不含手写工具行。

---

## 9. 待主理人拍板

| # | 问题 | 我的建议 |
|---|---|---|
| ① | 证据出证要不要收公道值 | 收，每件 30（覆盖 TSA 与签名算力），会员赠送额度可抵；保持「报价免费、确认才扣」 |
| ② | OCR / ASR / 来文解读单价 | §6 初值，上线后按成本表校准 |
| ③ | api key 是否细分 `spend` 权限 | 分。用户可发一把只读只写的 key 给不那么信任的 agent |
| ④ | 个案报告按案件一份（非按用户） | 按案件；现一人一案两者等价 |
| ⑤ | MCP 侧危机处理强制到什么程度 | 服务端只做「能确定性判定的」：crisis_check、事实卡首行标记、forbidden 号码永不出现、对外文书必带后果；agent 的措辞不硬拦 |
| ⑥ | 来文解读/录音转写是否本期 | 二期（Phase 3），先把免费能力面与报告做扎实 |

---

## 10. 缺口对照（盘点 1–10 → 本文落点）

| 缺口 | 落点 |
|---|---|
| 1 MCP 缺 8 项写能力 | §2 D/E/F/G/H/I + §3 注册表 |
| 2 缺公司背调/图谱读取 | §2 H |
| 3 缺文书读取 | §2 E draft_list/get |
| 4 manifest 漏 25 条 | §8 由注册表生成 |
| 5 knowledge 类型漏两类 | §2 C 十类全收 |
| 6 三张表有页面无实作 | §2 J（二期）+ §5 |
| 7 OCR/ASR 未接线 | §2 B evidence_extract、§2 J |
| 8 出证不计费 | §4.2 + §9-① |
| 9 危机拦截仅站内 | §4.4 crisis_check + crisis_hits |
| 10 BYO 连接状态只在前端 | §2 K me_get.connected_agent + 事实卡首行 |
| 主理人 09-04：档案潦草 | §4.3 个案报告 + §4.1 去重 |
| 主理人 09-04：agent 引导建档 | §2 A intake_submit |

---

## 11. 分期与拆票（批准后执行）

| 期 | 内容 | 级别 | 交付判据 |
|---|---|---|---|
| **P1 对齐与幂等**（本周） | 注册表骨架；MCP 补 claims/claim_calc、action_create、emotion_log、company_profile_upsert、draft_list/get/write、deadline_set/resolve、intake_submit、case_update 基本盘、timeline_list/milestone；`agent_writes` + client_ref + 自然键去重；knowledge 十类；manifest 与 skill 由注册表生成 | L（注册表）+ 若干 M | 站内 10 工具在 MCP 逐一可调且同表同函数；重放零双写；生成物快照守卫 |
| **P2 记忆与守则**（下周） | `case_reports` + stale + bootstrap + 事实卡首行 + 网页档案页渲染；`crisis_check` + `crisis_hits`；`me_get`、`quote_list`；`citation_check`、`knowledge_get`；公司情报只读面（probe/dossier_get/graph_get） | L + M | 报告过期机制真机可见；危机词表 MCP/站内同函数判据 |
| **P3 计费动作**（再下周） | `service_quotes` 泛化；`evidence_attest_quote/attest`（按 §9-①）；`dossier_quote/confirm`、`company_watch_set` 走统一报价；`evidence_upload_url/register`、`share_create`；`spend` scope | L | 报价→确认→扣费三步在四种服务上判据一致 |
| **P4 内容提取**（排期待定） | sidecar OCR/ASR 接线；`evidence_extract`、`doc_submit`、`transcript_submit`；文件解读页真数据；`draft_export` | L | 空表落地；计费按 §6 |

每期按分级规则派单（S/M 单 Agent，L 执行 + 复核），上产前 CI 绿 + 真机核对，台账逐单记。

---

## 12. 不做的事

- 不做「agent 代发」任何对外文书（红线不变）。
- 不做跨案件检索与跨用户任何读取。
- 不把聊天接口暴露为 MCP 工具。
- 不在 MCP 侧做密钥自我管理。
