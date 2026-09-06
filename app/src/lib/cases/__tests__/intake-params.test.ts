// app/src/lib/cases/__tests__/intake-params.test.ts
// 首诊请求体的「body 键 ↔ 内部字段」对照表（lib/cases/intake-params.ts）。
//
// ─────────────── 这份表是三方共读的，坏了不会有人喊 ───────────────
// 路由按它解请求体、首诊页按它拼请求体、领域包按它声明自己要问哪几格。
// 三方分叉的形态**全是 201**：
//   · 领域包新增一个首诊字段、表里没有 ⇒ 页面照样把它填进请求体，
//     `intakeInputFromBody` 不读它，那一格一路消失，回包 201、用户以为存进去了；
//   · 表里的值列写错一个字（`companyName` 写成 `company_name`）⇒ 落库层读不到，
//     该落的那条事件不落，而没有任何一处会报错。
// 所以这份表要被**两个方向**咬住：包里的每个键都在表里，表里的每个键都真的有人落库。
//
// 本文件的存在也是 intake-params.ts / schemaFlow.ts 两处注释点名承诺过的那一份。
import BetterSqlite3 from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { runMigrations } from '@/lib/db/migrate';
import { DOMAINS } from '@/lib/domains/registry';

import { submitIntake } from '..';
import { intakeInputFromBody } from '../intake';
import { INTAKE_BODY_PARAMS, INTAKE_PARAM_OF_KEY } from '../intake-params';

describe('对照表本身', () => {
  it('两份是同一份的正反面（反查表漏一项 = 页面把那一格发到一个没人读的键上）', () => {
    for (const [param, key] of Object.entries(INTAKE_BODY_PARAMS)) {
      expect(INTAKE_PARAM_OF_KEY[key], `${key} 在反查表里没有`).toBe(param);
    }
    expect(Object.keys(INTAKE_PARAM_OF_KEY).length).toBe(Object.keys(INTAKE_BODY_PARAMS).length);
  });

  it('一个键都不重复（两个 body 键指向同一个字段时，后到的那个会静默盖掉先到的）', () => {
    const keys = Object.values(INTAKE_BODY_PARAMS);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('金额那一格 REST 收的是**分**（与 MCP 面收元不是同一个名字，这正是要有这份表的理由）', () => {
    expect(INTAKE_PARAM_OF_KEY.monthlyWageFen).toBe('monthly_wage_fen');
    for (const pack of Object.values(DOMAINS)) {
      const money = pack.intakeSchema.find((f) => f.key === 'monthlyWageFen');
      if (!money) continue;
      // 包里那一列是 MCP 面的名字，与 REST 面**故意**不同名；两边同名反而会让人以为不用换算
      expect(money.param).not.toBe(INTAKE_PARAM_OF_KEY.monthlyWageFen);
    }
  });
});

describe('intakeInputFromBody：表上的每个键都被真的读进去', () => {
  it('逐键搬运，一个不落', () => {
    const body: Record<string, unknown> = {};
    for (const param of Object.keys(INTAKE_BODY_PARAMS)) body[param] = `值-${param}`;
    const input = intakeInputFromBody(body) as Record<string, unknown>;
    for (const [param, key] of Object.entries(INTAKE_BODY_PARAMS)) {
      // company_docs 另有缺省规则，单独一条
      if (key === 'companyDocs') continue;
      expect(input[key], `${param} 没被读进 ${key}`).toBe(`值-${param}`);
    }
  });

  it('company_docs 整段没给 → 空对象（那一问没答与答了空，落库那侧走同一条路）', () => {
    expect((intakeInputFromBody({}) as Record<string, unknown>).companyDocs).toEqual({});
  });

  it('表上没有的键一律不进入入参（多收一个键 = 悄悄多了一条没人验过的写入路径）', () => {
    const input = intakeInputFromBody({ 我不在表里: 'x' }) as Record<string, unknown>;
    expect(Object.keys(input).sort()).toEqual(Object.values(INTAKE_BODY_PARAMS).slice().sort());
  });
});

describe.each(Object.keys(DOMAINS))('%s 包的每个首诊字段都有人接', (key) => {
  const pack = DOMAINS[key];

  it('intakeSchema 的每个 key 都在对照表里（不在 = 用户填的那一格一路消失，回包 201）', () => {
    const missing = pack.intakeSchema
      .map((f) => f.key)
      .filter((k) => INTAKE_PARAM_OF_KEY[k] === undefined);
    expect(
      missing,
      `这几个首诊字段没有对应的 body 键：${missing.join('、')}\n` +
        '缺什么：REST 首诊这条路收不到它们。\n' +
        '为什么缺：对照表在 lib/cases/intake-params.ts，加字段时要一起加。\n' +
        '怎么办：把键补进 INTAKE_BODY_PARAMS，并确认落库层（intake.persist）真的写它。',
    ).toEqual([]);
  });

  it('填满一份交上去，schema 里声明过的每一格都在库里留下了痕迹（不只是"没报错"）', () => {
    const db = new BetterSqlite3(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    const userId = Number(
      db
        .prepare("INSERT INTO users (phone_hash, auth_status, created_at) VALUES ('h', '未认证', '2026-09-01T00:00:00.000Z')")
        .run().lastInsertRowid,
    );
    const caseId = Number(
      db
        .prepare('INSERT INTO cases (user_id, title, stage, domain, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(userId, '案子', pack.stages[0], key, '2026-09-01T00:00:00.000Z').lastInsertRowid,
    );

    const body: Record<string, unknown> = {};
    for (const f of pack.intakeSchema) {
      const param = INTAKE_PARAM_OF_KEY[f.key];
      switch (f.kind) {
        case 'enum':
          body[param] = (f.values ?? [])[0];
          break;
        case 'date':
          body[param] = '2025-03-04';
          break;
        case 'money':
          body[param] = 80000;
          break;
        case 'stringList':
          body[param] = ['第一项'];
          break;
        case 'eventList':
          body[param] = [{ date: '2026-01-09', text: '发生过一件事' }];
          break;
        case 'record':
          body[param] = Object.fromEntries((f.fields ?? []).map((x) => [x.key, '有']));
          break;
        default:
          body[param] = `填了字-${f.key}`;
      }
    }

    const res = submitIntake(db, { caseId, userId, ...intakeInputFromBody(body) });
    expect(res.ok, `首诊没收下：${JSON.stringify(res)}`).toBe(true);
    if (!res.ok) return;

    const row = db.prepare('SELECT * FROM cases WHERE id = ?').get(caseId) as Record<string, unknown>;
    // 落进 cases 固定列的那几格：读回来不是 null 才算真的接住了
    for (const [fieldKey, column] of Object.entries({
      stage: 'stage',
      employedFrom: 'employed_from',
      monthlyWageFen: 'monthly_wage_fen',
      position: 'position',
      contractCount: 'contract_count',
      bottomLine: 'bottom_line',
      goals: 'goal',
    })) {
      if (!pack.intakeSchema.some((f) => f.key === fieldKey)) continue;
      expect(row[column], `${fieldKey} 填了却没落进 cases.${column}`).not.toBeNull();
    }
    // 事件那三格（自述 / 对方说法 / 手上有哪几份材料 / 用户自己列的事）各落一条
    expect(res.result.timelineAdded).toBeGreaterThan(0);
    // 对方主体落进 company_profiles（那一格问的就是"对面是谁"）
    if (pack.intakeSchema.some((f) => f.key === 'companyName')) {
      const n = (
        db.prepare('SELECT COUNT(*) AS n FROM company_profiles WHERE case_id = ?').get(caseId) as {
          n: number;
        }
      ).n;
      expect(n, 'companyName 填了却没落主体').toBeGreaterThan(0);
    }
    db.close();
  });
});
