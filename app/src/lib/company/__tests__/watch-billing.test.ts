// app/src/lib/company/__tests__/watch-billing.test.ts
// 守望月度计费（spec v3 §2.2 · 工单 D-1）：三档结算 + arrears 状态机 + 幂等 + 变异核。
//
// 【变异核集中在 D3 状态机】「余额不足立即 paused 且不通知」是被本产品判为最危险的失败模式。
// 下面 D3 逐轮钉住：前两轮 status 必须仍 active、且每轮都发了中性通知；第 3 轮才 paused 且再发一次。
// 把实现改成「立即 paused」→ 第 1 轮 active 断言红；改成「不通知」→ 通知断言红。
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { runMigrations } from '../../db/migrate';
import { gongdaoGrant, getGongdao } from '../../billing';
import { GONGDAO_LEDGER_TYPE } from '../../billing/pricing';
import { wasSent } from '../../db/notify-log';
import { addWatch } from '../watch';
import { PAUSE_THRESHOLD, monthKey, runWatchBilling } from '../watch-billing';
import type { MailCopy } from '../../notify/copy';

const JUN = new Date(2026, 5, 1); // getMonth()=5 → 与进程时区无关，key=202606
const JUL = new Date(2026, 6, 1);
const AUG = new Date(2026, 7, 1);

interface Ctx {
  db: Database.Database;
  userId: number;
  caseId: number;
}

function setup(opts: { balance?: number; email?: string | null } = {}): Ctx {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const userId = Number(
    db.prepare('INSERT INTO users (phone_hash, email) VALUES (?, ?)')
      .run('u1', opts.email === undefined ? 'u1@example.com' : opts.email).lastInsertRowid,
  );
  const caseId = Number(
    db.prepare('INSERT INTO cases (user_id, title) VALUES (?, ?)').run(userId, '案').lastInsertRowid,
  );
  if (opts.balance) gongdaoGrant(userId, opts.balance, GONGDAO_LEDGER_TYPE.recharge, 'seed-balance', null, db);
  return { db, userId, caseId };
}

/** 记录发信调用的假 mailer；可切换成"抛错"以测通知失败。 */
function mailer(fail = false) {
  const calls: { to: string; copy: MailCopy }[] = [];
  const sendMail = vi.fn(async (to: string, copy: MailCopy) => {
    if (fail) throw new Error('SMTP 550 mailbox unavailable');
    calls.push({ to, copy });
  });
  return { sendMail, calls };
}

const watchRow = (db: Database.Database, id: number) =>
  db.prepare(
    'SELECT status, tier, billing_status, arrears_rounds, paid_through, billed_month FROM company_watches WHERE id=?',
  ).get(id) as {
    status: string;
    tier: string;
    billing_status: string;
    arrears_rounds: number;
    paid_through: string | null;
    billed_month: string | null;
  };

/** 某盯梢某月的扣费流水笔数（refId=watch-{id}-{YYYYMM}）。 */
const consumeCount = (db: Database.Database, watchId: number, mk: string) =>
  (db.prepare(
    'SELECT COUNT(*) c FROM gongdao_ledger WHERE type=? AND ref_id=?',
  ).get(GONGDAO_LEDGER_TYPE.consume, `watch-${watchId}-${mk}`) as { c: number }).c;

describe('三档结算（D2）', () => {
  test('daily 扣 199、weekly 扣 60、archive 不扣且不落 ledger 行', async () => {
    const ctx = setup({ balance: 1000 });
    const daily = addWatch(ctx.db, { caseId: ctx.caseId, name: 'A', tier: 'daily' }).id;
    const weekly = addWatch(ctx.db, { caseId: ctx.caseId, name: 'B', tier: 'weekly' }).id;
    const archive = addWatch(ctx.db, { caseId: ctx.caseId, name: 'C', tier: 'archive' }).id;

    const m = mailer();
    const r = await runWatchBilling(ctx.db, { sendMail: m.sendMail, now: JUN });

    // archive 不计入 examined
    expect(r).toMatchObject({ examined: 2, charged: 2, arrears: 0, paused: 0, failed: 0 });
    expect(getGongdao(ctx.userId, ctx.db)).toBe(1000 - 199 - 60);

    expect(watchRow(ctx.db, daily)).toMatchObject({ billing_status: 'paid', paid_through: '202606' });
    expect(watchRow(ctx.db, weekly)).toMatchObject({ billing_status: 'paid', paid_through: '202606' });
    // archive：一分没扣、无 ledger 行、状态不动（仍 free）
    expect(consumeCount(ctx.db, archive, '202606')).toBe(0);
    expect(watchRow(ctx.db, archive)).toMatchObject({ billing_status: 'free', billed_month: null });
    // 扣费不发通知
    expect(m.calls).toHaveLength(0);
  });
});

describe('同月幂等（D1）', () => {
  test('同月重复跑，每个 watch 只扣一笔', async () => {
    const ctx = setup({ balance: 1000 });
    const daily = addWatch(ctx.db, { caseId: ctx.caseId, name: 'A', tier: 'daily' }).id;
    const m = mailer();

    await runWatchBilling(ctx.db, { sendMail: m.sendMail, now: JUN });
    const afterFirst = getGongdao(ctx.userId, ctx.db);
    const r2 = await runWatchBilling(ctx.db, { sendMail: m.sendMail, now: JUN });

    expect(getGongdao(ctx.userId, ctx.db)).toBe(afterFirst); // 第二遍没再扣
    expect(consumeCount(ctx.db, daily, '202606')).toBe(1); // 只有一笔
    expect(r2).toMatchObject({ examined: 1, charged: 0 }); // 第二遍 billed_month 命中，跳过扣费
  });
});

describe('arrears 状态机（D3）· 变异核', () => {
  test('余额不足：前两轮欠费仍 active 且每轮通知，第 3 轮才 paused 且再发一次', async () => {
    const ctx = setup({ balance: 0 }); // 一分没有
    const w = addWatch(ctx.db, { caseId: ctx.caseId, name: 'A', tier: 'daily' }).id;

    // ── 第 1 轮（6 月）：欠费，仍 active ──
    const m1 = mailer();
    const r1 = await runWatchBilling(ctx.db, { sendMail: m1.sendMail, now: JUN });
    expect(r1).toMatchObject({ examined: 1, charged: 0, arrears: 1, paused: 0 });
    expect(watchRow(ctx.db, w)).toMatchObject({
      status: 'active', // ← 变异「立即 paused」在此红
      billing_status: 'arrears',
      arrears_rounds: 1,
    });
    expect(consumeCount(ctx.db, w, '202606')).toBe(0); // 不扣（不透支订阅）
    expect(m1.calls).toHaveLength(1); // ← 变异「不通知」在此红
    expect(m1.calls[0].copy.subject).not.toContain('暂停'); // 还没停，是催缴
    expect(wasSent(ctx.db, 'watch_arrears', `arrears-${w}-202606`, 'email')).toBe(true);

    // ── 第 2 轮（7 月）：仍欠费、仍 active ──
    const m2 = mailer();
    await runWatchBilling(ctx.db, { sendMail: m2.sendMail, now: JUL });
    expect(watchRow(ctx.db, w)).toMatchObject({ status: 'active', arrears_rounds: 2 });
    expect(m2.calls).toHaveLength(1);
    expect(m2.calls[0].copy.subject).not.toContain('暂停');

    // ── 第 3 轮（8 月）：达上限 → paused，且再发一次（催缴 + 暂停两封） ──
    const m3 = mailer();
    const r3 = await runWatchBilling(ctx.db, { sendMail: m3.sendMail, now: AUG });
    expect(r3).toMatchObject({ arrears: 1, paused: 1 });
    expect(watchRow(ctx.db, w)).toMatchObject({ status: 'paused', arrears_rounds: PAUSE_THRESHOLD });
    // 绝不静默停盯：暂停这件事必须发出去
    expect(m3.calls.some((c) => c.copy.subject.includes('暂停'))).toBe(true);
    expect(wasSent(ctx.db, 'watch_paused', `paused-${w}-202608`, 'email')).toBe(true);

    // ── 第 4 轮（8 月，同月重跑）：已 paused，退出活跃扫描，不再动它 ──
    const m4 = mailer();
    const r4 = await runWatchBilling(ctx.db, { sendMail: m4.sendMail, now: AUG });
    expect(r4).toMatchObject({ examined: 0 });
    expect(m4.calls).toHaveLength(0);
  });

  test('欠费后充值：下一轮恢复扣费、欠费计数清零、仍 active（未到暂停）', async () => {
    const ctx = setup({ balance: 0 });
    const w = addWatch(ctx.db, { caseId: ctx.caseId, name: 'A', tier: 'daily' }).id;
    const m = mailer();

    await runWatchBilling(ctx.db, { sendMail: m.sendMail, now: JUN }); // 欠费 1 轮
    expect(watchRow(ctx.db, w)).toMatchObject({ arrears_rounds: 1, billing_status: 'arrears' });

    gongdaoGrant(ctx.userId, 500, GONGDAO_LEDGER_TYPE.recharge, 'topup', null, ctx.db); // 充值
    await runWatchBilling(ctx.db, { sendMail: m.sendMail, now: JUL }); // 下月

    expect(watchRow(ctx.db, w)).toMatchObject({
      status: 'active',
      billing_status: 'paid',
      arrears_rounds: 0, // ← 恢复即清零
      paid_through: '202607',
    });
    expect(getGongdao(ctx.userId, ctx.db)).toBe(500 - 199);
  });

  test('paused 的盯梢不再被扫描计费（stop 是软停、留行）', async () => {
    const ctx = setup({ balance: 1000 });
    const w = addWatch(ctx.db, { caseId: ctx.caseId, name: 'A', tier: 'daily' }).id;
    ctx.db.prepare("UPDATE company_watches SET status='paused' WHERE id=?").run(w);
    const m = mailer();
    const r = await runWatchBilling(ctx.db, { sendMail: m.sendMail, now: JUN });
    expect(r).toMatchObject({ examined: 0, charged: 0 });
    expect(getGongdao(ctx.userId, ctx.db)).toBe(1000); // 没扣
  });
});

describe('通知的健壮性', () => {
  test('发信失败：状态照常推进（已欠费/已暂停），通知计入 failed 且不占 sent 位（下轮可重试）', async () => {
    const ctx = setup({ balance: 0 });
    const w = addWatch(ctx.db, { caseId: ctx.caseId, name: 'A', tier: 'daily' }).id;

    const bad = mailer(true); // 发信必抛
    const r = await runWatchBilling(ctx.db, { sendMail: bad.sendMail, now: JUN });
    // 状态推进到欠费（发不发得出去，欠费这个事实都成立）
    expect(watchRow(ctx.db, w)).toMatchObject({ billing_status: 'arrears', arrears_rounds: 1 });
    expect(r.failed).toBeGreaterThanOrEqual(1);
    expect(wasSent(ctx.db, 'watch_arrears', `arrears-${w}-202606`, 'email')).toBe(false); // 没占 sent 位

    // 同月重跑：billed_month 已命中不再重复计欠费，但通知会重试并这次发成
    const good = mailer(false);
    await runWatchBilling(ctx.db, { sendMail: good.sendMail, now: JUN });
    expect(watchRow(ctx.db, w)).toMatchObject({ arrears_rounds: 1 }); // 计数没被重跑推高
    expect(good.calls).toHaveLength(1); // 补发成功
    expect(wasSent(ctx.db, 'watch_arrears', `arrears-${w}-202606`, 'email')).toBe(true);
  });

  test('用户没绑邮箱：状态照常推进，不报错、不发信', async () => {
    const ctx = setup({ balance: 0, email: null });
    const w = addWatch(ctx.db, { caseId: ctx.caseId, name: 'A', tier: 'daily' }).id;
    const m = mailer();
    const r = await runWatchBilling(ctx.db, { sendMail: m.sendMail, now: JUN });
    expect(watchRow(ctx.db, w)).toMatchObject({ billing_status: 'arrears', arrears_rounds: 1 });
    expect(m.calls).toHaveLength(0);
    expect(r.failed).toBe(0); // 没邮箱不是发送失败
  });
});

describe('干跑', () => {
  test('dryRun：只算不扣不发不改库', async () => {
    const ctx = setup({ balance: 1000 });
    addWatch(ctx.db, { caseId: ctx.caseId, name: 'A', tier: 'daily' });
    addWatch(ctx.db, { caseId: ctx.caseId, name: 'B', tier: 'weekly' });
    const m = mailer();
    const r = await runWatchBilling(ctx.db, { sendMail: m.sendMail, now: JUN, dryRun: true });
    expect(r).toMatchObject({ examined: 2, charged: 2 });
    expect(getGongdao(ctx.userId, ctx.db)).toBe(1000); // 没扣
    expect(m.calls).toHaveLength(0);
    // 库没动：billed_month 仍空
    const rows = ctx.db.prepare('SELECT billed_month FROM company_watches').all();
    expect(rows.every((x) => (x as { billed_month: string | null }).billed_month === null)).toBe(true);
  });
});

describe('monthKey', () => {
  test('本地日历月，两位月份补零', () => {
    expect(monthKey(new Date(2026, 0, 15))).toBe('202601');
    expect(monthKey(new Date(2026, 11, 31))).toBe('202612');
  });
});
