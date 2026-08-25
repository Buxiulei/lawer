# 「口语↔法言法语」别名词表 · 规模估计与抽取方法（v1，WS2 出方法与规模，词表内容归 WS4）

> manager 定性：**「如果我们的系统要求用户说对词才能找到法条，那它只服务于已经懂法的人——那我们就背叛了立项的初衷。」**
> 本文只做**规模与方法**，不做词表定稿。所有数字都可由 `scratchpad/probe-alias-gap.ts` 复算。

## 1. 规模（实测，非估算）

| 量 | 值 | 出处 |
|---|---|---|
| 归档转录里的用户轮 | 291（两个结果目录、180 份 JSON） | `probe-reach.ts` |
| **其中不同 query** | **18 条** | 同上——副本不是样本，词表只能从这 18 条抽 |
| 人工指派的「本轮应命中卡」(query,卡) 对 | 46 | `probe-alias-gap.ts` |
| 现行检索够到的 | **16 / 46（35%）** | 同上 |
| **缺口（需要别名才能接上的）** | **30 对** | 同上 |
| 涉及的不同目标卡 | 38 张；**23 张一次都没被够到** | 同上 |
| 全库可达性 | 18 条口语只够得着 **75/217 张（34.6%）**；而转录里真实注入过 154 张 | `probe-reach.ts` |

**最有说服力的一条对照**：同一个知识库，**用户原话只够得着 75 张，模型自己写的检索词够到 154 张**。
差的那 79 张不是库里没有，是**要会说法言法语才拿得到**——manager 那句定性有了数字。

**产出率（用于外推，不要直接乘轮数）**：30 个缺口对 / 18 条不同 query ≈ **1.7 个缺口/条**；
每个缺口对通常需要 1–2 条别名（同一句口语可指向多张卡，同一张卡也可能要收多种说法），
故 **本批 18 条口语的词表规模 ≈ 30–60 条**。上线后按同法滚动，天花板取决于**不同用户说法**的增长，
不取决于对话轮数。

## 2. 抽取方法（六步，可复用；机械/判断分界写死）

| 步 | 做什么 | 机械还是判断 | 工具 |
|---|---|---|---|
| 1 | 取样面：从真实对话里挑「零实质命中」或「有命中但不对口」的轮 | **机械** | `probe-bridge.ts` / `probe-alias-gap.ts` |
| 2 | 指派「本轮应命中的卡」（1–4 张） | **判断**（人或 LLM，必须留痕：谁指派的、依据哪句话） | 本文件 §4 表 |
| 3 | 差集：应命中 − 实际前 6 = 需要别名的 (query,卡) 对 | **机械** | `probe-alias-gap.ts` |
| 4 | 词条成形：从 query 原话里摘出**用户实际说的那个短语**，挂到目标卡 | **判断** | §3 模板 |
| 5 | **反向测试（合入门槛）**：把别名并进 keywords 后全语料重跑，**不得**把无关轮拉进命中 | **机械** | `probe-context-ab2.ts` 同款 A/B |
| 6 | 上线后滚动：新对话按 1–5 循环；**灭灯条件**＝该别名连续 N 批不再产生新命中即降权复审（A2） | 机械+判断 | — |

**为什么第 5 步是门槛而不是建议**：本轮实测过一次教训——把匹配放宽成 2-gram 重叠，
名义上"救回 112/112 轮"，逐例读完全部是伪命中（keyword「12356」被「**35**岁」命中）。
**别名同样会制造这种伪命中，唯一的防线是加进去之后重跑一遍。**

**落点选择（重要）**：别名进**数据面**（卡 frontmatter 增 `aliases:` → `gen-knowledge-index.py`
并进 index.json 的 keywords），**不改 `matches()` 与打分**。理由：打分是全局面，
一个常量改动波及全部 217 张卡；别名是逐卡面，错了只影响那一张，且可单条回滚。

## 3. 词条模板（每条必备六栏）

```yaml
- alias: 一分钱没给              # 用户实际说的话，逐字，不做书面化
  register: 口语·结果描述         # 口语/俚语/情绪表述/程序术语误称 四型之一
  canonical: 用人单位逾期不履行生效裁决   # 对应的法言法语
  targets: [sop-zhixing-sop]     # 该说法应命中的卡
  evidence:                      # 来源必须能回到转录，杜绝拍脑袋造词
    scenario: S12, turn: 1, occurrences: 4
    quote: "裁决下来20天了公司一分钱没给"
  negatives:                     # 反例：加了它之后**不得**命中谁，以及为什么
    - {card: calc-tuoqian-jiafu-peichang, why: 加付赔偿金是裁决**之前**的行政程序（须先经劳动监察责令），与执行阶段不是一回事}
    - {card: sop-tuoqian-kekou-gongzi, why: 欠薪 SOP 解的是"还没打官司"的阶段}
  gate: 并入后全语料重跑，S07（真欠薪轮）前 6 不得变化
```

## 4. 完整样例（两类，manager 点名要全的）

### 4.1 S12 型 —— 「程序阶段被口语化」（用户不知道自己已经进入执行阶段）

原话：**「赢了又怎么样？裁决下来20天了公司一分钱没给，电话也不接。是不是就是废纸一张？我这大半年白折腾了？」**
现状：前 6 = 保密协议/公司注销/简易注销/证据目录/起诉状/谈判心理，**`sop-zhixing-sop` 一次没进**。

| alias | register | canonical | targets | negatives（合入门槛） |
|---|---|---|---|---|
| 一分钱没给 | 口语·结果描述 | 逾期不履行生效裁决 | sop-zhixing-sop | ✗calc-tuoqian-jiafu-peichang（裁决前的行政程序）✗sop-tuoqian-kekou-gongzi（未进入诉裁阶段） |
| 电话也不接 | 口语·对方行为 | 拒不履行 / 需查财产线索、申请限高失信 | sop-zhixing-sop | ✗sop-koutou-jiechu-yingdui（那是解除阶段的"口头"） |
| 废纸一张 | 口语·对裁决书的误解 | 生效法律文书的强制执行力 | sop-zhixing-sop, sop-caijue-yicaizhongju | ✗template-minshi-qisuzhuang（他不是要起诉，是要执行；给错会让他多走一年） |
| 裁决下来 N 天 | 口语·时间描述 | 履行期届满 / 两年申请执行期限起算 | sop-zhixing-sop, statute-qijian-jisuan-tongze | 数字部分不入词表（别名只收词面，不收变量） |
| 白折腾了 | 情绪·徒劳感 | —（无法律对应） | emotion-bengkui-jiedian-jijiu | **不与程序卡互替**：情绪面与程序面并列，两张都该给 |

> 这一条最能说明代价：**用户已经赢了**，只差"申请强制执行"这一步，而系统因为他不会说
> 「强制执行」四个字，给了他保密协议和公司注销。**赢了的案子烂在最后一公里。**

### 4.2 S03 型 —— 「金额术语被口语化」（用户说 N，库里写"经济补偿"）

原话：**「HR 给我协议让我今天下班前签……最多只能给N，走仲裁也就这么多还费时间……我好怕一分都拿不到。」**
现状：前 6 全是话术/SOP/判例，`statute-lhtf-jiechu-buchang-core`、`calc-jingji-buchang-n`、
《协商解除协议》两张审查卡**全部缺席**；且该轮候选池里**带 statute_quotes 的卡是 0 张**（不是被挤出，是没进池）。

| alias | register | canonical | targets | negatives |
|---|---|---|---|---|
| 最多只能给N | 口语·金额术语 | 经济补偿（第46/47条标准） | statute-lhtf-jiechu-buchang-core, calc-jingji-buchang-n | ✗calc-daitongzhijin-n1（N+1 是第40条三情形的代通知金，协商解除给的是 N；混了用户会以为多拿一个月） |
| 一分都拿不到 | 口语·风险描述 | 补偿归零风险（"个人原因"离职陷阱、一揽子放弃条款） | review-xieshang-jiechu-xieyi, template-xieshang-jiechu-shencha-qingdan | ✗sop-tuoqian-kekou-gongzi（不是欠薪） |
| 给我协议让我签 / 催我签 | 口语·动作 | 《协商解除协议》签署前审查 | review-xieshang-jiechu-xieyi, sop-yaoqiu-qianzi-wenjian | ✗review-laodong-hetong（入职合同，不是解除协议） |
| 走仲裁也就这么多 | 口语·被贬低的救济 | 仲裁请求事项与可主张项 | template-qingqiu-shixiang-ku | — |
| **今天不签明天名额就没了** | 口语·期限压力 | 人为截止日期话术 | script-hr-huashu-chaijie | **已覆盖对照**：这条整句已是 keyword，现行就能命中——说明"整句入 keyword"有效但不可持续，别名表要的是**短语级**收敛 |

> 术语学补注（任务一实测）：`statute-lhtf-jiechu-buchang-core` 已有 keyword「N」，
> 但 `MIN_KEYWORD_LEN = 2` 把长度 1 的词剔出打分，所以「最多只能给N」命不中；
> 而 S15#1 说「判了2N」就**命中了**（「2N」长度 2）。**一个字符的差别决定用户拿不拿得到法条原文。**
> 修法走别名（「最多只能给N」「只给N」「就给个N」都是长度≥2 的短语），**不动 MIN_KEYWORD_LEN**——
> 改常量是全局面，且当前全库只有一个长度 1 的 keyword 这件事是**今天的数据事实，不是结构保证**。

## 5. 18 条 query 的缺口全表（第 3 步机械产出，供 WS4 逐条成形）

| query | 应命中 | 够到 | 缺 |
|---|---|---|---|
| S01#1 | 3 | 2 | script-goutong-huashu-ku |
| S02#1 | 3 | 1 | sop-koutou-jiechu-yingdui、statute-lhtf-jiechu-buchang-core |
| S02#2 | 3 | 0 | sop-dianzi-shuju-guzheng、sop-gongzi-shebao-geshui-beijing、template-zhengju-cailiao-qingdan |
| S03#1 | 4 | 0 | review-xieshang-jiechu-xieyi、template-xieshang-jiechu-shencha-qingdan、statute-lhtf-jiechu-buchang-core、calc-jingji-buchang-n |
| S04#1 | 3 | 1 | sop-sanqi-nvzhigong、template-jujue-tiaogang-huifuhan |
| S05#1 | 3 | 2 | statute-lhtf-38-beipo-jiechu |
| S06#1 | 2 | 2 | — |
| S07#1 | 3 | 1 | sop-tuoqian-kekou-gongzi、template-beipo-jiechu-tongzhishu |
| S08#1 | 1 | 0 | emotion-caiyuan-xinli-jieduan |
| S08#2 | 1 | 0 | data-beijing-qiuzhu-ziyuan（**危机确定性通路已兜底，不靠检索**） |
| S09#1 | 3 | 1 | script-hongxian-qingdan、emotion-bengkui-jiedian-jijiu |
| S10#1 | 3 | 1 | template-zhongcai-shenqingshu、template-zhengju-cailiao-qingdan |
| S11#1 | 3 | 1 | emotion-kaiting-xinli-jianshe、sop-kaiting-liucheng-sop |
| S12#1 | 2 | 0 | sop-zhixing-sop、sop-caijue-yicaizhongju |
| S13#1 | 2 | 2 | — |
| S14#1 | 3 | 0 | calc-jingji-buchang-n、data-beijing-shepin-fengding、statute-lhtf-jiechu-buchang-core |
| S15#1 | 2 | 1 | method-panli-heyan-sibufa |
| S15#2 | 2 | 1 | statute-lhtf-jiechu-buchang-core |

## 6. 已知边界（不许被当成结论用）

1. **18 条 query 是全部样本**，且全部出自评测剧本——它们是**我们写的**口语，不是真实用户的口语。
   真实用户的说法分布只能上线后采。本版规模是**下界**。
2. §4 的「应命中卡」是 **ws2-agent 的人工指派**，不是数据：换个人指派，46 这个分母会变。
   复算时请连指派表一起复算。
3. 情绪型（S08#1）与程序型（S12#1）的缺口**性质不同**：前者哪怕接上词面，给的也只是陪伴话术；
   后者接上就是用户少走一年冤枉路。**别名表的收益不均匀，排序应按"接不上会怎样"而不是按条数。**
