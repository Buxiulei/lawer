// app/src/lib/notify/__tests__/deadline-reminder.test.ts
// 期限提醒的档位与去重语义。
//
// 【这里的失败代价不对称，判据也要跟着不对称】
// 多发一封 = 打扰；漏发一封 = 用户错过仲裁时效，**权利灭失，没有救济**。
// 所以每一条"不发"的分支都要单独钉住，而"多发"只需要不至于每分钟轰炸。
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, test } from 'vitest';

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
