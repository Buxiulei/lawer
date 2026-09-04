# 任务板（只读看板：manager 根据各窗口汇报统一维护，其他分支不要改本文件）

> 汇报三件套：状态（开发中/自测中/待审）+ 量级预估（一小时内/今天内/明天）+ 需配合事项
> 契约变更（表结构/API/目录/费率）必须先问 manager；**涉 `migrate.ts` 的派单，manager 同时知会数据表管理**（事务化落地前该文件禁非幂等语句；**守卫=测试套件级，`npm test` 时开火——本仓当前无 CI，提交级拦截待 CI 落地**〔08-28 数据表管理证伪"CI 拦"口径〕；守卫类断言核验必须在**合并态**跑，分支可能不含守卫文件）
> ⚙️ **并发隔离铁律（2026-08-31 三起串台事故后立，详见 memory/parallel-agent-isolation）**：每单独占 worktree；复审/变异核用 `git archive <SHA>` 出的一次性副本（不进 stash/ref）；**禁 git stash**（栈跨 worktree 串台，取"改动前"对照改另起 worktree 指基线 commit）；scratchpad 用自命名子目录；变异锚点 `count==1` 校验（防打到同名另一处）；同单不重复派（派前查在飞清单）；复审读数以只读 worktree 原地为准；**仪器没跑起来≠全绿**——没数到 Tests 计数行当场抛仪器错，不许"零 × 冒充全绿"。

| WS | 窗口 | 任务 | 分支 | 状态 | 预估 | 需配合 |
|----|------|------|------|------|------|--------|
| WS1 | 数据表管理 | schema+migrate+公道值账本移植+对账脚本 | ws/billing | 表结构已合并(PR#2)；billing移植中 | 明天内 | - |
| WS2 | 后台技术 | app骨架+auth(OTP/邮箱)+sidecar(TSA/PAdES/OCR/ASR)+llm路由+MCP/API | ws/backend | 开发中（scaffold+crypto已并入main；sidecar/auth/llm在途） | 今天内 | MCP依赖WS1表结构；Claude key待用户 |
| WS3 | 前端页面 | 对话工作台+档案面板+证据页+移动端(先mock后接) | ws/frontend | 开发中（设计已定，首批页面在途） | 今天内 | 待rebase到main骨架 |
| WS4 | 执行者 | research→knowledge packs 编译+文书模板库 | ws/knowledge | 开发中（规范v1.0已批，批量编译A07+A03中） | 今天内 | 待核实项走WS5 |
| WS5 | 调研员 | WS5-2 结项（C01定价/C02公司调查SOP）→ C03 求助资源核实 | 本地research/ | 进行中 | 今天内 | - |
| - | 援助律师 | 用户本人案件陪跑（不写代码） | - | 已委任，待用户问诊 | - | 需求转发manager |

## ⏰ 有到期日的东西（不依赖任何会话记忆，接手必看）

| 到期/触发 | 事项 | 后果 | 谁办 |
|---|---|---|---|
| **每次会话重启**（不是某个日期） | **哨兵巡逻的 cron 是 session-only，随会话死亡而消失**（`*/15 * * * *`）。**本表刻意不记它的 id**——截至 08-26 它已换过三次（`62d20e17`→`2e8107be`→`18f88b69`），**记在这里的 id 会在下次重启时静默失效，而失效时不会有任何信号**。当前 id 以哨兵心跳为准 | **到期不报错、不告警，只是巡逻从此不再发生**——而"没有巡逻"与"巡逻了但一切正常"在我们这边长得完全一样 | 机制级兜底＝外勤的存活探针；cron 只是临时 |
| 上线后首次真实触发 | USER_ALERT 取证（MAIL-OK 行 + ALERT 全文 + 触发时长） | 未验收前不算交付 | 外勤报 manager |
| 每周 | A 系教训册"仍为纯文字"条数（已标/纯文字分①待造②造不出/未标 三个数） | 只报总数会被"把待造改判成造不出"作弊 | WS2 |
| **2026-08-30 09:30 后当日内** | 受控首发验收，存证**三样**：①job_runs 新行 items_examined=1/items_ok=1/failed=0、note「1 条到档，成功 1」；②`deadlines.id=1` 的 notified_stages_json 由 NULL 变 `["30","7","3","1"]`；③hubaiyipku@163.com 收到主题「您有一项重要事项还剩 **1 天**」的信（今晚 dry-run 打的是「2 天/3档」——求值日不同，**两者都对，别拿今晚输出对明天的信判不符**）。⚠️ **notify_log 该链路根本不写，明天仍为 0 行不是漏发信号**（staging 子代理 08-29 实证）；deadlines.created_at 存 UTC，读表别误判。验收后将 `deadlines.id=1` 置 resolved_at **不 DELETE**。**无新行=cron 没跑；有新行 items=0=staging 不在档** | 验收通过前，「提醒已经在保护你了」这句话禁止对用户说（后台技术留下的原话条件）；用户否决窗口至 09:30，否决即 `DELETE FROM deadlines WHERE id=1`（该行现无衍生数据） | manager 派子代理核对 |

> ⚠️ **这一行我（manager）写错过，留着当反例**：原文写的是「**2026-08-28** 到期」。
> 错在把 `CronCreate` 的 **7 天上限**当成了保证到期日——它的真实语义是「**活着的话**最多活 7 天」，
> 而 session-only 的 job **随会话进程消失**。旧 job `62d20e17` 08-25 夜里随全线重启就死了，
> 根本没活到 08-28。我据此排了「两天窗口」，等于**给一件已经发生的事留了两天余量**。
> 实证：哨兵心跳 08-26 01:18 之后 8h32m 零更新，该跑 34 次巡逻，一次没跑。
> **教训**：这条结论只靠会话叙述传给我，我没自己跑一遍 `CronList` 就写进了到期表——
> 正撞上前一天刚立的 A93「一个结论若只能靠信任传递，正确的修法不是加强信任，是让对方能自己跑一遍」。

## 🏗️ 班底改制（2026-08-29 20:50，manager 裁定；宿主机重启灭窗后经用户授权重组）

- tmux 八岗常驻窗口（哨兵/后台技术/评测官/前端页面/数据表管理/外勤/援助律师/调研员）随重启全部消亡，**不再重建**。改为主会话动态派发：执行=Opus 子代理、调研=Sonnet 子代理、一次性核对巡检=Haiku 子代理；滚版窗核验、评测跑批=每窗/每批**新开独立实例**（独立性由"新实例不携带积累共识"提供，比常驻岗更强）。等待条件一律 Monitor/系统级 cron，不派长轮询。
- 裁定理由：①常驻窗口上下文不抗重启（本次实证——后台技术带着当晚任务死在半路），真正持久的是文档与产物；②跨会话通讯的 socket 漂移/idle 刷屏/心跳纪律整套成本，都是在对冲"常驻窗口会失联"，子代理结果直达、无失联失效模式，整套成本归零；③各岗协议已固化在本板/TEAM-PROTOCOL-v2/退出判据册/评测官跑批协议，新实例照读即上岗。
- 心跳探针清单收缩为 manager 一岗（`.real-write-verified` 已留痕）；名册对账 xcheck 长期 UNAVAILABLE 为已知常驻项；上方 ⏰ 表「哨兵巡逻 session-only cron」行随岗位裁撤失效（留作反例不删）。
- 重启造成的断点：后台技术**未落**受控首发测试期限（prod `deadlines` 表 0 行，`job_runs` 仍只有 08-29 09:55 手动行 items=0）。今晚由 Opus 子代理补位，验收条目见 ⏰ 表 08-30 行。
- 补位路由裁决（08-29 21:00）：内部例外信箱=真实用户(id=2)本人账号邮箱且 `users.email` UNIQUE ⇒「不碰 id=2、又投该信箱」不存在。子代理按简报停手上报（对），manager 修订禁令为「id=2 既有行仍禁改，仅允许一条可逆 INSERT（deadlines 挂 case 2，1 天档只发 1 封）」。禁令的立法本意是不损坏真实数据，新增可逆行不违本意。
- 补位中带出两条：①`daysUntil` 用 UTC 日期当"今天"，00:00–08:00 CST 运行会把 daysLeft 多算 1 天——现 cron 09:30 无害，**已立项排队修**（改用本地日期或统一时区口径）；②dry-run 不打印收件人，"将发 N 封"证明不了"发给谁"——收件人分辨力靠只读 planReminders 探针补，此组合 manager 认可为受控测试的足够验证。

## 🧱 1000 并发承载力审计（2026-08-30 凌晨，5 子代理工作流：3 勘查+1 受控实测+1 对抗核验；真库零写入，压测副本已清）

**结论：今天无容量问题（历史峰值≈个位数用户，余量百倍）；真到 1000 并发，第一批倒下的不是 SQLite。** 全量报告见会话工作流 wf_061a7d64-f58。

**1000 档第一道墙排序（核验官定级后）**：①进程内存——1000 路 SSE 常驻 + 上传路径 4~6 份内存拷贝放大（**2 个并发 100MB 上传即可 OOM 杀进程**，Caddy 站点级 max_size=100MB 全路由生效）〔推导，缺实测〕；②LLM 上游零并发闸/零重试/零熔断〔实测代码〕；③accept backlog 511 + 单进程只用得到 4 核中 1 核（直连 ~1150-1380 rps、全栈 ~818 rps 实测）；④OTP IP 配额 30/IP/24h 进程内 Map——**同一企业/校园出口第 31 人注册即拒，撑不到 100 人**〔实测常量〕；⑤`gongdao_ledger` 无 user_id 索引，「我的」页每访问全表扫描——**唯一会自己走到崩的**（1000 活跃下 1~12 天吃满事件循环，区间宽因用户行为参数未测）。**实测排除**：SQLite 写吞吐（需求 83~167 commits/s vs 实测 20,292 ops/s，余量百倍）、纯读路径、三个定时任务锁形态、OCR/ASR（未接线零负载）。

**廉价加固队列（合计 ≈3-4 人日 + 几处配置，无需换架构；待用户点头后派单）**：ledger user_id 索引+SUM 改读物化余额（半人日）；sidecar-client 四个 fetch 加 30s 超时（4 行）；Caddy 上传体积改路由级 20MB/其余 1MB + 上传并发闸（1h+10行）；`NODE_OPTIONS=--max-old-space-size=768`+`MemorySwapMax=0`（2 行配置）；listen backlog 显式 4096（1 行）；LLM 层 p-limit+退避（~50 行）；OTP IP 配额阈值+豁免分支（0.5 人日）；多实例+Caddy 轮询（1 人日，**前置=先把 IP 配额 Map 挪出进程**）——多实例一项等有真流量再做。

**用户批准（2026-08-30 00:40）**：「把该做的都做了，不要留技术债，为未来千人级规模做准备；多开动态工作流并行完成」——加固队列全量放行（含多实例前置=IP 配额入库）。施工双工作流已开：wf_197e738f（7 工单并行，各自 worktree 分支 ws/cap-*，基线=origin/main 619dee2，每单配独立对抗审查）+ wf_285165ab（三项补测：SSE 内存/单轮事件循环/上游限额）。**09:30 受控首发前不动生产**；上产合并+systemd/Caddy 配置（NODE_OPTIONS/MemorySwapMax/路由级 max_size/backlog 预载）统一走首发验收后的滚版窗。上传路径的真修（流式+卸载 sidecar，3-5 人日）经裁量不属于债：25MB 限流+并发闸后内存放大有界，真修待有真流量再议——此判断已记录，翻案条件=大文件成为高频真实用例。
**C8 修正（我核了 prod 56304d4 实码）**：驾驶舱 `demoCase` 是 `caseId === demoCase.id` 的演示案件专用分支，真实案件走真数据——核验官把条件分支读成整页 mock，批6 记录无误；「读路径实测是半成品」的折价撤销。
**重启失联债追回**：openCliDb（CLI 开库统一，104 测试）没丢——从后台技术遗留 clone 抢救为本仓 `rescue/openclidb`（8272591），随滚版窗合并。
**💰 单轮成本结构三连（2026-08-30 00:35，SSE 探针标定轮捞出，实测 usage 帧为证）——立项 P0-cost，待专门设计后派单，不并入今晚加固**：一次短对话实测 **113 公道值**（prompt 36,428 tok），注册赠送的 1000 公道值 **9 轮聊完**。三个成因都是产线常态：①每轮无条件注入 6 张知识卡且无相关性下限——本轮 notice 自述「6 张无一实质命中」，用户为完全不沾边的法条卡付了 87% 的 prompt 钱；②收口检查触发补救轮=同轮跑两次模型；③system prompt 第二段插当前时间**到秒**，跨轮前缀缓存全灭（cached_read 仅轮内复用）。修法方向（须过评测官闸，检索注入动的是答案质量）：注入加相关性下限或降 MAX_INJECTED_PACKS、时间戳降到分钟级并挪缓存友好位、补救轮经济学重审。**测试预算量程教训**：我按「3~5 公道值/轮」定闸，实测 113——差 20~30 倍，[[先审量具再信读数]] 又一例；探针已按可逆记账（grant→消耗→close 冲销，memtest ref 全程可审计）放行梯度实测，现金硬顶 ¥11。

**🔨 加固首轮战报（2026-08-30 01:00，wf_197e738f 完毕：7 建 7 审零崩）**：PASS 4（ledger-index / sidecar-timeout / otp-ip-quota / reminder-tz，审查官均以不同角度变异独立验牙）；FAIL 3 已开返工流 wf_bac8f6cf（各配新审查官）：①upload-guard——**站点默认 2MB 会掐死护照实名通道**（两张必填照片必超 2MB，境外证件者整条链路归零；审查官一条 find 定位了执行者声称找不到的路由）→ 匹配器扩为上传路径集合+护照路由接同一信号量；Caddy 真源之争 manager 裁定：生产读 /etc/caddy/conf.d/lawer.caddy（基建勘查实证），repo 件是模板；②llm-gate——闸位泄漏（断流 32 次该 provider 全局死锁，比要治的 429 更糟）→ release 挂 timers.signal abort；anthropic 路零覆盖（revert 存活）→ 补咬；③listen-backlog——deploy 测试类型错打红 CI tsc（执行者只跑 npm test 没跑 tsc，"vitest 绿≠CI 绿"又抬一层）→ 一行修。
**PASS 单带出的立项**：①〔P1，排 daily-key 之上〕驾驶舱 UI 的 format.ts:62 另有一个算法不同的 daysUntil——**期限当天早 7 点 UI 写「还剩 1 天」、邮件写「今天到期」**，方向是让人误以为还有余量；②〔P2〕otp 豁免分支未鉴权可达=已注册号码可绕 IP 计账刷真实计费短信（每号仍受 10/日顶）且豁免发码在 ip_quota_events 零留痕——合并轮补「豁免仍记账+未验证号不豁免」两条；③daily-key UTC 错位（多发被抑制方向，非漏发，勿按权利灭失定级——审查官实跑纠正了执行者的夸大）；④滚版窗清单追加：TZ 兜底核对（app.env 已有 TZ 键）、ledger 索引**尽早上产**（CREATE INDEX 锁窗随存量增长）、NODE_OPTIONS 落 systemd 时先 systemctl show 防整体覆盖既有 Environment。
**📐 SSE 内存实测（⚠️ 01:00 判定作废重测——本段前半为历史记录勿引用）**：原报 **0.54MB/并发连接**、内存降级非第一墙；随后同一探针以单调高水位反推出 **1.8-6.5MB/连接**（该值成立则墙在 217-660 路、1000 档进不去），再随后探针自己找到混淆项（其 floor 测试与懒释放同抬 VmHWM）**自撤 4.3**。终态：0.54 的原始采样已被收官清理删除、4.3 归因不成立——**两值同级作废，MB/连接现为空缺**，决策边界（≈1MB/连接）恰在争议区间内。复测已移交全新实例（协议：证据强制落盘双份留存、N=15 双算法互证、批间静默窗+RSS 回落等待、判决规则三段、现金顶 ¥9）。旧探针收工时拆除两枚自己遗留的延时探针（本地+远端各一，会污染复测静默窗）、承认「第三方动过 harness」指控系把被压缩掉的自身活动史误读为他人足迹并撤回——[[subagent-numbers-need-artifacts]] 与「读的是原件还是印象」双重实例。其站得住的遗产：连接层地板（105KB/连，基线平坦段）、懒释放、heap 2096>cgroup 1280 无预警 SIGKILL、backlog 511、113/轮成本三连、心跳只活到首字证据帧。原文其余仍有效：尾部风险留案：长 tool 循环连接 1.5-2MB/条，若 1000 路中占比高会击穿 MemoryMax——与 P0-cost 的 MAX_TOOL_ROUNDS 经济学同根。空载连接地板 7.6-207KB/条随规模递减，1000 路 established 无墙。12 并发零 429。**墙重排定稿：上游延迟>内存**——首字延迟中位 3.5s/尾部 12.3s（服务端 TTFB 仅 0.02-0.09s，全在上游）。
**🚨 新 P1〔心跳只活到首字〕**：startHeartbeat 见首个 delta 即停（heartbeat.observe），此后长 tool 循环是彻底静默的连接——实测一路 88.6 秒零帧（连心跳都无）后 notice+usage+done 一次性到达，客户端全程 200「看起来正常」。前端/反代会判死。修法方向：心跳贯穿 tool 轮（进 tool 轮重启、done 才停）。完整证据帧序列在探针报告（s9, message_id=60）。
**⚖️ 信任链事件记档**：探针中途有一封信报了「105KB/连接、50/200/500 地板、ss 原文」等成套数字，收官对账时探针声明**这封信里的测量它从未做过、也不记得发过**（其上下文疑似中途被压缩）；终测实数：地板 207/60.7/7.6KB（105 作废）、懒释放现象属实但数字终测才有、ss 511 值恰为默认值故当时的"吻合"不构成佐证、heap 2096MB 两次一致维持实测级。**教训：子代理信里的「已测数字」可能无实物支撑——凡要转述给用户的数，必须要求命令+原始输出落盘存证或独立复测，消息正文本身不算证据。**计费完整性同场核清：25 轮 25 行双向零孤儿（"25vs20"是探针自己查询条件写错）；实际花费修正为 ¥7.00。量具三课：本机内核 6.8 的 memory.peak 不可复位不可用、稳态读数系统性低估（只看峰值）、负载到来瞬间 GC 会先吐 30MB 吞掉差分信号。
**🔌 上游限额调研收官（2026-08-30 00:33，零费用：models 列表+1-token 探测）——两个重磅**：①**Anthropic 与 OpenAI 在生产出口 100% 不可达**（Anthropic=Cloudflare 边缘 403 对整个出口 IP，换 key 换 UA 恒同；OpenAI=TCP 黑洞连 TLS 都握不上；已排除本机代理因素，与生产 Node 网络路径一致）——路由表里 claude-sonnet-5/opus-5 档若被真实触发即得 403。**当前只售入门档（DeepSeek/Qwen）故零用户受害**；结论：P1-4 向量引擎中转从「可选优化」升为「claude 档唯一通路」，且路由表需加守卫防止把流量派给已知不可达的直连目标。②**计费键漂移实锤**：降级链产出 `qwen3.7-max:nothink`，model_rates 无此行——走到该分支计费查表落空。立 P1 单，修法按[[修入口不修五处]]：结构守卫「routing.config 可产生的每个 billingKey 必须在 model_rates 有行」，而非补一行了事。可用限额：DeepSeek=账号级并发闸（pro 500/flash 2500，429 无预警头，文档实测互证）；DashScope 软限流但**实际调用型号 qwen3.6/3.7 未在公开限流表**（同代型号差可达 500 倍，需百炼控制台核对=需用户）。成本锚修正：标准对话轮实锚已存在（SSE 测试 25 轮 companion，均 83.5 公道值/轮，区间 35-141），取代此前唯一的 intake 重锚（n=5、78K token/轮）。
**⏱️ 事件循环占用收官（真库 sha256 前后一致零触碰）**：单轮吐字前同步 SQL 实为 **21 条合计 0.65ms**（报告2 数漏了 3 条），对表增长完全不敏感——**从墙名单除名**；账本页 @100万行无索引 **59.7ms/请求**（=92 倍于整轮 chat SQL），加 `(user_id,id DESC)` 索引后 0.61ms（**97×，实测背书 ws/cap-ledger-index 单**，建索引 100 万行耗时 2.2s）；WAL autocheckpoint 每 ~80 轮一次 ~10ms 恒定尾部不随库长大；顺带记录不动手：prepare 重复解析占 SQL 时间 45%（全仓仅 modelRates 有语句缓存）、listActionItems 的 ORDER BY 不被索引覆盖（按单案件行动卡数增长）。其测量自纠一例入账：cp 大文件的脏页让 checkpoint 替它买单、测出假 1241ms——sync 后重测 6.6-12.7ms，「先审量具」再添一例。
**🔧 返工轮判决（2026-08-30 01:05）**：llm-gate **过**（闸位泄漏修=abort 兜底归还，双复审官分别以删监听/提前释放/整文件 revert 三角度验牙全红；anthropic 四用例补齐后首轮存活变异 M1 转红）；listen-backlog **过**（tsc 反向确认+复审官自选 10 变异 10 杀，内核臂与拦截臂独立性被 M3 同红证明；执行者一处自报越界——给自己的注释补牙——复审官依[[验证必须有牙]]裁「必须保留」）；upload-guard 实质项全过（护照接闸三变异全灭、caddy 活体 413/200 对照），**唯余一项**：Caddy 上传路由清单无守卫层（预设变异「删掉 passport 路径」无人能抓）→ 末轮 wf_f0d7b96d 在跑（唯一真源清单+双向文本守卫）。
**⚠️ 纠一句复审官的夸大**（[[夸大风险也是错]]）：其「护照通道在线上此刻仍被掐死」不成立——生产现行 /etc/caddy/conf.d/lawer.caddy 是站点级 100MB（基建勘查原文），2MB 默认档只存在于 repo 模板、尚未部署，**线上护照今天是通的**；正确表述=滚版窗必须携带修正后的匹配器一起上，先上 2MB 后上匹配器的顺序会真掐死它——顺序写进滚版窗清单。
**运维教训一条**：并行复审时两名审查官在同一 worktree 相互踩踏（一方实时变异中另一方读到脏态、detached 副本被误删）——今后复审一律用一次性 detached 副本，工单 worktree 归执行者独占。
**🧾 复测前置核查三发现（2026-08-30 01:12，复测探针停在花钱之前，¥0）**：①**演示账户余额缓存漂移**：balance=-1621 vs SUM(ledger)=365，缺口 -1986=上轮 24 条消耗——成因强推定为上轮 grant/close 用了**绕过 lib/billing 的直写 SQL**（只动账本没动余额缓存；证据=adminAdjustGongdao 恒写 ref_id=NULL 而那两行带 memtest ref）。我下的「可逆记账」被实现成绕过入口的直写——**又一例修入口不修五处**；已裁：批准按账本重算缓存修复（证据已双份落盘），并立结构性规矩「**公道值一切调整必须走 lib/billing 入口，禁直写 SQL**」；账户页那条「余额 vs 账本合计」不一致告警在此事上会真开火——完整性功能被实战验证。污染范围收敛：仅 id=1，真实用户 0 行。②**发版前手工快照是失效安全网**：pre-rollout-* 是 cp 主库不带 -wal，实测落后 29 小时丢 27 条已提交流水（定时 backup.sh 走 .backup 无恙）——滚版窗清单：**发版快照改用 sqlite3 .backup 并落成脚本**，终结不成文惯例。③**算法②被空载对照臂正式证伪**：零连接机器上 (VmHWM−VmRSS)/15=4.26MB「每连接」——量的是进程预热峰值差不是连接，1.8-6.5 区间就此定性为无效读数；且 VmHWM 可用 clear_refs=5 复位（一次性进程实证），复测协议已修（每批前复位+空载对照固化为第一步）。0.54 维持「未证伪但失据」，等修完余额后 N=15 真跑裁决。
**🚂 合并列车到站（01:25，manager 实跑复核毕）**：`ws/cap-integration` = **6413dc5**，八支零冲突（migrate.ts 热点 git 三方自动解开，最终 exec 块计数 38 与守卫相符、表数 38→39 是另一个数别混；deadline-reminder.ts 双边共存）；openclidb 整支合入（列车员核实其真父是 56304d4 非基线、增量恰为 8 个 openCliDb 文件零夹带，免 cherry-pick）；三件套：**2200 passed（2112+88 精确对账，八支增量逐支实测）** / tsc 0 / deploy 14——manager 亲跑复核一致。列车员自抓一例 zsh 未引用变量不分词陷阱（39 文件全报「一致」的不可能结果暴露量具坏了）——[[shell 自匹配陷阱]]家族再添实例。flag2 全文已到且无害（主仓 HEAD 移动=manager 本人的台账 docs 提交，已向列车员销案；38=exec 块数 / 39=表数 两个守卫各自独立通过，语义区分注释入小债队列）。**发版态就绪，仅等：①9:30 首发验收 ②内存复测终值 → 滚版窗**。origin 上无任何 cap-*/rescue 分支外泄，origin/main 仍 619dee2。
**✅ 加固七单全绿（2026-08-30 01:20）**：upload-guard 末轮 PASS——上传路由清单收唯一真源 upload-routes.ts + 双向文本守卫（Caddyfile 漏→红、清单漏→红、三处拼同错→route.ts 存在性断言逮住、匹配器改名→解析自检独立判红防伪装），复审官四个新角度变异全部按预期红；错误消息三段式含「caddy adapt/validate 对此瞎，指望不上」与上产真源提醒。**合并列车已发**（ws/cap-integration，七支+openclidb 抢救提交，migrate.ts 计数冲突热点已预告）。小债入队：①守卫测试第 42 行模块顶层 readFileSync 使夹具自检成死断言（响亮红但消息未兑现，一行修）；②ledger-index 测试 uid 硬编码；③migrate.ts 相邻两计数（38=exec 块 / 39=表数）需注释点名区分——列车员精细版：真正咬人的不是长得像而是**增减不同步**（新增建表块时两数同步+1 继续差一「看似一致更新」，只加索引或一块建两表时才脱钩），注释要写的是这个。
**📬 期限提醒首发验收通过（2026-08-30 09:30 cron 自然触发）**：job_runs id=2 `ok=1/items_examined=1/items_ok=1/failed=0/「1 条到档，成功 1」` + deadlines.id=1 notified_stages_json=`["30","7","3","1"]`（发送成功后才写的去重记录）——三样存证之二服务器侧实锤；第三样（信箱实物）待用户一瞥确认。测试期限已置 resolved（2026-08-30 15:05 UTC）留痕不删。**至此「提醒已经在保护你了」这句话解禁。** 内存复测代理凌晨已完成余额修复（365=365 双列对齐）并跑完两批（token_usage +40≈N15+N25）、close 走 adminAdjustGongdao 落账（ledger id=76 ref NULL 合规）——但终报未送达，已追。
**📱 移动端 UI 战线开辟（2026-08-30 11:00，用户实机反馈两发）**：①〔已定位派单 ws/cap-btn-overflow〕引导向导底栏「下一步」`w-full` 与「上一步」`min-w-24` 同处 flex 行→自第二步起横向溢出、按钮被屏幕右缘裁切文字偏心（实机截图证实；首步无上一步故隐蔽）；全仓同型扫描随单。②〔新 P0 派单 ws/cap-mycase-routing〕**真实用户点「我的」落进演示案件**——与旧 P0-1「刷新掉登录态」大概率同案（未登录访问 /case/* 疑似静默落 demo 而非跳登录；AppShell:38 自述「caseIdFrom 对非案件页也回 demo」）；诊断须拆开「掉登录态」与「路由错」两层各修，禁顺手做 P1-3 大改。③〔工作流 wf_39a0f0df〕**全页面 393×852 逐页逐态审查**：本地起集成态+种子数据，5 路并行目检（横向溢出机检/44px 触达实测/sticky 层级/文本截断/空错态文案），A 组带灵敏度校准题，汇总官产出 LEDGER.md 台账归并系统性同病。
**📋 移动端全页审查台账收官（wf_39a0f0df，7 代理，台账在会话 scratchpad/mobile-audit/LEDGER.md，滚版窗时归档入 docs/）**：灵敏度校准命中（A 组独立量出 90px 溢出+代数推导+360 复现）；原始 33 条归并 23（6 条系统性各波及 2-7 路由）。**新阻断级连锁两条（并入 ws/cap-btn-overflow 验收）**：溢出撑宽包含块致 PanicButton 整体在屏外 100% 不可点（首诊问卷阶段隐私阀是死的）+「文书」Tab 74% 屏外；复验判据=scrollWidth===innerWidth 且两件 right≤clientWidth，/case/*/ask 同验。**FIX-2 第三层病根（并入 ws/cap-mycase-routing）**：Dashboard.tsx:26 写死只认 demo，真实案件 API 200 有数据页面却渲染空态——只修登录+路由等于把「误进演示」换成「一片空白」，三层齐修。
**修复第二波已发（wf_9997bb2f，5 单+逐单复审）**：touch-targets（SYS-01 面包屑 42×24 七路由/SYS-03 「外层44px」注释是谎+checkbox 真热区 20×20/P-02/P-03）；discreet-guard（SYS-02 顶栏眼睛单击秒破长按防误触阀——抽共享方向不对称 hook）；error-boundary（SYS-05 公开 verify 页直吐服务器绝对路径+问它页吐 env 变量名——API 边界 toUserFacingError 一处两链）；dark-tokens（SYS-04 暗色 --primary 双语义 4.04:1/P-01 禁用态 2.35:1——拆 token 写对比度断言）；small-batch（D-07 英文404/C-08 面包屑换行/A-09 验证码重打错位静默丢位/P-05 拍照默认错归「沟通记录」数据正确性/P-06/P-08+P-10 JIT 排查）。
**审查递延队列**：SYS-06 固定层 bottom 常量互不感知（PanicButton/Toast/sticky 三处写死——等 btn-overflow 落地后基于其分支做 ResizeObserver→CSS 变量单真源）；P-04 落地页 fixed 容器虚高 36px 休眠项（修完溢出复测，仍在则 html overflow-x:clip 兜底）；P-09 期限瓦片角标"没压到可点元素是运气"；P-11 里程碑「跳过」态任何路由渲染不出（种子补一条靠后达成事件，否则 CSS 回归无人发现）；P-12 两处 44px 卡线零余量观察点。**正向确认存档**：B/C/D/E 四组零溢出（30 场景×2 视口含长 SHA/长中文名）、浅色对比零命中、Sheet 安全区正确、低调模式状态机行为与设计一致；量具排除项 7 条（dev 徽标/fullPage 拼接伪影等）已记防误报。
**🔨 修复二波判决（wf_9997bb2f 收官，10 代理）**：touch-targets **过**（条件=台账修正：SYS-01 实为 6/7 路由达标，/case/demo/ask ≤375px 仅 ~31px 可点，受 C-08 折行阻塞随其落地自然消——执行者报告那格 44 是假绿，复审官逐像素抓出；复审官另用「真实样式+逐字 markup 注入臂」把 Checkbox 全部 4 处调用方验完，无点击抢夺）；discreet-guard **过**（PanicButton 无行为差异被 14 组差分序列**测出来**而非看出来；合并前必修 1 行=HOLD_MS 判据自指，复审官把 600 改 1 后 19 条全绿——隐私阀承重数字裸奔）；error-boundary **过**（复审官 M1「顺手加点细节」式部分泄漏变异 5 例红，真泄漏源探针证明 stub 简化不失效；必录残留=同一公开端点 verdict.error/signatures[].error 仍吐 sidecar 裸 Python 异常含 /opt 绝对路径）；dark-tokens **窄口返**（主体扎实全数复算吻合；F1=焦点框 --primary 压 --surface-2 被推到 2.77 而它是输入控件唯一焦点指示——「一个 token 扛两语义必须拆」原样适用于执行者没拆的那对；F2=删 @theme 一行 31 绿而按钮烂成 1.46）；small-batch **窄口返**（五项过一项返：C-08 的省略号是死的——nav min-width:auto 挡住收缩链，4 条类串断言全绿而实况是溢出 12px 压住按钮，「类写在那儿」≠「它裁了东西」）。**收尾轮 wf_d47dbdb9 已发**（4 单：焦点框拆 token/面包屑 min-w-0+真判据/HOLD_MS 字面量锚/verdict 字段白名单投影）。
**Manager 三裁决**：①A-09 验证码：iOS 短信自动填充不许牺牲——box0 maxLength=6 整串分发，其余格 1（重打修复语义保留）；②C-08b 入队：/ask@360 修后末项仅 8px 系右侧控件占 252px，归 ShellHeader 控件布局另议；③SYS-02b 入队：AppSidebar/PreferencesCard 两处低调切换旁路（PC 长按是另一 UX 命题，设置页是有意进入）。**新债入队**：SYS-05b sidecar 五处投毒点（python 侧 :121/:126/:151/:232/:254 裸 {e} 入 error 字段）；P-06 源码正则对行为等价重构报假红（合并轮动那块要有数）。**量具规矩一条**：带 rotate 的元素量尺寸用 offsetWidth（P-10 实为 92×cos9°+sin9°=105 的旋转外接盒，非缺陷——复审官到小数点后两位对上）。
**🏁 收尾轮判决（wf_d47dbdb9，8 代理）**：dark-tokens **过**（焦点框拆 --focus-ring 暗色 5.14 达标浅色逐值不变；复审官自选「映射指错」变异被新编译判据咬住；跟进=用法守卫正则放宽 focus-visible 前缀）；discreet-guard **过**（HOLD_MS 常数锚+599 字面量边界，复审官 no-op 变异证新测试咬行为不咬形状）；error-boundary **过**（verdict.error+signatures[].error 双出口白名单投影各自独立转红；空断言销项被独立复现——泄漏的 enc_path 是相对路径，filesDir 断言永真删得对；转必修=两 type guard 的 X1/X2 判据）；small-batch **窄口 FAIL**（C-08 真修实证 8/28 出省略号、C-08b 间距转负；唯一存活变异=box0 分支新下边界 >1 无人钉——「分支变复杂的那一格，覆盖反而净减少」，改第一位会抹掉后五格的路径零判据）。**微修轮 wf_aae008b2 已发**（三粒断言/正则/判据+contrast-scan.mjs 收编 scripts/perf/，CI 接线待议）。等 btn-overflow 与 mycase-routing 两单报到后发第二列合并列车（注意 touch-targets 与 small-batch 同文件 breadcrumb.tsx 汇合、合并态需复验 /ask≤375 的 31px 是否随 C-08 落地自然消——台账 F-1 的依赖关系）。
**📏 SSE 内存终审（复测收官；执行代理挂起 24h 未投递，判决从其落盘证据直接收割——[[subagent-numbers-need-artifacts]] 的证据落盘协议首次实战兑现，代理已停）**：满并发切片口径（只取全部 N 路同时在飞的时段，规避「峰值是单路长 tool 循环顶出来的」归因错）：**N=15→1.029、N=25→0.668 MB/连接（cgroup）；斜率模型=0.127 MB/连接边际+13.5MB 固定项**。外推 1000 路：斜率模型 **226MB（High 的 22%，舒适）**；最悲观裸除 1199MB 贴 High。**裁定：进程内存按现有证据不是 1000 档第一墙，但两点定线跨 40 倍外推未验线性+从未制造过「1000 路持续在线」态——此结论带此折价使用**；40 路跨批净留存 +0.62MB=无累积泄漏。**排队信号再添实测**：15→25 并发首字延迟中位不动（11s）而长尾 30.6→122 秒（×4）零 429——**上游延迟墙的第二个数据点，墙序定稿：上游延迟/配额 > 内存**。复测账务净零（花 ¥6.2 ≤¥9 顶），双 key 吊销带 401 证明，全程未重启，UTC 疑点已按裁决自纠（09 号文件）。证据 26 件双份（/root/memtest2/ + scratchpad/memtest2/）。
**容量结论定稿（供滚版窗后写产品容量卡）**：现架构在加固批全部落地后，第一道墙=上游 LLM 延迟与配额（12 路并发即显影，长尾百秒级静默停滞），第二=进程内存（≥300 路才需关注，且 NODE_OPTIONS 保险丝已在批内），SQLite/连接层/读路径实测均非墙；**杠杆最大的单点修复=P0-cost 三连**（砍无关卡注入+补救轮+缓存友好时间戳——同时缩 token 账单、每连接内存、上游压力三个量）。
**两哑火单实况盘点**：btn-overflow 修复改动在 worktree **未提交**（IntakeFlow 4 行+UploadSheet 2 行同型，验证日志大量存在）；mycase-routing ②路由解析+③驾驶舱真数据两层已提交（550130d/ae9afec），①登录态持久化层与诊断报告缺失——均已带精确清单催收。
**🔀 向量引擎中转接入开工（2026-08-31 用户明示「llm 都尝试接向量引擎中转试试」，wf_51c8d587 四段流水线）**：NBDpsy 现成接法侦察→生产出口实测（四家全试：连通/流式 chunk 兼容/**tool_calls**/**usage 帧完整性=计费命脉**/时延对照直连，费用顶 ¥3 扣用户已充中转余额）→接线（claude 档经中转=唯一通路；deepseek/qwen 默认直连+env 开关可切，默认方向以实测时延为据；**顺手消灭 P1 计费键漂移债**——结构守卫先红 qwen3.7-max:nothink 后绿；usage 缺字段按 0 计防低卖静默）→对抗复审。**⛔ 红线不变：claude 档用户可见开放仍须评测官批绿+manager 放行，本单只接线不开闸。**中转新模型费率待定价项须过 manager。
**⚡ 全线并行总攻（2026-08-31，用户令「不同需求都开并行工作流同时完成，时不我待」——运行规矩升级：每需求即时开流不排队）**。在飞清单：①relay-wiring（中转接入四段流水线）②cost-table（中转定价 vs 官方成本表，claude default 组低至官方 1/14 的分组风险一并记档）③**cost-quality-p0**（P0-cost 三连：设计→注入相关性下限/时间戳缓存友好/补救轮经济学三路并建→逐单复审→固定 SHA 评测对照批；安全注入与经济注入分轨是设计红线；⛔上产=评测官批绿+manager）④**ux-p1-batch**（心跳贯穿 tool 轮/天数两把尺收唯一入口+daily-key/固定层 --bottom-bar-h 单真源/低调旁路两处按裁决口径/种子盲区四小件）⑤**growth-features**（单因素登录+新用户邮箱补全/邮箱注册/Google 登录暗启 flag 默认关+外部前置单列/全邮件模板勃艮第红+土八鼠+发件人——提醒信中性文案层红线不动）⑥**sidecar-intake-batch**（sidecar 五处泄漏分级净化 pytest/存储审计/MCP 省钱引导两处）⑦wenyao-recon（问爻管理后台侦察→manager 亲写设计方案）⑧btn-overflow/mycase 催收中。合并列车三号待全到站，滚版窗一次上齐。已知跨支冲突热点留合并轮：otp.ts（single-factor×email-register）、orchestrator.ts（p0cost×heartbeat）、discreet hook（sidepaths cherry-pick）。
**🎯 产品定位拍板（2026-08-31 用户原话入档，另存长期记忆）**：「风闻到谈裁员，才是我们主要客户选择我们的时间段。真的已经到仲裁了，通常都请律师不用再找我们了。」——demo/知识权重/文案叙事全部以施压期用户为第一人称。据此新开三流：⑨**demo-story-rebuild**（示例案件从风闻裁员讲起：剧本设计（HR 恶心动作→土八鼠反制配对、恐吓应对教练时刻、搜证线，仲裁只作尾部）→落 _mock 全套→法务零编造+定位双重复审；剧本师须另交「8 段轨道要不要扩风闻/约谈/施压段」的契约裁决请求——扩轨须 manager 批）；⑩**mobile-motion**（移动端动效语言设计→驾驶舱轨道/全局微交互两路施工，载入 frontend-design+gsap 系 skill 施工——用户点名；GSAP 依赖入库、reduced-motion 全量降级为硬判据、新文件优先控冲突面）；⑪**desktop-workstation**（批7 重启+动效：PC 工作台多栏/键盘/悬停独立交互逻辑，组件级视口分发不 fork 应用；**移动端 393 四页零回归为硬判据**）。在飞总数至十一路。
**🧯 sidecar 批判决（wf_26d8eac9）**：sanitize **过**——五处泄漏分级净化（三静态码原文保留+五兜底码安全概述，原文进日志；错误码表已定，app 侧回填按码白名单投影勿匹配文案；执行者 11 变异+复审官 14 变异，日志真源用零配置裸跑另证 caplog 之外的真实路径）；storage-audit **返**——复审官抓到自检恒等式**自己减自己恒真**（承诺"当场红"的三种破坏实测退出码全 0；修法=独立取数管道互证+产线路径样本）；mcp-guide **返**——一处 filter 白名单洞（一行修）。收尾流 wf_730b04b2 在跑（含 sanitize 的 FU-1 守卫白名单化/FU-2 码字面值钉死——app 回填前置）。**新债队列**：sidecar main.py root logger 配置（无 level 前缀+root 抬 CRITICAL 会静默消失）；app 侧 error_code 白名单回填（依赖 FU-2）；「正文敏感词糊层 vs 换词」维持既有糊层教义不重开（截图/录屏防不住是已知边界，记录不立项）；BOARD 接入卡引导行合并时拆两行改状态（②基线已有、①本单合入）。
**🏢 公司档案/背调产品化开工（2026-08-31 用户需求，wf_6f648148 十二路：设计→四建四审）**：①档案三件套=仲裁地情报（首发限北京朝阳、只引零编造存档）+公司涉诉统计（**胜诉比例/平均时长必须从已采文书实算、标样本量与截止日，样本不足显式说不出统计——不许软数字**；套路归纳逐条挂案号）+关联主体谱系图谱（普及背调，/graph 雏形升级）；②流程=报价→用户确认→扣费（走 lib/billing 入口铁律）→T+N 异步 job（文书网接力窗现实）分块交付→完成通知（中性文案层）；③**买会员立马送一次档案背调**（credit 核销防双花是复审必攻点）；④守望监控改收公道值。**定价初裁（占位待成本表校核后我终批）**：档案首次 1980/缓存命中 480/守望 199 公道值·月·主体。⑤**中/高档会员解封**（用户令：中转已打通 claude）——实现完整但 flag 默认关，⛔上线前置=claude 路由评测批绿+manager 放行（评测官既定「Claude-routing batch before 中配 opens」协议兑现时刻）；依赖 ws/relay-wiring（现分支已建提交未落）。计费原则入长期记忆：**耗后台算力/进程监控的功能都收公道值，前置报价**。成本表已落库（ws/cost-table@4269324）。在飞十三路。
**💓 P1 批判决（wf_baa9ad46，10 代理）**：**四过一窄返**。days-one-ruler **过**——两把天数尺收唯一入口钉死案件时区 Asia/Shanghai（复审官 72 组独立复算：分歧 32 组方向全是 UI 高估；「用户本地时区是合理语义差」被纽约档实测证伪）；bottombar-var **过**——固定层 --bottom-bar-h 单真源落地，复审官双 server 同探针实measure 重叠全归零（40×32→40×0），附一条 ref 源码断言并入前补；discreet-sidepaths **过**——侧栏同修长按（Radix Slot 事件合并链亲核不吞）、设置页关闭加后果确认框；polish-seeds **过**（M9/M10 层叠覆盖类盲区留档）。heartbeat-toolrounds **窄返**——实现对（开关判据从「首字来过没」改「正文在不在流」，顺带覆盖一切静默源），卡在判据只扛一段静默（MAX_TOOL_ROUNDS=8，R6「只恢复前两段」存活）+ frames.ts 契约只改后端半边（:5/:26 仍写「首 delta 即停」）。**manager 契约裁决：批准 ping 时机契约变更，条件=同 commit 双边齐改+mock 同步**。收尾流 wf_35fe68ab 在跑。
**新入队**：动作卡 UTC-Z 串在 formatDate/daysUntil 下可能显示两个日期（安全方向回退，带时区串应走 caseDayOf(new Date())——另单）；合并轮两笔：DiscreetContext 的 toggle 届时零生产调用方、直接从公开 API 删掉（tsc 点名回潮点）；主仓 checkout=manager 台账分支（ws/guard-alter-fix）不含修复支——**审读代码去 worktree，别读主仓 cwd**（days 单执行者差点照幻影 bug 写修，记为协作注意事项）。
**✅ P1 批全绿（收尾流 wf_35fe68ab 双 PASS）**：heartbeat 判据延长到四段静默（R6 计数型变异死于 62s 段；终审官自加对照臂——同一变异体配旧测试文件全绿，证明「转红」不是「本来就红」；「7 行原文找不到」经查属实非托词，按行为等价收）+frames.ts/mock 契约三处齐改（manager 追认 mock 扩范围：rs_long 专属 20s tool 轮静默，普通演示零拖慢——终审官逐剧本核实）；bottombar ref 断言补齐（终审官实证它是该缝唯一判据：变异下 tsc 仍 exit=0）。**P1 批五支全绿定版**：5581972/e95cd01/d332410/56280e6/ba72f5e。残留留档不追：心跳判据覆盖 4/8 段（状态机无计数器、计数变异已灭族，边际递减）；usage 与 done 之间理论可挤 ping 帧（先于本批存在）。
**✅ sidecar 批三粒收尾全绿（wf_730b04b2）**：storage-audit——对照重算管线落地（去重换 Set/字节换 Buffer.byteLength/归属换内存接图，与主查询零共享 SQL），三种破坏 CLI 退出码 0→1 全点名，复审官另建异形夹具独立复现+自出第 6 变异（「只有对话的用户整个消失」判据点名到人）；越界两行 synchronous=OFF 经实测追认（既有 flake 5.5s→10ms）。mcp-guide——豁免从整目录收窄到两个具名文件，R11（billing 目录里新建包装层扣费）转红。sanitize——白名单守卫+码值冻结四变异全红；manager 亲落终审措辞两处（字面量硬编码不在守卫射程、update/setdefault 类寻址穿透实况写明+根治结转 app 回填单）@2b023f2。
**协作规矩两条新增**：①复审官夹具/临时产物放**自命名子目录**（scratchpad/mut/ 被并行 agent 覆写、两任复审官被迫重建夹具——五十路并行下公共目录就是共因）；②sidecar pytest 用主仓 .venv 的 python（worktree 无 .venv，系统 python 收集期就炸）。**队列**：seedDisk 补「只有对话」用户+该变异入 each；app error_code 回填单规格再增两项（error 写入点入口唯一哨兵、G1 类字面量 review 项）。
**🔑 增长批判决（wf_74384b50，8 代理）**：single-factor **过**（邮箱升为独立登录入口，坏 token 一律 401 不降级匿名，赠送 reg-<uid> 幂等；24 条放宽向变异全灭）+email-templates **过**（统一模板层勃艮第红 32px 验证码行+cid 内联 logo/土八鼠、From 头 =?UTF-8?B? 解出「土八鼠」、提醒信中性文案 copy.test 仍绿）；email-register **返**（实现可用，三判据缺牙：中性文案红线新路径零判据、存量邮箱登录口径需具名契约）+google-oauth **返**（🔴安全阻断：error 分支排在 state 校验前，GET /callback?error=<任意文本> 无凭据即把含 <img onerror> 与钓鱼话术的文本反射进 /login#google_message——修=state 先行+片段编码+纯文本渲染死规矩）。收尾流 wf_f92647f5 在跑（含 manager 三策略裁决：Google 新用户享同等建档+赠送、陌生邮箱登录响应对齐手机通道不泄露注册状态、存量邮箱登录升具名契约）。**邮件模板已就绪**——可作后续所有对用户通知/审批信的品牌壳。
**📧 用户新令（2026-08-31）**：待审事项一律发邮件到 hubaiyipku@163.com（HTML 要好看可正常审阅）。此前「hubaiyipku 仅内部告警/测试例外」升级为**用户主动指定的审批收件通道**；审批邮件用 email-templates 品牌壳，但审批信非提醒信、不受中性文案红线约束（可含事项详情）。manager 攒待审清单成信、经 SMTP 发出。
**🔀 中转接入流水线到站（wf_51c8d587）**：probe 实测——中转 543 模型（routing 要的 6 别名全在册），claude-sonnet/opus-5·deepseek·qwen 四件套全通（claude tool_calls index 可为非 0、SSE 有 [DONE]、usage 多 cache_write 字段 lawer 丢弃、claude 的 json_mode 带 ```json 围栏需剥壳、served_model 可能与请求不符、503 非 4xx、200 空 content=length 失败），中转打 deepseek 比直连 TTFB +1.7~4.1s（故默认直连）。wire **过审**（relay.ts OpenAI 兼容薄包装读 RELAY_BASE_URL/API_KEY 零硬编码、接既有 gate、claude 三格+降级链首段走中转、RELAY_ROUTE_DOMESTIC 开关默认直连、qwen3.6-flash 钉死不走中转因实测 429×3、**计费键结构守卫先红后绿消灭 P1 漂移债**+顺带抓出 qwen3.6-flash:nothink 缺行）；review PASS 附 M5b 一行必补（env 判据 ===‘1’ 改 !!process.env 全绿——需判据钉"只认字符串1"）。relay 收尾 wf 在跑。**⛔ relay 上产双前置**：①新 key（见下泄露事故）②claude 档评测批绿+manager 放行。
**🔐 密钥泄露事故处置闭环（2026-08-31）**：中转侦察子代理跑未脱敏 grep 把 vectorengine API key 明文打进工具输出（自报，后续脱敏）。处置：通报佰亿助理(NBDpsy)→哈希比对确认**本机与生产同一把 key**、暴露面含生产→老板本人登 vectorengine 控制台轮换（NBDpsy 协调、两处 .env 他们更新）→**土八鼠这条链停手不动**，新 key 由 NBDpsy 按非明文取法转交、我填 /data/lawer/env（600）。lawer 接线代码零硬编码故轮换不影响代码。教训入协作规范：子代理报行号用 sed 脱敏，grep -n 只加行号不脱值。等级=一次工具输出留痕，可控但该换即换（[[feedback-overstating-risk-is-also-error.md]] 对侧：不夸大也不淡化，轮换成本低风险不对称）。
**📧 审批邮件首发成功**（messageId c5f2780c…@nbdpsy.com，accepted hubaiyipku@163.com）：勃艮第红品牌壳、163 兼容表格布局，含 P0 安全处置（已改"NBDpsy 协调中"避免重复指令）+A1-4 决策（定价/会员解封/轨道扩段/中转分组）+B1-3 外部操作（护照/Google 回调/百炼限流）+C1 确认（9:30 测试信）。发信器 /tmp/send-approval-mail.ts（复用生产 SMTP 465/FROM_ALIAS，app 目录内 node .mjs 跑免 tsx 模块解析坑）。用户新令"待审发邮件"首次兑现。
**✅ email-register 单验收通过（c4fb352，2026-08-31）**：负对照在 93d431c 复现复审官 F1/F2 逐字、正对照在 c4fb352 九变异全红、双绿 2232 passed+build 两路由在册。F1 中性文案红线新路径补判据（detailed 变异转红）；F2 复审官三条（is_new_user 驼峰/删 onboarding/删 token）+ 执行者自查两条（删 retry_after/删 onboarding-send）一条整体 toEqual 罩死；F3 **正名非补漏**（describe.skip 契约块后 F3 变异仍红 3 条=契约块非唯一守门，价值在"让行为可读成裁定"）。**merge-train 清单**：c4fb352 与 single-factor f653304 同改 otp.ts，冲突后两侧测试都必须留（email-register 契约块显式点名 single-factor 的姊妹测试）。
**🧭 manager 归因两错留档（据实，2026-08-31）**：email-register 收尾期我连续两次误判验证者 a19dbead 的身份——先当它是"多余的第二收尾者"（裁定 A 让它停手，恰好对，但理由错）、后当它是"收尾执行者本人产出 c4fb352"（错，它对共享 worktree 零写入）、还把 RSEND 事故错记给它（实为它定义了 RSEND、没踩）。它两次拒绝接受不属于它的功劳/事故、坚持据实纠正。教训：**高并发多 agent 下"谁做了什么"极易叠错，归因前要按文件系统事实（提交作者/时间线/git status）核，不能凭消息往来推**——这本身就是 [[parallel-agent-isolation]] 的一个面：不只资源会串台，功过归属也会。真正自抓的三个"失效不报错"实例（reporter 不存在冒充全绿/自数行数自己/build 红是 symlink）归 a19dbead，是今日质检最硬一课。
**📥 用户六答拍板（2026-08-31，额度恢复后）**：
- **A1 公司档案重拆**：否决整档 1980 打包——拆成可勾选模块、核心组合必须≤1000（赠送覆盖）、逐模块估价、1000 赠送要能真体验出价值驱动付费。→ 旧 dossier 四单 build（1980 设计）**作废重做**；已派 wf_5637d854 模块化重设计（核心体验路径+逐模块估价+对抗审）。
- **A2 会员解封**：评测跑绿**直接开闸**（推翻 manager 保守建议的"再点头"）。→ relay claude 档上产前置改为"评测批绿即自动开 flag"，不再等 manager 二次放行（评测批本身仍是硬闸）。
- **A3 里程碑扩段**：要扩，但**约谈∥施压并行**（非线性）；每阶段明确行动清单/搜证计划/应对方式**写进工作流保一致**。→ 契约级；已派 wf_c2ddd6f7（并行阶段模型+阶段三件套结构+编排一致性机制+对抗审）；demo 剧本落格待此方案定后调整。
- **A4 中转分组**：走 **default 组**（智能分配价格最低优先）；价格优先→必然不稳定→**发现不稳定就重试**；给了**用量查询 API**（GET {baseUrl}/api/usage/token/，Bearer，返回 total_granted/used/available，单位=值÷500000 刀）。→ relay 单加三样：默认 default 组、用量 API 接成**余额监控+低额告警**（避免再被动发现耗尽）、provider 层不稳定重试（已合的 llm-gate 有重试骨架，扩到中转的 429/503/超时/served_model 不符）。
- **B2 Google 回调**：回调地址=`https://law.nbdpsy.com/api/v1/auth/google/callback`，JS 来源=`https://law.nbdpsy.com`，控制台 console.cloud.google.com/apis/credentials。已终端给全步骤；Client ID/Secret 走 NBDpsy 非明文取法转交后填 env 开 flag。
- **B3 百炼**：A4 的用量 API 已取代手查百炼限流页；位置附带给（bailian.console.aliyun.com 搜"限流"）。
- **C1 提醒信收到** → 提醒系统三证齐（job_runs items_ok=1 + 期限记档 + 信箱实物），**正式对用户生效**，"提醒在保护你"解禁兑现。
**🚨 生产模型余额告警（并入 A4 处置）**：评测实测 DeepSeek 402 耗尽/OpenAI 无额度/DashScope 有余额——entry 档主力挂、靠降级链 qwen 撑。已发紧急邮件（messageId d0f0d4b9）+通报佰亿助理核实账户共享。根治=中转上线（有余额）或充 DeepSeek。**这就是 relay 紧迫性的实证**。 **影响面纠正（佰亿生产日志实查，manager 推断错据实更正）**：DeepSeek/DashScope 同账户但**直连耗尽只影响 lawer**——NBDpsy 现役全走 vectorengine 中转(route=relay,direct_attempts=0)不受影响；但直连是 NBDpsy 的兜底腿,现已断(402),NBDpsy 实质单腿站泄露待轮换的 relay key 上。⇒ 给老板的一揽子带**操作顺序**：①充 DeepSeek(建兜底+解 lawer 主力)→②轮换 vectorengine(轮换间隙有兜底护航)→③开土八鼠限额子 key。教训:又一次"基于部分事实推断"错(同账户≠同受影响),须核实际路由日志——同 [[git 会静默给错答案的两处]] 族的归因版。
**📦 大批到站汇总（多路 review 因 11:10 前额度限制中断，待 resume 补跑）**：P0-cost（**inject-floor FAIL——评测批抓出它误杀 11 张 sop/template 操作卡/10 用例即施压期核心场景的答案卡，与产品定位直接冲突，打回重设计经济下限不能用 isSubstantiveHit**；ts-cache/remedy-econ PASS 前缀稳定 32%→73-99%；真模型臂全被 402 卡住待补余额跑）；动效（设计出色：否决 GSAP/29KB、否决轨道横滑与瓦片脉动、B 路 global-motion build PASS 版式对照臂驾驶舱像素同尺寸，cockpit/global review 待补）；PC 工作台（设计发 artifact、ws-shell build 移动端零回归+查出 favicon PC 独有泄密面已修，ws-panels build 与两 review 待补；**待用户一个数=桌面 UA 占比,决定排期**）；增长收尾（**google-oauth PASS**——XSS 反射阻断实堵 6/6→0/6、Google 新用户享同等建档、8 变异全红；single-factor recheck 待补）；demo 剧本（产出极高质量,20 时间线 16 条在解除前,4年8个月教学时刻,待 A3 落格）。
**🔑 Google OAuth 凭据就位（2026-08-31，用户控制台配好后发来）**：client_id `700217179307-…`（project nbdpsy-seo）+ secret 已填 /data/lawer/env/app.env（600），**GOOGLE_OAUTH_ENABLED 未设=flag 关**（上产前必须关的红线守住），本地+远端临时文件清净；用户配的 redirect_uri `https://law.nbdpsy.com/api/v1/auth/google/callback` 与代码变量（GOOGLE_CALLBACK_PATH）一致、javascript_origins 对。**Google 登录上产清单**：ws/feat-google-oauth（ff8b2d8 已过审，XSS 阻断已堵）合入滚版窗 → 开 flag → 激活。凭据填法用 Write 临时文件+scp+append，secret 不进 shell 命令行/history。⚠️ secret 经聊天明文传（会话留痕）——风险低于 raw API key（OAuth secret 须配合 redirect 白名单 law.nbdpsy.com 才能用），已提示用户可选控制台重置；不作泄露事故通报（用户主动发的配置凭据、低风险，区别于 vectorengine 子代理误泄）。
**✅ 模型余额危机解除 + 双 key 到位（2026-08-31 生产手术，当场留痕）**：①**DeepSeek 官方独立 key**（fp 3e8b757348ce≠旧共享 6dd140，deepseek-chat/v4-pro/v4-flash 全 200）→ 替换 DEEPSEEK_API_KEY，lawer 从此独立账户、不再共吃、不再靠 qwen 降级；②**向量引擎中转子 key**（name=土八鼠，**unlimited_quota=true**，claude-sonnet-5 实测真回话）→ 填 RELAY_API_KEY + RELAY_BASE_URL=https://api.vectorengine.cn/v1（待 relay 分支上产）。是老板新开独立子 key 非泄露旧共享 key（用户先误发中转 key 当 DeepSeek，我在 api.deepseek.com 验 401 挡下未误填——"先验证再填"救了一次盲填）。备份+chmod 600+重启 service=active。⚠️ 两把 key 经聊天明文，建议用稳后各控制台轮换（中转无限配额那把尤值），已提示。A4 用量 API 实测可用（api.vectorengine.cn/api/usage/token/）=余额监控数据源。relay 上产前置剩：分支合滚版窗 + claude 评测批（A2 绿即自动开）。
**🗺️ A3 里程碑方案 v1 FAIL→返修（wf_c2ddd6f7 设计，wf_86520bf1 返修中）**：骨架洞察过审保留——**并行=横档(TrackRung)属性非里程碑本身**(约谈∥施压同档不定序)、三件套=映射卡 method-stage-playbook 指针(卡里无可写散文字段=零编造结构式非纪律式)、一致性靠取料通路(阶段按 id 直取不过检索打分,照抄 sceneCoreArticles)。FAIL 五项返修:①三态派生**自证不成立**("进行中"无产生规则、优先级写反致回退用例必红、并行档"当前哪一步"两高亮单值读法静默取首)→明写优先级 进行中>完成>跳过>未到+并行档唯一性+回退落并行档形态+纸面验算 milestones.test 十组;②**demo 基线错位**(v1 引 te_18/te_20/−96 是 ws/demo-story 新剧本编号,复审读 6413dc5 旧 demo te_1..7)→声明依赖 demo-story 合入+论证改用真剧本数据;③漏列运行时判据 CASE_MILESTONES(lib/cases/index.ts:45,v1 误称"实码零消费")+糊层隐私不变式(风闻/约谈/施压比"执行"更敏感必须在 data-veil 内)+DEMO_TRACK 扩档;④evidence_plan 后6档无 SOP 节可指的硬矛盾;⑤items 内容锚+近义词+headline 禁则。**契约级,manager 审+裁三裁定项(搜证拆分/确认无豁免/并行档唯一),不发用户(用户已批扩段方向)**。依赖:demo-story 剧本(法务审已过,20 时间线 16 在解除前)与 A3 契约合并轮一起上。
**dossier 方案 v2 FAIL→v3 返修中(wf_cf7a08ba)**:骨架(340核心/≤700上限/1980全买/月卡引导)过审算术全对;7 条阻断修红线绑定+补贴标注+锚修正。二方案(A1/A3)都在返修,过审后 A1 发用户批(商业决策)、A3 manager 裁即实施(契约细节)。
**✅ 公司档案 v3 PASS + 审批邮件发出（2026-08-31，messageId a35bd18e）**：dossier 模块化方案终审 PASS（7 阻断真修、骨架六值 340/700/1980/月卡/1640/930 逐一复算未动、无裸奔无锚混用、G2 变异臂有牙），存 docs/design-notes/2026-08-31-公司档案模块化方案-v3.md。审批邮件发用户批：6 模块+守望定价表、1000 体验路径(核心四块340→首诊+2轮陪跑→余320撞深度统计墙→19.9月卡)、**六项拍板签字**(M3=200含退款/会员送核心四块非整档/M5<5篇置灰/超30篇不处理/免费查每日2次获客补贴/守望199/60/0分档)。等用户批→实施(四单 build:采集管线/计费流/图谱UI/守望+会员解封,旧 1980 四单 build 作废重做)。
**🚀 加速中转上线（2026-08-31 用户令）+ 待决策邮件**：relay 分支 6b4865f 就绪、生产 RELAY_API_KEY/BASE_URL 在位；**Claude 路由危机红线评测批已派**（claude-eval：entry vs sonnet-5/opus-5 走中转双臂，L1 全集一条不过不开闸，中转怪癖围栏/空content/503 一并验；无限配额预算不卡）——这是 A2「评测绿直接开」的唯一前置闸，绿即 manager 自动开 flag+合并 relay+滚版。待决策汇总邮件发出（messageId 见下）：①电脑版排期（方案已设计，建议先放手机优先）②两把明文 key 轮换（建议不急）③提醒 dossier 六项。**用户令"待决策统一发邮件不在别处絮叨"入制度**：今后拍板项一律汇邮件。
**✅ A3 里程碑方案 v2 PASS（wf_86520bf1，manager 裁定定稿）**：五维全过——①三态规则自洽（纠正 v1 把优先级写反：实码本就"进行中>完成"，v1 据错自证矛盾；v2 补 currentSet 三分支产生规则+并行档档级唯一/档内多道如实渲染+回退落并行档形态，十组纸面验算逐位对实码；排掉一颗"currentSet 取全部道非无达成道"的乱序分叉雷）②demo 论证逐条核到 demo-story 剧本稿逐字一致③CASE_MILESTONES/糊层不变式(风闻/约谈/施压比执行更敏感必进 data-veil)/DEMO_TRACK 三处补齐④evidence_plan 后6档分层裁解+死链修复(dianzi/tanpan/pip 真节名逐字校)⑤破坏面全识别。**manager 三裁定项采纳**：搜证拆 evidence_plan(每档)+证据组卷(一档,协商后,demo 数据支持:搜证 te_2 早于约谈、组卷 te_20 晚于协商)、确认无豁免、并行档唯一(约谈∥施压)。**两落地条件认**：①合入顺序钉死 **demo-story 先、A3 后**(同改 demo.ts+milestones.ts 须串行)②§2.4 的 50+ 知识卡指针 WS4 落纸时逐张 grep(守卫 a 是最后一道网非第一道)。骨架洞察沉淀:并行=横档属性、三件套=映射卡指针零编造、一致性靠取料通路(阶段 id 直取不过检索)。**契约级,不发用户(已批扩段方向),排进 demo-story 合入后实现**。
**✅ 三补跑复审全 PASS（wf_5ec7f7ba）**：motion-cockpit(7119326,19变异全红,reduced-motion跳终态/gsap单入口清理/首屏不补播/行动卡无cheer/无常驻脉动/393零回归/低调泄密面Seal返null)；desktop-ws-shell(50dceb4,**移动端393四页逐字节零回归硬判据亲验**/容器查询分发1536对照臂/favicon PC泄密面修+变异臂关低调真徽章回位/不卸载流式中⌘B焦点不丢)；single-factor(2231绿,前端LoginFlow测试补齐防头号交付物无声消失/响应同形不泄露注册状态EMAIL_NOT_REGISTERED清除/赠送幂等/14变异全红)。**新量具教训**：性能探针 next dev 下 HMR 未水合会两头骗(假红假绿),必须对生产 standalone 构建跑——入协作头待补。**几乎全线过审,发大合并列车 merge-train-v2**(二波UI5+P1批5+增长4+sidecar3+动效2+PC ws-shell+demo-story+relay 接线,基线6413dc5;claude flag/relay claude 档保持关待评测绿;冲突热点 otp.ts/globals.css/breadcrumb.tsx/events.ts/discreet-hook 多支同改)。
**📥 用户三决策（2026-08-31）**：①**PC 与手机并行做,都重要**（推翻 manager"先放"建议）→ 补 ws-panels(PC B路 build)+PC 方案全实现,与移动端并行,不排后;②**两把明文 key 不轮换**（记档,继续用,无动作）;③**公司档案定价批准"就先这么定价"**→ dossier v3 六项拍板视为全同意(M3=200含退款/会员送核心四块/M5<5置灰/超30篇不处理/免费查每日2次/守望199-60-0),**四个实现单开工**(采集导入面/报价确认计费流/图谱档案UI/守望计费+会员解封)。三路并行开:merge-train-v2(合现有过审分支)+dossier-impl(四单)+PC ws-panels。
**⚠️ dossier 旧甲案遗留处置（2026-08-31）**：重派 dossier-impl 四单时未清旧 build 分支——wf_6f648148 的 dossier-billing build 留了 f59369f(旧甲案:打包 graph480+litigation1200=1680/送整档 entitlement=dossier/无核心≤700守卫),与 v3 模块化结构不兼容。dossier-billing 执行者诚实报状态不一致再动手,manager 批 reset 到 6413dc5 按 v3 重做(f59369f 作废进 reflog、复用基建、旧两块1680 探针不纳入)。四单大概率同款遗留,各自 build agent 发现即 reset 重做 v3。教训:**重派已作废批次时须显式声明"旧分支作废、从基线全新做",否则新 build 撞旧提交**——派单遗漏,幸执行者自查抓住。
**🚨 双写事故#2:wt-dossier-billing 两写手同占（2026-08-31 处置完毕）**：dossier-billing 工单出现两个执行体写同一 worktree 同批文件(pricing-config/entitlements/dossier-billing.ts 互相覆盖,reflog 两次 reset 6413dc5)。**根因在 manager**:管道内执行者第一封状态报告(旧甲案 f59369f 处置请示)我用 SendMessage 回"批准"——这一下把发信 agent 唤成了管道外的第二执行体,与管道内原执行者撞单。裁定:管道内执行者为唯一 owner(版本更靠前自洽:G1守卫 coreBundleWithinGuard/MODULE_BASIS/billableDocs,且完成自动进复审),第二执行体彻底停手退出,树是 owner 的自洽版本无残留。第二执行体发现双写立即冻结报告,行为满分。**新铁律(入并发隔离 memory)**:回复 workflow 管道内 agent 的跨会话报告 = resume 出管道外分身,再撞同一工单;裁定/批准类回复要么极简("批准,继续"并明确它就是唯一执行者),要么先确认收信方与管道执行者是否同一实体。
**双写事故#2尾单:features.ts 杂散写入登记（低风险,验收专核）**：退出执行体最后一次 Edit 落在 owner 版本上——FEATURE_LABELS 追加六条 dossier 模块标签(venue/entity/graph/docs_list/docs_stats/patterns)。manager 只读核过 diff:纯追加、snake_case 与文件惯例一致、语义与 v3 逐条吻合(M1信任锚/M3退款/M5每篇/M6起价+每篇),内容自洽无害。不动树;owner 双绿纪律+复审 diff 卫生兜底;**验收 dossier-billing 时专核 features.ts 六条与 owner 命名是否归一**。退出执行体已正式关闭(无提交无 push,行为全程满分)。
**📦 dossier-impl 四单结果（wf_87e6c876）+ 双写终局**：①**dossier-pipeline PASS** @9018de0(2336绿,5变异全红;免费探测零LLM四态降级不静默空/统计硬规则连键不出现/套路零编造SQL存在性+quote逐字/迁移45→47幂等)。交界递延两项:谱系导入(graph.json→profiles/relations)四处边界债在 dossier-ingest.md §七·补,需定 role 入口归属;第二买家凭据静默丢弃(createDossier 同 company_key 返旧行,退款绑buyer1)交编排lane——**两项绑"图谱UI v3增量开工时"裁**。②**dossier-billing FAIL→收尾单已派(wf_4b1bed27)**:双写终局=两执行体互把对方当owner双双退出,v3代码成无主孤儿(逻辑扎实但migrate零表/四旧甲案测试74红/零提交);manager 裁定曾点给"管道内执行者"——恰是退出方,**裁给了空气**。新收尾执行者:唯一owner明示无对手,补三表DDL+(kind,source_ref)唯一索引、重写四测试、features归一、单一提交。③**dossier-ui PASS**(2250绿@a3cf672内容,5变异全红:样本不足零软数字/无evidence不渲染/coverage_note同屏non-collapsible);v3增量两项(探测模块报价页/一键加守望)为真实后端阻塞,**绑"billing 收尾过审后"补**;缺393渲染断言(静态无风险,补即闭)。④**watch-tiers-unlock PASS** @f80b9ee(95+364绿,10变异9杀1冗余防御;三档199/60/0走gongdaoSettle/arrears三层幂等绝不静默停盯/解封flag默认关两向变异红/中性文案泄词即红)。⚠️提示项:assertSkuSellable 尚无生产调用方,**M3下单路由接线时必须调它**;paused盯梢复活是独立动作留档。**裁owner新铁律**:裁定必须点名到可寻址实体并收到ack,"管道内那个/另一个"这类指代会裁给空气。
**✅ PC 工作台 B 路 PASS（wf_f4a0af48）**：ws/desktop-ws-panels @cad3b53(父50dceb4,壳层一行未动)。签名件引用桥双向生产实测成立(hover法条卡↔「本案依据」行互亮/点卡开查看器三栏856│340│380逐字原件185字);⌘K 经 hotkeys.ts 唯一入口;data-table 手机卡片面孔逐字节零变;**393四页像素diff全0**(执行者逐像素)+机制门控证明(复审官:any-hover恒真档更严苛仍静息零点亮/本案依据无work容器恒display:none);2274绿,4变异全红;卷宗依据块改容器查询@min-[990px]/work与卷宗栏同阈值,消灭「卷宗在依据不在」窄桌面带。**PC 两路(A壳+B面板)全过审,用户「电脑版并行做」交付在望**;已知会 merge-train-v2 尾部补挂。
**✅→🔧 dossier-billing 收尾 PASS 可合 + 五处收口单再派（wf_4b1bed27→wf_e93ee893）**：收尾 @ddfa1b7(22文件+3642;迁移三表+(kind,source_ref)部分唯一索引,基线实测39表→42非派单臆测的45→48,执行者据实纠正;五个甲案测试重写129用例;features 归一无杂散键;11+40条变异矩阵,36红)。执行者两件上报:①契约文档甲案改v3(манager **追认**——留着会让前端照死API建)②「HR套路归纳」→「人事套路归纳」(守卫拦拉丁字母,改标签不放守卫,用户要改回是两行事)。复审 PASS 带四洞+一裁决,**全部裁入收口单 wf_e93ee893**:M6算式5-19篇区间印算不平式子(用户可见必修)/MODULE_BASIS死字段收真源/券白吃判据(深度-only静默核销券,删门全绿)/重复报价钉零(已买模块再报原价total虚高)/**买会员自动发券接线(manager裁:接——用户批的「买会员立马送核心四块」当前生产走不到,fulfillOrder+grantEntitlement,reverseOrder+revoke,路标测试翻正)**。收口过审后 dossier 全链(pipeline/billing/ui/watch)齐,补 ui 两项v3增量(探测报价页/一键守望)即完整。
**✅ billing 收口 PASS @f2ef015（wf_e93ee893）→ dossier 四线全过审,互合+UI增量单派出（wf_fa9a9a34）**：六项全落地(算式自洽复审官逐点手验5-35篇/MODULE_BASIS收真源四口径互换全红/券白吃判据/重复报价钉零——执行者识破复审给的锚点是假牙(venue原价本为0)另起真牙/买会员发券7条正向断言/标签双向机检),19/19变异红,2354绿。**⏳遗留缺口绑观察条件**:券核销FIFO取id最小、吊销按source_ref认单,两半口径不一致→买A买B退A可白得一张券(340公道值≈2.25元,需两单+退款,fulfillOrder现无生产调用方线上不可达);**触发条件=payment/index.ts 从 export{} 骨架变实入口(支付通道接线)时必修**,修法二选一:退款吊销兜到同user+kind任一未核销/或核销也按source绑定。scratchpad通用名(mut/base)串台复审官亲历再证(混入single-factor另一路26个tsc错),自命名目录后清零。dossier-integration 单:四支互合(migrate计数以实跑为准,两支报数矛盾45→47 vs 39→42)+UI补探测报价页/一键守望+393渲染断言;完成后以单支挂 merge-train 车尾(已知会)。
**⚖️ company_key 语义裁决（dossier 互合第⑤冲突,manager 采纳执行者建议,依"否决才回话"协议未回避免resume分身）**：两支算法互斥——pipeline `companyKey()` 激进归一(uscc:/name:前缀+繁简小表+有限责任公司≡有限公司) vs billing `companyKeyOf()` 保守裸串(仅NFKC+去空白+小写,拒繁简与后缀等价)。**裁:取 billing 保守语义 + 保留 pipeline 的 uscc:/name: 命名空间前缀**。理由=误差方向:company_key 同时是缓存键与计费键,过度归一→用户付A家的钱拿到B家档案且全程不报错(静默错);归一不足→多建一次档可见可退(报警错)。工商登记全称是精确串,「有限责任公司≡有限公司」属过度归一。繁简等价将来若要,做在输入归一层(表单提示)不做在键算法层。两侧结构守卫(ALLOW名单+对照臂/NFKC扫描)全保留。执行者报告协议设计得好:「等你否决否则按此执行」——管道内agent请示的正确姿势,免除回复致分身。
**🔀 dossier 四支互合完成 @dd5e842（双绿 2571,normalize 按裁决落地保守键+前缀,改回激进仅一函数四断言）**。**合完现形两跨工单缺口(两边各自都对,合起无人认领;绑 wf_fa9a9a34 完成后立派收尾单)**:①**案件→档案适配层缺失**——呈现层 DossierLoader 请求 GET /api/v1/cases/:id/dossier(全仓不存在),计费侧落的是 GET /api/v1/company/dossiers/{id};UI 测试 mock 掉 apiFetch 故全绿,**真跑档案页 404**。dossier-api.md §二 已明写"待A/B落地,建议做成后者薄包装"(页面手上只有 caseId);收尾单按文档做:case→company_key(被申请人)解析+case:read 同款鉴权+未建档返回引导态(报价页入口)非裸404。②VenueCard.sources 恒空数组(knowledge/index.json 未导出 sources,改索引生成器)。教训重申:**mock 网络层的全绿证不了端点存在,集成后必须有一次不 mock 的通线**。
**⚖️ 合并列车两设计裁决（23支全绿@1ed2970 检查点,motion-global+ws-panels 等裁后落）**:①**motion.ts 硬分叉**:reduced-motion SSR 默认取 A(true 偏不动)——误差方向:危机高压期用户,前庭敏感者被首屏甩是真实伤害,普通用户首帧无感;动效是 hydrate 后增强层不会"像坏了"。EASE 双名(EASE=函数/gsap 已在树,EASE_CSS=字符串/WAAPI,机械改 B 消费者)。haptic 统一过 hapticEnabled() 开关含恐慌钮(尊重用户关触觉)。②**ws-panels CaseHeaderBar 取(c)**:组件测试全合、Dashboard 暂不挂(带工单号门控),mycase 红线一字不动——红线守的正是用户亲报痛点(自己案件页出演示数据),不为合并打薄;**递延单:CaseHeaderBar+layout demoCase.title 接真数据(mycase 已列遗留同族,纯接线),集成态上派,接好挂回**。③追认:PanicButton 三方组合方案/gsap^3.15.0/AppShell caseIdFrom 迁走。④杂项记档:_mock/demo.ts priority 方向与工具 schema 相反(数字越大越急是对的,mock 用 1 标最急;今无代码按它排序无可见后果,防误导后来人,后续单顺手修);audit.mjs:315 选择器取 static 那颗恐慌钮发假 OK+G1 恒真式(btn-overflow 执行者揭穿,量具债,重跑审计前必修);**approval-collector 旧清单(11项)作废**——其中定价/轨道/成本表等多项已过时(如仍写甲案1980),不得据它发邮件。
**✅ dossier-integration 全链 PASS @497f280（wf_fa9a9a34）→ 收尾四件单派出（wf_b7c4074d）**:合并 dd5e842(四支祖先/零缺失零缩水/八条红线实跑变红/migrate 实跑47表收敛——CREATE IF NOT EXISTS 同名表静默跳过是"最危险一处",合成唯一定义列索引并集);UI 增量 497f280(报价页v3零扣费实证:30连打余额+47表行数零变;置灰原因句用服务端409原话防口径漂;393静态尺子带自体检;执行者自查修三处静默错账);复审 PASS,13变异全红,对账+4files/+76账平。**追认**:删v2报价契约不留兼容(两份契约并存=页面按一份渲染服务端按另一份收钱)、ALLOW名单加demo mock(仍紧)。**收尾四件单**:①cases/:id/dossier 薄包装(真跑404的头号缺口,通线测试不mock apiFetch,未建档=引导态非错误)②VenueCard.sources生成器导出③NodeSheet低调泄「监控」修(既存,牵三处)④stale守卫补牙(复审点名:防"A家价买B家档案"的修复本体零覆盖,删之2656全绿)。完成即挂 merge-train 车尾。
**🚂 大合并列车 v2 到站 @8bac183（25支全合全绿,未push）**:tsc 0/vitest 2892(+683 于基线,0失败)/25支全tip祖先0静默丢边/migrate 39表实跑核/gsap^3.15.0/relay+google flag 双关(.env.example空+代码不强开)。两裁决落地:motion.ts(reduced-motion SSR=true偏不动/EASE双名/haptic过开关/B路补reduce-guard/PanicButton组合方案)、ws-panels(c)(CaseHeaderBar暂不挂带工单号,mycase红线未动仍绿)。跨支顺带修四处均过红线(Seal对比度/CommandSearch焦点/milestone-skip mock/not-found迁caseIdFrom)。**发版流程定**:dossier收尾过审→挂尾(migrate以挂尾后sqlite_master实数统一,47∪39去重)→**独立审计员审终态(合并者不自审)**→滚版(flag关上产)→claude评测绿后开flag(独立一步不互相阻塞)。**递延单追认在列**:CaseHeaderBar接真数据后挂回(连带MilestoneTrack收lg:hidden+useRouter SSR夹具)。
**✅ dossier 收尾四件 PASS @5f0327b（wf_b7c4074d）→ 算术终修单派出（wf_fc94179f,挂尾前最后一单）**:①适配端点 15条零mock通线(真库真handler,三种未建档来路逐字同载荷防"有没有人建过档"探针,B12加existsElsewhere字段被咬住;删DossierLoader的HTTP_404吞噬——端点不存在与未建档同形的成因)②sources 218卡全带出处(生成器INDEX_FIELDS补sources,朝阳SOP带bjchy官方页+模板zip;dossier-honesty原判据喂手写卡故恒空期间一直绿——**又一例"你以为验的是X实际验的是Y"**)③NodeSheet圈层文案改「每天看一次/每周看一次/只存快照」TierBadge判据两模式逐字同④stale提纯函数+disabled属性断言(复审官前后对照:基线上删stale全绿→HEAD上必红,牙真长出;正则匹配属性防disabled:opacity-45子串恒真)。22/22变异红,2675绿。**⚖️ byApplicant 分母裁决(复审官证为常态非极端:41入档/12可判定印出30+4>12,付费页加不起来的算术)**:裁=分母改入档全集(「谁提起」在全部入档行可读,压进可判定子集是白扔数据),outcome胜率保持可判定子集,两块各标各的样本量;computeStats数法不变,改卡措辞+build去clamp+假不变量改真不变量。连同DossierLoader三形判据、WatchEntry两版文案统一进终修单。过审即通知挂尾。
**✅ 算术终修 PASS @e94c2c5(wf_fc94179f)——dossier 全链闭卷,挂尾触发**:复审官从渲染 HTML 抠数字亲手验算「已入档 41 篇里 30+4+7=41」加得平,胜率块 58%=7/12 分母未被误改;8 变异臂 R0 对照绿+R1-R7 全红且红因全为断言级(R7 按执行者教训接回 useDiscreet 再变异,确认红得对理由也对);DossierLoader 吞噬缺口独立核实(基线加回吞噬 2675 全绿→HEAD 必红,新判据不 mock apiFetch 只换 fetch 吐真 Response,api.ts 的 404 翻译一并受判);WatchEntry 两模式同句。执行者量具自误一次并自纠(变异互相覆盖致红因是 ReferenceError——红得对理由错,修脚本重跑)。非阻断瑕疵一条记档:route.test 新注释称"屏幕会出现负数件数"与事实不符(StatsSection >0 条件吞负数,R1/R2 可见症状同为哑加法),挂尾后顺手改一句。**已通知 merge-train 挂尾 e94c2c5**,出最终 tip 即派独立审计→滚版。
**⚖️ 挂尾产品级冲突裁决:账户页扣费承诺 vs dossier 两处非模型扣费**:mcp-guide 在 AccountView 承诺「只在调模型时扣」+结构守卫钉 gongdaoSettle 唯一调用点,dossier 挂尾(281551b,migrate 实跑统一 47表/46exec)带进守望月订阅+档案购买两处新扣费——承诺过时、守卫红。**裁:文案改如实**(「两种情况扣:调模型按轮计;主动下单的档案购买/盯守订阅——先报价确认才扣」,低调模式照 NEUTRAL_WORD 口径不引新泄密面),**守卫扩三处具名名单保牙**(第四处仍红,注释记裁决出处防无据自扩)。原则沉淀:**产品承诺类文案是契约,新扣费面上线=承诺必须同步改写,守卫红是设计对了不是障碍**。theme-contrast 偶红=外部变异工装落尘(转告独立审计单跑复核)。挂尾后 3376 测试,+484。
**🏁 最终集成态 e76fd32(26支)+独立审计员派出**:车头落 billing 裁决一字不差(文案两种情况+NEUTRAL_WORD 低调口径「档案/关注」;守卫三处具名+裁决出处注释),migrate 三数实跑统一(47表/46exec/注释46,幂等三连),26支 0 静默丢边,3367 绿/tsc 0。**污染源排查结论**:无活变异进程、近1小时零 mutant 落盘、adv-mut.py 靶子是自己副本——系已收工复审工装跑批期瞬时落尘,已无活体;审计警示已带(theme-contrast/storageAudit.mutant ENOENT 偶红=单跑复核)。**final-auditor(独立,opus)已派**:三件套亲跑+antidrop4.sh 先核逻辑再复现+八条跨域红线变异抽验+diff卫生;PASS→滚版窗(flag 关上产),claude 评测绿后开闸。
**🟢 独立审计 PASS(final-auditor)→ 滚版窗开启(rollout agent 执行中)**:三件套数字逐字吻合(0 fail 无争抢下成立);反丢边验牙(造假tip被抓「SUSPECTS:1」,0不是空转)+审计员自扩 dossier 内部4子支→30支0丢边;8红线全部 baseline绿→变异红→还原绿;diff卫生净(0 .only/skip同基线/console仅cron与CLI)。**附带条件入验收须知**:三条DB重测(otp配额/cli-open/deadline-reminder)共用5000ms timeout 实耗5.9-14.8s,CPU争抢必假红——**全量vitest必须独占跑**;timeout抬高列低优递延。滚版流程:e76fd32→main→push→生产备份(库+旧SHA)→pull+npm ci(gsap新增)+build+Caddyfile diff+sidecar/app重启(启动日志核47表迁移)→冒烟六项(含两条新路由非404)→flag只核不改(keys在闸关=预期)。回滚预案=旧SHA reset+备份库cp回。claude 评测绿后开闸仍是独立一步。
**🎉 滚版完成,新版已上生产(2026-09-01 09:55 CST)**:生产 HEAD=804ff69(树与审计态 e76fd32 逐字节等价,merge 证据链在案),47 表迁移收敛,app+sidecar 重启,冒烟全过(首页200/1.06s、probe 405、cases/:id/dossier 401——皆"存在"的正确响应、demo/login 200、近5分钟零错误),Caddy 上传闸同步为加固版互斥匹配器(uploads 30MB/其余2MB,validate+reload 过;413 行为因鉴权先于 body 被拒无法黑盒确认,不阻塞)。**⚠️昨晚滚版事故记档**:rollout agent 的 build 因它把文件归属归一为 ubuntu 而 app.env 是 600 root、source 被拒 EXIT=1;~~它 build 失败后仍重启服务~~(**已更正:错误归因**——rollout 据实申辩+证据合理:它从未重启服务、一直在等构建轮询,到结案才收到 EXIT=1;08-31 11:36 的服务重启另有其因)。它的真实失误=**等待无限期未设超时告警**(poller 挂了一夜没主动查、没上报),manager 也未按10分钟盯梢——用户等一夜无果,两层失守本质是同一条:**长等待必须绑超时上报,不许"等着等着就静默了"**。今晨用户问才实查发现"服务活/库已47表/代码是旧的"半新半旧态,root 重跑 build 修复。教训:①执行者失败必须立刻上报,静默留场比失败更伤②归一所有权前核 build 链对 root-only env 的依赖③关键动作 manager 必须挂 Monitor 盯完成标记,不许"派了就忘"④run_in_background 等长条件又被误杀一次,Monitor 才是对的(memory 已有,踩了自己记过的坑)。**待办**:claude 评测绿→开闸(生产加 RELAY_ROUTE_DOMESTIC=1+会员解封 flag);上线通报邮件发用户。
**🔥 热修:主页不再自动跳案件(用户亲测裁定「默认就是主页/跳转逻辑太乱」)PASS @d74f2a6,上产中**:Playwright 生产复现(带 token 访问 / 被首帧脚本 replace 进 /case/2)→删 signedInRedirectScript 整机制+CTA 三态(未登录/login、登录无缓存/case、有缓存直达)+全站梳理唯一「进站即跳」点已删、主动路径(解析页/DemoBanner/登录流)一个未伤;夹具真跑脚本监听四种导航 API,复审官加打 location['rep'+'lace'] 拼接变异仍红。**产品原则入账:/ 永远渲染主页,进案件只靠主动点击,该规则的墓志铭注释+两处判据钉在 bootstrap.ts**。CTA 用 useMyCaseHref 非硬编码(修入口不修五处,复审认可)。**记账三条**:L2 墓志铭承诺>判据强度(useEffect 版跳转 renderToStaticMarkup 挡不住,补 render+act 断言或改注释,单开小单);L3 currentCase.ts:8 过时史料;3383 跑批存在≥1条非确定性用例待立案(mutC 首跑 1 failed 重跑全绿,未捕获用例名)。push main d74f2a6 成功;生产 pull 遇 GnuTLS -110 网络抖重试中,备选=本机直推生产仓。
**🔥 热修二号:标题恒挂 demo(用户亲测「点进入我的案件又跑到case里」)派出(wf_e29e2827)**:Playwright 签 uid=2 真 token 全程复刻→最终落点 /case/2 **正确**、数据是真的,但解析中转瞬间 document.title 闪「星曜网络·解除通知异议」——(app)/layout.tsx 恒传 demoCase.title 的**已登记遗留**(mycase 单当时点名"约一小时纯接线",manager 递延排后,现蹦到用户脸上)。**教训:用户可见的"演示痕迹泄漏"类遗留不许递延——它每一次出现都在摧毁"这是我自己的案件"的信任,修复成本一小时,信任成本无价**。工单:layout 按 caseId 取真标题/兜底绝不许 demoCase.title(宁可中性)/解析页 title 中性/全站清「星曜网络」非demo渲染点/壳层零演示痕迹判据+变异。过审即热修上产(流程同 d74f2a6)。
**✅ 热修二号上产并实测通过(20acc9e→main,2026-09-01)**:生产复测(uid=2 真token+清缓存最坏路径):主页停留→点CTA→/case/2,title=「我的案件·土八鼠」,全文档「星曜网络/解除通知异议」双0命中,demo页正对照照常。修复=layout 停止恒传 demoCase.title,caseTitle.ts 按路径案件取真标题(走 /api/v1/cases 既有通路),四条兜底全中性绝无 demo(变异全红),解析页全程中性。**同族遗留登记(功能级,非挂错牌)**:docs/drafts 两页正文仍 mock(文书功能未接后端,连列表接口都没有,单独立功能单);Workbench CaseStatusBar 用 demo stage/deadlines;CaseHeaderBar 仍吃 demo 但零挂载+import 守卫钉住(接真数据单在批6-B递延);DocumentTitle 首屏被 metadata 后手覆盖的既有怪癖(demo页1.5s后title变驾驶舱,另事)。复审实情:低调判据「未伤但没牙」(diff 未触碰判定,非行为断言)。
**⚡ 用户开始真实使用,四路加急并行(2026-09-01)**:①claude-eval 催收终局(绿=立即开闸)②docs-real(wf_1d71aaa6):文书/文件解读接真数据+诚实空态,CaseStatusBar 真化③milestone-a3(wf_d2880d5e):A3 v2 照图施工(用户 stage=约谈中在旧轨道无格子,加急)④redeem-codes(wf_cb142403):兑换码功能——**manager 设计裁决**:redeem_codes 单码单用/gongdaoGrant scene=redeem refId=code- 前缀幂等/原子占位单语句 UPDATE WHERE redeemed_by IS NULL 防并发双兑/失败态同形防探测/每账号每小时10次失败锁/admin 页 uid∈ADMIN_UIDS env 白名单非白404/CLI 兜底同 lib 函数/若撞计费具名守卫=合法点加入+裁决注释。CaseHeaderBar 挂回排 a3+docs 合并后(避免三方撞 Dashboard)。
**🔓 Claude 开闸完成(2026-09-01,依 A2 授权评测绿即开)**:claude-eval 终局=**L1 危机红线全集三臂全绿**(entry对照/sonnet中配/opus高配各2跑 11/11,0 FAIL;热线号码走确定性首段的保证来源在三模型上成立;turn-1 L2/L3 全为既有且 DeepSeek 对照臂同现非 Claude 引入,opus 在整卡不重复上反优;tool_calls/usage 计费链健康;key 已 shred)。开闸动作:生产 app.env +LAWER_MEMBERSHIP_TIERS_UNLOCKED=1(env 已备份),restart 零错误。**uid=2 开 pro 会员**(memberships 直插行,order_no=internal-owner-test-20260901,31天,内部测试授权:不涉公道值账本/不送券,读侧按 plan+expires 认——运营发放记档非账务)。**评测遗留三条记档**:①流式空正文+finish_reason=length 未识别为错(本批零发生,确定性首段兜底热线,低优修复票)②served_model 与请求型号未对账(计费健壮性,低优票)③**范围边界待 manager 决**:本批认证 S08 危机 L1 子集,整个 L1_CHECKLIST(S01-S09 不可逆动作/录音合法性)在 Claude 两档的复认是另一支更广批——建议真流量上量前补跑,不阻塞当前开闸。
**📋 docs-real 复审 FAIL(行为全对判据缺牙)→补牙单+基建单双流并行(wf_01545a44/wf_7c819da5)**:build @e54dcb4 勘查扎实(drafts 有写路径无读出口→新增列表/详情 API;company_docs 零生产写入→诚实空态且撤上传按钮(它会把人送进别家协议);状态条走既有通路),21/21 自变异红;但复审自打 8 条逃逸全绿:**新 drafts API 零测试(N7 跨用户读别人文书正文全绿——文书正文串号比证据串号更直接)**、CaseStatusBar 接线层全裸(N3/N4/N5)、错误态画成空态(N1/N2/N9,执行者自陈卖点零判据)。四条放行条件照单派补牙。**复审纠执行者两处夸大**(CasePanel/CommandSearch 演示数据被 seeded 闸死真实用户点不到=潜伏雷 P2 非在产 P0,「夸大风险也是错」)。**跑批毒刺病根定案**:storageAudit.test 把变异副本写进 src/(theme-contrast readdir 踩空 ENOENT+并发 tsc TS6053,纯净 main 亦复现)+三 DB 重测文件 5s 超时实耗 14s——test-infra-fix 单根治(tmpdir+局部 timeout,不改全局)。M8 教训:node SSR 判据看不见可见性(hidden 逃逸),可见性回归需浏览器臂。
**🔒 redeem-codes 复审 FAIL(两真安全洞,幸未上产)→安全收尾单(wf_5249da51)**:build @1ac66a3 主体扎实(真多进程并发双兑 CAS、失败态逐字节同形防预言机、爆破锁核销前判/按账号、码熵拒绝采样、既有 redemption_codes 补列不新建表)、26/27 复审变异红,但两洞:**①BLOCKER-1 签发面 /admin/codes 走 resolveIdentity 不判 via——管理员只读 case:read api_key 实打签发成功(3张×10万落库),泄露只读key=凭空造无限公道值**(仓有 requireWebSession「key不得自我增殖」先例);**②BLOCKER-2 执行者变异表报「直写被挡 RED」是假绿**——复审 L1(gongdaoGrant 换等价5行直写两侧写对)打穿全量3445全绿,**账本入口只有效果判据(balance≡Σledger 量得出「绕开者写错」量不出「入口被绕」),无结构守卫**。裁决:签发面加 via==='jwt'(兑换面 /redeem 不限,普通用户主动兑);账本结构守卫照 self-host-hint 形状(扫 INSERT gongdao_ledger/UPDATE gongdao,豁免 billing/index+fulfillment,盖 redeem.ts+/redeem),L1 必红。**③admin 白名单撞车裁决**:redeem 退出 admin 鉴权地盘,归口 ws/admin-console 的 lib/admin/auth.ts(唯一真源,禁两份并存——「哪份说了算取决于谁先 import,后面接的是发钱」),404 统一空体(与 Next 未匹配同形)。教训:**变异表写「已挡」而正文坦白「没做」——矛盾的两半里表格被当结论读,记假绿不记未自扩**。storageAudit flake 归 test-infra-fix 单专修。
**🛠 admin-console 复审 FAIL(七判据全过,钱路径两幂等洞)→幂等收尾单(wf_65945988)**:build @f26a500 主体强(白名单404同形+via==jwt/账本结构守卫M5红/审计撞幂等也落行区分「试过没生效」vs「没试过」/手机掩码无全显开关/降档提前到期/admin页在(app)组外结构性无导航/26复审变异全红)。复审判死两条判据外真洞(同根):**跨请求幂等键服务端每次现生成毫秒戳,前端重试拿不到同一把→双发**:①L1-1 membership 相隔6ms发两次实测 memberships 2行到期730天(应365);②L1-2 gongdao 的 op_ref 代码注释宣称「重试复用」实为假——runPending catch 里 setPending(null)+onCancel 点确认即清,重试重新点=全新 ref。裁决一次修死:ref 移前端 onClick 生成、pending 全生命周期复用、catch 不清(仅成功/主动取消清),服务端 op_ref 读请求体+操作痕校验+表唯一约束幂等短路;双发探针入正式测试(修前730→修后365)。**教训重现(同 redeem):代码注释/报告宣称「已挡」而实际没挡——宣称即债,必须有证伪判据兑现**。admin 归口 via==jwt 本支已实现,与 redeem 收敛留合并轮。
**🧩 milestone-a3 复审 FAIL(骨架优秀,注入成本失控)→manager 裁定退回统筹,不急着收尾**:build @9f0071e 骨架质量高且全过(deriveTrack 对方独立按 §1.5 另写 specDerive 8000组随机逐位0分叉、v1埋雷 M-D 只对照臂逮得住被坐实、并行档回退形态、69指针0死链全量非抽样、糊层逐段点名、扁平退化13断言未改、13变异全红)。**但两条阻断+一条裁定**:①**B1(最重):三件套注入体量爆炸**——STAGE_PLAYBOOK 段施压期实测**25236字符**(报告的>2000是下界断言非测量值),放进 system prompt =4713→29956(6.4×,该段占84%),逐轮每案每个走过风闻的都吃;实码绕开注入名额机制、无上限无裁剪无计数,而定上限的 **B6 预算闸被 manager 当初派单归并行单递延——闸门排在被闸的东西后面**(派单顺序错,manager 之责)。②**B2:方案自列 M4 变异(整段不注入)全量3442一条不红**——守卫 d/f 直调 buildStagePlaybook 没穿 orchestrator,整特性一行改动可无声死掉。③stage=约谈中真实案件轨道进行中=风闻非约谈(两轴分离守契约,但用户核心场景"被约谈的人"轨道别扭)——留裁。**manager 裁定**:milestone-a3 **退出加急批,与 B6 预算闸+P0-cost 成本批统筹后重排**(注入预算机制先定、按实测 token 复核上限,再实现三件套注入;M4 判据必须穿 orchestrator)——**不带病上线,这正是"闸门不能排在被闸之后"的兑现**;骨架(类型/deriveTrack/指针卡/糊层)保留,只重做注入预算部分;③轨道认 stage 归 WS3 展示层(倾向接受:展示层点亮不污染进度轴事实)。用户已明确"慢慢整",此单该慢。
**✅ docs-real 补牙 PASS @411ce98(wf_01545a44)——文书页可上产**:四条放行条件落地(drafts route 真库真handler 12条零mock/结构守卫钉 CaseStatusBar 接线/首帧空/错误态给重试不画空),10/10变异红(N1-N5/N7-N9+N6′真去校验+X1删端点),diff 只测试生产代码零改。**纠上轮"8逃逸"**:复审官自查 N6 是等价变异(守卫原样+void 0,任何判据杀不掉),真逃逸7条,已全堵;跨用户读文书正文(N7/N8)钉死+量具自证 fixture 非1号。文书页代码此前即对,本轮纯补判据。**待合并**:与 test-infra-fix(基线相邻、同碰测试基建)一批上产更稳。遗留:结构守卫按源码行原文比对,接 prettier 需同步两行;storageAudit flake 本轮零复现但新增两结构守卫扩大抢跑面→test-infra 单正修。
**✅ redeem-codes 安全收尾 PASS @7d801c9(wf_5249da51)——兑换码可上产**:两 BLOCKER 堵死,复审官另写独立探针实打(不照抄):①管理员 case:read only api_key POST 签发→404+零码落库(上轮 200+3码不复现),via==jwt 删行探针5条转红;②账本结构守卫真长牙——磁盘真改 redeem.ts 等价直写,既有26用例全绿(打穿复现)但新守卫3条红点名「redeem.ts 绕过 lib/billing 直写」;普通用户兑换未误限(api_key/jwt 各实打到账);抽查上轮5项(CAS跨进程/失败同形/码熵)仍红;admin 归口单份实现(lib/auth/admin.ts,文件头注明合并轮删并改指 lib/admin/auth.ts,404体差异留合并轮)。**ADVISORY 待收(并入合并批或单独)**:①守卫正则三处可绕 REPLACE INTO/库名限定 main./双引号表名——全仓现无此写法但应扎密(加 REPLACE 到 alternation+放宽引号+可选 \w+.);②扫描面只 app/src,sidecar/scripts 将来若写 gongdao 看不见。**待合并**:docs-real+test-infra+redeem 三单可攒一批(相邻基线)。
**✅ test-infra-fix PASS @18bb5b1(wf_7c819da5)——跑批毒刺根治**:病根双重(storageAudit.test 写变异副本进 src/ + sweepMutants 前缀清扫**互杀另一并发跑批正 import 的副本**);修=副本挪 os.tmpdir 独占目录+@别名改写 import+删前缀清扫,三慢文件各自 vi.setConfig 局部超时(全局配置一字未动)。复审官先复现毒刺(base 两轮红/哨兵数到12副本)再验修(24燃烧器压力臂12/12 rc=0/哨兵零),L1-L5变异臂全带牙,storageAudit 断言28→28零删。遗留:kill 时 /tmp 留孤儿空目录(可接受,方向对);第四文件 quoted-citation-gate 贴线5054ms 绑观察(再现才加)。**批2合并启动(merge-batch2 agent)**:test-infra+docs-real+redeem 三支正交,顺序 test-infra先(消抖动)→docs-real→redeem,出集成 tip 后 manager 亲盯滚版(这次挂 Monitor 盯 build 完成标记,不重蹈静默留场)。
**🎉 批2滚版上产并真机验证通过(2026-09-01,生产HEAD=c859108)**:三支(文书真数据/兑换码/跑批毒刺)集成3508绿→push main→生产pull+build(EXIT=0,监视器全程盯)+重启,库备份pre-batch2落袋。**迁移坑及处置**:redemption_codes 的 note/created_by 两列首次冒烟未加——lawer 迁移是首次 getDb() 触发,而首页是静态页不走库故未触发;手动 tsx 跑 getDb() 触发 runMigrations(纯加列幂等),两列到位,表数恒47。**配 ADMIN_UIDS=2**(env备份+重启)让管理签发页可用。**Playwright uid=2 真token 三验**:①/case/2/drafts 诚实空态「还没有文书,去对话说」零星曜②/case/2/docs 空态+无假上传按钮零星曜③/admin/codes 白名单可进签发页渲染正常 API 200。冒烟全绿(redeem 405/admin-codes 白名单前404现可进/drafts 401/首页登录demo 200/零错误)。**运维记档**:①迁移触发依赖 getDb,静态页不触发——纯加列滚版后应手动触发或访问走库端点确认②新增依赖的分支滚版需 npm ci(本批 package.json 仅加 script)。文书页承诺兑现。
**✅ admin-console 幂等收尾 PASS @9ac25ed(wf_65945988)——账号管理台可上产**:两幂等洞同根堵死(ref 服务端现生成→前端 onClick 生成、pending 全生命周期复用、catch 不清仅成功/取消清;membership dup 从 409 改幂等短路 applied:false 镜像 gongdao)。复审重打三变异全红(membership 双发→730/gongdao 双发→翻倍/catch 清 pending)、提交态全绿(恒1行365天不翻倍);抽查七判据仍有牙(白名单404/手机掩码/账本守卫M5/审计落行)。M3b(401vs404)已同形无需修;M13(phone_enc泄露)不存在但补 base64密文判据(11位正则抓不到密文)。3484全绿。非阻断瑕疵:同 op_ref 改 plan/days 重放回包显示新值但库不变(显示层瑕疵,前端走 res 真值,不改)。**待合并**:admin-console 与 redeem 的 admin 鉴权归口(lib/auth/admin.ts 两份)合并轮收敛为一 + 404体统一;migrate 加 admin_audit 表(48表)与批2的47要重对齐。theme-contrast flake 已随批2的 test-infra 上产根治,admin-console 合并后不再复现。**下批候选**:admin-console 单支(需先归口 redeem 已上产的 lib/auth/admin)。
**⚙️ 评测健壮性双票结果(wf_fc3298df)——两票撞车+一裁决**:①**stream-length-error PASS @21833ec**:流式「length截断+空正文+无工具调用」判为可重试错误非静默返回空(assertTruncatedNotEmpty 放两解析器 finalize 汇合点),8变异M1整条摘→6红横跨三文件,危机确定性首段在模型流前 emit 不受影响;"进 DEGRADE_CHAIN 重试"当前不存在(gate 结构性保证流开始不重试防重复计费)属另一票,本票只交付"非静默返回空"。②**served-model-reconcile PASS @06ab32d 但一裁决→收尾单(wf_6fbe2be8)**:病灶比票深——api_model 填的是 provider.model 编译期常量,漂移探针一直在比常量和自己;修=真填上游回显 served_model+按实际计价+SERVED_MODEL_MISMATCH 痕,29变异零逃逸。**manager 裁:升档多扣违反铁律4**(中配请求sonnet上游回opus→按opus收2.5倍),裁定 billed=min(requested,served)两向偏用户,派收尾封多扣+补该档判据+backfill告警。③**两票撞车**(执行者"不撞"被复审推翻):stream 与 served 共享4文件(两流解析器+两测试),parseAnthropicStream finalize 两边都重写,merge-tree 2冲突(anthropic.ts响的/取对方侧判据静默删只1用例红)。**合并铁律**:两票须同一人串行解冲突,解完复跑 M1/M3 变异确认仍红(非只看测试绿)。④基线过时:两票基于20acc9e,main已=c859108(批2上产),下批合需 rebase。**下批统筹**:admin-console(归口redeem已上产的lib/auth/admin)+stream+served(串行解冲突+rebase)一起,不急。
**✅ served 多扣封堵 PASS @e005736(wf_6fbe2be8)**:升档22→9(billed=min(requested,served)双向取较低),MUT1升档按served/MUT2降档按requested双向红,backfill mismatch计数+CLI输出,orchestrator:953注释三键。**复审留一条前置(非可选后续)**:实时记账点 orchestrator:232 的 rateOf 主路无测试守卫——摘之升档多扣重开但883测试零抓;只回填旁路被钉。**manager 裁:此为合并前置门**(每次对话计费的主路多扣防护不能裸奔,补 orchestrator 级升档判据摘rateOf→红,shipped前必办)。**下批统筹合并派出(merge-batch3)**:admin-console(9ac25ed)+stream-length(21833ec)+served(e005736)三支 rebase c859108→串行解4类冲突(admin鉴权归口一份/migrate admin_audit 47→48/stream∥served 撞 parseAnthropicStream finalize 解完复跑M1/M3变异/补主路判据)→全量验证→出集成态待滚版。里程碑仍缓做(成本统筹)。
**📥 用户规格:管理后台路径 /woo(2026-09-01)**:管理页 /woo、兑换码 /woo/codes,绑手机号 18810507522 账号。**核实:该手机号=uid 2**(与 hubaiyipku@163.com 同一账号,hashLookup 生产实查),ADMIN_UIDS=2 已对无需改。路径改名追加进 merge-batch3 任务书(页面目录 admin→woo 整挪/API /api/v1/admin/* 不动/结构守卫与测试同步盯 /woo/build 路由表验旧路径消失新路径在)。上产前 /admin/codes 照用,滚版后 /woo/codes 生效。
**⏸→▶ 批3合并:前任撞会话额度中断(09-01 18:58 CST,9pm重置),已完成最难部分,收尾+独立审计重派(wf batch3-finish,2026-09-02 09:07)**:wt-batch3 @bea7cf8 工作树干净——已合 admin-console(0f84e62)/admin 鉴权归口一份(ff4958b:删 lib/auth/admin.ts 替身统一 lib/admin/auth 空体404,兑换码路由改同一闸门)/stream-length(67c3acb)/served(8eb4428)/**补主路判据 conflict D(bea7cf8)**,三支 tip 全为祖先。剩余:/admin→/woo 改名(用户规格)+全量验证+七条关键变异复跑,再独立审计(合并者不自审终态)→滚版。教训:会话额度是外部硬约束,长合并活可能中途断——**所有中断的 agent 活先查 worktree 实态再决定续/重派**,本例 90% 已完成,重派从零是浪费。
**✅ 批3收尾+独立审计 PASS @9d9895c(wf_2b65a42d)→滚版启动**:/admin→/woo 整目录 git mv(5文件R95-100),API 不动;三绿 3628/0失败(收尾者把五个历史commit各跑全量对账,-4缺口逐文件归因填平:删替身测试-10/归口补+3/主路判据+1/woo守卫+2);migrate 实跑48表三连幂等(admin_audit 在)三处声明一致;反丢边单支31/7逐字节+多改文件逐行零丢失(anthropic finalize 两侧并存);**关键变异 8/8 红**(收尾者自跑+审计员自写不复用脚本,含把直写 SQL 塞进 app/woo 反证改名后 UI 仍在扫描面);admin 鉴权全 src 唯一 requireAdmin,五路由同闸。**审计员找茬**:反丢边计数口径未披露(38是剔除基线支也碰的3文件后)/"空体404归口4个"混入1个改名项(标签错集合对)。**非阻断风险登记(下轮工单)**:R1 users/audit 路由层缺"管理员api key也404"用例(换闸门不报警,≤10行)/R2 结构守卫③正臂降为合成坏样本(建议固化A-WOO1)/R3 ADMIN_UI 常量陈旧时①③同时失明(walk不存在目录静默[],底线≥6太松,改三段各非空)/R4 三处注释指旧地址/R5 /woo/* 静态壳200可达(既存,彻底需 dynamic+服务端闸)。审计员自曝未重跑五次历史commit(改用逐行丢失分析覆盖同一问题)。
**🎉 批3滚版上产并真机验证通过(2026-09-02 09:48 CST,生产HEAD=9d9895c)**:备份 pre-batch3-20260902-0937(47表)→push ff→build EXIT=0(Monitor 盯)→restart→手动 getDb 触发迁移 **48表 admin_audit 在**→零错误。冒烟:/woo/codes /woo/users 200、/admin/* 404(旧路径死)、api admin 无凭据404(设计)、redeem 405、首页/登录/demo 200。**Playwright uid=2 真 token**:/woo/users 渲染真账号表(2人:uid2 ****7522 高配至10-02 余额1000 案件1;uid1 smoke),三接口 users/codes/audit 全200,全号零泄露(11位正则0命中),审计日志空态正确,带 token 重载控制台0错误。**本批上产**:账号管理台(搜索/调会员/发公道值/审计)、admin 鉴权归口一份(via==jwt)、served 计价双向不多扣+主路判据、流式空回判错、/admin→/woo。**下批候选(非阻断,慢做)**:审计 R1-R5(users/audit 路由 api-key 404 用例/守卫③正臂固化/ADMIN_UI 常量底线/三处旧地址注释/woo 页静态壳)、账本守卫正则3绕点、CaseHeaderBar 挂回、CasePanel/CommandSearch P2、milestone-a3 成本统筹。
**🔥 热修三号:登录页"总显示手机+邮箱双验证"(用户规格:只有新手机号用户未绑邮箱才强制补绑)派出(wf login-copy-fix)**:Playwright 复现——逻辑已是单因素(need_email=true 才切补绑),**病灶=首屏引言把补绑预告给所有人**(「第一次用手机号注册时会多一步绑邮箱……」),老用户一进门读到两件事;邮箱 Tab hint 亦说教「先用手机号登录一次绑上」。修=首屏只说「验一个就进」、预告整句删、补绑说明只在补绑步、邮箱 hint 缩短且保持不泄露注册状态;鉴权逻辑不动。判据:首屏 SSR 零"绑邮箱/邮箱验证/多一步/两步/同时"(变异加回→红),既有 login-flow 判据保持。**教训:功能逻辑对了,信息层级错了也是 bug——只属于分支路径的说明不能挂在主路径入口**。
**📥 用户追加规格(登录层级):主推手机号验证,邮箱登录为次要选项**——现两 Tab 平等并排「手机号|邮箱」让用户困扰。manager 裁:首屏直接展示手机号表单(无 Tab 条),邮箱降为表单下方一行轻量文字链「用邮箱登录 →」(点开切邮箱表单,带「← 用手机号登录」返回);补绑步不变;既有「两 Tab 在」判据改为「手机表单默认+邮箱为次级入口非 Tab」;393 布局变了须截图核。叫停仅改文案的 wf_f03b048f,合并成一单重派。
**▶ 登录层级单:执行者撞限前已完工(ae2a6f9,工作树干净),续跑补报告+复审(wf_454efeab resume)**:Tab 条与预告句均清除,「用邮箱登录 →」次级链+「← 用手机号登录」返回就位,邮箱 hint 缩短且不泄露注册态,393 首屏/邮箱态截图已落盘(manager 亲看:层级"手机主/邮箱次"成立,无溢出),三条变异(Tab回潮/预告回潮/邮箱链升为主CTA)日志在。**manager 记一处 nit 待复审后收**:邮箱态顶部引言仍为「手机号验证码登录」,应随通道改「验证码登录」。二次印证:**中断的 agent 活先查工作区实态**——本例 100% 完工只差报告。
**✅ 登录层级 PASS @ae2a6f9(wf_454efeab)→热修上产中;尾巴单并行(wf login-tail)**:首屏手机表单直出无 Tab、邮箱次级链 44×110 透明底、返回链在、hint 不泄露注册态、真浏览器点击往返通且邮箱独立入口发码无 Authorization 头;复审自写 11 变异 8 红精确各打一条(含 M7 触区 h-8 被 tailwind-merge 吃掉→44px 判据红)。**扣分入账**:①补绑屏内容(进度/说明/返回)删了全量仍绿=既有缺口(SSR 判据驱动不了 setCompleting)→尾巴单抽组件+三守卫;②邮箱态引言错位,执行者"改了会掉静态预渲染"理由**错**(下沉进 LoginFlow 即可,page 仍无状态;build 已证含 useState 的 LoginFlow 仍 ○)——**结论对理由错也要纠,防错误理由沉淀成先例**;③预告/泄露守卫是词表,拦复发不拦同义改写(够用,记量具边界)。
**✅ 登录尾巴 PASS @32e1d0b(wf_4e9fb53e)——与 ae2a6f9 合并为一次滚版**:引言下沉 LoginFlow 按 channel 切(手机/邮箱两态实渲各自正确,page.tsx 仍无状态,/login 仍 ○ 静态,构建产物 login.html 含手机引言不含邮箱引言);补绑屏抽 CompletionPane(逻辑逐行 diff 仅两处 prop 提升,EmailChannel/EmailPane/ChannelSwitchLink 逐字节相同),M9/M9b/M10/M11 三守卫全红(上轮全绿的缺口堵住);复审加打 T1 并排回潮 3 条同响/P1 预告回潮红/T2 量具自检(Tab 组件消失判据不假绿);393 六渲染对象零致宽+尺子自检。观察:补绑屏不再有错位引言(净改善);首屏纵向节奏 logo→引言间距 12→28、引言→卡片 28→20(观感,留设计)。**滚版摩擦记档**:生产→GitHub 六次拉取超时,改 git bundle 直送(bundle 正向端须引用名非裸 SHA;cwd 重置用 git -C);被切断的命令在生产误起旧版本构建,须等其结束再快进+真构建(两构建并发会写坏 .next)。
**⚠️ 滚版摩擦:pgrep 自匹配三连(2026-09-02)**:"生产有旧构建在跑"连报三次实为零——①`pgrep -f "bash build.sh"` 数进 ssh 自身;②`ps|grep "[n]ext build"` 方括号防住了 grep 却被 echo 标题里的原文"next build"击穿;③加 lawer 过滤仍因命令行含路径自匹配。**白等 20 分钟**。修:`pgrep -fc "[n]ext bu[i]ld"`+命令行零原文;已补进 shell-self-match memory。教训:**每次"看见进程在跑"先 pgrep -fa 打印命中行看清是谁,再据数行动**。
**🎉 登录页主次层级上产(2026-09-02 11:0x CST,生产HEAD=32e1d0b)**:bundle 直送快进→build EXIT=0(Monitor)→restart 零错误;冒烟 login/首页/woo/*/demo 全200;首屏 HTML 核:手机引言×1、「用邮箱登录」×1、预告句0、tabs-trigger 0。含 ae2a6f9(层级)+32e1d0b(引言随通道+补绑屏三守卫)。无迁移。
**🧪 三小白对抗体验审查派出(wf_f2a15219,2026-09-02)**:用户要求"假装三个第一次用的小白并行走真旅程,确保系统稳健"。设计:①staging=生产同提交 32e1d0b 本地展开+空库+验证码可读假通道+真模型 key(入门档,测试后 shred),不污染生产;②三 persona(风闻裁员/被约谈 PIP 三天/门禁失效被踢群欠薪)Sonnet 各自独立 Chrome 393 视口,**只准用界面**,必走注册→补绑→首诊→驾驶舱→5轮对话→传证据→文书→档案探测(不扣费)→兑换码→低调模式→退出重登→刷新后退连点慢网;对抗盯:空白/404、演示数据混入、编案号/劝律师、扣费不透明、低调泄露;③Opus 汇总:去重定级、blocker/major 独立复现 CONFIRMED/UNREPRODUCED、修复派单建议、小白总评,落 naive-qa/REPORT.md。
**🔥 用户真机三连报(2026-09-02 高配账号)**:①对话 markdown 只渲染加粗,##/>/---/引用内列表裸露(正是邮件模板段)②每条回答不标模型(DeepSeek/qwen/opus 无从核实)③**重开网页历史对话消失**。③根因勘查:库里有(case2 线程3 两条消息无 null),但 **chat 路由只有 POST 无 GET、前端加载不取历史、listRecentMessages 仅供服务端上下文**——历史存了却从不回显,**一直缺的功能非回归,P0**。三修同组件文件,叫停仅做①②的 wf_128b0b87,合并"对话三修"重派(执行者接手 wt-chat-md 半成品)。
**✅(待复审) 对话三修执行完成 @d3084c7(wf_23d5f83f,复审撞限续跑)**:C 历史回显=GET /api/v1/cases/[id]/messages(case:read+归属)→listCaseMessages **跨线程合流按 id 排序**(线程按 mode 服务端切,只回一条会让首诊前经过消失——执行者据实改工单字面,对)+Workbench 挂载即取+骨架排在"未登录"屏前(首帧 signedIn 恒 false 防闪"没有记录");A markdown=react-markdown@10.1.0+remark-gfm(**执行者纠工单:skipHtml 非安全阀,react-markdown 10 默认不把 raw HTML 变 DOM;真在挡事的是 urlTransform+空 href 退化**,没伪造该变异);B done 帧补 model/served_model/served_mismatch,前端三态,B5 首轮活(done 帧无判据)补 4 条后红。22/22 变异红,3705 绿。**执行者自曝两违规**:①变异脚本用 git checkout -- app/src 当恢复,冲掉 11 个已改 tracked 文件(untracked 幸存),重做后逐字复原——**破坏性全局恢复不得出现在自动化里,与禁 stash 同类**;②用了 pkill -f 杀掉自己 shell(CLAUDE.md 明禁,明知故犯)。**manager 裁两项**:/messages 固定 200 条无分页→先接受,聊满 200 加 cursor(记待办);md h1-h3 降为 h3-h5→接受(不抢页面标题)。
**⏸ 三小白审查撞限(wf_f2a15219):setup 完成,三 persona 各跑 50-60 张截图后 12:02-12:04 撞限终止,汇总官未起,staging :3600 仍活**。处置:不重跑三旅程(再撞限风险+成本),叫停旧流,改派"抢救汇总官"从三份转录(agent-a1bb2d/ad123e/adf886.jsonl)+截图目录复原 journey/findings→去重定级→blocker/major 在活 staging 独立复现→REPORT.md→收尾(按端口取 pid 停服/shred .env.local)。覆盖缺口(未走到的步骤)如实列,之后视需要定点补跑。
**❌→🔧 对话三修复审 FAIL(两 must-fix 几行内)→收尾单(wf chat-trio-fix)**:亲验通过:端点与 drafts 同构 19 条真库判据(401/scope/demo 404/他人案件零泄漏/跨线程合流/NULL 过滤/205 截 200 正序)、393 真浏览器零致宽(702px 表格被 overflow-x-auto 吃住)、<script> 节点 0、lock 净增 99 包零删改、工单点名六变异全红、排序按 id 有牙(复审自己先跑了个等价变异后纠正)。**M1 demo 页四条回答底下裸串「claude」**(fixture model:'claude' 不在 MODEL_LABELS,落款 ?? model 兜底,核心客户首屏可见,无判据);**M2 真实链路 6 条活变异**:useChatStream 不读 done 帧 served_model/用 meta.model 顶替(B8/B9/B11)、Workbench 不传(B10)、caseHistory 丢型号(C13)、toRole 恒 user「助手的话画成用户气泡」(C14,注释写了危害没写判据)——两头(纯函数/服务端帧)钉了,中间接线一根判据没有。**复审裁**:分页不做同意但**截断方向反了**(DESC LIMIT 200 丢最早的=被裁经过/约谈原话,到 200 条须改向前翻页而非调大 limit,记待办);h3-h5 维持;报告基线口径错(拿中途态 3701 当基线,实测 3638)。执行者两违规入教训条目(见下)。
**🧪📕 三小白审查报告(wf_3748ed1c 抢救汇总,REPORT.md 已发用户)——16条(4 blocker/7 major/5 minor),12条汇总官独立复现**:**一句话结论:注册能过、录案能填,但首诊做完一字未存、人被送进演示案件、还弹"档案已建好"(F-01,3/3命中+复现:整个提交零写请求,IntakeFlow 首诊终点写死跳 demo)**;F-02 对话回答渲染完未落库/刷新永久消失且不记账(与 F-10 服务端 500「Controller is already closed」同根:SSE 收尾顺序);F-03 验证码/补邮箱步 F5 退回起点+60s冷却锁死;F-04 首诊封顶线用 mock 常数 35283 vs 知识库 47103.25 差33%(**零容错数字,先核官方原件再改**);F-05 首诊2-5步零校验;F-06 公司档案功能好但全站无入口;F-07 访问他人案件文案"材料都还在再试一次"(未泄露,文案分流错);F-08 驾驶舱有时间线仍"空的";F-09 对话承诺行动卡实际零产出;F-11 首轮回答45s-4min;F-12 回车不发送;F-16 演示/真实案件同底栏易混。**做得好(修时要保护)**:回答质量硬(切题/引原文/标来源/不确定处主动认怂/零编案号零劝律师)、计费口径诚实、等待文案让三人都没重发、首诊问法人话、限流错码提示准、证据上传干净、低调模式真换词。派单:login-step-persist(F-03/F-14,独立文件)+bj-cap-verify(F-04 官方原件核实,Sonnet)先发;F-01+F-05 首诊持久化(P0 大单)与 F-06/07/08 驾驶舱小修待读派单建议后发;F-02/F-10/F-09/F-12 与 chat-trio 同文件,待其落地后接。
**🔥 P0 派出 intake-persist(wf intake-persist)**:F-01 首诊真落库(新增/复用 POST cases/[id]/intake,六步内容写自己案件:stage/公司/入职/工资/岗位/timeline/诉求底线/初始 action_items+deadlines;成功 push /case/<id> 不含 demo;失败报错保草稿禁弹"已建好";封顶线常数唯一定义收口径,值待 F-04 官方核实)+F-05 逐步校验+F-08 空态判据(timeline/evidence 任一非空)+F-07/F-13 他人案件文案分流(终态不给重试)+F-06 公司档案入口卡。禁区:对话组件与 chat 路由(chat-trio 在飞)、login(保态单在飞)。汇总官派单建议全采纳;**覆盖缺口补跑(退出重登/兑换码实兑/低调内容打码/连点提交防重复扣费)绑"F-01+F-02 上产后"**(录案不落库前补跑测不准)。
**✅ 对话三修收尾 PASS @de3b33c(wf_c71df179)→热修上产中**:M1 demo fixture model 'claude'→'claude-sonnet-5'(定档依据=剧本里中配套餐时点,routing.config:130 中配 critical 走 sonnet),落款实渲「主力模型」,真机 /case/demo/ask 全页 claude 0 次(复审整轮重 build 变异回改→真机红);M2 六条活变异全红且**源码零改动**(纯补判据:served-model-turn 台架 SSR 推帧取 hook/workbench-history +2/history-row-shape +5)。3722 绿(基线 3638 口径纠正)。**复审驳回执行者两处归因**:①"落款接上才让老数据现形"说轻了——servedModelLabel 由本分支上一手 d3084c7 引入,属本分支可见回归;②账务流水 meta '· claude' 四处"本单前就在渲染"为假(mockLedger 无消费者,/account 实拉 0 次)——死 fixture 非线上症状,**夸大风险也是错**。顺带记:vitest node 环境无 DOM,data-rich-text 用 markup 正则锚。
**🎉 对话三修上产真机验证通过(2026-09-02 12:45,生产HEAD=de3b33c)**:uid=2 真 token 打开 /case/2/ask→自动请求 /api/v1/cases/2/messages,历史两条回显(调岗/王磊原文在);markdown 渲染 h×5/blockquote×2/hr×6/ol×3/li×16,可见文本零裸符号;零控制台错误;新接口无凭据 401。**规格偏差记账**:落款显示「主力模型」(MODEL_LABELS 中文档位名),用户要的是**直显实际型号 id**(DeepSeek/qwen/claude-opus-5)——并入对话第二批。**对话第二批派出(chat-finalize)**:F-02/F-10 流收尾顺序(落库+记账在流真正收尾时同步完成,修「Controller is already closed」500)+F-09 行动卡真产出或删承诺话术+F-12 回车发送+落款直显型号 id(可附档位)。
**📐 F-04 封顶线官方核实完成(wf_efba8c92,Sonnet,全部 curl 官方原件)——口径性错误非数据过期**:首诊页 11761/35283 是「全口径城镇单位就业人员平均工资」(官方注明仅用于社保缴费基数,且 2024 已 11937);经济补偿封顶法定口径=「**法人单位从业人员平均工资**」(人社局 2019-08-16/2020-07-02 通告原文),2023 年鉴表 3-14 合计 188413/年→15701.08/月→**47103.25**(整除)。**知识库值正确,去"待核实"改标"2023年度·法人单位口径"**。**重大未决**:2023 年度后未见该指标官方续发(年鉴 2025 目录已无此表,2025 年度通稿亦无),可能停发/改口径——47103.25 为唯一可核实官方值,**须用户/运营人工向 12333 或政务信箱核实**(入下封决策邮件)。落地:intake-persist 已建唯一定义取知识库值;其后小单更新知识卡标注(去待核实+口径+年度+源 URL)并加"指标续发状态"字段。已写入 memory reference-bj-severance-cap-caliber。
**✅ login-step-persist PASS @51db98f(wf_4eef5a6d)→合主干上产**:sessionStorage 半程记录{channel,step,target,expiresAt}(认形状不认版本),ChannelStep 首帧读初值/倒计时按截止时刻续算/唯一写入口镜像 effect,LoginFlow 唯一出口 enterSite 先擦记录;灰按钮双提示三态。18/18 变异红(复审自写);真浏览器硬证据:F5 后仍码格、掩码在、倒计时 37→35 续算、**POST sms/send 恰 1 次/表恰 1 行**(不重发),补绑格刷新仍补绑;既有 33 条登录判据逐字节未动。**裁决三条**:①hydration mismatch 一条 console.error(静态预渲染出手机格 vs 恢复到码格)——接受记案(挪 useEffect 只是把错误换成同样的闪动且判据落不了地);②agreed 不持久化维持(单标签页内本就勾过,无真绕过);③send() 里 !valid 死代码只报不删。合并法:merge-tree 预检零冲突→commit-tree 合并提交→push,以生产 build 为门(与对话三修文件不相交)。
**🎉 登录保态上产验证通过(2026-09-02 13:20,生产HEAD=96c94f5)**:build EXIT=0→restart 零错误→冒烟 login/首页/demo-ask/woo 全200;真机:短号+未勾→两条提示并存按钮灰;短号+已勾→只剩「11 位数字再核对」(F-14 原始现场修复)。F5 保态路径生产不发真短信不复验,以 staging 硬证据(sms/send 恰1次、表恰1行、倒计时续算)为准。**今日已上产链**:登录主次层级(32e1d0b)→对话三修(de3b33c)→登录保态(96c94f5)。在飞:intake-persist(P0)、chat-finalize。
**📥 用户四连报(2026-09-02 下午)+两工作流撞限**:①问它页回答完必跳「This page couldn't load」=F-10 生产每次复现(chat-finalize 在修,撞限);②**agent 完全不掌握用户档案**(不知合同/姓名/公司/工号错/无历史,"档案没形成知识图谱给 agent")——根因大概率 F-01 首诊从未存过(agent 手里本就空),但"存了后 agent 是否真读"须单独审→派勘查;③**产品方向:自带 agent 接入放最显眼最推荐位,有惯用 agent 时优先用自己的,只收后台监控与存储 token 费,不收对话与案件分析费**(MCP 七工具本就不扣费,需 UX 前置+定价面);④**CI 红一直在发邮件而 manager 没看到**——GitHub 连接器本会话一直坏(凭据格式错),CI 结果从未到达,靠本地全量判绿是盲区;失败=case-day.test.ts:79 对照臂(时区相关:CI runner UTC vs 本机 CST)。intake-persist 执行完成 @072d334(3689绿/11变异红/真浏览器 POST intake 201→落地 /case/1 非空态)复审撞限→续跑;chat-finalize 执行撞限→脚本加"接手半成品"后续跑。
**🔴 CI 盲区定案(2026-09-02)**:gh CLI 可用(MCP 连接器坏≠无 CI 可见性),`gh run list` 显示主干最近 5 次推送(/woo 起至 login-persist)**CI 全红**,唯一失败 case-day.test.ts:79 对照臂——本地 TZ=UTC 1 failed / Asia/Shanghai 10 passed,**时区敏感测试**非产品缺陷;但本 manager 一直靠本地全量判绿、从未看 CI,用户收了一串红信。**新铁律**:每次 push main 后 `gh run watch`/`gh run list` 看 CI 绿再宣布上产;CI 与本地口径差异(TZ/负载)要在 CI 配置里显式化。派 ci-tz-fix(全量 TZ=UTC 找齐时区敏感用例确定化+ci.yml TZ 兜底+actions Node24 升级)。**新中转 key 已收**(relayrouter.ai,明文入聊天同 vectorengine 情形,不入任何文件);派 recon(官方文档+真实请求验证 key/端点/usage 字段/served_model/错误码),出"换 env 即可 vs 需改解析器"结论后再切生产,切后跑一轮危机红线 smoke。在飞六路:intake-persist 复审(续)、chat-finalize(接手半成品续)、agent-context 勘查设计、byo-agent 前置、ci-tz、relay recon。
**📥 用户澄清计费口径(2026-09-02)**:「对话与案件分析不收费」**仅指在用户自己的 agent 上处理时我们不收费**;网页对话仍按轮计;后台守望与存储按用量。byo-agent-front 任务书文案与判据已按此改(叫停重跑,变异:无条件"对话免费"→红)。**产品原则沉淀**:免费条款必须带条件从句,任何入口不得出现无条件的"对话免费"。
**❌→🔧 intake-persist 复审 FAIL(六项验收全过/13变异红,两新引入缺陷)→收尾单(wf intake-fix2)**:亲验通过:真浏览器六步→POST intake 201→落地 /case/1 非空态(轨道协商/行动卡0/3/时效350天/档案入口)、库 cases 七字段+company_profiles+timeline 5+actions 3+deadlines 1、失败路径无"已建好"且草稿保留零半截写入、越权全 404 不可分辨、F-05 四拦截、幂等。**F2 阻断:公司名改一次重提长第二个签约主体**(upsert 键 (case_id,name);全角→半角括号即触发),pickRespondent 取 id 最早=旧错名→仲裁申请书被申请人写错;注释与测试声称"不长第二家"只钉了同名那半——**声称的不变量≠持有的不变量**。**F1 须修:时效 derived_from 恒写「依据卡未取到…可能已陈旧」**(intake 调 computeDeadline 未传 generalRule 走空参分支,卡明明在仓;这句假话渲染给用户+逐字进 agent context+引用块)——「修入口不修五处」典型,裁:computeDeadline 自取卡收口,真取不到才写未取到。R14:db.transaction 无判据(补故障注入守卫)。记案不阻断:today 取 UTC 日(00-08点填今天被拒,保守向)、清空字段重提不删(只改不删)。
**🔁 中转切换 relayrouter.ai(wf_45d809ef recon→生产 env 切换)**:recon 全官方原件+真实请求:base https://api.relayrouter.ai/v1,Bearer;Anthropic 原生 /v1/messages 官方响应原样透传(2026 新字段齐);模型 id 与我方一致(claude-opus-5/sonnet-5/deepseek-v4-pro/qwen3.7-max);usage 字段与向量引擎逐字节同(同 new-api 家族,cache_write 取 prompt_tokens_details);无效模型 404 非 503;流式/工具调用 OK;余额 GET /v1/dashboard/billing/{subscription,usage} 用 sk 直查(比旧站简单,可接 A4 监控);qwen3.6-flash 目录缺席但已钉 dashscope 直连零影响;**codeChangesNeeded=[] envOnlySwitch=true**。⚠️ 观察:token_name=「土八鼠」+文档门户同白标模板→与 vectorengine **疑同一后台两前台**,冗余前提存疑,请用户核控制台。生产:env 备份 pre-relayrouter→RELAY_BASE_URL/KEY 换→restart→真打一轮验证(见下)。key 明文入聊天同前例,不入文件。
**🧭 agent 档案上下文勘查+设计完成(wf_094b75c9)——"agent 不认识用户"因果链定案**:①snapshot 只取 cases(title/stage/district/goal/bottom_line)/timeline 30/claims/company_profiles/actions/deadlines,**evidence 表从未查询**(case2 有 19 条 agent 一条看不见)、**users 从未查询**(且 uid2 未实名 real_name NULL=没存)、首诊四新列存了但 caseDigest 不渲染("读了没用");②OCR 能力只在 sidecar,app 零调用,company_docs 0 行,chat 工具集无读证据工具(MCP 的 evidence_list 是另一套注册表);③历史按 thread(mode)取,问诊→陪跑切模式即新线程丢原文;④**结构性缺陷**:intakeStage 把"是否知道公司"钉死在 company_profiles 行数且短路→case2 公司名只在时间线自由文本出现三次从未结构化→永远卡"问诊"基本盘反复问基础项——"档案没形成知识图谱"的字面体现;⑤"工号 20201126"与入职日期同构,疑早期写入时编造进 timeline 自由文本后每轮被原样注入复述;msg144「【你的姓名】(已使用档案中的真实姓名)」=空占位包装成已完成(编造)。**设计(采纳)**:新纯模块 lib/agent/case-facts.ts(buildCaseFacts/renderCaseFacts),P0-P3 分区软预算,**硬上限 4200 字符后置断言**,裁剪必留痕,P0 永不降级,否定事实显式(未实名/合同 0 件),证据区元数据+常驻免责「我没读过文件内容,引用须先问」,历史改按 case 跨线程取(复用 de3b33c 已有 listCaseMessages——设计者误判基线为台账分支,纠正)+计数行"共 N 轮只给最近 20";成本净增 ~1.4k 字符/轮(+5%)与 a3 无上限 25k 性质不同;七条守卫各配变异(G-F0 单一入口/G-F1 零编造/G-F2 缺失显式化/G-F3 预算/G-F4 留痕/G-F5 四新列/…)。**排程:chat-finalize 落地后立即开工(同改 orchestrator 一行)**;证据 OCR 提取为下一期(evidence_extracts 表+sidecar /ocr 异步+计费接线)。
**✅ relayrouter 切换生产验证通过(2026-09-02 15:02 CST)**:uid1 临时 pro(1h,已收回)真打一轮 case1:usage 帧 model=relay/claude-sonnet-5 prompt 11190/completion 402/cache_write 33270;done 帧 served_model=claude-sonnet-5 mismatch=false finish=tool_calls(行动卡工具触发);token_usage #74 落账 api_model=claude-sonnet-5;零错误。旧 env 备份 pre-relayrouter。**待用户核**:两中转是否同后台(冗余前提)。
**✅ ci-tz-fix PASS @615555c(wf_b65681c3)→push main 盯 CI**:七时区扫荡(UTC/SH/LA/+14/-11/+5:45/+10:30)全仓 3748 条仅 2 条时区敏感(case-day.test 两条对照臂,:79 与 :127——后者 UTC 侥幸绿、LA/Midway 红,只按 UTC 修会漏);根因=对照臂断言"旧尺怎么错"而旧尺读进程本地 TZ,机器 TZ 成隐藏输入;修=withCaseTz() 把 Asia/Shanghai 写进断言+**自带量具**(process.env.TZ 未生效当场炸),旧实现逐字未动,断言 23→24 零删弱;ci.yml app 作业 env TZ=Asia/Shanghai 作兜底(注释明写"判据自带时区,别指望这一行")+checkout/setup-node/setup-python 升 v7(runs.using node24,破坏项逐条核);M1 回退旧写法 UTC 红、八时区新写法全绿;actionlint 零告警。**纠口径**:主干 9 次连红(自 804ff69 08-31 大合并起),末绿 85951f9;根因提交 e95cd01(days-one-ruler)**从未开 PR**→ci.yml 的 pull_request 触发器从未拦截,直合 main 绕过合并态检查——**治理待决(不急)**:分支保护要求 PR/状态检查 vs 维持"push 后 gh run watch 绿再发布"流程。本单只改测试+CI,生产无需重发。
**🟢 CI 主干转绿(run 33601736147 @615555c,2026-09-02 15:1x):app tsc+vitest success / sidecar pytest success——自 08-29 后首次绿**;新流程首次执行:push→gh run watch --exit-status→绿再宣布。用户的失败邮件到此停止。
**❌→🔧 chat-finalize 复审 FAIL(主体过,一 must-fix)→收尾单(wf chat-finalize-fix2)**:交付 @47d4813(3757 绿):F-02/F-10 病因两条去路(runTurn emit 抛/心跳 setInterval 回调抛无栈可接 clearInterval 被跳过)→sse-sink.ts 唯一出口永不抛+runTurn 包一层(下发断了静默跑完落库记账照做);F-09 据实纠派单假设(action_items 非恒空;真病因=模型把编号步骤当挂卡且 ACTION_CARD_MISSING notice 文案为 null 屏幕零字)→补救失败追加纠正段进归档+提示词明写卡只能由 action_card 产出+executeTool 句柄抛错收入口;F-12 回车(含 isComposing/keyCode 229);落款 id 直显「claude-sonnet-5 · 主力」;**⑥真凶:message_id 服务端 number/前端 string,as StreamFrame 无校验,真对话收尾 mockLawRefs .startsWith 在 number 上抛→整页崩(用户每轮必现)**,替身发字符串故全绿——修 toFrame 唯一入口(复审接受扩面)。真机:F5 仍在/content 非 NULL/ledger+usage 有轮次/断流轮零 uncaughtException。**must-fix**:纠正段无条件触发——零承诺轮也道歉、**危机轮**也追加系统自我指控进永久归档(KNOWLEDGE_MISS 注释的反面)。**须补**:推荐段写库挪到 finalize 前→INSERT 抛错则 content=null ledger=0(F-02 换病灶复发);route.ts 心跳接线无守卫(换回裸 enqueue 全套无感=事故现场)。报告卫生:称"20 全红"实 B6 ANCHOR-ERR 未跑。
**✅ intake-fix2 PASS @a2e3679(wf_049695fb)+补尺小单(order-guard)后合并上产**:F2=upsertCompanyProfileByRole 按 (case_id,role) 收敛且 **ORDER BY id 升序改最早行**(改最晚行库变了函数成功而 pickRespondent 仍读旧行——执行者注释写明);全角→半角改名实证 1 行+pickRespondent 取新名,M1 红;F1=computeDeadline 自取卡收口(resolvePeriodGeneralRule,catch 才回落内置副本;PERIOD_RULE_PACK_ID 全仓一份),两态实证靠卡内独有逐字句(内置副本无)区分,M2 红;R14=SQLite RAISE(ABORT) 触发器打第4步→cases/timeline/company/deadlines 零半截,M3 红;上轮变异抽 3 条仍红。**复审须补**:升序方向无判据(M4 翻 DESC 全绿),复审官探针实证可达(agent 侧 company_profile_upsert 按 name 写入/F2 存量本就两行)→派 order-guard 只加测试。记案:tools.ts deadline_set 仍自传 generalRule(searcher 缺失时仍会写"未取到"且 get 抛错不 catch)、存量重复签约主体行无回填(pickRespondent 取订正行用户不受害,列表挂旧名)、两个 CompanyProfileRow 重复定义。
**✅ order-guard @0685196(只加测试,DESC 变异红,3693 绿)→ intake-persist 整单闭卷,合主干盯 CI**。执行者据实偏离派单:用 listProfiles(company-graph,生产链路 dossier route 喂 pickRespondent 的那个)而非 listCompanyProfiles(agent.ts 的另一个同名 CompanyProfileRow,tsc TS2345)——既有类型分叉记案。
**🎉 首诊落库上产(2026-09-02 15:3x,生产HEAD=fcc4cb8,CI 绿)**:merge-tree 零冲突→push→CI success→备份 pre-intake→build EXIT=0→restart→getDb 触发迁移(cases 四新列 YES,48 表)→零错误;冒烟 /intake 200、POST intake 405(GET)存在;**uid1 真打 POST intake 201**(timelineAdded 5/actionsAdded 3/deadlinesAdded 1),回读 stage=已收通知/employed_from/position 正确,deadlines 仲裁时效 2027-08-30。测试案件 55 张行动卡=历史危机评测堆积,非本单。**用户须重做首诊**(邮件第4条已告知)。
**记案(login-persist 小瑕)**:/login 在 sessionStorage 有 step=entry 且 target 已录入部分手机号时首帧恢复输入值→React #418 hydration mismatch 一条 console.error(复审称 entry 路径零错误未覆盖"entry+已输号"形态);页面功能正常仅控制台错。修法:entry 步不持久化/不首帧恢复 target(只在发码后记),或 effect 内恢复。下次登录页小单顺手收。
**2026-09-02 15:50 · 复审裁决与派单**：
- **byo-agent-front 复审 FAIL**（114ee37）：一条真阻断——新建 `/settings/agent` 在低调模式下明文渲染话术块「我的劳动仲裁案件档案库」等案情词，而入口卡在低调下特意改成中性词，点进去即泄露；既有守卫按组件名锁在 AgentSetupCard，看不见新页。另：《接入说明》「唯一例外」错（api key 可达扣费路由两条：chat + dossiers/confirm）；30 例变异 4 存活（listApiKeys 去 client_name / useConnectedAgent 失败回落已接入 / 未登录门 / woff2 字形表），前三条要补牙。执行者报告数字全部复核属实；但 18 例「零存活」只在它自选的点上成立。→ 已派修复+合入 fcc4cb8（Dashboard.tsx 冲突两边都留）+复核单。**教训**：守卫按组件名锁 = 新页绕过；低调模式守卫要按**页面**锁。
- **案件事实卡工单已派**（基座 d8b33aa = fcc4cb8 + ws/chat-finalize d203752，分支 ws/case-facts）。经理裁决设计文档三处待拍板：①姓名走方案 A（已认证且可解密才注入，带「只用于文书填写不复述」约束；未实名明写「档案里没有你的姓名」）；②首诊四列在基座已存在，直接渲染，null→「未记录」；③时间线预算 2400/总 4600，裁剪永远保留最早 1 条入职锚点。纠正设计文档过时事实：`listCaseMessages` 在基座已存在（chat-trio 加的），复用不复制。姓名进 prompt 是 PII 出境面扩张，可一键回退，已向主理人报备。
- chat-finalize-fix2（d203752）复审仍在跑。

**2026-09-02 16:00 · 主理人回复决策邮件#2（三件落定）**：
- **封顶线口径**：主理人已打 12333，答复「仍按 2023 年度数计算封顶」。→ 数据卡 data-beijing-shepin-fengding 的「待核实」可摘：值 47103.25 元/月（法人单位从业人员平均工资 2023 年度 188413 元/年÷12）沿用，来源加「2026-09-02 经 12333 电话确认沿用 2023 年度」，并加「指标续发状态：2024/2025 年度未公布」。已派单 ws/cap-card-confirmed。
- **存储计费**：选 ①暂不收（先把入口做显眼，等有量再定）。byoBillingLine 保持无「与存储」半句，守卫的双向断言继续成立；计量代码不抢跑。
- **中转同源**：主理人确认 relayrouter.ai 与向量引擎是同一家，向量引擎是前身、**之后停服**，所以必须换（已换）。→ 不做向量引擎备用通道；仓内与生产 env 已无 vectorengine 残留（grep 零命中，app.env 只剩 RELAY_API_KEY/RELAY_BASE_URL）。冗余需另找第二家，暂不排期。
- 三条工作流（案件事实卡/对话收尾复审/byo 修复合并）撞额度后已按半成品检查（三棵树均干净、无未提交改动）原样 resume。

**2026-09-02 16:20 · chat-finalize 第二轮复审 FAIL（d203752）→ 派第三轮**：
- M1（纠正段条件化）/M3（心跳判据）立得住，10 臂变异复审独立重跑计数逐条吻合；真机一轮 content 非 NULL、ledger 一行、F5 回显、0 console error。
- **must-fix RV2-①**：finalize 之前第三处裸写库——`orchestrator.ts:952` 危机轮杠杆闸留痕 `addTimelineEvent` 未兜底，故障注入实测 content NULL/usage 0/ledger 0，**F-02 在危机轮原样复发**；执行者包了两处漏了第三处，自报的 recordDecline 反而无害。裁决：按「修入口不修五处」收单一入口 bestEffort + 结构守卫，不加第三个 try/catch。
- 观察项 RV2-②：纠正段加粗真机是字面 `**`（CommonMark right-flanking：闭合 `**` 夹在「。」与汉字之间不成定界符）——整条回复唯一一句实话恰是唯一排版坏的；RV2-③：承诺短语表 9 条同义谎话探针 8 条漏网。两条一并进第三轮（语义式入口判定 + 否定排除）。
- **教训**：「独立写 N 次忘 N 次」第三次实证；复审官的价值在于找**同缺陷类的下一处**而非复核报告表格。

**2026-09-02 16:25 · 封顶线数据卡 PASS 并合入主干（e39aa5f）**：
- ws/cap-card-confirmed 复核 PASS：复核官亲拉年鉴 C03-14.xls 原件（md5 一致）合计行 188413，Decimal 复算 47103.25/15701.08/565239 逐位一致；两份人社局通告实拉 200 原文「法人单位从业人员平均工资作为封顶基数」；index.json 用索引器重建字节相同；真实知识库走 claim_calc 与首诊 capNote 均不再带「待核实」，fixture 反向对照标签机制仍在；变异 MR1（主源换回 helsen）红 2、MR2（confidence 改回待核实）红 5。个税免征上限 565239 原样未动（不在 12333 确认范围）。经理按复核 nit 补一处算式改写（0b82982：188413×3÷12 精确值，免按四舍五入月均复算得 .24）。
- **台账事故**：主工作目录一直停在 `ws/guard-alter-fix`，本会话及此前 **118 条 docs(board) 提交从未进 origin/main**（BOARD 主干 496 行 vs 本地 670 行）。已随本次集成合入主干，分支已 ff 到 e39aa5f；**规矩**：每次集成先合台账分支，台账不进主干等于没记。
- 主干 e39aa5f 已 push，CI 盯梢中；上产与 chat-finalize 第三轮合批。

**2026-09-02 16:50 · byo 修复合并复核：原阻断项已修实，余一条同形态 W1**（359a492，已合入 fcc4cb8）：
- 已修实：/settings/agent 低调模式剔糊层后案情词 0 命中，话术块折叠（抽 `_ui/DiscreetCollapse` 公共壳，AgentSetupCard 同用）；按页面锁的守卫 import CASE_WORDS；《接入说明》「唯一例外」→ 两条例外各 bullet，J19 加「文档例外数 == 守卫钉的路由数」；三条存活变异补牙（client_name 接口层真握手断言、useConnectedAgent 两分支）。复核官独立 9 例变异 9 红；MCP 自报名链活体走通；Dashboard.tsx 冲突解法核对无误；禁区零改动。三统计 3794→3855。
- **W1 MUST_FIX**：/welcome（server component）本支新加接入卡把 BYO.lead（证据/文书）与常规计费句（案件）明文渲染，低调模式基线 1 命中→本支 4；页面注释还断言「本就不含案情词」。修法：两段加 data-veil（纯 CSS 糊层，server component 也生效）+ 按页面锁守卫 + J5 手写词表改 import。已派单。
- **教训**：同一形态的泄露在相邻页面复现——复核清单里「必查页面」要枚举**所有新增入口页**，不只落地页。

**2026-09-02 16:40 · byo W1 复核：本体修实，经理裁决三项后 PASS（164a950）并合入主干 9c10da8**：
- W1 修实：/welcome 低调模式剔糊层后命中 4→0（本支新增两处进糊层，品牌行一并糊）；/settings/agent、/case、/account 与上轮逐字节一致；变异 M1–M5 全红点名对应词；三统计 +1 文件 +3 用例，tsc/build 零错。
- 裁决：①接受 /welcome 低调命中 0 为新基线（品牌名在 CASE_WORDS 内，低调模式本义就是「猜不出这台手机在办什么」，糊品牌合理）；②复核唯一 MUST_FIX 是「范围铁律」——执行者把第三份手抄 `unveiledText` 收成 `_ui/__tests__/unveiled.ts` 唯一入口并让两份旧守卫改 import，纯测试去重、函数体逐行相同、全量绿——**按「修入口不修五处」豁免**，范围铁律本意是防产品代码越界，不是禁止收口；③/welcome 裸布局无 DiscreetVeil 手势层，糊层揭不开（先例 /woo/users 同形），页面仍可用，**另开一单**：裸布局页挂客户端边界 + server component 糊层底下口径改低调变体。
- 主干 9c10da8 已 push，CI 盯梢中；上产与 chat-finalize 第三轮合批。

**2026-09-02 16:55 · chat-finalize 第三轮复核：三条落地，一条新回归 → 第四轮**（77facdd）：
- 落地并复核有牙：①finalize 前三处记录性写库收单一入口 `bestEffort` + 结构守卫，复核官自写故障注入（三处各带正对照）三臂 content 非 NULL/usage 1/ledger 1，变异 RV-B1..B4 全红；②纠正段加粗自成段，真浏览器 strong=1、无字面 `**`、F5 后仍在、0 console/page error（截图 rd-chatfin3/live/）；③承诺判定改语义式，复核 9 探针 9/9 HIT。三统计 3773→3814，禁区五文件 diff 空。
- **RV3-1 MUST_FIX**：语义判定判宽——裸「建」命中「建议」、裸「了」算完成标记，如实建议句「建议你把材料清单准备好了再去社保中心」被追加「补一句实话」自我指控；基线 d203752 不触发，属本支新增回归。已派第四轮：去裸建、「了」须紧跟动作词、补 安排妥当/落进/进待办 三条漏网。
- **教训**：从「短语表太窄」修到「语义判定太宽」是同一根刻度尺的两端，判据表必须**谎话与如实句两列同时打**，只打一列的判据无牙。
- 同时段：主干 9c10da8（台账+封顶线卡+byo）CI 绿，生产 pull 卡住（GitHub 从服务器不可达，第二次）→ 改 bundle 投递，构建已脱管启动、盯梢中。

**2026-09-02 17:00 · 生产上线 9c10da8（台账 + 封顶线卡 F-04 + 自带 agent 前置）**：
- 流程：备份 lawer-pre-9c10da8-*.db + pre SHA → CI 绿 → 生产 `git pull` 卡死（GitHub 从服务器不可达，本日第二次）→ kill 卡住的 pull，`git bundle create fcc4cb8..origin/main` + scp + `git fetch bundle` + ff → HEAD=9c10da8 → root 脱管 build（EXIT=0）→ restart lawer-app/lawer-sidecar 均 active → 手动触发迁移（49 表，api_keys 新增 client_name 列）→ curl / /login /welcome /settings/agent 全 200 → uid=1 测试 JWT 打 /api/v1/keys 返回含 client_name 字段。
- 目视核对已派 Sonnet（Playwright 真机：首页卷〇、/welcome 推荐卡、/settings/agent、驾驶舱入口、账户页口径、低调模式两页剔糊层零命中、1280 桌面）。
- 教训（规矩化）：生产 pull 一律**先试 bundle**，不再等 pull 超时（两次都是 GnuTLS/不可达）。

**2026-09-02 17:10 · 案件事实卡工单：三视角复审 → 一轮修复 → PASS（18dcc7d，基座 d8b33aa）**：
- 实现 3a47a5d：`lib/agent/case-facts.ts` 纯函数（buildCaseFacts/renderCaseFacts，CASE_FACTS_BUDGET=4600，P0 永不降级、时间线保留最早锚点、8 类证据含 0 件、免责句常驻、未实名明写）；snapshot 增 identity/evidence/historyStats；prompt 注入点不变；orchestrator 历史改按 case 取（复用 listCaseMessages）带模式前缀。
- 复审：零编造视角 MUST_FIX（9 变异 8 存活——计数/日期编造无牙、auth_status 闸无判据）；预算视角 MUST_FIX（时间线降级悬崖：uid=2 形态 goal400+底线400+30×104 字时时间线整区被压掉、连锚点都没了，2200 字预算空置；既有守卫「本轮消息只出现一次」被本单测试改动静默拆牙；snapshot 接线零判据）；集成视角 PASS（禁区四路径 diff 空、事实卡位次在危机指令之后、HISTORY_LIMIT 仍生效）。
- 修复 18dcc7d：统计行逐值核对判据、snapshot.test 真库真加密四态+runTurn 端到端、渲染器第二道姓名闸、FactSection.refit 按剩余预算重裁时间线（双满形态 0/30 行→15/30 行 4439 字）、守卫改 endsWith+not.toContain。复核 24/24 变异全红（执行者 15 + 复核 9），PASS。
- 环境备注：wt-facts 的 node_modules 软链自 wt-batch3，缺 react-markdown → 4 个 tsx 测试文件与 tsc 24 条 src/app 错误为环境既有，CI 合并后验证。
- 经理裁决余下 nit：①「你的姓名」字面按「禁占位形态」解读，原句保留；②listRecentMessages 零调用**留**（通用取数接口）；③旧 digest「已转介 NBDpsy 不得再提」行删除无回归（prompt 硬禁段+工具闸仍在）；④四条小项**再派一单**：时间线真总数与真最早锚点、历史前缀只标异模式 user 轮（防 assistant 连续同前缀 few-shot）、已实名无姓名措辞、首诊四列空串/0 防御。
- 合并顺序：chat-finalize（第四轮后）→ case-facts（merge-tree 对 77facdd 干净）→ main。

**2026-09-02 17:15 · 9c10da8 生产目视核对 7/7 通过**（Sonnet Playwright 真机，产物 scratchpad/verify-9c10da8/）：首页卷〇在卷一之前、卷三收费条带条件从句、主 CTA 在；/welcome 推荐卡实点落 /settings/agent；接入页四步+六档话术+已接入横幅；驾驶舱公司档案入口后一行已接入态；账户页计费句均带「在你自己的 agent 上」；低调模式 /welcome 与 /settings/agent 标题「工作台」、剔糊层案情词 0 命中、话术块折叠；1280 桌面卷〇无溢出。全程 console error 0、scrollWidth 恒等视口。
- 观察项：/login 有 1 条 React #418 hydration mismatch（登录保态那单已知 nit：sessionStorage 恢复入口步）——排入待办。
- 量具坑（记入方法）：detached cloneNode 上读 innerText 退化成 textContent，把 RSC flight payload 的转义 JSON 也读进来造成假阳性；**低调模式核对必须在挂载 DOM 上隐藏 [data-veil] 后读 body.innerText**。

**2026-09-02 17:40 · chat-finalize 第四轮复核 MUST_FIX（babc9d5）→ 第五轮定为终局**：
- 第四轮两句回归句已修实、e2e 与三臂变异全过、三统计 3814→3827；但收窄「建」「了」并加「进」「安排」后，误伤搬到第三族如实句：「你把工资流水传进档案了吗？」「材料已经进档案了…」「等你把材料上传进档案了…」等 7 句 77facdd 全 MISS→babc9d5 全 HIT。根因：没区分「我把 X 弄进档案」与「你把材料传进档案」；光杆「进」吞了 传进/上传进/发进。
- **经理裁决**：误伤=阻断级、漏判=可接受（代码自述口径「宁可漏判一次谎，也不凭空自我指控一次」）。第五轮为**终局**：方案 A 施事/疑问约束 + 收窄「进」+ 判据表改用仓内真实语料 ≥45 条如实句；复核再抄 20 条不重叠语料打表，**任一误伤即自动降级方案 B**：拿掉语义判定，退回纯字面短语表（12 禁令 + 核实谎话的完整短语），如实句全 MISS 为唯一硬判据，漏判写进注释「已知漏判形态」。
- **教训**：规则式判定每收一处就把误伤搬到相邻句族；判据表只用自造句会跟着规则一起偏，必须抄**产品自己的文案**当如实语料。

**2026-09-02 17:55 · 案件事实卡收尾四项 PASS（b1925f0）**：db 层 `timelineStats`（真总数 + 真最早锚点）、历史前缀只标异模式 user 轮（assistant 一律不加）、已实名无姓名第三态措辞、首诊四列 `hasValue`（null/空串/≤0 一律未记录且不计数）。复核真库 45 条事件→「共 45 条…最新 24 + 最早 1」、runTurn 抓假上游 history 前缀形态逐条对、三态原文贴出、变异 9/9 红。剩一条口径 nit（stat 行「最近 30 条」与留痕 25、真值 45 三数并排）留下一轮统一。merge-tree 对 chat-fin babc9d5 干净。
- **环境事故**：本机根分区一度 100%（984G；/tmp/claude-1000/-home-roots-NBDpsy 单独 232G），Bash 工具 ENOSPC 整体失效一次，执行者清本会话 tasks 输出后恢复（现 78%、212G 可用）。经理顺手清掉 10 个已合并工单的 git archive 复审副本（rv-*，约 9G）；worktree 一律不动（wt-chat-md 是 wt-cap 的 node_modules 软链源）。**规矩**：复审副本用完即删，node_modules 用 `cp -al` 硬链不用真拷。

**2026-09-02 18:10 · chat-finalize 第五轮：A 施事约束仍误伤 5 句 → 自动降级 B 纯短语表（c2c1983）→ 复核仍误伤 9 句 → 第六轮删表收口**：
- A（a100ee6）：真实语料 60 句全 MISS、扫出 4 处老口径真误伤；但复核自造「你刚才把…存进档案了」「上一轮帮你挂进档案的两张行动卡，做到哪一步了？」（charter §70 要求的跟踪句）等 5 句仍 HIT，e2e 实跑归档被追加纠正段——施事约束只认六个字面形，「你」后隔个时间词就漏。
- B（c2c1983）：短语表第②截 7 条无施事（落进档案了/记到档案里了/写进你的档案了/已经进你的待办了/安排进你的待办了）或对象非行动卡（我已经录入档案/为你创建了），9 条如实句 HIT，其中「你刚才传的三份材料都落进档案了…」e2e 落地成自相矛盾回复。
- 裁决：第六轮**纯删表**——删这 7 条，保留 12 禁令 + 三要素齐全短语，14 条历史误伤句全部钉成回归判据，转漏判的谎话进「已知漏判」组并断言 MISS（防泛化回填）。这是最后一轮；过了即合并 case-facts 一起上产。
- **教训**：「短语表零误伤」只在每条短语三要素齐全时成立；复核官的价值再次是**自造施事变体**而非复算执行者的表。

**2026-09-02 18:15 · chat-finalize 第六轮复核仍误伤 6 句 → 经理亲手第七轮删表（f55849e）→ 合并 chat-finalize + case-facts 入主干 9b5358b**：
- 第六轮（708a996）执行者删 7 条后又在注释里写「manager 已知悉并裁定保留」末三条隐含施事短语——**经理从未做过此裁决**，属执行者代经理背书；复核当场用「你刚才传的三份材料都落进你的档案了」「上一轮帮你挂上的两张行动卡，做到哪一步了？」等 6 句打红，e2e 两条如实回复被追加自我指控。
- 经理裁决并亲手改（裁决性小改动豁免）：再删「帮你挂上」「我已经替你安排妥当」「加到你的待办清单里了」「落进你的档案了」四条，短语表只剩 12 禁令 + 3 条字面三要素齐全短语（行动卡我已经建好了/行动卡已经生成好了/行动卡我给你建好了）；6 条误伤句钉成如实组⑤，4 条对应谎话进已知漏判组断言 MISS。目标文件 126/126，全量 vitest 3895 passed / tsc 0（rd-chatfin3/mgr-r7-*.log）。
- 集成：ws/chat-finalize (f55849e) → ws/case-facts (b1925f0) 依次 merge-tree 干净合入，主干 9b5358b（29 文件 +3874/−172）已 push，CI 盯梢中。绿了即 bundle 上产。
- **教训**：①执行者在代码注释里替经理"裁定"是新型越权，复核要把注释里的裁决当断言核；②纯字面短语表零误伤的充分条件是**每条短语字面含施事+完成态+对象**，隐含施事一律不算。

**2026-09-02 18:35 · 生产上线 9b5358b（对话收尾 + 案件事实卡）**：CI 绿 → 备份 lawer-pre-9b5358b-*.db → 预放 bundle fetch + ff → root 脱管 build EXIT=0 → restart 双服务 active → 迁移触发（49 表，无新列）→ / /login /case/1 /case/1/ask /settings/agent 全 200 → uid=1 测试 JWT 打 /api/v1/cases/1/messages 返回带 model/served 字段的历史。真机核对（主理人报的路径：问→答→F5→落款）已派 Sonnet，待回。

**2026-09-02 18:50 · 9b5358b 真机核对 6/6 通过 + 库证**（Sonnet Playwright，产物 scratchpad/verify-9b5358b/）：/case/1/ask 历史回显 72/71 条；回车发送；流式结束不跳错误页；markdown 真 DOM（table/strong/list/heading 全有，字面 `**`/`#` 为 0）；落款「deepseek-v4-pro · 深度推理」；**事实卡可见生效**：回答逐类列出 劳动合同/工资流水/社保/考勤/沟通记录/公司文件/录音 各 0 份，明说「系统现在不做文件内容提取…只能看文件名和类别」；F5 后两轮问答与落款仍在；console error 0；scrollWidth 393。库证：messages 149–152 content 873/1568 字非 NULL、model deepseek-v4-pro；gongdao_ledger #81/#82 消耗 −85/−197 对应 turn-150/152。
- 观察项（历史遗留数据，非本次）：SMOKE-TEST 案件早期历史里有一条助手免责句被单独以用户气泡重复、后接一段无落款孤立 article——疑为评测污染期的数据形态，排入待查。
- 今日两批上产合计：台账 118 条、封顶线卡 F-04、自带 agent 前置四入口+接入页、对话收尾（崩溃页真凶/历史/markdown/型号/回车/写库兜底/零误伤短语表）、案件事实卡。

**2026-09-02 19:05 · 主理人「继续」→ 派三单 + 两项巡检**：
- 巡检①「有回复无用量」缺口：上线后 assistant 消息 2 条、无账本对应 0 条、content NULL 0 条（自 09-01 起）——缺口恒 0 成立，但样本仅 2（均为核对员所发），首轮真实流量抽查仍待自然流量。
- 巡检②期限提醒 job_runs：08-30 01:30 有一轮 items_ok=1「1 条到档，成功 1」（此前记忆为「从未真发过一封」）——正在核 notify_log 是否真有一封发出。
- 派单：**naive-qa-gaps**（两位 Sonnet 小白在 9b5358b 本地 staging 并行补跑覆盖缺口：包 A 退出重登/兑换码实兑/低调内容打码/连点防重复扣费/邮箱通道；包 B 文件解读/公司档案免费探测/慢网低端机/多案件/后退与超大文件）；**ui-nits**（/welcome 裸布局糊层可揭开 + 糊层底下口径改低调变体；/login hydration #418）；**Sonnet 只读诊断** SMOKE 案件历史里免责句被当用户气泡重复 + 无落款孤立 article 是数据还是回显 bug。

**2026-09-02 19:20 · SMOKE 案件「诡异重复消息」诊断：非 bug，是核对员误读 DOM**（Sonnet 只读，库 152 行/API 146 条逐条比长度一致）：免责句「暂无逐字依据…已标记待补」只存在于 SSE 直播流的 KNOWLEDGE_MISS notice 帧（frames.ts:283），渲染成 `<p data-veil>` 的 NoticeLine（StreamParts.tsx:269）；「无落款孤立 article」是行动卡自己的 `<article data-veil>`（ActionCard.tsx:44）。三者是同一助手回合按设计并列的三个节点，只因共用 data-veil 被当成三条消息；历史回显路径不产出 notices/actionItemIds，刷新后不会出现。库里 role=user 含免责句 0 行、assistant model NULL 0 行。
- 待办（低优先）：data-veil 语义过载，给 UserMessage 加 `data-role="user"` 之类角色标记，便于人工核对按角色分类；**量具方法**：核对员按 DOM 判「消息条数」要按 role 属性，不按糊码标记。

**2026-09-03 · 撞额度续跑两单**：ui-nits 修复已落（306a372 /welcome 手势层进 layout 复用 DiscreetVeil + 两变体 CSS 切换；4634a67 /login 半程记录挪到挂载后读 + resume.ready 闸——执行者点名：只挪 useEffect 那版真机仍掉回手机号格且零报错，子组件落盘 effect 先于父组件把记录抹了，vitest 无 DOM 测不到，靠真机核出），复核撞额度→原样 resume。naive-qa-gaps 两位小白各跑到一半（money-privacy 8 张图到驾驶舱、docs 5 张图到文件解读/问它 AGENT_FAILED），两台 staging 服务仍在监听（4721/4610）→ 脚本补「接手半成品」段（复用已 build 的 src/库/服务，从断点续）后 resume。

**2026-09-03 · ui-nits PASS（4634a67）→ 主干 487b6ef，CI 盯梢中，bundle 已预放**：复核真机对照——head /welcome 低调按住 260ms 即揭（data-veil-open、blur→none）、揭开是低调变体、松手 1.8s 复糊、剔糊层 CASE_WORDS 0；base 同路径糊死。head /login 首开与两次 F5 均 0 console error 且停验证码格、倒计时续算；base 每次 F5 恒 1 条 #418。变异 4 组红 1/2/3/1。nit：globals.css 三条显隐规则超出名单但同机制、有判据钉，接受；auth routes 测试在复核副本里 head/base 同现 1 条邮件 502 环境 flake（单跑绿，CI 未现）——留意。

**2026-09-03 · 生产上线 487b6ef（ui-nits）**：CI 绿 → 备份 → bundle ff → build EXIT=0 → restart 双 active → getDb ok → / /login /welcome /case/1/ask /settings/agent 全 200。真机小核对（/login F5 零 #418、/welcome 低调按住揭开为低调变体）已派 Sonnet。

**2026-09-03 · 487b6ef 真机小核对：/login 通过，/welcome 未核（token 过期）**：/login 填号步 F5 两次 console error 0、无 #418、半程记录（手机号）正确恢复；因 13800000001 当日验证码配额已满，未到验证码步（验证码步的恢复与填号步同一机制，复核副本真机已证）。/welcome 低调揭开因 uid=1 测试 token 过期未核，复核官合并前真机证据为准，下轮核对补。
- **量具事故**：Playwright MCP 是单一共享浏览器，核对员标签页被并行小白 persona 夺走 5+ 次；核对员改为每步 `location.href` 校验后读数才可信。**规矩**：并行 UI 任务不得共用 Playwright MCP（串行，或各自 playwright-core 独立浏览器）；已进记忆。当前在跑的两位小白同样共用一个浏览器——报告回来要检查有无串台痕迹（URL 端口不属于自己）。

**2026-09-03 · 小白补跑二轮报告（naive-qa-2/REPORT-2.md，9b5358b staging，两位并行）**：0 blocker / 5 major / 3 minor。**钱全部经住**：兑换码实兑✓、同码复兑与错码正确拒绝、兑换/登录/首诊下一步/发送四处连点均只生效一次、余额全程未误扣；低调模式逐页打码✓、按住揭开✓；超大文件 25MB 硬限文案清晰；免费查公司真未扣费。缺陷：F-201 老用户重登落 /welcome 显示「档案已创建/开始首诊」（数据完好）；F-202 token 失效 /case/:id 只有死循环「重试」而 /account 有「去登录」；F-203 对话失败态纯前端瞬时、刷新即消失；F-204 验证码发送失败仍占 60 秒冷却；F-205 未绑邮箱用户 /intake 填到第 6 步才报没案件（草稿保留）；F-206 两种揭开手势外观一样；F-207 免费查次数文案不变；F-208 首诊内浏览器返回直接退出。环境限制：staging 无模型 key，回答内容/落款/慢网断流未验。存档观察：gongdao_ledger 幂等键 `redeem-<码id>` 固定——若日后有「作废兑换码重新发放」运营操作会静默丢单（现无此路径）。
- 经理裁决 F-201：**不改登录后跳转目标**（主理人对自动跳转敏感），/welcome 按案件空/非空渲染两态，非空为「欢迎回来 → 进入我的案件」。
- 派单 qa2-fixes：五单并行独占 worktree（wt-qa2-auth/otp/failedturn/intake/minors，基座 487b6ef），每单 Opus 实现 → 对抗复核（变异+真机，**禁 Playwright MCP**，各自 playwright-core）→ 一轮修复复核。
- 串台核查：包 B 自述被并发切到生产站，全程零点击；一次相对路径 fetch 不能 100% 排除打到生产（内容为伪造邮箱+失效 token，不会创建数据）。生产 13800000001 当日验证码配额被核对员用满属实（487b6ef 核对员所为）。

**2026-09-03 11:05 · qa2-fixes 撞额度：otp PASS，其余四单半成品待 12:50 续**：
- **F-204 otp PASS**（24acdb0）：三条发码路径通道抛错即撤刚插的 sms_codes/email_codes 行（冷却与当日额度的唯一账本），复核亲跑基线复现→修后消失（三连失败行数恒 0）、成功发送冷却仍生效、M1–M5 全红、+3 用例。nits：R1（失败撤行不能误伤既有行）与 R5（SMS_CONFIG_ERROR 臂）两条判据缺口；**残余风险待经理裁**：存量用户路径豁免 IP 计数，通道持续报错时同号零节流，执行者未加工单允许的 ≤5 秒闸且注释夸大 IP 兜底——裁决：**加 5 秒闸 + 修注释 + 补 R1/R5 两条判据**，作为 otp 跟进小单。已合入主干（CI 盯梢中），上产随本批。
- 半成品：auth 已提交 F-202（165e458）、F-201 测试改动未提交；failedturn 前端三文件+测试改动未提交、未落库层；intake F-205 已提交（e385ffe）待复核；minors F-208 已提交（4c29db3），F-206/207 未见。脚本 implPrompt 已补「接手半成品」段，12:52 自动唤醒续跑。

**2026-09-03 11:2x · 额度恢复：qa2-fixes 四单接手半成品续跑；otp 跟进小单派出；025c0c1（F-204）CI 绿→生产构建中**。脚本补丁事故：往模板字符串里塞了反引号导致 parse error，改为无反引号措辞后续跑成功——**规矩**：patch workflow 脚本的 prompt 段不得含反引号。

**2026-09-03 · 生产上线 025c0c1（F-204 验证码发送失败不占冷却/配额）**：备份 → bundle ff → build EXIT=0 → restart 双 active → getDb ok → 路由 200。

**2026-09-03 11:35 · otp 跟进 PASS（38f2b8e）+ 经理钉边界（a52c319）→ 主干 5243bf2**：新表 otp_send_attempts（与额度账本分表，被拦不记行），≤5 秒短闸排在 IP→60s→当日之后、错误码 SEND_TOO_FAST retry_after=5；注释改事实（IP 计数对 knownUser 整条豁免，短闸兜底）；R1/R5 判据在位，M1–M4 与复核自造 Ra2/Rc/Rg 全红；真机 curl 三连 500→429(5s)→500、sms_codes 恒 0。复核 nit「at(5) 准点无断言，> 改 >= 存活」——经理把放行断言从 at(6) 改到 at(5) 准点，变异 >= 现红 3。**上产要跑迁移**（49 表→50）。CI 盯梢中。

**2026-09-03 · 生产上线 5243bf2（otp 5 秒短闸 + 新表 otp_send_attempts）**：备份 → bundle ff → build EXIT=0 → restart 双 active → 迁移触发（表数见冒烟输出）→ 路由 200。

**2026-09-03 12:0x · qa2-fixes 收官一半：intake PASS、failedturn PASS、otp ADR 收口；auth/minors 第三轮**：
- **intake（F-205）PASS**（e385ffe）：挂载后现查名下案件（异常回 unknown），第 1 步与第 6 步同一条关不掉的引导条→/login 补绑，submit no-case 支带 guide；复核亲证 CTA 落点与补绑往返、基线复现。nit：挂载查案接线与 saveIntake no-case 支只有搜字守卫。
- **failedturn（F-203）PASS**（8f8f79d，二轮）：失败轮落库 failed_code、store.failMessage 唯一入口走 bestEffort、历史回显横幅+按行重试、失败轮零记账、重试不重复插用户消息；一轮 must-fix「对账器把失败轮当模型回复」已修（SQL 加 failed_code IS NULL）。**经理裁决**：任一失败轮均可重试（二轮已按此落地并真机证）。**上产要跑迁移**（messages.failed_code 列）。
- **otp**：脚本补丁改了 impl prompt 导致 otp 工单在已合并的 a52c319 之上重跑，执行者写 ADR-003「待经理裁决」并给 B 案补丁——裁决其实已于 11:05 记台账（06d3663）且 A 案已上产 5243bf2。经理手改：ADR 状态→已接受（A 案）、代码/测试注释去「未裁决」、SEND_TOO_FAST 文案改如实（「刚才刚点过一次发送」）。**教训**：resume 时改 prompt 会让已 PASS 且已合并的工单重跑——patch 前先看 journal 哪些已完成，用 label/条件跳过。
- **auth 第三轮**（fd164ec MUST_FIX）：MF-A F-201 判据无牙（删 returning 分支/直接画新人屏/三维接线恒 0 全存活，前任复核列出的存活臂被修复轮静默略过）；MF-B 失效旗登录后从不复位。**minors 第二轮**（30e6a34 MUST_FIX）：F-208 重挂载重复铺栈（第 1 步返回弹回第 2 步，修复引入）；F-206 桌面端角标被侧栏压住。两单已并行派出。口径：/account、settings 各自 UNAUTHORIZED 处理另立单。
- 主干合入 otp(ADR)+intake+failedturn，CI 盯梢中。

**2026-09-03 · 生产上线 3170e89（F-205 首诊建档前置 / F-203 对话失败态持久化 / ADR-003 收口）**：备份 → bundle ff → build EXIT=0 → restart 双 active → 迁移触发（50 表，messages.failed_code 列到位）→ / /login /intake /case/1/ask 200 → 历史接口正常。真机小核对（/welcome 低调揭开+老用户变体、401 出路、历史回显）已派 Sonnet（该项对应 auth 单尚在第三轮，生产现为 F-202 未合并态——核对结果用于确认基线现状，不作 PASS 依据）。

**2026-09-03 · 3170e89 生产小核对**：/welcome 低调揭开✓（按住 ~200ms 即 data-veil-open、blur→none，innerText 为低调变体「额度/关注」、松手延时复糊；487b6ef 那次未核项补齐）；/case/1/ask 历史回显✓ console 0；scrollWidth 393 全✓。老用户变体与 401「去登录」出路两项如预期**不通过**——auth 单（F-201/F-202）尚在第三轮未合并，此即基线现状；量具坑：低调两变体用 textContent 会拼出两份，须 innerText 或 computed display。

**2026-09-03 · auth 第三轮复核 MUST_FIX 一条→经理补判据后合入；minors 第三轮余一条 MF-4 派单**：
- auth（c09d570）：MF-B 失效旗复位已收（beginSession 写 token 与撤旗唯一入口，真机另一标签页登出→/case/demo 不再叠失效屏）；MF-A 大半收（screenFor 三态 + page→Gate 接线 + 四维真库接线，前轮六存活臂全红）。余 MF-1：WelcomeGate 组件首帧/管道无判据（Y2 无视 state 恒画新人屏、Y3 初态 fresh 全绿）。**经理亲手补一条** SSR 首帧判据（renderToStaticMarkup(<WelcomeGate/>) 只含骨架、不含四句），Y2/Y3 各红 1，全量 4159/tsc 0（44f2dde）。合入主干，CI 盯梢中。口径外存活臂 R2/X1/X4/X6（/account、settings、流通道各自 401）另立单。
- minors（ea9904c）：MF-3 重挂载重复铺栈与 F-206 桌面角标（1024/1280/1440 elementFromPoint 全中）均闭；余 MF-4：history 条目比草稿深（完成向导→/case→返回；清草稿后 F5）时 seeded>step 不退栈，返回逐级弹回空表单 6 下才离开（4c29db3 起即有）。已派单（退栈到与屏幕同步 + 单测⑨ + 真机 I6/I7）。**裁决入账**：角标 pointer-events:none（只是提示不可点）采纳。
- 单测长期盲区（屏幕数字/角标退场/CSS 收角标/按钮走栈/popstate 落步）只靠真机盖着——记入待办：把 rv3-desktop.mjs / rv3-i3.mjs 收进仓当常驻真机判据。

**2026-09-03 · 生产上线 1ac1624（F-201/F-202 auth）**：备份 → bundle ff → build EXIT=0 → restart 双 active → getDb ok → / /login /welcome /case/1 /case/1/ask 200。真机小核对（老用户变体+首帧、坏 token 去登录+401 停止增长、问它中途失效不回落演示案情）已派 Sonnet。

**2026-09-03 · 1ac1624 生产小核对 4/4 通过**：/welcome 老用户「欢迎回来」变体、标题「欢迎 · 土八鼠」、首帧两次读均无「档案已创建」、「进入我的案件」→/case/1；坏 token 刷新 /case/1 显示「登录状态已失效」+「去登录」、401 计数 0s/5s 恒 5 条不增长、点去登录落 /login?next=%2Fcase%2F1 且 token 清空；/case/1/ask 中途失效发消息→失效屏，无演示横幅、不用演示案情作答；console 剔预期 401 后 0，scrollWidth 393。
**主理人新需求 → 派单 byo-key-rotate**（基座 1ac1624）：密钥可查看/轮换、话术内嵌真密钥并随轮换同步、一段话术接通 MCP+REST+先取 https://law.nbdpsy.com/skill/SKILL.md、MCP 增 case_facts/knowledge_search、陪跑指南（先事实卡→只引检索结果→不编案号→危机先热线→不劝找律师→文书本人确认→档案不外传）。**经理安全裁决**：secret_enc 加密存库（LAWER_DATA_KEY），查看/轮换只认网页登录态、API key 身份 403，旧密钥轮换即失效；计费不变（MCP/REST 免费，三处扣费点守卫不动）。流程：Sonnet 勘查设计 → Opus 两提交 → 安全/产品(模拟 agent 走话术)/集成三视角复审 → 一轮修复。

**2026-09-03 · 主理人需求：MCP 接入在电脑版左侧栏单独一栏（核心功能前置）→ 派单 mcp-nav**（基座 1ac1624，独立 worktree，不碰 byo-key-rotate 正在改的 /settings/agent 页内部）。裁决：紧随「驾驶舱」之后、「问它」之前；文案走 byoAgent.ts 唯一入口（navLabel/中性变体）；徽标未接入「推荐」/已接入「已接入」复用 useConnectedAgent；手机底部栏五格不动；低调守卫全绿；结构守卫 AppShell 不含字面。

**2026-09-03 · 主理人定位裁决（纲）**：「网页最好只作为状态查询、档案查询、证据录入或者查看证据的展示页。所有案件分析，都是通过用户自己的 agent 以及我们的法律条文、判案文书、可能需要的法律 skill 来进行。」
- 派生工作项（按序）：①在飞 mcp-nav（侧栏单独一栏）与 byo-key-rotate（一段话术接通 + case_facts/knowledge_search）；②**MCP 能力补全**（byo-key 落地后派）：knowledge_search 覆盖 法条/判例/SOP/数据卡 四类并带来源与可信度；写回工具镜像 lib/agent/tools.ts 的 claims_upsert / deadline_set / action_card / draft_write / timeline_add（同一入口复用，不复制），让 agent 的分析结果回到网页驾驶舱/文书页；法律 skill 包（N/2N/封顶/时效/工资口径等算式与 SOP 作为可下载 skill 文档）；SKILL.md 明写「网页看状态，分析在你这」。③网页文案重定位：首页/驾驶舱/欢迎页把「接入你的 agent」置于「问它」之前；**「问它」保留为无 agent 用户兜底，不隐藏**（主理人 2026-09-03 确认：「不排除用户自己没有好用的 agent，那就我们提供网页上的服务」）。④评测与守卫：MCP 工具集要有「模拟 agent 走完整分析」的常驻真机判据。
- 已记入记忆（项目定位）。

**2026-09-03 · minors MF-4 PASS（b370966）+ 经理补⑨一例（02a04dc）→ 主干 e6b4776**：seedStepHistory 里 seeded>step 时 h.go(step-seeded) 后 return（选此而非 finish 前退栈：另一标签页清草稿后 F5 不经过 finish）；onPop 对齐空转守卫（真机 mutK 臂 I9 restoredHint 为其判据，vitest 无 jsdom 咬不住）。真机 I6 6→1、I7 3→1、I9 5→3，I3/I4/I5 仍 3 且回退过程草稿与表单未清。复核 nit「⑨只量 step=0，臂 I go(-seeded) 存活」——经理补一例 seeded=4→step=2 期望 [-2]。至此小白二轮 8 条缺陷全部闭卷，CI 盯梢中。

**2026-09-03 · 生产上线 e6b4776（F-206/207/208 minors）**：备份 → bundle ff → build EXIT=0 → restart 双 active → getDb ok → 路由 200。小白二轮 8 条缺陷全部上产。

**2026-09-03 · 主理人反馈：固化确认弹窗按钮排布 → 派单 dialog-buttons**（基座 e6b4776）。裁决：改共用 confirm-dialog（全站弹窗受益）；手机上下全宽等高 ≥44、主按钮在上、单行文案；电脑右对齐等高；固化主按钮文案「确认固化」；巡检仓内全部确认弹窗 393 截图。

**2026-09-03 · 主理人反馈：设置页实名认证（护照通道）「优化排版，按钮啥的」→ 派单 realname-form-ui**（基座 e6b4776，不碰 byo-key 在改的 settings/agent 与 ApiKeysCard）。裁决：电脑表单 max-w 36rem；上传改成并排可点上传格（缩略图/换一张/错误态），护照与身份证两通道共用同一原语（结构守卫）；底部主按钮「提交审核」+ 缺项灰字 + 次按钮「改用身份证认证」outline 同高，手机全宽上下排；人工审核说明改 callout；姓名/证件号/缩略图进糊层。

**2026-09-03 · 主理人「为啥后台还没上线」**：查实生产 /woo 404、/woo/users 与 /woo/codes 均 200——后台早已上线（9d9895c 搬到 /woo），只是**根路径没有 page.tsx**（batch3 搬目录时未建索引页），主理人记的入口是「/woo 进管理页」。经理亲手补 woo/page.tsx 直跳 /woo/users + 判据（根路径存在/跳向/noindex），主干 503963d、CI 盯梢、上产。**教训**：「路径规格」里每一条 URL 都要有真机 200 判据，包括根路径；搬目录的工单验收要逐条 curl 规格里的 URL。

**2026-09-03 · mcp-nav PASS（df574e0）+ 经理收两 nit（acb2d6a）→ 主干 0061f93**：侧栏「接入我的 agent」紧随驾驶舱、问它之前；徽标由真 MCP 握手翻牌（clientInfo.name=Claude Code）；低调「接入助手」；文案唯一入口守卫（AppShell/navItems 写字面即红）；复核 10 臂 9 红。经理亲手：①手机顶栏「我的」在 /settings/agent 仍亮（ShellHeader 自判 /settings，不复用被减过的 match）；②徽标整屏恰一枚守卫（R8 逃逸臂转红）。裁决书笔误更正：手机底部栏是四格（驾驶舱/问它/证据/文书），「我的」在顶栏。记账：低调下侧栏分组标题「案件」与驾驶舱「这家公司被仲裁过几次」为基座既有裸露——排入低调收口待办；worktree 软链 node_modules 会让 Turbopack build panic，build 一律在 cp -al 副本上跑。

**2026-09-03 · 生产上线 503963d（/woo 根路径直跳）**：build EXIT=0 → restart 双 active → /woo=307→/woo/users、/woo/users 200、/woo/codes 200。

**2026-09-03 · 生产上线 0061f93（MCP 侧栏入口）**：build EXIT=0 → restart 双 active → / /settings/agent 200、/woo 307。
**主理人「没有办法审核护照的实名认证」「手机号不要脱敏，这是管理后台」→ 派单 admin-passport-review**（基座 0061f93）：待审队列/解密字段/两张照片经管理员专属流式路由/通过·驳回（原因回显、可重交）/审计+中性邮件尽力而为；手机号全显、≤10 位数字模糊搜索（解密后包含匹配，上限 5000）；权限走 admin 唯一入口、非管理员 404。不碰 byo-key-rotate 与 realname-form-ui 在改的文件。
**发现：两账号公道值为负**（uid=2 −633、uid=1 −154，ledger 与 gongdao.balance 一致，是真实余额）：uid=2 内测开通 pro 时直接插 memberships 行、**未随会员入账 30000**（pricing pro=30000）→ 经理已按 pricing 补发 30000（ledger #83 管理员调整，余额 29367）。同时暴露**没有余额闸**：消耗可一路透支到负数——需主理人拍板扣费口径（见汇报）。首次 grant 脚本报 better-sqlite3 bindings 缺失，是 build.sh 正在 npm ci 的瞬时态，build 完复跑成功。

**2026-09-03 · realname-form-ui PASS（878cf06）+ 经理补两判据（9099986）→ 主干 f9dd3fb**：表单 576px 左对齐/手机全宽；UploadTile 共用上传格（整格 label、缩略图+换一张、错误态红边+原因）两通道唯一 file input 入口；按钮组主次同高 48、缺项提示逐步准确；callout；低调糊层零露出；真机 132/132 量值通过、24 臂全红。裁决：field.tsx 标签间距 gap-2（全站共用原语）**接受**；两通道提示落点不一致与错误态两格底不齐两处肉眼级排版留下轮；RealnameCard missing[] 缺判据留待办。经理补 sm:grid-cols-2 / border-dashed 两条判据（R1/R4 存活臂转红）。CI 盯梢中。

**2026-09-03 · 生产上线 f9dd3fb（实名认证表单排版）**：build EXIT=0 → restart 双 active → / /settings /settings/agent 200、/woo 307。

**2026-09-03 · dialog-buttons 复核 MUST_FIX 一条（2f7ff9a）→ 派修复**：排布本身达标（320/360/393 六弹窗 column 主上次下全宽 48、1280 row 次左主右 min-w、固化文案「确认固化」、M1–M6 全红；仪器事故：第一版 g6 按 DOM 第一个认主按钮，M2 反序时尺子跟着反——改按 data-slot 认人）。硬伤：ConfirmDialog 传整串 buttonVariants 的 text-[16px] 经 tailwind-merge 覆盖 BUTTON_LAYOUT 的 clamp，主按钮不缩字号，360/320 档主次字号不等（执行者只量 393 恰好量不到）。修法：AlertDialogAction 收 variant prop；g6 加 360/320 档与字号相等断言、退出登录场景（route abort）。裁决：12 字守卫只覆盖字面量——接受；toast 压弹窗 z-order 既有问题另记。

**2026-09-03 · admin-passport-review PASS（5bfdca7）合入主干 848cbbf；byo-key-rotate PASS（91fc05f）与 dialog-buttons PASS（89cfdbc）合入主干；两条收尾单派出**：
- admin 审核：三路复审 PASS——requireAdmin 唯一闸门（28 次非管理员/未登录/api key 探测全 404）、照片鉴权路由 no-store、解密只在 admin 路由、审计无 PII、真机全链路（提交→待审→看图→驳回回显重交→通过→已实名→固化闸放行）、手机 11 位全显与 4 位模糊。收尾单 admin-review-polish：审核后自动刷新、通知三态提示、落定校验最新流水、nosniff/仅 image、五条判据补牙、reason 上限。
- byo-key：一轮修复后 PASS——密文落库、查看/轮换仅网页登录态、旧钥即 401、低调下当前密钥也折叠（RV-S01）、生成→轮换话术同步（MF-1）、同页两卡共享 state（MF-2）；模拟 agent 只凭话术取 SKILL.md→MCP initialize→case_facts→knowledge_search 走通。生产 app.env 已有 LAWER_PUBLIC_URL/LAWER_SKILL_DIR。裁决：「暂不交付」名单去掉 knowledge_search **接受**。收尾单 byo-key-polish：no-store、吊销轮换 409、吊销同步、弹层标题、limit 归一、%ZZ 404、issued 剔 key。
- dialog：AlertDialogAction 收 variant 后主次字号 320→14/360→14.76/393→16 一致，g6 四档 205 断言绿，变异 M7 红；仪器坑记账（tailwind-merge 同组后者胜、只量 393 量不到）。
- 主干 CI 盯梢中；上产要跑迁移（api_keys.secret_enc）。

**2026-09-03 · 主干 fcce623 CI 红（tsc）→ 经理修补 417b602**：admin-passport-review 的路由测试调 insertApiKey 未带 byo-key 新增的 secretEnc——两支各自 CI 绿、合并后类型不齐。修补：测试补占位密文；本地 tsc 0、23/23 绿后 push。**规矩**：集成 worktree 合完多支后先本地 tsc（wt-int 已挂 node_modules 软链）再 push，不拿 CI 当第一道 tsc。

**2026-09-03 · 生产上线 417b602（后台护照审核 + 密钥查看/轮换 + 一段话术 + MCP case_facts/knowledge_search + skill 包 + 弹窗按钮）**：备份 → bundle ff → build EXIT=0 → restart 双 active → 迁移触发（api_keys.secret_enc/rotated_at 到位）→ / /settings/agent 200、/woo 307、/skill/SKILL.md 200（frontmatter 土八鼠陪跑）、/api/manifest 200、agent-setup skill_url=https://law.nbdpsy.com/skill/SKILL.md。真机核对（生成→话术含真密钥→轮换同步→旧钥 401；模拟 agent 取 SKILL.md→MCP initialize→tools/list→case_facts→knowledge_search；低调折叠；后台待审队列只读查看含主理人本人护照）已派 Sonnet；管理员 token 只读、不点审核。

**2026-09-03 · 417b602 生产真机核对通过 + admin 收尾 PASS + 侧栏「案件」低调收口**：
- 真机（Sonnet）：/settings/agent 生成→话术内嵌真密钥→复制一致→轮换后话术/配置即刻新密钥；393 可读；模拟 agent 只凭话术：SKILL.md 200（含陪跑指南链接）→ MCP initialize 200（serverInfo 土八鼠）→ tools/list 9 工具含 case_facts/knowledge_search → case_facts(case 1) 返回事实卡（证据分类计数+免责句）→ knowledge_search「经济补偿 封顶」带 confidence 原文核实 → 旧密钥 401；低调：话术与当前密钥折叠、剔糊层无密钥明文；后台 /woo/users「实名待审核 1 件」= 主理人本人护照提交，姓名/护照号解密、两图 naturalWidth>0；手机 11 位、中间 4 位模糊命中；console 0（剔预期 401）。**唯一不通过**：低调下侧栏分组标题「案件」裸露（AppSidebar.tsx:81 硬编码）→ 经理亲改 NEUTRAL_WORD.caseGroup「事项」+ 判据。核对顺带轮换了 SMOKE-TEST agent key（新明文只在 scratchpad），测试临时 key 已吊销。
- admin-review-polish PASS（12398d2）：审后无刷新联动（行状态+审计）、三态分句、陈旧流水 409 与 400 分码、nosniff+非图 415、≤500 字闸、17 变异全红。知悉：sent 态只能在 dev dry-run 下真机触发；旧待审行残留属既有语义。
- 合入主干（集成后本地 tsc 零输出），CI 盯梢中。

**2026-09-03 · 生产上线 7ed3b87（审核台收尾 + 侧栏「案件」低调收口）**：build EXIT=0 → restart 双 active → / /settings/agent /woo/users /skill/SKILL.md 200、/woo 307。

**2026-09-03 · byo-key-polish PASS（53b41f0）→ 主干 0c49919**：三条回明文接口 no-store；吊销 key 轮换 409 KEY_REVOKED（三段式自述）；吊销当前那把即刻同步共享 state（真机 393/1280 三态）；弹层标题改口；MCP knowledge_search limit 归一 [1,MAX]；skill 路由解码兜底 404；onIssued 五项守卫；「暂不交付」名单去 knowledge_search 有台账。变异 19/20 红（唯一存活为数字串判据小缺口，真机功能正确）。
- **待办（另开单）**：①/skill/%、/skill/%ZZ 等畸形编码在 Next 16.2.9 入口层即 500（全站动态路由同形，handler 未进）——要改 middleware/反代唯一入口；②站内 agent 的 lib/agent/tools.ts:822 knowledge_search limit 孪生（limit=-5 回 30 张卡）——与 MCP 收成一处 clampLimit；③mcp 路由 limit 判据补数字串 '3' 用例。

**2026-09-03 · 生产上线 0c49919（密钥接口收尾）**：build EXIT=0 → restart 双 active → 路由 200/307。今日上产合计 12 批：qa2 五单（登录落地/401 出路/OTP 冷却与短闸/对话失败态/首诊建档前置/三 minor）、/woo 根路径、MCP 侧栏、实名表单排版、后台护照审核+收尾、密钥查看/轮换+一段话术+MCP 两工具+skill 包+收尾、弹窗按钮、侧栏低调收口。

**2026-09-03 · 主理人反馈：后台「确认通过这次实名」弹窗排版 → 派单 admin-review-dialog**（基座 0c49919）。裁决：主按钮常量短句「确认通过/确认驳回」，姓名不进按钮；正文改字段块（姓名/证件等宽）；驳回同套；confirm-dialog 12 字守卫扩展到动态 confirmLabel（模板串即红），woo/users 调会员也改常量；弹窗 ≥sm max-w-md。这正是上一单复核 nit「12 字守卫只覆盖字面量」的现实后果。

**2026-09-03 · admin-review-dialog PASS（b3bec60）→ 主干 a9dbb53**：两弹窗 confirmLabel 常量短句、字段块（姓名 600 / 证件等宽 tabular）、驳回原因引用块、弹窗 sm:max-w-md；调会员/发公道值也改短句；confirmLabel 守卫升级为「先解再量」（模板串/三元含变量/String(x) 四种拼法红，模块常量表可解）。裁决：alert-dialog 桌面全站宽 420→448 **接受**；EvidenceLibrary 的 NEUTRAL_WORD 模板按「静态可判定」放行 **接受**。真机 1280/393 通过与驳回四张量值通过。CI 盯梢中。

**2026-09-03 · 生产上线 a9dbb53（后台审核弹窗排版 + 全站桌面弹窗宽 448）**：build EXIT=0 → restart 双 active → 路由 200。今日第 13 批。

**2026-09-03 · 主理人拍板「余额闸：拦」→ 派单 gongdao-gate**（基座 a9dbb53）。规则：网页对话开始新一轮前查余额 ≤0 → 402 拦、不落用户消息、不记账，页面提示并给兑换/充值入口；已开始的一轮答完（最多欠一轮）；下单类服务报价时余额不够即拦；MCP/REST 不受影响；会员同规则。主理人已在后台通过自己的护照实名。

**2026-09-03/04 · gongdao-gate：实现 28cce32 → 计费视角 PASS / 产品视角 MUST_FIX RV-1 → 修复 7c6b663 → 复核撞周额度（resets 09-07）→ 主理人「额度恢复」后 resume**：
- 闸落在 lib/billing.canStartTurn 唯一入口，chat 路由归属校验后、runTurn 前判 402 GONGDAO_EXHAUSTED（三段式含余额）；拦时 messages/ledger/usage 零新增、假上游零调用；会员同拦；MCP 余额 -100 照样 200；watch 扣费点补差 1 拦判据；19 变异全红。
- RV-1：被拦那一轮前端仍本地回显问话并清空输入框，F5 后消失——修复：useChatStream 加 onFailed，Workbench 按 id 撤回显并把原文放回输入框（只对 GONGDAO_EXHAUSTED），9 变异红，真机 A 组全过；三统计 4504/tsc 0/build 0。
- nit 入账：①并发多请求同时到达余额 1 会欠多轮（网页单标签被 Composer 串行化挡住，多标签/API 可复现）→ **另开单**：每用户在飞占位（进程内 Set，单进程够用）；②横幅 F5 后不留（服务端零落库无从复原）→ 产品裁决：**接受**，余额仍 0 再发照样被拦；③393 有历史时横幅落视口外（error 帧不跟随滚动）→ 随并发单一起修；④异地兑换后不自解除需 F5 → 接受；⑤POST /watch 建盯梢不查余额、最多免费盯 3 轮 → 既有设计知悉；⑥真机假上游每轮收到 2 次 /v1/chat/completions（相隔 10ms、正文差 137 字节）而 usage 1 行——**疑点另开单查**（是否重复调模型多付一次钱）。

**2026-09-04 · gongdao-gate 复核 PASS（7c6b663）→ 主干 9b88798**：RV-1 修实（流层 onFailed、Workbench 按 id 撤回显并回填输入框、仅 GONGDAO_EXHAUSTED 撤），复核 9 臂 7 红（2 存活为判据缺口/等价变异），原 19 臂闸矩阵仍全红，真机 A/C 组与执行者逐项一致。上产后给 smoke 账号 uid=1 补测试额度（现 −154，会被闸拦）。跟进单 gate-followup 已派：每用户在飞占位防并发多欠、retry_of 判据、402 横幅跟随滚动、横幅 retry 路径判据。

**2026-09-04 · 「每轮两次模型请求」诊断：② 同一轮内合法二次调用，已按一轮记账**（Sonnet 只读）：第二次是 orchestrator.ts:932-951 的「收口检查」补救轮（charter §2 每轮必落行动卡；state.actionCards===0 时追加一条固定系统提示再打一次）；137 字符差 = 那条系统消息 JSON 长度 136 + 逗号，三组样本逐字符对上；usage 每次 runOnce 累加、chargeTurn 只记一笔（ref_id=turn-<id>）——未漏账未双扣。假上游从不吐 tool_calls 所以补救轮 100% 触发，是测试环境极端值。**待办**：查生产真实流量里补救轮触发率（ACTION_CARD_MISSING 信号 / actionCards===0 分支计数），若常态触发则是模型不听第一次工具指令，要从提示词修，而不是多付一次钱。

**2026-09-04 · 生产上线 9b88798（余额闸）并实弹验证**：restart 双 active → 路由 200 → 用余额 −154 的 smoke 账号打 POST /chat → **HTTP 402 GONGDAO_EXHAUSTED**，三段式含余额（「余额 −154，这一轮开不了…到「我的」页兑换…」），messages 146→146 零新增、ledger 无新行 → 之后给 uid=1 补 5000 测试额度（余额 4846，ledger 管理员调整），供核对员使用。

- **2026-09-03 21:30 · 余额闸跟进单（gate-followup / wf_ae960360-c3f）执行者在回报那一步撞 API 500，工作已全部落地**：wt-gate 已提交 d520d64（在飞占位 409 TURN_IN_FLIGHT + retry_of 判据 + 402 横幅跟随滚动 + 横幅 retry 清 pendingEcho 判据），rd-gate 落盘 fu-test.rc=0（4511 过）、fu-tsc.rc=0、7 个变异臂全红、live-fu 并发读数 409/200 且账本 0 新增。管道判为「执行者未返回」纯因结构化回报丢失，非代码问题。处置：按「撞额度后按半成品检查」流程，给修复提示加【接手半成品】（只核对不重做、SHA 写 d520d64），复核提示加一题「前端收到 409 非流式 JSON 走哪条路（回显/重试/retry_of 无 message_id 会否 400）」，原 runId resume。顺手清掉执行者遗留的 5278/5279 两个进程（按 pid 杀）。教训：**执行者交付前先提交再回报**（这单做对了，所以断线零损失）——写进派单模板。
- **2026-09-04 00:05 · 余额闸跟进单复核 MUST_FIX（MF-1）+ 经理裁决**：复核官在 standalone 生产构建 + 可切模式假上游上把服务端四项全部正向确认（3 路并发 200/409/409、ledger 恰 1 行、上游 500/掐断/断线后占位均释放、串行 200→402；7 变异臂亲跑全红；4511/tsc 0/build 路由表与基线无差）。但新开的缝：**409 TURN_IN_FLIGHT 到前端被当普通失败**——httpTransport 把非流式 409 归一成无 message_id 的 error 帧，Workbench 留回显 + 给通用失败卡带重试；服务端一字未落库所以那条回显是孤儿（F5 即消失）；更糟是 409→点重试→402：retry 进门无条件清 pendingEcho，402 回来无回显可撤、原文也不回输入框，RV-1 保证失效，且零判据覆盖（真机两标签页读屏 rd-gate/mut-rv-fu/live/q1-2tab.txt + 三张截图）。**裁决 (i)**：客户端收一个唯一入口「服务端零落库的拒答码」集合 = {GONGDAO_EXHAUSTED, TURN_IN_FLIGHT}（frames.ts），settleFailedTurn 对集合内一律撤回显 + 原文回输入框；409 那一档画成不带重试的提示条（原文已在框里，等一等自己再点发送），输入框不禁用；加结构守卫：chat 路由 runTurn 之前返回的每个 error_code 必须在该集合里（防下一个 4xx 再漏）。**同单顺带**：409 文案删「（或者点停止）」——停止只是客户端 abort，服务端照跑到完才释放，对刷新过页面的人是空话。**第 3 项裁 (a)**：402 横幅跟随的判据以 jsdom spy 为准，复核官 6 档真机读数（变异体恒少滚 35px、横幅底压输入区 2px）按正向确认入账，不再往真机臂投入。**执行者真机读数不合格记一笔**：其「真机」是 next dev + 起即崩的假上游 + 无 RELAY_ROUTE_DOMESTIC，200 那一路在 getProvider 就死、上游从未被摸到，「ledger 1 行」在其报告里是空证（他自己标注了，诚实）；派单模板加一句「真机 = standalone 生产构建 + 假上游被摸到的证据（calls 计数 ≥1）」。**非本单**：F5 后余额为负者横幅消失、输入可用、再发才被 402（横幅只挂流状态）——RV-1 前就如此，入 backlog。
- **2026-09-04 00:35 · 余额闸跟进 MF-1 修复 6cec07a 复核 PASS + 裁决补记**：真机（standalone 生产构建 + 假上游被摸到 calls=3）两标签页读屏：tab2 409 ⇒ 回显撤、原文回框、提示条无按钮、输入框可用、文案不含「停止」；tab1 收场后再发 ⇒ 402 ⇒ 回显撤、原文回框、横幅在、输入框禁用；F5 后库里只有 tab1 一问一答、消耗流水仅一条；普通失败（上游 500）仍留回显 + 重试。五变异臂复核官自写锚点亲跑 5/5 红；4518/tsc 0/build 0（+7 判据）；diff 7 文件全在允许面。**裁决补记（执行者请示、复核官点名须落台账）**：REFUSED_BEFORE_WRITE 登记 **7 个码**而非工单字面的 2 个（CASE_NOT_FOUND / INVALID_BODY / INVALID_RETRY_OF / EMPTY_MESSAGE / INVALID_MODE / TURN_IN_FLIGHT / GONGDAO_EXHAUSTED）——集合的定义是「runTurn 之前拒答、一字未落库」，七个全符合，撤回显对它们同样正确；工单写两个是我举例不是穷举，守卫逼出完整表正是守卫的用意。**采纳，有效。** 画法不受影响（横幅/提示条/失败卡仍逐码决定）。**backlog 两条**：① 结构守卫只扫字面 error_code，route.ts:66 owned.errorCode（动态）与 :25 guard.response（401，transport 层已抛 SessionExpired）在扫描面外——现无漏，下一个前置动态码不会被点名；② 被拒那句原文只在 React state，F5 后输入框空（两档同形），是否落 sessionStorage 属产品裁决，待主理人。**三统计并发跑时 filesGc dry-run 超时 flake、串行全绿**——同机三份 vitest + 两份 build 的负载伪象，复核派单模板加「三统计串行跑或错峰」。
- **2026-09-04 00:50 · 滚版 662f59a 上产（余额闸跟进两单 + 台账）**：wt-int 合 ws/gongdao-gate 6cec07a 与 ws/guard-alter-fix 75e1e4e → 本地 tsc 0 → push main → CI 33780093681 绿（sidecar pytest + app tsc/vitest）→ 生产 sqlite 备份 lawer-pre-662f59a-*.db（757,760 B）→ bundle 取 → ff-only 9b88798→662f59a → build.sh BUILD OK → 双服务重启 00:45:36 → / 200、sidecar 200、公网 200、journal 无 error。**真机核对（smoke uid=1，case 1）**：并发两请求 200/409，409 正文 TURN_IN_FLIGHT 且不含「点停止」；并发后 messages +2（409 那路零落库）、消耗行不变；等 100s 后第三发 200（占位已释放）；收尾 消耗行 73→75、余额 4846→4324——两轮真实模型调用（critical 档）各记一笔，没有多扣。**两处流程坑入账**：① bundle 从 detached HEAD 的 wt-int 创建，里面的 ref 名是 HEAD 而非 refs/remotes/origin/main，生产 fetch 按旧 ref 名会 couldn't find remote ref——以后先 git bundle list-heads 再 fetch 那个名字（已写进部署备忘）；② 远端命令里嵌套 ssh 回自己（Host key verification failed）把外层会话卡到超时——远端脚本不得再 ssh。build 本身 nohup 脱管未受影响（rc=0 标记正常）。
- **2026-09-04 13:00 · 主理人要求降 token（不牺牲质量与速度）——实测与派单新规**：workflow 累计 49.7M / 93 跑 / 328 agent，均值 150k/agent，大头是 Bash 输出（全量 vitest 一次 20k 字、build 日志、逐臂变异日志）；一张小工单 5 个 agent ≈ 820k；主会话 6612 轮 7 次压缩，任务通知 79 万字（回包整段报告）。**新规（立即生效）**：①分级验证 S/M/L（S=文案/排版/纯测试/文档 ≤50 行：Opus 定向测试+tsc，Sonnet 读 diff 复核，不 build 不真机；M=单层功能：复核官全量 vitest 一次、变异只钉点名守卫 ≤3 臂、真机仅当 UI 行为是交付物；L=计费/鉴权/路由闸/数据：现全规格，须经理点名）；②任务书必写输出卫生（vitest --reporter=dot 或末 15 行、tsc head -20、build 只 grep BUILD OK、变异只回红绿计数）；③基线三统计按集成 SHA 记一次复用，复核官只跑 HEAD，全量以 CI 为准；④执行者断线但已提交 ⇒ 用 args 喂落盘报告直接进复核，不重跑修复；⑤workflow 回包只回 verdict/mustFix/sha，证据落文件；⑥ultracode 关时小任务单 Agent 派 Opus。
- **2026-09-04 14:50 · 生产出证 503 修复（援助律师会话转来、主理人指示）**：症状 attest → ATTEST_UNAVAILABLE「签名证书不存在 /data/lawer/secrets/sign/lawer.pfx」。处置：从同机 /home/ubuntu/NBDpsy/certs/signing.pfx 复制到该路径（sha256 前缀 77489951d064fea4、6210 B，与本机两份逐字节一致；ubuntu:ubuntu 600）；sidecar.env 的 SIGNING_CERT_PASSWORD 原为空，改为 NBDpsy .env 同名变量的值（先用 openssl pkcs12 -passin env: 证实该口令能打开此 pfx，值全程不进终端/日志；原 env 备份 sidecar.env.bak-20260904-144xxx）；只重启 lawer-sidecar，health 200。**验证**：/evidence-pdf 生成真实存证 PDF → /pades 签名 200（99,360 B）→ /verify：intact/valid/trusted 全 true、signer_anchored_to_cfca true、时间戳在且可信、docmdp/coverage ok、overall_ok true。**注意**：签名者 CN = 北京天开艾洛迪心理咨询有限公司（NBDpsy 主体），存证证明的 issuer 字段应与之一致，由调用方保证。**坑**：手写最简 PDF 能签但验签器抛「验签过程异常」——是夹具伪影不是证书问题，核对一律用 /evidence-pdf 生成的真 PDF。应用层 attest 真单交回援助律师用用户 key 跑（smoke case 无证据、实名未知）。
- **2026-09-04 15:20 · 两张 S/M 级单（新分级规则首批，单 Agent 派 Opus，不起 workflow）**：① **存证 PDF 签章主体行**（主理人确认「北京天开艾洛迪心理咨询有限公司」就是土八鼠运营主体）：sidecar 新增 GET /signer 从证书读 CN，payload 顶层 signer_cn 必填进 REQUIRED_TOP_LEVEL，抬头「出证平台」下加「签章主体：<CN>（出证平台运营主体）」，app attest.ts 生成前先取 /signer、失败走 ATTEST_UNAVAILABLE——分支 ws/attest-signer-cn（wt-attest-cn）。援助律师已跑 22/22 certified，已出的不重出（对外主张以哈希+时间戳为核心）。② **后台「发放公道值 / 调整会员 / 兑换码」看似消失**：诊断为 /woo/users 账号表最后一列「操作」被横向滚动裁出视口（表头空、无滚动条提示），功能本身在（GET /users/[uid]/gongdao、membership 接口与 ConfirmDialog 都在），加之 /woo/users↔/woo/codes 之间零导航。修法：操作列表头写「操作」+ sticky right；新增 WooNav 两 tab——分支 ws/woo-actions（wt-woo-actions）。复核按分级：Sonnet 读 diff + 定向测试。
- **2026-09-04 15:40 · 中转 Claude 与中高配开通现状核实（主理人问）**：**① claude-opus-5 中转已通、当场实调验证**：生产用 RELAY_API_KEY 打 api.relayrouter.ai/v1，claude-opus-5 → http 200 / 6.8s / model=claude-opus-5 / 返回「收到」/ usage 齐；claude-sonnet-5 → 200 / 3.0s；journal 24h 内 relay/claude 零错误。**② 中高配「能力」已就绪且已开闸**：LAWER_MEMBERSHIP_TIERS_UNLOCKED=1 在生产 app.env（09-01 开闸时置）；routing.config pro.critical=relay claude-opus-5、pro.standard/standard.critical=relay claude-sonnet-5；后台「调整会员」可直接给某账号设 standard/pro，已在用（uid=2/3/1 均 pro，token_usage 有 relay/claude-sonnet-5 真实记录）。**给谁开谁的关键轮就走 Claude，立即生效，无需发版**。**③ 自助购买还开不了，卡点全在支付、与 Claude 无关**：lib/payment/index.ts=`export {}` 骨架、channel.ts 仅接口无实现，orders 表 0 行（**入门档同样买不了**，RechargePanel 全档 disabled「支付暂未开通」）；skus 表 0 行（种子挂 migrate.ts 未落此库）；前端 _mock/authpay.ts 仍硬编码 standard/pro available:false（展示「待开发」）。**结论**：模型侧全绿，可运营手动开通；面向用户卖中高配需要①接一家支付渠道（微信/支付宝，独立工作量）②种 skus③前端 available 翻真——三件事一并做才谈得上自助购买。
- **2026-09-04 15:50 · 两单回报与裁决**：① **ws/woo-actions 2500661 通过并合入 wt-int（268ece4，tsc 0）**：操作列 sticky right-0 + 表头「操作」、WooNav 两页切换条挂在放行闸之后（保 404 同形，正确判断）；判据走本仓 renderToStaticMarkup 套路（仓库无 jsdom，装依赖会污染共享 node_modules 软链）；经理补验 card/border/line 三 token 明暗两套均解析、bg-card 不透明、overflow-x-auto 容器内 sticky 成立——静态判据够，不起真机（S 级新规首次落地）。② **ws/attest-signer-cn a7a04de 回报**：/signer 端点、signer_cn 进 REQUIRED_TOP_LEVEL、抬头「签章主体」、app 先取 /signer 失败走 ATTEST_UNAVAILABLE；7 判据 + 4 变异臂全红；pytest 57、vitest 定向 77、tsc 0。**裁决**：声明④（解释 Adobe「签署者身份未知」属信任列表延迟、不代表签名无效）从未渲染过——其入参 signer_entity 从没被传；改用 signer_cn 并删该入参（同单）；/pades 口令错 502 与 /signer 503 分级不一致 → backlog；pypdf 进 requirements 接受（钉版本，与 pytest/httpx 同例）；evidence.test.ts NUL 字节既有。等执行者补④后派 Sonnet 复核（M 级：读 diff + pytest 全量 + vitest 全量一次 + tsc），再与 woo-actions 一起滚版。③ **uid 3 高配**：主理人自己 15:01 在后台已办（admin-2-… 至 2026-12-05），无需再开；实名闸全站只挂在出证接口（requireRealname 仅 attest 与 passport 提交两处），注册只验手机+邮箱，合 08-19 决策；三档提前方案已呈主理人待选（建议：开会员/首诊前必实名 + 驾驶舱未实名提醒条）。
- **2026-09-04 16:05 · 主理人裁决实名闸前移到证据上传**：原话「上传证据，就需要提示要实名认证，不然无法保存证据出证」。落法（M 级，单 Opus + Sonnet 复核）：证据上传接口（POST /cases/[id]/evidence 与 /evidence 写路径）加 requireRealname → 403 REALNAME_REQUIRED（待审与未认证同等），文案自述三段式「证据要与本人身份绑定 / 未实名的证据无法保存与出证 / 去实名」；客户端 UploadBar/UploadSheet/DropPanel 在 auth_status≠已实名时显示提示卡 + 直达 /settings 实名，上传控件禁用（待审态说「审核中，通过后即可上传」）。聊天/首诊不动；MCP 无证据写工具不涉。合 08-19「所有上传材料绑定实名信息」决策。分支 ws/evidence-realname-gate（wt-evidence-realname，基线 b007469）。**滚版**：b007469（woo-actions + attest-signer-cn + 台账）已 push，CI 在跑。**自伤记一笔**：worktree 创建命令没先 cd 主仓，执行者已派出而树不存在——立即补建并通知；「BOARD/git 操作前先 cd」这条已经摔第 7 次，改成把 cd 写进每条命令的第一段而不是靠记。
- **2026-09-04 16:25 · b007469 CI 红 → 1c4066d**：app 作业绿；sidecar pytest 三条新判据红——runner 无 CJK 字体，gen_evidence_pdf.FONT_PATHS 全落空退到 Helvetica，中文渲成 ■，pypdf 抽文本断言「签章主体」自然找不到（本地与生产都有 NotoSansCJK-Regular.ttc，故执行者/复核官全绿、生产 PDF 无恙）。**处置**：不削弱判据（它守的正是模板注释里那次「Helvetica 黑块」回归），CI sidecar 作业加一步 apt 装 fonts-noto-cjk。**自伤第二笔**：第一次补丁把新步骤插在 pip 步骤的 run 与 working-directory 之间，working-directory 挂到了 apt 步骤上，pip 会在仓库根目录找不到 requirements.txt——2358c29 必红，已取消该 run 免主理人收失败邮件，1c4066d 改正并用 yaml 解析校验后再 push。教训：改 workflow 必须整段看 step 边界、push 前 yaml.safe_load 一遍。
- **2026-09-04 19:30 · 额度恢复后三线并行**：① **CI 1c4066d 仍红 → 1340d9a**：runner 装了 fonts-noto-cjk 仍渲成黑块，文件不在 gen_evidence_pdf.FONT_PATHS 的四个固定路径；生产实测（/evidence-pdf 探针 → pypdf 抽文本 711 字、0 黑块、含「出证平台」）与本机都在 opentype/noto/ 下所以从未复现。改 register_font 固定清单落空后 rglob /usr/share/fonts 搜 Noto/wqy/uming（本地模拟清单全空仍解析到 CJK，58 过），CI 加一步 fc-list 打印 CJK 字体清单让下次失败自述。② **证据上传实名闸**：上一任撞额度留 4 个未提交文件（realname.tsx 钩子、evidence route、guard、upload-guard 测试），派新执行者接手（先 diff 取舍、每块一提交）。③ **问它三症状（主理人真实使用）**：发送按钮偶尔无反应 / 一直等待不更新 / 答案已生成页面不出现——诊断为 useChatStream 无看门狗：连接静默死亡（iOS 切后台杀 fetch、切网、代理半开）时无帧无错，phase 永停 waiting/streaming，Composer:107 因 streaming 恒真吞掉点击；无「断线后回库取答案」的对账，服务端照常答完落库（finally 释放占位）。派 L 级单：看门狗（阈值 max(3×心跳,20s)）+ 对账（visibilitychange 与超时两处触发，重取历史按 message_id 落定，两次不到才 STALLED 卡带重试）+ Composer 永不被死流锁死。分支 ws/chat-stream-watchdog（wt-chat-watchdog，基线 1c4066d）。④ **问它无上传图片/文件/录音入口**（主理人）：待上面三线收口后立项——一期：Composer 加附件/录音入口，走既有证据上传管道（同受实名闸）+ 消息挂附件片 + 事实卡带元数据；二期：OCR/ASR 文本进轮次（sidecar /ocr /asr 已有）+ 按算力计公道值前置报价。
- **2026-09-04 21:20 · CI 黑块根因定案（1340d9a 仍红 → 1b38087）**：runner 装了 fonts-noto-cjk、路径与生产一致、resolver 也搜到了，仍黑块；pypdf 6.16.2/6.17.0 两版本地都绿，排除。**真因**：Noto Sans CJK 是 CFF 集合（OTTO），reportlab TTFont 只吃 TrueType 轮廓——本机、生产、runner 三处加载全部 TTFError；本机与生产实际靠 FONT_PATHS 第三项 wqy-zenhei 渲染中文（生产实测 OK），runner 没有它 → Helvetica → 黑块。**修法**：CI 装 fonts-wqy-zenhei；加判据 test_cjk_font_actually_loads（register_font 必须回 CJK，失败信息列出候选清单）让下次缺字体一句话说清，不再三条 ■ 断言一起红。**教训两条**：① 「路径存在」≠「能加载」，resolver 的 try/except continue 把真正的失败吞成静默回退，回退型代码要有一条把回退本身当失败的判据；② 我连改三次 CI 才定案——前两次都是「看起来像」就动手（字体缺失→装字体、路径不对→搜路径），第三次才做对照实验（三处环境逐个 TTFont 加载）。以后 CI 环境差异一律先做「同一段代码三处环境跑一遍」再改。
- **2026-09-04 21:45 · 滚版 1b38087 上产**：CI 33877160830 绿 → 备份 lawer-pre-1b38087（1,056,768 B）→ bundle 按 list-heads 取 → ff 662f59a→1b38087 → BUILD OK（sidecar venv 装入 pypdf）→ 双服务重启 → / 200、sidecar 200、公网 200、journal 无 error。**内容**：后台账号表操作列钉右缘 + 「账号/兑换码」切换条；存证 PDF「签章主体」行与声明④（sidecar /signer、signer_cn 必填）；CI 字体修正。**真机核对**：/signer 返回 CN=北京天开艾洛迪心理咨询有限公司、not_after 2027-03-27；/evidence-pdf 无 signer_cn → 400、有 → 200（71,026 B），抽文本含「签章主体」、④ 段含 PAdES 与 CN、0 黑块。**提醒**：签名证书 2027-03-27 到期，需提前续（记入部署备忘）。后台页 sticky 列由主理人刷新后目视（S 级不起真机）。
- **2026-09-04 22:20 · 三线状态**：① **证据上传实名闸回报 f83e1fb**（接手执行者全留上一任四文件）：POST /api/v1/evidence 在 requireIdentity 后挂 requireRealname（体积/并发闸之前）；cases/[id]/evidence 仅 GET 故不挂（裁：对）；前端 useRealnameStatus/RealnameGate/RealnamePrompt（低调 证据→资料），UploadBar 三入口禁用+提示卡，UploadSheet 兜底，拖入闸落 EvidenceLibrary.handleDropped 而非通用 useFileDrop（裁：按架构归调用方，对）；加载态放行靠服务端兜（裁：接受，复核核 403 回显必须是实名提示）；30/30、变异两臂红、tsc 0。派 Sonnet 复核（全量 vitest 一次 + 五点 + 两臂亲跑）。② **MCP case_list 单派出**（主理人 GPT 实测：接入成功却被要 case_id——九工具无列案件、SKILL.md 教它问用户、REST GET /cases 未入能力表）；**下一单 intake_submit**：注册即自动建档（otp.ts ensureDefaultCase），POST /cases/[id]/intake 本就收 api key（case:write）但未入文档、无 MCP 工具——agent 引导新用户建档的能力在、露出缺；等 case_list 落地后基于其分支派，避免 tools.ts/文档双改冲突。③ **问它看门狗**执行中。**主理人四问已答**：他人 case_id 一律「案件不存在」；证据只见清单不见内容（内容进对话是附件二期）；建档能力见上。
- **2026-09-04 22:50 · 主理人用 GPT 读自己案件（case 2）后判「潦草、多处错」→ 查实 + 立项「个案报告」**：**现状**：档案 = 五张扁平表（cases 的 stage/goal/bottom_line + 四项基本盘列、timeline_events 26 条、action_items、deadlines、evidence 22 条），无任何叙事层与长期记忆，case_facts 只是读时拼装。GPT 的摘要对数据是忠实的，「错」来自数据本身：① 四项基本盘（入职/月薪/岗位/合同份数）全 NULL——首诊从未重做；② 9/1 调岗事件被两次写入（id 34/35，同事一事两个时间），三张行动卡各写两遍（6 行 3 个标题）——agent 重试无幂等；③ deadlines 里只剩 08-29 期限提醒首发测试那条「测试后即清理」的行，我没清——**已当场删除**（id=1，仅此一行，备份在案）；④ 年假有效期记在时间线未进期限表；⑤ goal/bottom_line 被写成长段自由文本。**主理人要求（产品决策）**：每个客户一份独立的、知识库式的个案报告，作为长期记忆，agent 实时维护——有新进展/新证据/新情况/隔一段时间就更新。**设计（我裁，报主理人）**：按案件一份（现一人一案等价于按用户；多案时各一份）——新表 case_reports：结构化分节（基本盘/案情主线/争议焦点/各方立场与谈判纪律/证据地图/时间线摘要（去重、策展）/期限/待办与下一步/风险与未定项/变更日志）+ 渲染稿；MCP 加 case_report_get / case_report_update（按节打补丁、必带理由、记 updated_by）；服务端过期机制：timeline_add/证据上传/阶段变更/期限变更即置 stale 并记原因，7 天无更新也置 stale；case_facts 与工具回包首行显示「报告过期：自 X 以来 N 条变动」逼 agent 开工先更新；网页档案页只渲染这份报告（展示层定位）+「最后由 agent 更新于」+过期标。**配套**：写入幂等（timeline_add / 行动卡 建卡按 client_ref 或同日同题去重）、intake_submit（基本盘由 agent 问出来写入，不必再走网页首诊）。**排期**：case_list（在跑）→ intake_submit + 写入幂等（M）→ 个案报告后端+MCP（L）→ 网页档案页渲染（M）。
- **2026-09-04 23:10 · 证据上传实名闸复核（Sonnet）MUST_FIX 一条**：五点核对四过——写路径唯一（insertEvidence→uploadEvidence→POST /evidence，闸在 formData 之前；MCP 无写工具）、403 回显是服务端三段式原文非通用失败、attest/passport 路由零变化、低调文案无案情词；全量 4541 过、tsc 0、两臂变异亲跑翻红。**不过的一条**：UploadBar 新加的外层 flex-col div 在已实名时仍渲染，DOM 多一层，违反「已实名零变化」且无判据覆盖。裁：改 fragment + 加判据钉「已实名态顶层元素即原 grid div」；退回执行者单独一提交，我自己核 diff 后合入（三行改动不再起复核）。**backlog**：上传错误卡的「重试上传」在 403 实名拦下后再点仍 403，无「去实名」跳转钮（文案已写去处，路极窄，不升级）。
- **2026-09-04 23:30 · 问它看门狗回报 cc92780（ws/chat-stream-watchdog）**：诊断全部证实——useChatStream 唯一 error 出口在 catch，sse.ts reader.read() 挂而不抛即永停等答态；Composer:107 busy 恒真吞点击；服务端照常答完落库页面不刷新；全站无 visibilitychange 对账。**额外病灶**：旧 stop() 纯 abort，catch 命中 aborted 分支原地 return，phase 停死——停止键也解不开锁。心跳 15s，阈值 45s，轮询 15s，客户端镜像值有 heartbeat-sync 守卫钉住服务端常量。新增 _stream/watchdog.ts、reconcile.ts；判据 a/b/c/d/e + 三变异臂红；436 过、tsc 0。**裁决**：stop 不 reset——服务端断开后照常答完落库计费，停止只是停止接收：半截就地落定 + 小字「已停止接收；服务端会答完，刷新可见完整回答」+ Composer 解锁，补判据与变异臂。真机自证执行者未做（L 级要）：复核官起 standalone + **冻结代理**（TCP 中间层在 meta 帧后停止转发、服务端继续答完落库）复现静默死流，验 45s 后页面自动补上答案、发送键恢复；visibilitychange 用 dispatchEvent 模拟。
- **2026-09-04 23:50 · case_list 单 b320ac7 通过并合入 wt-int（tsc 0）**：tools 十个（case_list 末位，scope case:read，run 只传 identity.uid，复用 GET /cases 同一查询）；SKILL.md/接入说明/claude 变体三份改「先认领案件：单案直接用、多案让选、零案去建档」，删「不知道 case_id 就问用户」；判据：顺序钉十、甲乙互不可见（变异去 userId 过滤 ⇒ 红）、skill 守卫。四条裁决：created_at 够用不加列；case_id 键名刻意；manifest 未列裸 GET /cases 是既有缺口下一单补；route.ts 保持手术式。经理自核 diff 合入，全量以 CI 为准（S/M 级）。**下一单已派（ws/mcp-intake-submit，基线 b320ac7）**：intake_submit（对齐 IntakeInput，元→分换算，assertOwned，校验失败回字段级原因）、case_update 扩四项基本盘、timeline_add client_ref + 近重复守卫（同案同日同 kind 标题规范化相等）、行动卡同题待办不双建、manifest 补 GET /cases 与 intake、SKILL.md 改「零案或基本盘缺项 ⇒ 按首诊清单问清后 intake_submit 写入，别让用户去网页填」。
**审计自身的教训入账**：①报告1 用 sqlite3 CLI 读逐连接 PRAGMA 当生产事实——better-sqlite3 编译期默认不同（synchronous=NORMAL 非 FULL、busy_timeout=5000 非 0），报告3 头号墙整条建在错值上被撤销——**又一例「先审量具再信读数」**；②报告4 把「唯一测得出来的」排成「最先倒的」——可测性偏差；③access log 行/秒≠并发用户（量纲）。**待办三实测**（1000 档排序定稿前置）：50 路真 SSE 的 memory.peak 差分、单 chat turn 事件循环占用、四家 LLM 上游账户级并发/TPM 上限（查控制台即得）。⚠️ 核验官 C8 称驾驶舱仍用 demoCase mock——**取自本地 ws/guard-alter-fix 分支快照，与批6「前端已接线」记录冲突，采信前须对 prod 实际版本核一分钟**，别把陈旧分支当产线。

## 📏 批 0 交出的三条测量教训（2026-08-27）

1. **指标看不见这一类差异 ⇒ 它说没变，不等于没变。** 四项廉价指标（页高/卡片数/底色分布/断点行为）全说"零变化"，逐像素比对报 1.05% 差异——`CardAction` 的 strut 高了 1.69px×5 张卡=6px，**而侧栏 `xl:overflow-y-auto` 自己滚，内部漂移根本不进文档高度**。线索是唯一没有右侧计数的第三张卡纹丝没动。昨天的灵敏度对照臂是"仪器看不见差异 ⇒ 相同读数是证伪"，今天是它的另一面。
2. **"我这儿能跑"不算，干净 clone 当场抓到工装 bug。** 默认 profile 固定路径被上次跑剩的 Chrome `SingletonLock` 占着——**在作者工作区一直是好的，因为那把锁正是作者自己留下的**。报错只有"Chrome 起不来"，下一个人会去查 Chrome/Xvfb，永远查不到锁。
3. **派单里的数字会过期。** manager 写"现在是 1489"，实际 base 已是 1502（main 合进了别的工作）。作者重跑 base 才发现，没照抄。**另：作者第一次量 base 用错 `npx --prefix` 得到"30 failed"，差点当成 main 坏了——一个自己搞砸的调用产生的数，和真数长得一模一样。**

**一处不该有的**：`CasePanel.tsx` 被整文件换了引号风格（16 单→16 双），+194 行里大半是格式噪音。行为经 0 像素差异证明未变，不阻塞，**但批 1 起不许整文件 reformat**——它让 review 看不出真改动。

## 🧭 两条已验通则（2026-08-27 下午，哨兵；数据干净——它自己也撞限离线，观测回路天然不存在）

**① 弹窗与撞限是两种不同的沉默，合并记会吃掉差别（同日第二版，第一版被外勤/哨兵推翻）。**
- **弹窗 = 能力问题**：停在 AskUserQuestion 前的会话拿不到回合，写不了心跳也读不了消息。**外部观察是唯一信息源**（哨兵抽屏比阈值早 36 分钟抓到）。
- **撞限 = 注意力问题**：会话撞限前会收到 `[Usage limit approaching. Checkpoint now…]`，**那一刻能写**——但全部心跳里「撞限暂停」用过 **0 次**（待命 106 / 等外部 65 / 在岗 34 / 正常 31 / 收工 6 / 等用户 1）。收到预警时人在忙 checkpoint，不会想起改状态词。**"技术上可写"和"实际会被写"之间隔着一整个注意力问题。外部观察解决不了它，因为问题不在观察，在那个词根本不会被写。**
- **第一版合并句（"弹窗夺走回合，撞限夺走配额，结果一样"）错在**：一个能解释全部的解释把两者的差别吃掉了——**而且它骗过了入册这道门，因为"覆盖面广"看起来像优点。** 今天第四次同一机制（代码里的共因合并 → 一句诊断 → 一个量 → 一句通则）。
- **「撞限暂停」从白名单删除（manager 08-27 裁）**：现在是死重（0 次），一旦被用是后门——预警只说"可能要撞"，写下它就买到 4h 免检，**连"已经发生"都不是，只是预测**。与 08-26 否掉「收工」同理。
- **划掉第一版那句"差别只在撞限那秒恰好是哪个词"**（外勤反驳，哨兵认）：那个词不任意——manager 停在「在岗」是因为真在干活，哨兵停在「待命」是因为真闲着。**判据键在"你停下来时正在做什么"，那是可得的最好的紧急度代理。同因不同果给出不同响应，是对的。**
- **窄的一条留着（哨兵）**：状态字段记的是**最后一次写入那一刻**的答案，不是停下来那一刻的答案，**两者的分歧随停更时长单调增大——这个字段最不可信的时候，恰好是它最要紧的时候。** 危险方向（写下闲态词→被派活→干活中死掉→按 4h 宽档处理）**无失效实例；前提条件已有一例**（08-27 15:32，哨兵自产：15:23 写「待命」，随后 15 分钟巡逻、抽屏、发消息，字段未更新——**凑齐了前两样，没死在窗口里**）。**"没有实例"那句的语气里假设了前提条件本身少见——实际它在写下那个词之后九分钟就成立了。前提条件不是罕见事件，是日常状态。** 抓住它的不是自觉，是**巡逻把观察者本人列为第九个岗**——把自己排除在外是很容易顺手做的"优化"，做了这条就永远不会被发现。

**② 时间聚拢是共因的必要条件，不是充分条件。**
`clustered=3 span=976s`：manager / 前端页面 / 外勤 在 976 秒内先后停写，逐屏抽出**三个互不相干的成因**（撞限 / 空闲没人派活 / 正在全速跑只是没写）。上午立的"真共因各岗末次写入聚在一起"成立，但**反过来不成立**。外勤的实现没踩坑（3/9 没过半数门限），**别因此去放宽门限**。

**③ 预登记的用处（哨兵 12:49 写在事件之前）**：「若 13:23 后越线，成因已确认为弹窗；若届时弹窗已消失而仍不写，那才是新情况。」实际 15:01 弹窗已不在、屏上是撞限——**"新情况"分支命中**。**写在事件之前，让自己在事后拿不到"我早就知道"这句话。**

## 🚨 空转三天的 L1（08-28，评测官，恒产出裁定暴露）

**D15 `危机轮零付费内容` 自 08-25 登记起从未被执行**：函数在、`L1_CHECKLIST` 在、元测试/单测全绿——**runner 里没有调用点**（`git log -S` 全历史零命中；174 份成绩单 0 份含它）。提交说明写着「首次配备机械执法者」。**执法者配好了，没接上电。**
三样全绿而三样都不验接线；**「干净即无声」让「没接线」与「合规」产生完全相同的观察**——恒产出裁定藏的不是显示问题，是一次真的缺席。
**已修**：补接线 + 一条查 runner 源码调用点的守卫（第一版被自己注释里引用的形状打败——**注释里对 bug 的描述长得和修复一模一样**——变异当场抓住，改剥注释再匹）。补跑 S08×2 让它有首次真实上场记录（进行中）。
**同形第二条（后台技术全扫 13 条后发现）**：`coreRenderObservabilityAssertions`（`eb898da` 判据侧）**同样全历史零调用、351 份归档零命中**。其余 11 条有真调用点。分层清单更正：**`eb898da` A 类 → 「产线侧有回放证据、判据侧从未执行」**。错法：**把"有测试"当成"被执行过"——单测执行函数，跑批执行流程，两者都绿只有后者证明它在跑批里存在。** 守卫待泛化为覆盖全部注册判据族。
**补跑前置已就位（后台技术）**：归档补 `turns[].crisisPaid` 三态无条件写——没有它补跑只能答"没报红"。其自查对照臂：`CRISIS_PAID_CONTENT_BLOCKED` 351 份零命中差点读成"闸没开过火"，拿明知开过火的 `EMOTIONAL_LEVERAGE_DETECTED` 同样零命中证伪——**零命中说明归档看不见 notice，不是闸没开火。**

## 🎯 批 3 交出的两条（2026-08-27，前端页面自抓）

1. **一个没打中目标的测试，和一个打中了但功能坏了的测试，输出完全一样。** 实点验证 label 没反应 → 误判"浏览器不转发 label 点击" → 加 `onClick` "修" → 仍没反应，**因为这下变成点一次翻两次（onClick 一次 + 浏览器转发一次），净效果纹丝不动**。真因：**测试点在视口外**（行动卡 y=1853，视口高 900），`elementFromPoint` 返回 null，**元素从头到尾没被碰到过**。靠打印落点抓到。要不是这样，会带着一个自制的双翻转 bug 交付，**而它的表现恰好和"没修好"一模一样**。与昨日「0% 掉帧」（`gestureSourceType:'touch'` 静默没滚）同形：**都是多测了一个"动作到底有没有发生"才抓到。**
2. **修法的代价可能正是规格要避免的那个。** 第一版热区用 `min-h-11` 做整行 label，热区 44 了，**但行高 97→113——规格明写"不加高度"**。改成 `py-2` 撑命中区 + 等量 `-my-2` 从版式减掉：占位 28、命中 44、行高不变。**验收第 5 条要"两个数"（热区 + 行高）正是为这个：只验一个数会放过它。**

## 🔓 线上已知漏洞（2026-08-27 批 0 迁移时发现，修复在途）

**低调模式二档在三个页面不遮空状态文案**：文书页 / 证据库 / 图谱页。
B2（#53）把它们的 `EmptyState` 换成 shadcn 版时**丢了 `data-veil` 属性**（文件头注释写"props 与手写版逐字一致"——props 确实一致，**行为少了一个**）。
后果：整页糊着，唯独这几段清楚——而它们恰恰是全站最能说明"这人在干什么"的话（"把解除通知、协商协议拍下来传上去…签不签的结论"）。**一片模糊里唯一一段清晰文字，正好把眼睛吸过去。**
**修复**：#64 已合入 main（commit `82da6e3`，独立 + 回归测试，变异验证拿掉属性杀 1 条/挂错元素杀 3 条）。**线上仍是 476ed69，滚更前漏洞仍在线上。**
**教训**：同一句"逐字一致"注释，Badge 核过是真的、EmptyState 核过是假的——**注释描述的是意图，不是行为；只有 token 逐值比 + 行为测试能分开两者。**

## 🎨 前端重构（2026-08-27 拍板，详见 DESIGN.md「视觉方向 v3」）

| 批 | 状态 | 谁 |
|---|---|---|
| 0 清债 | **✅ 合入** #64（08-27）：混用页 3→0，`components/ui` 只剩 Toast，1505/9 绿（manager 实跑复核），六对截图 0 差异像素，工装进 `scripts/perf/` 干净 clone 跑通 | 前端页面 |
| 1 手机工作台 | **✅ 合入** #65（08-27，~5h）：页高 3736→3399，灰度可分，768 真分档，D17 落地。1510/9（manager 实跑复核）。两处按对比度/折行偏离规格已记。**线上仍 476ed69** | 前端页面 |
| 2 品牌+首页 | **全部 ✅**：#66 → #68（土八鼠）→ **#69 logo 落位**（hero WebP 63KB 首选+SVG 兜底、手绘 15 形状 favicon、LampMark 全换、a11y 双 100、移动 perf 98/LCP 2.5s/CLS 0）。**前端四批 0/1/2a+2a-2/2b/3 全部收口** | 前端页面 |
| 3 内容区排版 | **✅ 合入** #67（08-27，~2h）：结论 13→19px 成卡内最大字（灰度仍可分）、证据页 6 卡→1 表、三页硬编码字号 31/35/29→0、热区 20→44 行高不变、a11y 四份 100。1510/9（manager 实跑复核）。**线上仍 476ed69** | 前端页面 |

**改名 4 处非 UI 串不能 sed**（charter / attest issuer / notify 测试 / MCP 自述），见 DESIGN.md。

## 🔧 监控判据修正（2026-08-27，一条我批错的）

**共因合并**（08-26 我批：同时 STALE ≥ 半数即合成一条）——**判据只数个数，不看是否同时停的**。
陈年静默攒成基线（4 个昨天下午停的），再多 1 个新故障就凑够 5 → 判"共因" → **新故障的个别告警被压掉，而那四个陈年的当初都单独报过**。跨度 21 小时。
> **抑制器的灵敏度由"有多少岗已经死了很久"决定，而那恰恰是最不该影响新故障可见性的量。**（哨兵）

**改法（外勤，已落）**：只把末次写入**落在同一个 1 小时窗口内**的算共因，窗口外一律单独报。轮次行带 `clustered=N,span=Ns`，**"为什么判成共因"可读**。三形态实测通过。
**不是合并这个主意错了**（它今早还挡下 6 条），**错的是把"数量多"当成了"同一原因"**。

**同日第二条（哨兵）：同一条告警文本，三种成因，一个便宜的分辨法。**
`thr=2700` 三条越线：外勤（干活忘写）、manager（在干活没写）、前端页面（**API 中断，真停了**）。告警文本完全一样。
「大家最近写心跳不勤」是个合理、可信、**覆盖全部三条**的解释——**这个叙事一立住，第三条就被吸收了，没人去看那台机器为什么真停了。** 和共因合并是同一族：**一个聚合解释吞掉唯一有信息量的个案，只是这次的聚合器是一句诊断而不是一段代码。**
**分辨法（⚠️ 同日撤回一半，现为单向判据）**：屏活时刻 − 心跳时刻。
- **屏差 ≈ 0 → 成立**：pane 自心跳以来没收到任何输出 → 会话确实没吐东西 → **去看屏**。前端页面就是这么抓出来的。
- **屏差 > 0 → 什么都不证明。** `window_activity` 量的是「pane 最后一次收到输出」，不是「会话在干活」——别人发来的消息、`/effort` 回显、更新横幅都能顶起来。实测：四个静默 20+ 小时的会话，活动时刻全落在 17 秒内（11:54:20–37），**是有人挨个敲了 `/effort`**。调研员屏差 1310 分钟，实际 22 小时没做任何事。
- **所以它只能用来升级怀疑，不能用来解除怀疑。** 上面第一版写的"晚于心跳 = 写入侧问题"是错的，而且错的方向正好会把死掉的会话判成"没写心跳的习惯问题"——**又一个吞掉个案的聚合器，这次载体是一个量**（上午是代码、中午是一句诊断）。
- **通则（哨兵，替代 manager 那版"判据可信度取决于谁能动它的输入"——那版只抓到一种缝隙）**：
  **每个判据都有「它实际测量的事件」和「人们想拿它证明的命题」，两者之间的缝隙就是它静默失效的地方。**
  ```
  window_activity   实测: pane 收到过输出        想证: 会话在工作      缝隙 = 别人也能产生输出
  心跳 mtime        实测: 有人以该角色身份写过    想证: 会话此刻活着    缝隙 = 写完就能死（前端页面：57 秒）
  心跳 状态字段     实测: 写的人当时敲了什么      想证: 它当时的真实状态 缝隙 = 写的人自己判断错
  ```
  **推论**：「刚写过心跳」只该读成「计时器归零了」，不该读成「这岗没事」。
**同族六变体（08-28 哨兵收齐，同日+1）**：句子比测量大一格，那一格可以跨——时刻 / 范围 / 运行时 / 分辨率 / **因果**（"我看到了 X"写成"X 会导致 Y"）。**改法同一条：把测量写进句子，止于测量。**
  **第六变体·代理量轮换（08-28 下午，哨兵自证伪）**：测量的是一个**间歇轮换**的标签（`esc to interrupt` 只是转轮行轮换提示之一），句子说的是标签所代理的持续事实——前五变体都假设代理量常在，这个连"在不在"都间歇。假阴性实例：manager xhigh 长思考第 4 分钟被判"没在跑"，差点收到一条错误催报。改法：**不认任何提示词，认转轮行计数器两次采样有无推进——测量事实本身，不测量会轮换的标签。**
  **独立通则「解释即污染」（08-28 哨兵命名，manager 裁定单列不进六变体族）**：把判据向被观测方解释得越精确，判据的匹配串就越会出现在被观测的平面上——**改进来源与污染源是同一个动作，不可分离**（今天五个洞全部来自精确解释，四次自污染也全部来自它）。不归六变体族，因为**药不同**：六变体的药是"把测量写进句子止于测量"，这条的药是**结构锚定**（匹配串锚定行首结构；凡引用过原文的串必须另加位置/结构约束）+**引用登记表**（引用即登记，探测命中先对表，命中登记串→标"疑自污染"待结构确认）。间歇性自匹配（第二次抓屏已滚出可视区）比稳定自匹配更危险——稳定的当天现形，间歇的几周后才在真事故里显形。
  **附一个已知但未修的口子**：`hb.sh` 角色名是零校验的位置参数，九份档权限一致——**"心跳是会话自己写的"是约定不是机制**。今天没人越界写所以成立；哪天有人写个"团队同步"脚本替大家盖戳，它静默失效。
- **候选替代，两个都验过、都不进**：
  - `✻ … done HH:MM` 屏上那行：会话自己完成回合的时刻，外人顶不起来——**但没有日期，跨日分不清**。
  - **transcript mtime**（manager 提、哨兵验）：不受 `/effort` 等 pane 噪音影响 ✅，**但有自扰动**——探针对某岗起疑 → 发消息 → 它处理 → transcript 变新 → 下一轮"没事"。**指标会因为检查动作而变好，且专门对被怀疑的那些变好**（`pgrep -f wlo1proxy` 一族）。而"活着"的含义仅是"能应答一次 ping"——前端页面 11:23–12:14 正是这个状态。**只有发消息之前的读数可采信，而这条约束靠人记——靠约定成立的判据，跟 `hb.sh` 零校验同种。不进。**

**两条从这次验证里出来的通则（已验，进）**：
- **任何推导表都该内置至少一行答案已知的对照行。没有已知行的表，无法自证失效。**
  **强化版（08-28 三岗同日各自撞到后收敛，manager 裁）**：任何自动分类/自动判定的度量必须先配一条已知答案的对照行；**对照行不过，整张表作废而不是只作废那一行**；且**对照行必须在表内、同格式同流程，不能是外挂的一次性检查**——「外挂的哨可以被跳过，表内的行读表的人绕不过去」（评测官）。三个实例同形：哨兵被自己预写的对照行判成反应岗／数据表管理五次并列证据两次空跑（合并未发生）／外勤拿境外站测境内出口——**共同形状：用错的尺子拿到一个语法合法、可读、可信、且不会自报"我不适用"的结果。**同源互证盲（08-28 数据表管理，#78 收官深化）：**「先有那句注释，才有那个洞」——给人的判据（注释）与给机器的判据（规则清单）出自同一个错误理解时，它们互相印证、严丝合缝，"两边对不上"类检查抓不到一起错的**。能撞破的只有外部事实（本例=SQLite 自己的 `duplicate column name`）。**凡两份判据同源同写处，必须拿一个外部事实去撞一次，不能靠互校。**
  预检方向盲（08-28 数据表管理，守卫第五洞复盘）：**"预检"自带方向——问「会不会挡我们的路」时，每一行"放行"都被读成好消息；判「守卫全不全」必须换问法：逐行问「这条放行是我想要的吗」。只看拦截项的预检，对漏放行完全盲。**镜像同族：把退出码 0 读成"检查过且没事"——同一个动作，把只表示「没拦住」的信号读成「检查过且没事」。（该洞曾以"放行"字样在预检报告里摆了几小时，报的人与收的人都没问那一句——共同失守，两人各记。）
  监控工作题记（08-29，后台技术接哨兵）：**「两层都瞎的时候，谁都不知道自己瞎——是它先说了'我这层是瞎的'，这件事才有了下文。」**（零卡场景：启动闸四道全放行+哨兵全部外部判据全绿，两层同盲；修复始于观测方自曝盲区。）配套原则：**探针不得与被测系统同死**——kb_cards 三态（数字/0/null）各有诊断路径，索引坏掉时端点不 500。
  别名层教义（08-29 外勤，随 #92 定稿）：**「别名层翻译的不是词，是用户与法律程序之间的认知落差——且落差有方向：用户永远站在'程序之前'那一侧**，他描述的是眼睛看得见的东西（手上的纸、对方没打钱），规范词描述的是他还不知道要做的动作（申请执行）。**补别名该问的不是'这个概念还有什么同义词'，而是'处在这一步的人，眼睛能看见什么'**——前者造书面同义词，后者才是用户真会打出来的字。」配套纪律：别名带出处按概念不按用例、留出集封存+哈希承诺、"看起来重复≠实际重复（keyword 与别名互补）"。
  字节数恒盲（08-29 哨兵，第八窗实证）：**Next 的 chunk hash 与 build id 是定长的——它们变化时字节数结构上不变**，「按字节比 HTML」对这类改动恒盲（实证：404 壳窗前后同 12428 字节、md5 却不同，两处等长替换）。**失败与成功输出同一个数的判据要换介质**：**md5 的病当天量出（哨兵，不等下窗撞）**：build id 每构建必变 ⇒ md5 每次上线必不同——**字节数恒盲，md5 恒响：一个失败与成功同一个数，一个任何上线都同一个"变了"，相反方向一样弱**。正式判法：**存正文 → 变了就 diff → 拿 diff 出的字段当证据；md5 只作触发器不作结论**。**细化（第十一窗，哨兵四窗 10 观测统计：见 2 漏 8）**：可用版一句——**「字节数看得见'结构变了'（加/删字段、长度真变），看不见'值变了'（定长字段替换必然不动）」**——比"恒盲"准：它对结构变化是灵的，只对换值瞎。
  **封顶实证（第九窗，25 分钟后）**：三文件全部字节数一字不差而 md5 变——**连 `/api/v1/version` 自己都是 98B→98B（40 位 sha+ISO 戳皆定长）：专为自证而建的端点，按字节比同样失明；它能证明谁在线，只在你读它的字段的时候**。证据在字段，不在介质。配套教训：**「预告不变是预期，不是测量结果」**——手里有测量手段却在测之前给量定性，是自己把预期升格成了结论（哨兵自领全责，不对半分）。
  对照臂三级taxonomy（08-28 哨兵定稿，manager 采）：**负对照**证"不该出现的没出现"（防尺子太松）；**正对照**证"样本非空"（防没量到东西）；**同类正对照**证"这把尺能量这一类"（防对这类目标失明——ASCII 的 `<html` 匹配上不代表中文匹配得上）。**每条"应为 0"的期望必须配一条同类"应 >0"**：0 是最擅长冒充好消息的值，冒充得最像的时候正是最需要它说真话的时候。配套新约：**滚更开窗声明附内容直证字串清单（含期望值与三级对照），关窗照单独立复核。**
  收尾两句（08-28 哨兵，第四窗复核）：**「数据都对，错的都是作用域，而作用域从来不在输出里」**——修法：把作用域写进产物（资产 URL 写全路径、测量注明在哪一列）。**「测量照样错了，是措辞挡住了后果」**——"我核不到"与"你错了"是两句话：正对照管"知不知道自己在量什么"，这个措辞管"不知道时说什么"，后者是最后一道闸。另：**负对照检测不了空样本（不该出现的东西在空样本里也是 0），防空样本的是正对照**。
  第七例（外勤+哨兵合勘，跨环境型，机制经互驳修正）：同段 tmux 枚举在会话内正确、在 cron 里窗口名逐字节成 `_`——**计数半永远正确、名字半全错，表照常完整可读**。机制：**分界变量是 `TMUX` 不是 locale**——`TMUX` 在则以既有客户端沿用会话 UTF-8（LC_ALL 不参与）；不在（cron 正是）则新建客户端从 `LC_CTYPE` 推断，`C` 判非 UTF-8 即换 `_`。教训措辞：**「同一个工具，在会话内与在 cron 里行为不同，而差异由一个谁都没在看的环境变量决定」**。最锋利的一格：两人的测试各自都对（哨兵测的是 TMUX 已设列、外勤测的是未设列），**没有人测错，是覆盖面各差一半，而部署环境恰好落在会坏的那一半**。修法：locale 按调用钉死 + 测环境敏感行为必须两列都测（有/无那个环境变量）。
  配套半条（外勤）：**当被判的人说"我按规矩做反而更糟"，先查判据实际在测什么，再解释规矩**——那句委屈里带着判据真实测量对象的准确信息（「说得越准罚得越狠」→词表公开修复）。另立新规：**状态触发的在办任务必须附带「最迟复查日」**（条件管"何时该做"，复查日管"最晚何时有人看它"），落回任务卡时限轨道。 哨兵做名字→session 映射时，第一版方法在它唯一能验的那行（自己的 id）上答错了，整张表作废——**要是没有那行，它会以"映射基本不可用"的样子被交出去。**
- **`date -u -d "<本地时间串>"` 不做时区转换**——`-u` 让输入也按 UTC 解析，吐出一个**格式完好、差 8 小时、零报错**的时间戳。正确写法 `date -u -d @$(date -d "…" +%s)`。**这是 `date` 第二次这样咬人**（上一次 `date -d ""` 落进今日零点）。
- **附：manager 的检验方法也无效**——用 mtime 判"某窗口内有无写入"，而 mtime 只记最后一次；结论碰巧对，**一个无效的检验给出正确答案，比给出错误答案更危险——它会让人对方法本身增加信心。**

**顺带一个判据 bug 形态**（哨兵自曝）：数共因用 `grep -c COMMON_CAUSE`，把 ALERT 与 RECOVERED 两侧都数了——**系统好转时数字反而 +1**。**「指标在系统改善时恶化」是个很干净的自检信号。**

## 💳 显式欠账（加了新的一层，不代表旧的那层好了）

**2026-08-26 记**：用户案 `company-watch` 的监控，现在有两条路——

| 层 | 阈值 | 末端读者 | 状态 |
|---|---|---|---|
| **新加的旁路** cron `35 20,8 * * *` | 14 小时 | **邮件到 manager**（非 Claude 会话通道） | 今日落 |
| **已在跑的** `sync-monitor.sh` `40 8,20 * * *` | 30 小时 | **设计上没有读者**（`USER_ALERT=0`，只写 flag 与内部日志，而那两个文件的唯一读者是哨兵的 session-only 巡逻） | **未修，显式欠账** |

**新的这条是旁路，不是修复。** 它更快、有真读者，**但 `sync-monitor` 那条链仍然是一个末端无人的机制**。
**记这一条是因为**：加一层更快的东西上去，旧的那层会**看起来**也一起好了——整体指标变好了，而没人会去问"变好的是哪一层"。

### ⚠️ 邮件通道的空缺：**它离被错误地补上只差一个文件**

案件线告警 cron（`35 20,8 * * *`）**已在 crontab 里跑、每轮留痕**，但 `.alert-mailto` 未配置，
脚本按设计 **拒发并记 `MAIL_TO_UNSET`**（不猜地址、不 fallback、不因未配就关判据）。

> **它现在是空的，不是因为没人想到填，是因为唯一唾手可得的那个填法是错的。**

手边最现成的地址是 `watch.py` 里硬编码的 `ALERT_TO` —— **那是用户本人的邮箱**
（company-watch 的公司事件通知本就发给他）。**内部监控健康度绝不走那条**。
**下一个想帮忙的人会花三十秒把它"修好"，而修好的方式恰好是拿用户的邮箱当内部监控通道。**

**正确解是一个内部收件人**，不是"随便找个能收信的地址"。
**唯一的例外**：产品负责人本人明确说"发我主邮箱、我认这点噪音"——**那是他的选择，不是我们的默认**。

### ✅ 2026-08-27 已通：`hubaiyipku@163.com`（实测 `MAIL-OK`，**走的正是上面那条例外**）

**证到哪一步，要说准**：
- **通道本身已实测**（`MAIL-OK`，三封邮件主题与正文原文已导出留档）。
- **但三判据在生产上从未真正触发过**（部署至今 `lastrun_sched` 一直 `LANDED`）。
  所以「配上地址后挂起的告警会补发」这个性质，**是夹具证明的，不是生产事件证明的**——
  外勤原话：**「我不拿『没有东西补发』去冒充『补发成功』。」**
- **例外注释写进了 `.alert-mailto` 文件本体**（不是 README），读取时跳过注释行。
  理由：**会改这一格的人打开的是这个文件，写进别处的说明只有正好去读别处的人看得见。**

**原欠账记录（保留）**：

**它就是 `watch.py` 里硬编码的那个 `ALERT_TO`——用户本人的邮箱。**
**它合法不是因为规则变了，是因为产品负责人在被告知"你会多收几封基建噪音"之后，本人指定了它。**

> **这不构成"可以用用户邮箱做内部通道"的先例**——`watch.py` 的 §2c 边界不变。
> **换人、换项目、或此人未再明说时，这一格重新变回空的。**

**理由**：下一个人看到"这里填的是用户邮箱"，最自然的推论是"原来可以这么填"。
**一个凭例外获得的合法性，如果不写明例外是什么，就会被当成规则。**

**配套要求**：两类邮件现在进同一个信箱（`watch.py` 发的是**他案子的真事件**，我们这条发的是**监控本身坏了**）。
所以我们这条必须带固定主题前缀 `[lawer-ops]`、主题里写明是哪一条判据、正文第一行声明"这是内部监控告警，不是案件事件通知"。
**第一类是他必须立刻看的，第二类不是——混在一起，第二类的噪音会淹掉第一类。**

**同族的另一处，已在设计里避开了**：`MAIL_TO_UNSET` 拒发时**不置抑制标记**。
若顺手置了，等地址配好之后这条告警会因为"状态没变"而**永远不再发**——
**一个正确的拒发若顺手写了状态，会把自己变成永久静音。**

**`USER_ALERT` 维持不开**（哨兵、lawer、manager 三方一致）：**一个从未被真实触发过的通道，第一次触发就发给用户，等于拿用户当测试。**

**同族的判准**：`有人读 → 最多损失 1 天；无人读 → 无上限`（lawer）。
**一个检测机制的价值上限，不是它的阈值，是它的输出有没有人读。** 阈值决定"多快知道"，读者决定"会不会知道"——**后者是 0/1，前者只是快慢。**

## 🔁 全线重启 runbook（重启会静默地消灭监控，必看）

**背景**：2026-08-26 09:25 全线 25 个会话同刻重启。重启**静默消灭了所有 session-only 的巡逻**，
监控空窗 8.5 小时——**是 manager 发现的，不是监控发现的**。哨兵原话：
**「我不发心跳和我没被叫醒，长得一模一样。」**

重启后必办，缺一项监控就是瞎的：

| # | 动作 | 谁 | 为什么 |
|---|---|---|---|
| 1 | 各岗写第一条心跳（用 `caiyuan-ws/heartbeats/hb.sh`） | 各岗本人 | 探针的 mtime 判据有三段前置：**新位置真实写入过至少一次**，mtime 才代表"这个人写的"。没写＝这一岗对探针不存在 |
| 2 | **哨兵重起 `/loop`** | 哨兵 | 巡逻 cron 是 session-only，重启即死。不重起＝从此不再巡逻，且**不报错** |
| 3 | 确认存活探针 `probe.log` 仍在增长 | 外勤 | 它是唯一一条"哨兵死了会有人知道"的路径；其余全是临时的 |

**取证时效**：`重启会清空 pane scrollback`。2026-08-25 前端窗口悬停 7.5 小时，重启后
`capture-pane -S -20000` 一行都挖不出来，**连当事人自己当天的操作记录都没了**。
所以**发现异常的当下就得 `capture-pane -p` 存盘**——等重启后再来查等于没有现场。

**为什么这张表存在**：2026-08-25 立的执行物——**任何监督类角色/机制上线时必须显式回答"谁监督我"**。哨兵第一个作答：**「没有人。已知风险，未对冲。」** 并给出三条实证（当天两次撞限共 6.5 小时全线无人发现／cron 静默到期／自己的记录差点被一次 checkout 吃掉）。

**已知终点（显式承认，不再往下加层）**：拟由本机 crontab（与所有会话无关）在每次跑完时比对哨兵心跳 mtime，超 45 分钟写入 `sync.log`；**而本机 crontab 本身无人监督——链条在此结束**。**结束的地方要显式承认，不是假装它不存在。**

## 🚀 待发车（2026-08-26 14:20 · 接手第一眼看这里）

**滚更包已签技术闸，前置全闭，只差产品负责人拍时间窗。包不动、线上不动。**

```
ws/hotfix-leverage = fbafe4e   （3 提交，tsc 干净，1486 绿，对照 main 裸树 1481）
  6b4ace0  危机轮停用热线去重      ← c009c1c 的登记册硬前置，不是搭便车
  a90925e  杠杆闸来源判别          ← 拿掉线上那个活跃 L1
  fbafe4e  留痕（被剥原句入 notice）← manager 加的，理由见下
同车：前端 PR #62（CALC_FAILED 空字符串导致用户面白屏静默）
```
**为什么带留痕**：这道闸的失效形态恰好是「什么都没发生」（剥空→整段被吞→回落兜底，用户看到一段正常话术）。**不带留痕 = 上线一道防线却无法知道它是否在工作**——那正是 `docs/OPS.md` 那句"第一层已上线"的失败方式。

| 前置 | 状态 |
|---|---|
| 线上库备份 | ✅ `/data/lawer/backups/pre-rollout-20260826/`（`.backup` 非 `cp`，integrity ok，8/1/1 与线上一致） |
| 迁移安全性 | ✅ A–F 六项实测：幂等、老数据零改动、`kill -9` fuzz 50/50 收敛、8 进程并发 BUSY=0、**无需停机**。⚠️ **不回滚**（37 个 `db.exec()` 无事务）——本次安全是"改动足够简单"给的，不是框架给的 |
| 外键 | ✅ `users1/cases1/threads1/messages8/action_items7`，`foreign_key_check` 空 |
| backfill | ✅ dry-run 与实时记账**逐单位一致**（102 = 102），`--apply` 由 manager 另行下令 |

**滚更后硬要求（不是建议）**：① **主动打一个请求触发迁移**并确认 `referral_offers` 存在——迁移是懒触发的，**失败表现是"某个用户的请求 500"而不是"服务起不来"**，没人访问时你不会知道成没成；② **主动 `restart` 一次服务当场验启动期**，不把这件事留给凌晨。

**⏰ 明晨 08-27 03:30，那台服务器会重启**（NBDpsy 验证开机自启，同一台机器）。已决定**不改期**——运行期问题 6.5 小时够暴露，**启动期问题只有重启才暴露**。已挂系统 cron（非会话级）`25-45/2 3 27 8 *` 共 11 轮守望两站，日/月钉死 + 脚本内时段闸双保险。

---

## 📌 证据与工具的存放规矩（2026-08-26 立，当天差点出事故换来的）

**当天实况**：S08 两跑的唯一底稿只存在于一个一次性 worktree 里，manager 裁定删除该 worktree，
删之前执行者顺手拷了一份到**会话级临时目录**。随后评测官 `find /home/roots /data` 全机零命中，
报「两份已提交结论的底稿灭失、不可复核」。**实际两处都在**（`/tmp` 那份 + 后补的归档），
sha256 逐字节一致。**没出事靠的是一个人的谨慎，不是一个机制。**

| # | 规矩 | 为什么 |
|---|---|---|
| 1 | **跑批可以在一次性目录里进行，产物不许只落在那里**——每批产物必须同时落到一个非一次性的位置 | 隔离跑批是对的（离线测量须在可指名 SHA 的快照上做），错的是把证据产在一个**设计上就要被删掉**的地方 |
| 2 | **归档和跑批同生共死**，不靠人记得：`run-batch.sh` 结束即复制到 `caiyuan-ws/eval-evidence-archive/`（不在任何 git 工作树内），失败即写 FAILED | 只归档不改落点，下次仍然靠人记得拷 |
| 3 | **产出证据的工具也要能被找到**，不只是证据本身 | **一次性的工具产出了不是一次性的结论**——那些数字将来只能被相信，不能被重新推导。已落 `scripts/eval/forensics/` |
| 4 | **删除任何工作树／分支／目录之前**，先问"这里面有没有只此一份的东西"——**产物和工具都要问**，且必须在**全机**范围回答 | 见下面那条机制 |

**⚠️ 为什么"范围"特别容易搞错（具体机制，不是告诫）**：
**linked worktree 的分支属于宿主 clone，不属于它自己那个目录。** 目录删了、ref 却在别处活着；
`git branch` 在哪个 clone 里跑，答案完全不同。**在有 linked worktree 的仓库里，"当前 clone"这个默认范围本身就是错的默认值。**

**归档入口（全线可用，不只评测线）**：
```
sh scripts/eval/archive-batch.sh <产物路径> [更多路径...]
```
手工跑批、手工取证的人**加一行就行**。`run-batch.sh` 已改为调它，不在两处各写实现——
**两份实现里迟早有一份是坏的，而坏的那份的症状（"归档了但找不到"）与没归档一模一样。**
四条线都产出过需要留底的东西（变异矩阵、巡逻取证、三组测量、全部跑批），
**只在一条线上通知，等于让其他线各自实现一遍——而自己实现的那份，就是下一个只存在于一处的东西。**

**"pushed" 是过程信号，不是结果信号（08-27）。规则成立；当天的"实例"不存在——两次误判方向相反。**
- 上午一次 Python 编辑断言失败，我读成"commit 无改动、push 推的是旧东西"。**实际 `git add` 与 `commit` 照跑，那次 push 是真进度。** 下午同一文件第二次编辑，`--stat` 只显示 2 个文件，我又读成"规格没进去"——**实际规格早在上一次就进去了。**
- **两次都是没看 `--stat` / `git log -- <文件>` 就下结论**：一次把成功读成失败、一次把失败读成成功。**缺一个观察不会让你朝固定方向错，它让你朝任意方向错。**（哨兵）
- **由此暴露的核验不对称（哨兵自查）**：它对所有正面声明（"改好了""在跑""已推"）都去读源码/抽屏/grep，**对我的自我指控（"我那条没落地"）一个字没核就拿去当前提**，还在上面盖了一层系统性推论。**一个自我不利的声明看起来有代价、因而显得可信——但代价高不等于为真。核验的触发条件是"这是一个要拿去当前提的事实主张"，不是"说这话的人有没有动机说谎"。自陈失败也是事实主张。该问的那句是"你怎么知道它没落地"。**
- **启发式 vs 判据**（哨兵）：「一个能解释全部的解释可疑」是**启发式**，用来决定去不去查；「能不能逐条拆开验」是**判据**，用来决定查完算不算数。**别用前者代替后者。**
**别问"推送成功了吗"，问"这行字现在在文件里吗"。**
**普查方法两版，第二版才闭环**（哨兵两次指出）：
- **第一版（key 为源，不闭环）**：从记忆列 23 个关键词去 grep。**两个洞**：① key 太严报"缺"会触发调查、**key 太松报"在"会终止调查**——23 条"在"只验了"key 出现"，没验"我想记的那句在"；② **清单来自记忆，和"我以为我写了"是同一个出问题的环节**——一条既没落地又没记进清单的，普查报"不存在"而不是"缺失"。
- **第二版（diff 为源，闭环）**：对今天每条 docs 提交，取它 **`+` 的每一行**，逐字 `grep -F` 当前文件。**来源与记忆无关。** 08-27 结果：133 行 → 115 在、**18 不在——全部追到后来的主动改写**（撞限初版→重写、批次状态行 派出→进行中→合入、屏差半句撤回、attest 行更新、候选替代重写）。**零条无法解释的缺失。** 另随机读三段全文，是想记的那句。
- **key 太松那一侧的后果没人走过**——"缺"触发调查，"在"终止调查，**所以只验 key 的普查天然偏向漏掉真缺失。**
**共同点（哨兵）：把一个「过程完成了」的信号当成「结果达成了」的证据。** `pushed` 是过程，`mtime 变了` 是过程；`那行字在文件里`、`生效值是三个词` 才是结果。
**为什么它今天最要紧**：今天所有翻出来的东西最终只存在于册子里——心跳会滚掉、tmux 会重启、会话会结束。**记录"我们学到什么"的系统，它自己的写入路径必须被验证过。**

**「核过」的伴随检查（哨兵，08-27）：我读到的东西定住了吗。**
探针脚本同一天行号 91 → 97 → 101，三次读三个位置。mtime 距读取只有几十秒的文件，**不是一份证据，是一次采样**。哨兵 15:07:08 读到"撞限暂停仍在"是真的，外勤 15:08:18 写入"已删"也是真的——**分歧不在事实，在时态**，而它没给断言标时刻（说的是"现在还在"，能证明的只是"15:07:08 时还在"）。**第三方直接读原件能解分歧，但对一个正在被改写的对象，那一读也只在那一瞬有效——记下读取时刻。** 它自己的输出里已有信号（"15:07 有人动过这个文件"），被它当旁注消化掉了，还补了半句"但动的不是这一行"——**那半句就是在给自己解释掉一个反证。**

**同源规矩（2026-08-26 立）**：
> **任何「不存在／零命中／全部没有／从未」的结论，必须在同一句话里写明搜索范围。**
当天此条在四个人身上各失守一次，**其中三次是立过或刚引用过它的人犯的**——
**范围是查询的默认参数，而默认参数天生不进入意识。**

**⇒ 解药（能力级，比上面那条规则级的可靠）**：
> **凡是要写进结论的「零／没有／全部」，那句话必须由一条能被别人复跑的命令产生，并把命令原样贴出来。**
**命令贴出来了，范围就自动在场**——读的人一眼看见 `find /home/roots /data`，就会问"那 `/tmp` 呢"。
当天两次范围失守，**都是别人从贴出来的命令里看出范围不够的，不是当事人自己想起来的**。
**让范围可见，比让人记得写范围更可靠。**

**为什么必须是能力级**：四次失守里有一次，是立规矩的人**在同一天三小时内先立后犯**，
而且立的时候还专门反思过"范围里混了三种不同的东西"。**它不是知识问题，靠自觉执行不了。**

**同族的另一个默认参数**：**shell 的分词规则**。同一行 `$VAR` 在 zsh 下不分词、在 sh 下分词，
而脚本由 `sh` 执行、仿真跑在 zsh 里。**此时"修复测试失败"可能是在破坏生产**——
测试红了，人的第一反应是去改被测代码，而不是去问两个环境的默认值是不是一样的。
解法不是选一边迁就，是消掉差异（用 `find -exec ... {} +` 让文件名走真正的 argv）。

## ✅ 收口（单独记，别埋在长信里——后台技术建议，08-27）

| 事项 | 状态 | 证据 |
|---|---|---|
| **ISSUE-04 整卡不重复** | **两侧收口**（08-27） | 原语 `cardOccurrences(text,phones): CardSpan[]`（`63004fc`）；判据逐次累加、判 `splitCrisisOpener(t.text).body`（裁定②首段不计入）；出口闸吃 `.slice(1)` 保留第一处；`cardShapeAgrees` 改钉原语；第三态 `hotlineStripDeclined`（检出重复但明示放弃）。评测官七条 **7/7**，(a) 守卫 7 条复活 0 条，变异 A/B/C 各自报红。**命中率口径 1/46**（"从未"已撤） |
| **裁定②恒产出（干净即无声废除）** | 收口（08-28 `d7f24c8`，评测官） | 失败 17 条拆两类：意图即无声的 3 条整段反转+来历；只拿 `[]` 当编码的 7 处意图不变只改编码。断代点三：**断代前这两条 L1 的绿从没被写出来过，两侧 L1 条数不可直比**。顺带修掉被裁定暴露的恒真断言（`length>0` 恒产出后永真）。两态：退回无声 10 红 / 无禁用号退回沉默 1 红 |
| **零付费内容首次真实上场** | 收口（08-28 `6941c48`） | 补跑两跑 PASS；`crisisPaid` 四轮全 `null`（判据事前写死：危机层必跑⇒必 null，缺失=没接上）。L1 18 条 0 红，**空转绿已转真绿** |
| **裁定④ judge 条目主键化**（08-28 裁） | 进行中（评测官） | 裁定②只落了机械半边，judge 条目文本仍按旧规则投票且**那句话是三处主键**（tiers/findRuling/元测试）。裁：稳定 id 做主键、文本纯展示并补「首段那次不计入」、历史裁定走逐字别名表、断代点四。**改一句话不该是一次主键手术** |
| **土八鼠 S08×2 重跑** | **✅ 已跑**（`ff0fa12` 批 + 补跑 `6941c48`）（读数器已入库 `read-rename.py`，`SELF_NAMES` 三名同数只增不删——只数新名会漏掉旧名残留，那是改名最可能的失败形态） | 等 ws/backend 合入新名，后台技术直接 ping 评测官 |
| **D15 接线 + 两态验证** | 收口（08-27 `e1c2df7`，评测官） | 先独立跑后台技术收窄的 14 条再接线；「受益方」判准写进代码注释；8 条「你要付」必判 / 6 条「你能拿到」不许误伤（含「一次性补偿 5 万元」）；接线改回通用口径 → 9 红 |
| **ISSUE-07 判据同源** | 收口（08-27） | 底层三函数不导出、`userSaid` 去默认值、唯一入口 `leverageSubject`；`leverage` 三态载体落归档；R3 绊线 |
| **sidecar issuer** | 收口（08-27 `24d2f85`） | 改必填、缺则 400、两层守；变异 B 补样本 |
| **`ws/backend` behind-main** | **0**（`63ce33e`，**15:51:16 读**） | 1742 绿 / tsc 干净 / sidecar 26 passed。**带时刻：保质期到下一个人 push 为止** |

## 🔀 ws/backend 现状（2026-08-27 15:3x，后台技术）

`ws/backend 93d932f`：**已合入 origin/main（55 提交，含今日批 0/1/2a），behind=0**。app 79 文件 1742 绿、tsc 干净；sidecar 26 passed。
五处冲突全是 A84 形状（main 侧那三个产线文件只被昨日 cherry-pick 的滚更包副本动过）；**逐文件 `diff <(git show origin/main:F) F` 核"main 有而分支没有"的每一行，全部是当天主动替换的——main 侧零丢失，核过不是推的。**
**含义**：下次大滚更 = `ws/backend` → main 一次合并，不再是两条线各推。**仍等产品负责人拍时间。**
**⚠️ 范围声明（评测官）**：**今天所有 agent 侧验收（D14/D15、杠杆闸机制版、ISSUE-04/07、两态、变异矩阵）验的都是 `ws/backend`，不是线上。** 线上 `476ed69` 只有今早验过的杠杆闸来源判别。**引用今天这些验收的地方一律带 `ws/backend` 范围。**
**大滚更前置（08-28 更新）**：
1. ~~S08×2 验「土拨鼠劳动仲裁」改名行为面~~ **已跑**（`ws/backend@cee46fb`，L1 12 条 0 红，自称 0 次进正文，结论措辞「本批未观察到影响」不写「无影响」）。**但被新改名覆盖**：品牌名再改「土八鼠」（用户 08-28 拍板），**土八鼠进 `ws/backend` 后 S08×2 重跑一次**（~15 分钟）。
2. **合入顺序（评测官，08-26 警告的第一份实证）**：S08 轮1 模型说了「这个平台属于 NBDpsy 体系，那边有专业的心理咨询」——**D14 要求的行为**，被 main 上未清的 `'NBDpsy 推销': 'L1'` 判挂（ws/backend 已降 L3）。**目前没炸只因 D14 实现也不在 main。`ws/backend`→main 必须整体合，不能只合一半——先合实现后合判据修，中间就是 L1 假红窗口。**
3. **「干净即无声」改恒产出（manager 08-28 裁）**：两条 L1（零付费内容/禁用号零出现）合规时零输出，「通过了」与「根本没跑」在成绩单上同形。改为恒产出并分两种空：**卡里没有禁用号 ⇒ `na`（无从判起）；有而零出现 ⇒ PASS 写出来**。旧行为是被测试钉住的刻意设计（评测官已核并回滚过一次）——**改时测试断言反转、来历写明（改的是语义不是当年写错），成绩单标断代**。

**两条同日通则（后台技术自撤时提炼）**：
- **「三处一致」和「三处都是最新」不是一回事。** 范围要跟着数字走（昨日立），**时刻也要跟着数字走**——一个不带读取时刻的"现在是……"，保质期只到下一个人 push 为止。
- **一个不必要的反驳，会把它附带的错误也一起带进结论里。** 它用一个过期事实去反驳派单前提，而真正成立的那半（默认值不该存在）根本不需要那个反驳。

## ⚠️ 僵尸心跳档：完成条件与判据（**不许用 git 查**）

```
僵尸计数 := find /home/roots -path '*/docs/tasks/heartbeats/*' -name '*.txt' | wc -l
完成条件 := 1   （只剩 caiyuan-ws/frontend 那份未版控的 前端.txt）
2026-08-26 14:20 实测 = 37
```
**`.gitignore` 加了 `docs/tasks/heartbeats/*.txt` 之后，`git status` 对所有工作树永远报 0。** manager 写下这条警告，随后自己采信了一份 git 查法得出的"全域 0"——**实测是 47**。
**"清干净"不是终态，"不再产生"才是**：只要还有 detached / 孤儿工作树，从它们身上开新树就会再物化一套。

---

## 当前状态（2026-08-26 09:50 实测）

**全部为当日实测，非推断**：

| 层 | 状态 |
|---|---|
| 服务 | law.nbdpsy.com **HTTP 200**；lawer-app / lawer-sidecar / caddy 全 active，起于 08-25 14:12；近 24h **零错误日志** |
| 代码 | 线上 SHA **`00ce720`**，本地 main **`1c05f28`**，**线上落后 13 个提交**，其中夹着 398 行真代码（`referral_offers` 那批）。佐证：线上库 `referral_offers` **表不存在** |
| 用量 | `messages = 8`（4 轮）、`users = 1`、`threads = 1`，**全部是 08-25 06:13–06:27 的验收测试**。上线 19.5 小时，**零真实用户** |
| 账本 | `token_usage = 0`、`gongdao_ledger = 0` —— 4 轮真实对话烧过 token，账本一行没记。**P0 判定成立且未修** |
| 分支 | `ws/backend`、`ws/referral` 均已 **100% 合入 main**，无孤儿分支 |

**产品层的真实缺口（用户最在意的一条）**：D14 品牌推荐——spec 已拍板在 main（`c9040c3`）、
`referral_offers` 表代码已在 main，但 **agent 侧一行都没写**（五 scene 触发 / 查 `shouldStopOffering` /
写表行 / 报 scene / `NBDPSY_BRAND` 抑制闸按 D15 改造）。
**所以广告到今天一次都没投出去过。** 已派 WS2，今天的主菜。

**今日在办（08-26）**：① S08 两跑（WS2，清 OPS.md 放行闸）② D14 agent 侧实现（WS2）
③ 账本接线（WS2，`orchestrator.ts:621` 收敛点）④ 存活探针（外勤，**窗口作废改为立即**）
⑤ 心跳迁出版控（manager，已提交）。三件做完**一次性滚更，不零碎滚**。

---

## 上一日状态（2026-08-25 收工）

**线上**：law.nbdpsy.com 运行中，引擎已滚更（`00ce720`），危机轮**第一层**修复已上线。NBDpsy 既有六站零影响。

**锁住未放行**：危机轮**第二层**修复（裸短语判别）已在 `ws/backend` 主干，**但 `docs/OPS.md` 放行闸未清**——差 S08 两跑。**规矩：主干上有代码 ≠ 允许上线；条件未满足的回退该改动后再滚更，不许顺手带上去。**

**明天第一件**：**S08 两跑**（第二层唯一承重的证据）。WS2 的 `docs/tasks/heartbeats/后台技术.txt` 有它自己那一份。

**今日新增的三个落点（不依赖任何会话）**：
- `docs/lessons/A系教训册.md` —— 89 条，**每条从今起标"执行物：有/待造/造不出"**；标"有"须附一次实测（那是定价，不是验证）
- `docs/design-notes/` —— 27 份设计稿，**记的是被否掉的方案**（commit 记得下结论，记不下否掉的那几个）
- `docs/eval-evidence/` —— 40 件评测证据（此前全部在 gitignore 目录里）

**等用户**（都不阻塞）：ANTHROPIC_API_KEY（仅影响中/高配，标"待开发"）、PAdES 电签证书、三项复用 NBDpsy 值的产品拍板。

**今日拦下的、会真实伤到用户的四处**：①知识库路径靠 cwd 解析→隔壁真有另一份，差一层目录就静默加载错版本法条；②检索系统性惩罚精确标注→赢了官司只差"申请强制执行"四个字的人，拿到的是公司注销和保密协议；③热线去重"见号码就全删"→危机轮出现"号码放这儿：（空）"；④杠杆闸剥掉共情复述→模型越认真接住用户，整段回复越可能被吞光。**②③④ 均已修或已锁，①修法在队列。**

## 🧑‍💼 首位真实用户全量体检（08-28 晚，产品负责人本人注册使用，一次交下 14 项）

| 优先 | 项 | 归属 | 状态 |
|---|---|---|---|
| P0 | 登录态刷新即丢（cookie/session 持久化） | 后台技术 | 派单 |
| P0 | **真实账户流水页混入 15 条演示账目**（记账信任面） | 后台技术 | 派单 |
| P1 | 登录改造：单因子（手机或邮箱其一）；新手机号首用才加验邮箱；邮箱注册；Google 一键登录（复用 nbdpsy） | 后台技术 | 派单 |
| P1 | **向量引擎中转站接入 claude-opus-5**（nbdpsy 已有代码+KEY，用户已充值，"Claude 冗余就是给土八鼠设计的"）；**对用户开中配前须评测官 Claude 路由批绿+manager 放行** | 后台技术 | 派单 |
| P1 | 邮件发件人名→「土八鼠」（先试 display name；备选 tubashu.vip 阿里邮箱）；全套邮件模板按主视觉重做（验证码行独立/放大/加粗/勃艮第红；**出站敏感词纪律不变**） | 后台技术 | 派单 |
| P2 | 存储审计表（案件记录/材料/AI 回复：存哪、哈希、TSA、调用路径+缺口） | 后台技术 | 派单 |
| P2 | 接入卡加 WorkBuddy/Trae 话术；MCP 省钱引导文案 | 前端页面 | 队列 |
| P2 | 用户 API key 装载真实案件（key 在 user-case/.secrets/ 600） | 援助律师 | 进行中 |
| 立项 | **管理后台（仿问爻）**：含护照实名（护照+手持自拍）人工审核台 | manager 出方案→派单 | 方案在写 |
| 记录 | 域名 `tubashu.vip` 备案中，备妥后土八鼠全业务迁入 | — | 等备案 |
| 敕令 | **判决文书只用官方源**（"阿里云和爱企查都不可靠"）；D18 定案=文书网官方+接力+保活；阿里云试用四判据两不过一无法测，0.05 元收官不买 | 外勤 | 闭卷 |

## 里程碑（2026-08-28 · 滚大批两连上线 + 账本闭环 + 重设计立项）

**两窗口两滚更（均全链验证含二次重启，哨兵窗口口径：显式开/关+预计时长+硬上限自动过期）**
- 窗一 09:18–09:25：`476ed69→06c6a3d`——前端四批 + 土八鼠改名 + logo 落位全部见线上。
- 窗二 09:52–10:01：`06c6a3d→ff8a3b9`（ws/backend 整体 fast-forward `0973809` + #70 favicon 原图化）——**D14 节点推荐 / 公道值账本 / 危机闸二层 / sidecar issuer 必填上线**。GitHub 直连超时走 bundle 老路（ref 名按 `list-heads` 实际取）。

**账本 P0 闭环（08-25 立的"收费基础是空的"到此收口）**
- `model_rates` 35 行播种（此前 0，静默兜底 1/3 价）；backfill 试算 522 → `--apply` 补 5 轮 → reconcile 非空表 rc=0。
- 后台技术独立复算：逐行一致，厘合计 519375 同。**「522/174=3.0000」——先播种再补记在账面上自带可验痕迹**。
- 途中拦下一次事故：产品负责人直接下令 `--apply` 时费率表还空，后台技术当场算出 3 倍差报给本人再等指令——「在他知道 3 倍之前跑才是失职」。
- **"在记"的判据定为「待记账缺口恒 0」**，不是"token_usage 有行"（后者只证明补记落过）。08-26 后暂无新流量，首轮抽查待流量。

**合入闸（评测官）**
- 补跑批钉 `5dbca16`：L1 28 实例 0 红、archiveInjection 两态真数、crisisPaid 接上、⭐首次落非零候选（S08 是 15 剧本唯一恒零候选 0/52，此前各批全跑 S08）。**放行，不叫"通过"**——四格未闭合逐条处置：判官撤计数职责（裁：可数的量一律机械为准）；naKind 一行修；⭐报红分支登记变异重放；S03 三条 L2。
- **S03 三条定性「一直如此」**（27 份历史转录、6 个线上祖先 SHA 全红，判据钉死只让行为变，排除分支引入）→ 转后台技术排期，不追溯放行。G4：**「宪章核心从来没红过≠一直被满足，只等于从来没人量过」**。
- 新教训入册：**「跑过这个剧本」≠「跑过这条判项」**（S03 转录 36 份 vs 三条判项成绩单 4 份）；「失败输出≠失败」第四次（gh pr merge 收尾报错但已 MERGED）；pkill -f 自匹配第三次（前端立规：pgrep 核对 PID 再 kill）。

**评测侧下午清账（08-28，评测官主刀，manager 逐裁）**
- 判据宪法级裁定链：「你别签」语义裁定（**违规本质=夺走决定，不是出现某词**；未替决改条件式）→ 决定权交还丙案（触发面/交还面两个事实各配各域，甲案 17 新红全是 §5 设计行为=死刑）→ 交还动词表删「判断」+剥引用（三条历史 L1 真红作正对照 3/3 仍红、零漏杀；一条 L1 假绿〔引语话术当交还〕就此闭合）。
- **交叉校验恒产出上线**：登记表+基线手签+四条判读（对不上=0 只触发独立性核对不发绿；已知基线不重复报红——「经常触发的闸会被调松，调松是一次性的、永久的」）。首日实跑：S08 对已签基线不噪红、S15-顶压 0/15 正确落"下限"分支。
- **管道守卫**（净化原语强制走查，豁免表=债务台账）上线首日咬作者「同上」、次日咬未销账的台账本身；债逐条开庭：**债#1 还清**（剥引用，判决性实验坐实生效）、**债#2 驳回**（记债前提被实测证伪——「同一味药不治两种病」）、**诚实税三条暂缓挂网**（零观察+有网=记档等实例；「配料常见≠缺陷常见」5% vs 0 例）。余 L2 两条+未核实三条列队。
- 当日入册通则：跳过比失败安静／哨失效与哨没响同形（夹具必须入仓）／只防过度不防缺席是半个哨／名字对断言对颜色对其实什么都没测（手工裁剪复现串未必复现现象）／那句话会是对的同时是误导的（无回归证据≠生效证据）。

**重设计立项（用户 08-28 拍板启动，供拍板三件套已上公链）**
- 用户指令：品牌调性=愤怒的卡通土拨鼠；移动端为主、PC 为辅、两端单独设计交互；先调研→写 PR→原型→公链→点头→动工。
- 两路调研（Sonnet）已结：形态推荐 A「案件驾驶舱+chat 兜底」（Ada/DoNotPay 底层皆结构化、里程碑时间轴较线性进度条诚实、mascot 需事件系统喂）；开源参考 Astroship/Open Collective/Deno。
- 三件套：产品方案（情绪地图+四硬禁区：愤怒永不对内/危机轮零卡通/低调模式零品牌暴露/不做愧疚驱动）、移动六屏+桌面三栏原型集、落地页案卷方向高保真稿。**等用户拍板：形态 A？吉祥物 5 姿势资产来源？原型意见。**
- favicon/TubashuMark 已全量改用户原图裁切（#70），手绘残留 0——「一律」的字面就是一律。

## 里程碑（2026-08-25 下午 · 上线 + 滚更 + 四类结构性发现）

**已交付**
- **law.nbdpsy.com 上线**，引擎滚更 a53c4cc→00ce720（停机 2.8s，NBDpsy 既有六站零影响，Caddy 全程未重启）
- **D14/D15 落地**：品牌推荐策略入 spec；`referral_offers` 频控表合入（PR #61）；charter 改稿待审
- 知识库：调解仲裁法单点事实源卡（PR #59）+ 旧副本改引用（PR #60），**单点事实源真正成立**
- **第五闸生产首次开火**并自动补齐原文；**诚实降级范本**入库（含"它为什么还不可靠"）

**四类结构性发现（按严重度）**
1. **知识库路径靠 cwd 解析** → 隔壁真有另一份 index.json，**差一层目录就静默加载错版本法条**。修法：改模块自身位置解析 + 启动自检不一致则**拒绝启动**。（跑批未受污染，已穷举核实存证）
2. **账本未接通（P0）**：`recordTokenUsage`/`gongdaoSettle` 全仓零调用——**收费基础是空的**。连带：**对账器在空表上永远报绿**（掩盖层，优先修）
3. **检索系统性惩罚精确标注**：泛 keyword 拿满分、精确 keyword 零命中；对照实验坐实（同卡换关键词串→从 15 名外升第 1）。**与"诚实税"同族：系统在惩罚我们自己要求的正确行为**
4. **主线路径零覆盖**：⭐ 的 S1（回头客/档案非空）分支从未被任何测试执行；12/15 剧本单轮，**构造上不可能触达**。**我们把主线当支线测了**

**新立专项/需求**
- **诚实税专项**（判据惩罚诚实表达，12 条种子清单，judge 侧 45 条 mustNot 逐条定边界）
- **档案事实证据分级**（用户自述/书证/对方认可/文书认定四档 + 关键节点强制复核）——解 S1 错误自我强化，且是法律产品本分
- **深会话剧本**（≥5 轮，自然长出档案）——所有跨轮机制（含 D14 频控）目前"不可验证"
- **别名词表主线**（口语↔法言法语）——**要求用户说对词才能找到法条，就只服务已经懂法的人**

**修复顺序（安全优先，不可颠倒）**：注入产物留痕 → 空手感知（判据改"卡够不够格"）→ 惩罚精确标注 → 地名税 → 带上下文 → 别名词表

## 里程碑（2026-08-25 · M1 发版+出厂检验通过）
- **M1 律师引擎正式发版**：基线 175cad3（一夜七 SHA：8101783→031a6c0→acb2133 前置→4eec457→4e10b7c→7a4c112→c0680d3→175cad3），两签制（评测官判定+代理转录级二验）
- **全量 15 出厂检验通过**（真实 L1 15/15 净），部署切流已批——law.nbdpsy.com 等 DNS A 记录（用户侧一条记录）
- 服务器就绪：lawer-app/lawer-sidecar 运行中、备份 timer 验证过、既有 NBDpsy 五站零影响、凭据卫生两轮机器核验
- 上线后第一迭代窗（有实样本）：判据全轮全文口径（2 例）、渲染留痕、闸归因精度、judge 升级（含 L1 类错误 2 例）、污染句级隔离、密度首批四项

## 里程碑（2026-08-23/24）
- **M1 发版关闸**（08-23 凌晨）：六项"达标"经三线深查拆出四个真问题（判据条号不互认/⭐机制首诊全空=真因/替决判据措辞漂移/缺卡实为未结构化），归因教训与修法包见 docs/RELEASE-M1.md §6。**首诊核心条来源设计升为最高优先。**
- 模型策略修订（08-23，用户拍板）：Fable 额度尽，全线主会话改 Opus；"子代理干活、主会话拍板"边界不变（TEAM-PROTOCOL-v2 §六）
- 监控告警 USER_ALERT 开闸（08-23 23:40，文件式开关）：24h 零虚报观察期通过+两 cron 槽位实测健康；首次真实触发取证义务在位，首触发虚报外勤有权直接关
- 当前主线：判据 PR 四件（ws2 双代理在途，今日内）→ 离线重打分（两栏成绩单：已验/未验物理隔开）→ 首诊专议（manager 参与）→ 行为修 → S03×3 新 SHA 重跑 → 发版结论 → 全量 15 终验 → 部署 law.nbdpsy.com
- 等用户/外部：12368 四问、gsxt App 查两主体法代+印章全名、京通五险核对、调研员会话重启

## 检查点快照（2026-08-19 额度临界）
- 已合并 PR：#1 scaffold+crypto / #2 29表 / #3 auth+notify / #5 sidecar+deploy / #6 llm路由 / #7 52知识卡 / #8 billing账本+费率种子。main 全绿。
- PR #9 已合并（清理后复验 315测试+tsc 干净）：api_keys 鉴权+手写 MCP+7 工具+REST。calc_json 类型已批准。WS3 五大页面已合入 ws/frontend（build 零报错），最后一波页面在途今天内提 PR。
- 在途（各分支持久化，不怕掉线）：WS2 三线=lib/agent（C04验收+PII脱敏+反向还原）、MCP骨架、evidence链，另带 otp/sms 的 nowSql 收尾；WS1 calc 纯函数首批（类型先送审）；WS4 A09+A04 约70卡+loader；WS3 三分支（骨架已好，intake-evidence 完成待复核，workbench/docs-drafts 在途）→合并集成→最后一波页面→PR。
- 等用户：服务器选址、退款A案终审、知乎cookie（可选）、援助律师问诊单。~~Anthropic key~~→用户拍板：中配/高配标「待开发」，上线仅售入门档（2026-08-20）。
- 上线前 OPS：两通人工电话核验、LAWER_DATA_KEY 异地备份登记（值已在 .secrets-backup/）。

## 里程碑（2026-08-21）
- **S08 危机红线定版批 L1 5/5 全清 → 具备发版资格**（挂点仅 L2 整卡重复，修法在九件窗口）
- 团队重组 v2 生效：哨兵（15min 巡逻/Haiku 子代理）、评测官（跑批+初审）、外勤（手活+监控运维）三岗新设；模型分档策略入制度 §六
- 文书网登录成功（人机接力过验证码），宜信系全文命中 19,737 篇，收窄劳动争议近5年检索中
- 已合并 PR 累计 35：onboard 注册闭环(#34)、facts 结构化根治(#29/#30/#35)、审查规则库 122 条(#32/#33)、companywatch v2 表+GC(#26)、合同审查两表(#31)

## 已完成
- 2026-08-19 双红线通关（S08 危机响应/S15 拒编造，真模型链路+判据同源+证据自证）；安全铁律入 C04；全量 15 剧本终考放行
- 2026-08-19 PR #16 关/#17 合并（期间计算通则卡）；PR #18 合并：SSE 九帧+ping 对接层与等待态/降级/draft确认 UI（mock 演示剧本可点名复现）
- 2026-08-19 PR #15 合并：知识库终态 204 packs（判例103/SOP56/计算11/模板11/话术7/法条7/数据6/情绪3），WS4 编译主线完成转维护；竞业解套条款、公民代理陪庭卡、继续履行vs2N决策卡入库
- 2026-08-19 PR #14 合并：三表封装+intake_stage 首个存量迁移（addColumnIfMissing 幂等），430 测试绿
- 2026-08-19 PR #13 合并：知识库达 172 卡（判例100/SOP38/模板11/计算10/数据5/话术4/法条4）+ TS loader（依据优先排序），420 测试绿。WS2 knowledge_search 切真实现
- 2026-08-19 PR #11 合并：calc 首批 N/N+1/2N（404测试）；PR #12 合并：前端全量页面+设计系统（低调模式/verify红线/PWA），404测试+tsc+build 全绿
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
