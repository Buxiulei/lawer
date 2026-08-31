# scripts/perf —— 前端性能与交互测量工装

自起一个**独立** Chrome 跑低端机模拟、真实触摸事件、跨断点版式测量。
用来验「改动有没有把体验改坏」，尤其是重构前后的对照。

## 怎么跑

```sh
cd app && npm ci                 # 依赖（playwright-core）在 app 包里
cd app && npx next build && npx next start -p 3127 &

node scripts/perf/g4-layout.mjs                    # 跨断点版式：页高/卡片数/底色分布
PERF_BASE=http://127.0.0.1:3128 node scripts/perf/g4-layout.mjs   # 指定别的端口

Xvfb :95 -screen 0 400x900x24 &                    # 有头模式要先起虚拟显示
HEADED=1 node scripts/perf/g1-scroll.mjs /case/demo 3
node scripts/perf/g2-input.mjs                     # 真实触摸：点住即显/恐慌钮/图谱拖拽
node scripts/perf/g1-sanity.mjs                    # 灵敏度对照臂，见下
node scripts/perf/contrast-scan.mjs /login dark    # 渲染后对比度扫描（文字 + 控件边框/焦点框）

# C-08 的判据（退出码 0/1，可直接当门禁）：面包屑末项在 360 宽真出省略号
cd app && npx next dev -p 3129 &
PERF_BASE=http://localhost:3129 node scripts/perf/g5-breadcrumb.mjs
```

**`g5-breadcrumb.mjs` 的 PERF_BASE 必须写 `localhost`，不能写 `127.0.0.1`。**
Next dev 的 `allowedDevOrigins` 默认只放行 localhost，从 127.0.0.1 进来的 `/_next`
客户端 chunk 被拦掉 ⇒ 页面只有服务端 HTML、**根本不 hydrate** ⇒ 顶栏「案件档案」按钮
不登记 ⇒ 右侧控件窄一大截 ⇒ 面包屑挤不着 ⇒ **判据假绿**。
同一份代码实测：127.0.0.1 量出"重叠 108px"（其实是按钮不存在），localhost 量出 12px。
脚本等不到那个按钮会直接报错，不会静默量一个不犯病的版式。

环境变量：`PERF_BASE`（被测站点，默认 3127）、`PERF_PROFILE`（Chrome 用户目录，
默认临时目录）、`PERF_CHROME`（默认 `/usr/bin/google-chrome`）、`PERF_DISPLAY`（默认 `:95`）、
`PERF_TOKEN`（只有 `contrast-scan.mjs` 用，写进 localStorage 的登录态）。

## 两个外部依赖不在 npm 里

- **系统 Chrome**。`playwright-core` 故意不下载浏览器：我们自起系统 Chrome 再
  `connectOverCDP`，这样**绝不碰**共享的 chrome-devtools-mcp / ms-playwright-mcp 浏览器，
  也不 kill 任何现存 chrome 进程。没装就 `PERF_CHROME` 指一个。
- **Xvfb**，只有有头模式要。**无头下帧数据是假的**，原因见下。

## 硬纪律

**永远用独立的 `--user-data-dir`。** 别去连别人的调试端口、别 kill 别人的 chrome——
共享浏览器被占用时正确做法是自己起一个，不是抢。

## 上一轮（2026-08-26）的结果与有效性签

结果文件本身归档在 `caiyuan-ws/eval-evidence-archive/frontend/perf-harness/results/`（不入仓库）。
**这一节留在这里是因为它是判据不是数据**： 废数据和有效数据文件名长得像，
不标清楚下一个人会读错——而读错的方向恰好是"看起来更好看"的那边。

### 可以直接引用（本轮最终结论）
- `fin-casedemo-d.json` `fin-casedemo-m.json` `fin-landing-d.json` `fin-landing-m.json`
  —— 两条路由 × 桌面/移动两版式的 a11y 终审，**四项全 100 无失败项**（修复后）
- `g2-raw.json` —— 真实输入 11 项全过（**选择器与时序订正之后**的那一版）
- `g1-headed.json` 的**载入段**（LCP/FCP/CLS/长任务）：Xvfb 有头、真实滚动

### 有效但已过时（修复前的基线，只作对照）
- `lh-case-desktop.json` 桌面版式 96 分、2 项失败 —— 就是这两项后来被修掉的
- `lh-case-mobile.json` `lh-landing.json` `lh-landing-desktop.json` 修复前，均 100

### ⚠️ 废数据，不要引用
- **`lh-case.json`** —— `--preset=desktop` 顶掉了 `--form-factor=mobile`，
  实际在 1350×940 跑的，**口径冲突，已作废重跑**。别当"移动端结果"读。
- **`g1-raw.json`** —— 无头跑的。滚动是真的（2884px），但**帧数据无效**：
  无头下 rAF 是固定 60Hz 的 BeginFrame 节拍，光栅代价根本不进读数。
- **`raw-scroll-4x.json`** —— 2026-08-25 10:01，上一次尝试留下的，
  **我没有核验过它的方法学**，跑的还是旧端口 3126（旧构建）。
  其 LCP=88ms 不可信；帧数据必然与 `g1-raw` 同病。**当遗留物看，别当数据。**

### `g1-sanity.json` —— 它不是数据，它是证据
四档对照：无糊层 / `blur(5px)`（实际值）/ `blur(40px)` / `blur(120px)`，
**掉帧率全 0%、最大帧间隔全 16.8ms，四档完全一致。**

120px 高斯模糊糊满整页不可能不掉帧 ⇒ **这不是"糊层没代价"，是仪器看不见代价。**
所以本轮**没有出具掉帧率数字**，报的是「无法真实模拟」。

由此立的规矩（manager 已入册）：
> **任何"没有差异"的结论，出具前必须先证明这台仪器能看见差异。**
> 加一条已知应当有差异的对照臂；对照臂也没差异 ⇒ 报"无法真实模拟"，
> **不许把"测不出来"写成"没问题"。**

要拿到真实掉帧率只有两条路：真机 USB 调试，或线上 RUM 采真实用户帧数据。

---

## 这套工装踩过的坑（复用前先看，都会静默骗人）

1. **`Input.synthesizeScrollGesture` 传 `gestureSourceType:'touch'` 在无头下静默不滚。**
   页面纹丝没动，却照样报出一串漂亮的"0% 掉帧"。真实触摸要用
   `Input.dispatchTouchEvent` 逐点派发（`g1-touch-test.mjs` 就是当时的对比验证）。
   ⇒ **凡"做了动作再测结果"的测试，必须同时测量"那个动作到底发生了没有"**
   （所以 `g1-scroll.mjs` 里有 `scrolledPx` 字段，它不是装饰）。
2. **抓错元素**：`/case/demo` 上有 **2 个同名「低调模式」开关**（顶栏一个、悬浮钮一个），
   `.find()` 拿到的是顶栏那个普通开关，于是测出"单击关掉了、长按反而开着"的诡异结果；
   页面上有 **21 个 svg**，`querySelector('svg')` 抓到的是图标不是图谱。
   ⇒ 首轮 4 条 FAIL **全部是测试自身的错，不是产品缺陷**。
3. **`--preset=desktop` 会顶掉 `--form-factor=mobile`**，且不报错。
4. **只按移动版式审 a11y 会拿到虚假满分**：证据表格是 `≥sm` 才渲染的两面式布局，
   412px 下那半棵树根本不存在。**桌面版式审出的 2 项，移动版式一项都测不到。**
   ⇒ a11y 按版式分别审。

## 查横向溢出：只认「能横向滚动的距离」，禁用 scrollWidth

```js
const se = document.scrollingElement;
const before = se.scrollLeft;
se.scrollLeft = 9999;
const 可滚距离 = se.scrollLeft;   // 0 ＝ 没有横向溢出
se.scrollLeft = before;
```

**为什么把 `documentElement.scrollWidth` 拉黑**（2026-08-28 实测立规）：

落地页在 Chrome 移动模拟下，`scrollWidth` 恒比视口宽 **36px**，而同一时刻
**可滚距离是 0、没有任何元素被裁、`html`/`body` 的 `overflow` 都是 `visible`**
——手指推不动，用户什么也感觉不到。

罪魁是 `ui/Toast.tsx` 那个 `fixed inset-x-0` 的 aria-live 容器，它**自己喂自己**：
容器以布局视口为包含块，又把布局视口撑大；429 与 393 都是稳定不动点，
落在哪个取决于布局历史（运行时注入 `max-width:100%` 会掉到 393，
同一条 CSS 打进构建、冷启动则照旧 429）。

代价不在那 36px 本身，在于**它把这把尺子废了**：全站基线永远 +36，
以后真出现一个 20px 的溢出，会淹在这个常数里、和正常状态分不出来。

⇒ 判据换成症状本身（推得动推不动），不用代理指标。
**fullPage 截图的画布宽同理不可信**，它跟着 `scrollWidth` 走。

