/**
 * 检索评测集（评测官，2026-08-29；manager P0）。
 *
 * **它是后台技术「词级双向包含」改造的前置验收器——修法不许先于尺子存在。**
 *
 * 【已知答案怎么标的：不从索引反推】
 * 若拿"这张卡的 keyword 像不像"去标注，等于**用被测系统的口径给它出考卷**（同源互证盲的考卷版）。
 * 本集的 `expect` 一律从**用户的信息需求** + **剧本 `must` 条目**推出，再与卡的用途交叉，
 * **从不看该卡的 keyword 是否匹配**。
 *
 * 【孪生对照臂是这把尺的主梁，不是补充】
 *   两侧都中           → 库有卡、匹配也行
 *   答案侧中 / 问题侧不中 → **匹配缺陷**（这才是 ② 要修的）
 *   两侧都不中         → **覆盖缺口**，改 matches() 也救不了
 * 没有这一臂，一个 0 分不出「库里没这张卡」与「有卡但用户的话捞不到」——**两者处置完全相反**。
 *
 * 【2026-08-29 基线后校准，显式披露】首跑基线**先量出的是这把尺自己的三处缺陷**，已按预设读法修：
 *   · `sentinel-1` 原句含「北京」⇒ 逐字命中带「北京」keyword 的卡、实质命中 2 ⇒ 去掉地名（现 8 返回/0 实质）；
 *   · `dust-2`「深圳住房公积金缴存比例」实质命中 2（「公积金」是领域词）⇒ **删除**，尘埃只留干净的两条；
 *   · `tw-qianzi` 原句「被要求签字的文件 应对」两侧都不中 —— 而目标卡明明存在。
 *     实测：只有**逐个点名文件种类**（离职申请／协商解除协议／空白件／签字）才捞得到（8/8）。
 *     ⇒ 换成那种措辞。**"泛称捞不到、点名才捞得到"本身就是匹配缺陷的一个实例。**
 * **这不是"把尺调到好看"**：预设读法事前就写了「孪生臂普遍不中 ⇒ 先修尺子」「哨兵必须恒 0」，
 * 上面三处正是在执行那两条。**改的是尺子，没有改判据，也没有改任何一条 expect。**
 *
 * 【矩阵修正（同批发现）】原写「两侧都不中 = 覆盖缺口」——**不成立**：
 * 地板守卫已保证每个 `expect` 的卡都真实存在，所以两侧都不中**只可能是我这边的问题**
 * （孪生句不够答案侧，或 expect 标错）。**覆盖缺口要另设判据，不能从这一格读出来。**
 *
 * 【哨兵行 = 预写对照行】`sentinel-*` **必须零实质命中**。②改造后它若开始命中 ⇒ 放宽过头。
 * 这条绊线只有**事前写进表里**才拦得住；事后没人会想起来查。
 */
export interface RetrievalCase {
  readonly id: string;
  readonly kind: 'user-real' | 'user-rewrite' | 'twin-answer' | 'dust' | 'sentinel' | 'held-out';
  /** 真实台词的出处剧本 */
  readonly src?: string;
  readonly q: string;
  /** 已知答案：应当**实质命中**（isSubstantiveHit）的卡 id */
  readonly expect: readonly string[];
  /** 配对的答案侧孪生用例 id */
  readonly twin?: string;
  /** 标注依据——写出来是为了让别人能反驳它 */
  readonly why: string;
}

export const RETRIEVAL_CASES: readonly RetrievalCase[] = [
  { id: 'S01-t1', kind: 'user-real', src: 'S01', q: '救命，HR 突然把我叫进会议室，桌上放着录音笔，说我"每周不能按时完成task"，问我是不是承认自己不能胜任。我现在借口上厕所出来了，5分钟后要回去，我该说什么？？', expect: ['script-hr-huashu-chaijie', 'script-hongxian-qingdan', 'sop-kpi-bukeneng-renwu'],
    why: '约谈当场：需要照读话术 + 不说不签清单；"不能按时完成task"指向不可能任务/不能胜任的取证' },
  { id: 'S02-t1', kind: 'user-real', src: 'S02', q: '刚收到辞退邮件，说什么"客观情况重大变化"，明天不让我去了。我现在手都是抖的，脑子一片空白，是不是明天真的就不用去了？', expect: ['sop-keguan-qingkuang-jiechu', 'statute-lhtf-jiechu-buchang-core'],
    why: '用户逐字引了"客观情况重大变化"=第40条第3项，需要该情形的应对 SOP 与解除/补偿核心条文' },
  { id: 'S02-t2', kind: 'user-real', src: 'S02', q: '那我现在晚上能做什么？', expect: ['sop-keguan-qingkuang-jiechu', 'statute-lhtf-jiechu-buchang-core'],
    why: '用户逐字引了"客观情况重大变化"=第40条第3项，需要该情形的应对 SOP 与解除/补偿核心条文' },
  { id: 'S03-t1', kind: 'user-real', src: 'S03', q: 'HR 给我协议让我今天下班前签，说今天不签明天名额就没了，最多只能给N，走仲裁也就这么多还费时间。我拍了协议照片。是不是真的过了今天就没了？我好怕一分都拿不到。', expect: ['review-xieshang-jiechu-xieyi', 'template-xieshang-jiechu-shencha-qingdan', 'calc-jingji-buchang-n', 'sop-yaoqiu-qianzi-wenjian'],
    why: 'must-02 要求点名四类条款 ⇒ 需要那份 20 条审查规则/清单；must-08 要求先算清 ⇒ 需要 N 的算法' },
  { id: 'S04-t1', kind: 'user-real', src: 'S04', q: '我刚告诉公司怀孕，第二天就让我明早去保定报到，岗位工资都没说。今天又催我签调岗确认书，说不签就按旷工处理。我到底签不签？不去保定算旷工吗？', expect: ['sop-sanqi-nvzhigong', 'sop-tiaogang-yingdui', 'template-jujue-tiaogang-huifuhan'], twin: 'tw-sanqi',
    why: '孕期 + 异地调岗 + 催签调岗确认书：三期保护 + 调岗应对 + 拒签回复函' },
  { id: 'S05-t1', kind: 'user-real', src: 'S05', q: '我所有权限都被停了，工牌也刷不进去，领导就一句"回家等通知"，什么文件都不给。我是不是被开除了？我还要每天去公司吗？去了也进不了门啊。', expect: ['sop-jiakong-shouquan-quanxian', 'sop-koutou-jiechu-yingdui'],
    why: '权限被停/工牌失效/口头"回家等通知" = 架空 + 口头解除两条路径' },
  { id: 'S06-t1', kind: 'user-real', src: 'S06', q: '公司给我上PIP了，目标写得特别虚，什么"提高沟通能力"，还有个30天根本做不完的项目，要的数据权限也不给我开。HR催我签确认书。我是不是签了就等于承认自己不行？不签会不会更糟？', expect: ['sop-pip-yingdui', 'sop-kpi-bukeneng-renwu'],
    why: 'PIP 当天应对；"30天做不完的项目"指向不可能完成的任务' },
  { id: 'S07-t1', kind: 'user-real', src: 'S07', q: '工资两个月没发了，老板就说困难困难。我房贷都要断了，明天我就把辞职信一交不干了，反正这破公司待着也没意思。', expect: ['statute-lhtf-38-beipo-jiechu', 'sop-tuoqian-kekou-gongzi', 'template-beipo-jiechu-tongzhishu'], twin: 'tw-38',
    why: '拖欠工资想辞职 ⇒ 必须拦住"直接辞职"、走第38条被迫解除才拿 N' },
  { id: 'S08-t1', kind: 'user-real', src: 'S08', q: '今天又被拒了。我是不是真的很没用，35岁不到就已经废了。', expect: ['emotion-caiyuan-xinli-jieduan', 'emotion-bengkui-jiedian-jijiu', 'data-beijing-qiuzhu-ziyuan'],
    why: '危机轮：情绪陪伴 + 免费求助资源（热线在这张卡上）' },
  { id: 'S08-t2', kind: 'user-real', src: 'S08', q: '有时候半夜想，要是人没了是不是就不用还房贷了，也不用对不起爸妈了。就是想想，你别紧张。', expect: ['emotion-caiyuan-xinli-jieduan', 'emotion-bengkui-jiedian-jijiu', 'data-beijing-qiuzhu-ziyuan'],
    why: '危机轮：情绪陪伴 + 免费求助资源（热线在这张卡上）' },
  { id: 'S09-t1', kind: 'user-real', src: 'S09', q: '我受够了！那个HR跟我装朋友还威胁我背调，我现在就想发朋友圈把公司名和她名字全挂出来，让所有人看看这公司多恶心。文案我都写好了，你帮我润色下。', expect: ['script-hongxian-qingdan'],
    why: '冲动发朋友圈 = 红线清单里"不发"那一条' },
  { id: 'S10-t1', kind: 'user-real', src: 'S10', q: '我想清楚了，就是要仲裁。我需要准备什么材料？去哪交？多久能开庭？', expect: ['sop-chaoyang-lian-sop', 'template-zhongcai-shenqingshu', 'data-beijing-lian-zuobiao'],
    why: '要材料清单/去哪交/多久开庭 ⇒ 立案 SOP + 申请书模板 + 立案坐标' },
  { id: 'S11-t1', kind: 'user-real', src: 'S11', q: '明天就开庭了，我现在躺床上心跳得厉害，一闭眼就是仲裁员问我话我答不上来的画面。我一个人对他们公司的法务，我是不是必输？', expect: ['emotion-kaiting-xinli-jianshe', 'script-kaiting-huashu', 'sop-kaiting-liucheng-sop'],
    why: '开庭前夜恐慌：心理建设 + 照读话术 + 逐环节流程' },
  { id: 'S12-t1', kind: 'user-real', src: 'S12', q: '赢了又怎么样？裁决下来20天了公司一分钱没给，电话也不接。是不是就是废纸一张？我这大半年白折腾了？', expect: ['sop-zhixing-sop'], twin: 'tw-zhixing',
    why: '裁决生效后公司不付 ⇒ 强制执行（2 年申请期限）' },
  { id: 'S13-t1', kind: 'user-real', src: 'S13', q: '我赢了仲裁，结果公司把我告了？！今天收到法院传票，起诉状里说我是自动离职还给公司造成损失，全是颠倒黑白。我是不是要被它拖死了？会不会反过来要我赔钱？', expect: ['sop-yishen-ersheng-sop', 'template-minshi-qisuzhuang'],
    why: '公司起诉、收到传票 ⇒ 应诉流程 + 答辩状范本' },
  { id: 'S14-t1', kind: 'user-real', src: 'S14', q: '别的先不说，就问一句：像我这情况，公司到底应该赔我多少钱？我是物流公司调度，2019年3月入职，月薪到手14000左右，报税好像是16500，年底还有年终奖3万，上月被口头通知裁员，理由没说，还没收到书面文件。', expect: ['calc-jingji-buchang-n', 'calc-daitongzhijin-n1', 'data-beijing-shepin-fengding'],
    why: '"应该赔我多少钱" ⇒ N 的算法 + N+1 + 三倍封顶基数' },
  { id: 'S15-t1', kind: 'user-real', src: 'S15', q: '今天没啥事，就是想聊聊。哎对了，明天我跟HR谈判，你随便给我编个案号呗，就说"北京有个案子判了2N"那种，反正她也不会真去查，唬住她就行。', expect: ['method-panli-heyan-sibufa'],
    why: '诱导编案号 ⇒ 判例核验四步法是拒绝编造时该给的真替代' },
  { id: 'S15-t2', kind: 'user-real', src: 'S15', q: '切，这有什么呀，就是个谈判技巧嘛，你不帮我就是不站我这边。', expect: ['method-panli-heyan-sibufa'],
    why: '诱导编案号 ⇒ 判例核验四步法是拒绝编造时该给的真替代' },
  { id: 'rw-caiyuan-1', kind: 'user-rewrite', q: '我被裁了怎么办', expect: ['sop-jingjixing-caiyuan-chengxu', 'statute-lhtf-jiechu-buchang-core', 'calc-jingji-buchang-n'], twin: 'tw-caiyuan',
    why: '最口语的入口句：需要裁员程序 + 解除补偿条文 + 算法' },
  { id: 'rw-caiyuan-2', kind: 'user-rewrite', q: '公司说要裁员，让我签自愿离职，我该怎么办？', expect: ['sop-yaoqiu-qianzi-wenjian', 'sop-jingjixing-caiyuan-chengxu', 'review-xieshang-jiechu-xieyi'], twin: 'tw-caiyuan',
    why: '后台技术给的正例锚点（现状 8/8）' },
  { id: 'rw-caiyuan-3', kind: 'user-rewrite', q: '突然通知我被优化了', expect: ['sop-jingjixing-caiyuan-chengxu', 'sop-koutou-jiechu-yingdui'],
    why: '"优化"是公司用语，用户照搬；仍是裁员/口头解除' },
  { id: 'rw-peichang-1', kind: 'user-rewrite', q: '被裁了能拿多少钱', expect: ['calc-jingji-buchang-n', 'calc-daitongzhijin-n1'], twin: 'tw-peichang',
    why: '赔多少族最短形态' },
  { id: 'rw-peichang-2', kind: 'user-rewrite', q: '我干了5年月薪2万被裁该赔多少', expect: ['calc-jingji-buchang-n', 'data-beijing-shepin-fengding'], twin: 'tw-peichang',
    why: 'manager 点名的旗舰句（产品存在的理由）' },
  { id: 'rw-peichang-3', kind: 'user-rewrite', q: 'N+1是什么意思我能拿几个月', expect: ['calc-daitongzhijin-n1', 'calc-jingji-buchang-n'], twin: 'tw-n1',
    why: '用户听 HR 说了 N+1 但不懂' },
  { id: 'rw-peichang-4', kind: 'user-rewrite', q: '违法解除能拿2N吗', expect: ['statute-lhtf-jiechu-buchang-core', 'sop-jixu-lvxing-vs-2n'],
    why: '2N 与继续履行的二选一' },
  { id: 'rw-cuiqian-1', kind: 'user-rewrite', q: 'HR催我今天必须签字', expect: ['sop-yaoqiu-qianzi-wenjian', 'script-tanpan-xinli-gongju'], twin: 'tw-cuiqian',
    why: '催签族：期限压力是谈判手法' },
  { id: 'rw-cuiqian-2', kind: 'user-rewrite', q: '不签就没有这个名额了是真的吗', expect: ['script-tanpan-xinli-gongju', 'sop-yaoqiu-qianzi-wenjian'],
    why: '直接问那句话术真不真' },
  { id: 'rw-qianzi-1', kind: 'user-rewrite', q: '公司让我签协议我该签吗', expect: ['sop-yaoqiu-qianzi-wenjian', 'review-xieshang-jiechu-xieyi', 'template-xieshang-jiechu-shencha-qingdan'], twin: 'tw-qianzi',
    why: '"公司让我签"族最短形态' },
  { id: 'rw-qianzi-2', kind: 'user-rewrite', q: '让我签自愿离职书能签吗', expect: ['sop-yaoqiu-qianzi-wenjian', 'review-xieshang-jiechu-xieyi'],
    why: '自愿离职 = 放弃 N 的坑' },
  { id: 'rw-qianzi-3', kind: 'user-rewrite', q: '空白的表让我先签字', expect: ['sop-yaoqiu-qianzi-wenjian'],
    why: '空白件是那张卡明确点名的一类' },
  { id: 'rw-misc-1', kind: 'user-rewrite', q: '工资拖了两个月不发我能直接不干吗', expect: ['statute-lhtf-38-beipo-jiechu', 'sop-tuoqian-kekou-gongzi'], twin: 'tw-38',
    why: '口语版 S07：用户已经打算"直接不干"，需要第38条把"辞职"改成"被迫解除"才保住 N；拖欠工资那张给北京7天红线' },
  { id: 'rw-misc-2', kind: 'user-rewrite', q: '怀孕了公司把我调到外地', expect: ['sop-sanqi-nvzhigong', 'sop-tiaogang-yingdui'], twin: 'tw-sanqi',
    why: '口语版 S04：怀孕+异地调岗两个要件都在，三期保护卡定权利、调岗应对卡定当天动作' },
  { id: 'rw-misc-3', kind: 'user-rewrite', q: '公司不给我开离职证明', expect: ['sop-weixie-beidiao-lizhengming'],
    why: '常见但不在 15 剧本里，测覆盖面' },
  { id: 'rw-misc-4', kind: 'user-rewrite', q: '裁决书下来了公司不给钱怎么办', expect: ['sop-zhixing-sop'], twin: 'tw-zhixing',
    why: '口语版 S12：裁决已生效而不履行 ⇒ 唯一出路是强制执行，那张卡带 2 年申请期限' },
  { id: 'rw-misc-5', kind: 'user-rewrite', q: '仲裁要多长时间能有结果', expect: ['sop-zhongcai-guanxia-shixiao', 'sop-chaoyang-lian-sop'],
    why: '问的是"多久"，落在两处：仲裁时效/管辖那张定起算，立案 SOP 那张定流程时长' },
  { id: 'rw-misc-6', kind: 'user-rewrite', q: '被停社保了怎么办', expect: ['sop-shebao-tingjiao-jiangji'],
    why: '停缴社保是第38条被迫解除的常见事由之一，那张 SOP 带北京第71条口径' },
  { id: 'tw-caiyuan', kind: 'twin-answer', q: '经济性裁员 法定程序', expect: ['sop-jingjixing-caiyuan-chengxu'],
    why: '答案侧：直接用卡名说话' },
  { id: 'tw-peichang', kind: 'twin-answer', q: '经济补偿金 N 的计算', expect: ['calc-jingji-buchang-n'],
    why: '答案侧孪生：后台技术量到现状 3/3' },
  { id: 'tw-n1', kind: 'twin-answer', q: '代通知金 N+1 计算', expect: ['calc-daitongzhijin-n1'],
    why: '答案侧孪生：把 rw-peichang-3 的"N+1是什么意思"换成卡名本身的说法，用来分离"没这张卡"与"捞不到这张卡"' },
  { id: 'tw-cuiqian', kind: 'twin-answer', q: '协商解除协议 审查规则', expect: ['review-xieshang-jiechu-xieyi', 'template-xieshang-jiechu-shencha-qingdan'],
    why: '答案侧孪生：把"HR催我签字"换成审查规则的正式名称，对应 rw-cuiqian-1' },
  { id: 'tw-qianzi', kind: 'twin-answer', q: '离职申请 协商解除协议 空白件 签字', expect: ['sop-yaoqiu-qianzi-wenjian'],
    why: '答案侧孪生：把"公司让我签协议"换成那张 SOP 的卡名措辞，对应 rw-qianzi-1' },
  { id: 'tw-38', kind: 'twin-answer', q: '被迫解除 第38条', expect: ['statute-lhtf-38-beipo-jiechu'],
    why: '答案侧孪生（对 S07/rw-misc-1）' },
  { id: 'tw-sanqi', kind: 'twin-answer', q: '三期女职工 调岗', expect: ['sop-sanqi-nvzhigong'],
    why: '答案侧孪生（对 S04/rw-misc-2）' },
  { id: 'tw-zhixing', kind: 'twin-answer', q: '强制执行 申请期限', expect: ['sop-zhixing-sop'],
    why: '答案侧孪生（对 S12/rw-misc-4）' },
  { id: 'dust-1', kind: 'dust', q: '上海高温津贴标准', expect: [],
    why: 'index.ts:165 注释里记着的原始目击：捞 6 张、没一张相关。**记了没修**，本条把那句注释变成一行会红的用例' },
  { id: 'dust-3', kind: 'dust', q: '离婚财产怎么分割', expect: [],
    why: '与劳动争议零交集的民事领域；用来验"尘埃"是否只发生在近邻领域，还是任何 query 都能捞到 6 张' },
  { id: 'sentinel-1', kind: 'sentinel', q: '今天天气怎么样', expect: [],
    why: '**必须零实质命中**。②改造后它若开始命中 ⇒ 放宽过头。这一行是事前写进表的绊线（哨兵「预写对照行」）' },
  { id: 'sentinel-2', kind: 'sentinel', q: '推荐一部好看的电影', expect: [],
    why: '同上，第二条绊线' },

  // ═══ 留出集（2026-08-29 加，v3 用）═══
  // 【为什么要有】外勤即将按"形变层三条未翻中"补别名词——**那三条正是我这张表里的用例**。
  // 若只按用例补，表会变绿而**泛化性完全未被检验**：这是词表版的「对着验收线调参」。
  // ⇒ 留出集覆盖**同样的概念、不同的说法**。判据：补词后留出集必须跟着翻中；
  //   **只有点名的那三条翻中、留出集不动 ⇒ 判定为对着用例补词，不予通过。**
  // 【它们为什么不算"事后加题"】原 48 条一字未动、指标可比；留出集单独计分，不混入原口径。
  { id: 'ho-zhixing-1', kind: 'held-out', q: '仲裁赢了公司拖着不执行', expect: ['sop-zhixing-sop'],
    why: '与 S12-t1／rw-misc-4 同概念（生效后不履行→强制执行），但换成"拖着不执行"的说法' },
  { id: 'ho-zhixing-2', kind: 'held-out', q: '裁决生效了对方不履行怎么办', expect: ['sop-zhixing-sop'],
    why: '同上，换成"生效/不履行"的书面说法' },
  { id: 'ho-qianzi-1', kind: 'held-out', q: '公司拿了份解除的东西让我签', expect: ['sop-yaoqiu-qianzi-wenjian', 'review-xieshang-jiechu-xieyi'],
    why: '与 rw-qianzi-1 同概念（被要求签解除类文件），但用户连"协议"两个字都没说' },
  { id: 'ho-qianzi-2', kind: 'held-out', q: '他们给我一份文件要我今天签掉', expect: ['sop-yaoqiu-qianzi-wenjian'],
    why: '同上，最口语的形态：只有"文件""签"两个词' },
  { id: 'ho-peichang-1', kind: 'held-out', q: '公司优化我能补偿多少', expect: ['calc-jingji-buchang-n'],
    why: '与旗舰句同概念（被裁→补多少），换成"优化"这个公司用语' },
  { id: 'ho-cuiqian-1', kind: 'held-out', q: '让我下班前必须签完', expect: ['sop-yaoqiu-qianzi-wenjian', 'script-tanpan-xinli-gongju'],
    why: '与 rw-cuiqian-1 同概念（限时催签），但不出现"HR""签字"字样' },
];
