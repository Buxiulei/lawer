// app/src/lib/paste/__tests__/crisis-by-domain.test.ts
// 无工具模式回填的危机判据也按**这个案件所属领域**走（设计稿 §13「危机」行）。
//
// 【为什么这条要单独钉】危机判定与首段在站内对话那条路上已经按领域走了，
// 而回填这条路（用户把助手那一轮回复整段粘回来）此前仍取缺省领域——
// 失效形态是：第二个领域的用户粘回来的那段里有他自己领域的危机表述，
// **这一次预览什么都没提示**，结构块照常解析、回包照常 200，没有一处会报错。
import Database from 'better-sqlite3';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { runMigrations } from '@/lib/db/migrate';
import { DEFAULT_DOMAIN, DOMAINS, type DomainPack } from '@/lib/domains/registry';
import { assembleCrisisOpener, type CrisisOpenerText } from '@/lib/agent/crisis-opener';

import { crisisNotice, previewPasteBack } from '..';

const FAKE_KEY = '假领域-回填危机判据专用';
const OPENER: CrisisOpenerText = {
  head: ['假领域回填首段第一行。', '假领域回填首段第二行：'],
  tail: '假领域回填收束句。',
};
const LABOR_PACK = DOMAINS[DEFAULT_DOMAIN];
const FAKE_PACK: DomainPack = {
  ...LABOR_PACK,
  key: FAKE_KEY,
  crisis: {
    ...LABOR_PACK.crisis,
    lexicon: ['甲乙丙'],
    negations: ['并非'],
    openerText: OPENER,
    firstSegment: (ctx) => assembleCrisisOpener(OPENER, ctx.facts, { compact: ctx.compact }),
  },
};

let db: Database.Database;
let userId: number;
let fakeCase: number;
let laborCase: number;

beforeAll(() => {
  DOMAINS[FAKE_KEY] = FAKE_PACK;
});
afterAll(() => {
  delete DOMAINS[FAKE_KEY];
});

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  userId = Number(db.prepare('INSERT INTO users (phone_hash) VALUES (?)').run('a').lastInsertRowid);
  fakeCase = Number(
    db.prepare('INSERT INTO cases (user_id, title, domain) VALUES (?, ?, ?)').run(userId, '假领域的案子', FAKE_KEY)
      .lastInsertRowid,
  );
  laborCase = Number(
    db.prepare('INSERT INTO cases (user_id, title) VALUES (?, ?)').run(userId, '缺省领域的案子').lastInsertRowid,
  );
});

/** 这两句里各自只有对方词表认不出的那个词 */
const FAKE_TERM_TEXT = '我最近总是甲乙丙，说不下去了';
const LABOR_TERM_TEXT = `我最近总觉得${LABOR_PACK.crisis.lexicon[0]}`;

describe('crisisNotice 的领域参数（变异：把 domain 参数忽略掉 → 红）', () => {
  it('传假领域 ⇒ 认假包的词、用假包的首段；缺省领域的词在它这里不触发', () => {
    const got = crisisNotice(FAKE_TERM_TEXT, FAKE_KEY);
    expect(got.triggered).toBe(true);
    expect(got.message).toContain(OPENER.head[0]);
    expect(crisisNotice(LABOR_TERM_TEXT, FAKE_KEY).triggered).toBe(false);
  });

  it('不传 ⇒ 仍按缺省领域（既有调用方行为逐字不变）', () => {
    expect(crisisNotice(LABOR_TERM_TEXT).triggered).toBe(true);
    expect(crisisNotice(FAKE_TERM_TEXT).triggered).toBe(false);
  });
});

describe('previewPasteBack 把案件领域真的传下去（变异：调用处不传 owned.case.domain → 红）', () => {
  it('假领域的案子：粘回来的危机表述被接住，提示里是假包的首段', () => {
    const got = previewPasteBack(db, { caseId: fakeCase, userId, text: FAKE_TERM_TEXT }) as {
      crisis?: { triggered: boolean; message: string | null };
    };
    expect(got.crisis?.triggered).toBe(true);
    expect(got.crisis?.message).toContain(OPENER.head[0]);
  });

  it('同一段话贴进缺省领域的案子 ⇒ 不触发（词表真的按案件换了，不是两份并集）', () => {
    const got = previewPasteBack(db, { caseId: laborCase, userId, text: FAKE_TERM_TEXT }) as {
      crisis?: { triggered: boolean };
    };
    expect(got.crisis?.triggered).toBe(false);
  });

  it('缺省领域的案子照旧接住缺省领域的表述（自证上一条不是"整层没了"）', () => {
    const got = previewPasteBack(db, { caseId: laborCase, userId, text: LABOR_TERM_TEXT }) as {
      crisis?: { triggered: boolean; message: string | null };
    };
    expect(got.crisis?.triggered).toBe(true);
    expect(got.crisis?.message).toContain(LABOR_PACK.crisis.openerText.head[0]);
  });
});
