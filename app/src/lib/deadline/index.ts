// app/src/lib/deadline/index.ts
// 法定期限推算（最小确定性版本，manager 2026-08-19 裁决）。
//
// 【为什么日期必须由代码算】期限错过即权利灭失（migrate.ts deadlines 注释：全产品最不能出错的地方）。
// 让模型自己算「8 月 19 日 + 15 日是几号」再填进来，是把一条生死线交给一次心算——
// 而它算错不会有任何东西拦得住。所以模型只给**锚点日期 + 期限类型**，日期由本模块算出来。
// 这是 manager 2026-08-19 定的项目级范式：资金/证据/期限类数据一律工具直落，不容模型中间转述。
//
// 【纯函数，不读时钟】起算日由调用方传入。期限推算与「今天几号」无关，
// 掺进 new Date() 就没法测跨年与大小月边界了。
//
// 【起算规则的依据全部来自 knowledge packs，不凭记忆】每条规则的 basis 都是条号 + 逐字原文
// （charter §3）。尤其「自收到之日起算」到底含不含当日——各条规则口径**不一样**，
// 逐条按卡内容编码，见下方 RULES 的 countFrom 字段。
//
// 【本版不做的事，如实标注而不是假装精确】
// 节假日顺延（民诉法第八十五条「期间届满的最后一日是法定休假日的，以休假日后的第一日为期间届满的日期」）
// 需要国务院每年公布的节假日表，本版没有那份数据，所以**不算**，并在落库记录里显式写明
// 「未含节假日顺延」。宁可让用户看见「这个日子没考虑放假」，也不能给一个看起来精确、
// 实际可能早一天或晚一天的日子。

/** 起算方式。两者差一天，而这一天就是生死线本身。 */
export type CountFrom =
  /** 自当日起算（「之日起计算」）——法定时效多为此种 */
  | 'sameDay'
  /** 自次日起算（「从签收次日起算」）——诉讼/上诉期间为此种，北京有明文 */
  | 'nextDay';

export interface DeadlineRule {
  /** 规则键，模型从这里选 */
  key: string;
  /** 落 deadlines.kind 的值。必须是 migrate.ts 枚举里的串 */
  storedKind: string;
  label: string;
  countFrom: CountFrom;
  /** 期间长度。天与年分开：年要按自然年推，不能折算成 365 天 */
  span: { days: number } | { years: number };
  /** 条号 + 逐字原文（charter §3：涉法断言必须给条号与原文） */
  basis: string;
  /** 该期限特有的提醒 */
  caveats?: string[];
  /** true = 天数由办案机构指定，不是法定固定值，必须由调用方给 days */
  daysFromCaller?: boolean;
}

/**
 * 期限规则表。**每一条的 basis 都抄自 knowledge packs，不是凭记忆写的**：
 * 仲裁时效 → sop-zhongcai-guanxia-shixiao；起诉 15 日 → sop-caijue-yicaizhongju；
 * 上诉 15 日 → template-minshi-shangsuzhuang；申请执行 2 年 → sop-zhixing-sop；
 * 答辩期 → sop-yishen-ersheng-sop；举证期限 → sop-juzheng-xuzhi-sop。
 */
export const DEADLINE_RULES: Record<string, DeadlineRule> = {
  仲裁时效: {
    key: '仲裁时效',
    storedKind: '仲裁时效',
    label: '劳动争议仲裁时效（1 年）',
    // 「从……之日起计算」，卡内未给次日起算的特别口径，故按当日起算。
    // 方向上这也更保守：算出来的到期日更早，用户会更早动手。
    countFrom: 'sameDay',
    span: { years: 1 },
    basis:
      '《劳动争议调解仲裁法》第二十七条：「劳动争议申请仲裁的时效期间为一年。仲裁时效期间从当事人知道或者应当知道其权利被侵害之日起计算。」',
    caveats: [
      '劳动关系存续期间因拖欠劳动报酬发生争议的不受一年限制，但劳动关系终止的应自终止之日起一年内提出（同条第四款）。',
      '时效可因主张权利而中断、因不可抗力而中止；本日期未计入任何中断/中止事由。',
    ],
  },
  起诉15日: {
    key: '起诉15日',
    storedKind: '起诉15日',
    label: '不服仲裁裁决起诉期（15 日）',
    // 卡内明文：期间从签收次日起算（北京《解答（一）》第 12 条）
    countFrom: 'nextDay',
    span: { days: 15 },
    basis:
      '《劳动争议调解仲裁法》第五十条：「当事人对本法第四十七条规定以外的其他劳动争议案件的仲裁裁决不服的，' +
      '可以自收到仲裁裁决书之日起十五日内向人民法院提起诉讼；期满不起诉的，裁决书发生法律效力。」' +
      '起算口径见京高法发〔2024〕534号《解答（一）》第 12 问：「《调解仲裁法》第四十八条和第四十九条涉及的期间的起算，' +
      '应与《民事诉讼法》的有关规定相一致，均从次日起算。」',
    caveats: ['期满不起诉，裁决即对你生效，不能再翻。', '申请补正裁决书不停止本期间。'],
  },
  上诉15日: {
    key: '上诉15日',
    storedKind: '上诉15日',
    label: '不服一审判决上诉期（15 日）',
    countFrom: 'nextDay',
    span: { days: 15 },
    basis:
      '《民事诉讼法》第一百七十一条：「当事人不服地方人民法院第一审判决的，有权在判决书送达之日起十五日内向上一级人民法院提起上诉。」对判决 15 日、对裁定 10 日，均从送达次日起算。',
    caveats: ['对**裁定**上诉是 10 日不是 15 日，本规则只适用于判决。'],
  },
  申请执行2年: {
    key: '申请执行2年',
    storedKind: '申请执行2年',
    label: '申请强制执行期间（2 年）',
    countFrom: 'sameDay',
    span: { years: 2 },
    basis: '《民事诉讼法》第二百五十条：「申请执行的期间为二年。申请执行时效的中止、中断，适用法律有关诉讼时效中止、中断的规定。」',
    caveats: [
      '裁决书写明「生效之日起十日内支付」的，2 年从该履行期间的最后一日起算；未写履行期间的从生效之日起算——锚点日期请按此选取。',
      '终本后申请恢复执行不受本 2 年期间限制。',
    ],
  },
  答辩期15日: {
    key: '答辩期15日',
    // deadlines.kind 无 DB 级 CHECK（WS1 经 manager 确认 2026-08-19），字面值直接写，
    // 不再借「自定义」占位——derived_from 回归它本来的用途：记锚点事件与推算过程。
    storedKind: '答辩期',
    label: '应诉答辩期（15 日）',
    countFrom: 'nextDay',
    span: { days: 15 },
    basis:
      '《民事诉讼法》第一百二十八条（节选）：「人民法院应当在立案之日起五日内将起诉状副本发送被告，' +
      '被告应当在收到之日起十五日内提出答辩状……被告不提出答辩状的，不影响人民法院审理。」',
    caveats: ['不提答辩状不影响法院审理，但会放弃书面陈述的机会；开庭仍必须到场，缺席有败诉风险。'],
  },
  举证期限: {
    key: '举证期限',
    storedKind: '举证期限',
    label: '举证期限（由办案机构指定）',
    countFrom: 'sameDay',
    span: { days: 0 },
    daysFromCaller: true,
    basis:
      '朝阳区劳动人事争议仲裁委《举证须知》三：「举证期限由本委根据案件情况指定，自当事人收到案件受理通知书或立案通知书之日起计算。当事人应当在举证期限内向本委提交证据材料，当事人在举证期限内不提交的，视为放弃举证权利。」',
    caveats: ['天数由仲裁委在通知书上指定，不是法定固定值——必须照通知书上写的填，不能猜。'],
  },
};

/**
 * 期间计算通则（manager 2026-08-19 核对项）。
 *
 * 依据 knowledge/packs/statutes/qijian-jisuan-tongze.md（WS4 2026-08-19 补卡）逐字回填。
 * 该卡 confidence 为「待核实」（flk.npc.gov.cn 官方原始页尚未逐字比对，现为维基文库转录
 * + 534 号第 12 问 + 办案规则 §19 三源互证），按 charter §3 引用时如实带上这个状态。
 */
export interface StatuteQuote {
  law: string;
  article: string;
  text: string;
}

/**
 * 用卡里的**逐字条文**拼期间计算通则说明。
 *
 * 【为什么改成从卡读】原来这段是我**手抄**卡里的条文进代码常量——审计时定为中风险：
 * 卡更新了代码不会跟着变，而且没有任何东西会报错，条文就那么悄悄陈旧下去。
 * 现在只读 `facts.statute_quotes`（manager 根治方向：代码只读结构化字段）。
 *
 * 卡拿不到时回落到内置常量并**如实标注**——期限推算不能因为卡读不到就停摆，
 * 但也不能假装依据是新的。
 */
export function buildPeriodGeneralRule(quotes?: StatuteQuote[], confidence?: string): string {
  if (!Array.isArray(quotes) || quotes.length === 0) return `${PERIOD_GENERAL_RULE_FALLBACK}（**依据卡未取到，以上为代码内置副本，可能已陈旧**）`;
  const cited = quotes.map((q) => `《${q.law}》${q.article}：「${q.text}」`).join('');
  return `期间计算通则依据 ${cited}（依据卡 statute-qijian-jisuan-tongze，可信度：${confidence ?? '未标注'}）`;
}

/** 卡不可用时的兜底副本。**只作兜底**，正常路径走 buildPeriodGeneralRule。 */
export const PERIOD_GENERAL_RULE_FALLBACK =
  '期间计算通则依据《中华人民共和国民事诉讼法》第八十五条：' +
  '「期间以时、日、月、年计算。期间开始的时和日，不计算在期间内。' +
  '期间届满的最后一日是法定休假日的，以法定休假日后的第一日为期间届满的日期。' +
  '期间不包括在途时间，诉讼文书在期满前交邮的，不算过期。」' +
  '仲裁侧经《劳动人事争议仲裁办案规则》第十九条桥接：' +
  '「仲裁期间的计算，本规则未规定的，仲裁委员会可以参照民事诉讼关于期间计算的有关规定执行。」' +
  '（依据卡 statute-qijian-jisuan-tongze，可信度：待核实）';

/**
 * 「交邮不算过期」——民诉法 §85 末句给的兜底，写成固定提醒随每次推算下发。
 *
 * 这条对我们的用户特别值钱：他们自己跑流程，常常卡在最后一天赶不到窗口。
 * 知道「最后一天去邮局交邮、留好详情单存根」同样有效，能救回一个本来会过期的权利。
 */
export const MAIL_BEFORE_EXPIRY_CAVEAT =
  '赶不及现场递交时：诉讼文书**在期满前交邮**的不算过期（民诉法第八十五条末句），' +
  '以 EMS 详情单日期为准——最后一天去邮局是合法兜底，务必保留详情单存根。';

/**
 * 末日顺延的实现范围与如实标注。
 *
 * 周六日是确定性的（任何日期都能算出星期几），所以**编码实现**；
 * 法定节假日（春节、国庆等）需要国务院每年公布的假日表，本项目没有那份数据源，
 * 所以不算，并显式告诉用户去人工核对——而不是假装这个日期已经精确。
 */
export const HOLIDAY_CAVEAT =
  '末日顺延：本日期**已按周末顺延**（末日为周六/周日的，顺延至下一个工作日），' +
  '但**未含法定节假日顺延**（春节、国庆等假期表本系统无数据源）。' +
  '若本日期临近法定假期，请人工核对顺延后的实际届满日；无论如何都请提前行动，不要卡最后一天。';

export interface DeadlineComputation {
  /** 到期日，'YYYY-MM-DD' */
  dueDate: string;
  rule: DeadlineRule;
  /** 推算依据说明，落 deadlines.derived_from（用户可自查系统算得对不对） */
  derivedFrom: string;
  /** 该期限的全部提醒，含节假日未顺延标注 */
  caveats: string[];
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})/;

/** 解析 'YYYY-MM-DD'（也接受带时间的串，只取日期部分）→ UTC 零点。
 *  全程按 UTC 算：日期加减不该受服务器时区影响。 */
function parseDate(value: string): Date {
  const m = DATE_ONLY.exec(value.trim());
  if (!m) throw new Error(`锚点日期格式不对：「${value}」，需要 YYYY-MM-DD`);
  const [, y, mo, d] = m;
  const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  if (
    date.getUTCFullYear() !== Number(y) ||
    date.getUTCMonth() !== Number(mo) - 1 ||
    date.getUTCDate() !== Number(d)
  ) {
    throw new Error(`锚点日期不存在：「${value}」`);
  }
  return date;
}

function fmt(date: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}-${p(date.getUTCMonth() + 1)}-${p(date.getUTCDate())}`;
}

/**
 * 按自然年推 N 年。2 月 29 日 + 1 年在平年没有对应日，按**当月最后一日**取
 * （2024-02-29 + 1 年 → 2025-02-28），而不是滑到 3 月 1 日——期限宁可早一天，不可晚一天。
 */
function addYears(date: Date, years: number): Date {
  const y = date.getUTCFullYear() + years;
  const m = date.getUTCMonth();
  const d = date.getUTCDate();
  const lastDayOfMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(d, lastDayOfMonth)));
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

/**
 * 推算到期日。**纯函数**：同样输入永远同样输出，不读时钟。
 *
 * @param ruleKey DEADLINE_RULES 的键
 * @param anchor 起算锚点，'YYYY-MM-DD'（如裁决书签收日、解除日）
 * @param options.days 仅 daysFromCaller 的规则需要（举证期限：通知书上指定的天数）
 */
export function computeDeadline(
  ruleKey: string,
  anchor: string,
  options: { days?: number; generalRule?: string } = {},
): DeadlineComputation {
  const rule = DEADLINE_RULES[ruleKey];
  if (!rule) {
    throw new Error(`未知期限类型「${ruleKey}」，可选：${Object.keys(DEADLINE_RULES).join(' / ')}`);
  }

  const anchorDate = parseDate(anchor);
  // 次日起算：第 1 日是锚点的次日，故第 N 日 = 锚点 + N 天。
  // 当日起算：第 1 日就是锚点当天，故第 N 日 = 锚点 + (N-1) 天。
  const startOffset = rule.countFrom === 'nextDay' ? 1 : 0;

  let due: Date;
  let spanText: string;
  if ('years' in rule.span) {
    // 年期间取**锚点的周年对应日**（《民法典》第二百零二条「到期月的对应日为期间的最后一日」的
    // 通行读法）。这里刻意不再叠加「开始日不算入」的一天：叠加会把届满日往后推一天，
    // 而期间这件事上晚一天是致命的、早一天只是提前行动。精确口径待 WS4 补通则卡后复核。
    due = addYears(anchorDate, rule.span.years);
    spanText = `${rule.span.years} 年`;
  } else {
    const days = rule.daysFromCaller ? Number(options.days) : rule.span.days;
    if (!Number.isInteger(days) || days <= 0) {
      throw new Error(`${rule.label} 的天数必须由调用方给出（通知书上指定的天数），收到：${options.days}`);
    }
    due = addDays(anchorDate, days - 1 + startOffset);
    spanText = `${days} 日`;
  }

  const startText = rule.countFrom === 'nextDay' ? '次日起算' : '当日起算';
  const rawDue = fmt(due);
  const rolled = rollForwardOffWeekend(due);
  const rolledText =
    rolled.getTime() === due.getTime() ? '' : `（原为 ${rawDue}，落在${WEEKDAY_CN[due.getUTCDay()]}，已顺延至下一工作日）`;

  return {
    dueDate: fmt(rolled),
    rule,
    derivedFrom:
      `${rule.label}：自 ${fmt(anchorDate)}（${startText}）起 ${spanText} → ${fmt(rolled)}${rolledText}。` +
      `依据：${rule.basis} ${options.generalRule ?? buildPeriodGeneralRule()}`,
    caveats: [...(rule.caveats ?? []), HOLIDAY_CAVEAT, MAIL_BEFORE_EXPIRY_CAVEAT],
  };
}

const WEEKDAY_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 末日落在周六/周日则顺延至下一个周一。法定节假日不在此列（无数据源，见 HOLIDAY_CAVEAT）。 */
function rollForwardOffWeekend(date: Date): Date {
  const day = date.getUTCDay();
  if (day === 6) return addDays(date, 2); // 周六 → 周一
  if (day === 0) return addDays(date, 1); // 周日 → 周一
  return date;
}

/** 可选的期限类型键，供工具 schema 与提示词使用 */
export const DEADLINE_RULE_KEYS = Object.keys(DEADLINE_RULES);
