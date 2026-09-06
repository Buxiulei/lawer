// app/src/app/__tests__/domain-journey.test.tsx
// 机构负责人试用路径（设计稿 §16 分期 W4）：第二个领域的案件从**建案 → 首诊 → 事实卡**
// 走一遍，走的是页面真正会走的那几段代码（真路由 + 真库 + 真领域包），不点浏览器。
//
// ─────────────── 这一条盯的是什么 ───────────────
// 各段单独都有判据（领域选择、schema 排步、intake 落库、事实卡分节各自成条），
// **而它们全绿的同时这条路仍然可以是断的**：领域在注册那一步选了、案件却落成缺省领域；
// 案件领域对了、首诊页仍按缺省领域那六步问；首诊落库了、事实卡的抬头还在讲另一个行当。
// 三种断法都返回 200、页面都能用、一处报错都没有。所以要有一条从头走到尾的。
//
// 【为什么用真库真路由，而不是各段 mock 起来对拼】mock 出来的那条路证明的是
// "我以为的接口形状是自洽的"，而上面三种断法恰恰都发生在接口形状**自洽但两边理解不同**时。
//
// 【为什么按注册表里的每一个包各跑一遍，而不是只跑第二个包】只跑第二个的形态是：
// 第三个领域接进来时这条判据对它恒真——它证明的是"counseling 这一个能走通"，
// 不是"任何一个包都能走通"。逐包跑之后，新包漏了 copy.site 某个键、
// intakeSchema 少了必填项的错误码，在它挂进注册表的那一刻就红。
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { renderToStaticMarkup } from 'react-dom/server';
import type { Database } from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DomainChoice } from '@/app/_ui/DomainChoice';
import { schemaSteps, hasHandwrittenFlow } from '@/app/(app)/intake/_components/IntakeFlow';
import { EMPTY_DRAFT, type IntakeDraft } from '@/app/(app)/intake/_components/draft';
import { emptyValue, type FieldValue } from '@/app/(app)/intake/_components/schemaFlow';
import { toIntakePayload } from '@/app/(app)/intake/_components/submit';
import { buildCaseFacts, renderCaseFacts } from '@/lib/agent/case-facts';
import { loadCaseSnapshot } from '@/lib/agent/snapshot';
import * as otp from '@/lib/auth/otp';
import * as otpStore from '@/lib/db/otp';
import {
  DOMAINS,
  DOMAINS_ENABLED_ENV,
  type DomainPack,
  type IntakeFieldSpec,
} from '@/lib/domains/registry';

let db: Database;
let registerVerify: (req: Request) => Promise<Response>;
let listDomainsRoute: () => Promise<Response>;
let listCases: (req: Request) => Promise<Response>;
let postIntake: (
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) => Promise<Response>;
let dbFile: string;

/** 一封「验证码已发出」——真发信在这条路上与领域无关，注入一个不出网的 sender。 */
const MAILER = { sendEmail: async () => {}, sendSms: async () => {} };

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';
  dbFile = path.join(os.tmpdir(), `lawer-journey-${crypto.randomUUID()}.db`);
  process.env.DB_PATH = dbFile;
  // 灰度全开：这条路要走的正是"开了第二个领域之后"的那条。
  process.env[DOMAINS_ENABLED_ENV] = Object.keys(DOMAINS).join(',');

  registerVerify = (await import('../api/v1/auth/email/register/verify/route')).POST;
  listDomainsRoute = (await import('../api/v1/domains/route')).GET;
  listCases = (await import('../api/v1/cases/route')).GET;
  postIntake = (await import('../api/v1/cases/[id]/intake/route')).POST;
  db = (await import('@/lib/db/client')).getDb();
});

afterAll(() => {
  delete process.env[DOMAINS_ENABLED_ENV];
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(dbFile + suffix);
    } catch {
      // 临时库删不掉不影响判据
    }
  }
});

const ssr = (node: React.ReactNode) => renderToStaticMarkup(<>{node}</>);
const json = async (res: Response) => (await res.json()) as Record<string, unknown>;

/** 这一格填成什么样。**照 kind 造合法值**，值本身取自领域包（不在判据里编领域内容）。 */
function answerFor(field: IntakeFieldSpec): FieldValue {
  switch (field.kind) {
    case 'enum':
      // 取词表里的**第二个**（有的话）：取第一个的形态是，与"没填时的缺省"撞在一起分不开
      return (field.values ?? [])[1] ?? (field.values ?? [])[0] ?? '';
    case 'date':
      return '2025-03-04';
    case 'money':
      return '800';
    case 'text':
      return `这一格填了字（${field.key}）`;
    case 'stringList':
      return [`第一项诉求（${field.key}）`];
    case 'eventList':
      return [{ id: 'e1', date: '2026-01-09', text: `发生过一件事（${field.key}）` }];
    case 'record':
      return Object.fromEntries((field.fields ?? []).map((f) => [f.key, `有（${f.key}）`]));
  }
}

/** 一份填满的首诊草稿（schema 那条路）。 */
function filledDraft(pack: DomainPack): IntakeDraft {
  const fields: Record<string, FieldValue> = {};
  for (const f of pack.intakeSchema) fields[f.key] = answerFor(f);
  return { ...EMPTY_DRAFT, domain: pack.key, fields };
}

/** 走完整的「发注册码 → 验注册码（带 domain）」，回 token 与 case_id。 */
async function registerWithDomain(
  email: string,
  domain: string | undefined,
): Promise<{ token: string; caseId: number }> {
  const sent = await otp.sendEmailRegisterCode(db, { email, ip: '203.0.113.9' }, MAILER);
  expect(sent.ok, '前置失败：注册码没发出去').toBe(true);
  const code = (
    db
      .prepare('SELECT code FROM email_codes WHERE email = ? AND purpose = ? ORDER BY id DESC LIMIT 1')
      .get(email, otpStore.EMAIL_PURPOSE.register) as { code: string }
  ).code;

  const res = await registerVerify(
    new Request('http://localhost/api/v1/auth/email/register/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, code, ...(domain ? { domain } : {}) }),
    }),
  );
  const body = await json(res);
  expect(res.status, `建号失败：${JSON.stringify(body)}`).toBe(200);
  const onboarding = body.onboarding as { case_id: number } | undefined;
  expect(onboarding, '建号没有顺带建案：后面每一步都没有落点').toBeTruthy();
  return { token: body.token as string, caseId: onboarding!.case_id };
}

const authed = (url: string, token: string, init: RequestInit = {}) =>
  new Request(url, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });

/* ── 第一步：建案那一屏问「这件事属于哪一类」 ───────────────────── */

describe('建案：注册那一步的领域选择', () => {
  it('/api/v1/domains 回的是注册表里开着的那几个包，label 逐字取自包（变异：把 label 改成自己编的一句 → 红）', async () => {
    const body = await json(await listDomainsRoute());
    const domains = body.domains as { key: string; label: string }[];
    expect(domains.map((d) => d.key)).toEqual(Object.keys(DOMAINS));
    for (const d of domains) expect(d.label).toBe(DOMAINS[d.key].label);
    expect(domains.length, '注册表里只有一个包，下面几条对"多领域"恒真').toBeGreaterThan(1);
  });

  it('控件把每个包的 label 逐字摆出来，值是 key（选错一个字就落错领域）', async () => {
    const body = await json(await listDomainsRoute());
    const domains = body.domains as { key: string; label: string }[];
    const html = ssr(<DomainChoice domains={domains} value="" onChange={() => {}} />);
    for (const d of domains) {
      expect(html, `选项里没有「${d.label}」`).toContain(d.label);
      expect(html, `选项的值不是 ${d.key}`).toContain(`value="${d.key}"`);
    }
  });

  it.each(Object.keys(DOMAINS))(
    '选了「%s」→ 案件真的落这个领域，标题与欢迎事件是这个包的话（变异：把 domain 从注册路由摘掉 → 红）',
    async (key) => {
      const { caseId } = await registerWithDomain(`journey-${key}@example.com`, key);
      const row = db.prepare('SELECT domain, title FROM cases WHERE id = ?').get(caseId) as {
        domain: string;
        title: string;
      };
      const copy = DOMAINS[key].copy.site;
      expect(row.domain).toBe(key);
      expect(row.title).toBe(copy.defaultCaseTitle);
      const welcome = db
        .prepare('SELECT title, detail FROM timeline_events WHERE case_id = ? ORDER BY id LIMIT 1')
        .get(caseId) as { title: string; detail: string };
      expect(welcome.title).toBe(copy.welcomeEventTitle);
      expect(welcome.detail).toBe(copy.welcomeEventDetail);
    },
  );
});

/* ── 第二步 + 第三步：首诊按这个领域问、落库，事实卡按这个领域说话 ── */

describe.each(Object.keys(DOMAINS))('%s：首诊 → 事实卡走得通', (key) => {
  const pack = DOMAINS[key];

  it('首诊页从「名下案件」拿到的领域就是建案时选的那个（页面按它选 schema）', async () => {
    const { token, caseId } = await registerWithDomain(`intake-${key}@example.com`, key);
    const body = await json(await listCases(authed('http://localhost/api/v1/cases', token)));
    const mine = (body.cases as { id: number; domain: string }[]).find((c) => c.id === caseId);
    expect(mine, '名下清单里没有刚建的这个案子').toBeTruthy();
    // 页面（app/_ui/currentCase）只取这一列来决定问哪套问题；接口不给它就只能假设缺省领域
    expect(mine!.domain).toBe(key);
  });

  it('首诊排的步与这个包的 intakeSchema 逐项对应，末步是「你的档案」', () => {
    if (hasHandwrittenFlow(key)) {
      // 有手写向导的领域走的是那份稿子（逐字不变，另有判据钉住），不走 schema 排步
      return;
    }
    const steps = schemaSteps(pack);
    expect(steps.length).toBe(pack.intakeSchema.length + 1);
    // 顺序即 schema 的顺序：页面自作主张排序时这里会错位
    steps.slice(0, -1).forEach((step, i) => {
      expect(step.reassurance, `第 ${i + 1} 步的说明不是包里那句话`).toBe(
        pack.intakeSchema[i].description,
      );
    });
    expect(steps[steps.length - 1].title).toBe('你的档案');
  });

  it('必填项空着时拦下来说的是**这个包自己那句话**（变异：改成一句通用的「有必填项未填」→ 红）', () => {
    if (hasHandwrittenFlow(key)) return;
    const steps = schemaSteps(pack);
    const today = '2026-09-07';
    pack.intakeSchema.forEach((field, i) => {
      const blank = { ...EMPTY_DRAFT, fields: { [field.key]: emptyValue(field) } };
      const got = steps[i].block?.(blank, today) ?? null;
      if (!field.required) {
        expect(got, `${field.key} 不是必填项，不该拦`).toBeNull();
        return;
      }
      const want = (field.invalidMessage ?? '').replace('{values}', (field.values ?? []).join(' / '));
      expect(got, `${field.key} 拦下来说的不是包里那句话`).toBe(want);
    });
  });

  it('填满一份交上去 → 落进这个案子，阶段是这个包词表里的值，事件标题是这个包的话', async () => {
    const { token, caseId } = await registerWithDomain(`facts-${key}@example.com`, key);
    const draft = filledDraft(pack);
    // 手写向导那条路 toIntakePayload 读的是 draft 上那些手写字段，schema 那条路读 draft.fields。
    // 两条路由同一个函数按 pack 分流，这里走的正是页面会走的那一支。
    const payload = hasHandwrittenFlow(key)
      ? handwrittenPayload(pack)
      : toIntakePayload(draft, pack);

    const res = await postIntake(
      authed(`http://localhost/api/v1/cases/${caseId}/intake`, token, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
      { params: Promise.resolve({ id: String(caseId) }) },
    );
    const body = await json(res);
    expect(res.status, `首诊没收下：${JSON.stringify(body)}`).toBe(201);

    const row = db.prepare('SELECT stage, domain FROM cases WHERE id = ?').get(caseId) as {
      stage: string;
      domain: string;
    };
    expect(row.domain, '首诊不该改动案件领域').toBe(key);
    expect(pack.stages, '落库的阶段不在这个包的词表里').toContain(row.stage);

    const titles = (
      db
        .prepare('SELECT title FROM timeline_events WHERE case_id = ?')
        .all(caseId) as { title: string }[]
    ).map((r) => r.title);
    // 首诊把「对方主张的说法」「手上有哪几份书面材料」落成事件，标题逐字来自这个包的 copy.site
    expect(titles).toContain(pack.copy.site.intakeCounterpartWordingTitle);
    expect(titles).toContain(pack.copy.site.intakeCounterpartDocsTitle);
  });

  it('事实卡每一节的抬头是这个包的分节措辞，且不混进别的包的抬头', async () => {
    const { token, caseId } = await registerWithDomain(`card-${key}@example.com`, key);
    const payload = hasHandwrittenFlow(key)
      ? handwrittenPayload(pack)
      : toIntakePayload(filledDraft(pack), pack);
    await postIntake(
      authed(`http://localhost/api/v1/cases/${caseId}/intake`, token, {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
      { params: Promise.resolve({ id: String(caseId) }) },
    );

    const rendered = renderCaseFacts(buildCaseFacts(loadCaseSnapshot(db, caseId)));
    // 【按整行抬头比，不按子串比】子串比的形态是：一个包的「证据」是另一个包
    // 「证据地图（敏感级）」的子串，于是判据要么恒绿要么恒红，两种都没在验分节。
    const headings = [...rendered.matchAll(/^#{3}\s+(.+)$/gm)].map((m) => m[1].trim());
    for (const section of pack.factsSections) {
      expect(headings, `事实卡里没有「${section.title}」这一节`).toContain(section.title);
    }
    // 别的包**独有**的抬头一个都不许出现：混进来的形态是渲染器退回了上一个领域的措辞，
    // 而每一行数据都是对的、没有一处会报错。
    const mine = new Set(pack.factsSections.map((s) => s.title));
    for (const [otherKey, other] of Object.entries(DOMAINS)) {
      if (otherKey === key) continue;
      for (const s of other.factsSections) {
        if (mine.has(s.title)) continue; // 两个包本来就用同一个抬头（如「案件抬头」），不算串味
        expect(headings, `事实卡里混进了 ${otherKey} 的抬头「${s.title}」`).not.toContain(s.title);
      }
    }
  });

  it('有并行轨的领域，事实卡出「当前轨」一行；没有的领域一个字都不出', async () => {
    const { caseId } = await registerWithDomain(`track-${key}@example.com`, key);
    const rendered = renderCaseFacts(buildCaseFacts(loadCaseSnapshot(db, caseId)));
    if (pack.tracks.length === 0) {
      expect(rendered).not.toContain('当前轨');
    } else {
      expect(rendered).toContain('当前轨');
      for (const t of pack.tracks) expect(rendered).toContain(t);
    }
  });
});

/**
 * 手写向导那条路的请求体：把 schema 的答案摊回 draft 上那些手写字段。
 *
 * 【为什么不直接给 toIntakePayload 一个空 draft】空 draft 交上去会被服务端拦在必填项上，
 * 于是这条判据变成"验了一次 400"，而它要验的是**收下之后落成了什么**。
 */
function handwrittenPayload(pack: DomainPack): Record<string, unknown> {
  const byKey = new Map(pack.intakeSchema.map((f) => [f.key, f]));
  const stage = byKey.get('stage');
  const draft: IntakeDraft = {
    ...EMPTY_DRAFT,
    domain: pack.key,
    stage: ((stage?.values ?? [])[1] ?? (stage?.values ?? [])[0] ?? '') as IntakeDraft['stage'],
    companyName: '对面那一方',
    hiredOn: '2025-03-04',
    monthlyWage: '800',
    position: '我这一方的身份',
    contractCount: '只签过一次',
    events: [{ id: 'e1', date: '2026-01-09', text: '发生过一件事' }],
    freeText: '整段经过',
    terminationNotice: '有',
    settlementAgreement: '有',
    otherPaper: '有',
    companyWording: '对方口头说的话',
    goals: ['第一项诉求'],
    bottomLine: '我的底线',
  };
  return toIntakePayload(draft);
}
