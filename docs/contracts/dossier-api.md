# 契约：公司档案 / 图谱的接口形状

> 本篇由**工单 C（呈现层）**落笔，钉的是「界面要显示什么，因此后端必须给什么」。
> A（统计管线）与 B（计费流）按此实现；对不上的地方以本篇为准提出修改，别各改各的。
>
> 类型的**唯一事实源是代码**，不是本篇：
> - 图谱：`app/src/lib/graph/contract.ts`
> - 档案与报价：`app/src/lib/dossier/contract.ts`
>
> 本篇只解释「为什么是这个形状」——那部分代码里写不下，而它恰恰是最容易被改掉的部分。

---

## 一、`GET /api/v1/cases/:id/company-graph` — **已落地**（工单 C）

```
200 { ok: true, graph: CompanyGraph | null }
404 { ok: false, error_code: 'CASE_NOT_FOUND', message: '案件不存在' }
```

- `graph === null` = **这案还没做过公司调查**，不是错误。界面走「调查完成后这里会生成关系图谱」。
  返回空图（`nodes: []`）是错的：空图会渲染成一张什么都没有的画布。
- 归属校验复用 `lib/cases` 的入口，别人的案件一律 `CASE_NOT_FOUND`（不返回 403）。
- 取数：`lib/db/company-graph.ts`（SQL）→ `lib/graph/build.ts`（组装）。

### 几条已经钉死在测试里的口径

| 口径 | 取法 | 为什么 |
|---|---|---|
| `litigationCount` | `company_litigation` 里 `is_labor=1` 的**全部**行 | **不按年限截断**。真数据里 `judged_at` 大量为空，按 5 年卡会整批筛掉它们 ⇒ 涉诉多的公司显示得比实际干净。少报比多报贵。界面措辞同步改成「已入档的劳动争议」 |
| `tier` | `company_watches.tier`：daily→1 / weekly→2 / archive→3；无盯梢行→3 | 同一主体多个盯梢时**取最强**那档，不按行序取。圈层在界面上是"我们盯得多勤"的承诺，按插入顺序取会让同一份数据显示成不同的承诺 |
| `confidence` | 认不出的值降到「低」 | 取不准时偏向报警：少信一条边只是少一条线索，多信一条边会让人拿着没证据的关系去开庭 |
| `confidenceNote` / `updateNote` | 恒为 `''` | demo mock 里那是调查员写的叙事，真数据没有对应来源。**不拿通用话术填** |
| 边 | 两端都必须落在本案主体上 | 跨案脏边会让图上冒出本案没有的节点 |

---

## 二、`GET /api/v1/cases/:id/dossier` — **待 A/B 落地**

页面取档案走这条。响应：

```
200 { ok: true, dossier: DossierView | null }   // null = 还没建档
404 error_code 'DOSSIER_NOT_FOUND' 亦按"还没建档"处理（界面同样走招呼页，不当故障）
```

`DossierView` 见 `lib/dossier/contract.ts`。B 若已实现按 dossier id 取的 `GET /api/v1/company/dossiers/{id}`，
这条可以是它的薄包装（案件 → 该案 dossier）；**页面只认这一条**，因为页面手上只有 caseId。

### 呈现层会**拒绝渲染**的情况——后端据此决定字段怎么填

这一节是本篇最重要的部分。界面上所有的错误都不是"显示坏了"，而是"显示得太自信"。

1. **三件套缺一不出数字**。每张统计卡必须带 `sampleN` / `asOf` / `source`。
   缺任一 ⇒ 界面不出任何数字，改出「这张卡缺 X，在补齐之前不出数字」。
   - `sampleN: 0` 算**有**这一项（"我们查了，一条都没有"是有信息的话），只有 `null` 算缺。
   - `asOf` = `MAX(fetched_at)`，即"数据只到这一天"。
   - `source` 建议逐字用「裁判文书网·人机接力取证」。

2. **比率的分母只准是 `docsOutcomeDecided`**，且指标名叫
   **「劳动者全部或部分获支持的比例」**，不叫胜诉率。
   `docsOutcomeDecided < minSample` ⇒ 界面出：
   `样本不足：已入档 {docsTotal} 条，其中取到全文 {docsFulltext} 篇、可判定结果 {docsOutcomeDecided} 篇，不足 {minSample} 篇不出比例`
   四个数都要给对——「为什么出不了这个数」本身就是用户该知道的信息。

3. **`minSample` 必须来自 `pricing_config`**（`dossier.min_sample_outcome` /
   `dossier.min_sample_duration`），随响应下发。界面**没有任何地方写死 5**，
   有测试钉着（门槛给 8 时样本 6 照样不出数）。

4. **申请人方分布 `byApplicant` 必填**，与比例同屏并列。
   不区分程序位置的比率会把方向读反——存在用人单位批量起诉员工的案子，
   那时"公司赢了"和"劳动者输了"不是同一件事。

5. **时长四段各自独立**：各段自带 `n` / `medianDays` / 三件套，各判各的门槛，
   一段不足**不牵连**其它段。
   **契约里没有、也不许加"平均时长"这类合成字段**——有结构守卫测试扫 `avg|average|平均`。
   注意：`n` 不够但 `medianDays` 算得出来（2 篇也能算中位数）是最危险的输入，
   界面按 `n` 判，不按"有没有值"判。

6. **没有 `evidence` 的 pattern 渲染不出来**。后端应当在落库前就丢掉
   （案号要在库、引文要是全文逐字子串），界面是第二道。
   `droppedPatterns` 必填且会显示给用户——静默丢弃会把模型编造率藏起来，
   而编造率是这条红线唯一的体温计。

7. **`coverageNote` 是必渲染的结构化字段**，与统计卡同屏同级、**不折叠**。
   界面把它排在统计数字**之前**（排页尾的话，一屏读不完时它等于不存在）。
   有测试钉着"不点开任何折叠块就能读到全文"。

8. **仲裁地首发只做北京朝阳**。`venue.covered === false` 时界面只出一句
   「本档案暂不含该仲裁地的实操与判案风格（我们只对已逐字核实的辖区出这一块）」，
   **不出任何风格描述**。后端组这一节用 `lib/dossier/venue.ts`，
   索引里没有的卡 id 一律丢弃（将来接 LLM 选卡时，编出来的 id 落地成"少一张卡"，
   不是一张卡、也不是 500）。

9. **`companyName` 不进标题**。页面标题、tab title、面包屑固定「公司档案」四个字，
   公司名只出现在正文的打码块里。

10. **`tenureYears` 不参与任何统计**，只用于判例呈现排序。界面必须写明这一句。

### 已知缺口（需要跨工单补）

- `VenueCard.sources` **当前恒为空数组**。知识库 pack 的 frontmatter 里有 `sources`，
  但 `knowledge/index.json` 没有导出它，`lib/knowledge` 的 `PackMeta` 也就没有这个字段。
  补齐要改索引生成器 `gen-knowledge-index.py` + 重新生成 `index.json` —— 跨工单、
  且会与任何重新生成索引的人冲突，故本工单不动。界面在 `sources` 非空时会渲染，
  空时整块不渲染（不显示空标题）。卡正文里本身带着官方 URL，用户不至于没有出处。

---

## 三、报价与确认 — **已落地，形状归计费侧**

`POST /api/v1/company/dossiers/quote` / `confirm` 的请求与响应形状见
**`docs/contracts/dossier-billing-api.md`**（v3 拆包按模块计价），类型源在
`app/src/lib/company/dossier-billing.ts`。

> 本篇原先在这里写过一份 v2 的形状（`{ case_id, company_name, tenure_years }` →
> `lines: QuoteLine[]`，谱系块 + 判例块两块打包）。v3 改成六模块各自计价后它已作废，
> **连同 `lib/dossier/contract.ts` 里那份 `QuoteLine` / `DossierQuote` 一起删掉了**，
> 没有留"兼容形状"：两份报价契约并存的那天，页面按其中一份渲染、服务端按另一份收钱，
> 两边各自看着都对，而用户看到的价与实扣的价不是一个数。

呈现侧在这条链路上要守的，写在 `app/src/lib/dossier/order.ts`（判据在
`lib/dossier/__tests__/order.test.ts` 与报价页组件测试里）：

- **报价页零扣费**。页面上唯一动钱的调用是用户点「确认并扣费」之后的 confirm。
- **先免费探测再谈钱**（`POST /api/v1/company/probe`，见下）。四个计数既是扣费前
  可验证的事实，也是每块卖不卖的判据：关联 0 → 关联谱系置灰；涉诉 0 → 涉诉清单置灰；
  有公开文书链接篇数 < 门槛 → 深度两块置灰（这一条的判据在服务端，前端用它 409 的原话）。
- **置灰必须带原因句，且句里带着观测到的那个数**，并且**不显示价**——
  一个买不到的东西标着价，是在卖一个我们不打算给的承诺。
- **合计只是把服务端给的行相加**，前端不参与定价。`total / coreSubtotal /
  payableGongdao / shortfall` 四个数与服务端 `quoteDossier` 对同一子集算出来的
  逐字相等，有对账测试（同一份真库、真迁移、真函数跑）。
- **契约 §二 的四句诚实红线在扣费前就在屏幕上**，不折叠、不小字化。
- **赠送额守护出黄条但不阻断**：扣完撑不起一次首诊（`intakeReserve`）时提醒顺序，
  真正拦下单的只有余额不够。

## 四、`POST /api/v1/company/probe` — **已落地**（本工单）

请求 `{ name, uscc? }`（`case:read`）→ `{ ok: true, probe: ProbeResult }`，
类型源 `app/src/lib/company/probe.ts`。**不扣费、不建档**。

- 命中缓存 0 成本、不占配额、不限次；`collected` 才占配额。
- 降级（`no_collector` / `quota_exhausted`）**不返回空载荷**，只带 `reason`。
  界面**逐字渲染那句话**：它专门写来区分「这一刻没去查」与「查无此公司」，
  改写或补一份全 0 的载荷就把这个区分抹掉了。
- `payload.as_of` 是硬门槛：没有采集时点的四个数就是四个悬浮的数，界面必须同屏显示它。

## 五、`POST /api/v1/cases/:id/watch` — **已落地**（本工单）

一键加守望（spec v3 §2.1 M3）。请求 `{ name, uscc?, company_profile_id?, tier? }`
（**`case:write`** —— 它让这个账号下个月产生一笔月费），
→ `{ ok: true, watch: { id, created, tier, monthly_gongdao } }`。

- **这条不扣钱**：只落一行 `company_watches`，扣费在 `lib/company/watch-billing` 的月度巡检。
  界面照这个说，不写成「已扣 199」。
- 连点去重在 `lib/company/watch.addWatch`（同案同主体一条活跃盯梢），
  命中已有的**不改它的 tier**；因此响应里的 `tier` 读的是**库里那一行**，不是请求里那个——
  回显请求档位会让页面显示「已按每周档盯着」而库里其实是每日档。
- 未知 tier 一律 400，不静默回落 daily（回落会让用户以为自己挑了 0 公道值那档）。
- 入口 UI 的中性文案约束：低调模式下整块不出现「监控 / 守望 / 公司」，
  口径同 `lib/notify/copy` 的守望计费通知。三档说明两种模式**同一句**——
  一句话两个版本，漂了没有任何一处会报错。
