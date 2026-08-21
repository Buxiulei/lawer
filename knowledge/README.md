# knowledge packs 编译规范 v1.1（manager 2026-08-19 批准；v1.1 增 facts 字段，2026-08-20）

> 供 `lib/knowledge/`（pack 加载与检索）与律师 agent 消费。原料在服务器本地
> `research/raw/`（不入仓库）；本目录全部为**原创编译产物**，可入库。

## 1. 目录与命名

```
knowledge/
  README.md            # 本规范
  index.json           # 全量索引（脚本可再生成，先手工维护）
  TODO核实清单.md       # 所有「待核实」条目集中登记
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
sources:
  - https://flk.npc.gov.cn/...
confidence: 原文核实   # 原文核实|二手转述|待核实（取全 pack 最低档）
updated: 2026-08-19
---
```

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
```

- `status`: `usable`（可输出给用户）| `forbidden`（已证伪/危险号码，代码层拦截，绝不输出）。
- `category`: `crisis`（心理危机）| `legal`（法援/法律咨询）| `union`（工会）| `inspection`（人社/监察）——代码按 category 筛线，禁按 name 关键词猜。
- `dial_hint`（用户向，可直接渲染给用户）与 `agent_note`（agent 内部指令，**绝不渲染**）严格分离；
  `usable` 热线必须有 `dial_hint`；旧混受众字段 `note` **废弃**，出现即校验失败。
- `key`: 全库唯一的 snake_case 英文键，代码按 key 取数；`source_idx` 指向本卡 sources 数组下标。
- `statute_quotes.text` 必须与正文引用块**逐字一致**（空白归一后比对）。
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

## 3. 各 type 正文骨架

- **法条卡**：`## 条文原文`（逐字引用块，注明版本/文号/施行日）→ `## 适用要点` →
  `## 北京口径`（无则写「无地方特别口径」）→ `## 常见误区`（可选）。
- **判例卡**：案号/法院/裁判年份/来源链接 → 案情要旨 → 争议焦点 → 结果 →
  裁判理由（尽量原文摘录）→ 对劳动者的启示。**无真实案号绝不编造**；
  官方发布但未公开案号的写「官方案例，未公开案号」，存疑标 `confidence: 待核实`。
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
2. **宁缺毋错**：拿不准的数字/案号/文号一律「【待核实】」并同步登记
   `TODO核实清单.md`（格式：pack id · 待核实点 · 建议核实途径）。
3. 法条**逐字**引用原文块，不改写、不省略号截断关键句；转述放「适用要点」。
4. `confidence` 取整包最低档：正文只要有一处待核实即标 `待核实`。
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

数组，每项：`{id, type, title, keywords, applies_to, region, confidence, updated, path}`。
`path` 相对 `knowledge/`。检索逻辑（lib/knowledge）：keywords + applies_to + title 分词匹配。
