// app/src/lib/__tests__/complaints.test.ts
// 投诉 / 举报 / 个人信息权利请求的登记（协议第十二条第 1 款、
//《生成式人工智能服务管理暂行办法》第十五条）。
//
// 【这一组拦的是什么】受理编号是**用户手上唯一的凭据**。它坏掉的形态全是静默的：
//   · 撞车而没人管 —— 两个人拿着同一串来问，而我们答不出该翻哪一条；
//   · 撞车时接口报 500 —— 用户以为自己没提交成功，于是又提一条（而第一条已经在库里）；
//   · 联系方式明文落库 —— 库里多了一张"投诉人手机号清单"，而页面上什么都看不出来；
//   · 三类混成一类 —— 一条「请把我的信息删掉」躺在产品反馈堆里，
//     谁也没意识到它有 15 个工作日的法定期限。
import crypto from 'node:crypto';

import Database from 'better-sqlite3';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  COMPLAINT_ACK_WORKDAYS,
  COMPLAINT_BODY_MAX,
  COMPLAINT_BODY_MIN,
  COMPLAINT_KINDS,
  COMPLAINT_REPLY_WORKDAYS,
  createComplaint,
  listAllComplaints,
  listMyComplaints,
  newReceiptNo,
} from '@/lib/complaints';
import * as store from '@/lib/db/complaints';
import { runMigrations } from '@/lib/db/migrate';

let db: Database.Database;
let uid: number;

beforeAll(() => {
  process.env.LAWER_DATA_KEY = crypto.randomBytes(32).toString('base64');
});

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  uid = Number(
    db.prepare("INSERT INTO users (email, auth_status) VALUES ('a@example.com', '未认证')").run()
      .lastInsertRowid,
  );
});

const INPUT = { kind: '投诉', body: '公道值扣了两次，只跑了一轮。', contact: '13900139001' };

describe('受理编号', () => {
  it('形状是 TB-日期-6 位（变异：改掉日期段 → 红）', () => {
    const no = newReceiptNo(new Date('2026-09-07T03:00:00Z'));
    expect(no).toMatch(/^TB-20260907-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{6}$/);
  });

  /**
   * 【为什么把这几个字符挑出来验】这串要在电话里念、在邮件里手敲。
   * 留着 0 与 O、1 与 I/l 的形态是：他念"零"我们记成 O，编号查无此条，
   * 而两边都确信自己没记错。
   */
  it('不含 0 1 I L O U（变异：把字母表换回完整 36 进制 → 红）', () => {
    const tails = Array.from({ length: 500 }, () => newReceiptNo().split('-')[2]).join('');
    for (const ch of ['0', '1', 'I', 'L', 'O', 'U']) {
      expect(tails, `编号里出现了容易听错/看错的「${ch}」`).not.toContain(ch);
    }
  });

  it('两千条互不相同（变异：把随机段改成固定串 → 红）', () => {
    const seen = new Set(Array.from({ length: 2000 }, () => newReceiptNo()));
    expect(seen.size).toBe(2000);
  });
});

describe('登记一条', () => {
  it('落库并回一串编号，编号在库里查得到', () => {
    const res = createComplaint(db, { userId: uid, ...INPUT });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.receipt_no).toMatch(/^TB-\d{8}-/);
    const row = store.findComplaintById(db, res.complaint_id)!;
    expect(row.receipt_no).toBe(res.receipt_no);
    expect(row.kind).toBe('投诉');
    expect(row.user_id).toBe(uid);
  });

  it('回执带上两个时限，页面不必自己再写一份（变异：改掉其中一个 → 红）', () => {
    const res = createComplaint(db, { userId: uid, ...INPUT });
    expect(res.ok && res.ack_workdays).toBe(COMPLAINT_ACK_WORKDAYS);
    expect(res.ok && res.reply_workdays).toBe(COMPLAINT_REPLY_WORKDAYS);
    expect(COMPLAINT_ACK_WORKDAYS).toBe(3);
    expect(COMPLAINT_REPLY_WORKDAYS).toBe(15);
  });

  /**
   * 【为什么联系方式必须是密文列】它多半就是一个手机号，而这张表将来是后台每天要翻的。
   * 明文列的形态是：库里躺着一张"投诉人手机号清单"，而页面上什么都看不出来。
   * 【变异臂】把 createComplaint 里的 encryptField 去掉 ⇒ 这条红。
   */
  it('联系方式以密文落库，明文一个字都不在库里', () => {
    const res = createComplaint(db, { userId: uid, ...INPUT });
    expect(res.ok).toBe(true);
    const row = store.findComplaintById(db, (res as { complaint_id: number }).complaint_id)!;
    expect(row.contact_enc).not.toContain(INPUT.contact);
    expect(row.contact_enc).toMatch(/^v1:/);
    // 整张表的原始文本里也不许出现那个号码（防"另开一列明文备份"）
    const dump = JSON.stringify(db.prepare('SELECT * FROM complaints').all());
    expect(dump).not.toContain(INPUT.contact);
  });

  it('读回来是解密后的明文（后台照着它答复）', () => {
    createComplaint(db, { userId: uid, ...INPUT });
    expect(listMyComplaints(db, uid)[0].contact).toBe(INPUT.contact);
    expect(listAllComplaints(db)[0].contact).toBe(INPUT.contact);
  });
});

describe('受理编号唯一', () => {
  /**
   * 【为什么要造一次撞车，而不是"随机够长就行"】唯一索引在那里，是因为**撞了要有人管**。
   * 不管的两种形态都很糟：吞掉（INSERT OR IGNORE）＝ 页面给了用户一串别人的编号；
   * 抛出去（500）＝ 用户以为没提交成功，于是又提一条。
   * 这里把 newReceiptNo 的随机源逼到只有一种取值，撞车必然发生。
   *
   * 【变异臂】把 createComplaint 里的重试循环去掉（只试一次）⇒ 第二条报错，本组红。
   */
  it('库层拦得住重复编号（唯一索引真的在）', () => {
    store.insertComplaint(db, {
      receiptNo: 'TB-20260907-AAAAAA',
      userId: uid,
      kind: '投诉',
      body: 'x'.repeat(10),
      contactEnc: 'v1:fake',
    });
    let err: unknown = null;
    try {
      store.insertComplaint(db, {
        receiptNo: 'TB-20260907-AAAAAA',
        userId: uid,
        kind: '投诉',
        body: 'y'.repeat(10),
        contactEnc: 'v1:fake',
      });
    } catch (e) {
      err = e;
    }
    expect(err, '同一串编号插了两次却没报错——唯一索引不在').not.toBeNull();
    expect(store.isUniqueViolation(err), '撞车的识别函数认不出它自己那条约束').toBe(true);
  });

  it('撞车时换一串重试，用户拿到的仍是一串**没被占用**的编号', () => {
    const first = createComplaint(db, { userId: uid, ...INPUT });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // 把下一次生成的编号顶成已存在的那一串：第一次必撞，实现要自己换一串再来
    const taken = first.receipt_no;
    let calls = 0;
    const realRandomInt = crypto.randomInt;
    // 测试里临时顶掉随机源（crypto.randomInt 有重载，赋值时按 unknown 中转）
    (crypto as unknown as { randomInt: unknown }).randomInt = (max: number) => {
      calls += 1;
      // 前 6 次（第一串）走"和已占用那串同样的字符"，之后回真随机
      return calls <= 6 ? '23456789ABCDEFGHJKMNPQRSTVWXYZ'.indexOf(taken[11 + calls - 1]) : realRandomInt(max);
    };
    try {
      const second = createComplaint(db, { userId: uid, ...INPUT });
      expect(second.ok, '撞了一次就放弃了：用户会以为没提交成功，于是再提一条').toBe(true);
      if (!second.ok) return;
      expect(second.receipt_no).not.toBe(taken);
    } finally {
      (crypto as unknown as { randomInt: unknown }).randomInt = realRandomInt;
    }

    const all = listAllComplaints(db).map((c) => c.receipt_no);
    expect(new Set(all).size, '库里出现了两条同号').toBe(all.length);
  });

  it('一千条连着提，编号互不相同', () => {
    for (let i = 0; i < 1000; i += 1) createComplaint(db, { userId: uid, ...INPUT });
    const all = listAllComplaints(db, 2000).map((c) => c.receipt_no);
    expect(all.length).toBe(1000);
    expect(new Set(all).size).toBe(1000);
  });
});

/**
 * 对外口径的**字面值**，单独钉一次。
 *
 * 【为什么上面那些"三类都收得下""时限随回执下发"还不够】它们全都从
 * COMPLAINT_KINDS / COMPLAINT_*_WORKDAYS 取值再拿回去比——是一组**同义反复**：
 * 把常量里的「个人信息权利请求」删掉、把 3 改成 5，那些判据跟着一起变，照旧全绿。
 * 而这三类与这两个数是《用户服务协议》第十二条第 1 款对用户**逐字承诺**的东西，
 * 也是《生成式人工智能服务管理暂行办法》第十五条要求公布的处理流程与反馈时限。
 *
 * 同源（页面不另写一份）与钉值（承诺过的那个值没被悄悄改掉）是两件事，缺一不可。
 * 要改这里的任何一个值，先改协议正本（docs/legal/用户服务协议-草案.md）并由经理裁定。
 */
describe('对外承诺的字面值（改它要先改协议正本）', () => {
  it('三类请求一个不少、一个不多（变异：删掉「个人信息权利请求」→ 红）', () => {
    expect(
      [...COMPLAINT_KINDS],
      '协议第十二条第 1 款承诺的是投诉、举报、个人信息权利请求三条路。' +
        '少一条的形态是：那一类请求被并进别的堆里，而它的法定期限没人认领。',
    ).toEqual(['投诉', '举报', '个人信息权利请求']);
  });

  it('两个时限就是 3 / 15 个工作日（变异：把 3 改成 5 → 红）', () => {
    expect(COMPLAINT_ACK_WORKDAYS, '协议承诺 3 个工作日内确认受理').toBe(3);
    expect(COMPLAINT_REPLY_WORKDAYS, '协议承诺 15 个工作日内答复 / 办结').toBe(15);
  });
});

describe('入参闸：拒了就说清为什么', () => {
  it('三类之外的类型拒收（变异：把 kind 直接落库 → 红）', () => {
    const res = createComplaint(db, { userId: uid, ...INPUT, kind: '反馈' });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errorCode).toBe('BAD_COMPLAINT_KIND');
    for (const k of COMPLAINT_KINDS) expect(res.message).toContain(k);
    expect(db.prepare('SELECT COUNT(*) n FROM complaints').get()).toEqual({ n: 0 });
  });

  it('三类都收得下（变异：把 individual 权利请求那一类漏掉 → 红）', () => {
    for (const kind of COMPLAINT_KINDS) {
      const res = createComplaint(db, { userId: uid, ...INPUT, kind });
      expect(res.ok, `${kind} 提不了`).toBe(true);
    }
    expect(listAllComplaints(db).map((c) => c.kind).sort()).toEqual([...COMPLAINT_KINDS].sort());
  });

  it('描述太短、太长都拒，且回话里带着实际长度', () => {
    const short = createComplaint(db, { userId: uid, ...INPUT, body: 'x'.repeat(COMPLAINT_BODY_MIN - 1) });
    expect(short.ok).toBe(false);
    if (!short.ok) expect(short.errorCode).toBe('BAD_COMPLAINT_BODY');
    const long = createComplaint(db, { userId: uid, ...INPUT, body: 'x'.repeat(COMPLAINT_BODY_MAX + 1) });
    expect(long.ok).toBe(false);
    if (!long.ok) expect(long.message).toContain(String(COMPLAINT_BODY_MAX + 1));
  });

  it('联系方式必填（没有它，"答复处理结果"这句承诺兑现不了）', () => {
    const res = createComplaint(db, { userId: uid, ...INPUT, contact: '   ' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errorCode).toBe('BAD_COMPLAINT_CONTACT');
  });
});

describe('归属与留存', () => {
  it('只看得到自己提的那几条', () => {
    const other = Number(
      db.prepare("INSERT INTO users (email, auth_status) VALUES ('b@example.com', '未认证')").run()
        .lastInsertRowid,
    );
    createComplaint(db, { userId: uid, ...INPUT });
    createComplaint(db, { userId: other, ...INPUT });
    expect(listMyComplaints(db, uid)).toHaveLength(1);
    expect(listAllComplaints(db)).toHaveLength(2);
  });

  /**
   * 【为什么注销之后这一行还在】协议第五条第 8 款：已出具的证明、支付记录与
   * 法律要求留存的日志按法定期限保留。受理记录属于后者。
   * user_id 挂 NOT NULL 的形态是：注销时要么连台账一起删（而我们对外承诺过它在），
   * 要么注销本身失败。
   */
  it('账号注销后记录还在，只是不再挂在谁名下（变异：把外键改成 CASCADE → 红）', () => {
    const res = createComplaint(db, { userId: uid, ...INPUT });
    expect(res.ok).toBe(true);
    db.prepare('DELETE FROM users WHERE id = ?').run(uid);
    const rows = listAllComplaints(db);
    expect(rows, '注销把受理台账一起删了').toHaveLength(1);
    expect(rows[0].user_id).toBeNull();
    expect(rows[0].receipt_no).toBe((res as { receipt_no: string }).receipt_no);
  });
});
