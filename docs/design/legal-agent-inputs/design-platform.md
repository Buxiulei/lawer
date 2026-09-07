# 法律智能体设计方案（角度：平台与多领域优先）

> 设计师：平台/多领域视角。起点是土八鼠现状（R3），目标是「第 2、3 个领域上线成本递减而质量不降」。
> 仓库核对基线：wt-int（app/src/lib/domains、capabilities、agent、knowledge、cases、llm），设计稿 §13/§15/§16。
> 数字与法条只认官方源；本方案不新增任何法条数字，凡引用现有卡片的核实状态一律照卡片标注。

## 总论：三层切分与一条主张

**主张**：一个领域 = 一份声明式领域包 + 一组知识卡 + 一套按包参数化的判据集；共用层（内核）里不许出现任何领域字面量，且这条由测试而非人守。现状已经在 `lib/domains/registry.ts` 与 `lib/capabilities/__tests__/registry-guard.test.ts` 落了第一块，但只守了 `lib/capabilities/`；领域字面量仍散在 `lib/agent/task-class.ts`（辞退/仲裁/2N 词表）、`lib/agent/crisis.ts`（CRISIS_TERMS、`CRISIS_RESOURCE_PACK_ID='data-beijing-qiuzhu-ziyuan'`）、`lib/agent/charter.ts`（北京朝阳、仲裁 15 日）、`lib/agent/case-facts.ts`（「用工基本盘（首诊四项）」分节）、`lib/agent/calc/*`（N/2N/年假）、`lib/agent/citation-block.ts`（劳动合同法核心条映射）、`lib/agent/intake.ts`（A→B→C→D 状态机）。同时 56 条能力全部声明 `domains: ['*']`，`knowledge/index.json` 无 `domain` 字段，`SearchOptions` 无 domain 过滤——即「领域过滤」这条机制目前是空转的。

三层：
1. **内核（kernel，跨域不变）**：能力注册表与三入口（MCP/REST/站内）、身份/实名/计费双闸、幂等入口、档案六表 + 个案报告生成器、检索器与 facts 消费面、危机引擎、案号/引用闸、路由表、评测执行器与判官。
2. **领域包（DomainPack，声明式）**：现有 `key/label/parties/stages/factsSections/reportSections/deadlineKinds/docKinds/calculatorKinds` 之上增加：`intakeSchema`、`crisisLexicon`（词表+否定标记+首段模板 id）、`criticalLexicon`（task-class 触发词）、`coreArticles`（核心条映射表）、`calculators`（算钱器实现的引用表）、`deadlineRules`（起算规则）、`boundaryPhrases`（执业边界与承诺短语字面表）、`copy`（NEUTRAL 词典与能力文案）、`evalSuite`（该域的剧本/变异矩阵/红线剧本目录）、`admission`（准入判据清单状态）。
3. **知识内容（knowledge/packs/<domain>/ + common/）**：卡片式，frontmatter 增 `domain`；`common` 域放民法典总则/民诉法/个保法这类跨域法条，各域 `related` 引用它，不复制。

## Q1 目标函数：什么叫「好的法律智能体」

定义：在用户自己的窗口期（劳动：风闻裁员→HR 约谈）里，每一轮回答都**有依据、有行动、有档、不越界、不漏人**。可量化判据（按 PR 门禁与周抽查两档）：

| 判据 | 量值 | 测法 |
|---|---|---|
| 引用可回溯率 | 涉法断言中带卡 id 且卡 `confidence=原文核实` 的比例 ≥95%；`待核实` 卡引用必须带状态 | 评测 G-系列机械断言（citation-block） |
| 编造案号率 | 0 | citation-guard 流上闸 + 评测 G1 |
| 红线剧本通过率 | 100%（任一 L1 FAIL 整场 FAIL） | scripts/eval `redline` |
| 期限落档率 | 剧本含期限触发事实时 `deadline_set` 调用率 100% | 工具调用断言 |
| 「未记录」误读率 | 0（不得把〔未记录〕说成「没有/不存在」） | 字面断言 + judge |
| 危机召回/误触 | 词表+变异矩阵召回 ≥95%，误触 ≤2% | crisis 纯函数矩阵 |
| 越界短语 | 0 | boundaryPhrases 字面表 |
| 行动卡具体度 | ≥90% 卡含「做什么/怎么做/为什么/截止」四要素 | action_card schema + judge |
| 写档重复率 | 同 client_ref 重复写入 0 | idempotent 台账 |
| 线上抽查 | 每周 20 轮人审，缺口=「有回复无引用」「有期限事实无 deadline」 | 人审表 |

**失败模式清单与拦截层**（谁拦是设计核心，不是模型）：
1. 幻觉引用（案号/条号/数字）→ 内核：`citation-guard.ts` 流上白名单 + 占位号启发式；`citation-block.ts` 逐卡引用块；数字只走 `facts.values`。领域包只提供 `coreArticles`。
2. 越界执业（自称律师/代理/包赢/胜率百分比）→ 内核字面闸（新增 `boundaryPhrases`，与承诺短语表同范式：施事+完成态+对象三要素），charter §1/§7 兜底，评测红线剧本。
3. 漏期限→ `deadlines` 表 + case-facts P0「0 条〔未记录〕≠没有期限」+ 领域包 `deadlineRules` 程序化起算 + 提醒任务。
4. 把〔未记录〕当不存在→ case-facts 铁律（已落）+ 评测字面断言。
5. 情绪危机漏接/误触→ `crisis.ts` 确定性引擎 + 领域包词表 + 24h 窗口；不交给模型。
6. 用户错误前提被强化（R1：模型会强化用户输入中的错误法律前提）→ 推理层中间产物「前提核验行」（Q3）。
7. 不可逆动作未经确认→ charter §7.2 + action_card 增 `irreversible:true` 时必带确认句（schema 校验）。
8. 跨域污染（劳动一年时效被用到咨询纠纷三年诉讼时效）→ 知识检索 domain 过滤默认开 + 能力 `domains` 真实生效 + 共用层字面量守卫扩到 `lib/agent`。
9. 写档重复/丢失→ `idempotent.ts` 扩到所有写能力 + `bestEffort` 唯一入口。
10. 敏感信息外泄（咨询领域来访者）→ 证据/事实卡敏感级列 + `pii.ts` + 导出脱敏。
11. 模型偷换/静默降级→ `reconcileServedModel` 留痕。
12. 用户自带 agent 忽略协议→ 服务端回包封装（Q9），不靠客户端自觉。

## Q2 知识层

**采集**：法条首源 flk.npc.gov.cn（整篇抓取+条号匹配，无条级 API），地方规定 beijing.gov.cn/rsj.beijing.gov.cn，判例只用官方公开渠道（人民法院案例库、指导性案例、人社局典型案例），不爬裁判文书网、不整段转录商业库（R2 授权与合规结论）。北大法宝 MCP 只作「实时核验」用途，不作缓存底座，除非拿到书面授权（待核实项 R2-2）。

**结构化：保留卡片 + facts，不上图谱**。理由：220 卡量级下图谱没有消费者；卡片 + `facts.statute_quotes/values/hotlines` 已是代码唯一读取面，校验器强制「facts 值必须在正文逐字出现」——这条纪律就是可回溯的根。要补的是一张**断言台账**（assertion ledger）：`{claim_key, pack_id, source_idx, quote, effective_from, confidence}`，由 `gen-knowledge-index.py` 从 facts 生成，agent 输出中每条涉法断言要能落到一行台账。这是「每一句法律断言可回溯到官方原文」的机械定义：**回溯 = 断言→卡 id→facts 条目→sources[source_idx] 官方 URL→逐字引文**，四跳缺一即判「待核实」。

**版本与有效性**：沿用「单点事实源卡」+「复核触发条件」（beijing-shepin-fengding 范本），不做年度死刷新；每张源卡记 `effective_from` 与 `review_trigger`（如「市统计局年鉴发布」「最高法废止公告」）。facts 结构增 `effective_from/until`（R2 与记忆条目「数据卡缺生效期间」一致，先建结构再迁数据）。

**领域打包**：`knowledge/packs/<domain>/` + `common/`；index 增 `domain` 字段；`SearchOptions.domain` 默认取案件领域，显式 `crossDomain:true` 才放开；`common` 恒可见。核心条映射表（citation-block 的 S3b 定向补注）从共用代码搬入领域包 `coreArticles`，且**准入判据要求映射表里每条都有 `statute_quotes`**——直接堵掉 R3 短板 4（46/47/87/40/41/39 六条无逐字原文）。

**核实与更新**：`TODO核实清单.md` 分域分组；新域上线前 A 组（硬数字）与核心条清零，其余可带「待核实」但 confidence 必须如实透传。

## Q3 推理层

法律方法不靠提示词「讲道理」，靠**结构化中间产物 + 程序化校验**。一轮回答的中间产物（全部可落库、可断言）：
1. **档案读取回执**：`case_facts` 渲染结果 + 报告节选（Q4），带「上轮行动卡状态」。
2. **前提核验行**：模型先列出用户本轮陈述里被当作前提的法律命题（如「试用期可以随时辞退」），每条标「与库一致/与库相反/库无」——与库相反的必须在回答里纠正，评测断言可查。
3. **争点表**：`{issue, our_claim, their_likely_claim, burden(谁举证), evidence_have, evidence_gap}`；举证责任分配读领域包 `burdenRules`（劳动：解释里的用人单位举证事项 vs 仲裁办案规则的证据偏在——R2 指出是两条不同强度规则，卡片需分开，条号待核实）。
4. **要件表**：从核心条映射取要件清单，逐要件标「已证/自述待证/缺」——三段论在这里落地：大前提=法条卡逐字，小前提=要件表，结论只允许是**风险区间**。
5. **金额产物**：一律 `claim_calc`，展示算式与输入来源（`InputSource` 已有），不许正文手算。
6. **期限产物**：触发事实→`deadlineRules`→`deadline_set`。
7. **行动卡** ≤3 张，schema 校验四要素。
8. **拒答/转人工判定**：程序化三条件——核心条映射无命中且 `countSubstantiveHits=0`（空手感知）；争点涉及领域包 `outOfScope`（如刑事、涉外）；用户要求代理/出庭/代签。触发即走固定模板「这点我需要核实，先按保守做法…」，不劝找律师，但仲裁立案后按 stage 自然给一次资源卡。

哪些靠什么：前提核验/争点/要件表靠**结构化输出 + 提示**（模型擅长），一致性靠**程序化校验**（要件表引用的卡 id 必须在本轮检索集或 `searcher.get()` 直取集里——注意 R3 指出 `retrievedIds` 不含直取卡，判据要合并两集）。

## Q4 记忆与档案

现状六张扁平表 + 刚立项的 `case_reports`（`report.ts/report-stale.ts` 惰性生成 + 过期标记）。设计：
- **先看档再答**是协议不是习惯：站内由 `prompt.ts` 强制注入 case_facts + 报告节选；MCP/skill 侧在 `SKILL.md`/manifest 写「每轮先 `case_report_get`（stale 时先 `case_facts`）」，并由服务端在 `tools/call` 上做**软校验**：同一会话（key+case）30 分钟内无读档调用即写入 `timeline_add/draft_write` 时回包附 `warning: NO_RECENT_READ`，站内则直接不放行写入。
- **来源标注**：档案每条事实带枚举列 `provenance ∈ {用户自述, OCR抽取, 第三方材料(已出证), 官方文书, agent推断}` 与 `verified ∈ {未核, 用户确认, 材料印证}`；case-facts 渲染时逐条带〔用户自述待核实〕/〔已核验〕（现已有两种标记，扩成枚举而非散字符串）。
- **叙事层** = 报告的 `narrative` 节，只允许由 `timeline` 长出来，不接受模型自由改写；`changelog` 只追加。
- **证据简报**（`evidence_brief`）挂敏感级；咨询领域来访者信息默认化名。
- 领域差异只在 `factsSections/reportSections` 声明，渲染器共用；`domain-pack-labor.test.ts` 那种「对着源码比标题」的判据改为渲染器读包，再由通用契约测试跑每个包。

## Q5 工具面与执行

**边界**：能力注册表已是三入口单一真源（`registry.ts` + `families/*`），保留。补三件：
1. `domains` 字段真实生效——`claim_calc`、`company_*`（改「对方主体情报」）、`deadline_set` 的 kind 校验绑定领域包；`tools/list` 无案件上下文时给并集但每条带 `domains` 元数据，用户 agent 能读。
2. **幂等普适化**：`withClientRef` 目前只覆盖注册写能力，`timeline_add` 自带列；把 `client_ref` 变成写能力 schema 的必填可选项（缺则用自然键：`(case_id, kind, occurred_at, title)` 归一后哈希）——解决 GPT 事故「同事件写两次」。
3. **spend 类**走报价→确认（已有 `dossier_quote/confirm`），跨域不变。

**共用一套能力**：站内 `AGENT_TOOLS`（11 个）与注册表现在是两份声明；改为站内工具集也从注册表 `exposeTo:['site']` 派生，`action_card/intake_done` 这类纯站内工具登记为 `exposeTo:['site']` 而非另写。

**陪跑节奏由 agent 驱动但由内核计时**：行动卡到期 → 提醒任务（已有 deadline reminder）→ 下一轮开场「前情提要」由 `recapBrief` 生成；催办不靠模型记得，靠 `action_items.due_at` 与 cron。用户自带 agent 场景下，催办走邮件/站内，并在 `case_report_get` 回包顶部带「逾期待办」块。

## Q6 安全与合规

| 项 | 规则 | 守卫 | 验法 |
|---|---|---|---|
| 执业边界 | 不自称律师、不代理/代言、不承诺结果、不报胜率；只做咨询、文书起草、期限与证据整理（律师法§13 与基层查处形态，R1） | `boundaryPhrases` 字面闸（内核）+ charter §1/§7 | 变异矩阵：每条短语的隔离负样本 |
| AI 内容标识 | 站内回复与导出文书加显式标识（2025-09-01 起办法；是否覆盖一对一问答待核实，按「适用」从严） | 渲染层固定角标 + 导出元数据 | 快照测试 |
| 隐私最小化 | 证件号不落明文；来访者信息化名；`pii.ts` 占位符出站前还原只在服务端 | `pii.ts` + 敏感级列 | 出站抓包断言无原文 |
| 危机干预 | 确定性首段不经模型；热线只取 `facts.hotlines status=usable`；forbidden 号码全库禁出 | `crisis.ts` + 校验器 | 纯函数矩阵 + forbidden 扫描 |
| 对抗输入 | 伪造事实→provenance 标「用户自述」永不升级为「已核验」；诱导越界（「你就当律师帮我签」）→ boundary 闸；prompt 注入→packs 原文与用户消息分区、工具描述不含可执行指令 | case-facts + 闸 | 红线剧本 S-adv 系列 |
| 引用核验闸 | 案号白名单流上闸；条号必须在本轮检索集∪直取集；数字必须来自 facts | citation-guard/citation-block | G1–G4 |
| 备案门槛 | 暂行办法§17 是否适用待核实；先按「一对一咨询、无社会动员」准备说明材料 | 合规清单 | 人工 |

## Q7 评测与验收

现状：C04 十五剧本 + 机械断言 + judge 两票制 + 红线整场 FAIL + 判据同源（judge 直接 import lib/agent）。平台化改法：
1. **判据集按领域包参数化**：`scripts/eval` 执行器不变，剧本目录 `scripts/eval/suites/<domain>/`，每包必须交付：≥15 剧本、≥2 红线剧本、每个判据要件的隔离负样本（变异矩阵）、留出集（不进 PR 门禁，季度跑）。
2. **契约测试（跨包共用）**：对每个 `DOMAINS[key]` 自动跑——stages 非空且与 DDL 一致、factsSections 渲染无空节、coreArticles 每条有 statute_quotes、crisisLexicon 与 NEGATION 无互相抵消、boundaryPhrases 负样本全过、能力 `domains` 引用的 kind 都在包内。新包接入 = 这套全绿。
3. **判官偏差控制**：两票 + SPLIT 交人工保留；加「判官盲测」：每季用 20 条人审已定结论校准判官一致率，低于 90% 换判官模型或改锚点。
4. **线上抽查**：每周 20 轮，判据固定为缺口型（有回复无引用/有期限事实无 deadline/危机词命中无卡），不看「好不好」。
5. **回归门禁**：红线 100% + 机械断言不降 + 引用可回溯率不降；judge 项允许 SPLIT 但不允许 FAIL 增加。
6. **真实案例回放**：脱敏后的真实会话作留出集（用户同意），只在发版前跑。

## Q8 多领域扩展

**共享**：内核全部（Q5 三入口、双闸、幂等、档案六表、报告生成器、检索器、危机引擎、引用闸、路由表、评测执行器、账号/实名/NBDpsy 互认）。
**隔离**：领域包全部字段、`knowledge/packs/<domain>/`、评测 suites、NEUTRAL 词典与页面文案、领域热线/资源卡 id。**不做**一案多域、不做领域间案情互通。

**新领域最小清单**（缺一不准入，由契约测试 + 人审两道）：
1. `domains/<key>.ts` 全字段填齐，`DOMAINS` 挂行；共用层字面量守卫扩到 `lib/agent`、`lib/cases` 全绿。
2. 知识包：核心条映射 100% 有逐字原文；硬数字 data 卡 A 组清零；法条卡 `confidence=原文核实` 占比 ≥80%；判例卡无编造案号；TODO 清单分组登记。
3. 危机词表 + 首段模板 + 热线卡（`status=usable` 经电话核验），变异矩阵召回 ≥95%。
4. 评测 suite ≥15 剧本 + ≥2 红线 + 变异矩阵，全绿。
5. 律师复核清单闭卷（咨询域四项：强制报告主体、合同定性、记录保存年限、地方许可）——未闭卷项进事实卡「风险与待律师核」固定节。
6. 合规：执业边界短语表补该域形态（如「替你写伦理答辩并署名」）。

**递减成本的来源**：第二个域（counseling）要付的是 W1「把劳动字面量搬进包」的一次性平台费；第三个域（婚姻家庭）只付内容 + suite。准入判据不随域数放松。

## Q9 模型策略

- **路由**：保留 `taskClass × plan` 查表（`routing.config.ts`），但 `classifyTask` 的 CRITICAL_PATTERNS 搬入领域包 `criticalLexicon`，共用的只有「危机→critical」「文书模式→critical」。仍用词表不用小模型分类（分类误判的方式恰是最致命的）。
- **成本**：bulk 恒不走 Claude；critical 偏向上判；`reconcileServedModel` 按实付计价。
- **微调 vs 检索 vs 工具**：不微调（R1：无产品敢只靠参数记忆；微调无法随法条更新）；检索接地 + 工具产物（算钱/期限/引用闸）是主体；judge 用便宜模型两票。
- **国产合规**：入门档全 DeepSeek/Qwen；critical 走 Claude 经中转时 `served_model` 留痕；离线兜底 = DEGRADE_CHAIN 只向后 + 危机层与引用闸不依赖模型（模型全挂时危机首段与 case_facts 仍可出）。
- **用户自带 agent 场景（控制不了模型）靠三件**：①**服务端产物即事实**——`claim_calc/deadline_set/citation_check/case_report_get` 回包是结构化、带引用与来源的，模型只能转述；②**回包封装（answer envelope）**：每个读能力回包带 `must_say`（如「以下数字来自档案，未核验项已标」）与 `must_not`（「不得补一个查不到的案号」），并在 `citation_check` 上把「引用核验」做成用户 agent 可调的显式能力，skill 文档要求回答前调用；③**无工具模式**（§15 D）：粘贴块里带事实卡 + 报告 + 引用清单，回收 ```tubashu 结构块由服务端校验后才落档——用户 agent 的自由文本永远不直接写库。质量下限 = 服务端产物质量，而非模型质量。

## Q10 路线图（以现状为起点，切片可验证）

| 片 | 改什么 | 判据 | 时长 |
|---|---|---|---|
| S1 内核去领域化 | `task-class.ts` 词表、`crisis.ts` 词表/资源卡 id、`citation-block.ts` 核心条映射、`case-facts.ts` 分节标题、`intake.ts` 状态机、`AGENT_TOOLS` 派生自注册表，全部改为读 `DomainPack`；守卫从 `lib/capabilities` 扩到 `lib/agent`、`lib/cases` | 守卫测试对 `lib/agent` 全绿；C04 十五剧本零行为变化（输出 diff 为空或仅顺序） | 2 周 |
| S2 知识分域 + 断言台账 | index/frontmatter 加 `domain`；`SearchOptions.domain`；`common/` 域；`gen-knowledge-index.py` 生成断言台账；facts 加 `effective_from` | 劳动核心六条 statute_quotes 100%；跨域检索默认关闭的单测；台账每行四跳可达 | 2 周 |
| S3 幂等普适 + 读档协议 | `client_ref` 进所有写能力 schema，自然键兜底；`NO_RECENT_READ` 软校验；`intake_submit` 幂等 | 重放同一写入 0 重复；GPT 事故剧本回放不再双写 | 1 周 |
| S4 评测参数化 + 契约测试 | `scripts/eval/suites/labor/` 迁移；`domain-contract.test.ts` 对每个包跑 | labor 全绿；空包 `counseling` 骨架被契约测试点名缺哪项 | 1 周 |
| S5 第二域 counseling 准入 | 按 Q8 清单填包、写知识、写 suite | 准入六项全绿；labor 零回归 | 3–4 周 |

**现有劳动部分应优化的具体点**（指到文件）：
1. `lib/agent/task-class.ts`：劳动词表在共用层→搬入 `LABOR.criticalLexicon`，共用函数只留结构；验：criticalReasons 单测不变。
2. `lib/agent/crisis.ts`：CRISIS_TERMS/NEGATION 与 `CRISIS_RESOURCE_PACK_ID` 硬编码→引擎读包 `crisisLexicon`；验：现有 crisis.test 全绿 + 变异矩阵。
3. `lib/capabilities/families/*`：56 条全 `['*']`→`claim_calc/company_*/deadline_set` 绑 `['labor']` 或按包 kind 校验；验：registry-guard 新增「calculatorKinds 引用的 kind 必须在包内」。
4. `lib/agent/citation-block.ts` + `knowledge/packs/statutes/`：核心条映射六条无 statute_quotes→补卡并让准入判据要求 100%；验：core-articles.test 改为读包并断言 quotes 非空。
5. `lib/capabilities/idempotent.ts` + `timeline_add`：仅注册写能力幂等→自然键兜底普适；验：重放测试。
6. `lib/agent/case-facts.ts`：〔用户自述待核实〕/〔已核验〕散字符串→`provenance/verified` 枚举列并渲染；验：字面断言「未记录≠不存在」保留 + 枚举覆盖测试。
7. `lib/deadline/case-day.ts` 与 `format.ts` 的 daysUntil：R3 记两套算法→只留 `case-day.ts` 一处，UI 与提醒同源；验：00:00–08:00 CST 边界用例。
8. `scripts/eval/judge.ts` + 检索集：`retrievedIds` 不含 `searcher.get()` 直取卡→合并两集再判「有无依据」；验：直取卡场景不再误判 FAIL。
9. `lib/agent/orchestrator.ts` 承诺短语表：同范式新增 `boundaryPhrases`（越界执业），字面表 + 三要素；验：变异矩阵。

## 风险
- 去领域化会碰 charter（manager 维护、逐字比对测试），需先裁「charter 分共用段与领域段」。
- 自然键幂等可能把两条真的不同事件误合并（同日同题）；用 `client_ref` 优先、自然键只兜底并回包 `deduped` 让 agent 复述。
- 咨询域法条（民法典/精神卫生法/消保法）与伦理守则均待逐字核对，准入前不得标「原文核实」。
- 暂行办法§17、标识办法适用性待核实，按从严准备。
- 用户自带 agent 忽略 `must_say`，服务端只能保证工具产物正确，无法保证转述正确；线上抽查要盯这一类缺口。
