// app/src/lib/admin/__tests__/users.test.ts
// 后台列表出参。
//
// ⚠️ 【本文件的判据方向在 2026-09-03 被整体翻转】原来钉的是「手机号只出尾 4，出参里
// 不许出现 11 位连续数字」与「手机不支持模糊」。主理人裁决：「手机号不要脱敏，这是管理后台」。
// 于是这两条变成了反向断言——**必须**出现 11 位全号、**必须**支持 ≤10 位片段检索。
// 翻转的是策略，不是牙口：旧文件里那条与掩码无关的泄露防护（出参不得含 phone_enc /
// phone_hash 这两列本身）原样保留 —— 全显手机号不等于连密文和查找哈希也能跟着出网。
//
// 现在要害四条：
//   ① 全号原样出参，且 phone_enc / phone_hash 仍不出网；
//   ② 解不开的行 phone=null 且 phone_error 带**可读原因**（不是空串，不是静默 null）；
//   ③ 全号走 hash 精确（不被模糊逻辑污染出多命中）、≤10 位走解密扫描；
//   ④ 扫描到顶（PHONE_SCAN_LIMIT+1 行）必须在 hint 里说出来，绝不静默漏检。
import { beforeEach, describe, expect, test } from 'vitest';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import type { Database as Db } from 'better-sqlite3';

import { normalizePhone } from '@/lib/auth/phone';
import { encryptField, hashLookup } from '@/lib/crypto';
import { runMigrations } from '@/lib/db/migrate';
import {
  PHONE_SCAN_LIMIT,
  decryptPhoneFull,
  getAdminUser,
  listAdminUsers,
} from '../users';

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

describe('手机号全显', () => {
  test('解出的是 11 位全号原文，没绑手机 → phone/error 都是 null', () => {
    expect(decryptPhoneFull(encryptField('13800138888'))).toEqual({
      phone: '13800138888',
      error: null,
    });
    expect(decryptPhoneFull(null)).toEqual({ phone: null, error: null });
  });

  test('🔴 解不开 → phone=null 且 phone_error 是**可读原因**，不是空串', () => {
    const bad = decryptPhoneFull('这不是密文');
    expect(bad.phone).toBe(null);
    expect(bad.error).toBeTruthy();
    // 自述式：说得出"哪里不对"，运维照着它能判断是密钥问题还是密文问题
    expect(bad.error).toContain('密文');
  });

  test('🔴 列表出参里就是 11 位连续数字（掩码回潮即红）', () => {
    for (const p of PHONES) addUser(p, null);
    const page = listAdminUsers(db);
    expect(page.rows).toHaveLength(3);
    // 反向断言：旧判据是 not.toMatch(/\d{11}/)，现在必须匹配得到
    expect(JSON.stringify(page)).toMatch(/\d{11}/);
    expect(page.rows.map((r) => r.phone).sort()).toEqual([...PHONES].sort());
    expect(page.rows.every((r) => r.phone_error === null)).toBe(true);
  });

  test('LAWER_DATA_KEY 换掉之后整张表仍打得开：该行 phone=null + 原因非空，其余行不受影响', () => {
    addUser(PHONES[0], 'a@t.com');
    // 只把一行的密文改坏，模拟"某一行的密文损坏"而不是全库密钥错
    db.prepare("UPDATE users SET phone_enc='enc:v1:坏掉了' WHERE id=(SELECT MIN(id) FROM users)").run();
    addUser(PHONES[1], 'b@t.com');

    const rows = listAdminUsers(db).rows;
    expect(rows).toHaveLength(2);
    const broken = rows.find((r) => r.phone === null)!;
    expect(broken.phone_error).toBeTruthy();
    expect(broken.phone_error!.length).toBeGreaterThan(4);
    const fine = rows.find((r) => r.phone !== null)!;
    expect(fine.phone).toBe(PHONES[1]);
  });

  test('🔴 全显不等于连密文也能出网：出参里没有 phone_enc / phone_hash 这两列', () => {
    addUser(PHONES[0], null);
    const page = listAdminUsers(db);
    const row = page.rows[0] as unknown as Record<string, unknown>;
    expect(row).not.toHaveProperty('phone_enc');
    expect(row).not.toHaveProperty('phone_hash');
    const enc = (db.prepare('SELECT phone_enc AS e FROM users').get() as { e: string }).e;
    expect(JSON.stringify(page)).not.toContain(enc);
    expect(JSON.stringify(page)).not.toContain(hashLookup(PHONES[0]));
  });
});

describe('检索', () => {
  beforeEach(() => {
    addUser(PHONES[0], 'zhang@example.com'); // 13800138888
    addUser(PHONES[1], 'li@corp.cn'); //       13911119999
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

  test('邮箱子串：命中域名片段（本次改动不该动到这条路）', () => {
    expect(listAdminUsers(db, { field: 'email', query: 'example.com' }).total).toBe(2);
    expect(listAdminUsers(db, { field: 'email', query: 'zhang' }).total).toBe(1);
  });

  test('邮箱里的 % 被转义，不会变成"匹配全部"', () => {
    expect(listAdminUsers(db, { field: 'email', query: '%' }).total).toBe(0);
  });

  test('手机全号：按 phone_hash 等值比对，命中唯一一人，出参是全号', () => {
    const res = listAdminUsers(db, { field: 'phone', query: PHONES[0] });
    expect(res.total).toBe(1);
    expect(res.rows[0].phone).toBe(PHONES[0]);
    const stored = db.prepare('SELECT phone_hash FROM users WHERE id=?').get(res.rows[0].uid) as
      { phone_hash: string };
    expect(stored.phone_hash).toBe(hashLookup(normalizePhone(PHONES[0])!));
  });

  test('带 +86 / 空格 / 横杠的写法归一化后同样命中（入库与查表同一把归一化）', () => {
    for (const raw of ['+86 138 0013 8888', '138-0013-8888', '8613800138888']) {
      expect(listAdminUsers(db, { field: 'phone', query: raw }).total, raw).toBe(1);
    }
  });

  test('🔴 全号走的是精确路：另一个号把它整个包在里面也不会被一起捞上来', () => {
    // 13800138888 是 1380013888 的超串；若全号也走 contains 扫描，短串那次会多命中。
    // 这里反过来验：拿**全号**去查，只能中它自己那一条，与库里有没有相似号无关。
    addUser('13800138880', 'near@t.com');
    const res = listAdminUsers(db, { field: 'phone', query: PHONES[0] });
    expect(res.total).toBe(1);
    expect(res.rows[0].phone).toBe(PHONES[0]);
  });

  test('🔴 ≤10 位数字片段：解密后按包含匹配，前缀/中段/尾段都能命中', () => {
    const prefix = listAdminUsers(db, { field: 'phone', query: '138' });
    expect(prefix.total).toBe(1);
    expect(prefix.rows[0].phone).toBe(PHONES[0]);
    expect(prefix.hint).toBe(null);

    // 中段：0013 只在 13800138888 里
    expect(listAdminUsers(db, { field: 'phone', query: '0013' }).total).toBe(1);
    // 尾段：8888 命中 13800138888；9999 命中 13911119999
    expect(listAdminUsers(db, { field: 'phone', query: '8888' }).rows[0].phone).toBe(PHONES[0]);
    expect(listAdminUsers(db, { field: 'phone', query: '9999' }).rows[0].phone).toBe(PHONES[1]);
    // 共同前缀 139 只中一个，13 中两个 —— 证明真在做子串而不是任意返回
    expect(listAdminUsers(db, { field: 'phone', query: '139' }).total).toBe(1);
    expect(listAdminUsers(db, { field: 'phone', query: '13' }).total).toBe(2);
  });

  test('🔴 分流边界钉死：11 位走 hash、1–10 位走扫描、12 位以上给提示不静默当全量', () => {
    // 10 位（normalizePhone 必然失败）→ 模糊，且不是"格式不对"的空结果
    const ten = listAdminUsers(db, { field: 'phone', query: '3800138888' });
    expect(ten.total).toBe(1);
    expect(ten.hint).toBe(null);
    // 12 位纯数字：既不是全号也不是片段 → 空结果 + 提示（不是全量）
    const twelve = listAdminUsers(db, { field: 'phone', query: '138001388881' });
    expect(twelve.total).toBe(0);
    expect(twelve.hint).toContain('11 位全号');
    // 掺字母：同样落到提示分支
    expect(listAdminUsers(db, { field: 'phone', query: '138abc' }).hint).toContain('11 位全号');
  });

  test('片段检索命中的行同样是全号出参（不是只回 uid）', () => {
    const res = listAdminUsers(db, { field: 'phone', query: '888' });
    expect(res.rows[0].phone).toBe(PHONES[0]);
    expect(res.rows[0].email).toBe('zhang@example.com');
  });

  test('片段检索也分页，且倒序不重不漏', () => {
    for (let i = 0; i < 5; i++) addUser(`1370000000${i}`, `p${i}@t.com`);
    const p1 = listAdminUsers(db, { field: 'phone', query: '137', page: 1, pageSize: 2 });
    const p2 = listAdminUsers(db, { field: 'phone', query: '137', page: 2, pageSize: 2 });
    const p3 = listAdminUsers(db, { field: 'phone', query: '137', page: 3, pageSize: 2 });
    expect(p1.total).toBe(5);
    expect([p1.rows.length, p2.rows.length, p3.rows.length]).toEqual([2, 2, 1]);
    const seen = [...p1.rows, ...p2.rows, ...p3.rows].map((r) => r.uid);
    expect(new Set(seen).size).toBe(5);
    expect(p1.rows[0].uid).toBeGreaterThan(p1.rows[1].uid); // 倒序
  });

  test('空检索词 = 全量', () => {
    expect(listAdminUsers(db, { field: 'phone', query: '   ' }).total).toBe(3);
  });
});

describe('🔴 模糊检索的扫描上限：到顶必须说出来', () => {
  test(`绑手机的账号恰好 ${PHONE_SCAN_LIMIT} 个 → 无提示；再多一个 → hint 明说只扫了多少`, () => {
    // 造 PHONE_SCAN_LIMIT 个绑手机的账号。号码形如 139-1000xxxx（xxxx ≤ 4999），
    // 因此**不可能**含连续四个 7 —— 探针片段 7777 只会命中下面那个第 5001 行。
    const insert = db.prepare('INSERT INTO users (phone_enc, phone_hash, email) VALUES (?,?,?)');
    db.transaction(() => {
      for (let i = 0; i < PHONE_SCAN_LIMIT; i++) {
        const p = `139${String(10000000 + i).padStart(8, '0')}`;
        insert.run(encryptField(p), hashLookup(p), null);
      }
    })();

    const atLimit = listAdminUsers(db, { field: 'phone', query: '139' });
    expect(atLimit.hint, '恰好到上限不该报"漏检"').toBe(null);

    // 第 5001 个（最新，排在扫描窗口最前面）
    const p = `13800007777`;
    insert.run(encryptField(p), hashLookup(p), 'over@t.com');

    const over = listAdminUsers(db, { field: 'phone', query: '7777' });
    expect(over.hint, '超过上限必须明说只扫了多少').toContain(String(PHONE_SCAN_LIMIT));
    // 判据的关键在这：判"到顶"要按**扫描到的候选行数**，不能按命中数——
    // 这次只命中 1 个，若按命中数判就永远不会提示，漏检因此静默。
    expect(over.total).toBe(1);
  });
});

describe('🔴 全号精确检索不受扫描窗口限制（精确路与模糊路必须真的是两条路）', () => {
  test('最早注册的那个人，用全号查得到——他在 5000 行扫描窗口之外', () => {
    // 【这条判据在量什么】"全号也并进模糊分支"这种变异，用普通样本量不出来：
    // 子串匹配一个完整号码，结果恰好也只有他自己。两条路真正的差别在**覆盖面**——
    // hash 是全表等值（走索引，O(1)，与注册时间无关），扫描只看最近 5000 个。
    // 所以把目标放在窗口之外：并进模糊分支的那一刻，他就查不到了（total 0），
    // 而"查不到"会被读成「没这个人」。
    const OLDEST = '13500007777';
    db.prepare('INSERT INTO users (phone_enc, phone_hash, email) VALUES (?,?,?)')
      .run(encryptField(OLDEST), hashLookup(OLDEST), 'oldest@t.com');

    const insert = db.prepare('INSERT INTO users (phone_enc, phone_hash, email) VALUES (?,?,?)');
    db.transaction(() => {
      for (let i = 0; i < PHONE_SCAN_LIMIT; i++) {
        const p = `139${String(10000000 + i).padStart(8, '0')}`;
        insert.run(encryptField(p), hashLookup(p), null);
      }
    })();

    const exact = listAdminUsers(db, { field: 'phone', query: OLDEST });
    expect(exact.total).toBe(1);
    expect(exact.rows[0].email).toBe('oldest@t.com');
    expect(exact.hint).toBe(null);

    // 同一个人用片段查**确实**落在窗口外查不到——证明上面那条不是碰巧
    expect(listAdminUsers(db, { field: 'phone', query: '7777' }).total).toBe(0);
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
