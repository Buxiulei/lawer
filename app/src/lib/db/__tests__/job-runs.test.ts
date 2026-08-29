import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../migrate';
import * as store from '../job-runs';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
});

/**
 * 把一行的时间戳整体往前推 N 小时（started_at 与 finished_at 同幅度平移）。
 * 判据里的「太久」是相对 datetime('now') 的，测试不能靠等——只能把库里的行做旧。
 */
function backdate(runId: number, hours: number): void {
  db.prepare(
    `UPDATE job_runs
        SET started_at  = datetime(started_at, ?),
            finished_at = CASE WHEN finished_at IS NULL THEN NULL ELSE datetime(finished_at, ?) END
      WHERE id = ?`,
  ).run(`-${hours} hours`, `-${hours} hours`, runId);
}

const DAILY = [{ name: '期限提醒', maxAgeHours: 24 }];

describe('三态可分辨（本表存在的全部理由）', () => {
  it('没有行 / 有行未跑完 / 有行已跑完 —— lastRun 与 staleJobs 都分成三类，不是两类', () => {
    const jobs = [
      { name: '从没跑过的任务', maxAgeHours: 24 },
      { name: '跑起来没跑完的任务', maxAgeHours: 24 },
      { name: '跑完了的任务', maxAgeHours: 24 },
    ];

    // ① 没有行：什么都不做
    // ② 有行、finished_at IS NULL：开跑了没回填，且做旧到超过阈值（真崩掉的那次）
    const stuck = store.startRun(db, '跑起来没跑完的任务');
    backdate(stuck, 48);
    // ③ 有行、finished_at 非空
    const done = store.startRun(db, '跑完了的任务');
    store.finishRun(db, done, { ok: true, itemsExamined: 3 });

    // lastRun 分得开：查无此行 / 有行但 finished_at 为空 / 有行且 finished_at 非空
    expect(store.lastRun(db, '从没跑过的任务')).toBeUndefined();
    const stuckRow = store.lastRun(db, '跑起来没跑完的任务')!;
    expect(stuckRow.finished_at).toBeNull();
    expect(stuckRow.ok).toBeNull(); // 未跑完 ⇒ ok 也还没有结论，不许被默认值占掉
    const doneRow = store.lastRun(db, '跑完了的任务')!;
    expect(doneRow.finished_at).not.toBeNull();
    expect(doneRow.ok).toBe(1);

    // staleJobs 报出两类异常 + 一个健康任务，三者互不混淆
    const stale = store.staleJobs(db, jobs);
    expect(stale.map((s) => [s.name, s.reason])).toEqual([
      ['从没跑过的任务', '从未跑过'],
      ['跑起来没跑完的任务', '未跑完'],
    ]);
    expect(stale.map((s) => s.name)).not.toContain('跑完了的任务');
  });

  it('startRun 只落开跑那一行：finished_at / ok / items_examined / error_text 全空', () => {
    const id = store.startRun(db, '期限提醒');
    const row = store.lastRun(db, '期限提醒')!;
    expect(row.id).toBe(id);
    expect(row.job_name).toBe('期限提醒');
    expect(row.started_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/); // canonical（ADR-002）
    expect(row.finished_at).toBeNull();
    expect(row.ok).toBeNull();
    expect(row.items_examined).toBeNull();
    expect(row.error_text).toBeNull();
  });
});

describe('崩溃场景：startRun 之后没有 finishRun', () => {
  it('做旧到超过阈值后被报成「未跑完」，且 detail 说得出是哪一种异常', () => {
    const id = store.startRun(db, '期限提醒');
    backdate(id, 48);
    const [hit, ...rest] = store.staleJobs(db, DAILY);
    expect(rest).toHaveLength(0);
    expect(hit.reason).toBe('未跑完');
    expect(hit.lastRun!.id).toBe(id);
    expect(hit.detail).toContain('没有跑完');
  });

  it('刚开跑还没跑完的那一轮不报（否则每一轮正常运行都会响一次警）', () => {
    store.startRun(db, '期限提醒');
    expect(store.staleJobs(db, DAILY)).toEqual([]);
  });

  it('崩过一次、下一轮正常跑完之后不再报（按最近一次判，不是按历史里有没有崩过）', () => {
    backdate(store.startRun(db, '期限提醒'), 48);
    store.finishRun(db, store.startRun(db, '期限提醒'), { ok: true, itemsExamined: 1 });
    expect(store.staleJobs(db, DAILY)).toEqual([]);
  });
});

describe('items_examined = 0 不等于没跑', () => {
  it('一次 ok=1, items_examined=0 的运行不被 staleJobs 报出', () => {
    const id = store.startRun(db, '期限提醒');
    store.finishRun(db, id, { ok: true, itemsExamined: 0 });
    expect(store.lastRun(db, '期限提醒')!.items_examined).toBe(0);
    expect(store.staleJobs(db, DAILY)).toEqual([]);
  });

  it('0 与「没填」在库里是两回事：0 是「跑了，没有可做的」，NULL 才是没结论', () => {
    store.finishRun(db, store.startRun(db, 'A'), { ok: true, itemsExamined: 0 });
    store.finishRun(db, store.startRun(db, 'B'), { ok: true });
    expect(store.lastRun(db, 'A')!.items_examined).toBe(0);
    expect(store.lastRun(db, 'B')!.items_examined).toBeNull();
  });
});

describe('error_text 原文', () => {
  it('失败运行能把原始错误串一字不差取回来', () => {
    const raw = '天眼查 API 429 Too Many Requests: quota exhausted for appKey=***, retry after 3600s';
    const id = store.startRun(db, '公司监控巡检');
    store.finishRun(db, id, { ok: false, itemsExamined: 7, errorText: raw });
    const row = store.lastRun(db, '公司监控巡检')!;
    expect(row.ok).toBe(0);
    expect(row.error_text).toBe(raw);
    expect(row.items_examined).toBe(7); // 失败前已经检查过的项数照样留着
    expect(row.finished_at).not.toBeNull(); // 失败也是「跑完了」，不是「未跑完」
  });

  it('ok=false 且 errorText 为空直接抛错，且不落回填（禁止只写「失败」）', () => {
    const id = store.startRun(db, '公司监控巡检');
    expect(() => store.finishRun(db, id, { ok: false })).toThrow(/原文/);
    expect(() => store.finishRun(db, id, { ok: false, errorText: '   ' })).toThrow(/原文/);
    expect(store.lastRun(db, '公司监控巡检')!.finished_at).toBeNull();
  });

  it('runId 查无此行时抛错，不静默 0 行（静默会让那一行永远停在未跑完）', () => {
    expect(() => store.finishRun(db, 99999, { ok: true })).toThrow(/查无此行/);
  });
});

describe('对照臂：健康任务一个都不许报', () => {
  it('刚跑完、ok=1 的任务不在清单里（不然「全都报」和「判据坏了」输出一样）', () => {
    for (const name of ['期限提醒', '公道值对账', '公司监控巡检']) {
      store.finishRun(db, store.startRun(db, name), { ok: true, itemsExamined: 2 });
    }
    expect(
      store.staleJobs(db, [
        { name: '期限提醒', maxAgeHours: 24 },
        { name: '公道值对账', maxAgeHours: 24 },
        { name: '公司监控巡检', maxAgeHours: 24 },
      ]),
    ).toEqual([]);
  });

  it('健康与异常混在一起时只报异常那些，且不误伤同库里的其它任务', () => {
    store.finishRun(db, store.startRun(db, '期限提醒'), { ok: true, itemsExamined: 2 });
    const oldId = store.startRun(db, '公道值对账');
    store.finishRun(db, oldId, { ok: true });
    backdate(oldId, 48);

    const stale = store.staleJobs(db, [
      { name: '期限提醒', maxAgeHours: 24 },
      { name: '公道值对账', maxAgeHours: 24 },
      { name: '公司监控巡检', maxAgeHours: 24 },
    ]);
    expect(stale.map((s) => [s.name, s.reason])).toEqual([
      ['公道值对账', '太久没跑'],
      ['公司监控巡检', '从未跑过'],
    ]);
  });

  it('跑完但失败（ok=0）不算「超期未跑」——staleJobs 只管跑没跑，失败请读 lastRun().ok', () => {
    store.finishRun(db, store.startRun(db, '期限提醒'), { ok: false, errorText: 'SMTP 421' });
    expect(store.staleJobs(db, DAILY)).toEqual([]);
    expect(store.lastRun(db, '期限提醒')!.ok).toBe(0);
  });

  it('maxAgeHours 非法当场抛错，不悄悄返回空清单（配置写错等于这个任务没人盯）', () => {
    expect(() => store.staleJobs(db, [{ name: '期限提醒', maxAgeHours: Number.NaN }])).toThrow(
      /maxAgeHours/,
    );
    expect(() => store.staleJobs(db, [{ name: '期限提醒', maxAgeHours: -1 }])).toThrow(
      /maxAgeHours/,
    );
  });
});

describe('lastRun', () => {
  it('多轮之后取的是最新那一轮（按 id，不按秒精度的时间串）', () => {
    const first = store.startRun(db, '期限提醒');
    store.finishRun(db, first, { ok: false, errorText: '第一轮：网关超时' });
    const second = store.startRun(db, '期限提醒');
    store.finishRun(db, second, { ok: true, itemsExamined: 5 });
    const row = store.lastRun(db, '期限提醒')!;
    expect(row.id).toBe(second);
    expect(row.ok).toBe(1);
  });

  it('按任务名各查各的，互不串台', () => {
    store.finishRun(db, store.startRun(db, '期限提醒'), { ok: true });
    expect(store.lastRun(db, '公道值对账')).toBeUndefined();
  });
});

describe('迁移幂等', () => {
  it('runMigrations 连跑两次，sqlite_master 快照一致', () => {
    const snapshot = () =>
      db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all();
    const before = snapshot();
    runMigrations(db);
    expect(snapshot()).toEqual(before);
  });

  it('建出了 job_runs 与它的读取索引', () => {
    const names = (
      db.prepare('SELECT name FROM sqlite_master WHERE name LIKE ?').all('%job_runs%') as {
        name: string;
      }[]
    ).map((r) => r.name);
    expect(names).toContain('job_runs');
    expect(names).toContain('idx_job_runs_name');
  });
});
