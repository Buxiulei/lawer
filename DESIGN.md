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

## Decisions Log
| 日期 | 决策 | 理由 |
|------|------|------|
| 2026-08-19 | 主色深松石绿而非蓝/金/紫 | 安抚+专业，避开政务蓝/律所金/AI 紫套路 |
| 2026-08-19 | 红色仅风险/不可逆 | 焦虑用户，警报色是稀缺资源 |
| 2026-08-19 | 系统字体栈不加载 CJK webfont | 移动端体积/弱网 |
| 2026-08-19 | Tailwind v4 + 手写组件，不引 UI 框架 | manager 规定重型框架需先问；控制体积与风格一致性 |
| 2026-08-19 | 低调模式 | 地铁偷看场景，隐私即情绪安抚 |
