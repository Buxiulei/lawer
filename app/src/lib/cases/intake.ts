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
// 【期限只在有真起算点时才落】法定时效错一天就是权利灭失。首诊拿不到「知道权利被侵害之日」
// 时**不落这条期限**，绝不拿「今天」当锚点——那会把到期日算得比真实的晚，
// 等于告诉用户他还有时间。宁可没有，不可晚。落哪一类、哪几个阶段才落、附什么说明，
// 全在领域包的 intakeLimitation 里（本层不认识任何具体领域）。
import type { Database } from 'better-sqlite3';

import { computeDeadline } from '@/lib/deadline';
import type { DomainPack, IntakeFieldSpec } from '@/lib/domains/registry';
import { insertActionItem, insertDeadline, upsertCompanyProfileByRole } from '@/lib/db/agent';
import * as store from '@/lib/db/cases';
import { nowSql } from '@/lib/db/time';
import { INTAKE_STAGE_ACTIONS, intakeActionDueAt, intakeActionPriority } from './intake-actions';
import { INTAKE_BODY_PARAMS } from './intake-params';
import type { CaseStage } from './stages';

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

/**
 * 请求体 → 首诊入参。**REST 那条路上「body 上叫什么」只写在这一处**
 * （对照表在 ./intake-params.ts，页面拼请求体走同一份）。
 *
 * 【为什么从路由里收上来】原先路由里是一段手抄清单，形态是：领域包的 intakeSchema
 * 多一个字段、页面老实填进请求体、**路由不读它也不报错**——那一格一路消失，回包还是 201。
 * 收成一处之后，判据能对着这份表核对「每个领域包的每个首诊字段都有人接」。
 *
 * `company_docs` 缺省成空对象是原样保留的既有行为：那一问整段没答与答了空，
 * 在落库那侧走的是同一条路（拼不出 docLine 就不落那条事件）。
 */
export function intakeInputFromBody(
  body: Record<string, unknown>,
): Omit<IntakeInput, 'caseId' | 'userId'> {
  const out: Record<string, unknown> = {};
  for (const [param, key] of Object.entries(INTAKE_BODY_PARAMS)) out[key] = body[param];
  out.companyDocs = (body.company_docs ?? {}) as Record<string, unknown>;
  return out as Omit<IntakeInput, 'caseId' | 'userId'>;
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

/**
 * 「对方给过哪些文件」那一问的子问清单，从领域包取（intakeSchema 里 kind==='record' 的那项）。
 * 顺序与前端问的顺序一致，也是落库那条事件里的拼接顺序。
 */
function docFieldsOf(pack: DomainPack, key: string): readonly { key: string; label: string }[] {
  return pack.intakeSchema.find((f) => f.key === key)?.fields ?? [];
}

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

/** 校验一个首诊字段：过了回归一后的值，没过回该字段那条自述错误。 */
function checkField(
  spec: IntakeFieldSpec,
  raw: unknown,
  today: string,
): { ok: true; value: unknown } | IntakeFailure {
  const bad = (message: string) => fail(spec.errorCode!, message);
  const message = (spec.invalidMessage ?? '').replace(
    '{values}',
    (spec.values ?? []).join(' / '),
  );

  switch (spec.kind) {
    case 'enum':
      return typeof raw === 'string' && (spec.values ?? []).includes(raw)
        ? { ok: true, value: raw }
        : bad(message);
    case 'text': {
      const v = trimmed(raw);
      return v ? { ok: true, value: v } : bad(message);
    }
    case 'date': {
      const v = normalizeDateOnly(raw);
      if (!v) return bad(message);
      // 晚于今天的日子格式完全合法，错的是它指向将来——所以另说一句话，
      // 回同一句「格式要写成 YYYY-MM-DD」的形态是：用户照着改格式，改完还是被拒。
      if (v > today) return bad(spec.futureMessage ?? message);
      return { ok: true, value: v };
    }
    case 'money':
      return typeof raw === 'number' && Number.isInteger(raw) && raw > 0
        ? { ok: true, value: raw }
        : bad(message);
    case 'stringList': {
      const list = Array.isArray(raw)
        ? raw.map((g) => trimmed(g)).filter((g): g is string => g !== null)
        : [];
      return list.length > 0 ? { ok: true, value: list } : bad(message);
    }
    default:
      // eventList / record 这些没有必填校验（errorCode 不在场时根本走不到这里）
      return { ok: true, value: raw };
  }
}

/**
 * 校验首诊必填项。**服务端是权威**：前端的逐步校验只是别让人白填一场，
 * 它可以被绕过（改 localStorage、直接打接口），而这几项一旦落成空值，
 * 后面的金额与年限就会拿着空值往下算。
 *
 * 【校验哪几项、说哪句话，全由领域包的 intakeSchema 决定】本层不认识任何具体领域：
 * 写死一份必填清单的形态是——第二个领域接进来时，它的用户被要求填一批本领域没有的字段，
 * 而每一条错误信息读起来都很正常。
 *
 * 顺序即 intakeSchema 的顺序：同时填错两项时先报哪一条由领域包定，不由这里定。
 */
export function validateIntake(
  input: Pick<IntakeInput, 'stage' | 'companyName' | 'employedFrom' | 'monthlyWageFen' | 'goals'>,
  today: string,
  /** 案件所属领域的包（由 lib/cases/index.ts 的 packForCase 取），本层不写死词表 */
  pack: DomainPack,
): { ok: true; value: { stage: CaseStage; companyName: string; employedFrom: string; monthlyWageFen: number; goals: string[] } } | IntakeFailure {
  const raw = input as unknown as Record<string, unknown>;
  const value: Record<string, unknown> = {};
  for (const spec of pack.intakeSchema) {
    // errorCode 不在场 = 这个字段不做必填校验（见 IntakeFieldSpec 头注释）
    if (!spec.errorCode) continue;
    const checked = checkField(spec, raw[spec.key], today);
    if (!checked.ok) return checked;
    value[spec.key] = checked.value;
  }
  return {
    ok: true,
    value: value as unknown as {
      stage: CaseStage;
      companyName: string;
      employedFrom: string;
      monthlyWageFen: number;
      goals: string[];
    },
  };
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
  pack: DomainPack,
): IntakeResult {
  const nowIso = now.toISOString();
  const copy = pack.copy.site;

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
    events.push({ happenedAt: nowIso, kind: '我方动作', title: copy.intakeFreeTextTitle, detail: freeText });
  }

  const companyWording = trimmed(input.companyWording);
  if (companyWording) {
    events.push({
      happenedAt: nowIso,
      kind: '公司动作',
      title: copy.intakeCounterpartWordingTitle,
      detail: companyWording,
    });
  }

  const docs = (input.companyDocs ?? {}) as Record<string, unknown>;
  const docLine = docFieldsOf(pack, 'companyDocs')
    .map(({ key, label }) => {
      const answer = trimmed(docs[key]);
      return answer ? `${label}：${answer}` : null;
    })
    .filter((x): x is string => x !== null)
    .join('；');
  if (docLine) {
    events.push({
      happenedAt: nowIso,
      kind: '公司动作',
      title: copy.intakeCounterpartDocsTitle,
      detail: docLine,
    });
  }

  // ── 三件事：种子表与首诊第 6 步画的是同一份 ──
  const seeds = INTAKE_STAGE_ACTIONS[value.stage] ?? [];

  // ── 法定期限：只有拿得到真起算点、且本领域声明了要落，才落 ──
  const anchor = datedDays.length > 0 ? datedDays.slice().sort()[0] : null;
  const lim = pack.intakeLimitation;
  const limitation =
    lim && anchor !== null && lim.stages.includes(value.stage)
      ? computeDeadline(lim.kind, anchor)
      : null;

  // 【选填的日期与金额也要落库】validateIntake 只归一化**带 errorCode 的那几项**
  // （必填校验那一批），选填的一格都不碰。而 employed_from / monthly_wage_fen 是 cases 上的
  // 固定列，persist 从 value 里取——一个把这两格声明成选填的领域包，它的用户老老实实填了、
  // 页面老老实实发了、服务端老老实实收了、回包 201，而这两格在库里恒为 NULL。
  // 后果不是"少一格"：这两个值正是时效起算与退费基数的输入。
  // 【为什么写在这里而不是把它们改成必填】必填与否是**领域包的产品判断**，
  // 不是落库层的判断；落库层该做的是"包声明要问的、用户填了的，就得存下来"。
  // 【填了但格式不对的那一格】选填字段没有 errorCode，说不出话来，只能不写这个键
  //（与下面「只改不删」同一条口径）。这条缺口记在本票的 openQuestions 里。
  const employedFrom = value.employedFrom ?? normalizeDateOnly(input.employedFrom) ?? undefined;
  const wageRaw = input.monthlyWageFen;
  const monthlyWageFen =
    value.monthlyWageFen ??
    (typeof wageRaw === 'number' && Number.isInteger(wageRaw) && wageRaw > 0 ? wageRaw : undefined);

  const write = db.transaction((): IntakeResult => {
    // 【只改不删】下面几个字段用条件展开：这一次没填就**不写这个键**，库里原来的值原样留着。
    // 所以「上次填了底线、这次清空重提」不会把底线清掉——这是刻意的，不是漏了 else 分支。
    // 留着旧值最坏是过时，用户看得见也改得回；而替他删掉上一次亲手写下的底线是不可撤销的。
    // 真要清空得有一个明确的「删掉这条」动作，不能靠一个空输入框顺手完成。
    store.updateCaseFields(db, caseId, {
      stage: value.stage,
      goal: value.goals.join('、'),
      ...(employedFrom === undefined ? {} : { employed_from: employedFrom }),
      ...(monthlyWageFen === undefined ? {} : { monthly_wage_fen: monthlyWageFen }),
      ...(trimmed(input.bottomLine) === null ? {} : { bottom_line: trimmed(input.bottomLine)! }),
      ...(trimmed(input.position) === null ? {} : { position: trimmed(input.position)! }),
      ...(trimmed(input.contractCount) === null ? {} : { contract_count: trimmed(input.contractCount)! }),
    });

    // 首诊填的这个名字就是日后立案时列在对面的那一方。按 (case_id, role='签约主体') 收敛，
    // **不是**按 name：这一格问的是「对面是谁」，用户把全角括号改成半角再提交，是订正同一个答案，
    // 不是又来了一家。按 name 收敛会留下改名前那一行，而 pickRespondent 同档取 id 最早的
    // 一条，正好取到用户刚改掉的错名——对方主体就此写错（lib/db/agent.ts 详述）。
    // 同上只改不删：本案其它角色的公司行（用工主体 / 关联，多是背调查出来的）一律不碰。
    upsertCompanyProfileByRole(db, {
      caseId,
      name: value.companyName,
      uscc: null,
      role: '签约主体',
      legalRep: null,
      riskNotes: null,
      sourcesJson: JSON.stringify([{ source: copy.intakeCompanySource, at: nowSql() }]),
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
        derivedFrom: `${limitation.derivedFrom} ${lim!.note.replace('{anchor}', anchor!)}`,
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
export function submitIntakeInto(
  db: Database,
  caseId: number,
  input: IntakeInput,
  /** 这个案子的领域包。由调用方按 cases.domain 取，本层不认识任何具体领域 */
  pack: DomainPack,
): { ok: true; result: IntakeResult } | IntakeFailure {
  const now = input.now ?? new Date();
  const checked = validateIntake(input, now.toISOString().slice(0, 10), pack);
  if (!checked.ok) return checked;
  return { ok: true, result: persist(db, caseId, checked.value, input, now, pack) };
}
