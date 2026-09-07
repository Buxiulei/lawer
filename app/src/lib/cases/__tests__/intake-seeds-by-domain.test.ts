// app/src/lib/cases/__tests__/intake-seeds-by-domain.test.ts
// 首诊「现在做这三件事」按领域给（P4-W3 把种子表从共用层搬进 DomainPack.intakeStageActions）。
//
// 【这一组拦的是一个不报错的空屏】搬家之前那张表按上一个行当的阶段名建键，住在共用层。
// 第二个领域接进来时它的 stage 在表里一个都对不上，`?? []` 于是给 0 条种子：
// 首诊回包 `actionsAdded: 0`、HTTP 200、日志干净，用户做完首诊看到的那一屏是空的——
// 而他分不清这是故障，还是"这个阶段本来就没事可做"。**两种情况在产出上完全同形**，
// 所以下面既钉"有种子的阶段真落了库"，也钉"没有种子的阶段是包里写着的空数组，不是缺键"。
import crypto from 'node:crypto';

import Database from 'better-sqlite3';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import * as cases from '@/lib/cases';
import { listActionItems } from '@/lib/db/cases';
import { runMigrations } from '@/lib/db/migrate';
import { assertDomainPack, DEFAULT_DOMAIN, DOMAINS, DOMAINS_ENABLED_ENV } from '@/lib/domains/registry';
import type { DomainPack } from '@/lib/domains/registry';

const COUNSELING = DOMAINS.counseling;

let db: Database.Database;
let uid: number;

beforeAll(() => {
  process.env.LAWER_DATA_KEY = crypto.randomBytes(32).toString('base64');
});

beforeEach(() => {
  process.env[DOMAINS_ENABLED_ENV] = `${DEFAULT_DOMAIN},counseling`;
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  uid = Number(db.prepare('INSERT INTO users (phone_hash) VALUES (?)').run('seed').lastInsertRowid);
});

function makeCase(domain: string): number {
  const made = cases.ensureDefaultCase(db, uid, domain);
  if ('ok' in made) throw new Error(`建案失败：${JSON.stringify(made)}`);
  return made.caseId;
}

/**
 * 走完一次真首诊，回落库结果。字段名是跨领域不变的那一份（见 counseling.ts 的头注释），
 * `extra` 用来补上某个领域自己必填的格子（缺省领域要 employedFrom，本领域不要）。
 */
function submit(caseId: number, stage: string, extra: Record<string, unknown> = {}) {
  const r = cases.submitIntake(db, {
    caseId,
    userId: uid,
    stage,
    companyName: '来访A',
    goals: ['把这件事了结'],
    events: [{ date: '2026-08-01', text: '对方提出退费' }],
    ...extra,
  } as Parameters<typeof cases.submitIntake>[1]);
  if (!('ok' in r) || !r.ok) throw new Error(`首诊失败：${JSON.stringify(r)}`);
  return r.result;
}

describe('首诊三件事按案件领域取', () => {
  it('counseling 案件做完首诊，三件事真的进了库（搬家前这里是 0 条且不报错）', () => {
    const caseId = makeCase('counseling');
    const stage = '来访投诉';
    const seeds = COUNSELING.intakeStageActions[stage];
    expect(seeds.length, '这条判据依赖这个阶段有种子，包里改空了它就变成空跑').toBe(3);

    const result = submit(caseId, stage);
    expect(result.actionsAdded, '首诊回包说加了 0 条待办——那一屏是空的').toBe(seeds.length);

    // 落库的是**包里那三条**，不是别的领域那三条：只看条数的判据在两个包都给三条时会一起绿。
    const stored = listActionItems(db, caseId, null);
    expect(stored.map((a) => a.title).sort()).toEqual(seeds.map((s) => s.title).sort());
  });

  it('越靠前越急：种子第 0 条拿到最大的 priority（驾驶舱按 priority 降序只推一件）', () => {
    const caseId = makeCase('counseling');
    const seeds = COUNSELING.intakeStageActions['来访投诉'];
    submit(caseId, '来访投诉');
    const byTitle = new Map(listActionItems(db, caseId, null).map((a) => [a.title, a.priority]));
    // 直接用 i+1 的写法会让最急的那件排到最后，而它看起来完全正常
    expect(byTitle.get(seeds[0].title)!).toBeGreaterThan(byTitle.get(seeds[2].title)!);
  });

  it('包里写着空数组的阶段落 0 条——这是结论，不是"表里没有这个键"', () => {
    const caseId = makeCase('counseling');
    expect(COUNSELING.intakeStageActions['执行']).toEqual([]);
    expect(submit(caseId, '执行').actionsAdded).toBe(0);
  });

  it('缺省领域的同一条路逐字不变（搬家没换掉另一个领域的那份）', () => {
    const pack = DOMAINS[DEFAULT_DOMAIN];
    const stage = pack.stages.find((s) => pack.intakeStageActions[s].length > 0)!;
    const caseId = makeCase(DEFAULT_DOMAIN);
    const result = submit(caseId, stage, { employedFrom: '2020-01-01', monthlyWageFen: 2_000_000 });
    expect(result.actionsAdded).toBe(pack.intakeStageActions[stage].length);
    expect(listActionItems(db, caseId, null).map((a) => a.title).sort()).toEqual(
      pack.intakeStageActions[stage].map((s) => s.title).sort(),
    );
  });
});

describe('装载时就点名的两种缺项（缺键与多键在产出上都是 0 条）', () => {
  /** 拿一个真包改一处：只改这一项，其余字段原样，免得红的理由被换成别的。 */
  function tweak(patch: Partial<DomainPack>): DomainPack {
    return { ...COUNSELING, ...patch };
  }

  it('新增了一个 stage 却没给它种子 ⇒ assertDomainPack 点名说缺哪个阶段', () => {
    const pack = tweak({ stages: [...COUNSELING.stages, '新加的阶段'] });
    expect(() => assertDomainPack(pack)).toThrow(/新加的阶段/);
  });

  it('种子表里有一个不是本领域阶段的键 ⇒ 同样点名（那份文案永远画不出来）', () => {
    const pack = tweak({
      intakeStageActions: { ...COUNSELING.intakeStageActions, 打错的阶段名: [] },
    });
    expect(() => assertDomainPack(pack)).toThrow(/打错的阶段名/);
  });

  it('整项忘了填 ⇒ 点名 intakeStageActions（不是等到首诊那一刻才静静给 0 条）', () => {
    const pack = tweak({ intakeStageActions: undefined as unknown as DomainPack['intakeStageActions'] });
    expect(() => assertDomainPack(pack)).toThrow(/intakeStageActions/);
  });

  it('每个已挂上的领域包，种子表的键与 stages 一一对应（不空跑：包一多这条就是唯一的普查）', () => {
    for (const [key, pack] of Object.entries(DOMAINS)) {
      expect([...Object.keys(pack.intakeStageActions)].sort(), `${key} 的种子表键集合`).toEqual(
        [...pack.stages].sort(),
      );
    }
    expect(Object.keys(DOMAINS).length, '只剩一个包时上面那条退化成自说自话').toBeGreaterThanOrEqual(2);
  });
});
