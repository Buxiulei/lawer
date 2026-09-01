// app/src/lib/notify/__tests__/deadline-reminder.test.ts
// 期限提醒的档位与去重语义。
//
// 【这里的失败代价不对称，判据也要跟着不对称】
// 多发一封 = 打扰；漏发一封 = 用户错过仲裁时效，**权利灭失，没有救济**。
// 所以每一条"不发"的分支都要单独钉住，而"多发"只需要不至于每分钟轰炸。
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { formatCountdown } from '@/app/_ui/format';

import { runMigrations } from '../../db/migrate';
import {
  IRRECOVERABLE_KINDS,
  runReminders,
  daysUntil,
  markSent,
  planReminders,
  stageFor,
  type DueRow,
} from '../deadline-reminder';

// 本文件每条用例的 beforeEach 都要跑一整套迁移建库；单跑就已实耗数秒，全量跑批里和
// 几十个同样吃 CPU 的文件挤在一起，默认 5s 的余量不够——超时红过，但代码一行没错。
// 放宽的**只是这个文件**：全局改宽会把真慢化一起盖掉。
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const NOW = new Date('2026-09-01T08:00:00Z');
let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
});

function seed(opts: { kind: string; dueAt: string; sent?: string[]; resolved?: boolean; email?: string | null }) {
  const uid = Number(
    db.prepare('INSERT INTO users (email) VALUES (?)').run(opts.email === undefined ? 'u@t.com' : opts.email)
      .lastInsertRowid,
  );
  const cid = Number(
    db.prepare("INSERT INTO cases (user_id, title) VALUES (?, '案')").run(uid).lastInsertRowid,
  );
  const did = Number(
    db
      .prepare('INSERT INTO deadlines (case_id, kind, due_at, notified_stages_json, resolved_at) VALUES (?,?,?,?,?)')
      .run(cid, opts.kind, opts.dueAt, opts.sent ? JSON.stringify(opts.sent) : null, opts.resolved ? '2026-08-01' : null)
      .lastInsertRowid,
  );
  return { uid, cid, did };
}

const row = (o: Partial<DueRow>): DueRow => ({
  id: 1, case_id: 1, kind: '开庭', due_at: '2026-09-08', notified_stages_json: null,
  email: 'u@t.com', notify_verbose: 0, ...o,
});

describe('天数按日历日算', () => {
  test('同日=0，次日=1，跨月正确', () => {
    expect(daysUntil('2026-09-01', NOW)).toBe(0);
    expect(daysUntil('2026-09-02', NOW)).toBe(1);
    expect(daysUntil('2026-10-01', NOW)).toBe(30);
  });
  test('带时分秒也只看日期部分 —— 用户感知的是"还剩几天"不是"还剩几小时"', () => {
    expect(daysUntil('2026-09-02T23:59:59Z', NOW)).toBe(1);
    expect(daysUntil('2026-09-02T00:00:01Z', NOW)).toBe(1);
  });
});

describe('🔴 "今天"取北京日历日 —— CST 00:00–08:00 那一段不能多算一天', () => {
  // 【这里 pin TZ 现在只为量具，不为被测函数】原注释写的是"这个函数的契约就是按
  // **本地**日历日，跑在 UTC runner 上结论会不同"——那已经不成立了：daysUntil 现在
  // 锚死在案件时区（lib/deadline/case-day），换任何进程时区结论都一样
  // （case-day.test.ts「不受进程时区摆布」那组专钉这件事）。
  // 仍然 pin，是因为下面"先验量具"那条用 getFullYear/getDate 读本地日历日。
  const originalTz = process.env.TZ;
  beforeEach(() => { process.env.TZ = 'Asia/Shanghai'; });
  afterEach(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  /**
   * 修复前的实现，逐字保留当**对照臂**。
   * 没有它，"新实现给 3"只是一句和判据并存的文字——看不出修的是哪一段、修没修着。
   */
  function daysUntilUtcLegacy(dueAt: string, now: Date): number {
    const due = new Date(`${dueAt.slice(0, 10)}T00:00:00Z`).getTime();
    const today = new Date(`${now.toISOString().slice(0, 10)}T00:00:00Z`).getTime();
    return Math.round((due - today) / 86400000);
  }

  // 本地 2026-09-01 00:30 CST。UTC 此刻还停在 08-31 16:30 —— 正是出问题的那一段。
  const AT_0030 = new Date('2026-08-31T16:30:00Z');
  // 本地 2026-09-01 09:30 CST（当前 cron 时刻）。UTC 已跨到 09-01，本地/UTC 同日。
  const AT_0930 = new Date('2026-09-01T01:30:00Z');
  const DUE = '2026-09-04'; // 本地今天 + 3 天

  test('先验量具：TZ 真的 pin 住了，两个时刻的本地日历日都是 09-01', () => {
    // 【先审量具再信读数】TZ 若没生效，下面两条会变成互相抵消的假绿。
    for (const t of [AT_0030, AT_0930]) {
      expect(t.getFullYear()).toBe(2026);
      expect(t.getMonth()).toBe(8); // 9 月
      expect(t.getDate()).toBe(1);
    }
    // 而 UTC 日在这两个时刻是分裂的 —— 这才是 bug 存在的前提
    expect(AT_0030.toISOString().slice(0, 10)).toBe('2026-08-31');
    expect(AT_0930.toISOString().slice(0, 10)).toBe('2026-09-01');
  });

  test('🔑 本地 00:30：旧实现给 4（多算一天），新实现必须给 3', () => {
    expect(daysUntilUtcLegacy(DUE, AT_0030)).toBe(4);
    expect(daysUntil(DUE, AT_0030)).toBe(3);
  });

  test('本地 09:30：新旧一致（都是 3）—— 修的是那一段，不是全域', () => {
    expect(daysUntilUtcLegacy(DUE, AT_0930)).toBe(3);
    expect(daysUntil(DUE, AT_0930)).toBe(3);
  });

  test('🔑 00:30 时 daysLeft=1 才会进逐日加码档 —— 多算一天等于那天不发', () => {
    // 这条把"算错一天"翻译成它真正的后果：不可回复类期限在最后一天静默不提醒。
    const r = row({ kind: '仲裁时效', due_at: '2026-09-02' }); // 本地今天 + 1
    expect(daysUntilUtcLegacy(r.due_at, AT_0030)).toBe(2);     // 旧：2 天 ⇒ 走不到 ≤1 的加码档
    // 逐日键此前取 UTC 日（stageFor 里的 now.toISOString()），00:30 会写成
    // 'daily-2026-08-31' —— 上一单点名留给后续单据，现已一并修掉，故这里补上断言：
    // 键必须跟 daysLeft 落在同一个北京日历日，否则"同一天只发一次"就不成立。
    expect(stageFor(r, AT_0030)).toMatchObject({ stageKey: 'daily-2026-09-01', daysLeft: 1 });
  });

  test('🔑 逐日键按北京日历日 —— 同一天跑两轮只发一封', () => {
    // 【这条钉的是"多发"】逐日键此前用 UTC 日，而 UTC 日在北京 08:00 换日：
    // 07:30 那轮写 'daily-2026-08-31'、09:30 那轮写 'daily-2026-09-01' ——
    // 同一个北京 9 月 1 日被切成两个键，用户当天收到两封一模一样的提醒。
    const AT_0730 = new Date('2026-08-31T23:30:00Z'); // 北京 09-01 07:30
    const AT_0930 = new Date('2026-09-01T01:30:00Z'); // 北京 09-01 09:30（cron 时刻）

    // 对照臂：旧的 UTC 键在这两个时刻确实是分裂的 —— 这才是"当天发两封"的成因
    const utcKey = (d: Date) => `daily-${d.toISOString().slice(0, 10)}`;
    expect(utcKey(AT_0730)).not.toBe(utcKey(AT_0930));

    const first = stageFor(row({ kind: '仲裁时效', due_at: '2026-09-02' }), AT_0730);
    expect(first).toMatchObject({ stageKey: 'daily-2026-09-01' });

    // 第一轮记档后再跑第二轮：同一个北京日历日，必须一封都不再发。
    // 旧实现在这里会给出一个"新"键 ⇒ 第二封。
    const afterFirst = row({
      kind: '仲裁时效',
      due_at: '2026-09-02',
      notified_stages_json: JSON.stringify([first!.stageKey]),
    });
    expect(stageFor(afterFirst, AT_0930)).toBeNull();
  });
});

describe('档位选择', () => {
  test('31 天外不发', () => {
    expect(stageFor(row({ due_at: '2026-10-05' }), NOW)).toBeNull();
  });
  test('恰好 30 天 → 发 30 档', () => {
    expect(stageFor(row({ due_at: '2026-10-01' }), NOW)).toMatchObject({ stageKey: '30', daysLeft: 30 });
  });
  test('落在两档之间取**最紧**的那档（29 天 → 30 档；2 天 → 3 档）', () => {
    // 【第一版取的是最松档，测试撞出来了】那样剩 2 天且从未提醒时会先发 30 档、
    // 次日 7 档、再次日 3 档——**一条晚发现的期限在最后几天连发四封**。
    expect(stageFor(row({ due_at: '2026-09-30' }), NOW)).toMatchObject({ stageKey: '30' });
    expect(stageFor(row({ due_at: '2026-09-03' }), NOW)).toMatchObject({ stageKey: '3' });
  });

  test('🔑 发紧档时把更松的档一并记上 —— 不再补发历史档', () => {
    const { did } = seed({ kind: '开庭', dueAt: '2026-09-03' }); // 剩 2 天
    markSent(db, did, '3');
    const r = db.prepare('SELECT notified_stages_json j FROM deadlines WHERE id=?').get(did) as { j: string };
    expect(JSON.parse(r.j).sort()).toEqual(['3', '30', '7']);
  });
  test('已发过 30 档，29 天时不重发；到 7 天时发 7 档', () => {
    expect(stageFor(row({ due_at: '2026-09-30', notified_stages_json: '["30"]' }), NOW)).toBeNull();
    expect(stageFor(row({ due_at: '2026-09-08', notified_stages_json: '["30"]' }), NOW)).toMatchObject({ stageKey: '7' });
  });
  test('🔴 已过期不发 —— 发了也没用', () => {
    expect(stageFor(row({ due_at: '2026-08-30' }), NOW)).toBeNull();
  });
});

describe('🔴 ③ 不可回复类的末档加码：宁可轰炸不可漏', () => {
  test('仲裁时效剩 1 天 → 逐日档，键带日期', () => {
    const s = stageFor(row({ kind: '仲裁时效', due_at: '2026-09-02' }), NOW);
    expect(s).toMatchObject({ stageKey: 'daily-2026-09-01', daysLeft: 1 });
  });
  test('同一天不重发，跨天必然重发', () => {
    const r = row({ kind: '仲裁时效', due_at: '2026-09-02', notified_stages_json: '["daily-2026-09-01"]' });
    expect(stageFor(r, NOW)).toBeNull();
    expect(stageFor(r, new Date('2026-09-02T08:00:00Z'))).toMatchObject({ stageKey: 'daily-2026-09-02' });
  });
  test('可回复类（开庭/答辩期）不进逐日档 —— 加码只给不可回复的', () => {
    const r = row({ kind: '开庭', due_at: '2026-09-02', notified_stages_json: '["30","7","3"]' });
    expect(stageFor(r, NOW)).toMatchObject({ stageKey: '1' });
    // 1 档发过之后就停，不逐日
    expect(stageFor({ ...r, notified_stages_json: '["30","7","3","1"]' }, NOW)).toBeNull();
  });
  test('四类不可回复期限一个都不能漏登记', () => {
    for (const k of ['仲裁时效', '起诉15日', '上诉15日', '申请执行2年']) {
      expect(IRRECOVERABLE_KINDS.has(k), k).toBe(true);
    }
    expect(IRRECOVERABLE_KINDS.has('开庭')).toBe(false);
    expect(IRRECOVERABLE_KINDS.has('自定义')).toBe(false);
  });
});

describe('🔴 坏数据一律偏向"发"', () => {
  test('notified_stages_json 是坏 JSON → 当没发过，重发', () => {
    // 【为什么不抛错】一个坏字段不该让这条期限从此静默失联。
    // 多发一封是打扰，漏发是权利灭失——误差方向必须偏向发。
    expect(stageFor(row({ due_at: '2026-09-08', notified_stages_json: '{坏' }), NOW)).toMatchObject({ stageKey: '7' });
  });
  test('字段是对象而非数组 → 同样当没发过', () => {
    expect(stageFor(row({ due_at: '2026-09-08', notified_stages_json: '{"30":true}' }), NOW)).toMatchObject({ stageKey: '7' });
  });
});

describe('扫描与计划', () => {
  test('已了结的不进计划', () => {
    seed({ kind: '开庭', dueAt: '2026-09-03', resolved: true });
    expect(planReminders(db, NOW)).toEqual([]);
  });
  test('没绑邮箱的跳过，且不算错', () => {
    seed({ kind: '开庭', dueAt: '2026-09-03', email: null });
    expect(planReminders(db, NOW)).toEqual([]);
  });
  test('正常一条进计划，带 detailed=false', () => {
    seed({ kind: '仲裁时效', dueAt: '2026-09-03' });
    const p = planReminders(db, NOW);
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ kind: '仲裁时效', daysLeft: 2, stageKey: '3', detailed: false });
  });
  test('用户开了 notify_verbose → detailed=true', () => {
    const { uid } = seed({ kind: '开庭', dueAt: '2026-09-03' });
    db.prepare('UPDATE users SET notify_verbose=1 WHERE id=?').run(uid);
    expect(planReminders(db, NOW)[0].detailed).toBe(true);
  });
});

describe('markSent 只追加不覆盖', () => {
  test('保留既有档，追加新档', () => {
    const { did } = seed({ kind: '开庭', dueAt: '2026-09-08', sent: ['30'] });
    markSent(db, did, '7');
    const r = db.prepare('SELECT notified_stages_json j FROM deadlines WHERE id=?').get(did) as { j: string };
    expect(JSON.parse(r.j)).toEqual(['30', '7']);
  });
  test('重复写同一档不产生重复项（但会补上覆盖的更松档）', () => {
    const { did } = seed({ kind: '开庭', dueAt: '2026-09-08', sent: ['7'] });
    markSent(db, did, '7');
    const r = db.prepare('SELECT notified_stages_json j FROM deadlines WHERE id=?').get(did) as { j: string };
    // 7 覆盖 30；去重后是这两项，不是 ['7','7','30']
    expect(JSON.parse(r.j).sort()).toEqual(['30', '7']);
  });

  test('逐日档只记自己，不去覆盖数字档', () => {
    // daily-YYYY-MM-DD 不是数字档，不该被当成"覆盖了 30/7/3/1"——
    // 否则一次逐日提醒会把所有档记满，而那几档本来就该各发一次。
    const { did } = seed({ kind: '仲裁时效', dueAt: '2026-09-02' });
    markSent(db, did, 'daily-2026-09-01');
    const r = db.prepare('SELECT notified_stages_json j FROM deadlines WHERE id=?').get(did) as { j: string };
    expect(JSON.parse(r.j)).toEqual(['daily-2026-09-01']);
  });
});

describe('🔴 端到端：真发出去的那封信与驾驶舱说同一句话', () => {
  /**
   * 【为什么要端到端钉一遍】上游 daysUntil 相等只是个数字相等；
   * 用户实际看到的是**邮件主题**和**驾驶舱徽标**这两句中文。
   * 中间还隔着 stageFor 的档位选择与 copy.ts 的措辞（daysLeft <= 0 才写「今天到期」），
   * 任何一处偏一格，两句话就又不一样了。这条从库里的一行走到那两句话。
   */
  test('🔑 期限当天北京早 7 点：邮件写「今天到期」，驾驶舱也写「今天到期」', async () => {
    const DUE = '2026-09-10';
    const AT_0700 = new Date('2026-09-09T23:00:00Z'); // 北京 09-10 07:00，UTC 还停在 09-09
    // 先验量具：这确实是 UTC/北京分裂的那一段，不是随手挑的一个时刻
    expect(AT_0700.toISOString().slice(0, 10)).toBe('2026-09-09');

    seed({ kind: '仲裁时效', dueAt: DUE });
    const got: { subject: string; text: string }[] = [];
    const r = await runReminders(db, {
      sendMail: async (_to, c) => { got.push(c); },
      now: AT_0700,
    });

    expect(r).toMatchObject({ examined: 1, ok: 1, failed: 0 });
    expect(got).toHaveLength(1);
    expect(got[0].subject).toContain('今天到期');
    expect(got[0].subject).not.toContain('还剩');
    expect(got[0].text).toContain('今天到期');

    // 同一时刻的驾驶舱徽标（DeadlineChip / DeadlineTiles 读的就是这个函数）
    expect(formatCountdown(DUE, AT_0700)).toBe('今天到期');
    expect(formatCountdown(`${DUE} 00:00:00`, AT_0700)).toBe('今天到期'); // 库里的实况形态
  });
});

describe('🔴 ② 先发后记 —— 这是这活的要害', () => {
  const sentTo: string[] = [];
  const okSender = async (to: string) => { sentTo.push(to); };
  const failSender = async () => { throw new Error('SMTP 挂了'); };

  test('发送成功才记档', async () => {
    sentTo.length = 0;
    const { did } = seed({ kind: '开庭', dueAt: '2026-09-03' });
    const r = await runReminders(db, { sendMail: okSender, now: NOW });
    expect(r).toMatchObject({ examined: 1, ok: 1, failed: 0 });
    expect(sentTo).toEqual(['u@t.com']);
    const j = (db.prepare('SELECT notified_stages_json j FROM deadlines WHERE id=?').get(did) as { j: string }).j;
    expect(JSON.parse(j)).toContain('3');
  });

  test('🔑 发送失败**不记档**，下一轮会重试', async () => {
    // 【为什么这条是要害】反过来（先记后发）会在失败时留下"已通知"的假象，
    // 而那一档再也不会重来 —— 对仲裁时效，那一次静默漏发就是权利灭失。
    const { did } = seed({ kind: '仲裁时效', dueAt: '2026-09-03' });
    const r1 = await runReminders(db, { sendMail: failSender, now: NOW });
    expect(r1).toMatchObject({ examined: 1, ok: 0, failed: 1 });
    const j = (db.prepare('SELECT notified_stages_json j FROM deadlines WHERE id=?').get(did) as { j: string | null }).j;
    expect(j).toBeNull(); // 一个字都没记

    sentTo.length = 0;
    const r2 = await runReminders(db, { sendMail: okSender, now: NOW });
    expect(r2).toMatchObject({ ok: 1 }); // 下一轮真的重试了
    expect(sentTo).toEqual(['u@t.com']);
  });

  test('一封失败不拖累其余', async () => {
    seed({ kind: '开庭', dueAt: '2026-09-03', email: 'a@t.com' });
    seed({ kind: '开庭', dueAt: '2026-09-03', email: 'b@t.com' });
    let n = 0;
    const flaky = async () => { n += 1; if (n === 1) throw new Error('第一封挂'); };
    const r = await runReminders(db, { sendMail: flaky, now: NOW });
    expect(r).toMatchObject({ examined: 2, ok: 1, failed: 1 });
  });

  test('干跑不发不记档，但如实报会发几封', async () => {
    const { did } = seed({ kind: '开庭', dueAt: '2026-09-03' });
    sentTo.length = 0;
    const r = await runReminders(db, { sendMail: okSender, now: NOW, dryRun: true });
    expect(r).toMatchObject({ examined: 1, ok: 1 });
    expect(sentTo).toEqual([]);
    const j = (db.prepare('SELECT notified_stages_json j FROM deadlines WHERE id=?').get(did) as { j: string | null }).j;
    expect(j).toBeNull();
    expect(r.note).toContain('干跑');
  });

  test('空表时 note 说"无到档"，不是空字符串', async () => {
    const r = await runReminders(db, { sendMail: okSender, now: NOW });
    expect(r).toMatchObject({ examined: 0, ok: 0, failed: 0 });
    expect(r.note).toContain('无到档');
  });

  test('发出去的邮件内容确实是中性的', async () => {
    const got: { subject: string; text: string }[] = [];
    seed({ kind: '仲裁时效', dueAt: '2026-09-03' });
    await runReminders(db, { sendMail: async (_to, c) => { got.push(c); }, now: NOW });
    expect(got).toHaveLength(1);
    for (const w of ['仲裁', '劳动', '裁员', '赔偿']) {
      expect(got[0].subject, w).not.toContain(w);
      expect(got[0].text, w).not.toContain(w);
    }
  });
});

describe('🔴 job_runs 接入：三态与"整轮 vs 逐项"', () => {
  const fs2 = require('node:fs') as typeof import('node:fs');
  const os2 = require('node:os') as typeof import('node:os');
  const path2 = require('node:path') as typeof import('node:path');

  function tmpDb(): string {
    const f = path2.join(os2.tmpdir(), `lawer-jr-${Math.random().toString(36).slice(2)}.db`);
    const d = new Database(f);
    runMigrations(d);
    const u = Number(d.prepare("INSERT INTO users (email) VALUES ('x@example.com')").run().lastInsertRowid);
    const c = Number(d.prepare("INSERT INTO cases (user_id,title) VALUES (?, '案')").run(u).lastInsertRowid);
    d.prepare("INSERT INTO deadlines (case_id,kind,due_at) VALUES (?, '仲裁时效', ?)").run(
      c, new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10));
    d.close();
    return f;
  }

  test('干跑不写 job_runs —— 一个只跑干跑的 cron 不该看起来很健康', async () => {
    // 【为什么这条重要】job_runs 记的是"这轮真的做了什么"。给干跑记一行，
    // staleJobs 会以为任务在正常跑 —— **而它一封都没发过**。
    const { reminderCli } = await import('../deadline-reminder');
    const f = tmpDb();
    await reminderCli(f, { apply: false });
    const d = new Database(f, { readonly: true });
    expect((d.prepare('SELECT COUNT(*) c FROM job_runs').get() as { c: number }).c).toBe(0);
    d.close();
    fs2.rmSync(f, { force: true });
  });

  test('🔑 逐项失败 ≠ 整轮失败：SMTP 没配时 ok=1 而 items_failed=1', async () => {
    // 数据表管理定的语义：混了的话「发了 100 封失败 3 封」
    // 与「一封没发成、整个任务崩了」会读起来一样。
    const saved = { h: process.env.SMTP_HOST, u: process.env.SMTP_USERNAME, p: process.env.SMTP_PASSWORD };
    delete process.env.SMTP_HOST; delete process.env.SMTP_USERNAME; delete process.env.SMTP_PASSWORD;
    const { reminderCli } = await import('../deadline-reminder');
    const f = tmpDb();
    const rc = await reminderCli(f, { apply: true });
    expect(rc).toBe(1); // 有发送失败 → 退出码 1
    const d = new Database(f, { readonly: true });
    const row = d.prepare('SELECT * FROM job_runs').get() as Record<string, unknown>;
    expect(row.job_name).toBe('期限提醒');
    expect(row.ok).toBe(1);            // 整轮跑通了
    expect(row.items_failed).toBe(1);  // 其中一封失败
    expect(row.finished_at).toBeTruthy();
    expect(row.error_text).toBeNull(); // 整轮没炸 ⇒ 不写整轮错误
    d.close();
    fs2.rmSync(f, { force: true });
    if (saved.h) process.env.SMTP_HOST = saved.h;
    if (saved.u) process.env.SMTP_USERNAME = saved.u;
    if (saved.p) process.env.SMTP_PASSWORD = saved.p;
  });

  test('发送失败时那条期限没被记档 —— 下轮还会重试', async () => {
    const saved = process.env.SMTP_HOST; delete process.env.SMTP_HOST;
    const { reminderCli } = await import('../deadline-reminder');
    const f = tmpDb();
    await reminderCli(f, { apply: true });
    const d = new Database(f, { readonly: true });
    expect((d.prepare('SELECT notified_stages_json j FROM deadlines').get() as { j: string | null }).j).toBeNull();
    d.close();
    fs2.rmSync(f, { force: true });
    if (saved) process.env.SMTP_HOST = saved;
  });
});
