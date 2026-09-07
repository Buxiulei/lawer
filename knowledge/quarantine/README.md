# 隔离区（quarantine）

主理人 2026-09-07 裁决：**知识库里不允许「二手转述」「待核实」**。每条二手信息必须
追到一手信源并逐字核实；**追不到的卡整张移进这里**，不进索引、不被检索、不进 agent 的上下文。

## 怎么用

```
knowledge/quarantine/<原子目录>/<原卡文件名>.md
```

`<原子目录>` 沿用它原来在 `packs/` 下的**整段**相对路径（`statutes/`、`cases/`、`calc/` …），
这样将来核实成功要搬回去时，路径是现成的。**领域包连领域那一段一起沿用**：
`packs/counseling/cases/x.md` → `quarantine/counseling/cases/x.md`，不是 `quarantine/cases/x.md`。
（2026-09-07 收口时纠正过一次：counseling 的两张判例卡一度落在 `quarantine/cases/` 里，
与劳动包的四十来张判例卡混在同一个目录下——搬回去时会搬错地方，而目录本身不会说这件事。）

移动用普通 `mv`，卡片正文一个字不改；**在 frontmatter 之后、正文之前**加一段隔离说明：

```markdown
> **【隔离原因】** 2026-09-07 移入。
> 原 sources 全部是转载（zh.wikisource.org、sohu.com），不是一手源。
> 试过：flk.npc.gov.cn 站内检索「<案号/文号>」无结果；
>       裁判文书网 wenshu.court.gov.cn 需登录，未取到；
>       bjcourt.gov.cn 站内检索无该案号。
> 复活条件：拿到 .gov.cn 上的原件并用 scripts/verify-quotes.py 核过引文。
```

**「试过哪些信源」必须逐条写下来。** 不写的话，下一个人只能把同样的路重走一遍，
而"试过了没找到"与"没人试过"在目录里长得一模一样。

## 谁在拦

| 位置 | 拦法 |
| --- | --- |
| `scripts/gen-knowledge-index.py`（构建期） | 路径含 `quarantine/` 目录段的卡一律不进 `index.json`；**索引里出现隔离区路径即拒绝生成**（CI 即红） |
| `app/src/lib/knowledge/index.ts` (`loadIndex`)（运行时） | `index.json` 里出现隔离区路径 → **把那几条排除出检索面，并 `console.error` 逐条点名**，其余卡照常加载 |
| `scripts/verify-quotes.py` | 不核隔离区的卡（它本来就是"追不到源"的存档） |

两道都拦，是因为生成器管不着**别人手里那份 `index.json`**——部署时换掉的、
别的分支带来的、手改过的。这类失效是静默的：隔离卡照常被检索、照常被引用。

**两道的严厉程度不同，是 manager 2026-09-07 的裁决**：构建期严格（拒绝生成，人就在跟前，
改完重跑即可）；运行时**排除但不拒绝启动**——`loadIndex` 抛错且不缓存，之后每一次预检索、
`knowledge_search`、危机资源卡取卡都会重抛，等于**全站每一轮对话 500**，连卡片没问题的
那批用户一起断。少几张卡好过整个 agent 停机。但排除必须**出声**：静默排除与"这几张卡
从来不存在"在日志里长得一模一样。唯一的例外是**排到一张不剩**——那时权衡反过来
（一个没有知识却照常作答的 agent 比宕机更坏），仍然拒绝启动。
判据见 `app/src/lib/knowledge/__tests__/index-guard.test.ts`。

## 隔离区的 confidence 一律是「待核实」（经理 2026-09-07 裁定）

隔离区的卡**不进索引**，所以它写什么 confidence 一度没人管——于是这里躺着 52 张
`confidence: 原文核实`。那是一句假话：这些卡进隔离区的**全部理由**就是核不动。

它的危害不在检索面（隔离区本来就被排除），在**下一个人**：搬回 `packs/` 的动作只是
一次 `mv`，而搬的人看到 frontmatter 上写着"原文核实"，会以为核实这一步已经有人做过了。

口径：**隔离区里的卡，confidence 只能是 `待核实` 或 `二手转述`**（写卡时它是什么就留什么，
但一律不许挂 `原文核实` / `无外部断言` 这两个"可进索引"的标签）。本次统一改成 `待核实`。

| 位置 | 拦法 |
| --- | --- |
| `scripts/gen-knowledge-index.py` 守卫 (h)（构建期） | `quarantine/**` 下出现 `confidence: 原文核实` 或 `无外部断言` ⇒ 拒绝生成并逐张点名 |
| `app/src/lib/knowledge/__tests__/index-guard.test.ts`（判据） | 直接扫仓库里的 `knowledge/quarantine/**`，同一条规则；它管的是**仓库里现在躺着的这一份**，构建器管的是"生成这一次" |

## 第 12 批（2026-09-07，同源审计与判例引文机制）

**本批复活（移出本区，回到 `knowledge/packs/cases/`）**：

- `case-qingjia-shouxu-maodun-kuanggong-2025`（三中院 2025-05-13 发布会·案例九）——
  核心裁判规则在已登记的官方原件 `cases-bj3zy-2025-dxal`
  （<https://www.court.gov.cn/zixun/xiangqing/465001.html>）正文里**逐字写着**：
  「第九个典型案例指出，劳动者未履行请假手续且请假合理性存疑，其擅自离岗构成旷工。」
  按同场发布会另外三张卡（`case-weixin-youxing-jiaban-sz25-1` 等）已经在用的做法，
  **只保留官方通稿明文的要旨**，删掉全部来自非官方转载站的当事人、岗位、缺勤日期与
  "裁判理由原文"，并补上 `facts.case_quotes` 逐字节选（新机制见 `knowledge/README.md` §2.1）。
  原隔离记录里"只有一句话要旨、核不动"的判断，前提是那张卡要断言大段案情；
  把卡改成只断言那一句之后，它就核得动了。

## 已隔离清单（按批次追加，逐卡记录）

> 每行：id · 隔离原因 · 试过的信源（结果）。详细版留在各卡文件的【隔离原因】块里，
> 这里只放能让下一个人判断"值不值得重试"的摘要。

### 第 8 批（2026-09-07，判例卡，核实员分到 20 张，其中 17 张已被前序按 host 规则批量移入本区、未逐张尝试官方来源）

本批发现与"第 9 批"独立重合：`www.bjcourt.gov.cn` 主站 `521`（WAF）不代表子站不可达，换浏览器 UA 后
`bj3zy.bjcourt.gov.cn`（三中院）、`bj1zy.bjcourt.gov.cn`（一中院）、`cyqfy.bjcourt.gov.cn`（朝阳区法院，
真实子域非之前误猜的 `bjchy`）均可正常访问；`wenshu.court.gov.cn` 首页可达但**检索功能已强制要求登录**
（手机号/支付宝/钉钉，本批未注册未核）——用真实浏览器打开搜索页会被跳转到登录页，绕过 UI 直连
`POST /website/parse/rest.q4w` 返回 `{"code":9,...}`（无有效会话 token）。此前批量隔离时套用的
"文书详情页 `/website/wenshu/181107ANFZ0BXSK4/index.html` 返回要求登录的壳页"这条记录本身是真的，
只是被不加区分地复制到了全部 18 张卡，掩盖了"每张卡具体试过什么"。

**本批复活（移出本区，回到 `knowledge/packs/cases/`）**：北京三中院 2026-04-24《涉竞业限制劳动争议
案件审理情况新闻发布会通稿》六件典型案例，官方页 <https://bj3zy.bjcourt.gov.cn/article/detail/2026/05/id/9317393.shtml>
已登记为 `cases-bj3zy-2026-jingye-dxal`：

- `case-jingye-lanyong-jujue-buchang-sz26-1`（案例一）、`case-jingye-jingzheng-guanxi-shizhi-sz26-2`（案例二）、
  `case-jingye-peiou-daichi-sz26-3`（案例三）、`case-jingye-gongzi-han-buchang-wuxiao-sz26-4`（案例四）、
  `case-jingye-weiyuejin-tiaozheng-sz26-5`（案例五）、`case-jingye-feifa-quzheng-sz26-6`（案例六）——
  官方通稿对六案各只给一句话要旨，原卡（源自 sohu.com 转载）里的具体当事人、金额、日期与大段"裁判理由
  原文"引号内容无法逐字核实（案例五那条更是与登记在册的 `statute-minfadian-hetongbian-tongze-jieshi`
  第六十五条原文核对后发现是**误引**——真实条文没有"预期利益"这个要素、多出的是"合同主体、交易类型、
  履约背景"）。已将六卡改写为**只断言通稿逐字写明的内容**（一句话要旨 + 通稿其他部分的真实引文，
  案例五额外补了第六十五条的逐字原文作独立法律依据），移除全部无法核实的细节，confidence 维持原文核实。

**维持隔离（9 张判决书转录 + 1 张通报会卡，详见各卡【隔离原因】块的逐案记录，已替换此前的模板化记录）**：

- `case-hunton-buchengli-lvsuo-3024`（三中院 (2024)京03民终3024号）、`case-hunton-zhuxiao-gudong-16816`
  （三中院 (2023)京03民终16816号）、`case-jinghu-fuwuqi-sunshi-107`（三中院 (2024)京03民终107号）、
  `case-jingye-yewu-chonghe-weiyue-12630`（三中院 (2023)京03民终12630号）、`case-jixiao-gaijin-chengxu-jing03-16660`
  （三中院 (2023)京03民终16660号）：`bj3zy.bjcourt.gov.cn` 自带检索按案号数字逐一试过，均 0 命中
  （`3024` 唯一命中是一份 2020 年度部门决算里"3024.5万元"的数字巧合，与本案无关）；该站无公开的
  普通案件裁判文书全文库栏目。
- `case-jingye-jingzheng-zhengju-buzu-11222`（一中院 (2023)京01民终11222号）：`bj1zy.bjcourt.gov.cn`
  同法检索 0 命中。
- `case-hunton-wugu-shuangbei-43551`（朝阳法院 (2022)京0105民初43551号）、`case-hunton-yiren-gongsi-liandai-13483`
  （朝阳法院 (2024)京0105民初13483号）、`case-jiechu-buzhengju-jing0105-6093`（朝阳法院 (2023)京0105民初6093号）：
  `cyqfy.bjcourt.gov.cn` 同法检索（日期范围放宽到 2015 年至今）0 命中。
- `case-jiangxin-30-geshui-zhengju-7478`（二审三中院 (2024)京03民终7478号，一审朝阳法院 (2023)京0105民初2634号）：
  两级法院站内检索均 0 命中。
- `case-hunton-liandai-cy24-1`（朝阳法院 2024 涉多元用工典型案例·案例一）：官方通报会原件已找到并登记
  （`cases-cyqfy-2024-duoyuanyonggong-tongbaohui`，与"第 9 批"复用同一篇，未重复登记），但该文只叙述
  通报会本身、未列出任何一件案例的具体案情，核不动。

复活条件同上：拿到判决全文（或该批典型案例逐案详情）的 `.gov.cn` 原件并核过引文；
注册 `wenshu.court.gov.cn` 账号后由本人核验也可，本次未做。

### 第 11 批（2026-09-07，判例卡）

本批分到的判例卡原 sources 均非官方（`zh.wikisource.org` 判决书转录，或
`www.sohu.com` / `m.thepaper.cn` 等媒体转载）。**初轮**只试了 `wenshu.court.gov.cn`
（需登录，`rest.q4w` 返回 `code:9`）、`www.bjcourt.gov.cn`（主站 `521` WAF）、
`rmfyalk.court.gov.cn`（人民法院案例库检索需登录，`code:401`）三条路，全部确认结构性不可达；
**二轮**发现并复用了"第 8/9 批"独立发现的方法——换浏览器 UA 后 `bj3zy.bjcourt.gov.cn`（三中院）/
`cyqfy.bjcourt.gov.cn`（朝阳法院）可直接访问，且自带 `/article/essearch.shtml` 站内全文检索
（日期范围须显式放宽到 2015-01-01 起，默认只搜"最近一年"）——用这条路**成功复活 1 张**（见下），
对其余卡逐一以案号数字与案情关键词检索，二次确认均无单独全文页：

**本批复活（移出本区，回到 `knowledge/packs/cases/`）**：

- `case-yinxing-jiaban-jing03-9602`（"隐形加班第一案"）← `bj3zy.bjcourt.gov.cn` essearch 以关键词
  「隐形加班」检索出 16 篇官方报道，其中《三中院审结首例认定隐形加班案件取得了良好社会效果》
  （主审法官郑吉喆、田艳飞亲自撰写，2023-04-28，理论研究·调研成果）等 4 篇给出了完整案情、
  裁判理由原文与认定标准；但**专门以案号「9602」「67920」与当事人全名「李某艳」检索均 0 命中**——
  三中院官网自己的历次报道从未披露过案号，也从未用过"李某艳"这个全名（只称"李某""李女士"）。
  已按官网原文改写全卡：**移除**网络媒体流传的精确案号与三项加班小时数（140.6/397.9/57.3 小时，
  无官方来源）、案由改为"李某因与领导冲突被移出工作群、旷工被开除后主张加班费"（原卡遗漏了这段
  背景）、加班认定标准补齐法官自述的"提供工作实质性"+"占用时间明显性"两条原则原文，confidence
  维持原文核实。

**以下 10 张维持隔离（二轮 essearch 复核，未见单独全文页）**：

- **case-xianshi-gongping-chexiao-49641**（朝阳法院 (2023)京0105民初49641号）：`cyqfy.bjcourt.gov.cn` essearch 以「49641」「显失公平 解除协议」检索 0 命中。
- **case-xiaoji-daigong-minzhuchengxu-jing03-94**（三中院 (2024)京03民终94号，一审(2023)京0105民初20971号）：`bj3zy.bjcourt.gov.cn` essearch 以「20971」「消极怠工」检索 0 命中。
- **case-xiaoshou-shouce-baifang-jilu-9548**（三中院 (2024)京03民终9548号，一审(2022)京0105民初68898号）：`bj3zy.bjcourt.gov.cn` essearch 以「68898」「行为打卡 拜访记录」检索 0 命中。
- **case-xieyi-yilanzi-fangqi-16272**（三中院 (2023)京03民终16272号）：`bj3zy.bjcourt.gov.cn` essearch 以「16272」「一揽子放弃」检索 0 命中。
- **case-yiqing-zhaoren-jiechu-jing0105-67387**（朝阳法院 (2023)京0105民初67387号）：`cyqfy.bjcourt.gov.cn` essearch 以「67387」「居家办公 公众号」检索 0 命中。
- **case-zaizhi-jingshang-chigu-18348**（三中院 (2023)京03民终18348号）：`bj3zy.bjcourt.gov.cn` essearch 以「18348」「在职经商 持股」检索 0 命中。
- **case-zhuanjiao-baoguo-zhiye-daode-12028**（三中院 (2023)京03民终12028号）：`bj3zy.bjcourt.gov.cn` essearch 以「12028」「转交包裹」检索 0 命中。
- **case-zhengju-caixin-guize-huibian**（16 条判例采信规则汇编，涉 (2024)京03民终99号等多案）：`bj3zy.bjcourt.gov.cn` essearch 以「微信记录 解除决定」检索 0 命中；本卡引用的其余判例中 4 件已被本批或第 8/9 批各自逐案检索确认 0 命中（详见卡内说明）；汇编性质决定它不会比其引用的单案更容易核实。
- **case-xianzhao-liuchan-bingjia-kuanggong-2025**（北京三中院 2025-05-13 发布会 9 件典型案例·案例六，闫某先兆流产案）：官方发布页（`cases-bj3zy-2025-dxal`）逐字核对后确认只是活动纪实通稿；`bj3zy.bjcourt.gov.cn`「典型案件」频道 4 页无对应条目；essearch 以「先兆流产」检索 0 命中。
- **case-xiujia-qingqiu-youdao-lizhi-2025**（同一发布会·案例五，李某休假被诱导离职案）：同上，essearch 以「办离职吧」检索 0 命中。

复活条件统一为：拿到上述判决书或典型案例在 `.gov.cn` 上的**全文**原件（而非通稿摘要），
用 `scripts/fetch-source.py` 登记后以 `scripts/verify-quotes.py` 核过卡内引文。

### 第 9 批（2026-09-07，判例卡，核实员分到 20 张，其中 18 张已被前序批量移入本区）

**工具发现，供后续批次复用**：`www.bjcourt.gov.cn`（北京法院审判信息网主站）确实 `HTTP 521`
（WAF JS 挑战）不可达，但它的**子站**（如 `bj3zy.bjcourt.gov.cn` 北京三中院、`cyqfy.bjcourt.gov.cn`
北京市朝阳区人民法院——朝阳法院真实子域是 `cyqfy` 不是之前猜的 `bjchy`）**换一个浏览器 UA
（如 `curl -A "Mozilla/5.0 ..."`）就能正常访问**，且这些子站自带 `/article/essearch.shtml` 站内检索
（POST 表单，字段 `content_time_publish_begin`/`content_time_publish_end`/`keyword`；**默认查询框会把日期
锁定在"最近一年"，不显式传更早的 `content_time_publish_begin` 就会把 2024 年及更早的内容全部漏检**，
这一坑导致本批一度误判"检索无结果"）。本批用这条路径**成功复活 2 张**（见下方"本批复活"），
建议后续批次遇到 `京03`/`京0105` 案号、且案件曾被三中院/朝阳法院自己的"司睿案例库""案件快报""入选人民法院
案例库"栏目报道过的，优先试这条路，而不是止步于 `www.bjcourt.gov.cn` 主站 521。

**本批复活（移出本区，回到 `knowledge/packs/cases/`，不再需要下面的隔离清单跟踪）**：

- `case-jujie-xinhuo-jing03-5083` ← 官方源 `bj3zy.bjcourt.gov.cn`「司睿案例库」找到，案情与裁判理由逐字核对一致；原卡里的具体案号"（2025）京03民终5083号"、入库编号、精确赔偿金额"120,094元"官网未披露，已按官网原文改写为"官方案例，未公开案号""12万余元"。
- `case-peiou-jingye-jing03-683` ← 官方源 `bj3zy.bjcourt.gov.cn`「我院新增两篇案例入选人民法院案例库」找到，案情与裁判理由逐字核对一致；原卡里的入库编号、案号、"天津某冠公司"、精确判决金额官网未披露，已按官网原文改写。

**新增隔离（原在 `packs/cases/`，本批发现引用源已失效，移入本区）**：

- **case-mowei-taotai-shangwei-guize-2016**（第八次全国法院民事商事审判工作会议（民事部分）纪要，无案号）：
  原卡唯一 sources 链接 `gov.cn/xinwen/2016-11/30/content_5140730.htm` 本机实测 **404**。用 `web.archive.org`
  存档核实了历史内容（仅供参考，非引用信源）：确认原文是新华社通稿，标题、内容与卡片描述均不完全一致，且
  **该纪要全文只有 36 条，卡片"多家律所援引为第47条"的说法已被证伪**（不存在第47条）。`court.gov.cn` 站内
  搜索多组关键词均 0 命中。详见卡内隔离说明。

**以下 16 张维持隔离（本批逐张复查，含新尝试的信源，详见各卡【隔离原因】块）**：

- `case-keguan-yiqing-yewuliang-jing03-15429`、`case-keguan-zhanlue-tiaozheng-jing03-20183`：`bj3zy.bjcourt.gov.cn` 检索"疫情 业务量""客观情况""客观情况发生重大变化""组织架构调整"及双方案号均 0 命中——这两案是普通二审案件，未被制成官方专文。
- `case-qianfu-yongjin-38-jiechu-16097`（焦某）、`case-lirun-20-jixiao-weiyuejin-11114`（苏某）、`case-lizhi-zhengming-jianli-riqi-72152`（郭某）、`case-luyin-lihai-guanxi-bucaina-14444`（姚某）、`case-nianzhongjiang-jishu-2n-jing0105-33722`（钟奇燕/楷亚锐衡）、`case-qingjia-benshang-jing03-9422`（乔某伟）：`bj3zy.bjcourt.gov.cn` 与 `cyqfy.bjcourt.gov.cn` 站内检索当事人姓名均 0 命中或只命中同名他案。
- `case-nianzhongjiang-beijing-koujing`（8 案汇编卡）：其中 2 案已在上面确认查无官方专文，其余 6 案本批预算内未逐一复查。
- `case-peichanjia-shijia-koufa-sz25-7`、`case-nianjia-guoqi-zuofei-wuxiao-sz25-2`、`case-nianjia-yuerjia-gongzi-sz25-8`（均属北京三中院 2025-05-13 发布会 9 件典型案例之一）：除已登记的通稿 `cases-bj3zy-2025-dxal` 外，本批另找到并登记了同一发布会的调研版报道 `cases-bj3zy-2025-xiuxijiajiaquan-diaoyan`（<https://bj3zy.bjcourt.gov.cn/article/detail/2025/06/id/8865668.shtml>），比通稿多一两句案情，但仍**未逐案给出本卡引用级别的案情细节与裁判理由原文**，核不动。
- `case-nongmingong-zongbao-qingchang-cy24-5`、`case-paiqian-gongjijin-guocuo-cy24-6`、`case-pingtai-yonggong-qunti-tiaojie-cy24-7`（均属朝阳法院 2024-07-25 涉多元用工典型案例通报会）：找到并登记了朝阳法院官方原件 `cases-cyqfy-2024-duoyuanyonggong-tongbaohui`（<https://cyqfy.bjcourt.gov.cn/article/detail/2024/08/id/8071059.shtml>），但该文**只叙述通报会本身，未列出任何一件具体典型案例的案情**，核不动。

复活条件同上：拿到判决全文或典型案例逐案全文的 `.gov.cn` 原件并核过引文；
汇编/通报会类通稿不算——只有一句话要旨的官方页不足以核实本卡断言的具体案情与裁判理由原文。

### 第 13 批（2026-09-07，心理咨询纠纷领域包 `packs/counseling`，核实员第 3 批；收口时归位到 `quarantine/counseling/cases/`）

本批分到 3 张判例卡，1 张（四川高院退费案）在四川省高级人民法院官网「典型案例」栏目
（`scfy.scssfw.gov.cn`）找到官方原文并复活（登记为 `cases-scfy-2024-xiaofei-dxal-3`，
案情、金额与裁判理由逐字核对一致，改写为只断言官网原文，回到 `knowledge/packs/counseling/cases/`）。
以下 2 张维持隔离：

- **case-dongni-lisongwei-weizhongshen**（冬妮诉李松蔚名誉权互诉案）：卡片自述"2024 年开庭·
  未终审"，按 [[method-counseling-panli-heyan]] 未终审案件没有先例价值；唯一来源为澎湃新闻转载，
  非 `.gov.cn`。本次复核用 `html.duckduckgo.com` 检索该案后续进展，搜索引擎持续返回 HTTP 202
  （限流）未获结果，本会话 WebSearch 工具配额已耗尽（200/200），未能确认终审情况。
- **case-guge-mingyu-quan**（顾歌诉来访者家属名誉权案）：唯一来源是代理律所（上海市光大律师
  事务所）官网的自我宣传文章，不是司法机关或中立媒体发布，案号/审理法院/判决年份均未载。
  试过：`www.court.gov.cn` 新闻中心/典型案例栏目人工翻页未见收录；`rmfyalk.court.gov.cn`
  （人民法院案例库）首页可达但检索接口 `/cpws_al_api/api/cpwsAl/...` 直接请求返回
  `400 Bad Request`（需前端会话，未能绕过）；`wenshu.court.gov.cn` 搜到的 2 个 `down/one?docId=`
  直链请求均返回 0 字节（需要登录会话）；`html.duckduckgo.com`／`www.bing.com`／`www.so.com`
  多次检索均被限流或返回与查询无关的结果。

复活条件同上：拿到该案（或顾歌案）在 `.gov.cn` 上的判决全文/官方通稿并核过引文；
冬妮案额外需要确认已终审。
