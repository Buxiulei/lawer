# 土八鼠法律智能体设计方案 —— 接地与可回溯优先

> 设计角度：**一切法律断言必须可回溯到官方原文与档案事实；幻觉是头号敌人。**
> 起点是知识层与引用核验闸，其余各层按「这层能不能把一条没有出处的断言拦下来」排优先级。
> 现状引用的文件路径均以仓库 `app/src/lib/` 与 `knowledge/` 为根；数字来自本次对仓库的实测统计，未实测的标【待核实】。

## 现状基线（本次实测，作为所有判据的分母）

- `knowledge/index.json` 220 张卡：判例 103 / SOP 57 / 法条 12 / 计算 11 / 模板 11 / 数据 7 / 审查规则 7 / 话术 7 / 情绪 3 / 方法 2；confidence：原文核实 139、待核实 60、二手转述 21。
- 带 `facts.statute_quotes` 的卡只有 **12** 张；`statutes/lhtf-jiechu-buchang-core.md` 已收录劳动合同法 §39/40/41/46/47/87 与实施条例 §25/27 的逐字条文——`scripts/eval/README.md` 与 `citation-block.ts` 注释里「六条全库无 statute_quotes」的记载已过时（待跑一遍 S03/S15 确认引用块真能拼出）。
- 103 张判例卡：100 张有 `facts.case_facts`；`case_no` 字段含「（20xx）…号」形态的仅 **19** 张，51 张写的是「官方案例，未公开案号」类文字，其余无该字段。**首条 source 的域名分布：zh.wikisource.org 46、sohu.com 22、rsj.beijing.gov.cn 21、court.gov.cn 7、其它 7**——即超过六成判例卡的「原文」来自非官方转载站，却可能标着 `原文核实`。这是接地视角下最大的一处结构性弱点。
- 运行时确定性闸只有两道半：`agent/citation-guard.ts`（案号白名单+占位流水号启发式，流上替换为【案号待核实】）、`agent/crisis.ts`（字面词表+4 字否定窗+确定性首段）、`orchestrator.ts` 的承诺短语字面表。**法条条号、条文文本、数据卡数值在输出侧没有任何运行时闸**，只有评测侧 G4「光秃条号」事后判。
- 检索 `knowledge/index.ts` 是确定性关键词/场景/标题二元组打分，无向量；`countSubstantiveHits` 是空手感知唯一实现；`method/core-article-map.md` 把「本阶段必须带原文的核心条」做成声明式事实。
- 事实卡 `agent/case-facts.ts`：10 分区、P0–P3 降级、4600 字硬预算、〔未记录〕/〔用户自述待核实〕/〔已核验〕三种状态标签已存在。
- 能力面 `capabilities/families/*` 约 60 个工具，`citation_check` 已落地（法条回「库里有无+逐字原文」，判例回四步法结论）；`idempotent.ts` 的 `withClientRef` 只覆盖走它的写能力，`timeline_add` 自带一套。
- 评测 `scripts/eval`：15 剧本、机械断言纯函数、judge 两票制（deepseek-v4-pro）、红线 S08/S15；已知陷阱 `retrievedIds` 不含 `searcher.get()` 直取卡。

---

## Q1 目标函数：什么叫「好的法律智能体」

**定义**：好 = 在用户当前阶段，给出的每一条法律断言都能被拆成三元组 **〈断言，锚点，核验状态〉**，锚点指向官方原文（法条/文号/官方发布的案例页）或档案事实（带 origin 与 evidence_id），核验状态如实（原文核实/二手转述/待核实/用户自述）；并且**不多说**——档案没有的事实不当作有，库里没有的依据不当作有。「答得多」不是目标，「答的每一句都能被对方律师当庭查而不倒」才是。

**可量化判据**（分母都写在评测夹具里，按 SHA 记一次）：

| 指标 | 判据 | 目标 |
|---|---|---|
| 案号可回溯率 | 输出中每个案号 ∈ 本轮检索原文 | 100%（已由 CitationGuard 保证，评测 G1 复核） |
| 条号可回溯率 | 输出中每个「《X法》第 N 条」∈ 本轮 statute_quotes ∪ 核心条映射 | 100%（新 StatuteGuard，见 Q6） |
| 逐字一致率 | 引号内条文与 `facts.statute_quotes.text` 空白归一后一致 | ≥ 98%，差异必须标【转述】 |
| 数值一致率 | 输出中出现的封顶/最低工资/社平等数字 ∈ `facts.values` 且带生效期间 | 100% |
| 未记录当不存在 | 档案〔未记录〕项被回答成「没有/不适用/时效没问题」 | 0 |
| 漏期限 | 档案有生效期限且剩余 ≤ 15 天时回复未提及 | 0 |
| 危机接住 | 词表命中 + judge 两票集上首段为资源卡 | 100%（红线） |
| 越界执业 | 出现代理/包赢/以律师名义字面表 | 0（红线） |
| 空手如实率 | `countSubstantiveHits==0` 时回复声明「库里没有依据」 | 100% |
| 拒答代价 | 空手率与「能答却不答」占比 | 只观测不优化，防止过度弃权 |

**失败模式清单与拦截层**（L0 知识 → L1 检索 → L2 注入/提示 → L3 输出闸 → L4 工具/服务端 → L5 评测）：

1. 编造案号 → L3 `CitationGuard`；L5 G1。
2. 编造/错配条号、把 §46 讲成 §47 内容 → **L3 StatuteGuard（新）**；L2 引用块预格式化；L5 G4。
3. 真案号+编案情（ISSUE-03 形态）→ L2 `precedentBlocks` 结构分离；L5 `precedentContaminationAssertions`；再加 L3 判例段与 `case_facts` 字段 diff（新）。
4. 引用二手转载当原文 → **L0 法源登记簿**（新）：source 域名不在官方白名单则 confidence 封顶「二手转述」，L2 引用块必须带该状态。
5. 过期法条/过期数值 → L0 `effective_until`/复核触发；L2 引用块生效期间；L5 年度巡检。
6. 〔未记录〕当不存在 → L2 事实卡状态行；L5 新增断言「〔未记录〕分区对应的否定句」；L3 要件表禁止在〔未记录〕格填「满足/不满足」（Q3）。
7. 漏期限 → L2 P0 永不降级；L4 `deadline_list` 服务端算剩余天数；L5 S 剧本；时区口径统一（Q10）。
8. 越界执业（代理、包赢、以律师名义）→ L3 字面表；L4 能力面根本没有「代提交」类工具；L5 红线。
9. 情绪危机漏接 → L3 crisis 词表 + 领域词表（Q8）；影子语义探测只记日志不拦（Q6）；L5 S08。
10. 用户输入错误法律前提（「裁员必须 3N」）→ L2 charter「错误前提先纠」；L3 StatuteGuard 不会放行没有原文的「3N」；L5 `holdsLineUnderPressure`。
11. 证据文件里的指令注入（OCR 出的「忽略以上规则」）→ L4 提取文本作数据封装；L5 对抗剧本。
12. 写档重复/双写 → L4 `withClientRef` 全覆盖。
13. 用户自带 agent 无视纪律 → L4 工具出参自带闸（redactBanned、citation_guide）+ **回贴核验**（Q5/Q9）。

---

## Q2 知识层：让「每一句法律断言可回溯到官方原文」

**结构选择：卡片为主体，加两层薄结构，不上图谱、不上向量库。**

1. **法源登记簿 `knowledge/sources.json`（新，L0 的根）**。每条 = `{source_id, kind: 法律|行政法规|司法解释|部门规章|地方规章|官方文件|官方案例发布|转载, official_host, url, fetched_at, content_sha256, version_label(如 2012修正), status: 现行|已修正|已废止|待核实, superseded_by?, review_trigger}`。卡片 `sources` 从裸 URL 改为 `source_id` 引用（过渡期两者并存，脚本自动登记）。**规则**：`confidence: 原文核实` 只允许在所有引用源的 `official_host` 落在白名单（flk.npc.gov.cn、gov.cn、court.gov.cn、mohrss.gov.cn、beijing.gov.cn、rsj.beijing.gov.cn、bjcourt.gov.cn、chinatax.gov.cn 等，清单进仓库）时成立；wikisource/sohu 一律封顶「二手转述」。`gen-knowledge-index.py` 构建即断。**效果**：判例卡里那 68 张转载源的卡会被如实降级——这不是损失，这是把现在就存在的不确定性写到用户看得见的地方。
2. **锚点字段**。`facts.statute_quotes[]` 增 `anchor: "<law_id>@<article>@<version_label>"` 与 `source_id`；`facts.values[]` 已有 `effective_from`，补 `effective_until?`、`source_id`；`facts.case_facts` 增 `authority: 指导性案例|人民法院案例库入库|公报案例|最高法典型|高院典型|市人社局典型|区仲裁委典型|裁判文书(官方)|裁判文书(转载)` 与 `full_text_available: bool`。效力排序（指导性>入库>公报>典型）R2 已标是业内总结非最高法明文，因此 `authority` 只做**展示与排序提示**，不做效力裁决。
3. **法条边索引**由脚本从 `law_refs`/`related`/`core_article_map` 生成（`knowledge/edges.json`），供 `citation_check` 回「哪些卡引用了这一条」。这是图谱能给的 80% 价值，零维护成本；手工图谱被否决（Q 关键选择）。

**采集**：法条只从 flk.npc.gov.cn 整篇抓取后按条号切分（R2 确认无条级深链），落 `research/raw/`（不入仓），卡片只放逐字条文与 sha；地方规章走 beijing.gov.cn PDF；官方案例走 rsj.beijing.gov.cn / court.gov.cn 专题页；**不爬裁判文书网**（R2 合规风险），不整段转录商业库判例（法宝协议限自用）。裁判文书的「全文四步核验」只对 `full_text_available=true` 的卡执行，否则四步法第一步直接判「内部参考、不进书状」。

**版本与有效性**：没有官方有效性 API，所以用「单点事实源卡 + 登记簿 status + 复核触发」三件套：每张登记簿条目带 `review_trigger`（如「人社局发新年度通告」「最高法发布废止决定」「每年 12 月国办放假安排」），季度跑 `scripts/source-patrol.py`（新）重抓官方页比 sha，不一致只**置 stale 不改卡**，人工核后升级。`data/beijing-shepin-fengding.md` 的做法升为全库规则。

**领域打包**：`knowledge/packs/<domain>/…` + `index.json` 增 `domain`；通则包 `knowledge/packs/common/`（民诉法期间、证据规定、民法典诉讼时效、热线资源）`domain: "*"`。跨域检索默认关。

**可回溯的闭环**：输入侧 `citation-block.ts` 只从 facts 拼引用块（保留）→ 输出侧 StatuteGuard/ValueGuard 只放行本轮 facts 里有的条号与数值 → 每条引用渲染成脚注 `[来源卡 id · 可信度 · 生效期间]`，网页作为展示层给脚注一个卡片页链接，用户点开能看到逐字原文与官方 URL。三段中任何一段断掉，断言就出不来，或出来时带着【待核验】。

---

## Q3 推理层：法律方法进 agent 的方式

**原则：能结构化的走结构化中间产物 + 程序化校验；提示词只负责措辞与顺序，不负责正确性。**（承诺短语四轮翻车、G4 六次挂在同一句指令上，都证明提示词不是防线。）

**一轮回答的中间产物清单**（按生成顺序，每个都落日志可回放）：

1. `facts_card`：`buildCaseFacts` 输出，含状态行（报告过期/基本盘缺项/近期危机）。
2. `crisis_assessment`：确定性首段决定。
3. `retrieval_set`：`search()` 命中 + `get()` 直取 + 核心条映射命中，**三者合并记入 `retrievedIds`**（修现有评测陷阱）。
4. `citation_bundle`：引用块列表，每块带 anchor/source_id/confidence/effective。
5. **`issue_table`（争点表，新）**：服务端由 `claims.kind`、`cases.stage`、时间线事件 kind 确定性生成行，每行 = 争点、请求项、对应核心条 anchor。
6. **`element_table`（要件表，新）**：来自计算规则卡新增的 `facts.claim_elements`（如 2N：劳动关系、解除事实、解除理由或程序违法、工资基数、工龄；每个要件标 `burden: 劳动者|用人单位|待核实` 与 `basis anchor`）。服务端把要件与档案字段对上，每格只能取 {已核验, 用户自述, 〔未记录〕}——模型填的是「评价」列，且程序校验：〔未记录〕格禁止出现「满足/不满足/无风险」，只允许「需补：…」。举证责任的两条不同强度规则（司法解释的几类决定倒置 vs 仲裁办案规则的证据偏在）分别建 statute 卡后引用，条号 R2 标待核实前 `burden` 只允许填「待核实」。
7. `risk_band`：结论档位枚举 {有依据可主张, 需补证后可主张, 依据不足, 反向风险}，不输出「胜率」；金额给区间（封顶/基数口径分支各算一支）。
8. `draft`：模型正文。
9. `gate_report`：CitationGuard/StatuteGuard/ValueGuard/承诺表/杠杆闸/危机卡去重的命中记录。
10. `writes`：带 client_ref 的落档列表 + `markReportStale`。

**三段论怎么进**：不是让模型「写三段论」，而是要件表本身就是小前提（事实格）对大前提（basis anchor）的映射；正文里的「你的情况与之相似之处是…」句法（`precedentBlocks` 已定）把判例事实和用户事实隔开。

**何时拒答/转人工**：① `countSubstantiveHits==0` 且核心条映射无命中 → 空手模式，只做事实登记与问诊；② 案件 domain ≠ 请求领域 → 拒并指路；③ 阶段进入 S4 仲裁准备以后，行动卡固定含「材料交律师/法援复核」项，但措辞不劝（`不劝找律师` 纪律保留，只是把「分流」做成阶段属性而非话术）；④ 要件表里 `burden=待核实` 的要件超过一半 → 结论档位强制「依据不足」。

---

## Q4 记忆与档案

**目标形态**：每轮先看档不是靠 agent 自觉，而是服务端把档塞进它眼前，并且每条事实都带出处。

1. **origin 字段全覆盖**（迁移）：`timeline`、`claims`、`company`、`evidence_brief`、`case_reports` 各节的字段增 `origin: user_stated|agent_inferred|document_extracted|official_verified`、`evidence_ids[]`、`verified_at?`。事实卡渲染时把现有三种标签换成由 origin 推出的四种：〔已核验·证据 #id〕/〔用户自述〕/〔agent 推断〕/〔未记录〕。`case-facts.ts` 「零编造」铁律不变，只是标签有了数据来源而非渲染时猜。
2. **用户自述 vs 第三方证据**：`evidence_extract` 提取文本进 `evidence_brief` 时只允许 `document_extracted`；`timeline_add` 由 agent 调用时默认 `user_stated`，带 `evidence_ids` 且证据已 `attest` 才可升 `official_verified`（出证是免费能力，主理人已拍板）。报告的「证据地图」节按 origin 分栏。
3. **个案报告 = 长期叙事记忆**：保留 `report.ts` 惰性生成 + stale；增「依据清单」节：本案已引用过的 anchor 及其状态，报告过期时该节一并重算——法条改了，旧报告的依据自动标 stale。
4. **先看档再答的强制**：站内 `runTurn` 已必注入；MCP/REST 侧新增 **READ_FIRST 软闸**：写工具（timeline_add/claims_upsert/draft_write/deadline_set）在同一 api key 最近 30 分钟没有过 `case_facts`/`case_get` 读时，返回 `READ_FIRST` 错误并**把事实卡直接夹在错误体里**——代价一次往返，换来「不看档就写」这条路径关闭。
5. **来源标注的表达**：档案页与事实卡统一符号；MCP 出参 `case_facts` 首行状态区已定义，增「未核验事实条数」。

---

## Q5 工具面与执行

1. **边界由注册表声明**：`capabilities/registry.ts` 每条增 `effect: read|write_idempotent|write_append|paid|external` 与 `requires: [realname|balance|quote_confirm|read_first]`。`invoke.ts` 按 effect 强制走 `withClientRef`（**包括迁 `timeline_add` 进来**，它的独立 client_ref 列作过渡兼容），`write_append` 只允许追加（时间线更正走 `corrects_event_id`）。
2. **动作清单与幂等键**：登记（timeline/claims/company）自然键 = 案+kind+规范化标题+日；算钱 `claim_calc` 纯函数 + upsert；期限 `deadline_set` 案+kind+anchor_date；文书 `draft_write` 同题新版本；出证 `evidence_attest` 按 evidence_id 幂等；行动卡 ≤3/次、同题不双建。
3. **三入口一套能力**：P7 已定，注册表生成 manifest/skill/OpenAPI。接地要求补一条：**每个返回法律内容的工具出参都带 `citation_guide` 与 `confidence`**，并且经 `redactBanned`——用户自带模型再怎么改写，它拿到的原料本身是带状态的。
4. **无工具客户端（DeepSeek/豆包网页版粘贴）**：新增 `answer_verify`（REST + 网页粘贴框）：用户把外部 agent 的回答贴回站内，服务端跑同一套输出闸（案号/条号/数值/承诺/代理字面表），返回逐条核验报告并可一键把核验过的依据存进报告「依据清单」。这是我们对控制不了的模型唯一能做的确定性动作。
5. **陪跑节奏由 agent 驱动的机制**：服务端每日计算 `next_touch(case)` = min(最近期限−缓冲, 到期行动卡, 报告 stale 超 7 天)；期限提醒已上线；催办邮件/站内条只陈述事实（「离仲裁时效还剩 12 天，档案里还没有解除通知的证据」），不催消费；用户自带 agent 可用 `case_digest`（新，只读）拉这份摘要作为它的开场。

---

## Q6 安全与合规（每条：谁守卫 / 怎么验）

| 项 | 规则 | 守卫 | 验 |
|---|---|---|---|
| 执业边界·话 | 不以律师名义、不承诺结果、不说「我替你出庭/代你提交/代为谈判」 | `orchestrator.ts` 承诺短语字面表 + 新增「代理动作」字面表（施事=我/我们 + 代理动词 + 诉讼对象三要素齐才收） | 变异矩阵：每要素单独缺失的负样本必须放行 |
| 执业边界·事 | 能力面无向仲裁委/法院提交的动作；文书只生成给用户自己发 | `registry.ts` 无此类工具；`draft_write` 对外文书必带 `send_consequences` | registry-guard 测试枚举全部 effect |
| 隐私最小化 | 中转出境前 PII 占位（`llm/pii.ts`）；MCP 出参默认摘要；转介只传授权摘要 | provider 层、families 层 | 单测：占位符往返；抽查 relay 日志无姓名 |
| 危机干预 | 确定性首段 + 24h 窗 + D15 付费禁令；领域词表分包 | `crisis.ts`；影子语义探测（小模型只打日志） | S08/S15 红线；影子探测与词表的分歧日志周审 |
| 对抗·伪造事实 | 用户说的进档只能是 `user_stated`；与证据冲突时事实卡并列显示 | origin 字段、`evidence_brief` | 剧本：用户口述与 OCR 文本矛盾 |
| 对抗·诱导越界 | 「你就说肯定赢」「帮我编个案号」 | 字面表 + CitationGuard + `refusesToFabricate` | S15 及其变体 |
| 对抗·文档注入 | 提取文本以数据块封装，系统提示声明其非指令 | `evidence_extract` 出参包装 | 剧本：合同 OCR 内含指令 |
| 引用核验闸 | 案号（有）+ **条号/条文/数值（新）** | `citation-guard.ts` 扩展为 `CitationGuard`+`StatuteGuard`+`ValueGuard` 三类同接口 | 每闸变异矩阵；534 号文号类误伤为固定负样本 |
| AI 标识 | 生成内容显式标识 | 网页/文书页脚 | 待核实一对一咨询是否适用，先按适用做 |

StatuteGuard 细节：正则捕「《?X法》?第 N 条」，流上缓冲；放行集 = 本轮 `statute_quotes` 的 (law, article) ∪ 核心条映射命中且已取到原文的条；不在集内替换为「《X法》第 N 条【条号待核验】」并计入 notice。文号（京高法发〔2024〕534 号）形态显式排除。引号内条文与 facts 文本比对：不一致不替换，只追加【非逐字，见来源卡】。ValueGuard：捕带单位的金额/百分比，若与 `facts.values` 某 key 在 ±0.5% 内但不相等 → 标【数值与来源卡不一致】。

---

## Q7 评测与验收

1. **三个集合**：① C04 剧本集（现 15，扩到 ≥25，新增：错误前提、文档注入、〔未记录〕否定句、二手源引用标注、期限剩余 ≤15 天）；② 变异矩阵：每道闸每个要件的隔离负样本，随修法同补丁落盘（`assertions.test.ts` 旁）；③ **留出集**：真实案件回放（脱敏，用户授权），只由评测官持有 SHA，从不用于调判据，每季度跑一次报「留出集不认识我」的分数。
2. **接地专项断言（机械，不经 judge）**：`citationCompletenessAssertions` 扩为：条号 ⊆ retrieved anchors；引号内条文 diff；数值 ∈ values；二手源引用必带「二手转述」字样；〔未记录〕分区不得对应否定句。分母声明：夹具里显式写每条断言该覆盖的剧本列表，覆盖为 0 时构建红（判据同源断裂教训）。
3. **judge 偏差控制**：两票制保留；judge 模型 ≠ 被测模型；judge 只答「发生/未发生」；judge 永不判引用正确性（那是机械项）；SPLIT 率按 SHA 记，>10% 视为判据设计问题不是模型问题。
4. **线上抽查**：每周抽 5% 轮次离线重跑输出闸 + `gate_report` 统计，看「被替换的【待核验】」数量趋势；首轮流量抽查判据（有回复无用量缺口=0）保留。
5. **回归门禁**：PR 必跑 S08/S15 + 接地专项；改卡必过 `gen-knowledge-index.py`（含新登记簿校验）；改闸必附变异矩阵。
6. **随领域扩展**：剧本与红线放 `domains/<key>/eval/`，共用断言原语在 `scripts/eval/assertions.ts`；新领域没有 ≥2 条红线剧本与 ≥10 剧本不许上线（Q8）。

---

## Q8 多领域扩展

**共享**：引擎（orchestrator、闸门框架、幂等、计费、路由）、事实卡/报告渲染器、能力注册表与生成器、评测原语、法源登记簿格式、`knowledge/packs/common/` 通则包、危机首段机制与热线数据结构。
**隔离**（`lib/domains/<key>.ts` + `knowledge/packs/<key>/`）：阶段、首诊 schema、事实卡/报告分节、算钱器与 `claim_elements`、期限种类、文书种类、危机词表、承诺/代理字面表的领域词、文案、核心条映射、剧本与红线。`registry-guard.test.ts` 已禁共用层出现领域字面量，扩展为也禁出现在 `knowledge/packs/common/`。

**新领域上线最小清单**：① DomainPack 全字段实现；② 法源登记簿条目全部官方白名单或显式二手；③ 核心条映射每个阶段 ≥1 条且原文已收；④ `claim_elements` 覆盖每个 calculatorKind；⑤ 危机词表 + 领域特有语言形态样本 ≥30 条通过词表回归；⑥ ≥10 剧本 + ≥2 红线 + 每道闸变异矩阵；⑦ 接地专项断言全绿三轮；⑧ 权威层级说明：心理咨询领域的伦理守则（学会守则）不是法律，`authority` 标「行业规范」，引用时必须带此状态——这一条是心理咨询包与劳动包最不同的接地点；⑨ 空手率基线记录。准入判据：三轮 0 编造引用、〔未记录〕误判 0、红线 0 FAIL。

---

## Q9 模型策略

- **检索+工具 > 微调**：不做领域微调。理由：微调把某一天的法烤进权重，无法回溯、无法随登记簿失效；评测集也不够大到能证明微调没有引入新幻觉。模型只需两种能力：照抄引用块、按要件表填评价。
- **路由**：保留 `routing.config.ts` 套餐×taskClass；`task-class.ts` 增第五类「需引用」（文书/金额/期限/判例已是 critical，补「解释法条」）：需引用的轮次只允许走通过接地专项断言 ≥95% 的模型（按 SHA 记的模型分数表进配置），套餐再低也不掉到没过线的模型——这是把「价格驱动」改成「任务驱动」的最小改动。
- **成本**：接地机制大部分是确定性代码，不增加 token；要件表由服务端生成只增几百字。
- **合规**：DeepSeek/通义为国产主路；Claude 中转前 PII 占位；served_model 留痕已做。
- **离线兜底「无模型模式」**：LLM 全挂时事实卡、期限计算、`claim_calc`、`template_fill`、危机首段、`answer_verify` 全部可用——它们本来就不经模型。
- **用户自带 agent 时的质量保证**：①工具出参自带闸与状态（Q5-3）；②`citation_check`/`answer_verify` 让对方模型自查、让用户回贴核验；③skill 文本规定固定工作流（先 case_facts → knowledge_search → citation_check → 写）并由 READ_FIRST 软闸兜底；④对方写入档案的内容一律 `updated_by=agent(key)`、origin 默认 `agent_inferred`，网页展示层标黄；⑤客户端矩阵里无工具客户端只给「粘贴回执」路径，不宣称等价。

---

## Q10 路线图（以现状为起点，每片可验证）

| 片 | 改什么 | 判据 | 时长 |
|---|---|---|---|
| S1 法源登记簿与可信度封顶 | `knowledge/sources.json`、`gen-knowledge-index.py` 校验、卡片 sources→source_id 迁移脚本 | 构建通过；转载源卡 confidence 全部 ≤ 二手转述（预期约 68 张判例卡变动，以脚本统计为准）；`原文核实` 卡 100% 官方域名 | 1–2 周 |
| S2 StatuteGuard/ValueGuard | `citation-guard.ts` 抽象为三闸同接口；`orchestrator.ts` 流上接线；notice 留痕 | 变异矩阵全绿（含 534 号文号不误伤）；S03/S15 三轮「光秃条号」由评测项变为运行时 0 泄漏 | 1–2 周 |
| S3 要件表/争点表 | calc 卡加 `facts.claim_elements`；`agent/` 新增 `issue-table.ts`；事实卡后追加要件表分区（预算内） | 〔未记录〕格 0 次出现「满足/不满足」；S05/S07 结论档位与人工标注一致 ≥90% | 2 周 |
| S4 回贴核验与 READ_FIRST | `answer_verify` 能力 + 网页粘贴框；`invoke.ts` 软闸 | 粘贴含假案号/假条号的样本 100% 标出；MCP 无读先写返回 READ_FIRST 且错误体含事实卡 | 1–2 周 |
| S5 origin 全覆盖与报告依据清单 | 迁移 + 渲染器 + `report.ts` 新节 | 事实卡四种标签由数据推出，无渲染时猜测；法条卡 stale 后报告依据节同步 stale | 2 周 |
| S6 第二领域干跑 | 用心理咨询包走 Q8 清单，不改共用层 | registry-guard 零改动通过；清单九项逐项打勾 | 2–3 周 |

**现有劳动纠纷部分应优化的具体点**（现在→改成→怎么验）：

1. 判例卡来源：`knowledge/packs/cases/*` 首条 source 46 张 wikisource、22 张 sohu → 登记簿封顶「二手转述」，能换官方页的换（rsj.beijing.gov.cn 典型案例、court.gov.cn 案例库页）→ 脚本统计官方域名占比与 confidence 分布前后对比。
2. `scripts/eval/README.md`、`agent/citation-block.ts` 注释「六条无 statute_quotes」 → 已有 `lhtf-jiechu-buchang-core.md`，删陈旧记载并跑 S03/S15 三轮 → 「光秃条号」项 N/A 占比归零、PASS 记录落盘。
3. 条号无运行时闸 → S2 StatuteGuard → 变异矩阵 + 评测。
4. `retrievedIds` 不含 `searcher.get()` 直取卡 → 合并三来源 → 评测 README 删该陷阱条目，断言直接用合并集。
5. `timeline_add` 不走 `withClientRef` → 迁入统一入口（保留旧列兼容）→ 并发双写测试。
6. `daysUntil` UTC 与 `format.ts:62` 双算法 → 统一 CST 口径单一函数 → 00:00–08:00 CST 边界用例。
7. 举证责任两条规则（司法解释几类决定 vs 仲裁办案规则证据偏在）在 SOP/话术卡可能混称 → 分建两张 statute 卡，条号核实前 `burden` 只填「待核实」→ grep 全库「举证责任倒置」出现处逐一挂卡。
8. `crisis.ts` 纯字面词表 → 保留为判定真源，加影子语义探测只记日志 → 周审分歧样本，命中率提升才进词表。
9. 51 张「官方案例，未公开案号」判例卡 → `authority` 字段 + `full_text_available=false` → 四步法第一步自动判「内部参考」，评测断言这些卡不出现在文书正文。
10. `task-class.ts` 无「解释法条」触发 → 加入需引用类 → 路由离线断言。

## 待核实
- 「六条无 statute_quotes」是否真已解决：只看到卡文件含 §46/47/87 条目，未跑评测确认引用块拼出。
- 68 张转载源判例卡中多少张同时列有官方备份源（只统计了首条 source）。
- 《生成式 AI 暂行办法》§17 与《标识办法》对一对一咨询的适用，沿 R1 待核实。
- 举证责任两条规则的确切条号，沿 R2 待核实。
