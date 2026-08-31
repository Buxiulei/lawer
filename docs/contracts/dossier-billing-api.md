# 契约 · 公司档案报价与确认扣费（工单 B）

- 提案人：工单 B「报价确认计费流 + 会员赠送」｜起草 2026-08-31，分支 `ws/dossier-billing`
- 收件：工单 C（图谱与档案呈现 UI，按本契约接前端）、工单 A（采集管线，共用 `company_dossiers`）
- 范围：**只覆盖三条计费端点**。采集分块进度、统计卡、套路卡由工单 A/C 各自出契约；
  本文件不猜它们的形状，届时在 `GET /{id}` 的响应里**新增字段**合流，已有字段不动。
- 口径以《公司档案模块化方案 v3》为准：**拆包按模块计价**，v2 的「谱系块 / 判例块两块打包」已作废。

---

## 一、口径先说清

| 概念 | 是什么 | 不是什么 |
|---|---|---|
| `company_dossiers` | **公司维度**的平台资产，`company_key` 唯一，跨案件跨账号共享 | 不是案件私有资产（那是 `company_profiles`） |
| 模块（module） | 分开计价、分开扣、分开退的**六个**一次性交付物 | 不是交付进度的状态机 |
| 核心四项 | `venue` / `entity` / `graph` / `docs_list`：秒级~分钟级、必定有货 | 不是「必须一起买」，可任选 |
| 深度两项 | `docs_stats` / `patterns`：按篇计价、人工接力、可能样本不足 | 不打包硬卖，有自动退款兜底 |
| `alreadyPaid` / `paid` | 这个**账号**为这一块**付过费**（含钱付、券付、免费，也含已退款的） | **不等于已交付**。交付看采集侧 |

价目与阈值全部在 `pricing_config` 表，键见 `app/src/lib/billing/pricing-config.ts` 的 `PRICE_FALLBACK`。
**前端不许写死任何价**：改价是往表里写一行、不发版，页面写死就会出现「显示 340、实际扣 200」。

六个模块与当前兜底价（表里有行以表为准）：

| module | 中文名 | 计价口径 `priceBasis` | 当前价 |
|---|---|---|---|
| `venue` | 仲裁地实操 | `free` | 0（信任锚：全站共享预生成辖区卡） |
| `entity` | 主体体检 | `fixed` | 60 |
| `graph` | 关联谱系 | `fixed` | 200 |
| `docs_list` | 涉诉清单 | `fixed` | 80 |
| `docs_stats` | 涉诉深度统计 | `per_doc` | 70/篇，计费篇数上限 30 |
| `patterns` | 人事套路归纳 | `base_plus_per_doc` | 240 起（含前 20 篇），第 21 篇起每篇 +4 |

核心四项合计 340，**受结构守卫钉死 ≤ 700**（= 注册赠送 1000 − 一次首诊预留 300）：
核心档案不得花光赠送额把用户堵在首诊门口。越线由 `coreBundleWithinGuard` 在 CI 拦下。

---

## 二、`POST /api/v1/company/dossiers/quote` — 报价

- 鉴权：`case:read`
- **这条端点不动钱**：不扣费、不建档、不占额度。有对照测试逐字断言余额、流水行数、档案行数不变。

请求：

```jsonc
{
  "name": "北京甲科技有限公司",   // 必填。归一化后为空 → 400 COMPANY_NAME_EMPTY
  "uscc": "91110105MA01ABCD2X", // 可选。填了就以它为 company_key，公司更名不换档
  "modules": ["entity", "graph"], // 可选。省略=六块都报；含未知值/空数组 → 400 INVALID_MODULES
  "doc_count": 5                // 可选，默认 0。有公开文书链接的劳动争议篇数，M5/M6 计价与可售性判据
}
```

`doc_count` 的权威来源应是服务端探测缓存（采集工单）；该表落地前由本路由透传。
两个方向都不放行低价套利：篇数低于门槛只会被置灰不卖，篇数高只会让用户付更多。

响应 `200`（示例为 `doc_count: 5` 时买全六块）：

```jsonc
{
  "ok": true,
  "quote": {
    "companyKey": "北京甲科技有限公司",
    "name": "北京甲科技有限公司",
    "uscc": null,
    "dossierId": 12,        // 已有存档则为其 id；从未建过档为 null
    "billableDocs": 5,      // = min(doc_count, 30)，超上限的篇数不入档、不处理、不计费
    "items": [
      { "module": "venue",      "label": "仲裁地实操",   "isCore": true,  "priceBasis": "free",              "gongdao": 0,   "alreadyPaid": false },
      { "module": "entity",     "label": "主体体检",     "isCore": true,  "priceBasis": "fixed",             "gongdao": 60,  "alreadyPaid": false },
      { "module": "graph",      "label": "关联谱系",     "isCore": true,  "priceBasis": "fixed",             "gongdao": 200, "alreadyPaid": false },
      { "module": "docs_list",  "label": "涉诉清单",     "isCore": true,  "priceBasis": "fixed",             "gongdao": 80,  "alreadyPaid": false },
      { "module": "docs_stats", "label": "涉诉深度统计", "isCore": false, "priceBasis": "per_doc",           "gongdao": 350, "formula": "5 篇 × 70 = 350", "alreadyPaid": false },
      { "module": "patterns",   "label": "人事套路归纳", "isCore": false, "priceBasis": "base_plus_per_doc", "gongdao": 240, "formula": "240 起（含前 20 篇）+ (5−20)×4 = 240", "alreadyPaid": false }
    ],
    "total": 930,               // 本次应付原价合计（已付过的块计 0，不重复收）
    "coreSubtotal": 340,        // 其中核心四项小计 —— 赠送券能抵扣的就是这一段
    "membershipCreditAvailable": false, // true=有未核销的会员赠送券
    "payableGongdao": 930,      // 真正走公道值扣的额：有券时 = total − coreSubtotal
    "balance": 3000,
    "shortfall": 0,             // 余额缺口，按 payableGongdao 算（不是按 total）
    "intakeReserve": 300,       // 发起一次首诊所需预留，赠送额守护黄条用它，**不阻断下单**
    "litigationSlaDays": 7,     // M5 文书取证上限（工作日），超期自动全额退该模块
    "minDocurlToSell": 5        // M5/M6 可售门槛
  }
}
```

**页面必须在扣费前渲染出来的四句**（这是设计里绑死的诚实红线，不是可选文案）：

1. 拆价可见，核心四项与深度两项可以**分开买**——深度两项可能样本不足，不打包硬卖；
2. 「文书部分需人工登录取证，最长 `litigationSlaDays` 个工作日」；
3. 「样本不足或超期未交付，自动全额退还该模块费用」；
4. `billableDocs < doc_count` 时另加一句：「超出 `billableDocs` 篇的部分不入档、不处理、也不收费」。

---

## 三、`POST /api/v1/company/dossiers/confirm` — 确认扣费并建档

- 鉴权：**`case:write`**（只读凭据触发不了扣费，有测试钉死）
- 请求体与报价端点**逐字同形**：把报价用的那个对象原样发过来。

响应 `200`：

```jsonc
{
  "ok": true,
  "dossier_id": 12,
  "paid_by": "membership_credit", // gongdao | membership_credit | none
  "charged": 590,                 // 本次实扣公道值（券覆盖的核心为 0，深度按价）
  "entitlement_id": 7,            // 核销掉的赠送券 id，未用券为 null
  "quote": { /* 同上，下单时点的报价快照 */ }
}
```

`paid_by` 三值的语义**别混**：

- `gongdao` —— 全部走公道值扣费，流水在 `gongdao_ledger`；
- `membership_credit` —— 核销了一张赠送券覆盖**核心四项**，
  **深度两项仍然扣钱**（`charged` 就是那部分）。券覆盖的核心块在账本里是 `delta=0` 的标记行：
  余额不动，但「这块买过没有」照样查得到。凭据在 `entitlements.consumed_ref` 与
  `company_dossiers.paid_by/paid_ref` 两处；
- `none` —— 请求的模块此前都已付过，本次一分钱没动（重复确认的正常结果，不是错误）。

【每个模块一笔独立消耗】幂等键 `dossier-{档案id}-u{用户id}-{module}`：退一块不牵连另一块，
多个买家买同一家公司各自一笔、互不撞键。退款键由 `gongdaoRefund` 拼成 `refund-{上串}`。

失败：

| status | error_code | 何时 |
|---|---|---|
| 400 | `INVALID_BODY` / `INVALID_MODULES` / `INVALID_DOC_COUNT` | 入参格式不合法 |
| 400 | `COMPANY_NAME_EMPTY` / `DOSSIER_MODULES_EMPTY` | 公司名归一化后为空 / 归一化后一个模块都不剩 |
| 402 | `GONGDAO_INSUFFICIENT` | 余额不足。**此时一条档案都不会建、券也不会被核销**（整笔回滚） |
| 403 | `FORBIDDEN_SCOPE` | 凭据没有 `case:write` |
| 409 | `DOSSIER_DOCS_BELOW_SELL_FLOOR` | 有公开文书链接篇数 < `minDocurlToSell`，深度两项直接不卖（核心四项不受影响） |
| 409 | `DOSSIER_DEPENDENCY_UNMET` | 只勾了 `patterns` 没勾 `docs_stats`，且此前也没买过它 |

`INVALID_MODULES` **不做「过滤掉未知值」这种宽容处理**：`['graph','graphs']` 被过滤成
`['graph']` 后，用户会看到一个他没选的价，且没有任何一处会报错。

⚠️ **已知边界**：TTL 到期后同一账号对同一家公司「再买一次刷新」当前不成立——
它撞的还是同一个幂等键，会被判为重放（`paid_by='none'`、不扣钱也不重跑）。
二次刷新要成立需要给每次购买一个自己的身份（一张购买单），另开工单。
前端在 `paid_by='none'` 且用户本意是刷新时，应如实说「本公司的这一块你已购买过」，
不要显示成「已下单，正在采集」。

---

## 四、`GET /api/v1/company/dossiers/{id}` — 档案状态与计费实况

- 鉴权：`case:read`；**无权与不存在返回同一个 404 `DOSSIER_NOT_FOUND`**
  （分开答就成了「这家公司有没有人建过档」的探针）。非法 id 走同一个 404。
- 可见范围：下单人本人、为它付过任一模块费的账号、用赠送券换过它核心的账号。

响应 `200`：

```jsonc
{
  "ok": true,
  "dossier": {
    "id": 12, "company_key": "…", "name": "…", "uscc": null,
    "status": "queued",                      // queued | awaiting_relay | done（值域归采集管线）
    "created_at": "2026-08-31 10:00:00"
  },
  "billing": {
    "modules": [                             // 恒为全部六块，没买的 paid=false
      { "module": "venue",      "label": "仲裁地实操",   "isCore": true,  "paid": true,  "charged": 0,   "refunded": 0 },
      { "module": "graph",      "label": "关联谱系",     "isCore": true,  "paid": true,  "charged": 200, "refunded": 200 },
      { "module": "docs_stats", "label": "涉诉深度统计", "isCore": false, "paid": false, "charged": 0,   "refunded": 0 }
      // …省略
    ],
    "net_gongdao": 140,                      // 扣 − 退
    "paid_by_membership_credit": false
  }
}
```

`refunded > 0` 即这一块没达标或没交付，**页面必须说出来**（「样本不足，本块费用已退回」），
不要只把数字改成 0 了事——退了钱却不说，用户只会以为系统吞了东西。

**本响应暂不含采集分块进度**：那张表在工单 A。与其在这里编一个 `progress` 字段占位，
不如先不给——一个永远停在 `queued`、看起来却完全正常的假进度，比缺一个字段难查得多。

---

## 五、给工单 A 的三个咬合点

1. **`company_dossiers` / `pricing_config` / `entitlements` 三张表已在 `app/src/lib/db/migrate.ts` 建好**
   （本分支交付，migrate 幂等、`migrate.test.ts` 的表清单已同步到 42 张）。
   A 若也写了同名 `CREATE TABLE IF NOT EXISTS`，合并时**保留一份**并核对列是超集，不要各留各的。
   `company_dossiers.status` 的值域归 A：本分支只读不写它，建档取 DDL 默认 `'queued'`。
2. **退款入口只有一个**：`app/src/lib/company/refund.ts`。巡检 job 每轮无脑调用是安全的
   （幂等在账本上），「这轮退没退过」不需要 job 自己记。**别在别处再写一遍退款**：
   - `refundGraphIfLowConfidence(db, id, 高置信边数)` —— M3，门槛 `dossier.min_graph_high_conf_edges`
   - `refundDocsStatsIfSampleShort(db, id, 可判定篇数)` —— M5，门槛 `dossier.min_sample_outcome`
   - `refundDocsStatsSlaExpired(db, id)` —— M5 超期（是否超期由 job 按 `dossier.litigation_sla_days` 判）
   - `refundPatternsIfKeptShort(db, id, 保留条目数)` —— M6，门槛 `dossier.min_patterns_kept`
3. **门槛值一律经 `readPrice()` 读 `pricing_config`**，不要硬编码 5 / 2 / 3 / 7 / 30。
   负值与小数会当场抛三段式错误（指名键、实际值、怎么改），不静默回落。

## 六、已知缺口（本分支未做，接手前先看这条）

**买会员尚未自动发券**：`fulfillment.fulfillOrder` 里没有 `grantEntitlement`、
`reverseOrder` 里没有 `revokeUnconsumedBySource`。本分支交付的是「有券怎么用」
（`consumeEntitlement` / `confirmDossier`），发券那一步还没接。
缺口有测试路标钉着（`billing/__tests__/entitlements.test.ts` 末尾那个 describe），
接线的人一改代码它就红，改成正向断言即可。
