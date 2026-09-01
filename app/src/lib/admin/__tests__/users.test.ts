// app/src/lib/admin/__tests__/users.test.ts
// 后台列表出参。要害两条：
//   ① 手机号只出尾 4 —— 出参里**不许出现 11 位连续数字**（变异成全显即红）；
//   ② 手机检索按 phone_hash 等值比对 —— 密文不可模糊匹配，所以只有全号能查得到。
import { beforeEach, describe, expect, test } from 'vitest';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import type { Database as Db } from 'better-sqlite3';

import { normalizePhone } from '@/lib/auth/phone';
import { encryptField, hashLookup } from '@/lib/crypto';
import { runMigrations } from '@/lib/db/migrate';
import { getAdminUser, listAdminUsers, maskPhoneTail4 } from '../users';

let db: Db;

const PHONES = ['13800138888', '13911119999', '15800001234'];

function addUser(phone: string | null, email: string | null): number {
  const enc = phone ? encryptField(phone) : null;
  const hash = phone ? hashLookup(phone) : null;
  return Number(
    db.prepare('INSERT INTO users (phone_enc, phone_hash, email) VALUES (?,?,?)').run(enc, hash, email)
      .lastInsertRowid,
  );
}

beforeEach(() => {
  process.env.LAWER_DATA_KEY = crypto.randomBytes(32).toString('base64');
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
});

describe('手机号掩码', () => {
  test('只留尾 4，前面固定四颗星', () => {
    expect(maskPhoneTail4(encryptField('13800138888'))).toBe('****8888');
    expect(maskPhoneTail4(encryptField('15800001234'))).toBe('****1234');
  });

  test('没绑手机 → null；密文解不开 → null，绝不回落明文', () => {
    expect(maskPhoneTail4(null)).toBe(null);
    expect(maskPhoneTail4('这不是密文')).toBe(null);
  });

  test('列表出参里不含任何 11 位连续数字（全显即红）', () => {
    for (const p of PHONES) addUser(p, null);
    const page = listAdminUsers(db);
    expect(page.rows).toHaveLength(3);
    const serialized = JSON.stringify(page);
    expect(serialized).not.toMatch(/\d{11}/);
    // 反向锚：确实取到了尾 4，不是因为整列都空才"没有 11 位数字"
    expect(page.rows.map((r) => r.phone_masked).sort()).toEqual(['****1234', '****8888', '****9999']);
  });

  test('出参里不含 phone_enc / phone_hash 这两列本身', () => {
    addUser(PHONES[0], null);
    const row = listAdminUsers(db).rows[0] as unknown as Record<string, unknown>;
    expect(row).not.toHaveProperty('phone_enc');
    expect(row).not.toHaveProperty('phone_hash');
  });
});

describe('检索', () => {
  beforeEach(() => {
    addUser(PHONES[0], 'zhang@example.com');
    addUser(PHONES[1], 'li@corp.cn');
    addUser(null, 'wang@example.com');
  });

  test('uid 精确：只命中那一个，不做前缀匹配', () => {
    const all = listAdminUsers(db).rows;
    const one = listAdminUsers(db, { field: 'uid', query: String(all[0].uid) });
    expect(one.total).toBe(1);
    expect(one.rows[0].uid).toBe(all[0].uid);
    expect(listAdminUsers(db, { field: 'uid', query: '99999' }).total).toBe(0);
  });

  test('uid 填了非数字 → 空结果 + 人话提示（不静默当全量）', () => {
    const res = listAdminUsers(db, { field: 'uid', query: 'abc' });
    expect(res.total).toBe(0);
    expect(res.hint).toBe('UID 只能是数字');
  });

  test('邮箱子串：命中域名片段', () => {
    expect(listAdminUsers(db, { field: 'email', query: 'example.com' }).total).toBe(2);
    expect(listAdminUsers(db, { field: 'email', query: 'zhang' }).total).toBe(1);
  });

  test('邮箱里的 % 被转义，不会变成"匹配全部"', () => {
    expect(listAdminUsers(db, { field: 'email', query: '%' }).total).toBe(0);
  });

  test('手机全号：按 phone_hash 等值比对，命中唯一一人', () => {
    const res = listAdminUsers(db, { field: 'phone', query: PHONES[0] });
    expect(res.total).toBe(1);
    expect(res.rows[0].phone_masked).toBe('****8888');
    // 判据锚：查得到的那一行，其 phone_hash 就是 hashLookup(归一化手机号)
    const stored = db.prepare('SELECT phone_hash FROM users WHERE id=?').get(res.rows[0].uid) as
      { phone_hash: string };
    expect(stored.phone_hash).toBe(hashLookup(normalizePhone(PHONES[0])!));
  });

  test('带 +86 / 空格 / 横杠的写法归一化后同样命中（入库与查表同一把归一化）', () => {
    for (const raw of ['+86 138 0013 8888', '138-0013-8888', '8613800138888']) {
      expect(listAdminUsers(db, { field: 'phone', query: raw }).total, raw).toBe(1);
    }
  });

  test('手机不支持模糊：给前缀查不到，且给的是"格式不对"而不是"查无此人"', () => {
    const res = listAdminUsers(db, { field: 'phone', query: '138' });
    expect(res.total).toBe(0);
    expect(res.hint).toContain('11 位全号');
  });

  test('空检索词 = 全量', () => {
    expect(listAdminUsers(db, { field: 'phone', query: '   ' }).total).toBe(3);
  });
});

describe('列表内容与分页', () => {
  test('会员档/到期取有效行里最晚那条；过期行不算', () => {
    const uid = addUser(PHONES[0], 'a@t.com');
    db.prepare(
      "INSERT INTO memberships (user_id, plan, order_no, expires_at) VALUES (?,?,?, datetime('now','-1 day'))",
    ).run(uid, 'pro', 'expired-1');
    expect(listAdminUsers(db).rows[0].plan).toBe(null);

    db.prepare(
      "INSERT INTO memberships (user_id, plan, order_no, expires_at) VALUES (?,?,?, datetime('now','+31 days'))",
    ).run(uid, 'entry', 'live-1');
    const row = listAdminUsers(db).rows[0];
    expect(row.plan).toBe('entry');
    expect(row.plan_expires_at).toBeTruthy();
  });

  test('余额与案件数取真值（无行 = 0，不是 null）', () => {
    const uid = addUser(null, 'b@t.com');
    let row = listAdminUsers(db).rows[0];
    expect(row.balance).toBe(0);
    expect(row.case_count).toBe(0);

    db.prepare('INSERT INTO gongdao (user_id, balance) VALUES (?,?)').run(uid, 777);
    db.prepare("INSERT INTO cases (user_id, title) VALUES (?, '甲')").run(uid);
    db.prepare("INSERT INTO cases (user_id, title) VALUES (?, '乙')").run(uid);
    row = listAdminUsers(db).rows[0];
    expect(row.balance).toBe(777);
    expect(row.case_count).toBe(2);
  });

  test('分页：倒序（新注册在前）、total 是过滤后的总数、翻页不重不漏', () => {
    const uids: number[] = [];
    for (let i = 0; i < 25; i++) uids.push(addUser(null, `u${i}@t.com`));

    const p1 = listAdminUsers(db, { page: 1, pageSize: 10 });
    const p2 = listAdminUsers(db, { page: 2, pageSize: 10 });
    const p3 = listAdminUsers(db, { page: 3, pageSize: 10 });
    expect(p1.total).toBe(25);
    expect(p1.rows).toHaveLength(10);
    expect(p3.rows).toHaveLength(5);
    expect(p1.rows[0].uid).toBe(uids[uids.length - 1]); // 最新的在最前
    const seen = [...p1.rows, ...p2.rows, ...p3.rows].map((r) => r.uid);
    expect(new Set(seen).size).toBe(25);
  });

  test('getAdminUser：查得到给行，查不到给 null', () => {
    const uid = addUser(PHONES[0], 'c@t.com');
    expect(getAdminUser(db, uid)?.uid).toBe(uid);
    expect(getAdminUser(db, 99999)).toBe(null);
  });
});
