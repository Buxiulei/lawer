// app/src/lib/agent/prompt.ts
// system prompt 组装（manager 契约）：charter 全文 + 案件档案摘要 + 检索到的 packs 逐字原文。
//
// 【顺序是有讲究的】准则在最前、知识在最后：
//   ① charter 定的是「怎么做人」，必须先于一切内容生效，包括在读到 pack 内容之后；
//   ② 档案摘要在中间，因为它是 charter 各条纪律的作用对象（跟踪上轮行动卡、别重复问已知的事）；
//   ③ pack 原文放最后、紧挨用户消息，是让「引用依据」这件事离生成点最近。
//
// 【不做的事】本文件不做任何摘要、压缩、改写。档案是事实，packs 是法条原文，
// 任何一处「为了省 token 而转述」都会以「模型把转述当原文引用」的形式变成可信度事故。

import { CHARTER } from './charter';
import { intakeDirective, recapBrief, type IntakeStage } from './intake';
import { MAX_ACTION_CARDS } from './tools';
import { CRISIS_DIRECTIVE, CRISIS_RESOURCE_PACK_ID } from './crisis';
import { coreArticleKeys, packCitationGuide, type CoreArticleSources } from './citation-block';
import type { KnowledgePack } from './retrieval';
import type { CaseSnapshot } from './snapshot';

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

/**
 * 北京时间的可读串 + ISO8601 串。
 *
 * 为什么必须给：charter §2 要求行动卡的截止时间具体到当天与句子级，action_card 又要求
 * due_at 是 ISO8601。模型不知道「今天几号」就只能编一个日期，那张卡的截止时间就是错的。
 * 给 +08:00 而不是 UTC，是因为用户说的「今天下班前」指的是北京时间的今天。
 */
export function beijingNow(now: Date): { readable: string; iso: string } {
  const bj = new Date(now.getTime() + 8 * 3600_000);
  const p = (n: number) => String(n).padStart(2, '0');
  const date = `${bj.getUTCFullYear()}-${p(bj.getUTCMonth() + 1)}-${p(bj.getUTCDate())}`;
  const time = `${p(bj.getUTCHours())}:${p(bj.getUTCMinutes())}`;
  return {
    readable: `${date}（周${WEEKDAYS[bj.getUTCDay()]}）${time}`,
    iso: `${date}T${time}:00+08:00`,
  };
}

/** 案件档案摘要。空档案也要如实说「空」——模型看不见「没有」就会假设「有」。 */
export function caseDigest(s: CaseSnapshot): string {
  const c = s.case;
  const lines: string[] = [
    '## 案件档案（服务端读出的当前事实，以此为准，用户说法与此矛盾时先核对再改档）',
    '',
    `- 案件：#${c.id}《${c.title}》 阶段：${c.stage} 地区：${c.district}`,
    `- 用户目标：${c.goal ?? '（未记录）'}`,
    `- 用户底线：${c.bottom_line ?? '（未记录）'}`,
  ];

  lines.push('', `### 公司主体（${s.companies.length} 个）`);
  if (s.companies.length === 0) lines.push('（空——还不知道是哪家公司）');
  else {
    for (const p of s.companies) {
      const bits = [p.role, p.uscc ? `统一社会信用代码 ${p.uscc}` : null, p.legal_rep ? `法定代表人 ${p.legal_rep}` : null]
        .filter(Boolean)
        .join('，');
      lines.push(`- ${p.name}（${bits}）${p.risk_notes ? ` 风险：${p.risk_notes}` : ''}`);
    }
  }

  lines.push('', `### 时间线（最近 ${s.timeline.length} 条，倒序）`);
  if (s.timeline.length === 0) lines.push('（空——还没有任何已落档的事件）');
  else for (const e of s.timeline) lines.push(`- ${e.happened_at}｜${e.kind}｜${e.title}${e.detail ? `：${e.detail}` : ''}`);

  lines.push('', `### 诉求（claims，${s.claims.length} 项）`);
  if (s.claims.length === 0) lines.push('（空——还没有登记任何金额诉求）');
  else {
    for (const cl of s.claims) {
      const amount = cl.amount_fen > 0 ? `${(cl.amount_fen / 100).toFixed(2)} 元` : '待计算';
      lines.push(`- ${cl.kind}：${amount}${cl.basis ? `｜依据 ${cl.basis}` : ''}${cl.calc_json ? `｜算式 ${cl.calc_json}` : ''}`);
    }
  }

  lines.push('', `### 未完成的行动卡（${s.openActions.length} 张，charter §9 要求本轮跟踪）`);
  if (s.openActions.length === 0) lines.push('（空）');
  else for (const a of s.openActions) lines.push(`- #${a.id}《${a.title}》${a.due_at ? ` 截止 ${a.due_at}` : ''}`);

  if (s.deadlines.length) {
    lines.push('', '### 生效中的法定期限');
    for (const d of s.deadlines) lines.push(`- ${d.kind}：${d.due_at}${d.derived_from ? `（推算依据：${d.derived_from}）` : ''}`);
  }

  if (s.referredNbdpsy) {
    lines.push('', '> 本案**已经**转介过一次心理咨询（NBDpsy）。spec §10：一案最多一次，不得再提。');
  }

  return lines.join('\n');
}

/** 检索到的 packs 逐字原文段。
 *  noteAfter：紧贴某张卡的正文之后追加一条指令——模型对**邻近**指令的依从性明显好于
 *  放在通用指令区的同一句话（实测：危机轮「别重印整张卡」写在开头时被无视，卡给了两轮）。 */
export function packsSection(
  packs: KnowledgePack[],
  noteAfter?: { packId: string; note: string },
  coreArticles: Set<string> = new Set(),
): string {
  if (packs.length === 0) return '';
  const blocks = packs.map((p) =>
    [
      `### [${p.id}] ${p.title}`,
      `类型：${p.type}｜适用地区：${p.region}｜可信度：${p.confidence}｜更新于 ${p.updated}`,
      '',
      p.body,
      // G4：引用要求**逐卡贴附**，不放段落抬头。抬头那句"法条给条号+逐字原文"一直都在，
      // 而 G4 在定版批 6/6 全挂——指令离约束对象太远就被稀释，这是第三次同型。
      // 内容是拼好的引用块（照抄比缩写省力），拼不出来时给填空模板。
      '',
      packCitationGuide(p, coreArticles),
      ...(noteAfter && noteAfter.packId === p.id ? ['', `> ⚠️ **本卡使用限制**：${noteAfter.note}`] : []),
    ].join('\n'),
  );
  return [
    '## 本轮检索到的依据（逐字原文，引用时照抄，不要改写）',
    '',
    '引用纪律：法条给条号 + 逐字原文；判例给案号 + 来源；数字给值与生效期间。',
    '可信度标「待核实」的卡，引用时必须把这个状态一起告诉用户。',
    '下面没有的条号、案号、文号、数字，一律视为你不知道——需要就再调 knowledge_search，检索不到就说「需要核实」。',
    '',
    blocks.join('\n\n---\n\n'),
  ].join('\n');
}

/** 输出纪律段：把 charter 里几条能机械判定的要求，翻译成「本轮具体该调哪个工具」。 */
function outputDiscipline(): string {
  return [
    '## 本轮输出纪律（硬性）',
    '',
    `1. **行动卡**：回复必须以「现在做什么」收口，调用 action_card 产出 1-${MAX_ACTION_CARDS} 张。`,
    '   一张卡 = 做什么(what) + 怎么做(how，含可照读原句) + 为什么(why，一句带依据) + 截止时间(due_at)。',
    '   用户情绪崩溃时只给 1 张，把下一步缩小到一件事（charter §5）。',
    '2. **落档**：用户这轮说出来的新事实当轮落库，不要只写在正文里——',
    '   事件 → timeline_add；金额要素 → claims_upsert；公司主体 → company_profile_upsert；情绪 → emotion_log。',
    '   正文里说「已经帮你记下了」而没调工具，等于没记。',
    '3. **依据**：任何条号、案号、文号、金额标准、社平/最低工资数值，只能来自 knowledge_search 的返回。',
    '   凭记忆写出来的一律算编造（charter §7.1）。检索不到就明说「这点我需要核实，先按保守做法……」。',
    '4. **金额**：一切计算走 claim_calc，禁止心算——分段与三倍封顶你算不对，错的金额会写进仲裁申请书。',
    '   展示结果时必须带上它返回的 formula 算式，并逐项说明哪些输入是「用户自述待证」。',
    '5. **文书**：draft_write 起草；发给公司的文书必须同时给 send_consequences，且要在正文里明说',
    '   「发不发由你决定，我不会替你发出」（charter §7.2、§7.5）。',
    '6. **不可逆动作**：签字、辞职、接受方案、拒签、发出通知、公开发声——凡是做了就收不回的，',
    '   你只做两件事：把利弊摆开、给出你的倾向。**最后必须有一句明确把决定权交回用户**，',
    '   例如「签不签由你决定」「看完这几条你再决定」。分析写得再充分，缺这一句就是替用户拍板。',
    '   （charter §7.2。这条不限于文书——S03 实测：整段把签与不签的后果讲透了，却从头到尾',
    '   没有一句交还决定权，读起来就成了「我已经替你判了」。）',
    '7. **冲动前兆的拦截对象**：要拦的是**不可逆动作本身**——发出去、签字、递交、辞职、转账；',
    '   **不是它的准备工作**——写文案、想措辞、查资料、问我意见都不必拦，那些恰恰是该鼓励的冷静步骤。',
    '   「先别急着**发**」是拦截；「先别急着**写**」不是，写完不发没有任何损失。',
    '   讲清后果、给替代动作、把决定权交还——这些都属于**拦截之后**的事，**不能替代拦截本身**：',
    '   一段话把「发出去会被公司反用作证据」讲得再透，只要没有明确说出「先别发」，就没有拦住。',
    '   （与第 6 条同族：都是对不可逆动作的处置纪律。）',
    '8. **可照读原句**：凡是用户接下来要**对公司开口或动笔**的场合（催签、约谈、拒签、请假、要书面说明），',
    '   都要给一句**可以直接照着念、不用改一个字**的话，单独成行加引号。charter §6 要的是句子，不是策略描述——',
    '   「你可以表达一下需要考虑的意思」是废话；「这份我先带回去看看，明天上午给您答复」才是能用的。',
    '   同时标一句「哪些话绝不能说」（如别说"我不干了"、别说"随便你们"）。',
    '9. **被要求做不该做的事时**：明确说「不」，把理由落在**用户自己的利害**上，不评价他的人品。',
    '   「这个我不编」+「编的案号一旦被识破，你后面所有真话都会被当成假的」——这是帮他；',
    '   「你这样不对」「做人要诚信」是训人，**说教会让他觉得你站在对面**，而你必须站在他这边。',
    '   拒绝之后立刻给**更好用的真东西**（真实条文/案号），让他明白拒绝不是不帮忙。',
    '10. **引判例**：判例段**只复述卡里写的**（案情要旨/争议焦点/结果/裁判理由），',
    '   用户自己的情况——时间、岗位、薪资、公司怎么做的——**一个字都不许写进判例案情**。',
    '   要讲相似点就另起一句：「你的情况与之相似之处是……」，把判例事实与你的事实分开摆。',
    '   （实测事故：引的是真案例，却把用户的「次日报到」「未明确新岗位及薪资待遇」写进了案情。',
    '   **案号是真的、细节是编的**——用户当庭复述，对方一查全文没有该情节，失信的是用户自己。）',
    '11. **格式**：短句、编号、直给。不写「以上仅供参考」「建议咨询专业律师」这类话（charter §1、§7.7）。',
  ].join('\n');
}

export interface BuildSystemPromptInput {
  snapshot: CaseSnapshot;
  /** threads.mode：问诊 | 陪跑 | 文书 | 录音分析 */
  mode: string;
  stage: IntakeStage;
  /** 预检索到的 packs（逐字原文） */
  packs: KnowledgePack[];
  /** ⭐核心条的取料（S1 档案三来源 / S3 场景映射 / S4 用户原话），由 orchestrator 一处算清 */
  coreSources?: CoreArticleSources;
  now: Date;
  /** 本轮识别到自伤/极端痛苦表述（见 crisis.assessCrisis） */
  crisis?: boolean;
  /** 本案此前已给过危机资源卡：指令照下，但不再重复整张卡（spec §10 不刷屏） */
  crisisCardAlreadyGiven?: boolean;
  /** 本轮是否够格提及付费心理咨询（charter §5 持续焦虑抑郁表现 且 未转介过） */
  nbdpsyEligible?: boolean;
}

export function buildSystemPrompt(input: BuildSystemPromptInput): string {
  const { readable, iso } = beijingNow(input.now);
  const parts = [
    CHARTER,
    // 危机指令紧跟 charter，排在案件档案与问诊指令**之前**：
    // 它要压过本轮其它一切安排（问诊清单、行动卡、依据纪律），放在后面会被前面的
    // 「每轮必须问 1-3 个问题」「必须给行动卡」稀释成又一条并列要求。
    input.crisis ? CRISIS_DIRECTIVE : '',
    [
      '## 运行环境',
      '',
      `- 当前北京时间：${readable}（ISO8601：${iso}）。所有「今天/明天/下班前」按这个时刻换算。`,
      `- 默认适用地区：${input.snapshot.case.district}区（北京市）。`,
      `- 当前会话模式：${input.mode}。`,
    ].join('\n'),
    caseDigest(input.snapshot),
    // 陪跑/文书这类"回头继续"的模式先给前情提要；首诊(问诊)不需要，用户刚开口
    input.mode === '问诊' ? intakeDirective(input.stage) : `${recapBrief(input.snapshot)}\n\n${intakeDirective(input.stage)}`,
    outputDiscipline(),
    // 【前置禁令 > 事后剥句】不够格时**在生成前就禁掉**，而不是等它说完再剥——
    // 普通轮是流式的，剥句只能清掉入库正文，用户早看见了。
    // 事后剥句仍保留作兜底，但真正管用的是这条前置约束。
    input.nbdpsyEligible === false
      ? [
          '## 本轮禁止提及付费心理咨询（硬性）',
          '',
          '不得以任何形式提及、推荐、或提出代为预约 NBDpsy 及任何付费心理咨询服务',
          '（含「我可以帮你约」「安排一次专业咨询」这类说法）。',
          '理由：charter §5 只允许在**持续焦虑抑郁表现**时提一次，本案尚未达到该条件；',
          'spec D9 明令禁止趁人之危观感——在用户刚说出痛苦的那一刻推销服务，正是它要禁的事。',
          '需要给支持资源时，给**免费公益资源**（心理援助热线、工会、法援），不要给我们的付费服务。',
        ].join('\n')
      : '',
    packsSection(
      input.packs,
      // 「别重印整张卡」这条**紧贴卡本身**下发，不放通用指令区：
      // 实测放开头时模型照样把整张卡重印了两轮，指令离约束对象太远就被稀释了。
      input.crisis && input.crisisCardAlreadyGiven
        ? {
            packId: CRISIS_RESOURCE_PACK_ID,
            note:
              '本案 24 小时内已经给过一次这张卡，本轮**不要再整张重复**（spec §10 不刷屏）。' +
              '但三个号码本身**仍然必须出现在这一轮回复里**——用一句话重述即可，' +
              '如「热线还是这三个，随时能打：12356 / 座机 800-810-1117 / 手机 010-82951332」。' +
              '绝不能让用户在这种时刻回头翻聊天记录找号码。',
          }
        : undefined,
      // 核心依据条**由结构化事实判定**，不让模型自己勾——见 citation-block.coreArticleKeys：
      // S1 档案三来源恒优先；S1 空（首诊轮）时 S3 场景映射优先占上限、S2 检索序补足、
      // S4 用户点名不占上限。取料面在 orchestrator 一处算清，这里只补本通路的注入包。
      coreArticleKeys({ ...input.coreSources, retrieved: input.packs }),
    ),
  ];
  return parts.filter((p) => p.trim()).join('\n\n---\n\n');
}
