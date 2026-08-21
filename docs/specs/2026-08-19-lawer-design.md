# lawer「裁员应对专员」整站设计 spec v1.0

> 状态：已批准（2026-08-19，产品负责人口头批准设计稿 v1）
> 架构师/总控：manager 会话 · 本文件是全项目唯一事实源，改动需 manager 审批并记入 CHANGELOG

## 1. 背景与目标

为北京（默认朝阳区）请不起律师、自己跑劳动仲裁/一审/二审的劳动者，提供 AI 律师全程陪跑：
**细致问诊 → 公司公开信息调查 → 专属案件档案（长期记忆）→ 随时给出快速准确的行动建议（第一优先）**，
覆盖：书面回复/异议函、HR 约谈录音分析（后续实时耳语/直接介入）、证据固化（时间戳+电签）、
公司文件 OCR 解读与签/不签意见、仲裁与开庭材料准备+流程预演+心理建设、全程情绪安抚。

非目标（明确不做）：不自称律师/律所、不承诺胜诉率、不做诉讼代理（用户自己或公民代理出庭）、
不反复劝用户"去找律师"（目标用户请不起律师，这是红线）。

## 2. 已拍板决策（产品负责人 2026-08-19）

| # | 决策 |
|---|---|
| D1 | 实名制：手机号+邮箱双验证才能用；上传材料绑定实名+存证订单记录；数据加密存储；原件上传 |
| D2 | 收费只赚 token 钱；点数名「公道值」；计费逻辑照抄问爻「功德」账本 |
| D3 | 三档套餐：入门=全 DeepSeek；中配=关键环节 Claude；高配=主力 Claude；支持 Claude/GPT/Qwen/DeepSeek。**修订(2026-08-20 用户拍板)：需要 Anthropic key 的中配/高配设为「待开发」不可购**，上线仅售入门档；质量目标以入门档达标为准（闸门+提示词优化，不许把质量赌在换模型上）；key 到位后再开两档 |
| D4 | MCP+API 开放：用户自己的 agent 直连档案库；下发接入说明；无 MCP 用户网页全功能；移动端+PC。**修订(2026-08-20)：接入面 agent 无关**——用户可能用 Claude/Codex/豆包/WorkBuddy/Trae 等任意 AI：MCP 走标准 Streamable HTTP+通用 JSON 配置；不支持 MCP 的走 REST（manifest 自描述）；接入话术提供 通用/Claude/Codex/仅REST 多版本，Claude skill 仅是其中一个变体 |
| D5 | 语音：事后录音分析（M5 一期）→ 实时耳语+直接介入（二期，需明确开启并告知对方） |
| D6 | MVP 主线=解除/裁员/逼迫离职（含 N/N+1/2N、欠薪、年假、加班费、双倍工资、社保、竞业、年终奖）；朝阳深耕，分区差异化；阶段全覆盖（仲裁前博弈→执行→被告应诉） |
| D7 | 通知复用 NBDpsy：阿里云短信+企业邮/DirectMail+服务号模板消息 |
| D8 | 电签/固化复用 NBDpsy：CFCA 证书 PAdES + GlobalSign AATL RFC3161 + 阿里云实人认证 |
| D9 | 无人工兜底，全 AI；重度情绪（焦虑抑郁表现）可引流 NBDpsy 心理咨询，禁止趁人之危观感 |
| D10 | 公司调查只查公开信息。**形态修订(2026-08-19)**：政务源（gsxt/zxgk/信用中国）有 WAF+服务器IP拒绝，无人值守代查不可行——agent 生成查询清单→用户手机自查→回传截图由 agent 解读；agent 可直接代查：人民法院案例库、破产重整信息网；商业库首选爱企查（免登录）。依据 research/raw/C02 实测 |
| D11 | 凭据（模型 key、阿里云、微信）从 NBDpsy 项目获取，绝不入仓库 |
| D12 | 律师 agent 不做刻意人设/口癖，实用为主 |
| D13 | **视觉方向（2026-08-20 用户拍板）**：主视觉色系=淡金色+勃艮第红+米白色（NBDpsy 品牌系，精确色值从 NBDpsy 前端代码提取对齐）；基底参考 GitHub 开源免费设计模板（**仅限 MIT/Apache/CC0 等宽松许可，License 留档**），抄布局与设计感、换自有 token。语义色纪律不变：告警/不可逆红必须与勃艮第主色显著区分（亮朱红系），期限倒计时避开淡金选独立橙系。深浅双主题+低调模式在新色系下重新映射 |

## 2b. 实战沉淀（用户 1 号真实案件产出的产品化输入，2026-08-21）

本项目的第一个用户就是产品负责人本人的真实劳动争议案件。该案实战中沉淀出三份方法资产，**已标注"产品化输入"，实现对应能力时必须取用**：

| 沉淀 | 位置 | 用于 |
|---|---|---|
| **判例核验四步法** | `knowledge/packs/method/panli-heyan-sibufa.md`（method 新域） | agent 引用任何判例前必过：①读全文（禁止只凭案号+摘要）②分清"当事人自认"vs"法院裁判认定"③否定性核验（看"没有什么"，如"连带"二字零出现）④标注【可用/不可用/**反向**】结论字段。**血泪来源**：某案原被当作连带责任的有利先例，读全文后发现是"择一担责"的反向判例，险些写进书状被对方反用 |
| **案件材料事实纪律** | `user-case/案件材料事实纪律.md` | case 档案模块设计输入：三栏分离（既存事实·可举证／待核实·缺口／行业结构·非本案个体事实）+ 法条必须逐字可溯源 + "指向/实际是"必须有证据锚点。**产品含义**：case 的事实字段将来要带 source/confidence，与知识卡同构 |
| **告警行动卡模板** | `user-case/company-watch/告警行动卡模板-产品化输入.md` | companywatch 告警设计：按**请求权状态**分流（有成立请求→保全；在职无请求→异议阻断+评估被迫解除）与**注销类型**分流（简易注销→20日债权人异议；普通注销/清算→45日债权申报），附分级防误报与文案纪律。**原则**：每条告警必须对应一个可执行动作，否则只是焦虑生成器 |

## 3. 架构原则（架构师门禁）

1. **单体优先**：一个 Next.js 应用 + 一个 Python sidecar + Caddy，不搞微服务。新增服务需 ADR。
2. **模块边界神圣**：`lib/` 下每个目录一个职责，跨模块只经导出的函数接口；禁止路由里写业务逻辑（路由=参数校验+调 lib+返回）。
3. **抄优于写**：问爻/NBDpsy 已验证的代码整块移植（账本、支付、OTP、电签脚本、key 网关），改名不改逻辑；移植时删掉原项目业务残留。
4. **钱和证据零妥协**：公道值账本与存证记录只追加不修改；幂等键强制；对账脚本随迁移交付。
5. **性能**：SQLite WAL+预编译语句；LLM 响应一律 SSE 流式；文件按 SHA256 去重存储；列表全部分页；知识检索用本地索引（不引向量库，除非 ADR）。
6. **版本迭代**：semver + `docs/CHANGELOG.md`（keep-a-changelog 格式）+ git tag；架构决策写 `docs/adr/NNN-标题.md`。
7. **门禁**：所有分支经 PR 进 main，manager 审核合并；测试随功能走（账本/计算器/期限引擎必须有单测）；禁止 dead code 与"顺手重构"。

## 4. 技术选型（方案 A，已批准）

- **app/**：Next.js 16 + React 19 + TypeScript + better-sqlite3（WAL）。骨架、账本、支付、管理端从 `/home/roots/六爻/app` 移植。
- **sidecar/**：Python 3.11 + FastAPI。电签/时间戳脚本从 `/home/roots/NBDpsy/后端服务/管理后端/scripts/` 移植（`rfc3161_timestamp.py`、`pades_sign.py`、`gen_evidence_pdf.py`、`verify_*.py`、trust_anchors），加 OCR/ASR 编排（DashScope Qwen-VL/Paraformer）。仅内网监听，供 app 调用。
- **MCP**：跑在 app 内（`/api/mcp` streamable HTTP route handler），鉴权复用 api_keys 表。
- **前端**：app 内页面（不分仓）。移动优先响应式 + PWA。
- 部署（2026-08-20 定案）：合并到 **NBDpsy 生产服务器**（211.159.155.210 腾讯云国内，8G/100G数据盘，荷载已核实充足）。数据全放 `/data/lawer/`（SQLite+加密证据库+备份，与 NBDpsy 物理隔离）；app :3010 / sidecar :8110 仅内网；**Caddy 直连** law.nbdpsy.com（自动 TLS）；DNS 用现成 CLOUDFLARE_DNS_API_TOKEN 加 law A 记录→服务器 IP（无需新建 Tunnel token）；**Zero Trust**：主站公开、仅管理后台套 Cloudflare Access 门禁（授权邮箱）；部署对齐 NBDpsy 的 git push→webhook 模式，备份并入 NBDpsy 体系。

## 5. 系统架构

```
 用户(手机/PC浏览器)      用户自己的 Claude(挂 skill)
        │ HTTPS                    │ MCP(HTTP)+API key
        ▼                          ▼
 ┌─────────────────────  Caddy  ─────────────────────┐
 │                    Next.js app                     │
 │  web 页面(对话工作台/档案/证据/管理端)              │
 │  /api/v1/*(REST)  /api/mcp(MCP)  /verify/:no(公开) │
 │  lib/: agent │ llm路由 │ billing │ knowledge │      │
 │        cases │ evidence │ notify │ payment │ crypto │
 └──────┬───────────────┬───────────────┬────────────┘
        │ SQLite(WAL)   │ 文件库(SHA256去重,加密)      
        ▼               ▼               ▼ 内网HTTP
   lawer.db        /data/files    Python sidecar
                                  (TSA时间戳/PAdES/OCR/ASR/PDF)
 外部：Anthropic/OpenAI/DeepSeek/DashScope · 阿里云(短信/实人认证) ·
       微信(支付/服务号) · 支付宝 · GlobalSign TSA
```

## 6. 仓库结构

```
lawer/
  app/                    # Next.js 单体
    src/app/              # 页面 + api 路由（薄）
    src/lib/db/           # client.ts + migrate.ts + 表封装（唯一 SQL 层）
    src/lib/auth/         # OTP/邮箱验证/JWT/实名认证编排
    src/lib/billing/      # 公道值（抄功德：index/pricing/estimate/fulfillment/redeem/features/channel）
    src/lib/llm/          # providers/{anthropic,openai,deepseek,dashscope}.ts + router.ts + rates
    src/lib/agent/        # 律师 agent：编排、问诊状态机、行动卡、文书起草、金额计算器
    src/lib/knowledge/    # pack 加载与检索
    src/lib/cases/        # 案件档案领域逻辑
    src/lib/evidence/     # 上传/去重/固化编排（调 sidecar）
    src/lib/notify/       # sms/email/wechat-pubacc 薄客户端
    src/lib/payment/      # alipay/wechat（抄问爻）
    src/lib/crypto/       # 字段级加密(AES-GCM, env 主密钥)
    src/lib/deadline/     # 期限引擎
  sidecar/                # FastAPI：/tsa /pades /ocr /asr /pdf
  knowledge/              # packs（编译产物，原创+引用，可入库）
  skill/                  # 下发给用户 Claude 的 skill 模板
  deploy/                 # docker-compose.yml Caddyfile backup.sh
  docs/{specs,tasks,adr,CHANGELOG.md}
  scripts/                # 对账、导入导出、运维
```

注：调研原始材料在服务器本地 `/home/roots/裁员应对员/research/`（约150万字，含网络抓取内容），**不入仓库**。

## 7. 数据模型（数据表管理窗口细化，本节为约束）

**用户与实名**
- `users`(id, phone_enc, phone_hash UNIQUE, email, email_verified_at, phone_verified_at, real_name_enc, id_card_enc, auth_status[未认证|待审|已实名], created_at)
- `sms_codes` / `email_codes`（OTP，限流字段照抄 NBDpsy 语义）
- `realname_verifications`(id, user_id, provider[cloudauth|eid|manual], cert_no, status, raw_meta_enc, created_at)
- `api_keys`(id, user_id, name, key_hash UNIQUE, scopes, last_used_at, enabled)

**案件档案（心脏）**
- `cases`(id, user_id, title, stage[风声|约谈中|已收通知|已解除|仲裁准备|已立案|开庭|裁决|一审|二审|执行|结案], district DEFAULT '朝阳', goal, bottom_line, status, created_at)
- `company_profiles`(id, case_id, name, uscc, role[签约主体|用工主体|关联], reg_capital, legal_rep, risk_notes, sources_json, investigated_at)
- `timeline_events`(id, case_id, happened_at, kind[公司动作|我方动作|系统动作|期限], title, detail, evidence_ids_json, created_at)  — 只追加，修正用新事件
- `evidence`(id, case_id, user_id, file_id, name, category[合同|工资|社保|考勤|沟通记录|公司文件|录音|其他], prove_purpose, original_medium, status[已上传|已固化|已出证], created_at)
- `files`(id, sha256 UNIQUE, size, mime, enc_path, created_at)  — 按哈希去重，落盘加密
- `attestations`(id, evidence_id, order_no UNIQUE, user_realname_snapshot_enc, sha256, tsa_tst_b64, tsa_gen_time, tsa_serial, tsa_url, cert_pdf_file_id, status, created_at)  — 存证订单，只追加
- `company_docs`(id, case_id, file_id, ocr_text, doc_type[解除通知|协商协议|调岗通知|PIP|警告|其他], risk_flags_json, advice[签|不签|改签|待定], advice_detail, created_at)
- `claims`(id, case_id, kind[2N|N|N+1|欠薪|年假|加班费|双倍工资|年终奖|竞业补偿|其他], amount_fen, calc_json, basis, status)
- `action_items`(id, case_id, title, detail, due_at, priority, status[待办|完成|放弃], source_message_id, created_at)
- `deadlines`(id, case_id, kind[仲裁时效|起诉15日|上诉15日|举证期限|开庭|申请执行2年|自定义], due_at, derived_from, notified_stages_json)
- `threads`(id, case_id, mode[问诊|陪跑|文书|录音分析]) / `messages`(id, thread_id, role, content, model, tokens_json, created_at)
- `emotion_log`(id, case_id, level[平稳|低落|焦虑|严重], note, referred_nbdpsy, created_at)
- `share_links`(id, case_id, token UNIQUE, scope[档案只读|单文件下载], expires_at, revoked_at)
- `drafts`(id, case_id, kind[异议函|被迫解除通知|仲裁申请书|证据清单|答辩状|上诉状|谈判话术|其他], title, content, version, status)

**公道值（抄问爻，改名）**
- `gongdao`(user_id PK, balance) / `gongdao_ledger`(delta, type, ref_id, feature, meta_json; UNIQUE(type,ref_id) WHERE ref_id NOT NULL)
- `memberships` / `skus` / `orders` / `redemption_codes` / `token_usage`(+model 列) — 结构照抄
- `model_rates`(model, token_kind[in|out|cache_read|cache_write], gongdao_per_token, effective_at)  — 新增；档位变体编码进 model 串（如 qwen-plus:think），变体→API参数映射归 lib/llm
- `notify_log`(scene, biz_key 幂等, channel, status) — 照抄 NBDpsy 语义

## 8. 模块规格与验收（摘要）

| 模块 | 要点 | 验收 |
|---|---|---|
| auth | 手机 OTP+邮箱验证双必须；JWT；实人认证 H5（CloudAuth，M2 接通） | 新用户 3 分钟内完成注册双验证 |
| agent | 问诊状态机（首诊清单→补充→陪跑）；每次回复必产出/更新行动卡；重要结论引用 pack 依据（法条条号/判例） | 首诊后自动建档：时间线≥3事件、诉求初算、行动卡≥3 |
| llm 路由 | task_class[critical|standard|bulk] × 套餐 → 模型；SSE；token 计量→账本结算 | 三套餐路由正确；断流可重试不双扣 |
| knowledge | packs frontmatter 索引+关键词检索；agent 工具 `knowledge_search` | 命中法条卡逐字原文 |
| evidence | 上传→加密→SHA256→TSA 固化→存证订单→《存证证明》PDF→`/verify/:no` | 验证页可离线复核哈希与时间戳 |
| OCR | 拍照→Qwen-VL→风险标红→签/不签/改签建议入 company_docs | 解除通知样张全流程 <60s |
| 计算器 | N/N+1/2N/年假/加班费/双倍工资，北京口径（分段、三倍社平封顶、12年上限），calc_json 留痕 | 单测覆盖 spec 附录算例 |
| deadline+notify | 事件→期限→短信/邮件/服务号三通道，幂等 | 模拟开庭前1天触发三通道 |
| billing | 账本移植+估价预检+支付+兑换码+注册赠送 | 对账脚本 SUM(ledger)=balance；重复回调不双记 |
| MCP/API | 工具：case_get/update, timeline_add, evidence_upload, docs_ocr, claim_calc, draft_write, knowledge_search, action_*, deadline_list；`/api/manifest` | 用户 Claude 挂 skill 后完成"传证据→固化→列行动卡"全链 |
| 管理端 | 用户/公道值调整(ADMIN_EMAILS)/兑换码/费率/存证查询 | 发码→用户核销到账 |
| **companywatch** | **公司主体监控（2026-08-20 用户拍板新增，MCP/API 能力）**：按案件添加被监控主体→调度器每日≥2次经公开渠道（爱企查为主，可插拔源）拉取→diff 出事件：简易注销公告/注销清算备案/经营状态变更/股权法代变更/减资公告/拉取连续失败（静默失效也是告警）。urgent 级（前两类）即时三通道通知+自动落 timeline+生成行动卡（挂债权人异议 SOP）；info 级日报合并。表：company_watches / company_watch_events(只追加)/ 检查日志。工具：company_watch_add/list/events + company_snapshot（按需快照回填 company_profiles）。合规：仅公开信息（D10）、来源留 URL、限频。计费：feature=companywatch 定额（待M3核定，MVP 记量不扣） | 添加监控→模拟注销公告→三通道告警+行动卡出现 |
| **companywatch v2** | **关联主体图谱+诉讼档案（2026-08-20 用户拍板扩展）**：输入公司→自动发现关联主体（1 跳默认：股东上溯/对外投资下探/分支机构/同法定代表人；2 跳需确认）→ 生成建议清单用户勾选→批量入监控。同时抓取全部关联主体**近 5 年公开可得的裁判文书与涉诉记录**（劳动争议案由优先精读入档：应诉风格/赔付先例/代理律所），存 company_litigation，agent 可检索。表：company_relations（关系类型+证据URL+置信度）/company_litigation（案号/法院/日期/案由/角色/文书URL/摘要/来源）。工具：company_relations_discover / company_litigation_list。**诚实边界写进产品文案**：裁判文书公开率 2021 起持续下降，只能承诺"公开渠道可得"而非"全部"；缺口用涉诉记录条目（有案号无全文）补。**数据源策略**：个人案=用户自己的爱企查登录态；平台规模化=商业数据 API（企查查/天眼查开放平台，按次计费，待用户批预算后接入） | 输入一家公司→关联清单≥法代/股东/分支三类→勾选入监控→5年劳动争议文书列表可检索 |
| **companywatch v3** | **三圈监控模型+关系图谱可视化（2026-08-20 用户拍板）**。三圈：圈1直接责任链每日2次（签约/用工/发薪主体+直接控股股东）、圈2责任扩展候选每周1次（股东链1-2跳中间层/实控人核心主体/被执行动态）、圈3存档不监控（一次性快照备查）；**自动升级规则**：圈1出事件→相邻圈2主体自动升每日。铁律：每条告警对应可执行动作，拒绝焦虑生成器；图谱要全（追责地图）、监控要准（信号不淹没）。company_watches 加 tier 列。**前端图谱页**：案件档案内「公司图谱」视图——节点=company_profiles（徽标：圈层/监控状态/近期事件数/涉诉数），边=company_relations（类型样式区分：股权实线带箭头/同法代虚线/分支点线），股权层级自上而下布局，点节点开详情抽屉（快照字段+近5年涉诉+事件流），urgent 事件节点红色脉冲，移动端可捏合缩放。API：GET /api/v1/cases/:id/company-graph → {nodes,edges,tiers,events} | 图谱页渲染 3+ 主体两类关系；圈1模拟事件→节点变红+相邻圈2升级标记 |
| **contract-review** | **职场合同分级审查（2026-08-20 用户拍板）**：对劳动合同/竞业/保密/培训服务期/协商解除协议/offer/规章制度确认书等职场文书,逐条对照法律审正当性,输出三级修改意见——**大坑必修(must)/中坑强烈修(strong)/小坑建议修(suggest)**。链路:上传/OCR→条款切分→规则库匹配+LLM 逐条审(critical 档)→结构化 findings{条款引用,坑级,问题,法条依据逐字,可照抄的修改要求话术,谈判提示}→落库→must 项自动生成行动卡("要求修改后再签")。规则库=knowledge 新域 review-rules/(按合同类型分卡,规则走 facts 结构化:severity/pattern_hint/basis/suggestion),要点:必备条款缺项(劳动合同法§17)、试用期超限、工资拆分、竞业无补偿、违约金滥设、放弃社保声明、空白合同、单方调岗条款、送达陷阱等。表:contract_reviews+review_findings(逐条状态:待处理|已提出|已修改|接受风险)。前端:审查报告视图(三级色带+逐条卡+一键复制修改话术+导出PDF+签署决策条)。工具:contract_review(MCP/API)。评测:C04 扩合同剧本,must 漏检=FAIL | 喂一份含5坑样本合同→must 全检出+每条带条号原文+可照抄话术 |

## 9. 公道值定价（草案，M3 接入时按官方实价核定费率表）

- 锚点照抄问爻：**1 元模型成本 = 300 公道值**（约 50% 毛利空间）。
- 费率公式：`gongdao_per_token = 官方单价(元/token) × 300`，按 model×token_kind 写入 `model_rates`（接入时核定，含缓存价）。
- 套餐草案（月卡=公道值额度+路由策略）：入门 ¥19.9（全 DeepSeek/Qwen）；中配 ¥59（critical 走 Claude）；高配 ¥199（standard 以上走 Claude）。散充 1 元=100 公道值。注册赠送额度以能完整走完一次首诊为准（上线前实测标定）。
- API/MCP 模式：token 由用户自己的 agent 承担，平台仅对固化出证、存储扩容、短信收定额公道值（`FIXED_PRICING`）。

## 10. 安全·隐私·合规

- 敏感字段（手机号/身份证/实名/认证原始报文）AES-GCM 加密落库，主密钥 env；文件落盘加密；备份加密异地。
- 首屏一次性免责声明：平台提供法律信息与行动建议，不构成律师意见、不形成委托代理关系；用户协议+隐私政策（M3 前上线）。
- 录音指引话术固定为"一方知情录音+合法场景"；直接介入模式强制开启提示"已告知对方使用辅助工具"。
- 情绪引流红线：连续/严重痛苦表达才提示 NBDpsy 与公益热线，一案最多提示一次，禁止推销话术。
- 服务器若落国内：域名备案；若海外：标注跨境存储于隐私政策并单独同意（PIPL 第39条）。
- share_links 默认 7 天过期、可撤销；下载链接带水印页脚（案件编号+生成时间）。

## 11. 里程碑（多窗口并行）

- **M1 陪跑最小闭环**（最急，先服务用户本人）：auth(OTP+邮箱) + cases 全套档案表 + agent 问诊/陪跑/行动卡 + 计算器 + drafts 文书 + knowledge 检索（先用已有 packs）
- **M2 证据链**：上传/去重/加密 + sidecar TSA 固化 + 存证订单 + 验证页 + OCR 解读 + 实人认证接通
- **M3 商业化**：公道值账本 + 支付 + 套餐路由 + 管理端 + 用户协议/隐私政策
- **M4 开放与提醒**：MCP + REST + 用户 skill + deadline/notify 三通道
- **M5 语音一期**：录音上传→ASR 说话人分离→逐句分析→复盘报告；（二期实时耳语/直接介入另立 spec）

## 12. 协作纪律

- 分支 `ws/<角色>`，PR → main，manager 审核合并；commit 遵循 conventional commits。
- 任务板 `docs/tasks/BOARD.md`：开工前读，收工前写（状态+量级预估+需配合）。
- 决策疑问 → SendMessage 给 manager，不自行拍板改契约（表结构、API 形状、费率、目录结构）。
- 汇报节奏：manager 10 分钟盯梢；阻塞立刻报，不空等。
