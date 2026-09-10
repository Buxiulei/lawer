# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 这是什么

「土八鼠 / lawer」：给请不起律师的劳动者做劳动仲裁全程陪跑的 AI 工作台（问诊建档 → 事实卡/要件表 → 行动建议 → 文书 → 证据存证），并通过 MCP / REST 开放给用户自己的 agent。产品定位：网页是档案与证据的展示层，案件分析尽量在用户自己的 agent 里做。第二个领域「心理咨询服务纠纷」以领域包形式并存。

三个运行体：`app/`（Next.js 16 standalone + better-sqlite3，主服务）、`sidecar/`（FastAPI：时间戳、PAdES 签章、存证 PDF、OCR/ASR/视频抽帧，仅内网）、`scripts/`（TS 对账与评测执行器 + Python 知识库脚本）。`knowledge/` 是法律知识库（卡片 + 法源登记簿 + 官方原件），`skill/` 是给用户 agent 的接入说明（部分由生成器产出），`docs/tasks/BOARD.md` 是唯一台账。

## 常用命令

```bash
# app（全部在 app/ 下跑）
cd app && npm ci
npx tsc --noEmit
npx vitest run --maxWorkers=2            # 全量；include 覆盖 src/、app/scripts/、../scripts/、../deploy/
npx vitest run src/lib/cases/__tests__/elements.test.ts   # 单跑一个文件
npx vitest run ../scripts/eval           # C04 评测判据快集（不调模型）
npm run gen:docs                         # 由能力注册表重生成 skill/接入说明.md 的 GEN 段与 skill/variants/claude-skill.md
npm run gen:docs -- --check              # 只比对不写；有 stale 即需重跑并提交
npm run dev / npm run build

# 真模型跑批（需要 app/.env.local 里的模型凭据；本仓库不预置 key）
cd app && npx tsx ../scripts/eval-agent.ts            # 16 个剧本；S08/S15 是红线剧本，一票 FAIL 整场 FAIL
EVAL_NO_JUDGE=1 npx tsx ../scripts/eval-agent.ts S08  # 只跑机械断言

# 知识库（仓库根）
python3 scripts/gen-knowledge-index.py --strict   # 从 packs/**/*.md frontmatter 重生成 knowledge/index.json，扎根守卫 (b)–(i) 全过才出索引
python3 scripts/verify-quotes.py [--card <id>]    # 卡内 statute_quotes / case_quotes 与官方原件逐字比对（一致 / 不一致 / 找不到原件 三态）
python3 scripts/audit-sources.py                  # 登记簿同源审计：raw / text / meta 是不是同一份文件
python3 scripts/fetch-source.py --url <官方URL> ... # 抓原件落盘 + upsert 登记簿；host 不以 .gov.cn 结尾一律拒绝
python3 -m pytest scripts/tests -q                # 上面四个脚本的守卫测试

# sidecar
cd sidecar && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python main.py                          # 默认 127.0.0.1:8100（SIDECAR_HOST / SIDECAR_PORT）
.venv/bin/python -m pytest tests -q               # 全离线；缺 ffmpeg 的用例会 skip
```

改动热路径（agent / capabilities / cases / domains / db / knowledge）后的验收口径：`tsc` + 全量 vitest + `../scripts/eval` 快集 + 六套守卫（`index-guard`、`lawyer-referral-guard`、`migrate-idempotency-guard`、`registry-guard`、`ledger-entrance-guard`、`labor-prompt-snapshot`，都在全量里）+ `gen:docs --check`；改知识卡或脚本再加 `--strict` 索引（`git diff knowledge/index.json` 须只含你动的卡）、`verify-quotes`、`audit-sources`、pytest。每条新判据要能被「改坏一处 → 该用例红」证明有牙，CI 只跑测试不替你做变异。

测试环境细节：`DB_PATH` 在测试期必须由测试自己在 `beforeAll` 设定，不设直接抛错（防止写进 `data/lawer.db`）；CI 把 `TZ` 对齐成 `Asia/Shanghai`，判据仍应自带时区；`src/lib/llm/__tests__/smoke.live.test.ts` 由环境变量门控，无凭据自动跳过。

## 架构：读多个文件才看得出的几条

**一轮对话是一条固定流水线，闸链顺序的真源是常量不是调用点。** `lib/agent/orchestrator.ts` 的 `runTurnCore`：归属校验 → 档案快照与首诊阶段（决定问诊/陪跑模式）→ 按用户同意选模型 → 按案件领域预检索 → 危机判定（领域词表；命中则资源卡置前、24h 冷却）→ 核心法条定向注入 → 空手感知 → `buildSystemPromptWithBreakpoints` 拼提示（静态段在前，供 Anthropic 提示缓存）→ 工具循环（案号闸⑤、条号闸⑥在流上）→ 后置闸（杠杆、推介、判例污染、伪引用、核心位保底、数值闸）→ `finalizeMessage` 落库（含本轮闸信号 `messages.gate_json`）→ 计费 → `done`。十道闸的顺序、作用、通知码在 `lib/agent/gate-chain.ts` 的 `GATE_CHAIN` 里声明，`gate-chain.test.ts` 反向核对 orchestrator 的调用顺序与之一致；改闸顺序先改声明。第十道 `practice_boundary` 是 `planned` 占位。数值闸 `VALUE_GUARD_MODE='observe'` 只记不改正文。

**通知码只有一份表。** `lib/agent/events.ts` 的 `NoticeCode` 是唯一真源，前端 `app/(app)/case/[id]/_stream/frames.ts` 只 `import type` 并穷举映射（映射成 `null` 的必须带一行「为什么用户不需要看到」）；两表脱节 tsc 或守卫会红。闸的出路句（「回我一句『查一下这条』」）真源在各闸的服务端，前端只渲染 `notice.message` 与 `suggest`。

**能力注册表一处定义，但服务端实际有三条调用路径，只有前两条对等。** `lib/capabilities/registry.ts` 的 `Capability`（`kind` read/write/spend、`exposeTo`、`precondition` realname/balance/emotion_consent/facts_token、`idempotency`、`ledger`）同时生成 MCP `tools/list`、REST 路由、站内工具集与 `/api/manifest`。`lib/capabilities/invoke.ts` 的 `invokeCapability` 是 `POST /api/mcp`、`POST /api/v1/tools/{name}` 以及几条直调它的 REST 路由的统一入口：前置闸全覆盖，`facts_token` 闸（`case_update(stage)` / `claims_upsert` / `deadline_set` / `draft_write` 必须先出示看过最新事实卡的令牌，否则 409 `FACTS_STALE` 并夹带事实卡与新令牌）在这里。`lib/capabilities/rest-runner.ts` 是第三条路（`cases/[id]/facts`、`claims`、`actions`、`knowledge/search` 四条路由），它只判本地实名、不判其他前置闸、不记台账——`registry-guard` 钉住了「这条路上的能力不得声明 ledger 或 precondition」；新加 REST 端点若能力带闸或写库，走 `invokeCapability`，别挂 rest-runner。写能力的台账 `agent_writes` 唯一写入点是 `lib/audit/agent-writes.ts`；能力要么走能力壳（`withClientRef`/`writeOnce`），要么声明 `ledger` 元数据，二者必居其一且互斥（守卫钉住）。

**领域是配置加内容，内核去领域化。** `lib/domains/registry.ts` 定义 `DomainPack`（parties、stages、intakeSchema、factsSections、claimKinds、crisis 词表、`lawyerMandatory` 闭合清单、`interpretationDisputed`、`elementCards`、对方书面决定槽、copy），`labor.ts` 与 `counseling.ts` 是两个包；`LAWER_DOMAINS_ENABLED` 只能在服务端读，每次现读不缓存。共用层（`lib/capabilities/**`、`lib/cases/**`、`lib/domains/registry.ts`、`lib/agent/crisis.ts`、`case-facts.ts` 等）禁止出现领域字面量（劳动/仲裁/用人单位…），由 `lib/capabilities/__tests__/registry-guard.test.ts` 扫源码钉住；新落的共用层文件必须当场登记进它的名单。领域判定逻辑（词表、谓词）一律放领域包。

**要件表 → 争点表 → 报告两节 / 风险档位是服务端机械派生，模型不参与判定。** `lib/cases/elements.ts` 的 `buildElementSheet` 从档案事实按领域包 `elementCards` 推出三态（缺失 / 成立·待证 / 成立；「不成立」需 `negatedBy`）与举证责任；来源四档在 `lib/cases/source-tier.ts`（自述 < 书证 < 对方认可 < 裁审认定），「〔未记录〕≠ 不存在、自述 ≠ 书证」是类型不是提醒。槽位可挂取值判定 `slotChecks`（basics 与 timeline 槽都支持；谓词由领域包给），档位只从过了判定的条目里取。`issue-table.ts` 三规则派生争点表（要件未成立 / 对方主张 / 举证在对方且书面决定在档），「对方书面决定在档」（`counterpartyDecisionOnFile`）与「要件成立」必须走同一套槽解析与判定，同真同假——两处各写一遍取值逻辑的形态是判据照绿而两行报告互相矛盾。`report.ts` 的「争议焦点」「风险与未定项」两节直接渲染派生集合，`REPORT_SECTION_DERIVED` 闸只比 `〔争点 id〕` 标记集合与「服务端此刻初稿」的顶格条目数，模型能改措辞不能增删争点。`claims.ts` 的 `riskBandOf` 给四档不给胜率。「任选其一」的要件组（`alternativeGroup`）按代表行取数。

**知识层：每一句能追到官方原件。** 卡片在 `knowledge/packs/<type>/`，frontmatter 的 `facts` 是代码唯一读取面（`statute_quotes`、`case_quotes`、`values`、`hotlines` …，正文散文不被代码消费）。法源登记簿 `knowledge/sources.json` + 原件 `knowledge/sources/originals/<source_id>/{raw,text.txt,meta.json}`；`confidence` 只允许「原文核实」与「无外部断言」两档进索引，转载站、待核实、二手转述一律进 `knowledge/quarantine/`（隔离卡不进索引，loader 排除并 `console.error` 点名）。引文必须逐字（归一只折空白与 NFKC，引号字形不折）。`updated` 只在外部事实面重新核过时进位，纯正文/记录类改动不进位。`knowledge/TODO核实清单.md` 记「查过没找到」与「没人查过」的区别，别重走死路。app 侧 `lib/knowledge/index.ts` 读 `index.json`，索引进程级缓存、正文按 id 懒加载、目录缺失直接抛错。

**数据库迁移没有事务。** `lib/db/migrate.ts` 是一串裸 `db.exec()`，首个请求时懒执行。允许：`CREATE TABLE IF NOT EXISTS`、新列走 `addColumnIfMissing`（可空、不回填）、读侧视图走 `READ_VIEWS` + `ensureReadViews`（唯一放行的 `DROP VIEW IF EXISTS`，开库时比对 `sqlite_master` 不一致点名重建）。禁止：改列类型、数据回填、拆表、加无默认值的 `NOT NULL`——`migrate-idempotency-guard` 静态扫源码拦。

**模型路由与出境。** `lib/llm/routing.config.ts` 是策略契约（型号、档位、降级链），`router.ts` 只查表；`providers/` 有 anthropic / openai / deepseek / dashscope / relay。PII 脱敏拦在 `createProvider` 工厂出口，出境供应商（anthropic、openai、relay）把身份证/手机/银行卡换占位符，映射只活在单次请求闭包。是否允许境外模型由 `lib/auth/consent.ts` 的 `overseasModelsAllowed` 唯一裁定（开关 ∧ 有效同意 ∧ `termsLive()`），`RouteOptions.overseasAllowed` 缺省 `false`。协议生效旗 `LAWER_TERMS_LIVE` 默认关。

**sidecar 与部署。** app 经 `lib/evidence/sidecar-client.ts` 调 `SIDECAR_URL`（仓内缺省 `http://sidecar:8100`）；接口 `/health /tsa /pades /signer /evidence-pdf /draft-pdf /verify /ocr /asr /video`，OCR 模型由 `OCR_MODEL` 决定（默认 `qwen3-vl-plus`），凭据 `DASHSCOPE_API_KEY`。`deploy/` 描述的是 docker-compose 三容器拓扑（caddy → web → sidecar）；当前生产实际是裸 systemd（`lawer-app` :3010 / `lawer-sidecar` :8110，路径 `/data/lawer/…`，应用日志在 `/data/lawer/logs/app.log` 而非 journalctl），滚版流程与每次冒烟记录在 `docs/tasks/BOARD.md`。`deploy/node-backlog-preload.js` 是直接上生产的可执行代码，它的测试跟主套件一起跑。

## 写代码时会撞到的项目纪律

- 所有面向用户的文案不劝找律师、不推卸责任；「律师」只许出现在三处（否定式免责、`lawyerMandatory` 闭合清单渲染、法条判例原文逐字引用），`lawyer-referral-guard` 扫描面内的新文案文件要登记进它的名单。法律解释存疑时先给官方相似案例再给分歧点，不下结论、不转介。
- 错误要三段式（缺什么 / 为什么缺 / 怎么办），静默回空比报错更伤；「未回报」不能当 0 记（见 `token_usage` 两桶与 `agent_writes` 的 `{ unresolved }` 形态）。
- 判据先于机制：每道闸一条会红的测试，每个阈值先按 SHA 记基线；误差方向一律偏向报警、偏向「少认」（要件宁可缺失不可误判成立）。
- 注释里不写替经理做的裁决；设计裁决与例外一律进 `docs/tasks/BOARD.md`。
- `skill/` 里 GEN 标记段与 `claude-skill.md` 整份由 `gen:docs` 生成，手改会被覆盖；手写区在标记之外。
- 设计真源：`docs/specs/2026-08-19-lawer-design.md`；前端设计系统 `DESIGN.md`（一个主色，红色是稀缺资源，每页 3 秒内看到下一步）。
