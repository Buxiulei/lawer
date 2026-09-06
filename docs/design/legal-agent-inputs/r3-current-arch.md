# R3 土八鼠现状架构与短板（只读调研）

## ① 运行链（每环：输入→输出｜谁在守卫）

| 环节 | 文件 | 输入→输出 | 守卫 |
|---|---|---|---|
| 入口 | chat route/api/mcp/route.ts/lib/mcp/*/rest-runner.ts/skill/[filename]/route.ts | 用户消息或工具调用→统一进`runTurn`或`invokeCapability` | `requireIdentity`+`hasScope` |
| 身份权限 | auth/identity.ts、auth/guard.ts、capabilities/invoke.ts | identity→pass/403 | `checkPreconditions`(realname/balance)，MCP/REST同一入口，不许各写一份 |
| 计费闸①入场 | lib/billing(canStartTurn/beginTurn) | 开流前判定→402/409或放行 | in-flight.ts防并发重复扣费、entitlements.ts套餐余额 |
| 事实卡 | agent/case-facts.ts+snapshot.ts+cases/report.ts | CaseSnapshot→system prompt事实区(硬上限4600字) | P0永不降级、缺失写"未记录"不许默认值、姓名两道闸(实名+解密成功) |
| 知识注入 | lib/knowledge/index.ts+retrieval.ts+citation-block.ts | 用户原话→packs[]+法条原文 | 空手感知(countSubstantiveHits)、S3b核心条定向补注、CitationGuard案号白名单 |
| 危机闸 | agent/crisis.ts | message→触发判定+资源卡+确定性首段(不经模型) | 24h去重窗口、杠杆句闸(applyLeverageGate)、D15付费禁令、双票不过用CRISIS_SAFE_FALLBACK兜底 |
| 模型路由 | llm/routing.config.ts+router.ts | taskClass×plan→Provider | REQUIRED_ENV可用性判据、DEGRADE_CHAIN只向后降级不向前升档、served_model按实付计价 |
| 工具调用 | agent/tools.ts(11个AGENT_TOOLS)+capabilities/registry.ts(MCP/REST/站内三入口共用注册表) | 模型tool_call→执行+结果回灌 | MAX_TOOL_ROUNDS=8、idempotent.ts幂等、领域字面量守卫(registry-guard.test) |
| 落档 | lib/cases/*+db/agent+report.ts(case_reports个案报告) | 工具结果→timeline/claims/actions/deadlines/evidence+报告过期标记 | `bestEffort()`唯一记录性写入口、markReportStale唯一入口 |
| 计费闸②结算 | orchestrator.ts chargeTurn() | usage→token流水+公道值结算 | 四桶皆null不许当0记账、(type,ref_id)唯一索引防重放 |

## ② 历史事故与现修法（≥12条，源BOARD.md/docs）

1. **GPT读档潦草**（2026-09-04）：档案=五张扁平表无叙事层，首诊四项全NULL、事件重复写入两次、行动卡各写两遍→立项case_reports个案报告+过期机制(已落地report.ts/report-stale.ts)。
2. **首诊从未落库**F-01：IntakeFlow终点写死跳demo案件，整段提交零写请求→intake-persist单据实写六步+失败禁弹"已建好"。
3. **SSE收尾500**F-02/F-10：`controller.enqueue`在用户离开后抛错，掀翻整个tool-loop→action_card/finalizeMessage永不执行→改造`bestEffort`唯一入口+sinkBroken隔离下发与记账。
4. **失败轮纯前端**F-203：刷新即消失无痕迹→messages.failed_code落库+`store.failMessage`唯一入口+可重试。
5. **首诊封顶线用mock常数**F-04：35283 vs 官方47103.25差33%→零容错数字改核官方原件。
6. **危机轮悬空**：`stripDuplicateHotlineList`见号码≥2行即全删，把"先给号码+结尾照读"两处都剥空→manager裁临时关闭去重，等"保留第一处"修法。
7. **G4光秃条号**：库里无逐字原文时判FAIL会激励模型编造原文→改判N/A，补卡才是解。
8. **承诺短语表四轮翻车**：语义泛化每次都误伤新的如实句("已记到档案里了吗")→退回纯字面表，三要素(施事+完成态+对象)缺一不收。
9. **杠杆闸判据分裂**：产线传模型段、评测传全文，两边判不同字符串→`LeverageSubject`品牌类型收口，底层函数不再导出。
10. **危机卡重复/悬空并存的窗口设计**：案件级封死→三月后再危机时模型无号码可给→改24h冷却窗口两头兼顾。
11. **时区错位**：daysUntil用UTC当"今天"，00:00-08:00 CST运行多算1天；驾驶舱UI与提醒邮件各用一套算法(format.ts:62另一个daysUntil)→统一时区口径排队修。
12. **中转型号偷换**：请求opus不等于拿到opus，served_model与请求不符→`reconcileServedModel`按实际较低价计价+notice留痕。
13. **姓名占位符编造**：文书写"【你的姓名】(已使用档案中的真实姓名)"，空占位包装成已完成→case-facts.ts identitySection两道闸+禁止占位符明文写死。
14. **rollout无限期等待未设超时**：build失败但服务未重启的半新半旧态，用户等一夜无人知→静默留场比失败更伤，长等待必须绑Monitor+超时上报。
15. **判据同源断裂**：产线与评测各写一份检测函数，覆盖率满但评测批次实际零覆盖（citation-block.ts分支17次单测覆盖、评测夹具从未填过）→分母必须并列声明。

## ③ 评测现状：好答案如何被判定，盲区在哪

`scripts/eval-agent.ts`执行C04十五剧本（`scenarios.ts`），机械断言(`assertions.ts`纯函数)+语义断言两票制(`judge.ts`，deepseek-v4-pro当判官，两票不一致→SPLIT交人工)。红线剧本(S08自伤/S15)任一FAIL即整场FAIL不加权。**判据交付前必答清单**四问（manager 2026-08-25）：改坏靠什么发现/验证是否随修法落盘/接的是产线判据还是抄了正则/变异矩阵覆盖每个要件的隔离负样本。三面防线：文本落地/单条变异/全量变异，各有盲区（②只看被点名判据、③见系统性偏差——人写负样本本能"整体不合格"而非"只差一条"）。**盲区**：①judge本身是LLM，边界项("接住情绪"算不算)靠两票制而非确定性；②检索集(`retrievedIds`)不含`searcher.get()`直取的卡，用它推断"模型没依据"会反；③覆盖率非0不代表判对，只代表跑过；④N/A非PASS但占比>50%才告警，中间地带无人看。

## ④ 8个结构性短板（非bug，指到文件）

1. **无叙事层/知识图谱**：档案是六张扁平表现拼(case-facts.ts)，公司名"时间线提过≠档案已知"(companySection)，与"核心客户窗口=风闻裁员→HR约谈"的连续叙事需求错位。
2. **写入无普遍幂等**：GPT事件事故里同一事件写两次、三张行动卡各两遍；`idempotent.ts`仅覆盖注册的写能力，timeline_add等仍靠agent自律不重复。
3. **判据与产线双份实现的结构性风险**：crisis.ts已用`LeverageSubject`品牌类型收口一处，但`countSubstantiveHits`(knowledge/index.ts)、`classifyTask`(task-class.ts)等仍是"信任调用方传对参数"，无类型层强制。
4. **知识库召回与法条覆盖有已知缺口**：README记"劳动合同法46/47/87/40/41/39六条全库无statute_quotes"，S3b定向注入只能补"映射表已声明"的场景，未声明的场景仍靠检索排序碰运气。
5. **危机识别是关键词表，非语义理解**：crisis.ts CRISIS_TERMS/NEGATION_MARKERS纯字面表，四字否定窗口，绕着说的新变体(非CRISIS_TERMS收录词)天然漏判，且注释明言"刻意排除"的词随时可能是误伤或漏判的下一个坑。
6. **模型路由的法律质量分层是价格驱动而非任务驱动**：routing.config.ts三档entry/standard/pro只按套餐价切换模型，critical/standard/bulk三档taskClass由`classifyTask`(task-class.ts)一次性分类，法律判断的实际难度(如首次仲裁材料 vs 简单追问)未必与套餐价格对齐。
7. **个案报告(case_reports)刚立项、尚未全链路验证**：report.ts/report-stale.ts已实现惰性生成+过期标记，但MCP的case_report_get/update、intake_submit幂等写入(BOARD 2026-09-04排期)仍在"排队"，是否解决①②尚待真机验证。
8. **评测的红线覆盖面窄于危机形态空间**：S08/S15两个红线剧本+CRISIS_TERMS词表是唯二的"确定性防线"，而心理咨询纠纷/婚姻家庭等新领域扩展后，危机表述的语言形态会大幅变化，现有词表与判据均未覆盖新领域语料。

## 待核实
- BOARD.md/A系教训册体量巨大(937行+2637行)，本次为关键词定向抽取，未逐行通读，可能遗漏未命中关键词的事故条目。
- case_reports/intake_submit的"排期"项(BOARD 2026-09-04)当前实现进度未做代码级验证，只确认表结构与report.ts函数已存在。
