# 待核实清单（WS5 调研员对接）

> 格式：pack id · 待核实点 · 建议核实途径。核实后更新对应 pack 并将其 confidence 升级。
> 清扫纪录：2026-08-19 两轮全库清扫共解除 31 处（依据三张单点事实源卡），余下为真实外部待核实项。
> 卡内均有精确【待核实】标记，可 `grep -rn 待核实 knowledge/packs/` 定位原文。

## E. A09/A04 批次新增（2026-08-19 第二轮清扫后余项，分组摘要）

| 组 | 摘要 | 涉及 pack | 建议途径 |
|---|---|---|---|
| E1 电话/窗口/现场路径 | 朝阳法院与三中院电话及接待时间（二手）、朝阳仲裁发号与网上立案补交原件细节、邮寄申请可否、终局金额分项还是合计、监察窗口直线号、撤销期内能否径行执行 | sop-yishen-ersheng-sop、sop-chaoyang-lian-sop、sop-jiancha-vs-zhongcai、sop-zhixing-sop | 12368 / 010-87983310 / 12351 电话确认（可并入 OPS 人工核验清单） |
| E2 法条未回官方原始页 | 民诉法、诉讼费用交纳办法（国务院令481号）、企业破产法§113、仲裁办案规则（人社部令33号）§20/50/53/54、北京失业保险金申领办法、执行变更追加规定条款号、民诉证据规定若干规则条号 | 上述 sop/templates 各卡 + scripts-kaiting-huashu | flk.npc.gov.cn / gov.cn / mohrss.gov.cn；可在 A01/A02 法条批次顺手建卡解决 |
| E3 北京无明文口径 | 二审是否仍收10元、调解书能否写违约金、到期终止补偿的个税免征适用、监察范围是否涵盖2N、年假报酬时效起算、工会程序瑕疵补正 | sop-tiaojie-sop、sop-jiancha-vs-zhongcai、sop-zhongcai-guanxia-shixiao、scripts-zhizheng-yaodian 等 | 裁判文书检索 / 法院交费通知 / 北京税务 12366 |
| E4 经办条件 | 非京籍灵活就业参保、医保断缴恢复时点、失业登记经办口径与失业补助金政策、临时救助条件 | sop-zhongcai-qijian-zijiu | rsj/医保局/民政局办事指南、12333 |
| E5 案例线索 | 放弃仲裁诉权条款2024案例出处、个税免征当年数额、八民会纪要"第47条"条号、年终奖在职口径、HR谈话录音采纳判例 | template-xieshang-jiechu-shencha-qingdan、case-mowei-taotai-shangwei-guize-2016、case-nianzhongjiang-beijing-koujing、case-zhengju-caixin-guize-huibian | 最高法官方发布稿 / 三中院白皮书 / 判例检索 |

编卡纪律追加（第二轮清扫教训）：①"某条未收录进源卡"的注记**不要写死在 pack 正文**——源卡扩充后即成陈旧信息，统一在源卡侧维护收录清单；②"逐月/按月起算"表述已全库绝迹，新卡禁用（正确表述：自主张权利之日起向前一年按日倒算，534§41）。law_refs 为可选字段（规范 §2），纯数值/资源 data 卡豁免。

## A. 年度数值 / 官方发布类

| pack id | 待核实点 | 建议途径 |
|---|---|---|
| data-beijing-shepin-fengding | ~~3 倍封顶值 47,103.25 与月均 15,701.08~~ **已确认（2026-09-02）**：值取自《北京统计年鉴 2024》表 3-14 合计行 188,413 元/年官方原件；主理人 2026-09-02 致电 12333，答复经济补偿封顶仍按 2023 年度数计算，两条值已升 `原文核实`。**观察项（不列待办、不按年自动续更）**：2024、2025 年度法人单位从业人员平均工资官方未见发布（年鉴 2025 目录已无该总量表；网传 198,804 无信源禁用），仅在人社局发新年度通告或 12333 口径变化时复核。另：个税免征上限 565,239 的税务口径仍待核实，见下 A 表新增行 | 复核触发式：12333 / 市统计局 010-55529938 |
| data-beijing-shepin-fengding（个税分项） | 补偿金个税免征上限 565,239 元是否同用法人单位口径、当年适用数额（不在 2026-09-02 12333 人社口径答复范围内） | 北京税务 12366 / chinatax.gov.cn；与 sop-yaoqiu-qianzi-wenjian 联动 |
| data-beijing-shebao-jishu | 2025 年度社保缴费基数上下限通告正式文号 | rsj.beijing.gov.cn 通知公告 |
| data-beijing-shiye-baoxianjin | 2025-09-01 失业金档次调整发布文号；2026 年 7—8 月是否发新标准 | rsj.beijing.gov.cn |
| data-beijing-qiuzhu-ziyuan | 回龙观热线 7×24 人工接听属实性 | 人工电话核验（已列 OPS 清单） |

## B. 外部法规原文未取得（多数可在 A01/A02 法条批次单建法条卡解决）

| pack id | 待核实点 | 建议途径 |
|---|---|---|
| calc-bingjia-gongzi | 劳部发〔1994〕479号医疗期档次对照表 | mohrss.gov.cn / flk.npc.gov.cn |
| calc-nianjia-300 | 年休假条例与实施办法官方原始页（分档/累计/折算已获 534§62 印证；未印证：实施办法§11 的 21.75 分母、§13 约定优先） | flk.npc.gov.cn |
| calc-shiye-baoxianjin | 《失业保险条例》条文官方源（现为转录） | flk.npc.gov.cn |
| calc-buchangjin-geshui | 财税〔2018〕164号§5(1)原文及延续公告；个税税率表逐字核对 | chinatax.gov.cn / flk.npc.gov.cn |
| calc-tuoqian-jiafu-peichang | 《劳动法》第 91 条原文 | flk.npc.gov.cn |
| calc-jiabanfei | 《北京市工资支付规定》第 44 条原文（原料只到 43 条，补录进 statute-beijing-gongzi-zhifu-guiding） | beijing.gov.cn 规章 PDF |
| sop-daoqi-buxuqian | 《北京市劳动合同规定》第 47 条原文（页面撤稿）；实施条例第 11 条原文 | 备案库 / flk.npc.gov.cn |
| sop-zhengren-yu-zhengju-qingdan、script-goutong-huashu-ku | 《民诉证据规定》证人出庭/保证书/书面证言条文序号及 §94(1) 表述 | court.gov.cn |

## C. 北京无明文的裁审口径（需检索裁判文书或问 12333）

| pack id | 待核实点 |
|---|---|
| calc-weiqian-hetong-shuangbei | "不满一个月"折算分母（21.75 还是当月计薪天数） |
| calc-daitongzhijin-n1 | 通知不足 30 日按天折抵？上月奖金/提成计入？最低工资保底适用？解除当月不足月取哪个"上一个月"？ |
| calc-daigang-gongzi | "一个工资支付周期"起算点；生活费 1,778 元是代扣前还是到手口径 |
| calc-jiabanfei | 是否有文件明示第 43 条 20.92 已不适用；年终奖是否一律排除出加班费基数 |
| calc-nianjia-300 | 年假报酬时效起算出处；基数是否含年终奖分摊；"福利年假"能否按 300%；最低工资保底依据 |
| calc-bingjia-gongzi | 三方均未约定病假工资标准时按法定下限还是正常工资 |
| calc-tuoqian-jiafu-peichang | 50%—100% 裁量标准，北京有无执法指引 |
| calc-buchangjin-geshui | 2N 是否同样适用"3 倍免税" |

## D. 案例来源与经办路径

| pack id | 待核实点 | 备注 |
|---|---|---|
| template-xieshang-jiechu-shencha-qingdan | 第 5/10/15 项援引的北京典型案例无公开案号；第 18 项个税免征当年数额 | 第 10 项极可能是 sop-weixie-beidiao-lizhengming 已带官方 URL 的章某案（2023 十大案例 9），可优先比对 |
| sop-yaoqiu-qianzi-wenjian | 个税免征口径与当年数额 | 与 data-beijing-shepin-fengding 联动 |
| sop-daigang-tinggong | 涉疫情十大典型案例·孙某待岗案裁决结果 | rsj.beijing.gov.cn 典型案例页 |
| sop-shebao-tingjiao-jiangji、sop-gongzi-shebao-geshui-beijing | 社保平台/京通/个税 APP 菜单层级与打印路径 | 实名登录逐屏核 |
| sop-dianzi-shuju-guzheng | 北京公证处电子数据保全收费与时长 | 各公证处官网/电话 |

## F. 竞业指引观察项（2026-08-19，calc-jingye-buchang-weiyuejin 卡内已标推导性质，非未核实事实）

| 观察项 | 现状 | 触发动作 |
|---|---|---|
| 人社厅发〔2025〕40号 §13"超1年不宜低于50%"的北京采纳率 | 无公开判例（agent 纪律：报数按30%，50%仅谈判目标） | 出现按50%判付的北京判例即升级 |
| §14"5倍线"与司法违约金调整的衔接 | 法院仍走民法典合同编通则解释§65，未见援引指引 | 同上 |
| "补偿总额"分母在未约定补偿时的口径 | 卡按应付总额 M×T 推导（卡内已标注） | 官方明确后替换 |

## G. 维护组（低优先例行）

| 事项 | 说明 | 途径 |
|---|---|---|
| sop-jianyi-zhuxiao-yiyi | ①条例§33 与公司法司解二§19/20 逐字与官方原始页比对（现为维基文库转录）；②gsxt 简易注销异议线上入口逐屏核对（需实名登录）；③2023 公司法清算义务人条款与老司解衔接口径 | gov.cn / court.gov.cn / gsxt 实名登录实测 |
| statute-qijian-jisuan-tongze | 民诉法§85 逐字与 flk 原始页比对（现为三源互证：维基文库+WS2引述+534§12），比对后升 原文核实 | flk.npc.gov.cn |
| 年度法定节假日安排 data 卡 | 国办发文逐年更新，供 deadline 期限顺延精确化（manager 2026-08-19 排维护组） | gov.cn 国办每年 11-12 月发文 |

## H. 心理咨询纠纷领域包（P4-W2 新增，2026-09-06；`domain: counseling`）

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

## 已核实归档

| 日期 | 事项 | 结果 |
|---|---|---|
| 2026-08-19 | 加班费是否计入经济补偿基数 | 534§55(4) 逐字：计入；年终奖按 12 个月分摊 |
| 2026-08-19 | 534 号原文直链与逐字核对 | 双官方源+本地 PDF；已收录 §4/6/38/41/50/53/54/55(全)/56/57/59-62/66-73/75/76/78-81/83/84 |
| 2026-08-19 | 2008 分段北京口径 | 534§66：基数与 2N 均不再分段；481 号已废止（人社部发〔2017〕87 号） |
| 2026-08-19 | 病假月是否剔除 12 个月平均 | 无明文；通行不剔除，低于最低工资兜底（(2021)京民申7816号） |
| 2026-08-19 | 2019"法人单位口径"通告原始页 | rsj 原始页验活，已入 data 卡 |
| 2026-08-19 | 2026 年最低工资 | 查无调整，2,540 元/月现行（京人社劳发〔2025〕7 号） |
| 2026-08-19 | 代通知金封顶与上月异常 | 唯一硬法源实施条例§20；534 号零命中；无封顶依据；2N 后不另付 +1（(2023)京03民终14407号） |
| 2026-08-19 | 司法解释二 §6-11 转录准确性 | 对照官方 PDF 逐字一致（本地副本 research/raw/法释2025-12号-司法解释二-官方PDF.pdf） |
| 2026-09-02 | 三倍封顶基数 47,103.25 元/月的原始出处与续用状态 | 《北京统计年鉴 2024》表 3-14 合计行 188,413 元/年（nj.tjj.beijing.gov.cn 原始表格文件）；主理人 2026-09-02 致电 12333，答复仍按 2023 年度数计算封顶 → data 卡 fengding_jishu_monthly / faren_avg_monthly 升 原文核实 |
