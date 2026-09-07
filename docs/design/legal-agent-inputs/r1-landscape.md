# R1：法律智能体外部现状与失败证据（调研员R1）

## 一、法律LLM幻觉实证与业界应对

Stanford RegLab《Hallucination-Free?》(2024-05预印本，2025发表于JELS)：**Lexis+ AI幻觉率17%，Westlaw AI-Assisted Research 33%，GPT-4(无检索)43%**[1][2][3]。错误含捏造案例及"真案例但曲解要旨"的隐蔽型；首个预注册实证评估，证实厂商"消除幻觉"宣传夸大[1][3]。Ask Practical Law AI幻觉少但拒答率极高(数值待核实)[9]。
同团队《Large Legal Fictions》(Dahl et al., JLA 2024)：通用模型80万+问题测试，**GPT-4幻觉58%、GPT-3.5 69%、Llama2 88%**；回答判例"裁判要旨"错误率≥75%；模型会强化用户输入中的错误前提[4][5]。
业界两条应对主线：①**检索接地(RAG)**锚定真实文书；②**拒答/弃权**——综述指出过度弃权牺牲可用性，权衡尚无定论[6][7]。可核验引用是唯一广泛认可的缓解手段。

## 二、法律推理评测集

**LegalBench**(162任务/40机构)：偏英美合同/民事程序，不覆盖长文档、不做判例类推、不支持非英语，多步推理被拆成不连贯子任务[10][11][12]。
**LawBench**：中文，记忆/理解/应用三层20任务，测51模型，GPT-4最好但仍有限[13][14]。
**LexEval**(NeurIPS 2024)：最大中文法律基准，23任务/约1.4万题，六维分类(记忆/理解/逻辑推理/辨别/生成/伦理)[13][15]。
**DISC-Law-Eval**(复旦DISC)：客观题(仿司考按难度分级算准确率)+主观题(法律咨询/判决预测，GPT-3.5-turbo当裁判打分，300条样本)[16][17]。
共性短板：都强于"知识记忆"，弱于**长文档理解、类案类推、多步推理、主观判断**——恰是真实法律咨询最依赖的能力[10][13]。

## 三、中文法律大模型架构取向

**ChatLaw**：Ziya-LLaMA-13B+LoRA微调，"自研角色"缓解幻觉；关键词辅助BERT向量+Faiss混合检索[18]。
**DISC-LawLLM**(2023-09)：微调(30万条SFT)+检索增强(top-K文档拼prompt)[16][19]。
**通义法睿**(通义千问基座)：1.6亿裁判文书+全量法规预训练、注入法律思维链；"Agentic+Iterative Planning"架构；融合RAG接权威知识库，**官方称用RAG解决幻觉**[20]。
**法信**(最高法批准，2012立项)：类案检索/智能问答；2024-11发布"法信法律基座大模型"，定位司法系统官方基础设施，非C端产品[21]。
**北大法宝AI**：法规433万+/案例1.46亿+检索库为资产，"多模型+智能路由"，产品化为智能问答/模拟法庭/角色化助手[22]。
两条路：①**数据/检索资产驱动型**(法信、法宝依托体制内独家文书库)；②**基座微调+RAG混合型**(ChatLaw/DISC-LawLLM学术路线，通义法睿商业路线)。无产品宣称仅靠参数记忆，RAG已是行业默认话术。

## 四、监管与合规边界

最高法《关于规范和加强人工智能司法应用的意见》法发〔2022〕33号(2022-12-09)：五原则——安全合法/公平公正/**辅助审判**/透明可信/公序良俗，核心是AI辅助而非替代裁判[23][24]。
《生成式人工智能服务管理暂行办法》(七部门，2023-07-13发布/08-15施行)：第2条适用"向境内公众提供生成内容服务"；第4条要求透明度/内容可靠+反歧视；第7条训练数据合法不侵权；第14条违法内容须停止生成传输并报告；**第17条具舆论属性或社会动员能力的服务需安全评估+算法备案**(是否适用本产品待核实)[25][26]。
《人工智能生成合成内容标识办法》+GB 45438-2025(2025-09-01施行)：AI生成内容须加显式角标+隐式元数据标识，不得删改隐匿[27]；是否覆盖"一对一咨询问答"待核实。
《律师法》第十三条：**"没有取得律师执业证书的人员，不得以律师名义从事法律服务业务；除法律另有规定外，不得从事诉讼代理或者辩护业务"**[28][29]，违者责令停止非法执业、没收违法所得、处1-5倍罚款[29]。红线：不能以律师名义、不能做诉讼代理/辩护本身。
基层法律服务所/法律咨询公司边界(司法部、新京报等)：合法范围是法律咨询、代拟审查文书等**非诉讼类服务**；查处高发形态——冒充律所、承诺"包打赢"、与律师"暗箱合作"变相代理诉讼、违规收费不开票、假冒律师身份代理诉讼[30][31][32]。**对应本产品"网页展示状态/分析在用户agent里/仲裁阶段分流律师"定位的合规必要性**——绝不能变相有偿代理诉讼或承诺胜诉。

## 五、国外agentic legal产品设计原则

**Harvey**：官方博客提三原则——Design With Domain Awareness、Make the Complex Feel Effortless、Design With Intention[33]。技术层描述(RAG+法律精调、结构化引用核验、类"Shepardize"核验good law、Vault工作区隔离+SOC2/ISO27001、内部幻觉率约0.2%)均为第三方转述，**非官方白皮书**，待核实[34][35]。
**CoCounsel**(原Casetext，现属Thomson Reuters)：第三方称上线前"Trust Team"测试近4000小时/3万+问题；直接接Westlaw/Practical Law/Checkpoint官方库做grounding[36]，同为二手信源待核实。
**Spellbook**：定位窄——仅嵌入Word做合同起草/审查/条款对比，不做通用法律问答[36]。
共同取向(**信源多二手，待核实**)：①检索接地取代纯参数生成；②引用须可回溯真实文件；③法律专家全程参与评测迭代；④窄场景优先于通用助手；⑤企业级数据隔离/安全认证是采购门槛。

---

## 来源清单

[1] https://reglab.stanford.edu/publications/hallucination-free-assessing-the-reliability-of-leading-ai-legal-research-tools/
[2] https://arxiv.org/pdf/2405.20362
[3] https://onlinelibrary.wiley.com/doi/full/10.1111/jels.12413
[4] https://academic.oup.com/jla/article/16/1/64/7699227
[5] https://dho.stanford.edu/wp-content/uploads/Hallucinations_JLA.pdf
[6] https://direct.mit.edu/tacl/article/doi/10.1162/tacl_a_00754/131566/Know-Your-Limits-A-Survey-of-Abstention-in-Large
[7] https://arxiv.org/html/2407.18418v1
[9] https://www.lawnext.com/2024/05/stanford-will-augment-its-study-finding-that-ai-legal-research-tools-hallucinate-in-17-of-queries-as-some-raise-questions-about-the-results.html
[10] https://github.com/HazyResearch/legalbench/
[11] https://arxiv.org/pdf/2308.11462
[12] https://www.ryanmcdonough.co.uk/legalbench-testing-the-limits-of-llms-in-legal-reasoning/
[13] https://arxiv.org/html/2409.20288v2
[14] https://github.com/open-compass/LawBench
[15] https://proceedings.neurips.cc/paper_files/paper/2024/file/2cb40fc022ca7bdc1a9a78b793661284-Paper-Datasets_and_Benchmarks_Track.pdf
[16] https://arxiv.org/pdf/2309.11325
[17] https://cloud.tencent.com/developer/article/2334839
[18] https://zhuanlan.zhihu.com/p/643673344
[19] https://github.com/FudanDISC/DISC-LawLLM
[20] https://tongyi.aliyun.com/farui
[21] https://www.court.gov.cn/zixun/xiangqing/447711.html
[22] https://baike.baidu.com/item/%E5%8C%97%E5%A4%A7%E6%B3%95%E5%AE%9D/7435492
[23] http://fzzfyjy.cupl.edu.cn/info/1080/15639.htm
[24] https://ipc.court.gov.cn/zh-cn/news/view-2131.html
[25] https://www.cac.gov.cn/2023-07/13/c_1690898327029107.htm
[26] https://www.cac.gov.cn/2023-07/13/c_1690898326795531.htm
[27] https://www.cac.gov.cn/2025-03/14/c_1743654685899683.htm
[28] http://www.npc.gov.cn/zgrdw/npc/xinwen/2017-09/12/content_2028697.htm （原文抓取因SSL握手失败未直接核验，条文文本经二次检索交叉确认，见[29]）
[29] 交叉确认页面：https://sf.sz.gov.cn/ztzl/lszysq/zcfg_145189/content/post_2953135.html ；https://www.12371.cn/2020/06/11/ARTI1591829325020697.shtml
[30] https://www.thepaper.cn/newsDetail_forward_25285949
[31] https://www.moj.gov.cn/pub/sfbgw/fzgz/fzgzggflfwx/fzgzggflfw/202404/t20240424_497874.html
[32] https://www.bjnews.com.cn/detail/1721896879168370.html
[33] https://www.harvey.ai/blog/how-we-approach-design-at-harvey
[34] https://medium.com/@takafumi.endo/how-harvey-built-trust-in-legal-ai-a-case-study-for-builders-786cc23c3b6d
[35] https://www.zenml.io/llmops-database/building-and-evaluating-legal-ai-at-scale-with-domain-expert-integration
[36] https://lawyerist.com/reviews/artificial-intelligence-in-law-firms/cocounsel-review-artificial-intelligence-for-lawyers/

## 待核实清单（unverified）
- Ask Practical Law AI的具体拒答率数值（只确认"拒答率高、幻觉少"定性描述）。
- Harvey"幻觉率约0.2%"、CoCounsel"近4000小时/3万+问题测试"均为第三方转述，未见官方一手数据披露。
- 《生成式人工智能服务管理暂行办法》第17条门槛是否覆盖一对一法律咨询AI问答，未找到官方对该场景的明确解释。
- 《人工智能生成合成内容标识办法》是否适用于站内"问它"一对一问答（而非面向公众内容传播），未找到官方专门解释。
- 律师法第十三条原文因npc.gov.cn官网SSL握手失败无法直接抓取核验，现引用文本来自多个转载页交叉确认一致，未直接核对国务院公报影印件原文。
- DISC-Law-Eval"伦理/复杂推理维度弱于选择题记忆维度"仅确认评测方法设计，未拿到分项得分表格原始数据。
