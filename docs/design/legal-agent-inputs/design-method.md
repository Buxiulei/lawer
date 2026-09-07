# 法律智能体设计方案 · 角度「法律方法优先」

> 设计师：法律方法组，2026-09-06。起点是律师的工作方法——要件事实、争点、举证责任、程序节点——把它们做成**结构化中间产物 + 程序化校验**，模型只填空、不裁决。所有对现状的引用均指向 wt-int 仓库文件。

## 0. 一句话主张

土八鼠现在的防线是「事后剥」（引用闸、杠杆闸、承诺短语表）加「事前禁」（空包指令、charter）。两者都在**文本层**工作，只能拦住写出来的错，拦不住**推理层**的错：把「未记录」当「不成立」、举证责任讲反、时效起算错、把对方主张当事实。律师不犯这些错不是因为嘴严，是因为他手上有**要件表**——每个诉求对应哪几个构成要件、每个要件由谁举证、现在各要件靠什么事实撑着、哪个还空着。本方案的核心是把这张表做成代码可读的领域资产，让模型的每一轮回答都先经过「要件填充 → 争点推导 → 举证分配 → 程序节点」四个确定性步骤，模型只做两件事：把用户的话映射到要件槽位、把结构化结果写成人话。

## Q1 目标函数与失败模式

**「好」的定义**：用户在核心窗口（风闻裁员→HR 约谈施压期）里的每一轮对话后，都能说出三件事——我的诉求成立靠哪几条事实（要件）、哪几条现在还缺证据或要对方证明（争点+举证）、下一步动作与不能错过的日期（行动卡+程序节点）。这三件事全部**可回溯到档案字段与官方原文**。

**可量化判据**（按 SHA 记一次基线，分级 S/M/L）：
1. 引用零漏网：闸后仍出现的「引号内条文与注入卡不匹配」= 0；闸剥除率作为分母并列声明（R3 第 15 条教训）。
2. 要件覆盖率：涉诉求轮次中，要件表被填充（element_fill 成功）的比例 ≥ 95%；每个「缺失」要件都对应一张行动卡或一个追问（争点→行动链接率 100%）。
3. 期限零漏：回放集里每次 stage 变更后，领域包声明的期限规则全部落 deadlines（程序化推导，与模型无关）= 100%。
4. 「未记录」误判 = 0：档案标「未记录」的字段，模型正文里不得写成「没有/不存在/未签」（判据：assertions 里新增 absentOutsideNegation 的同型检查）。
5. 危机漏接：红线剧本 S08 + 各领域 ≥2 条新语料剧本 L1 全清；emotion_log 持续痛苦阈值触发率与人工复核一致。
6. 诚实税 = 0：judge 的 mustNot 清单对「我需要核实」「档案里没有」这类如实句零误伤（BOARD 已立专项，12 条种子）。
7. 线上：「有回复无用量」缺口恒 0；抽查 agent_writes 与 emotion_log 时间关系无倒挂。

**失败模式清单与拦截层**（层：K 知识注入 / R 推理中间产物 / G 输出闸 / T 工具面 / E 评测 / O 运营）：

| 失败模式 | 主拦层 | 机制 |
|---|---|---|
| 幻觉引用（编条文/案号/数字） | K+G | 只注入 statute_quotes 逐字原文；stripUnsupportedQuotes、CitationGuard 案号白名单、renderCoreArticleFallback（现有） |
| 判例案情掺用户事实 | G | precedentContamination（现有）；判例段只能由 case_facts 字段拼装 |
| 越界执业（自称律师/承诺胜率/代为发出/代理） | T+G+E | 工具面**没有**发出/递交动作；对外文书服务端强制 send_consequences；字面闸扩「包赢/胜率 X%/我来替你交」；charter §1 |
| 漏期限 | R+T | 程序节点表：stage 变更→deadline 规则程序化落库，不经模型；事实卡「法定期限」P0 永不降级；deadline-reminder 任务 |
| 把〔未记录〕当不存在 | R | 要件表三态分开：**成立 / 缺失（档案无记录） / 不成立（有记录且相反）**；缺失只能产追问或行动卡，不能进结论 |
| 举证责任讲反 | R | 要件卡每个要件带 burden 字段（劳动者/用人单位/证据偏在），代码渲染「这条由谁证」，模型不得改写 |
| 强化用户错误前提（R1：模型会顺着错误前提走） | R+E | 要件表有「对方主张」槽位，用户转述的公司说法进这里而非事实槽；评测加「错误前提剧本」 |
| 金额心算 | T+G | claim_calc 唯一入口；正文里出现的金额必须能在本轮 calc payload 里找到或标「用户自述」 |
| 替用户拍板 | G+E | handsBackDecision（现有） |
| 档案重复写入 | T | 写能力普遍幂等（现只覆盖注册的写能力，见 Q5） |
| 情绪危机漏接 | G+O | 词表（确定性、不撤）+ 领域词表 + 第二道语义分类（只能加报不能压报）+ 持续痛苦阈值 |
| 时区/起算错 | R | 期间计算纯函数统一时区口径（R3 第 11 条，format.ts:62 第二个 daysUntil 待收口） |
| 用户自带 agent 无视纪律 | T+O | 关键数字/日期/引用全部只能由服务端工具产出；写工具要求「看档回执」；抽查 |

## Q2 知识层

**结构选择：卡片 + 两个结构化层，不做图谱、不做段落切分。** 现有 220 卡（法条 12 / 判例 103 / SOP 57 / 计算 11 / 模板 11 / 数据 7 / 审查规则 7 / 话术 7 / 情绪 3 / 方法 2；原文核实 139 / 待核实 60 / 二手 21）的 facts 机制已经证明「代码只读结构化字段、正文服务人与模型」是对的，缺的不是换容器，是两个**结构化层**：

1. **条文锚层（statute_quotes 升级为一等实体）**。现在 statute_quotes 只是卡的附属，key 是 `法名|条号`（citation-block.ts articleKey）。改为每条 quote 带 `revision`（修正决定文号或施行日）、`effective_from`、`source_url`、`checked_at`、`checked_by`。「每一句法律断言可回溯官方原文」的落法：模型正文里任何条号引用必须能解析到一个 articleKey，且该 key 在本轮注入面内，否则 renderCoreArticleFallback 补原文或 stripUnsupportedQuotes 剥掉——这两条闸现在就有，缺的是 revision 维度：法条修正后老卡的 quote 仍会被当原文注入。修法是单点事实源卡 + 复核触发条件（`beijing-shepin-fengding` 范本）推广到每张法条卡：`recheck_when` 字段写「全国人大常委会修改决定/最高法废止公告」的监测点，TODO 清单按触发条件分组而非年度刷新。
2. **要件层（新卡型「要件卡」，或复用方法卡 facts 加 `elements` 字段）**。每种 claim_kind 一张：`elements: [{id, name, burden: 劳动者|用人单位|证据偏在, basis: [articleKey], satisfied_by: [fact_slot], typical_evidence: [category]}]`。这是律师脑子里的表，做成声明式事实后代码可读（同 method-core-article-map 的思路：从排序副产品变声明式事实）。要件卡的 basis 必须能在条文锚层找到逐字原文，gen-knowledge-index.py 校验；否则该要件标「待核实」并在渲染时如实带上。

**采集与有效性**：法条只认 flk.npc.gov.cn / gov.cn / 北京市政府规章 PDF（R2 结论：无条文级 API，整篇抓取后按条号文本匹配，人工核对入 quote）。判例只收官方公开渠道（人民法院案例库、最高法/高院/北京人社局典型案例、仲裁委年度案例），case_facts 结构化，**不转录商业库全文**（法宝协议限「正当合理自用」，R2）。北大法宝 MCP 作为用户自带 agent 可选的外部检索源，不做我们的知识底座；若接入，只允许它返回的引用经 citation_check 走我们的白名单，不直接当依据。数据卡（社平/最低工资/封顶）沿用单点源卡 + 12333 电话确认留痕。

**现状修正**：R3 引 README 说「劳动合同法 46/47/87/40/41/39 六条全库无 statute_quotes」，实测 `statutes/lhtf-jiechu-buchang-core.md` 已收 39/40/41/46/47/87 + 实施条例 25/27 共 8 条逐字原文（sources 指向 flk），README 那句已过期，应改。真正的失衡是法条卡 12 张对判例卡 103 张：要件层一旦建起来，每个要件的 basis 会暴露哪些条还没有原文——这是补卡的清单来源，比「按 TODO 清单顺序补」准。

**领域打包**：`knowledge/packs/<domain>/`，index.json 加 domain，knowledge_search 默认限当前案件领域（设计稿 §13）。要件卡、程序节点卡、危机词表卡是领域包的三张「骨架卡」，其余是血肉。

## Q3 推理层：法律方法怎么进 agent

**三条路我选「结构化中间产物为主、程序化校验兜底、提示只做翻译」。** 现状是提示为主（prompt.ts 11 条输出纪律 + charter 9 节）加事后闸，中间产物只有事实卡与 calc_json。承诺短语表四轮翻车（R3 第 8 条）证明：靠提示让模型自己守纪律，判据只能在文本层追着改；把纪律做成中间产物，判据就能判结构。

**一轮回答的中间产物清单**（顺序即执行顺序，前六项确定性、后三项模型参与）：

1. **看档回执**：snapshot 哈希 + 报告 stale 状态 + 近 72h 危机标记（现有 case-facts 首行状态区，改为可被写工具校验的 token，见 Q4）。
2. **场景键**：`(scene=cases.stage, claim_kinds=claims.kind[])`，全部取自已落库结构化字段，不新增模型判断（method-core-article-map 已这样做）。
3. **要件表实例**：按场景键取要件卡，把档案里的事实槽位（timeline/claims/evidence/首诊四项）对到要件上，每要件算出三态（成立/缺失/不成立）+ 来源档（Q4 四档）。纯函数 `buildElementSheet(snapshot, elementCards)`，放 lib/agent/elements.ts。
4. **争点表**：从要件表推导：状态≠成立的要件、对方主张槽位非空的要件、burden=用人单位但档案里已有对方书面决定的要件（举证倒置触发点，R2 提醒两条规则强度不同，要件卡 burden 分「司法解释限定类」与「仲裁办案规则证据偏在类」）。
5. **举证责任分配**：每个争点渲染「由谁证、现在手上有什么、缺什么」，直接来自要件卡 burden 与证据分类计数。
6. **程序节点**：当前 stage 的期限清单 + 下一节点触发条件（Q5）。
7. **模型填槽（element_fill 工具）**：用户本轮的新话，模型只做「这句话对应哪个事实槽/哪个要件/来源档是自述还是书证」的映射，写入 timeline/claims 时带 element_ref。代码校验槽位存在、来源档合法。
8. **依据包**：核心条映射 + 检索补足（现有 ⭐机制），加要件表里「存疑要件」的 basis 定向注入——这解决「S3b 只能补映射表已声明的场景」（R3 短板 4）：要件卡替映射表覆盖了全部 claim_kind。
9. **风险区间**：claim_calc 给两档——「按档案现有书证能撑的最低值」与「用户自述全部成立的最高值」，用 InputSource 四档加权，展示为区间 + 每个差额对应哪个要件缺证。**不给胜率百分比**（charter §1）。
10. **输出与闸**：模型写正文 + action_card；现有闸链（杠杆闸→NBDpsy 闸→判例污染→引用闸→核心条兜底）不撤，新增「争点回声」判据：正文提到的争点必须与争点表同集，多出来的是模型自己发明的争点，少了的是漏答。

**三段论的落法**：大前提 = 条文锚（逐字）、小前提 = 要件表里状态为「成立」的要件及其来源档、结论 = 由要件卡声明的法律效果（如「§46(一) + §38 → 有权主张 N」）。模型不做涵摄，代码做；模型解释涵摄结果。

**何时拒答/转人工**：① 要件表 P0 要件（劳动关系存在、解除事实、工资基数）全部「缺失」→ 本轮转问诊轮（现有 EMPTY_PACK_DIRECTIVE 的同款思路：禁令必须配出路）；② 场景键落在领域包未声明的 stage/claim_kind → 明说「这个诉求我还没有可靠的要件清单」+ 给保守动作；③ stage ≥ 仲裁准备且争点表里有 burden=劳动者 的要件缺证 → 行动卡里给法援/工会资源卡一次（charter §1 例外，不劝找律师）；④ 用户要求代拟诉讼代理/出庭代言 → 硬拒（律师法 §13）。

## Q4 记忆与档案

**四档来源分级**（BOARD 已立「档案事实证据分级」专项，本方案给落法）：timeline_events、claims 输入、evidence 简报结论、company_profiles 各加 `source_tier`：`自述 | 书证 | 对方认可 | 裁审认定`，加 `asserted_by`：`user | agent_inferred | doc_extract | system`。现状 timeline_events 只有 kind（公司动作/我方动作/系统动作/期限）没有来源，claims 只在 calc_json 里有 InputSource（用户自述/证据佐证/系统默认）——两处口径不同，要收成一份枚举放 lib/cases/source-tier.ts，calc 的 InputSource 改为它的子集。

**事实卡渲染**：每条事实后缀档位标记（`[自述]` / `[书证#12]` / `[对方认可·timeline#8]`），缺失写「未记录」（现有铁律不变）。要件表的三态由档位推：书证及以上才算「成立」，纯自述算「成立·待证」，渲染时明写。**关键节点强制复核**：stage 进入「仲裁准备」时，P0 要件全为自述的案件，事实卡首行加「三项关键事实仍无书证」，行动卡强制含取证项。

**用户自述 vs 第三方证据**：evidence 表已有简报机制与「未提取」标记（case-facts.ts EVIDENCE_DISCLAIMER），把简报结论写入时间线的事件一律 asserted_by=doc_extract、tier=书证；用户口述公司说了什么 → tier=自述、进要件表「对方主张」槽而非事实槽。

**「每轮先看档」的强制**：站内 runTurn 天然注入事实卡。用户自带 agent 靠不住 skill 纪律，所以加**看档回执**：case_facts / case_report_get 回包带 `facts_token`（snapshot 哈希 + 签发时间，10 分钟有效）；case_update（stage）、claims_upsert、deadline_set、draft_write 四个高危写工具要求带 token，缺失或过期返回 `FACTS_STALE` 并附最新事实卡——不是拒绝干活，是把「先看档」变成写入的前置条件，与幂等键同一形态。timeline_add / emotion_log 不要求（低危、高频）。

**个案报告**：case_reports 惰性生成 + stale 标记已落地（report.ts / report-stale.ts），本方案只加两节的取数口径：「争议焦点」source=disputes 改为直接渲染争点表，「风险与未定项」渲染要件表里缺失/存疑项——报告不再由模型自由整理这两节，模型只能改措辞。

## Q5 工具面与执行

**边界三条**：① 工具面**没有**「发出/递交/代为发言」动作，只有 draft_write + share_create（用户自己发）；② 一切金额、日期、引用只能由 claim_calc / deadline_set / knowledge_get / citation_check 产出，模型自由文本里出现的同类数字视为未验证；③ 对外文书服务端强制 send_consequences（设计稿 §4.4 已定）。

**幂等**：idempotent.ts 现在只覆盖注册的写能力，timeline_add 靠 agent 自律（R3 短板 2）。改成注册表级默认：每个写能力声明 `idempotencyKey(args) → string`，timeline_add 用 `case_id + happened_at 日 + 归一化 title`，action_create 用 `case_id + 归一化 title + due 日`，claims_upsert 用 `case_id + kind`；服务端命中即返回 deduped=true（dossier_confirm 已是这个形态）。registry-guard 测试加一条：写能力没声明 idempotencyKey 即红。

**共用一套能力**：lib/capabilities/registry.ts 已是 MCP/REST/站内三入口单一真源；新增 element_fill、element_sheet_get（读要件表）、issue_list（读争点表）三个能力，同样注册一次三处可用。skill 文档由 gen-agent-docs.ts 从注册表生成，不手写第二份。

**陪跑节奏由程序节点驱动**：领域包新增 `procedureNodes: [{stage, deadlineRules: [{kind, from: 事件类型, days, basis: articleKey}], nextTriggers}]`。stage 变更（case_update 或 intake_submit）时服务端按规则自动 deadline_set（derived_from 写规则 id），不等模型调。deadline-reminder.ts 已在线（首封真发已证实），扩到 action_items 的 due_at：到期前一天与当天各一次，邮件正文由确定性模板渲染，不经模型。「催办」不由模型自发，由任务触发后在下一轮事实卡首行标「上轮 2 张行动卡逾期未完成」，模型按 charter §9 问障碍。

## Q6 安全与合规

| 边界 | 谁守卫 | 怎么验 |
|---|---|---|
| 不自称律师/律师意见、不代理诉讼、不承诺胜率 | charter §1 + 字面闸（新增 PRACTICE_BOUNDARY_PHRASES：「我是律师」「胜率 X%」「包赢」「我替你交/发」）+ 工具面无发出动作 | 变异矩阵：每个短语正负样本各 3；工具面快照测试断言无 send/file 类能力 |
| 不劝找律师、资源卡一案一次 | charter §1/§7.7 + referral_offers 台账 | 现有 nbdpsyPitchAssertions 同型 |
| 隐私最小化 | llm/pii.ts 脱敏；counseling 领域来访者默认化名（设计稿 §16）；事实卡姓名两道闸 | 出站请求抓样断言无手机号/身份证；快照测试 |
| 危机干预 | crisis.ts 确定性首段 + 24h 窗 + D15 付费禁令 + 领域词表 + 第二道语义分类（bulk 模型，只能升不能降触发）| S08 + 每领域 ≥2 新语料剧本；分类器输出与词表分歧样本进人工复核队列 |
| 对抗输入·伪造事实 | 来源档：用户口述永远是「自述」，书证只能来自 evidence 提取；attest 出证时点冻结实名 | 剧本：用户声称「公司已书面承认」但无上传 → 要件表仍显示自述 |
| 对抗输入·诱导越界 | S15 拒编造 + 边界短语闸 | holdsLineUnderPressure 现有 |
| 引用核验闸 | stripUnsupportedQuotes / CitationGuard / precedentContamination / renderCoreArticleFallback | 闸剥除率与漏网率并列报告；剥除后必须有补料（禁令配出路） |
| AI 内容标识（2025-09-01 办法）| 站内回复元数据与页脚标识；是否适用一对一问答**待核实**，按适用做 | 页面快照 |
| 算法备案第 17 条 | 待核实；先按不具备舆论属性准备材料 | — |

## Q7 评测与验收

现有 C04 十五剧本 + 机械断言 + judge 两票制 + 红线一票否决，保留。补五件：
1. **要件级断言**：每剧本夹具预置要件表期望（哪些要件应判缺失、哪些争点应出现、谁举证），断言比较结构而非文本——这是「判据设计不能靠语义泛化」（R3 第 8 条）的正解。
2. **深会话剧本**（BOARD 已立）：≥5 轮自然长出档案，验证 ⭐S1 回头客分支、看档回执、幂等、报告 stale。
3. **变异矩阵按要件隔离**：每个要件一条「只差这一条」的负样本（R3 评测盲区③：人写负样本本能整体不合格）。
4. **judge 偏差控制**：判官与被测模型不同厂；诚实税种子清单进 judge 的 mustNot 边界；SPLIT 率按 SHA 记；N/A 占比阈值从 50% 降到 30% 并把中间地带列出来。
5. **留出集与线上抽查**：真实案件脱敏回放（用户授权、姓名替换、不入 git）每季度扩一次，永不进夹具；线上「有回复无用量」缺口 + agent_writes/emotion_log 时序倒挂 + 闸开火率三条日报。
**回归门禁**：红线剧本 + 要件级断言 + 领域包 labor 行为零变化守卫（设计稿 §16 W1）任一红即不发版。**随领域扩展**：每个领域包自带 `eval/` 子目录（剧本、要件期望、危机语料），评测执行器按 domain 参数跑，共用断言原语。

## Q8 多领域扩展

设计稿 §13 已定「一个领域 = 一份配置 + 一组内容」，DomainPack 现有 parties/stages/factsSections/reportSections/deadlineKinds/docKinds/calculatorKinds。本方案加三个**骨架字段**：`elementSheets`（要件卡 id 列表）、`procedureNodes`（期限规则）、`crisisLexicon`（词表 + 首段模板）。共享：工具面、表结构、闸链、评测原语、来源档枚举、条文锚层机制。隔离：知识包目录、要件卡、程序节点、词表、文案词典、评测剧本。

**新领域上线最小清单与准入判据**：① 要件卡覆盖领域 top-N 诉求（劳动 4 种起步：2N/N/欠薪/双倍工资），每个要件 basis 有原文核实的条文锚；② 程序节点表每条期限规则有官方出处（counseling 的协会申诉时限、记录保存年限现标待核实，不达标不得进 procedureNodes，只能进「风险与待律师核」）；③ 危机词表 + 首段 + ≥2 红线剧本 L1 全清；④ 15 剧本等价物 + 要件级断言；⑤ 领域内至少 1 位执业者（counseling = NBDpsy 机构负责人）对要件卡签字复核并落 checked_by；⑥ labor 零变化守卫绿。

## Q9 模型策略

**路由从「关键词 × 套餐」改为「中间产物 × 套餐」**：task-class.ts 现在靠 CRITICAL_PATTERNS 词表（R3 短板 6），改为叠加结构信号——要件表有 P0 要件状态变化、争点表非空、stage ∈ {已收通知, 仲裁准备, 开庭, 裁决}、程序节点 7 日内到期 → critical；词表保留为兜底（偏向 critical 的不对称原则不变）。套餐档继续决定模型池，routing.config.ts 不动定价。

**微调 vs 检索 vs 工具**：不微调。理由：R1 证据显示微调路线（ChatLaw/DISC）仍需 RAG，且微调把法律知识烧进权重后版本失效不可控，与条文锚层的 revision 机制冲突；我们的差异化在结构化中间产物与工具，不在模型。检索继续本地关键词（确定性、可测），修「惩罚精确标注」与别名词表（BOARD 已列）。

**国产合规与离线兜底**：入门档全 DeepSeek/Qwen；中转型号偷换已有 reconcileServedModel。离线兜底 = 不经模型也能给的确定性产物：事实卡、要件表、争点表、期限清单、calc 结果、核心条原文、危机首段——模型不可用时回包这些 + 「分析暂不可用」，不静默。

**用户自带 agent 场景**：我们控制不了模型，只控制三样：① 数字/日期/引用只能由工具产出，模型复述错了用户在网页看到的仍是对的（网页是展示层）；② 写入前置看档回执 + 幂等 + 服务端拒收缺 send_consequences 的文书；③ citation_check 与 element_sheet_get 让守纪律的 agent 有路可走，不守的靠抽查（agent_writes 与回复无对应工具调用的比例）。无工具模式客户端（设计稿 §15：DeepSeek/豆包网页版粘贴）只能拿到渲染好的事实卡与要件表文本，不能写入。

## Q10 路线图（起点 = 当前 main，切片可独立验收）

| 片 | 改什么 | 判据 | 时长 |
|---|---|---|---|
| S1 来源档 | migrate.ts 给 timeline_events/claims/company_profiles 加 source_tier+asserted_by；lib/cases/source-tier.ts 单一枚举；calc InputSource 收成子集；case-facts.ts 渲染档位；工具 schema 加字段 | 事实卡快照测试含档位；旧数据回填为「自述」；深会话剧本里书证事件档位=书证 | 2 周 |
| S2 要件卡+争点表（劳动 4 诉求） | 新卡型或方法卡 facts.elements；gen-knowledge-index.py 校验 basis 可解析；lib/agent/elements.ts 纯函数；element_fill/element_sheet_get/issue_list 三能力注册；prompt.ts 加要件区；依据包按存疑要件定向注入 | 15 剧本要件级断言；争点→行动卡链接率 100%；「未记录≠不成立」断言 0 违规 | 3 周 |
| S3 程序节点 | DomainPack.procedureNodes；stage 变更服务端自动 deadline_set；format.ts:62 与 daysUntil 时区收口；reminder 扩 action_items | 回放集 stage 变更后期限落库 100%；00:00–08:00 CST 边界测试 | 2 周 |
| S4 看档回执+普遍幂等 | facts_token；四个高危写工具校验；registry 写能力必须声明 idempotencyKey | 深会话剧本重复调用 deduped；无 token 写入返回 FACTS_STALE | 1.5 周 |
| S5 路由与评测升级 | task-class 结构信号；judge 诚实税清单；N/A 阈值 30%；领域 eval 子目录 | SPLIT 率、N/A 率按 SHA 对比；labor 零变化守卫 | 1.5 周 |
| S6 counseling 骨架卡 | 要件卡（退费/名誉/伦理申诉）、程序节点（可核实的进表，不可核实的进待律师核）、词表 | Q8 六条准入 | 4 周 |

**现有劳动部分应优化的具体点**：
1. task-class.ts CRITICAL_PATTERNS 词表 → 叠加要件/争点/stage 结构信号（S5）。
2. timeline_add 无幂等（tools.ts / capabilities/families/timeline.ts）→ 注册表级 idempotencyKey（S4）。
3. timeline_events 无来源字段（migrate.ts:246）→ source_tier（S1）。
4. knowledge/index.ts search「惩罚精确标注」（BOARD 四类结构性发现 3）→ keyword 命中按精确度加权；aliases.json 已由 expandQuery 消费，但别名条目需按「真实 query 驱动」持续扩（现有校验已强制每条写 source），把口语↔法言法语的缺口按评测空包轮反推补齐。
5. knowledge/README.md「六条无 statute_quotes」表述过期 → 改为按要件 basis 生成缺卡清单。
6. 法条卡 12 张 vs 判例 103 张、待核实 60 张 → 以要件 basis 为序补法条原文，TODO 清单 B 组优先。
7. crisis.ts CRISIS_TERMS 纯字面 → 保留 + 领域词表 + 只升不降的语义第二道。
8. format.ts:62 第二个 daysUntil → 收口到单一时区函数。
9. countSubstantiveHits / classifyTask「信任调用方传对参数」→ LeverageSubject 同款品牌类型收口。
10. case_reports「争议焦点」「风险与未定项」两节改为渲染争点表/要件表，模型只改措辞。

## 待核实
- 《劳动争议司法解释》举证责任倒置条与《仲裁办案规则》证据偏在条的确切条号（R2 待核实 5），要件卡 burden 分类依赖它。
- AI 内容标识办法与生成式 AI 办法第 17 条对一对一咨询的适用（R1）。
- 北大法宝 MCP 用途条款能否允许经我们 citation_check 白名单转引。
- BOARD 与 A 系教训册未逐行通读，可能有已立项但本方案重复提出的条目。
