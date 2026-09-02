/**
 * 首诊流程与证据库的 mock 素材：选项文案、诉求估算、证据清单建议。
 * 字段语义对齐 spec §7 的 cases / claims / timeline_events / evidence。
 * 接后端后估算逻辑由 lib/cases 计算器替换，页面组件签名不变。
 */

import type { SanbeiCap } from '@/lib/cap/sanbei';
import { sanbeiCapFacts, SANBEI_CAP_UNVERIFIED_CAVEAT, isSanbeiCapVerified } from '@/lib/cap/sanbei';
import {
  INTAKE_STAGE_ACTIONS,
  intakeActionDueAt,
  intakeActionPriority,
} from '@/lib/cases/intake-actions';
import type { ActionItem, CaseStage, EvidenceCategory, EvidenceItem } from './types';

/* ── 步骤 1：现在处于哪一步 ─────────────────────────────── */

export interface StageOption {
  value: CaseStage;
  /** 白话说明：一句话让人认出自己在哪 */
  plain: string;
}

export const INTAKE_STAGES: StageOption[] = [
  { value: '风声', plain: '还没找我谈，但部门在传要裁人，或者身边已经有人被约谈了。' },
  { value: '约谈中', plain: 'HR 或领导已经找我谈过，让我签字或者考虑方案，我还没签。' },
  { value: '已收通知', plain: '拿到了书面的解除通知、离职通知或者协商协议。' },
  { value: '已解除', plain: '已经办了离职交接、权限被收走，或者公司说劳动关系已经结束。' },
  { value: '仲裁准备', plain: '打算申请劳动仲裁，正在准备材料。' },
];

/* ── 步骤 2：基本情况 ───────────────────────────────────── */

export const CONTRACT_COUNTS = [
  '只签过一次',
  '续签过一次',
  '续签两次及以上',
  '已经是无固定期限',
  '没签过书面合同',
] as const;

export type ContractCount = (typeof CONTRACT_COUNTS)[number];

/* ── 步骤 4：公司给的说法与文件 ─────────────────────────── */

export const HAS_DOC_ANSWERS = ['有', '没有', '不确定'] as const;

export type HasDocAnswer = (typeof HAS_DOC_ANSWERS)[number];

export interface CompanyDocQuestion {
  key: 'terminationNotice' | 'settlementAgreement' | 'otherPaper';
  label: string;
  plain: string;
}

export const COMPANY_DOC_QUESTIONS: CompanyDocQuestion[] = [
  {
    key: 'terminationNotice',
    label: '《解除劳动合同通知书》',
    plain: '公司单方面通知你劳动合同结束的那张纸，上面通常写着理由和补偿标准。',
  },
  {
    key: 'settlementAgreement',
    label: '《协商解除协议》',
    plain: '要你签字同意"双方协商一致离职"的协议，签了之后再谈金额会很被动。',
  },
  {
    key: 'otherPaper',
    label: '调岗通知 / 绩效改进（PIP）/ 警告信',
    plain: '这类文件常常是解除前的铺垫，留着能说明公司在为解除做准备。',
  },
];

/* ── 步骤 5：你想要什么 ─────────────────────────────────── */

export interface GoalOption {
  value: string;
  plain: string;
  /** money 的会进金额表，other 的只列在诉求说明里 */
  kind: 'money' | 'other';
}

export const GOAL_OPTIONS: GoalOption[] = [
  { value: '违法解除赔偿金（2N）', kind: 'money', plain: '认为公司解除没有合法理由，要双倍的补偿。' },
  { value: '经济补偿（N 或 N+1）', kind: 'money', plain: '接受离职，但要拿到法定的补偿和代通知金。' },
  { value: '拖欠的工资', kind: 'money', plain: '最后一个月工资、提成或者被扣掉的部分还没发。' },
  { value: '加班费', kind: 'money', plain: '有加班但没给钱也没调休。' },
  { value: '未休年假折算', kind: 'money', plain: '今年的年假没休完，离职时应该折成钱。' },
  { value: '未签合同双倍工资', kind: 'money', plain: '入职超过一个月公司一直没签书面合同。' },
  { value: '继续履行劳动合同', kind: 'other', plain: '不想拿钱走人，要求回去继续上班。' },
  { value: '社保公积金补缴', kind: 'other', plain: '公司没缴、少缴，或者按最低基数缴。' },
  { value: '离职证明与退工手续', kind: 'other', plain: '需要拿到离职证明才能入职下一家。' },
];

/* ── 诉求金额估算（雏形，口径以后端计算器为准）───────────── */

export interface ClaimEstimateInput {
  stage: CaseStage | '';
  /** 入职日期 YYYY-MM-DD，空串表示还没填 */
  hiredOn: string;
  /** 月工资（元），NaN 表示还没填 */
  monthlyWageYuan: number;
  goals: string[];
  /**
   * 三倍社平封顶基数的当前读数，由服务端从知识卡取好传进来（见 lib/cap/sanbei）。
   * **null = 卡里没读到**：这时一分钱都不算，绝不落回任何写死的旧数字——
   * 封顶线决定赔偿上限，猜错的代价是给劳动者一个错误的期待值。
   */
  cap: SanbeiCap | null;
}

export interface ClaimEstimateRow {
  key: string;
  label: string;
  /** null = 现在还算不出来，需要补材料 */
  amountFen: number | null;
  note: string;
}

export interface ClaimEstimate {
  rows: ClaimEstimateRow[];
  /** 折算后的工作年限（半年一档） */
  serviceYears: number;
  /** 计算基数（元），已经过三倍社平封顶判定 */
  baseWageYuan: number;
  capped: boolean;
  capNote: string;
  /** 算不出金额时为 true，金额一律显示为待补 */
  incomplete: boolean;
  /** 算不出的原因：用户还没填全，还是封顶基数没取到。两者该说的话不一样 */
  incompleteReason: 'inputs' | 'cap' | null;
}

/** 经济补偿年限：满一年算一年，满半年不满一年算一年，不满半年算半年。 */
export function serviceYearsBetween(hiredOn: string, until: Date): number {
  const start = new Date(`${hiredOn}T00:00:00+08:00`);
  if (Number.isNaN(start.getTime())) return 0;
  const months = Math.max(
    0,
    (until.getFullYear() - start.getFullYear()) * 12 +
      (until.getMonth() - start.getMonth()) +
      (until.getDate() >= start.getDate() ? 0 : -1),
  );
  const fullYears = Math.floor(months / 12);
  const restMonths = months % 12;
  if (restMonths === 0) return fullYears;
  return restMonths >= 6 ? fullYears + 1 : fullYears + 0.5;
}

const MONEY_GOAL_NOTES: Record<string, string> = {
  '拖欠的工资': '把工资条和银行流水传到证据库后，按实际差额逐月列出来。',
  加班费: '需要考勤或打卡记录对上具体日期，仲裁时考勤由公司举证。',
  未休年假折算: '需要核对公司的年假制度和请假审批记录，确认剩几天。',
  未签合同双倍工资: '需要确认第一份书面合同的签署日期，最多主张 11 个月。',
};

export function estimateClaims(
  input: ClaimEstimateInput,
  now: Date = new Date(),
): ClaimEstimate {
  const wage = input.monthlyWageYuan;
  const cap = input.cap;
  // 缺输入与缺封顶基数都算不出钱，但要分开说：一个是「回去补两格」，一个是我们这边的问题。
  const missingInputs = !input.hiredOn || !Number.isFinite(wage) || wage <= 0;
  const incompleteReason: 'inputs' | 'cap' | null = missingInputs
    ? 'inputs'
    : cap === null
      ? 'cap'
      : null;
  const incomplete = incompleteReason !== null;
  const serviceYears = input.hiredOn ? serviceYearsBetween(input.hiredOn, now) : 0;
  const capped = !incomplete && cap !== null && wage > cap.yuan;
  const baseWageYuan = incomplete ? 0 : capped && cap !== null ? cap.yuan : wage;
  const cappedYears = capped ? Math.min(serviceYears, 12) : serviceYears;

  // 封顶线的三项事实（值 / 生效期间 / 可信度）走 lib/cap/sanbei 的统一口径，
  // 与对话里讲的是同一份；待核实的状态一路带到用户面前，不因为「有数」就当它坐实了。
  const capNote =
    cap === null
      ? '三倍社平封顶基数这次没从数据卡读到，所以金额先不算——这个数决定赔偿上限，读不到就不猜。' +
        '刷新一次通常就好；一直不行请告诉我们，这是我们这边的问题。'
      : `北京三倍社平封顶基数：${sanbeiCapFacts(cap)}。` +
        (isSanbeiCapVerified(cap) ? '' : `${SANBEI_CAP_UNVERIFIED_CAVEAT}。`) +
        (missingInputs
          ? '月工资超过它时按它计，且年限最多算 12 年。'
          : capped
            ? '你的月工资高于它，基数按封顶线计，年限最多算 12 年。'
            : '你的月工资未超过它，不封顶，年限也不受 12 年上限限制。');

  const yuanToFen = (yuan: number) => Math.round(yuan * 100);
  const moneyGoals = input.goals.filter((g) =>
    GOAL_OPTIONS.some((o) => o.value === g && o.kind === 'money'),
  );
  const wantsCompensation =
    moneyGoals.includes('违法解除赔偿金（2N）') || moneyGoals.includes('经济补偿（N 或 N+1）');

  const rows: ClaimEstimateRow[] = [];

  if (!wantsCompensation || moneyGoals.includes('违法解除赔偿金（2N）')) {
    rows.push({
      key: '2N',
      label: '违法解除赔偿金（2N）',
      amountFen: incomplete ? null : yuanToFen(2 * cappedYears * baseWageYuan),
      note: wantsCompensation
        ? `2 × ${cappedYears} 年 × ${baseWageYuan || '基数'} 元`
        : '你还没选诉求，这里先按最常见的违法解除赔偿金算一版给你看。',
    });
  }

  if (moneyGoals.includes('经济补偿（N 或 N+1）')) {
    rows.push({
      key: 'N+1',
      label: '经济补偿 + 代通知金（N+1）',
      amountFen: incomplete ? null : yuanToFen((cappedYears + 1) * baseWageYuan),
      note: `(${cappedYears} 年 + 1 个月) × ${baseWageYuan || '基数'} 元；代通知金只有公司没提前 30 天书面通知才有。`,
    });
  }

  for (const goal of moneyGoals) {
    const note = MONEY_GOAL_NOTES[goal];
    if (!note) continue;
    rows.push({ key: goal, label: goal, amountFen: null, note });
  }

  return { rows, serviceYears, baseWageYuan, capped, capNote, incomplete, incompleteReason };
}

/* ── 首诊结束后的下一步行动（按阶段给 3 条）───────────────── */

/** 档案预览里的「下一步做什么」，按阶段取 3 条。 */
export function previewActions(
  stage: CaseStage | '',
  caseId = 'demo',
  now: Date = new Date(),
): ActionItem[] {
  // 种子表在 lib/cases/intake-actions（服务端落库用的是同一份）。这里只做「种子 → 视图行」，
  // 不再自己存一份文案：屏幕上写着三件事、库里一件都没有，就是这么来的。
  const seeds = INTAKE_STAGE_ACTIONS[stage] ?? [];
  return seeds.map((seed, i) => ({
    id: `intake_action_${i + 1}`,
    caseId,
    title: seed.title,
    detail: seed.detail,
    dueAt: intakeActionDueAt(seed, now),
    // 与落库口径一致：种子顺序即轻重顺序，越靠前越急，而 action_items 按 priority **降序**取。
    priority: intakeActionPriority(seeds.length, i) as 1 | 2 | 3,
    status: '待办',
    sourceMessageId: null,
    createdAt: now.toISOString(),
  }));
}

/* ── 证据库 ─────────────────────────────────────────────── */

/** 分组与选择器的类别顺序，和 spec §7 evidence.category 枚举一致。 */
export const EVIDENCE_CATEGORIES: EvidenceCategory[] = [
  '合同',
  '工资',
  '社保',
  '考勤',
  '沟通记录',
  '公司文件',
  '录音',
  '其他',
];

export interface EvidenceChecklistItem {
  category: EvidenceCategory;
  name: string;
  /** 为什么重要——一句话，别写成法条 */
  why: string;
}

export const EVIDENCE_CHECKLIST: EvidenceChecklistItem[] = [
  {
    category: '合同',
    name: '劳动合同（含所有续签页）',
    why: '定下入职时间、岗位和约定工资，后面所有金额都从这里起算。',
  },
  {
    category: '工资',
    name: '近 12 个月银行工资流水',
    why: '"月工资"这个基数以实发为准，银行流水比工资条更难被否认。',
  },
  {
    category: '社保',
    name: '社保或公积金缴纳明细',
    why: '佐证劳动关系存续的时间段，也能看出公司是不是按最低基数缴的。',
  },
  {
    category: '考勤',
    name: '打卡或排班记录',
    why: '主张加班费的关键；公司拿不出考勤记录，不利后果由公司承担。',
  },
  {
    category: '沟通记录',
    name: '和 HR、领导的聊天与邮件',
    why: '公司主动提出解除、口头承诺过的补偿，往往只留在这里。',
  },
  {
    category: '公司文件',
    name: '解除通知、协商协议、调岗通知、PIP',
    why: '公司写下的解除理由，直接决定你能主张 N 还是 2N。',
  },
  {
    category: '录音',
    name: '约谈录音（原始文件）',
    why: '你参与的谈话可以录。保留原始文件，剪辑过的片段容易被质疑真实性。',
  },
];

const UPLOAD_SOURCE_LABEL = {
  photo: '拍照',
  file: '选文件',
  audio: '录音',
} as const;

export type UploadSource = keyof typeof UPLOAD_SOURCE_LABEL;

/**
 * 上传入口默认落在哪个类别，用户可以改。
 * photo 走「公司文件」而不是「沟通记录」：全站三处文案都把拍照绑在纸质原件上
 * （原始载体提示的「纸质件」、空态的「手边有纸质文件就拍照」、首诊的「把原件拍照传上去」），
 * 而聊天记录是截图、走「选文件」。归错类不是观感问题——它进的是仲裁证据目录。
 */
export const UPLOAD_DEFAULT_CATEGORY: Record<UploadSource, EvidenceCategory> = {
  photo: '公司文件',
  file: '公司文件',
  audio: '录音',
};

export const UPLOAD_DEFAULT_MEDIUM: Record<UploadSource, string> = {
  photo: '手机拍摄，原图仍在相册',
  file: '本机文件，原件本人保管',
  audio: '本人手机录音，原始文件未删除',
};

function mockSha256(seed: string): string {
  let h = 0x811c9dc5;
  const out: string[] = [];
  for (let i = 0; i < 64; i += 1) {
    h ^= seed.charCodeAt(i % seed.length) + i;
    h = Math.imul(h, 0x01000193) >>> 0;
    out.push(((h >>> 24) & 0xf).toString(16));
  }
  return out.join('');
}

/** mock 上传：真实上传接后端时替换为 files 表返回。 */
export function mockUploadEvidence(params: {
  caseId: string;
  name: string;
  sizeBytes: number;
  category: EvidenceCategory;
  provePurpose: string;
  originalMedium: string;
  now?: Date;
}): EvidenceItem {
  const now = params.now ?? new Date();
  const id = `ev_local_${now.getTime()}`;
  return {
    id,
    caseId: params.caseId,
    fileId: `f_local_${now.getTime()}`,
    name: params.name,
    category: params.category,
    provePurpose: params.provePurpose,
    originalMedium: params.originalMedium,
    status: '已上传',
    sizeBytes: params.sizeBytes,
    sha256: mockSha256(`${id}:${params.name}:${params.sizeBytes}`),
    createdAt: now.toISOString(),
  };
}

/** mock 出证：真实流程是 TSA 固化后生成存证订单号。 */
export function mockAttestationNo(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const serial = String(now.getTime() % 1_000_000).padStart(6, '0');
  return `AT-${y}-${m}${d}-${serial}`;
}
