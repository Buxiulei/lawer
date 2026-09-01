// app/src/lib/billing/__tests__/redeem-issue.test.ts
// 兑换码**签发**侧（管理页与 CLI 共用的那个函数）：码的不可枚举性、批次元数据、
// 面值/张数的守卫，以及「签发出来的码真的能兑」这条端到端闭环。
//
// 【为什么把熵单独立一组】码是凭空造公道值的钥匙，猜中一条就是一笔真钱。
// 而熵不够这件事**不会让任何别的测试变红**：码照样生成、照样能兑、页面一切正常，
// 只是搜索空间小了几个数量级。除了这里，没有别的地方会发现。
import Database from 'better-sqlite3';
import { describe, expect, test } from 'vitest';

import { runMigrations } from '../../db/migrate';
import { toSql } from '../../db/time';
import { getGongdao } from '../index';
import {
  CODE_ALPHABET,
  CODE_LENGTH,
  generateRedeemCode,
  issueRedeemCodes,
  listRedeemCodes,
  redeemCode,
} from '../redeem';

function makeDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const uid = Number(
    db.prepare('INSERT INTO users (email) VALUES (?)').run('admin@t.com').lastInsertRowid,
  );
  return { db, uid };
}

describe('码的熵', () => {
  test('生成 1000 条：零重复', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i += 1) seen.add(generateRedeemCode());
    expect(seen.size).toBe(1000);
  });

  test('长度 ≥16，且只用字母表里的字符', () => {
    expect(CODE_LENGTH).toBeGreaterThanOrEqual(16);
    const allowed = new RegExp(`^[${CODE_ALPHABET}]+$`);
    for (let i = 0; i < 200; i += 1) {
      const code = generateRedeemCode();
      expect(code.length).toBe(CODE_LENGTH);
      expect(code).toMatch(allowed);
    }
  });

  test('字母表里没有易混字符：0 O / 1 I L / U 一个都不出现', () => {
    // 反向断言，不是照抄常量：把 CODE_ALPHABET 改成含 '0O1IL' 的串，这条当场红。
    for (const ch of '0O1ILU') expect(CODE_ALPHABET).not.toContain(ch);
    // 正对照：字母表本身不是空串/退化成一个字符（那样上面每条 not.toContain 也都会绿）
    expect(CODE_ALPHABET.length).toBeGreaterThanOrEqual(30);
    expect(new Set(CODE_ALPHABET).size).toBe(CODE_ALPHABET.length); // 无重复字符
  });

  test('码是归一形：全大写、无空白无分隔符（存进去什么样，用户输什么样）', () => {
    for (let i = 0; i < 50; i += 1) {
      const code = generateRedeemCode();
      expect(code).toBe(code.toUpperCase().trim());
      expect(code).not.toMatch(/[\s-]/);
    }
  });

  /**
   * 字符分布不许有明显偏置。
   *
   * 【这条防的是什么】`byte % 30` 会让字母表前 16 个字符比后 14 个多出 12.5% ——
   * 上面那三条断言全都照绿。16000 个字符下每个字符期望 533 次，
   * 12.5% 的偏置是 ±33，远大于这里给的抖动余量。
   */
  test('字符分布无系统性偏置（拒绝采样有效）', () => {
    const counts = new Map<string, number>();
    const samples = 1000;
    for (let i = 0; i < samples; i += 1) {
      for (const ch of generateRedeemCode()) counts.set(ch, (counts.get(ch) ?? 0) + 1);
    }
    const total = samples * CODE_LENGTH;
    const expected = total / CODE_ALPHABET.length;
    for (const ch of CODE_ALPHABET) {
      const got = counts.get(ch) ?? 0;
      // ±25% 的余量：随机抖动进得来（σ≈23，25% 是 5σ 以上），12.5% 的系统性偏置也进不来——
      // 取模偏置会让**一半的字符**同向偏 12.5%，而不是单个字符偶然偏一次。
      expect(Math.abs(got - expected) / expected).toBeLessThan(0.25);
    }
    // 更硬的一条：前半段字符总数与后半段应当接近。取模偏置正是让前 16 个整体偏高。
    const half = Math.floor(CODE_ALPHABET.length / 2);
    const sum = (chars: string) => [...chars].reduce((a, c) => a + (counts.get(c) ?? 0), 0);
    const front = sum(CODE_ALPHABET.slice(0, half));
    const back = sum(CODE_ALPHABET.slice(half, half * 2));
    expect(Math.abs(front - back) / ((front + back) / 2)).toBeLessThan(0.06);
  });
});

describe('批量签发', () => {
  test('签出的张数、面值、备注、签发人都落库，且码互不相同', () => {
    const { db, uid } = makeDb();
    const codes = issueRedeemCodes(db, {
      count: 25,
      gongdaoValue: 300,
      note: '2026-09 老用户回馈',
      createdBy: uid,
    });
    expect(codes).toHaveLength(25);
    expect(new Set(codes).size).toBe(25);

    const rows = db
      .prepare('SELECT code, gongdao_value, note, created_by, expires_at, enabled FROM redemption_codes')
      .all() as {
      code: string;
      gongdao_value: number;
      note: string | null;
      created_by: number | null;
      expires_at: string | null;
      enabled: number;
    }[];
    expect(rows).toHaveLength(25);
    for (const r of rows) {
      expect(r.gongdao_value).toBe(300);
      expect(r.note).toBe('2026-09 老用户回馈');
      expect(r.created_by).toBe(uid);
      expect(r.expires_at).toBeNull(); // 没填就是不过期，不编一个默认到期日
      expect(r.enabled).toBe(1);
    }
    expect(new Set(rows.map((r) => r.code))).toEqual(new Set(codes));
  });

  test('签出来的码真的兑得动，面值就是签发时那个数', () => {
    const { db, uid } = makeDb();
    const holder = Number(
      db.prepare('INSERT INTO users (email) VALUES (?)').run('u@t.com').lastInsertRowid,
    );
    const [code] = issueRedeemCodes(db, { count: 1, gongdaoValue: 777, createdBy: uid });
    const r = redeemCode(db, holder, code);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.gongdao).toBe(777);
    expect(getGongdao(holder, db)).toBe(777);
  });

  test('小写输入照样兑得动（归一比对）', () => {
    const { db, uid } = makeDb();
    const [code] = issueRedeemCodes(db, { count: 1, gongdaoValue: 50, createdBy: uid });
    expect(redeemCode(db, uid, `  ${code.toLowerCase()}  `).ok).toBe(true);
  });

  test('到期时间写进去，过期码拒兑', () => {
    const { db, uid } = makeDb();
    const past = toSql(new Date(Date.now() - 3600_000));
    const [code] = issueRedeemCodes(db, { count: 1, gongdaoValue: 100, expiresAt: past, createdBy: uid });
    const r = redeemCode(db, uid, code);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('expired');
    expect(getGongdao(uid, db)).toBe(0);
  });

  test('张数/面值非正数被拒，且**一张都不落库**（不是发一半）', () => {
    const { db } = makeDb();
    expect(() => issueRedeemCodes(db, { count: 0, gongdaoValue: 100 })).toThrow(/张数/);
    expect(() => issueRedeemCodes(db, { count: 5, gongdaoValue: 0 })).toThrow(/面值/);
    expect(() => issueRedeemCodes(db, { count: -3, gongdaoValue: 100 })).toThrow();
    expect(db.prepare('SELECT COUNT(*) c FROM redemption_codes').get()).toEqual({ c: 0 });
  });

  test('列表按最新在前，含状态所需的全部字段', () => {
    const { db, uid } = makeDb();
    issueRedeemCodes(db, { count: 3, gongdaoValue: 100, note: '第一批', createdBy: uid });
    const [second] = issueRedeemCodes(db, { count: 1, gongdaoValue: 200, note: '第二批', createdBy: uid });
    const rows = listRedeemCodes(db);
    expect(rows).toHaveLength(4);
    expect(rows[0].code).toBe(second);
    expect(rows[0].note).toBe('第二批');
    expect(rows[0].redeemed_by).toBeNull();

    redeemCode(db, uid, second);
    const after = listRedeemCodes(db);
    expect(after[0].redeemed_by).toBe(uid);
    expect(after[0].redeemed_at).not.toBeNull();
  });
});
