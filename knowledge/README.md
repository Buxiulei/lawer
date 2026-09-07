# knowledge packs 编译规范 v1.1（manager 2026-08-19 批准；v1.1 增 facts 字段，2026-08-20）

> 供 `lib/knowledge/`（pack 加载与检索）与律师 agent 消费。原料在服务器本地
> `research/raw/`（不入仓库）；本目录全部为**原创编译产物**，可入库。

## 1. 目录与命名

```
knowledge/
  README.md            # 本规范
  index.json           # 全量索引（脚本可再生成，先手工维护）
  TODO核实清单.md       # 核实闭卷记录（2026-09-07 起：不再有「待核实」这个状态，只有核实或隔离）
  sources.json         # 法源登记簿（官方原件的出处/版本/sha256），见 §7
  sources/originals/   # 抓下来的官方原件存档：<source_id>/{raw.<ext>, text.txt, meta.json}
  quarantine/          # 隔离区：追不到一手源的卡整张移进来，不进索引（见该目录 README）
  packs/
    statutes/          # 法条卡
    cases/             # 判例卡
    calc/              # 计算规则
    sop/               # 流程SOP
    templates/         # 文书模板
    scripts/           # 话术卡
    emotion/           # 情绪指南
    data/              # 数据卡（社平/最低工资/基数等硬数字）
    review-rules/      # 审查规则（合同/文件逐条审查规则库，facts.review_rules 结构化）
```

- 文件名 = slug，小写拼音/英文加连字符（如 `lhtf-38-beipo-jiechu.md`）。
- `id` = `<域单数>-<slug>`（如 `statute-lhtf-38-beipo-jiechu`），全库唯一。

## 2. frontmatter（全类型统一）

```yaml
---
id: statute-lhtf-38-beipo-jiechu
type: 法条卡          # 法条卡|判例卡|计算规则|流程SOP|文书模板|话术卡|情绪指南|数据卡|审查规则
title: 劳动合同法第38条：被迫解除（劳动者单方解除拿N）
keywords: [被迫解除, 第38条, 拖欠工资, 未缴社保, 经济补偿]
applies_to: [逼迫离职, 欠薪, 社保断缴, 协商解除]   # 场景标签，见 §5 受控词表
law_refs: [劳动合同法§38, 劳动合同法§46]           # 规范化法条引用，可选
related: [calc-jingji-buchang-n, sop-tiaogang-yingdui]  # 关联 pack id，可选
region: 北京          # 北京|全国；北京口径与全国规则并存时标「北京」
domain: counseling    # 领域键，可选。**不写 = 缺省领域 labor**；取值见 app/src/lib/domains/registry.ts 的 DOMAINS，口径见 §2.3
sources:
  - https://flk.npc.gov.cn/...
confidence: 原文核实   # 原文核实|二手转述|待核实（取全 pack 最低档）；无外部断言的 D 类卡见 §2.2
updated: 2026-08-19
---
```

## 2.2 D 类：无外部断言卡的 confidence 口径（2026-09-07 定）

绝大多数卡都在断言外部世界的某件事——条文原文、案号、社平工资、机构电话——它们的
`confidence` 回答的是"核到什么程度"，追到 `.gov.cn` 原件并逐字对上的记 `原文核实`。

**但有一类卡什么外部事实都不断言**：内容整个是本项目自己写的方法论、陪伴话术、
预演脚本（现有三张：`emotion-caiyuan-xinli-jieduan`、`emotion-kaiting-xinli-jianshe`、
`method-panli-heyan-sibufa`）。它们没有原件可核，**给它记 `原文核实` 是个类别错误**——
说"我核过原文了"，而根本不存在那份原文；这类卡从前就是靠这么记混进来的，`sources`
里写着一段散文，扎根守卫 (b) 一开就当场点名。**统一口径：这类卡 `confidence: 无外部断言`。**
它不在"核到什么程度"那条轴上，它说的是这张卡压根不在那条轴上。

判定与守卫（`scripts/gen-knowledge-index.py` 的 (e)，写在守卫里而不是只写在这段文档里）：

| 条件 | 说明 |
| --- | --- |
| 不许有 `facts` | facts 是被代码消费的**事实**，有 facts 就是在断言外部世界（条文/数值/号码/地址/判例） |
| 不许有 `law_refs` | 指着一条法条，就是在断言那条法条说了什么 |
| `sources` 里不许有 http(s) URL | 有出处就说明有原件可核，那它该走 `原文核实` 并接受 (b)(c) 的检查 |
| `sources` 写什么 | 一段说明"为什么这张卡没有出处"的话：正文都是谁写的、提到的外部概念只作背景不作依据 |

三条一起，是为了让 `无外部断言` 不能当免检标签用：**贴上它的那一刻，这张卡就交出了
引条文、报数字、报号码、援引判例的全部权利**。要拿回其中任何一项，就得回去追一手源。

（`--strict` 下 (d) 只放行 `原文核实` 与 `无外部断言` 两档；`二手转述`／`待核实` 一律拒绝生成，
见 §7.3 与主理人 2026-09-07 裁决。）

## 2.1 facts 结构化字段（v1.1，被代码消费的事实的唯一读取面）

> 事故根治规则（manager 2026-08-20 裁决）：**凡被代码消费的事实，进 frontmatter `facts:`
> 结构化字段；代码只读 facts，禁止用正则啃卡片散文。** 正文散文服务人与模型，facts 服务代码，
> 一卡两面；两面数值不一致 = gen-knowledge-index.py 校验失败（构建即断）。

```yaml
facts:
  hotlines:            # 资源卡：热线/电话
    - {name: 全国心理援助热线, phone: "12356", category: crisis, status: usable, hours: 24小时, dial_hint: 手机座机均可直拨, agent_note: 首选统一入口，偏心理咨询}
    - {name: 北京市正阳公证处(误传为法援号), phone: "010-85961236", category: legal, status: forbidden, agent_note: 绝不输出给用户}
  values:              # 数据卡：被计算/校验消费的数值
    - {key: min_wage_monthly, value: 2540, unit: 元/月, effective_from: "2025-09-01", confidence: 原文核实, source_idx: 0}
  statute_quotes:      # 法条逐字条文（如期间通则供 deadline basis）
    - {law: 中华人民共和国民事诉讼法, article: 第八十五条, text: "……"}
  case_quotes:         # 判例卡：从官方页上逐字节选的那几句（见下）
    - {source_id: cases-bj3zy-2025-dxal, text: "第九个典型案例指出，……构成旷工。", note: 案例九的裁判要旨}
```

- `status`: `usable`（可输出给用户）| `forbidden`（已证伪/危险号码，代码层拦截，绝不输出）。
- `category`: `crisis`（心理危机）| `legal`（法援/法律咨询）| `union`（工会）| `inspection`（人社/监察）——代码按 category 筛线，禁按 name 关键词猜。
- `addresses`（坐标卡）：`[{name, scene: [仲裁立案|一审起诉|二审上诉|执行申请], address, phone?, status: usable|unverified, hours?, agent_note?, source?, confidence?}]`——
  usable=官方确认可输出；unverified=二手来源，代码层禁止渲染具体值（agent 只说"以官方查询为准"）。
  **铁律：name 只用于展示，消费方判断一律走 scene+status 双键，禁止按 name 含"仲裁院/法院"等关键词取条目**
  （这是"代码按名字猜"的同型坑第三次——热线 category、坐标 scene 均为根治）。scene 是数组，一个机构
  可挂多场景，或同机构建多条。校验器强制 scene 非空且值在受控集内。
- `hours` 只放用户可见纯服务时间（如 `24小时`/`7×24`/`工作日`）；核验状态等内部信息一律进
  `agent_note`，hours 含"核验中/待核实/官网载/存疑"等内部词即校验失败。
- `dial_hint`（用户向，可直接渲染给用户）与 `agent_note`（agent 内部指令，**绝不渲染**）严格分离；
  `usable` 热线必须有 `dial_hint`；旧混受众字段 `note` **废弃**，出现即校验失败。
- `key`: 全库唯一的 snake_case 英文键，代码按 key 取数；`source_idx` 指向本卡 sources 数组下标。
- `statute_quotes.text` 必须与正文引用块**逐字一致**（空白归一后比对）。
- `case_quotes`（判例卡的扎根面，2026-09-07 经理裁定新增）：
  `[{source_id, text, note?}]`——从**官方页**上逐字抄下来的节选，**至少要含裁判要旨或裁判结果一句**。
  - `source_id` **必填**（不像 statute_quotes 可以省）：判例没有"法名"这种能与登记簿互为子串
    匹配的东西，一句"第九个典型案例指出…"匹得上哪份原件只有写卡的人知道；靠猜的形态是
    随机挑一份发布会通稿来核，**并且照样报「一致」**。
  - `text` 与 `statute_quotes.text` 同规矩：必须是本卡正文的子串（两面一致），
    且必须是登记原件正文的子串（`scripts/verify-quotes.py` 同一套归一）。
  - `note` 可选，写这段话在原件里的位置/身份（"案例九的裁判要旨""通稿导语"）。
  - **`packs/cases/` 下的每张判例卡必须有 ≥1 条核得过的 case_quotes**，否则 `--strict` 拒绝生成
    （守卫 (f)）。**为什么这道闸非有不可**：判例卡最常见的失效不是"没有出处"，而是
    **出处是真的、案情是转载站编的**——官方通稿只给一句话要旨，卡里却写着当事人姓名、
    金额、大段"裁判理由原文"。要求至少一句逐字对得上官方页，等于逼这张卡至少有一句话
    是从原件上抄下来的，而不是全篇转述。
- `review_rules`（审查规则卡，contract-review 消费面）：
  ```yaml
  review_rules:
    - id: ldht-001                    # 全库唯一，<合同类型缩写>-<三位序号>
      severity: must                  # must=违法/无效/剥夺法定权利 | strong=合法但显失公平/埋雷 | suggest=可优化
      title: 试用期超过法定上限
      pattern_hint: 合同期限与试用期长度组合违反 §19 阶梯（如一年期合同约定三个月以上试用期）   # 触发特征描述，给 LLM 不给正则
      basis: 劳动合同法§19            # 条号，必须同时出现在本卡 law_refs；正文有逐字或经单点事实源卡可溯
      suggestion: 要求将试用期改为不超过 X 个月，并注明"依《劳动合同法》第十九条"   # 可照抄的修改要求话术
      negotiation_tip: 试用期工资不得低于转正工资 80%，可一并提   # 可选
  ```
  校验：rule id 全库唯一；severity 枚举合法；必填 id/severity/title/pattern_hint/basis/suggestion；
  basis 中出现的每个条号引用须能在本卡 law_refs 找到对应条目。
  **分级哲学（manager 2026-08-20 确认）**：must 只留给"无效级"硬度——有法条/判例直接支撑
  违法、无效或剥夺法定权利；"可主张纠正/补足但条款未必无效"（如约定补偿低于 30%）、
  "合法有效但必须知道的雷"（如返还补偿+违约金条款）一律 strong。**must 的完整门槛（manager 2026-08-20 裁定）**：条款依法无效/违法（法院直接不认），
  **或直接剥夺法定救济权**（仲裁权、送达知情、离职证明等程序命脉）。判断口诀：
  "这个坑若不改，用户开庭会不会直接吃亏"——会，就往上抬一级。其余拿不准时降档不升档，
  并在正文说明理由——审查结论的可信度比吓唬人重要。
- 校验规则（gen-knowledge-index.py 内建）：values 的 value 必须出现在本卡正文（千分位归一后），
  hotlines 的 phone 必须出现在本卡正文，statute_quotes.text 必须是正文子串；
  全库唯一性：key 不重复；status=forbidden 的号码不得出现在其他任何卡正文。
- facts 随 index.json 透传给 loader（PackMeta.facts），WS2 adapter 只读它。

## 2.3 domain（领域键，设计稿 §13）

一张卡属于哪个领域，优先看卡片自己声明的 `domain:`；没写就看它在不在 `packs/<领域>/` 下；都不是才算缺省领域（存量卡片写于只有一个领域的时候）。**index.json 里每条都带显式值**（生成器 `domain_of()` 补齐，加载器 `loadIndex` 再兜一次），下游读到的恒有值。消费侧口径：

- 检索 `search()` 不传 `domain` 时**只回缺省领域（labor）的卡**——跨域检索默认关闭；
- 逐字条文注入（`findByArticleKeys`）同闸：别的领域收录的法条不会被注入进缺省领域的对话；
- 因此**新领域包的每张卡都必须写 `domain:`**。漏写的形态不是「这张卡搜不到」，而是「它出现在另一个领域用户的检索结果里」，且回包一切正常。

改完卡必须重跑 `python3 scripts/gen-knowledge-index.py`：检索读的是 index.json，卡上写什么都不算数；两面分叉有判据盯着（`app/src/lib/knowledge/__tests__/domain-gate.test.ts`）。

## 3. 各 type 正文骨架

- **法条卡**：`## 条文原文`（逐字引用块，注明版本/文号/施行日）→ `## 适用要点` →
  `## 北京口径`（无则写「无地方特别口径」）→ `## 常见误区`（可选）。
- **判例卡**：案号/法院/裁判年份/来源链接 → 案情要旨 → 争议焦点 → 结果 →
  裁判理由（**官方页原文摘录，同一段进 `facts.case_quotes`**）→ 对劳动者的启示。
  **无真实案号绝不编造**；官方发布但未公开案号的写「官方案例，未公开案号」。
  官方页没写的案情细节（当事人、金额、日期、大段裁判理由）一律不写——
  写不进来就在卡里明说不写（§4.2），而不是从转载站抄一份进来。
- **计算规则**：`## 公式` → `## 参数口径`（每个参数怎么取数）→ `## 算例`（≥2 个，
  含边界）→ `## 北京口径与数据`（引用 data 卡）→ `## 争议点/待核实`。
- **流程SOP**：适用场景判定 → 分步动作（说什么/不说什么/发什么）→ 证据固定清单 →
  常见错误（❌ 列表）→ 依据（法条/判例 id 引用）。
- **文书模板**：适用场景 → 全文模板（`【】`为填空位，附填写说明）→ 送达方式 → 注意事项。
- **话术卡**：场景 → 对方话术 → 应对话术（可直接照读）→ 禁忌语 → 依据。
- **情绪指南**：情绪状态识别 → 陪伴话术 → 行动锚点 → 引流红线（遵守 spec §10）。
- **数据卡**：数据表（值/适用期间/发布机关/文号）→ 用途与常见混用错误 → 更新触发条件。
- **审查规则**：适用文件类型判定 → 按 severity 分节的规则详解（每条：适用要点/例外/关联判例 related）
  → 整体审查顺序建议。规则本体在 facts.review_rules，正文写机器装不下的判断力。

## 4. 质量线

1. **自含可用**：agent 只读单个 pack 即可正确回答，不依赖原料。
2. **宁缺毋错**（2026-09-07 主理人裁决后收紧）：**不许留「【待核实】」**——那是一个
   可以无限期停留的状态，而它与"已经核过了"在检索结果里长得一样。拿不准的数字／案号／
   文号只有两条路：**追到一手源逐字核实，或者不写**（把那一句删掉，或整张卡移进
   `quarantine/`）。写不进来的东西要在卡里**明说不写**（"本卡不写它的受理条件，原因是…"），
   而不是写进来再加一句"未核实"。
3. 法条**逐字**引用原文块，不改写、不省略号截断关键句；转述放「适用要点」。
4. `confidence` 取整包最低档。索引里只允许 `原文核实` 与 `无外部断言`（§2.2）两档；
   `二手转述`／`待核实` 会被生成器当场拒绝（§7.3 的 (d)）。
5. 每 pack 控制在 200 行内；超长拆分并用 `related` 互链。
   **例外**：单点事实源汇编卡（见 #6）与审查规则卡（facts.review_rules 本体占行数大头，拆卡会切碎 contract-review 的单一消费面）可放宽行数。
6. **单点事实源**（manager 修订 2026-08-19）：被 ≥2 个 pack 引用的文号/数据，
   建一张专卡收录（逐字条目+原文直链），其他 pack 一律经 `related` 引用该卡、
   confidence 跟随该卡，不各自转述——防止核实状态发散。
   现有：`statute-jgf-2024-534-jieda-1`（京高法发〔2024〕534号）。
7. **硬数字一律走 data 卡**：社平/封顶/最低工资/基数上下限等数值不裸写进
   calc/sop 卡，建 `data/` 卡（值/适用期间/发布机关/文号/更新触发条件）后按 id 引用。
8. **法条原文 source 首选 flk.npc.gov.cn**（国家法律法规数据库）；转载链接
   （samr/gov.cn 部门转载等）可列为备份源，不作首源。地方文件首选
   beijing.gov.cn / rsj.beijing.gov.cn 原始页。

## 5. applies_to 受控词表（首批，可增补需报 manager）

`调岗降薪` `PIP` `末位淘汰` `待岗停工` `逼迫离职` `协商解除` `违纪解除` `裁员`
`欠薪` `社保断缴` `年假` `加班费` `双倍工资` `年终奖` `竞业限制` `孕产哺乳`
`证据固定` `仲裁申请` `开庭质证` `调解` `裁决与终局` `一审二审` `执行` `情绪支持` `离职证明` `背调威胁`

## 6. index.json

数组，每项：`{id, type, title, keywords, applies_to, region, domain, confidence, updated, path}`。
`path` 相对 `knowledge/`。检索逻辑（lib/knowledge）：keywords + applies_to + title 分词匹配。

### domain（多领域，设计稿 §13）

一张卡属于哪个领域。生成器按这个顺序判：frontmatter 的 `domain` → `packs/<domain>/…`
这种分包布局的第一层目录 → 缺省 `labor`。取值必须是注册过的领域
（`app/src/lib/domains/registry.ts` 的 `DOMAINS`，生成器里有一份同步的影子，判据比对）。

检索默认**不过滤**领域；带案件上下文的调用方（站内注入、`knowledge_search` 传了 `case_id`）
按 `cases.domain` 限本领域——跨域检索是显式选择，不是默认行为。

写一个没人认识的 `domain` 会**当场拒绝生成**（构建期严格，CI 即红）；万一混进 index.json，
加载时把那几条**排除出检索面并 `console.error` 逐条点名**，其余卡照常加载
（manager 2026-09-07 裁决，与隔离区同一口径，理由见 `knowledge/quarantine/README.md`）。
两道都拦是因为它的失效形态是静默的：那批卡在按领域过滤时凭空消失，而检索照常返回
200 与一个更短的列表。

## 7. 法源登记簿与机械核验（2026-09-07 起）

> 主理人裁决：**知识库里不允许「二手转述」「待核实」**。每条二手信息必须追到一手信源并
> 逐字核实；追不到的卡整张移入 `knowledge/quarantine/<原子目录>/`（带原因与试过的信源），不进索引。

### 7.1 登记簿 `knowledge/sources.json`

顶层是数组，每条登记一份**官方原件**：

```json
{"source_id": "fashi-2025-12-jieshi-2", "kind": "司法解释",
 "name": "最高人民法院关于审理劳动争议案件适用法律问题的解释（二）",
 "issuer": "最高人民法院", "official_host": "www.court.gov.cn",
 "url": "https://www.court.gov.cn/zixun/xiangqing/472691.html",
 "fetched_at": "2026-09-07T00:30:36+08:00", "content_sha256": "adeb…",
 "version_label": "法释〔2025〕12号", "effective_from": "2025-09-01", "status": "现行",
 "files": {"raw": "sources/originals/fashi-2025-12-jieshi-2/raw.html",
           "text": "sources/originals/fashi-2025-12-jieshi-2/text.txt"}}
```

- `kind`：`法律|行政法规|司法解释|部门规章|地方规章|规范性文件|官方案例|官方数据|行业规范|机构官网`
- `status`：`现行|已修正|已废止`——**页面自述被后来的令/文号修改过的，写 `已修正`**，
  别因为它挂在政府网站上就记成现行。
- `files` 路径相对 `knowledge/`，与 index.json 的 `path` 同一口径；`files.text` 为 `null`
  的条目必定同时带 `needs_text: true`（抽取器抽不出正文），此时引用它的引文被判「找不到原件」，
  且 `scripts/audit-sources.py` 判红——**「还没抽出正文」不能与「抽出来了」在退出码上长得一样**。
- 登记簿**只能由 `scripts/fetch-source.py` 写**：手写一条等于跳过 host 闸与 sha256。
- **`text.txt` 只能由抽取器写，人工粘贴这条路已封死**（经理 2026-09-07 裁定）。
  旧行为是"抽不出就让人自己把正文写进 text.txt"，产物是 **raw 与 text 毫无对应关系**的条目，
  而登记簿看起来完全正常（有 url、有 sha256、有抓取时间）。2026-09-07 在
  `statute-gerensuodeshuifa` 上实见此形态：raw 是 flk 的 552 字节 SPA 空壳、text 是从
  chinatax 另抓的正文，`verify-quotes` 判「一致」——一致于一份没人登记过的文件。

### 7.1.1 `kind=机构官网` 与 `kind=行业规范` 的分界（经理 2026-09-07 裁定）

两者都是"非 `.gov.cn` 但算数"的口子，可信范围完全不同，所以必须是两个 kind：

| | 行业规范 | 机构官网 |
| --- | --- | --- |
| 是什么 | 行业组织发布的**规范文件**（学会伦理守则一类） | 一家机构在自己官网上**讲自己的事**（热线号码、办公地址、自家收费公示） |
| 登记要求 | `--issuer-host` | `--issuer-host` **加** `--justification`（写明该机构与它自述信息的关系） |
| 谁能引 | 任何卡（与 `.gov.cn` 同权） | **只有数据卡的 facts**（热线/地址/收费）。法条卡/判例卡/SOP/计算规则引它即 `--strict` 拒绝生成（守卫 (g)） |

合成一个 kind 的失效形态是：某个 host 为了一条热线号码进了白名单，从此一张法条卡可以拿
某医院的科普文当法律依据，而 host 闸一声不吭地放行。

### 7.2 三个命令

```bash
# 抓一份原件并登记（host 不以 .gov.cn 结尾一律拒绝；幂等，同 URL 同 sha 不重写）
python3 scripts/fetch-source.py --source-id <id> --name <法源全称> \
    --kind <受控词> --issuer <发布机关> --url <官方URL> \
    [--version-label …] [--effective-from YYYY-MM-DD] [--status 现行|已修正|已废止]

# 把卡里的 facts.statute_quotes 逐条拿去和原件比对（三态：一致/不一致/找不到原件）
python3 scripts/verify-quotes.py [--card <卡id>] [--json] [--allow-missing]

# 生成索引（默认 --strict：扎根守卫全过才出索引）
python3 scripts/gen-knowledge-index.py [--no-strict]

# 登记簿同源审计：每条登记的 raw / text / 元数据是不是同一份文件（见 §7.5）
python3 scripts/audit-sources.py [--source-id <id>] [--json]

# 不下载，用当前抽取器从盘上的 raw 重写 text.txt（改了抽取器之后用）
python3 scripts/fetch-source.py --reextract [--source-id <id>]
```

`--reextract` 是**抽取器变强之后唯一的补救路**：上面那条抓取命令是幂等的，
条件正是"抓下来的字节没变"，所以重跑一遍只会打印"未变化"、**不重写 `text.txt`**。
没有这条路的话，修一份过时的存档就只剩"手写 `text.txt`"，而那条路已经封死（§7.5）。
它只碰 `text.txt`；`raw` / `content_sha256` / `fetched_at` 一个字节不动，
登记簿只在 `files.text`／`needs_text` 真的翻转时才改写。

**它只重抽复算量程内的格式**（`DERIVABLE_KINDS`，§7.5），量程外的（今天只有 pdf）跳过并报数。
这道闸是拿事故换来的：第一版没有它，一次全库 `--reextract` 就用本机的 pypdf 6.17
覆盖了两份 pdf 的存档（`statute-minsufa` 的目录被抽成"第四章回避**2**第五章"，页码插进正文），
而审计对 pdf 只报"未复算"、照常退 0——**一次审计看不见的存档漂移**。
写者与审计者必须共用同一份名单，不能各有各的政策。

行业规范（学会伦理守则一类）的一手源是发布机构自己的官网，抓取时必须显式声明：
`--kind 行业规范 --issuer-host <该 host>`。登记之后，**那个 host 才进白名单**。
机构自述信息（热线/地址/收费）走 `--kind 机构官网 --issuer-host <该 host> --justification <说明>`，
白名单同样只在登记之后才开口，且引用范围另受守卫 (g) 限制（§7.1.1）。

### 7.3 生成器的扎根守卫

| | 守的是 | 不过的后果 |
| --- | --- | --- |
| (b) | `confidence: 原文核实` 的卡，每条 `sources` 都得是官方 host（`.gov.cn`，或登记簿里 `kind∈{行业规范, 机构官网}` 的机构官网） | 拒绝生成，逐条点名 |
| (c) | 带 `facts.statute_quotes` / `facts.case_quotes` 的卡，每条引文都要与登记在册的原件逐字对得上 | 拒绝生成，指出第几个字起分叉 |
| (d) | `--strict`（默认开）索引里不许有 `confidence` 既非 `原文核实` 也非 `无外部断言` 的卡 | 拒绝生成，逐张点名 |
| (e) | 自称 `无外部断言`（D 类，§2.2）的卡必须真的没有外部断言：无 `facts`、无 `law_refs`、`sources` 里无 http(s) 出处 | 拒绝生成，逐张点名 |
| (f) | `packs/cases/` 下的判例卡必须有 ≥1 条**核得过**的 `facts.case_quotes`（§2.1） | 拒绝生成，逐张点名 |
| (g) | `kind=机构官网` 的源只能被**数据卡**引用（§7.1.1），无论是 `sources` 里的 URL 还是 facts 里的 `source_id` | 拒绝生成，逐张点名 |
| (h) | `quarantine/**` 下的卡不许挂 `原文核实` / `无外部断言` 这两个"可进索引"的标签 | 拒绝生成，逐张点名 |

> **(f) 已闭卷（2026-09-07 收口）**：机制落地当天现库红在 (f)（42 张存量判例卡没有
> `case_quotes`），`knowledge/index.json` 一度由 `--no-strict` 生成。本轮把 43 张判例卡的
> `case_quotes` 逐条补齐并核过，现库在**默认 `--strict`** 下八道守卫全绿，CI 与索引都不再带
> `--no-strict`。**判据跟着换了方向**：`scripts/tests/test_gen_guards.py::test_real_library_is_green_under_strict`
> 现在钉的是"一条都不红，且重新生成的索引与仓里那份逐字节相同"。

`--no-strict` 把**这几道**整体降为警告，只在核实作业期间用；
**前面那批"卡片自洽"的校验（facts 两面一致、id 唯一、类型闸…）一条不降**——
一个开关只有一种含义，才不会有人以为自己关掉的是别的东西。

### 7.4 引文怎么写才核得动

`facts.statute_quotes` 的条目可以多写一个 `source_id` 指名原件；不写时按 `law` 与登记簿的
`name` 互为子串匹配（「劳动合同法」↔「中华人民共和国劳动合同法」）。**匹配到多条一律判
「找不到原件」并要求补 `source_id`**——随便挑一条等于随机选一份原件来核验。

比对前两边都做归一：NFKC（全角→半角）、引号族折成 `"`、去掉全部空白与 markdown 的
`*` `_` `>`。所以卡里写成加粗引用块、原件是纯文本，不影响判定。

`facts.case_quotes` 走同一套归一与三态判定，只是**必须写 `source_id`**（§2.1）。

### 7.5 登记簿同源审计 `scripts/audit-sources.py`

`verify-quotes` 只读 `files.text`，`gen-knowledge-index` 只看 host。两者都**默认**
text 是从 raw 抽出来的、raw 是从 url 抓下来的。这个默认一旦不成立，整条链子照常全绿
（`statute-gerensuodeshuifa` 就是那一次）。这个脚本审的就是那个默认：

| | 审的是 | 不过的后果 |
| --- | --- | --- |
| ① | `sha256(files.raw)` == `content_sha256` | 判红：原件被换过或改过 |
| ② | raw 不是 SPA 空壳（< 2KB 且带 `id="app"`/`id="root"` 这类骨架标记） | 判红：抓到的是壳不是正文 |
| ③ | 用 **fetch-source 同一个抽取器**从 raw 重抽，归一后 `text.txt` 必须是重抽结果的子串 | 判红：text 与 raw 不是一回事 |
| ④ | `needs_text: true` 的条目 | 判红：抽不出正文的登记在修好之前不算数 |
| ⑤ | `text.txt` 字符数 ≤ raw 字节数 | 判红：抽出来的正文不可能比原件长 |

③ 的量程写在 `scripts/fetch-source.py` 的 `DERIVABLE_KINDS`（**只此一份**，审计不另立名单）：
html / htm / xml / txt / docx / **doc / xls / zip**。判据是"抽出来的字只随仓里的代码变"——
这几种格式的抽取器全在 `fetch-source.py` 里（.doc 是 [MS-DOC] 的分片表解析，
.xls 走 xlrd 读单元格，.zip 逐成员分派），换台机器输出一个字不差。

**pdf 不在量程里**，只报"未复算"并逐条印出。不是嫌麻烦：pypdf 的输出随它自己的版本漂。
2026-09-07 实测——用 pypdf 6.17 重抽 `statute-minsufa`，目录处抽成
"第四章回避**2**第五章诉讼参加人"（页码被插进正文），与存档的 33991 字对不上；
同一天同一台机器重抽 `statute-beijing-gongzi-zhifu-guiding-doc` 却逐字相同。
把这种东西当判据，等于让审计结论随环境漂，而**同一份库这台机器红、那台机器绿**时，
人只会挑绿的那台。未复算的条目仍要过 ①②④⑤。

**量程内的格式若本机缺工具（olefile / xlrd，§7.6），审计判红并印出 `pip install` 那行**，
不会退回"未复算"。"这台机器没量"与"量过了"不能在退出码上长得一样——
判据：`test_missing_extraction_tool_is_red_not_quietly_underived`。

**"未复算"这个桶是钉死的**：`scripts/tests/test_audit_sources.py::test_real_registry_underived_set_is_pinned`
把现库的未复算名单钉在两条 pdf 上（`statute-beijing-gongzi-zhifu-guiding-doc` /
`statute-minsufa`），**多一条少一条都红**。新登记的条目若抽不出文本，会被 ④ 挡住
（fetch-source 给它标 `needs_text`）；这颗钉子管的是**绕开 fetch-source、手写登记簿**
那条路——手写一条 pdf 登记再自己写一份 text.txt，审计照样退 0。

> **两处旧账已清（2026-09-07 收口）**，它们当初正是"复算不动"的代价：
> · `bjchy-banli-cailiao-baofuzhuang`（朝阳区办理材料包 .zip，29 个成员、13 个是 .doc）的
>   `text.txt` 里，**11 个 .doc 只有一行占位说明**（"本机无 antiword/catdoc，未抽取"），
>   另外 2 个的正文是**人工用 `libreoffice --convert-to txt` 转出来粘进去的**——块尾还留着
>   "[补记 2026-09-07：…逐字核对无损]"这样的人写句子。补上 .doc 抽取器整份重抽后
>   30720 字 → 70418 字，找回 4.4 万字官方正文（劳动法/劳动合同法/调解仲裁法全文与各式模板）。
>   **顺带更正一条此前写在这里的判断**：那 30720 字（30×1024）是巧合，**不是截断**——
>   29 个成员一个不少，末尾那句无句号的话是最后一份 .docx 自己的结尾。往严重方向猜错
>   同样是猜错，写在这里以免后人照着"被截断"去查。
> · `data-beijing-shepin-fengding`（统计年鉴表 3-14 .xls）的 `text.txt` 头三行是**人写的**
>   出处说明（"本地经 LibreOffice 由 .xls 转 CSV 抽取正文…"）。改由 xlrd 逐格重抽，
>   人写的三行没了，表内数值一个不变：188413÷12×3 = 47103.25，
>   与 12333 口头确认的北京 2023 年度封顶基数一致（见 `data-beijing-*` 相关卡）。
> 两条都用 `--reextract` 重抽（§7.2），raw 与 sha256 一个字节没动。

### 7.6 抽取器的外部依赖（本机装什么）

| 包 | 谁用它 | 缺了会怎样 |
| --- | --- | --- |
| `pyyaml` | 三个脚本读卡片 frontmatter | 脚本起不来 |
| `olefile` | `.doc` / `.xls` 的 OLE 容器拆流 | 审计对这两类格式**判红**并印出 pip 命令 |
| `xlrd` | `.xls` 读单元格（xlrd 2.x 只认 .xls，正合本库） | 同上 |

```bash
pip install --user pyyaml olefile xlrd      # CI 的 knowledge job 装的是同一份
```

**为什么允许这两个依赖，却不许 pypdf**：它们只负责把二进制容器拆开（哪个流、哪个格子），
拆完之后**怎么变成一行行文本，全由本仓的代码决定**——换个版本，输出不变。
pypdf 反过来：文本布局的还原逻辑在它自己那里，版本一变正文就变（见 §7.5 的实测）。
判据不是"有没有依赖"，是"输出会不会随依赖的版本漂"。
