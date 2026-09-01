// app/src/lib/billing/__tests__/ledger-view.test.ts
// P0-2：「我的」页此前渲染的是 @/app/_mock/authpay 的 15 条演示条目 + 由它算出的假余额。
// 这里锁死真实读函数的行为——**核心判据是"新账户只看得见自己的真实条目"**，
// 而不是"接口有返回"。后者接了 mock 也成立。
import Database from 'better-sqlite3';
import { describe, expect, test } from 'vitest';

import { runMigrations } from '../../db/migrate';
import { getGongdao, gongdaoGrant, gongdaoSettle, listGongdaoLedger } from '../index';

function makeDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const uid = (email: string) =>
    Number(db.prepare('INSERT INTO users (email) VALUES (?)').run(email).lastInsertRowid);
  return { db, a: uid('a@t.com'), b: uid('b@t.com') };
}

describe('新注册账户', () => {
  test('流水为空、余额为 0——不是 15 条演示条目', () => {
    const { db, a } = makeDb();
    const v = listGongdaoLedger(a, 50, db);
    expect(v.entries).toEqual([]);
    expect(v.balance).toBe(0);
    expect(v.ledger_sum).toBe(0);
  });

  test('空账户的返回里不含任何演示条目的特征词', () => {
    // 【为什么单列这条】上一条断言 `[]`，那只在"接对了"时有意义；
    // 若哪天有人给空账户加了"示例数据"兜底，上一条会红——但**红得像个功能变更**。
    // 这一条把 P0-2 的病灶本身钉住：演示账目的字样一个都不许出现在响应里。
    const { db, a } = makeDb();
    const json = JSON.stringify(listGongdaoLedger(a, 50, db));
    for (const demo of ['中配月卡', '兑换码', '演示', 'demo', 'mock']) {
      expect(json, demo).not.toContain(demo);
    }
  });
});

describe('真实条目', () => {
  test('入账与消耗都如实出现，条数与内容对得上', () => {
    const { db, a } = makeDb();
    gongdaoGrant(a, 1000, '充值', 'order-1', null, db);
    gongdaoSettle(a, 120, 'turn-1', '问诊', null, db);

    const v = listGongdaoLedger(a, 50, db);
    expect(v.entries).toHaveLength(2);
    expect(v.entries.map((e) => e.type)).toEqual(['消耗', '充值']); // 倒序，最新在前
    expect(v.balance).toBe(880);
    expect(v.ledger_sum).toBe(880);
  });

  test('balance_after 由余额倒推，分页下也正确', () => {
    const { db, a } = makeDb();
    gongdaoGrant(a, 100, '充值', 'o1', null, db);
    gongdaoGrant(a, 200, '充值', 'o2', null, db);
    gongdaoSettle(a, 50, 't1', '问诊', null, db);
    // 余额 250；倒序为 [-50, +200, +100]
    const full = listGongdaoLedger(a, 50, db);
    expect(full.entries.map((e) => e.balance_after)).toEqual([250, 300, 100]);

    // 【关键】只取最新一条时，它的 balance_after 仍必须是 250——
    // 正向累加的写法在这里会算成 -50，那正是分页会引入的错。
    const page = listGongdaoLedger(a, 1, db);
    expect(page.entries).toHaveLength(1);
    expect(page.entries[0].balance_after).toBe(250);
  });
});

describe('隔离与诚实', () => {
  test('甲的流水不出现在乙的视图里', () => {
    const { db, a, b } = makeDb();
    gongdaoGrant(a, 500, '充值', 'oa', null, db);
    expect(listGongdaoLedger(b, 50, db).entries).toEqual([]);
    expect(listGongdaoLedger(b, 50, db).balance).toBe(0);
    expect(listGongdaoLedger(a, 50, db).entries).toHaveLength(1);
  });

  test('物化余额与账本不符时，两个数都露出来而不是只报一个', () => {
    const { db, a } = makeDb();
    gongdaoGrant(a, 300, '充值', 'o1', null, db);
    // 人为制造不符（对账器判错的那种情形）
    db.prepare('UPDATE gongdao SET balance = balance + 999 WHERE user_id=?').run(a);

    const v = listGongdaoLedger(a, 50, db);
    expect(v.balance).toBe(1299);
    expect(v.ledger_sum).toBe(300);
    // 【这条断言的是"不符可见"】若接口只返回一个数，页面会渲染出
    // 一个**看起来完全正常的错数**，而这一页写着「每一笔都记着只增不改」。
    expect(v.balance).not.toBe(v.ledger_sum);
  });

  test('getGongdao 与本视图的 balance 是同一个数（不许两处各算各的）', () => {
    const { db, a } = makeDb();
    gongdaoGrant(a, 77, '充值', 'o1', null, db);
    expect(listGongdaoLedger(a, 50, db).balance).toBe(getGongdao(a, db));
  });
});
