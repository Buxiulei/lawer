// app/src/lib/cases/intake.ts
// 首诊提交：把六步问下来的内容写进**用户自己的那个案件**。
//
// 【为什么有这个文件】此前首诊六步全程只写浏览器 localStorage，最后一步的按钮
// 直接 `router.push('/case/demo')`：用户填完公司名、入职日期、月工资、时间线、诉求、底线，
// 服务器上**一个字都没有**，人还被送进了演示案件，屏幕上却弹「档案已建好」。
// 这是产品对第一次来的人的零交付点——他交出了最难说出口的那些事，我们一条没接住。
//
// 【存输入不存结论】N / 2N / N+1 的**金额不落库**，落的是算它们要用的输入
// （入职日期、月工资、阶段、诉求）。理由：封顶基数与年限口径会随知识卡更新，
// 存下来的结论第二天就可能与现算的对不上，而用户看不出哪个是新的。结论一律现算。
//
// 【期限只在有真起算点时才落】仲裁时效错一天就是权利灭失。首诊拿不到「知道权利被侵害之日」
// 时**不落这条期限**，绝不拿「今天」当锚点——那会把到期日算得比真实的晚，
// 等于告诉用户他还有时间。宁可没有，不可晚。
import type { Database } from 'better-sqlite3';

import { computeDeadline } from '@/lib/deadline';
import { insertActionItem, insertDeadline, upsertCompanyProfileByRole } from '@/lib/db/agent';
import * as store from '@/lib/db/cases';
import { nowSql } from '@/lib/db/time';
import { INTAKE_STAGE_ACTIONS, intakeActionDueAt, intakeActionPriority } from './intake-actions';
import { CASE_STAGES, type CaseStage } from './stages';

/** 首诊里公司给过哪些文件的三问，键与前端 draft 同名 */
export interface IntakeCompanyDocs {
  terminationNotice?: unknown;
  settlementAgreement?: unknown;
  otherPaper?: unknown;
}

export interface IntakeEventInput {
  /** 'YYYY-MM-DD'，可以留空——记不清日期不该挡住记录 */
  date?: unknown;
  text?: unknown;
}

export interface IntakeInput {
  caseId: number;
  userId: number;
  stage: unknown;
  companyName: unknown;
  employedFrom: unknown;
  monthlyWageFen: unknown;
  position?: unknown;
  contractCount?: unknown;
  events?: unknown;
  freeText?: unknown;
  companyDocs?: IntakeCompanyDocs;
  companyWording?: unknown;
  goals?: unknown;
  bottomLine?: unknown;
  /** 落库时刻，测试可注入 */
  now?: Date;
}

export interface IntakeResult {
  caseId: number;
  /** 本次新写入的时间线事件数 */
  timelineAdded: number;
  /** 本次新写入的行动卡数（同名的已存在则不重复写） */
  actionsAdded: number;
  /** 本次新写入的法定期限数（拿不到真起算点时为 0） */
  deadlinesAdded: number;
}

/** 公司给过哪些文件，三问一行记清楚。顺序与前端问的顺序一致。 */
const COMPANY_DOC_LABELS: { key: keyof IntakeCompanyDocs; label: string }[] = [
  { key: 'terminationNotice', label: '《解除劳动合同通知书》' },
  { key: 'settlementAgreement', label: '《协商解除协议》' },
  { key: 'otherPaper', label: '调岗通知 / 绩效改进（PIP）/ 警告信' },
];

/**
 * 这几个阶段说明劳动关系已经出事、时效多半已经在走，才谈得上落仲裁时效。
 * 「风声」「约谈中」还没有可指认的侵害日，落了就是编。
 */
const STAGES_WITH_RUNNING_LIMITATION: readonly string[] = ['已收通知', '已解除', '仲裁准备'];

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function trimmed(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** 'YYYY-MM-DD' 且是真实存在的一天；否则 null。不接受带时间的串——首诊填的就是日期。 */
export function normalizeDateOnly(value: unknown): string | null {
  if (typeof value !== 'string' || !DATE_ONLY.test(value.trim())) return null;
  const raw = value.trim();
  const [y, m, d] = raw.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() !== m - 1 ||
    date.getUTCDate() !== d
  ) {
    return null;
  }
  return raw;
}

/**
 * 只填了日期的事件落在**北京当天中午**，不是零点。
 *
 * 【为什么是中午】happened_at 经 SQLite `datetime()` 归一成 UTC 串。北京零点 = 前一天
 * UTC 16:00，库里那行的日期部分就变成了**前一天**；而展示侧读到的是不带时区标记的
 * canonical 串（`YYYY-MM-DD HH:MM:SS`），不同环境按本地时区解析，日子还会再挪一次。
 * 取中午后，UTC 值是当天 04:00，前后各差 12 小时都不跨日——用户填 8 月 28 日，
 * 库里、SSR、浏览器读到的都是 8 月 28 日。
 * 用户没填时刻，取当天哪一刻本来就是我们定的，那就取一个不会把日子弄错的时刻。
 */
function dayNoonIso(dateOnly: string): string {
  return new Date(`${dateOnly}T12:00:00+08:00`).toISOString();
}

export interface IntakeFailure {
  ok: false;
  status: number;
  errorCode: string;
  message: string;
}

function fail(errorCode: string, message: string): IntakeFailure {
  return { ok: false, status: 400, errorCode, message };
}

/**
 * 校验首诊必填项。**服务端是权威**：前端的逐步校验只是别让人白填一场，
 * 它可以被绕过（改 localStorage、直接打接口），而这几项一旦落成空值，
 * 后面的金额与年限就会拿着空值往下算。
 */
export function validateIntake(
  input: Pick<IntakeInput, 'stage' | 'companyName' | 'employedFrom' | 'monthlyWageFen' | 'goals'>,
  today: string,
): { ok: true; value: { stage: CaseStage; companyName: string; employedFrom: string; monthlyWageFen: number; goals: string[] } } | IntakeFailure {
  if (typeof input.stage !== 'string' || !(CASE_STAGES as readonly string[]).includes(input.stage)) {
    return fail('INVALID_STAGE', `stage 只能是 ${CASE_STAGES.join(' / ')}`);
  }
  const companyName = trimmed(input.companyName);
  if (!companyName) {
    return fail('INVALID_COMPANY_NAME', '公司名称不能为空：它就是仲裁里的被申请人');
  }
  const employedFrom = normalizeDateOnly(input.employedFrom);
  if (!employedFrom) {
    return fail('INVALID_EMPLOYED_FROM', '入职时间要填成 YYYY-MM-DD 的真实日期，它是工龄年限的起点');
  }
  if (employedFrom > today) {
    return fail('INVALID_EMPLOYED_FROM', '入职时间不能晚于今天');
  }
  const wage = input.monthlyWageFen;
  if (typeof wage !== 'number' || !Number.isInteger(wage) || wage <= 0) {
    return fail('INVALID_MONTHLY_WAGE', '月工资要填一个大于 0 的数字（单位：分），它是所有金额的基数');
  }
  const goals = Array.isArray(input.goals)
    ? input.goals.map((g) => trimmed(g)).filter((g): g is string => g !== null)
    : [];
  if (goals.length === 0) {
    return fail('INVALID_GOALS', '至少要选一项诉求：不写清要什么，谈判时容易被牵着走');
  }
  return { ok: true, value: { stage: input.stage as CaseStage, companyName, employedFrom, monthlyWageFen: wage, goals } };
}

/**
 * 落库。归属校验由调用方（lib/cases 的 submitIntake）先做，本函数只管写。
 * 全程一个事务：写了一半的档案比没写更糟——用户看到时间线有、诉求没有，会以为自己漏填了。
 */
function persist(
  db: Database,
  caseId: number,
  value: { stage: CaseStage; companyName: string; employedFrom: string; monthlyWageFen: number; goals: string[] },
  input: IntakeInput,
  now: Date,
): IntakeResult {
  const nowIso = now.toISOString();

  // ── 事件：用户自己记的那几条 + 整段自述 + 公司说法 + 公司给过哪些文件 ──
  const rawEvents = Array.isArray(input.events) ? (input.events as IntakeEventInput[]) : [];
  const events: { happenedAt: string; kind: string; title: string; detail: string | null }[] = [];
  const datedDays: string[] = [];
  for (const e of rawEvents) {
    const text = trimmed(e?.text);
    if (!text) continue;
    const day = normalizeDateOnly(e?.date);
    if (day) datedDays.push(day);
    events.push({
      happenedAt: day ? dayNoonIso(day) : nowIso,
      // 首诊这一步问的是「公司那边发生了什么」（例子全是开会宣布、HR 约谈、收到通知），
      // 所以默认记成公司动作。用户后续在时间线里补的事件才逐条自选类别。
      kind: '公司动作',
      title: text.slice(0, 80),
      detail: text.length > 80 ? text : null,
    });
  }

  const freeText = trimmed(input.freeText);
  if (freeText) {
    // 「把经过写下来」是用户自己做的一件事，正文进 detail，不硬塞进标题里
    events.push({ happenedAt: nowIso, kind: '我方动作', title: '我把经过整段记了下来', detail: freeText });
  }

  const companyWording = trimmed(input.companyWording);
  if (companyWording) {
    events.push({ happenedAt: nowIso, kind: '公司动作', title: '公司口头给的说法', detail: companyWording });
  }

  const docLine = COMPANY_DOC_LABELS.map(({ key, label }) => {
    const answer = trimmed(input.companyDocs?.[key]);
    return answer ? `${label}：${answer}` : null;
  })
    .filter((x): x is string => x !== null)
    .join('；');
  if (docLine) {
    events.push({ happenedAt: nowIso, kind: '公司动作', title: '公司已经给过哪些文件', detail: docLine });
  }

  // ── 三件事：种子表与首诊第 6 步画的是同一份 ──
  const seeds = INTAKE_STAGE_ACTIONS[value.stage] ?? [];

  // ── 仲裁时效：只有拿得到真起算点才落 ──
  const anchor = datedDays.length > 0 ? datedDays.slice().sort()[0] : null;
  const limitation =
    anchor !== null && STAGES_WITH_RUNNING_LIMITATION.includes(value.stage)
      ? computeDeadline('仲裁时效', anchor)
      : null;

  const write = db.transaction((): IntakeResult => {
    // 【只改不删】下面三个字段用条件展开：这一次没填就**不写这个键**，库里原来的值原样留着。
    // 所以「上次填了底线、这次清空重提」不会把底线清掉——这是刻意的，不是漏了 else 分支。
    // 留着旧值最坏是过时，用户看得见也改得回；而替他删掉上一次亲手写下的底线是不可撤销的。
    // 真要清空得有一个明确的「删掉这条」动作，不能靠一个空输入框顺手完成。
    store.updateCaseFields(db, caseId, {
      stage: value.stage,
      goal: value.goals.join('、'),
      employed_from: value.employedFrom,
      monthly_wage_fen: value.monthlyWageFen,
      ...(trimmed(input.bottomLine) === null ? {} : { bottom_line: trimmed(input.bottomLine)! }),
      ...(trimmed(input.position) === null ? {} : { position: trimmed(input.position)! }),
      ...(trimmed(input.contractCount) === null ? {} : { contract_count: trimmed(input.contractCount)! }),
    });

    // 公司名就是仲裁申请书上的被申请人。按 (case_id, role='签约主体') 收敛，**不是**按 name：
    // 首诊这一格问的是「被申请人是谁」，用户把全角括号改成半角再提交，是订正同一个答案，
    // 不是又来了一家公司。按 name 收敛会留下改名前那一行，而 pickRespondent 同档取 id 最早的
    // 一条，正好取到用户刚改掉的错名——仲裁申请书上的被申请人就此写错（lib/db/agent.ts 详述）。
    // 同上只改不删：本案其它角色的公司行（用工主体 / 关联，多是背调查出来的）一律不碰。
    upsertCompanyProfileByRole(db, {
      caseId,
      name: value.companyName,
      uscc: null,
      role: '签约主体',
      legalRep: null,
      riskNotes: null,
      sourcesJson: JSON.stringify([{ source: '用户首诊自述', at: nowSql() }]),
    });

    let timelineAdded = 0;
    for (const e of events) {
      store.insertTimelineEvent(db, { caseId, ...e });
      timelineAdded += 1;
    }

    // 重复提交首诊时不再长出一份一模一样的待办：标题相同即认为是同一件事。
    // 时间线相反——它只追加，改口径靠补一条新事件（spec §7）。
    const existingTitles = new Set(store.listActionItems(db, caseId, null).map((a) => a.title));
    let actionsAdded = 0;
    seeds.forEach((seed, i) => {
      if (existingTitles.has(seed.title)) return;
      insertActionItem(db, {
        caseId,
        title: seed.title,
        detail: seed.detail,
        dueAt: intakeActionDueAt(seed, now),
        priority: intakeActionPriority(seeds.length, i),
        sourceMessageId: null,
      });
      actionsAdded += 1;
    });

    let deadlinesAdded = 0;
    if (limitation) {
      const created = insertDeadline(db, {
        caseId,
        kind: limitation.rule.storedKind,
        dueDate: limitation.dueDate,
        derivedFrom:
          `${limitation.derivedFrom} ` +
          `【起算点暂按你在首诊里记下的最早一件事（${anchor}）取，这是**偏早的保守估计**：` +
          `真正的起算日是你知道权利被侵害那天（通常是收到解除通知或办完离职那天）。` +
          `确认后到期限页改成那天，日子会往后挪。】`,
      });
      deadlinesAdded = created.created ? 1 : 0;
    }

    return { caseId, timelineAdded, actionsAdded, deadlinesAdded };
  });

  return write();
}

/**
 * 首诊提交的对外入口。归属校验在 lib/cases/index.ts 那层做完再调这里。
 */
export function submitIntakeInto(db: Database, caseId: number, input: IntakeInput): { ok: true; result: IntakeResult } | IntakeFailure {
  const now = input.now ?? new Date();
  const checked = validateIntake(input, now.toISOString().slice(0, 10));
  if (!checked.ok) return checked;
  return { ok: true, result: persist(db, caseId, checked.value, input, now) };
}
