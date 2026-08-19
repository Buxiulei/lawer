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
| data-beijing-shepin-fengding | 2024、2025 年度法人单位从业人员平均工资及 3 倍封顶值（2024 网传 198,804 无信源禁用；WS5 已确认 2024 值尚未发布） | 北京市统计局年鉴与公报页，每年 6 月中下旬 |
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
