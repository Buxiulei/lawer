# 核实闭卷记录（2026-09-07）

> 本文件从前叫《待核实清单》，登记的是"哪些点还没核"。**它现在不再有那个用途**——
> 主理人 2026-09-07 裁决：**知识库里不允许「二手转述」「待核实」**。每条二手信息必须追到
> 一手信源并逐字核实；追不到的卡整张移进 `knowledge/quarantine/<原子目录>/`，不进索引。
> 于是"待核实"不再是一种可以停留的状态，只有两个去处：核实，或隔离。
>
> 文件名保留不动（外部有引用），内容改为**闭卷记录**：核前核后各是什么样、隔离了什么、
> 还剩哪些够不着的口子，以及下一个人从哪儿接着干。

## 一、统计

| | 核实前（基线 `aeb5e9e`） | 闭卷时（`f11b346`） | 收口后（本次） |
| --- | ---: | ---: | ---: |
| `原文核实` | 139 | 156 | **157** |
| `待核实` | 60 | 0 | **0** |
| `二手转述` | 21 | 0 | **0** |
| `无外部断言`（D 类，见 `README.md` §2.2） | — | 3 | **4** |
| `knowledge/packs/` 合计 | 220 | 159 | **161** |
| `knowledge/quarantine/` | 0 | 61 | **60** |

闭卷时 159 + 61 = 220：一张没丢，也没有新增。**减少的 61 张全部是判例卡**（103 → 42），
其余九类卡片数一张未动——移走的是"引文只有转载来源、官方渠道查不到全文"的判决书转录卡，
不是按主题裁的。隔离清单与逐张的"试过哪些信源"在 [`quarantine/README.md`](quarantine/README.md)。

收口后 161 + 60 = 221，比基线多 1：`case-qingjia-shouxu-maodun-kuanggong-2025`
按官方页原文重写后从隔离区**搬回**（61→60、159→160），另**新建** 1 张数据卡
`data-beijing-gongzheng-baoquan-shoufei`（160→161）。

配套的机械面（数字都是本次收口当场跑出来的）：

- 法源登记簿 `knowledge/sources.json`：**96 份官方原件**（官方案例 24、法律 17、规范性文件 13、
  官方数据 12、行政法规 10、司法解释 8、部门规章 6、机构官网 3、地方规章 3），落在 21 个 host 上；
  非 `.gov.cn` 的只有 3 个，全部是 `kind=机构官网` 的机构自己的官网（`www.bcnpo.cn`、
  `www.crisis.org.cn`、`www.pkuh6.cn`），每一个都在登记簿里写明 `justification`，
  且只有数据卡能引（守卫 (g)，`README.md` §7.1.1）。
- 引文机械核验 `scripts/verify-quotes.py`：**323 条引文全部「一致」**
  （`facts.statute_quotes` 279 条 + `facts.case_quotes` 44 条），不一致 0、找不到原件 0。
- **判例卡 `case_quotes` 覆盖 43 / 43 = 100%**：`packs/cases/` 下每一张都至少有一条
  从官方页逐字摘下来、且核得过的原文（守卫 (f)）。收口前是 1 / 43。
- 登记簿同源审计 `scripts/audit-sources.py`：96 条登记，**复算一致 94、未复算 2、有问题 0**。
  未复算的 2 条都是 pdf，为什么不算它们见 `README.md` §7.5；
  原先未复算的另两条（`.zip` 打包件与 `.xls` 年鉴表）本次补了机械抽取器整份重抽，已进复算量程。
- 生成器 `scripts/gen-knowledge-index.py`（**默认 `--strict`，不再带 `--no-strict`**）：
  161 张卡、八道守卫全绿。CI 的 knowledge job 也同步去掉了降级。

## 二、三类处置各是什么意思

1. **核实**——追到 `.gov.cn`（或登记在册的行业规范发布机构官网）的原件，用
   `scripts/fetch-source.py` 抓下来存档 + 登记 sha256，再用 `scripts/verify-quotes.py`
   把卡里的引文逐字对上。改的是"出处"，不是"内容"。
2. **改写**——官方原件确实存在，但它比卡里写的**少**：只给一句话要旨，没有案号、金额、
   裁判理由全文。这类卡按官方原文范围重写，**删掉一切核不动的细节**（六起竞业典型案例、
   隐形加班案的案号与加班小时数、司睿案例库两案的入库编号与精确金额，均属此类）。
   留下的每一句都能在官方页上指出来。
3. **隔离**——官方渠道查不到全文。整张移进 `quarantine/`，卡内加【隔离原因】块，
   **逐条写清试过哪些信源、各是什么结果**。不写的话，"试过了没找到"与"没人试过"
   在目录里长得一模一样，下一个人只能把同样的路重走一遍。

## 三、还够不着的口子（本轮已各再试一次，仍未取到）

这三条不是"忘了做"，是**本环境到那个站点的网络层／检索层过不去**。写下来是为了让下一个人
知道从哪儿接着试，而不是从头再撞一遍同一堵墙。

| 文件 | 卡里现在怎么处理 | 试过什么 | 复活条件 |
| --- | --- | --- | --- |
| 《工会法律援助办法》（总工发〔2008〕52 号） | **卡里已不再转述它的任何条件**：`sop-jiancha-vs-zhongcai` 的（A）段改成只说"窗口在同楼、热线 12351、受理条件当面问窗口"，不写谁能申请、要不要经济困难审查 | 全总官网 `acftu.org` 及全部子域被出口 IP 级硬拦截：`curl` 四档全部 `HTTP 412`（腾讯云 WAF JS 挑战），真实无头 Chromium 打开返回 `HTTP 510`、页面明写「触发WAF防护：30140」；`www.gov.cn` 当年的新华社通稿现址 404 且只是转述报道，不含条文；`flk.npc.gov.cn` 与 `mohrss.gov.cn` 均未收录该文件全文 | 换一个能访问 `acftu.org` 的出口，或找到该文件在某个 `.gov.cn` 上的全文转载页 |
| 劳部发〔1995〕236 号（贯彻医疗期规定的通知） | 卡里已无引用（`sop-yiliaoqi-baohu` 现在只引 479 号本身，逐字核过） | `mohrss.gov.cn` 规章库 5 页 75 条、劳动关系与综合两个规范性文件频道全部翻过；六轮"宣布失效和废止"通知（298+241 份目录）逐份核对——236 号**不在废止名单里**，但也找不到在线全文；`flk.npc.gov.cn` 的 `robots.txt` 明文禁止自动化采集且 `Disallow: /`，按纪律未尝试 | 人工在 `flk.npc.gov.cn` 检索到该文并取得全文，或人社部把它挂回规范性文件库 |
| 朝阳区人民法院立案一庭的门牌号与电话、三中院的地址电话与接待时段 | 坐标卡 `data-beijing-lian-zuobiao` 标 `status: unverified`，**代码层禁止渲染具体值**；本轮把 `sop-yishen-ersheng-sop`、`template-minshi-shangsuzhuang`、`sop-zhixing-sop` 里各自抄了一份的具体地址电话全部删掉，统一指回坐标卡与 12368 | `cyqfy.bjcourt.gov.cn` 2023-10-16《朝阳法院诉讼服务中心新址正式启用》只确认"已迁至新址"，公告原文不含门牌号与电话；网上流传的值只有媒体转载 | 该院官网公布新址门牌／电话，或 12368 人工确认后按坐标卡的更新触发条件升级 |

> 第三行是本轮顺手收掉的一处**两个真源各说各话**：坐标卡老老实实标了 `unverified`、
> 禁止报出具体值，而三张 SOP／模板卡各自抄了一份同样的地址电话当确定值写着。
> 这类分歧在故障时报出来的永远是好看的那个。

## 四、这一轮改了哪些机制（不只是改卡）

- **`knowledge/sources.json` + `sources/originals/`**：官方原件存档与登记簿，只能由
  `scripts/fetch-source.py` 写（手写一条等于跳过 host 闸与 sha256）。
- **`scripts/verify-quotes.py`**：把 `facts.statute_quotes` 逐条拿去和原件比，三态判定
  （一致／不一致／找不到原件），"找不到原件"同样不算过。
- **生成器扎根守卫 (b)(c)(d)(e)**：见 `README.md` §7.3。(e) 是本轮新加的——
  D 类 `无外部断言` 卡必须真的没有外部断言，否则那个档位就成了免检标签。
- **`fetch-source.py` 会解 EdgeOne 的 JS 挑战页**：`mohrss.gov.cn` 对脚本返回 987 字节的
  挑战页（HTTP 200），此前有人绕开脚本人工抓文本粘进 `text.txt`，结果
  `raw.html` 是挑战页、`text.txt` 是正文，**两者毫无对应关系而登记簿看起来完全正常**——
  尺子就此脱离了它该量的那份原件。现在脚本自己算出那两个 cookie 再取一次，
  `raw`／`text`／`sha256` 重新同源（本轮据此修好 `statute-laobufa-1994-479`，
  并补齐了 `statute-gongzi-zhifu-zanxing-guiding`）。
- **隔离区双拦**：构建期拒绝生成（CI 即红），运行时排除并 `console.error` 点名、不拒绝启动
  （排到一张不剩时仍拒绝启动）。口径与理由见 `quarantine/README.md`。
- **登记簿同源审计 `scripts/audit-sources.py`**（`README.md` §7.5）：问的是"这份原件是不是
  它自称的那份文件"——`verify-quotes` 问的是另一件事（"卡里这句话是不是原件里的话"），
  缺哪一把，另一把量出来的都可能是好看的假数。
- **`.doc` / `.xls` / `.zip` 的机械抽取器进 `fetch-source.py`，`text.txt` 全部由抽取器写**：
  收口前这两份存档里还留着"人工用 libreoffice 转出来粘进去"的正文和一句句人写的补记
  （朝阳办事材料包里 11 个 .doc 只有占位行，4.4 万字官方正文根本不在存档里）。
  现在按魔数认格式、逐成员分派，审计能对它们**复算**。配套加了 `--reextract`：
  抽取器变强之后，不下载也能用盘上的 raw 重写 `text.txt`（§7.2）——
  没有这条路，修一份过时存档的唯一办法又会变回手写 `text.txt`。

## 五、下一个人怎么接

```bash
pip install --user pyyaml olefile xlrd     # 抽取器的依赖，缺了审计判红（README.md §7.6）
python3 scripts/audit-sources.py           # 每条登记的 raw / text / 元数据是不是同一份文件
python3 scripts/gen-knowledge-index.py     # 默认 --strict，红了就照它点名的卡修
python3 scripts/verify-quotes.py           # 引文 ↔ 官方原件，三态
python3 -m pytest scripts/tests -q         # 上面三把尺子自己的判据
```

想让一张隔离卡复活：拿到 `.gov.cn` 上的**全文**原件（通稿摘要不算）→
`scripts/fetch-source.py` 登记 → 把卡从 `quarantine/` 移回 `packs/` 并删掉【隔离原因】块 →
`verify-quotes.py` 核过引文 → 重跑生成器。


## 六、心理咨询纠纷领域包（`domain: counseling`，**本轮豁免扎根守卫，最迟 2026-09-14**）

> 这 39 张卡与上面 161 张劳动卡不同：它们**暂不受扎根守卫 (b)–(h) 约束**，
> 凭 `knowledge/packs/counseling/GROUNDING_PENDING` 这一个文件豁免（豁免原因与最迟日期写在该文件里）。
> 生成器读到该文件时对这个目录只做结构校验并在 stderr 警告，不做扎根守卫；
> 删掉该文件即恢复全部守卫（判据 `scripts/tests/test_gen_guards.py` 两向钉住）。
> 本章就是这份豁免欠下的账：逐项核实之后删掉 `GROUNDING_PENDING`，这一章随之作废。


> 本领域包 39 张卡中，**7 张法条卡为官方原始 HTML 逐字核实**（精神卫生法、个保法、民法典、
> 消保法），另 1 张方法卡（method-counseling-panli-heyan，引用库内方法本体）同为 `原文核实`；
> **其余 31 张**因引用了下列未决项，整卡取最低档 `待核实`。
> 这 31 张卡**每张正文里都有 `【待核实` 标记**，可 `grep -rn 待核实 knowledge/packs/counseling/`
> 定位；每张也在下面 §H6 里逐卡登记（为什么待核实、什么解除了才能单独升档）。
> 两条都有判据盯着（counseling-pack.test.ts），漏一张即红。

### H1. 伦理守则第二版（**只能人工核对 PDF，不得机器抽取后标已核实**）

| pack id | 待核实点 | 建议核实途径 |
|---|---|---|
| ethic-lunli-3-2-baomi-liwai | 3.1/3.2/3.3/3.4 的条号与逐字文本（现为《心理学报》2018 年 50 卷 11 期期刊网页版转述） | 人工下载中国心理学会临床与咨询心理学注册工作委员会官方 PDF 逐字核对 |
| ethic-lunli-1-8-1-10-shuangchong-guanxi | 1.8/1.9/1.10 的条号与逐字文本 | 同上 |
| ethic-lunli-8-2-8-3-yuancheng-fuwu | 8.1/8.2/8.3 的条号与逐字文本 | 同上 |

**纪律**：三张卡在人工核对完成前，其条号与条文**不得写入对外文书**
（伦理申诉答辩书、投诉答复函、知情同意书正式版）；机器抽取结果不得用于升档。

### H2. 待律师书面确认（四张风险卡，卡内均写明「未经律师书面确认不得作为结论输出」）

| pack id | 待核实点 | 建议核实途径 |
|---|---|---|
| risk-qiangzhi-baogao-zhuti | 心理咨询机构是否属于侵害未成年人案件强制报告制度的法定主体（官方文件未明文列出，学理解读有分歧） | 执业律师书面意见；检察机关/地方规定检索 |
| risk-hetong-dingxing | 心理咨询服务合同定性（委托合同 vs 服务合同）及其对退费公式的影响 | 执业律师书面意见；类案检索 |
| risk-jilu-baocun-nianxian | 咨询记录保存年限（无明文，类推病历缺乏依据；与个保法最小必要冲突） | 执业律师书面意见；行业标准跟踪 |
| risk-difang-xuke-beian | 心理咨询机构的行政许可/备案要求，尤其地方性规定 | 执业律师书面意见；属地卫健委与市场监管部门书面咨询 |

### H3. 法条与官方文件原文未取得

| pack id | 待核实点 | 建议核实途径 |
|---|---|---|
| data-counseling-shixiao-qixian | 《民事诉讼法》**2023 年修正版**答辩期条文的**现行条号**（本卡逐字引用的是最高法公报 2012 修正版第一百二十五条；二手称现行为第一百二十八条） | flk.npc.gov.cn（站点已改前后端分离，旧 detail2 链接不再直出正文）/ npc.gov.cn 现行版 |
| data-counseling-shixiao-qixian | 举证期限的官方口径；协会伦理申诉的受理与答复时限；监管/消协投诉的答复期限 | court.gov.cn；中国心理学会注册系统；属地市场监管部门 |
| statute-xbf-26-55-geshi-tiaokuan-chengfa、sop-jianguan-xiehui-tousu、script-laifang-tousu-goutong | 「心理咨询师 2017 年退出国家职业资格目录」的官方公告原文 | mohrss.gov.cn 原始公告 |
| risk-difang-xuke-beian | 是否存在国家级「心理咨询机构管理办法」或专项行政许可规定（本次未穷尽检索） | nhc.gov.cn / samr.gov.cn |
| data-counseling-weiji-rexian | 机构所在城市是否另有官方公布的地方心理援助热线（**不得自行补写地方号码**）；12356 各省实际接通与坐席情况 | 属地卫生健康行政部门；gov.cn |

### H4. 判例（三则**全部**未取得裁判文书全文，结论字段统一为「不可用（仅内部参考）」）

| pack id | 待核实点 | 备注 |
|---|---|---|
| case-guge-mingyu-quan | 原始案号、审理法院、裁判年份、判决书「本院认为」段原文 | 现来源为律所官网转述，非司法机关发布 |
| case-dongni-lisongwei-weizhongshen | **是否已有生效判决**；案号与审级；协会伦理调查是否恢复及结论 | 查证时为 2024 年开庭阶段，**未终审**，不得用于预测胜败 |
| case-sichuan-tuifei-7500 | 原始案号、审理法院、判决书关于合同定性与退费计算的原文；四川高院官网原始发布页 | 现来源为新闻转发布会通稿 |
| sop-zishang-shijian-zhuize | 自伤事件后家属追责的可公开引用裁判文书（本次未查到） | 裁判文书网为动态站点，需人工检索或专业法律数据库 |

### H5. 编卡纪律与待批事项（**非事实待核实，需 manager 批**）

| 事项 | 说明 |
|---|---|
| `applies_to` 受控词表增补 | 本领域新增场景标签：`日常合规` `知情同意` `保密例外` `危机处置` `来访投诉` `退费争议` `疗效争议` `隐私泄露` `名誉侵权` `伦理申诉` `监管投诉` `诉讼与仲裁` `未成年人` `远程咨询` `转介与终止` `自伤事件` `记录留痕`（另复用劳动词表的 `证据固定`）。按 README §5「增补需报 manager」，**待批**。 |
| 热线卡的 12356 与劳动包重复收录 | README §6 单点事实源要求被 ≥2 pack 引用的数据建专卡。本领域包按设计稿 §13「知识库按领域独立成包、跨域检索默认关闭」自建 data-counseling-weiji-rexian，与 data-beijing-qiuzhu-ziyuan 各持一份 12356。**是否合并为跨域单点事实源，待 manager 裁。** |
| `status: forbidden` 的语义 | 现枚举只有 usable/forbidden，本领域用 forbidden 承载「非官方发布、本包不输出」（希望24热线），与劳动包的「已证伪/危险号码」语义不同。**是否拆分枚举，待 manager 裁。** |

### H6. 逐卡登记（31 张 `待核实` 卡，README §4.2：pack id · 待核实点 · 途径）

> 上面 H1—H5 按**未决项**分组，本表按**卡**逐张登记：卡内均有 `【待核实` 标记可 grep 定位，
> 本表回答的是另一个问题——**这张卡为什么是待核实、什么解除了才能单独升档**。
> 判据：`app/src/lib/knowledge/__tests__/counseling-pack.test.ts` 逐卡比对（漏登记即红）。

| pack id | 待核实点 | 升档条件 / 途径 |
|---|---|---|
| case-dongni-lisongwei-weizhongshen | 是否已有生效判决；案号与审级（查证时未终审） | §H4（裁判文书原件） |
| case-guge-mingyu-quan | 案号、审理法院、裁判年份、「本院认为」段原文 | §H4（裁判文书原件） |
| case-sichuan-tuifei-7500 | 案号、审理法院、合同定性与退费计算的判决原文 | §H4（裁判文书原件） |
| data-counseling-shixiao-qixian | 民诉法现行答辩期条号；举证期限/伦理申诉/监管投诉的答复期限 | §H3（官方原文） |
| data-counseling-weiji-rexian | 机构所在城市是否另有官方地方热线；12356 各省实际接通情况 | §H3（属地卫健部门） |
| ethic-lunli-1-8-1-10-shuangchong-guanxi | 条号与逐字文本为期刊网页版转述，未经官方 PDF 人工核对 | §H1（人工核对官方 PDF） |
| ethic-lunli-3-2-baomi-liwai | 条号与逐字文本为期刊网页版转述，未经官方 PDF 人工核对 | §H1（人工核对官方 PDF） |
| ethic-lunli-8-2-8-3-yuancheng-fuwu | 条号与逐字文本为期刊网页版转述，未经官方 PDF 人工核对 | §H1（人工核对官方 PDF） |
| risk-difang-xuke-beian | 行政许可/地方备案要求；「2017 年退出国家职业资格目录」待核官方公告 | §H2（执业律师书面意见）+ §H3 |
| risk-hetong-dingxing | 咨询服务合同定性（委托 vs 服务）及其退费公式后果 | §H2（执业律师书面意见） |
| risk-jilu-baocun-nianxian | 咨询记录保存年限无明文，类推病历缺依据 | §H2（执业律师书面意见） |
| risk-qiangzhi-baogao-zhuti | 强制报告制度是否涵盖心理咨询机构，官方文件未明文 | §H2（执业律师书面意见） |
| script-laifang-tousu-goutong | 「心理咨询师 2017 年退出国家职业资格目录」官方公告原文 | §H3（mohrss.gov.cn 原始公告） |
| script-weiji-tonghua-huashu | 无独立未决事实项；随所引未决项解除后复核：data-counseling-weiji-rexian、ethic-lunli-3-2-baomi-liwai、sop-zishang-shijian-zhuize | 上列各项解除后逐条复核本卡 |
| sop-jianguan-xiehui-tousu | 监管/消协投诉的答复期限；同上职业资格公告原文 | §H3（官方原文） |
| sop-liaoxiao-zhengyi | 无独立未决事实项；随所引未决项解除后复核：sop-lunli-shensu-yingdui | 上列各项解除后逐条复核本卡 |
| sop-lunli-shensu-yingdui | 协会伦理申诉的受理与答复时限；伦理守则条文本身待核 | §H1 + §H3 |
| sop-mingyu-qinquan-yingdui | 无独立未决事实项；随所引未决项解除后复核：case-dongni-lisongwei-weizhongshen、case-guge-mingyu-quan | 上列各项解除后逐条复核本卡 |
| sop-tuifei-zhengyi | 无独立未决事实项；随所引未决项解除后复核：case-sichuan-tuifei-7500、data-counseling-shixiao-qixian、risk-hetong-dingxing、script-laifang-tousu-goutong、sop-jianguan-xiehui-tousu、sop-lunli-shensu-yingdui | 上列各项解除后逐条复核本卡 |
| sop-yinsi-xielou-zhikong | 无独立未决事实项；随所引未决项解除后复核：ethic-lunli-8-2-8-3-yuancheng-fuwu、risk-jilu-baocun-nianxian、sop-jianguan-xiehui-tousu | 上列各项解除后逐条复核本卡 |
| sop-zhiqing-tongyi-quexian | 无独立未决事实项；随所引未决项解除后复核：case-sichuan-tuifei-7500、ethic-lunli-3-2-baomi-liwai | 上列各项解除后逐条复核本卡 |
| sop-zishang-shijian-zhuize | 自伤事件后家属追责的可公开引用裁判文书（本次未查到） | §H4（裁判文书检索） |
| template-baomi-gaozhi-liwai | 无独立未决事实项；随所引未决项解除后复核：ethic-lunli-3-2-baomi-liwai | 上列各项解除后逐条复核本卡 |
| template-lunli-shensu-dabianshu | 无独立未决事实项；随所引未决项解除后复核：case-dongni-lisongwei-weizhongshen、ethic-lunli-1-8-1-10-shuangchong-guanxi、ethic-lunli-3-2-baomi-liwai、sop-lunli-shensu-yingdui | 上列各项解除后逐条复核本卡 |
| template-lvshihan-yingdui-yaodian | 无独立未决事实项；随所引未决项解除后复核：case-guge-mingyu-quan | 上列各项解除后逐条复核本卡 |
| template-tingzhi-fuwu-tongzhi | 无独立未决事实项；随所引未决项解除后复核：ethic-lunli-1-8-1-10-shuangchong-guanxi、sop-zishang-shijian-zhuize | 上列各项解除后逐条复核本卡 |
| template-tousu-dafu-han | 无独立未决事实项；随所引未决项解除后复核：sop-jianguan-xiehui-tousu | 上列各项解除后逐条复核本卡 |
| template-tuifei-xieyi | 无独立未决事实项；随所引未决项解除后复核：risk-hetong-dingxing | 上列各项解除后逐条复核本卡 |
| template-weiji-chuzhi-jilu | 无独立未决事实项；随所引未决项解除后复核：data-counseling-weiji-rexian | 上列各项解除后逐条复核本卡 |
| template-zhiqing-tongyishu | 无独立未决事实项；随所引未决项解除后复核：ethic-lunli-3-2-baomi-liwai | 上列各项解除后逐条复核本卡 |
| template-zhuanjie-han | 无独立未决事实项；随所引未决项解除后复核：script-laifang-tousu-goutong | 上列各项解除后逐条复核本卡 |