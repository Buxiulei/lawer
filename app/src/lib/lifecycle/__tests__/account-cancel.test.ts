// app/src/lib/lifecycle/__tests__/account-cancel.test.ts
// 注销账号的三臂：成功 / 拒绝 / 幂等，外加「注销之后凭据真的不认了」这条。
//
// 【这一组要拦的四种静默错法】
//   · 一步就注销了（没有第二因子）——回包与两步式的第二步同形；
//   · 验证码走了登录那一桶（一条为登录发出的码能拿去注销）；
//   · 注销了但登录态还能用（JWT 是纯 HMAC，签出去撤不回）；
//   · 注销了但手机号/邮箱还留在库里（页面上那个账号已经"没了"）；
//   · 注销了但免登录分享链接照样打得开（确认单第 2 条明写「确认那一刻立即失效」，
//     而回包上 shares_revoked=0 与「本来就没有链接」完全同形——2026-09-07 复审补位）。
import crypto from 'node:crypto';

import Database from 'better-sqlite3';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { resolveIdentity } from '@/lib/auth/identity';
import { signToken } from '@/lib/auth/jwt';
import { encryptField, hashLookup } from '@/lib/crypto';
import * as store from '@/lib/db/cases';
import { runMigrations } from '@/lib/db/migrate';
import { createShare, readShare } from '@/lib/shares';

import {
  CANCEL_BALANCE_COPY_ENV,
  CANCEL_BALANCE_COPY_PENDING,
  cancelAccount,
  cancelBalanceCopy,
  cancelConfirmToken,
} from '../account-cancel';

const PHONE = '13800138000';
const CODE = '424242';

let db: Database.Database;
let uid: number;
let caseId: number;
let sent: { to: string; code: string }[];

beforeAll(() => {
  process.env.LAWER_DATA_KEY = crypto.randomBytes(32).toString('base64');
  process.env.JWT_SECRET ??= 'test-secret-for-cancel';
});

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  sent = [];
  uid = Number(
    db
      .prepare('INSERT INTO users (phone_enc, phone_hash, email) VALUES (?,?,?)')
      .run(encryptField(PHONE), hashLookup(PHONE), 'a@t.com').lastInsertRowid,
  );
  caseId = Number(
    db.prepare('INSERT INTO cases (user_id, title) VALUES (?,?)').run(uid, '甲的档案').lastInsertRowid,
  );
});

const deps = () => ({
  sendSms: async (to: string, code: string) => {
    sent.push({ to, code });
  },
  makeCode: () => CODE,
  now: new Date('2026-09-07T00:00:00Z'),
});

/** 在某个案子上建一条免登录分享链接（真走 createShare，不手插 share_links 行）。 */
function shareOn(target: number, owner: number): string {
  const draftId = Number(
    db
      .prepare("INSERT INTO drafts (case_id, kind, title, content) VALUES (?,'异议函','稿','正文若干')")
      .run(target).lastInsertRowid,
  );
  const made = createShare(db, { userId: owner, draftId });
  if (!made.ok) throw new Error(`建链接失败：${made.message}`);
  return made.token;
}

async function challenge() {
  const res = await cancelAccount({ db, userId: uid }, deps());
  if (!res.ok || res.stage !== 'challenge') throw new Error('本该是确认单');
  return res;
}

describe('第一步：出确认单 + 发码，零删除', () => {
  it('不带 code ⇒ stage=challenge，档案与账号原封不动', async () => {
    const res = await challenge();
    expect(res.channel).toBe('sms');
    expect(res.sent_to).not.toContain('138001'); // 掩码过，不回明文号
    expect(res.cases).toBe(1);
    expect(sent).toEqual([{ to: PHONE, code: CODE }]);

    // 零删除：案件还在、账号还没标注销、手机号还在
    expect(store.findCaseById(db, caseId)).toBeDefined();
    const row = db.prepare('SELECT cancelled_at, phone_hash FROM users WHERE id=?').get(uid) as {
      cancelled_at: string | null;
      phone_hash: string | null;
    };
    expect(row.cancelled_at).toBeNull();
    expect(row.phone_hash).not.toBeNull();
  });

  it('码落在 purpose=cancel 那一桶里，登录那一桶一条都没有（变异：把 CANCEL_CODE_PURPOSE 改成 login → 本条红）', async () => {
    await challenge();
    const rows = db.prepare('SELECT purpose FROM sms_codes').all() as { purpose: string }[];
    expect(rows.map((r) => r.purpose)).toEqual(['cancel']);
  });

  it('确认单里带着「余额与套餐怎么算」，且默认那句明说还没定稿', async () => {
    const res = await challenge();
    expect(res.balance_note).toBe(CANCEL_BALANCE_COPY_PENDING);
    expect(res.balance_note).toContain('尚未定稿');
    expect(res.removes.length).toBeGreaterThan(0);
    expect(res.keeps.join('')).toContain('存证证明');
    expect(res.note).toContain('本次没有注销任何东西');
  });

  it('文案可配：配了就说配的那句（运营层面的口径，不写死在代码里）', () => {
    const saved = process.env[CANCEL_BALANCE_COPY_ENV];
    process.env[CANCEL_BALANCE_COPY_ENV] = '余额一律不退，套餐按剩余天数折算。';
    try {
      expect(cancelBalanceCopy()).toBe('余额一律不退，套餐按剩余天数折算。');
    } finally {
      if (saved === undefined) delete process.env[CANCEL_BALANCE_COPY_ENV];
      else process.env[CANCEL_BALANCE_COPY_ENV] = saved;
    }
  });

  it('60 秒内不重复发（连点两下不该打两条短信出去）', async () => {
    await challenge();
    const again = await cancelAccount({ db, userId: uid }, deps());
    expect(again.ok).toBe(false);
    expect(!again.ok && again.errorCode).toBe('RATE_LIMITED');
    expect(sent).toHaveLength(1);
  });

  it('短信发不出去 ⇒ 那一行码被撤掉，冷却回到发之前', async () => {
    const res = await cancelAccount(
      { db, userId: uid },
      { ...deps(), sendSms: async () => { throw new Error('通道 503'); } },
    );
    expect(!res.ok && res.errorCode).toBe('CODE_SEND_FAILED');
    expect(db.prepare('SELECT COUNT(*) AS n FROM sms_codes').get()).toEqual({ n: 0 });
  });
});

describe('第二步：成功臂', () => {
  it('令牌 + 码都对 ⇒ 案件标删、凭据停用、可识别字段抹掉（变异：把 anonymizeUser 那一句删掉 → 本条红）', async () => {
    const keyId = Number(
      db
        .prepare("INSERT INTO api_keys (user_id, name, key_hash, scopes) VALUES (?,'k','h','case:read')")
        .run(uid).lastInsertRowid,
    );
    const codeId = Number(
      db
        .prepare(
          `INSERT INTO oauth_codes (code_hash, client_id, user_id, key_id, redirect_uri, code_challenge, scopes, expires_at)
           VALUES ('ch','cli',?,?,'https://x/cb','cc','[\"case:read\"]','2030-01-01 00:00:00')`,
        )
        .run(uid, keyId).lastInsertRowid,
    );
    db.prepare(
      `INSERT INTO oauth_tokens (token_hash, kind, code_id, key_id, user_id, expires_at)
       VALUES ('th','access',?,?,?,'2030-01-01 00:00:00')`,
    ).run(codeId, keyId, uid);

    const ch = await challenge();
    const res = await cancelAccount(
      { db, userId: uid, code: CODE, confirmToken: ch.confirm_token },
      deps(),
    );
    if (!res.ok || res.stage !== 'cancelled') throw new Error(`本该注销：${JSON.stringify(res)}`);

    expect(res.cases_deleted).toBe(1);
    expect(res.keys_disabled).toBe(1);
    expect(res.oauth_tokens_revoked).toBe(1);
    expect(res.cancelled_at).toBe('2026-09-07 00:00:00');
    expect(res.purge_after).toBe('2026-10-07 00:00:00');

    // 档案标删（读侧取不到），账号字段抹掉，凭据停用
    expect(store.findCaseById(db, caseId)).toBeUndefined();
    const row = db
      .prepare('SELECT phone_enc, phone_hash, email, auth_status, cancelled_at FROM users WHERE id=?')
      .get(uid) as Record<string, unknown>;
    expect(row.phone_enc).toBeNull();
    expect(row.phone_hash).toBeNull();
    expect(row.email).toBeNull();
    expect(row.auth_status).toBe('未认证');
    expect(row.cancelled_at).toBe('2026-09-07 00:00:00');
    expect(db.prepare('SELECT enabled FROM api_keys WHERE id=?').get(keyId)).toEqual({ enabled: 0 });
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM oauth_tokens WHERE revoked_at IS NULL').get() as { n: number }).n,
    ).toBe(0);
  });

  /**
   * 确认单里 CANCEL_REMOVES 第 2 条对用户说的是「全部免登录分享链接（确认那一刻立即失效）」。
   * 那句话不是由 30 日后的清理任务兑现的——**免登录链接是谁拿到谁能打开**，
   * 从确认到硬删的这 30 天里，任何持有链接的人照样打得开，而用户以为门已经关上了。
   *
   * 判据断言的是**链接真的打不开了**（readShare 那条免登录读路），不是 share_links 上多了个时刻：
   * 只看列的判据在「收了行但读路不认这一列」时同样会绿。
   */
  it('注销当场收回全部免登录分享链接（变异：把 shares += revokeCaseShares(...) 换成 shares += 0 → 本条红）', async () => {
    const live = shareOn(caseId, uid);
    // 第二个案子：用户注销前自己已经删过它。链接挂在软删的案子上照样打得开，也照样要收
    const alreadyDeleted = Number(
      db.prepare('INSERT INTO cases (user_id, title) VALUES (?,?)').run(uid, '先删掉的那个').lastInsertRowid,
    );
    const onDeleted = shareOn(alreadyDeleted, uid);
    db.prepare("UPDATE cases SET deleted_at='2026-08-01 00:00:00' WHERE id=?").run(alreadyDeleted);
    // 别人的链接：注销只收自己名下的，收宽了同样是错
    const stranger = Number(
      db.prepare("INSERT INTO users (email) VALUES ('b@t.com')").run().lastInsertRowid,
    );
    const strangerCase = Number(
      db.prepare('INSERT INTO cases (user_id, title) VALUES (?,?)').run(stranger, '别人的档案').lastInsertRowid,
    );
    const others = shareOn(strangerCase, stranger);

    // 正对照：注销之前这三条都打得开
    for (const t of [live, onDeleted, others]) expect(readShare(db, t).state).toBe('ok');

    const ch = await challenge();
    const res = await cancelAccount(
      { db, userId: uid, code: CODE, confirmToken: ch.confirm_token },
      deps(),
    );
    if (!res.ok || res.stage !== 'cancelled') throw new Error('本该注销');

    expect(res.shares_revoked).toBe(2);
    expect(readShare(db, live).state, '还活着的案子那条链接没收回').toBe('revoked');
    expect(readShare(db, onDeleted).state, '先删过的案子那条链接没收回').toBe('revoked');
    expect(readShare(db, others).state, '把别人的链接也收了').toBe('ok');
    expect(
      (db
        .prepare(
          'SELECT COUNT(*) AS n FROM share_links WHERE revoked_at IS NULL AND case_id IN (SELECT id FROM cases WHERE user_id = ?)',
        )
        .get(uid) as { n: number }).n,
    ).toBe(0);
  });

  it('注销之后网页登录态不再被认（变异：resolveIdentity 去掉注销闸 → 本条红）', async () => {
    const jwt = signToken(uid);
    const headers = new Headers({ authorization: `Bearer ${jwt}` });
    // 正对照：注销之前这张 token 是好使的
    expect(resolveIdentity(db, headers)?.uid).toBe(uid);

    const ch = await challenge();
    await cancelAccount({ db, userId: uid, code: CODE, confirmToken: ch.confirm_token }, deps());

    expect(resolveIdentity(db, headers)).toBeNull();
  });

  it('已经删过的案子不重复计数，但也不改写它的删除时刻', async () => {
    db.prepare("UPDATE cases SET deleted_at='2026-08-01 00:00:00' WHERE id=?").run(caseId);
    const ch = await challenge();
    const res = await cancelAccount(
      { db, userId: uid, code: CODE, confirmToken: ch.confirm_token },
      deps(),
    );
    if (!res.ok || res.stage !== 'cancelled') throw new Error('本该注销');
    expect(res.cases_deleted).toBe(0);
    expect(
      db.prepare('SELECT deleted_at FROM cases WHERE id=?').get(caseId),
    ).toEqual({ deleted_at: '2026-08-01 00:00:00' });
  });
});

describe('拒绝臂：每一条都零删除', () => {
  const untouched = () => {
    expect(store.findCaseById(db, caseId), '案件被动了').toBeDefined();
    expect(
      (db.prepare('SELECT cancelled_at FROM users WHERE id=?').get(uid) as { cancelled_at: string | null })
        .cancelled_at,
      '账号被标注销了',
    ).toBeNull();
  };

  it('令牌不对 ⇒ INVALID_CONFIRM_TOKEN', async () => {
    await challenge();
    const res = await cancelAccount({ db, userId: uid, code: CODE, confirmToken: 'x'.repeat(32) }, deps());
    expect(!res.ok && res.errorCode).toBe('INVALID_CONFIRM_TOKEN');
    untouched();
  });

  it('码不对 ⇒ OTP_INVALID，且错够五次锁死', async () => {
    const ch = await challenge();
    for (let i = 0; i < 4; i += 1) {
      const bad = await cancelAccount(
        { db, userId: uid, code: '000000', confirmToken: ch.confirm_token },
        deps(),
      );
      expect(!bad.ok && bad.errorCode, `第 ${i + 1} 次`).toBe('OTP_INVALID');
    }
    const locked = await cancelAccount(
      { db, userId: uid, code: '000000', confirmToken: ch.confirm_token },
      deps(),
    );
    expect(!locked.ok && locked.errorCode).toBe('OTP_LOCKED');
    untouched();
  });

  it('压根没发过码 ⇒ OTP_NOT_FOUND（拿着令牌也不行：两样必须齐）', async () => {
    const res = await cancelAccount(
      { db, userId: uid, code: CODE, confirmToken: cancelConfirmToken(uid) },
      deps(),
    );
    expect(!res.ok && res.errorCode).toBe('OTP_NOT_FOUND');
    untouched();
  });

  it('用登录那一桶的码注销不了（purpose 隔离：一条为登录发的码不能拿来抹账号）', async () => {
    db.prepare(
      "INSERT INTO sms_codes (phone_hash, code, purpose, expires_at) VALUES (?, ?, 'login', '2030-01-01 00:00:00')",
    ).run(hashLookup(PHONE), CODE);
    const res = await cancelAccount(
      { db, userId: uid, code: CODE, confirmToken: cancelConfirmToken(uid) },
      deps(),
    );
    expect(!res.ok && res.errorCode).toBe('OTP_NOT_FOUND');
    untouched();
  });

  it('既没手机也没邮箱 ⇒ CANCEL_CHANNEL_MISSING（不能只凭一张登录态就抹掉一个人的档案）', async () => {
    const bare = Number(db.prepare('INSERT INTO users (auth_status) VALUES (?)').run('未认证').lastInsertRowid);
    const res = await cancelAccount({ db, userId: bare }, deps());
    expect(!res.ok && res.errorCode).toBe('CANCEL_CHANNEL_MISSING');
  });
});

describe('幂等臂', () => {
  it('注销两次都成功，第二次首次注销时刻与到期时刻都不变', async () => {
    const ch = await challenge();
    const first = await cancelAccount(
      { db, userId: uid, code: CODE, confirmToken: ch.confirm_token },
      deps(),
    );
    if (!first.ok || first.stage !== 'cancelled') throw new Error('第一次就该注销');

    // 第二次要一条新码：上一条已被标 used（一次性）。**注销之后手机号已经抹掉**，
    // 所以这里直接往 cancel 那一桶里补一条，模拟「同一次业务重放」。
    db.prepare(
      "INSERT INTO email_codes (email, code, purpose, expires_at) VALUES ('x@t.com', ?, 'cancel', '2030-01-01 00:00:00')",
    ).run(CODE);
    db.prepare("UPDATE users SET email='x@t.com' WHERE id=?").run(uid);

    const second = await cancelAccount(
      { db, userId: uid, code: CODE, confirmToken: cancelConfirmToken(uid) },
      { ...deps(), now: new Date('2026-09-30T00:00:00Z') },
    );
    if (!second.ok || second.stage !== 'cancelled') throw new Error('第二次也该成功');
    expect(second.cancelled_at).toBe(first.cancelled_at);
    expect(second.purge_after).toBe(first.purge_after);
    expect(second.cases_deleted).toBe(0);
  });
});
