# Design System — lawer 裁员应对专员（前端）

> WS3 前端设计系统，由 /design-consultation 产出。UI 相关决策先读本文件；偏离需在 PR 里说明。
> 上位约束：docs/specs/2026-08-19-lawer-design.md（§1 目标、§8 模块、D12 不做刻意人设）。

## Product Context
- **是什么**：AI 劳动仲裁全程陪跑工作台（问诊→档案→行动建议→证据→文书）。
- **给谁用**：北京朝阳请不起律师的被裁劳动者。焦虑、法律零基础，常在地铁上/会议室外用手机偷偷看。
- **项目类型**：移动优先的 Web App（PWA），PC 自适应为工作台形态。

## 基调（Visual Thesis）
**「深夜里的一盏台灯」**——沉静、温暖、有秩序。不是冷冰冰的政务/律所站，也不幼稚卖萌。
每个页面必须让用户 3 秒内看到"下一步做什么"。文案冷静、具体、不煽情；
**红线：绝不出现"建议咨询专业律师"类劝退话术**（spec §1 非目标）。

## 色彩（restrained：一个主色 + 语义色，红色是稀缺资源）

### Light（默认）
```css
--bg: #F7F6F3;          /* 暖纸白底 */
--surface: #FFFFFF;      /* 卡片 */
--surface-2: #F0EEE9;    /* 次级面/输入框底 */
--ink: #26272B;          /* 正文 */
--ink-2: #6B6C70;        /* 次要文字 */
--line: #E4E2DC;         /* 分隔线 */
--primary: #146D63;      /* 深松石绿：按钮/链接/选中态 */
--primary-ink: #0F544C;  /* 主色深文字 */
--primary-wash: #E3EFED; /* 主色淡底（行动卡/选中背景） */
--amber: #B45309;        /* 截止日/待办紧迫——不是红 */
--amber-wash: #FBF0E3;
--danger: #C0453C;       /* 仅：风险条款标红、不可逆操作确认 */
--danger-wash: #F9E9E7;
--success: #2F7D4F;      /* 已固化/已完成 */
--success-wash: #E7F2EB;
```

### Dark（`.dark` 或 prefers-color-scheme）
```css
--bg: #151719; --surface: #1E2124; --surface-2: #26292D;
--ink: #E8E6E1; --ink-2: #9B9C9E; --line: #33363A;
--primary: #3FA396; --primary-ink: #6BC0B4; --primary-wash: #1C3230;
--amber: #E0913C; --amber-wash: #33270F;
--danger: #E06A5F; --danger-wash: #3A201D;
--success: #5CAF7E; --success-wash: #1C2F24;
```

规则：
- **红色只用于**：文件解读的风险条款标红、发送给公司前的二次确认、删除类操作。到期提醒/倒计时用 amber。焦虑用户面前不滥用警报色。
- 状态徽标：已上传=灰、已固化=success、已出证=primary、逾期=amber。

## 字体与中文排版
- 全站系统栈，不加载 CJK webfont：
  `-apple-system, "PingFang SC", "HarmonyOS Sans SC", "MiSans", "Noto Sans SC", "Microsoft YaHei", sans-serif`
- 金额/日期/倒计时：`font-variant-numeric: tabular-nums`；金额用 600 字重 + primary-ink。
- 正文 16px/1.7，移动端不小于 15px；标题靠字重（600/650）与字号分级，不靠颜色。
- 段落 max-width 38em；法条原文引用块：surface-2 底 + 4px primary 左边线，衬线不强求。
- 标点悬挂不做（成本高收益低）；中西文间距由文案规范保证（数字与汉字间留空格）。

## 间距·圆角·层级
- 基准 4px；常用 8/12/16/24/32。页面左右留白：移动 16px，PC 24px。
- 圆角：卡片 12px、按钮 10px、徽标 999px。不做全员大圆角。
- 阴影极轻（0 1px 3px rgba(0,0,0,.06)），层级主要靠底色差与分隔线。

## 布局
- **移动优先单列** + 底部 Tab（工作台 / 证据 / 文书 / 我的），Tab 高 56px。
- 案件档案在移动端 = 右滑抽屉/半屏 sheet；PC ≥1024px = 双栏（对话流 flex-1 + 档案面板 360px）。
- 触屏目标 ≥44×44px；主操作按钮高 48px。
- 对话流：AI 消息不加气泡底（像文档一样可读），用户消息浅色气泡靠右；行动卡/法条卡是流内一等公民组件。

## 动效
- minimal-functional：过渡 150–250ms ease-out；SSE 流式文字直接渲染，不加打字机光标动画以外的花活。
- 抽屉/Sheet 250ms；骨架屏用于列表加载；不做弹跳、视差、装饰动画。

## 关键组件语义
- **行动卡 ActionCard**：checkbox + 标题 + 截止日(amber) + 展开详情；勾选=完成，写回档案待办。
- **法条卡 LawRefCard**:「《劳动合同法》第 47 条」+ 一句话结论，点开显示逐字原文（surface-2 引用块）。
- **二次确认 ConfirmDialog**：凡"会被公司看到/不可逆"的操作（发送异议函、分享链接、删除证据）必须弹确认，确认按钮文案写明后果（如"确认发送给公司"），danger 色仅此处用于按钮。
- **固化徽标 EvidenceBadge**：已上传/已固化/已出证 三态 + "原始载体请自己保留"常驻提示条。
- **倒计时 DeadlineChip**：≤3 天 amber 底，>3 天灰底；绝不红底闪烁。

## RISK（有意的差异化，两条）
1. **低调模式**：顶栏一键开关。开启后：金额、公司名、案件标题打码（`filter: blur`，点按暂显 3s）；`<title>` 与 PWA 名显示为中性"工作台"。为地铁/工位偷看场景设计。
2. **行动优先的对话流**：每次 AI 回复后置顶"现在做什么"行动卡组，对话可折叠——服务 spec"快速准确的行动建议第一优先"，不是普通聊天产品。

## PWA
- manifest：name「裁员应对专员」/ short_name「陪跑」，theme_color 跟随深浅色，图标中性（几何台灯/盾形，不用法槌天平）。
- 低调模式开启时 document.title 切换为「工作台」。

## 情绪与文案规则
- 空状态/等待文案给确定感：「已收到，正在核对北京口径的计算标准…」而非「AI 思考中」。
- 不用感叹号堆砌安慰；用"下一步"给确定感。严重情绪引流 NBDpsy 遵守 spec §10 红线（一案最多一次）。

## API 对接约定（前端红线）
- **存证验证 `/verify`（含公开页 /verify/:no）**：后端即使验签不通过也返回 HTTP 200，**裁决只看响应体 `overall_ok` 字段**。前端绝不许拿 `res.ok`/状态码当验证结果；`overall_ok === false` 时必须明确展示「验证未通过」红态（danger 色允许场景）。`overall_ok === true` 才展示通过绿态。缺字段/解析失败按"无法验证"处理，不得展示为通过。（来源：WS2 sidecar 契约，manager 2026-08-19 转发）

## 视觉方向 v2（spec D13，2026-08-20 用户拍板，重制排批2后）

### NBDpsy 品牌 token（从 /home/roots/NBDpsy/frontend 三端代码提取，以 marketing-web v2 为准）
- 勃艮第主色：`#8B2942`（light `#A23D55` / dark `#6D1F33`）
- 淡金辅助：`#B8995E`（哑金亮部 `#D4AF37` / dark `#8A7340`）
- 米白底：`#FFFCF5` / 暖 `#FAF5EB` / admin `#FAF8F5`；surface `#FFFFFF`；text `#2B1F1A`；border `#E8E4DC`
- 语义色纪律（重制时执行）：告警/不可逆红**不用** NBDpsy 的 `#B3423A`（与勃艮第区分不足），往亮朱红调并出对比样张报批；期限倒计时独立橙系（`#C07A1A` 方向），避开淡金；深浅双主题+低调模式在新色系下重新映射并实测。

### 开源模板候选（License 已逐字核实原文，留档备查）
1. **Kiranism/next-shadcn-dashboard-starter**（首选骨架参考）
   - https://github.com/Kiranism/next-shadcn-dashboard-starter （~6.8k star，活跃）
   - License：MIT。原文摘录：`MIT License\n\nCopyright (c) 2023 Kiranism`
   - Next.js 16 + React 19 + Tailwind v4 + shadcn/ui（token=CSS 变量，改色成本最低）；landing+dashboard 全形态
   - 预览：https://www.shadcn.io/template/kiranism-next-shadcn-dashboard-starter
   - ⚠ 采用即引入 shadcn/Radix 组件体系，与现有手写组件并存/迁移需拍板
2. **shadcn/ui 官方 Blocks**（设计语言底座+缺口区块补充）
   - https://github.com/shadcn-ui/ui （122k star，Vercel 官方）
   - License：MIT。原文摘录：`MIT License\n\nCopyright (c) 2023 shadcn`
   - 区块形态（dashboard/sidebar/登录/图表），需自行拼装；预览 https://ui.shadcn.com/blocks
3. **TailAdmin 免费版**（数据密集组件按需单独移植）
   - https://github.com/TailAdmin/free-nextjs-admin-dashboard （~2.3k star，2025-12 有提交）
   - License：MIT。原文摘录：`MIT License\n\nCopyright (c) 2023 TailAdmin`
   - Next 16+React 19+Tailwind v4；免费版仅 1 个基础 dashboard+50+ 组件，无 landing；非 token 系统改色成本较高
   - 预览：https://demo.tailadmin.com/

排除留档：**Preline UI**——MIT+“Fair Use License”双许可，含竞品限制/署名/终止条款（"shall not be used to create any product or service that directly competes with Preline UI"），不符宽松许可铁律；**Windmill Dashboard**——license 纯 MIT 但 2024 起无维护、栈老旧。

### 品牌主题 token 定稿（2026-08-21，主会话设计，语义变量名不变=全站一次换肤）

语义名沿用 v1（--bg/--surface/--surface-2/--ink/--ink-2/--line/--primary/--primary-ink/--primary-wash/--amber*/--danger*/--success*），新增 --gold/--gold-wash。

| 语义 | Light | Dark | 用法纪律 |
|---|---|---|---|
| bg | `#FFFCF5` 米白 | `#171310` 暖黑 | 页面底 |
| surface | `#FFFFFF` | `#201A17` | 卡片 |
| surface-2 | `#F5EFE3` | `#2A2320` | 次级面/输入底/引用块 |
| ink / ink-2 | `#2B1F1A` / `#6E5C50` | `#EAE3D9` / `#A3988B` | 正文/次要 |
| line | `#E8E4DC` | `#3A322D` | 分隔线 |
| **primary 勃艮第** | `#8B2942` | `#C55D76` | 按钮/链接/选中；primary-ink `#6D1F33`/`#D98BA0`；wash `#F5E7EB`/`#332026` |
| **gold 淡金** | `#8A7340`（文字级）/装饰 `#B8995E` | `#C9A75B` | **仅品牌点缀**：logo、会员/成就徽标、选中高光、图表次系列；**禁止**用于警示、倒计时、可点击主操作；wash `#F5E6C8`/`#2E2717` |
| **danger 亮朱红** | `#D9442F` | `#E5705C` | 风险条款标红/不可逆确认，**与勃艮第显著区分**（朱红偏橙、勃艮第偏紫深）；wash `#FBE9E5`/`#3B1F1A`；**文字级 danger-ink `#B5361F`**（浅色主题下小号文字/chip 用，对白约 6:1；深色主题 danger-ink=danger） |
| **amber→期限橙** | `#B4690E` | `#E09A46` | 截止日/倒计时专用，独立橙系不与淡金混（金偏黄褐、橙偏橘）；wash `#FAF0E1`/`#33270F`；**文字级 amber-ink `#8F540A`**（同上，约 6:1；深色主题 amber-ink=amber） |
| success | `#2F7D5D` | `#5CAF8A` | 已固化/完成；wash `#E8F3EE`/`#1C2F26` |

配套：阴影/圆角向 NBDpsy 靠（卡 12px 不变、阴影仍极轻）；低调模式打码规则不变，新色系下 blur 底色随 surface；theme_color（manifest/viewport）同步 `#FFFCF5`/`#171310`。
可辨识性自查线：勃艮第 vs 朱红 ΔHue≈25°+明度差；淡金 vs 期限橙在 wash 底上并排可区分（实测截图为证）。

### 第三方组件体系引入清单（manager 2026-08-21 立规，每次引入必做）
1. **token 桥接同步验证**：把某个核心 token（如 --primary）临时改成显眼测试色，起 dev 确认新旧两套组件**同时**变色，截图留证后改回——凡有一处不变，即存在"第二套色值"，先修桥接再继续。（B1 实录：此法抓出桥接层一处写死白色）
2. 焦点圈/键盘行为与既有体系统一（全局 outline 一套观感；ESC 语义一致），跨页导航流实测。
3. 整页单体系：内容区交互组件整页归一；壳层全站统一切换不算混用。

### shadcn 基元清单（B2 第一波补齐，第二波只消费不新增）
`src/components/shadcn/` 现有基元一览。**新增基元只在补齐波做**，后续波次直接用；
确实缺件时先提出来，不要在页面里就地手写第二套。

- B1 建：`button` `card` `input` `label` `field` `separator` `switch` `checkbox` `tabs`
  `tooltip` `dialog` `alert-dialog` `sheet` `dropdown-menu` `collapsible` `breadcrumb`
  `sidebar` `icons` `utils`，以及三个薄封装 `app-sheet`（=旧 `ui/Sheet` 的 props）、
  `confirm-dialog`（=旧 `ui/ConfirmDialog` 的 props）、`use-focus-restore`。
- B2 补：`table` `data-table` `textarea`（+`field` 里的 `TextareaField`）`badge` `progress`
  `skeleton` `alert` `empty-state` `radio-group` `select`。

只有 `radio-group` 拉了新依赖（`@radix-ui/react-radio-group`），换来一组单选在 Tab 序里
只占一个停靠点、组内方向键走位；其余基元都是原生元素 + token，没加包。
`select` 是**原生 `<select>`** 的封装（手机上出系统滚轮，比自绘浮层好按），
本波没有消费方，是给第二波表单预置的；富内容菜单走 `dropdown-menu`。

### 数据表格 `DataTable` 用法（给第二波：账户流水等）
`src/components/shadcn/data-table.tsx`。一份 `columns` 同时喂两副面孔：
**≥sm 出 TailAdmin 风格表格，<sm 降级成卡片列表**——390 宽下六列必然溢出，
而横向拖动会把「这一行是什么」拖出视野，所以窄屏不留横向滚动条，改每行一张卡。

```tsx
const COLUMNS: DataTableColumn<Ledger>[] = [
  { key: 'item', header: '项目', card: 'title', cell: (r) => r.item },
  { key: 'amount', header: '金额', numeric: true, sensitive: true,
    card: 'footnote', cell: (r) => formatAmount(r.amount) },
  { key: 'state', header: '状态', card: 'badge', cell: (r) => <Badge>{r.state}</Badge> },
];

<DataTable columns={COLUMNS} rows={rows} rowKey={(r) => r.id}
           caption="账户流水" onRowClick={(r) => setOpenId(r.id)} />
```

- `card` 说明这一列在窄屏卡片里落到哪：`title` 主标题、`badge` 与标题同排、
  `meta` 副行、`footnote` 末行小字（多列以 · 相连、空列自动跳过）、`hide` 窄屏不显示。
  不写默认 `meta`。**加列时两副面孔一起改**，就是靠这个字段绑在一起的。
- `numeric` 右对齐并走等宽数字。
- `sensitive` 管低调模式：行可点时只打码不接管点击（点按要留给「打开详情」，
  去详情里看），行不可点时包 `<Sensitive>`，点按临时显示 3 秒。
  **凡列里可能出现金额、公司名、案件标题就要标**——证据库的「证明目的」栏
  正因为写着「平均工资为 25000 元」才补标的。
- `onRowClick` 让首列文字变成按钮、整行是它的热区（行的点击冒泡上去，
  不重复挂 handler）；`rowLabel` 不给就用首列文字当无障碍名字。
- 列宽靠 `cell` 里内层 `<span>` 的 `max-w` 卡住：表格是 auto 布局，
  光给 `td` 加 `max-w` 不生效，长文本记得配 `truncate` 或 `sm:line-clamp-2`。
- 两副面孔分组方式不同时用 `faces`：证据库 ≥sm 是一张平表（类别是列）、
  <sm 按类别分节，于是表格那半 `faces="table"`、每节各来一次 `faces="cards"`。

### 重制执行分两个 PR
- **PR-A token 换肤**：globals.css 全量替换 + 组件内写死色值清查 + 深浅/低调模式重映射 + 全页面截图实测。
- **PR-B 组合骨架布局重制**：引 shadcn 基建（CSS 变量对接自家 token），按 Kiranism/Blocks/TailAdmin 逐页重制布局，整页单体系纪律。

### 终选（2026-08-20 用户拍板）：组合方案
- **主骨架**：next-shadcn-dashboard-starter；**区块缺口**：shadcn/ui 官方 Blocks；**数据表格组件**：TailAdmin 免费版按需挖取。三家均 MIT，组合合法。
- **shadcn/Radix 引入已批准（渐进式）**：新页面用 shadcn 体系；既有手写组件不动、不做存量迁移。
- **纪律：同一页面内不混两套交互组件**——整页归属一个体系（shadcn 或手写），避免焦点管理/键盘导航行为不一致。
- 执行顺序：批2 → 新品牌主题重制（基于组合骨架）→ 图谱页直接用新主题。

## 视觉方向 v3（2026-08-27 用户拍板，前端重构 brief）

**触发**：产品负责人原话「前端页面需要整体重构优化，现在太丑了」；品牌改名「土拨鼠劳动仲裁」；色板定死勃艮第红 / 淡金 / 米白。

**诊断（前端页面盘点，全部量化）**：
- 手机端工作台只有一个断点 `xl`(1280)，393–1279 同一套版式；**五种语义卡片共用一个容器类、只靠底色区分，而底色间对比度 1.02–1.15:1**——视觉上就是同一个颜色。8 张一样的卡摞 4.4 屏。
- 上次重制（v2）只做了壳层和 shadcn 基元；**七个页面的内容区布局从未按模板重做**，仍是 #12 那版手写骨架。
- 桌面端不丑。品牌只剩一个抽象箭头。

**三个决定（用户原话）**：
| # | 决定 | 影响 |
|---|---|---|
| ① | 底色 `surface / surface-2 / primary-wash`：**「不算，可以动」** | 品牌三色不动；这组不是品牌色，可调对比或改为结构区分 |
| ② | 骨架：**「壳层留，内容区改按 GOV.UK + chatbot」** | **改了 2026-08-20 那次拍板**（主骨架 next-shadcn-dashboard-starter）。壳层已按它做完、保留；内容区不再走仪表盘密度 |
| ③ | 改名：**「全换成"土拨鼠劳动仲裁"」** | 18 个文件，其中 4 处不是 UI 串（见下） |

**两个锚**：对话工作台 → `vercel/chatbot`（Apache 2.0，LICENSE 已核）；档案/期限/行动卡 → **GOV.UK Design System**（MIT）——大字号、低密度、`warning-text` 法律后果警示条、祈使句。中文字号按 Ant Design 14/22 基准。
**避开**：仪表盘密度（shadcn-admin 一路）、taxonomy（已归档）、open-webui（Svelte，许可有变更史）。

**分四批，每批一个 PR、独立可上线**：
| 批 | 动什么 | 验收 |
|---|---|---|
| 0 清债 | 删 4 手写基元换 shadcn；修 DeadlineChip/EvidenceBadge 传染源；性能工装收进 `scripts/perf/` 依赖自带（原借六爻 node_modules） | 混用页 0（扣 Toast 口径）；tsc+vitest 绿；干净 clone 能跑工装；视觉与改前一致 |
| 1 手机工作台 | 加 sm/md/lg 断点；五种卡片改**结构区分**不再只靠底色；「现在做什么」一眼跳出。**规格见 `docs/design-notes/2026-08-27-批1-手机工作台重制.md`**（六级分量表、断点表、灰度验收） | 393 截图对照 + 灰度测试；性能工装（含灵敏度对照臂） |
| 2 品牌+首页 | logo 落位；全站改名；首页按 GOV.UK 语气重写首屏 | Lighthouse 桌面+移动**分别**审 |
| 3 内容区排版 | 证据页（Summary List 替六张单卡、Inset text 替公告块）/ 文书页（结论升为标题栏）/ 字号与间距 token / 批 1 遗留 28px 热区。**规格见 `docs/design-notes/2026-08-27-批3-内容区排版.md`** | 结论是卡内最大的字（给数）；`text-[NNpx]` 硬编码归零；灰度可分 |

**批 2 改名的 4 处非 UI 串，不能 sed**：
- `lib/agent/charter.ts:19` — 模型 system prompt 的自我指称，改了评测 judge 可能引用
- `lib/evidence/attest.ts:184` — `issuer` 字段。**已核（08-27）：它是每次请求现生成的报告对象里的显示标签，不落库、验证端不读不比（`src/app/verify` / `api/v1/verify` / `lib/evidence` 三处递归 grep 只此一处）。改名安全；已签发的 PDF 保留旧名属历史事实，无需兼容。**
- `lib/notify/copy.ts` + 其测试 — 邮件主题含品牌名且测试断言排除敏感词，改名要同步改测试
- `api/mcp/route.ts` / `lib/mcp/jsonrpc.ts` / `agentSetup.ts` — 对外 MCP 自述，外部 agent 可能按字面匹配

## Decisions Log
| 日期 | 决策 | 理由 |
|------|------|------|
| 2026-08-19 | 主色深松石绿而非蓝/金/紫 | 安抚+专业，避开政务蓝/律所金/AI 紫套路 |
| 2026-08-19 | 红色仅风险/不可逆 | 焦虑用户，警报色是稀缺资源 |
| 2026-08-19 | 系统字体栈不加载 CJK webfont | 移动端体积/弱网 |
| 2026-08-19 | Tailwind v4 + 手写组件，不引 UI 框架 | manager 规定重型框架需先问；控制体积与风格一致性 |
| 2026-08-19 | 低调模式 | 地铁偷看场景，隐私即情绪安抚 |
| 2026-08-20 | 视觉 v2 组合方案 + shadcn/Radix 渐进式引入 | 用户终选；整页单体系纪律防交互不一致 |
| 2026-08-27 | 底色 surface/surface-2/primary-wash 可动（品牌三色不动） | 用户拍板；工作台"丑"的主因是这组 1.05:1 的底色，不是品牌色 |
| 2026-08-27 | 壳层留、内容区改按 GOV.UK + vercel/chatbot | 用户拍板，**覆盖 08-20 主骨架决定**；上次目标是"像后台"，这次要避开的正是仪表盘密度 |
| 2026-08-27 | 全站改名「土拨鼠劳动仲裁」 | 用户拍板；品牌隐喻=土拨鼠站立守望 |
