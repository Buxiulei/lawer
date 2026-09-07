// app/src/lib/lifecycle/__tests__/identity-erase.test.ts
// 「把这个人抹干净」这件事，在**四份副本**上都成立（2026-09-07 复审 major 的回归位）。
//
// 【这一组要拦的失败形态只有一种，但它长着四张脸】注销回包对用户说「姓名与证件号已经抹掉」，
// 页面显示注销完成，30 日后 purged_at 也落定了——而库里：
//   ② realname_verifications.cert_no 与 raw_meta_enc（后者明写「内含姓名身份证」，
//      护照通道往里写的是真名与护照号）原样躺着；
//   ③ 上传的护照资料页与手持自拍两份密文文件还在盘上，且它们的 file_id 只写在 ② 的
//      信封里——信封删了之后，这两张照片就再也没有一处说得出它属于谁；
//   ④ sms_codes.phone_hash 与 email_codes.email（明文）还在，同一个手机号再来注册时，
//      这两张表把新账号接回了旧账号的注销时刻。
// 三处都不报错，外面也看不出来。所以每一条都配**正对照**：抹之前那份东西确实在。
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

process.env.LAWER_DATA_KEY = crypto.randomBytes(32).toString('base64');
const FILES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-erase-'));
process.env.FILES_DIR = FILES_DIR;

import { initPassportRealname } from '@/lib/auth/passport-realname';
import { encryptField, hashLookup } from '@/lib/crypto';
import { gcOrphanFilesAmong } from '@/lib/db/filesGc';
import * as lifecycleStore from '@/lib/db/lifecycle';
import { runMigrations } from '@/lib/db/migrate';
import * as realnameStore from '@/lib/db/realname';

import { eraseUserIdentity } from '../identity-erase';

const PHONE = '13800138000';
const EMAIL = 'a@t.com';

let db: Database.Database;
let uid: number;

const count = (sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as { n: number }).n;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  uid = Number(
    db
      .prepare('INSERT INTO users (phone_enc, phone_hash, email) VALUES (?,?,?)')
      .run(encryptField(PHONE), hashLookup(PHONE), EMAIL).lastInsertRowid,
  );
});

/** 阿里云那条通道的一行：cert_no 存 provider 侧引用，raw_meta_enc 里是三方原始报文。 */
function seedCloudauth(): number {
  return realnameStore.insertVerification(db, {
    userId: uid,
    provider: 'cloudauth',
    certNo: 'certify-9527',
    status: 'passed',
    rawMetaEnc: encryptField(JSON.stringify({ cert_name: '甲', cert_no: '110101199001011234' })),
  });
}

/** 护照那条通道：真走 initPassportRealname，材料落 files 表 + 盘。 */
function seedPassport(): { verificationId: number; fileIds: number[]; encPaths: string[] } {
  const init = initPassportRealname(db, {
    userId: uid,
    realName: '甲',
    passportNo: 'E12345678',
    idPage: { bytes: Buffer.from(`护照资料页-${crypto.randomUUID()}`), mime: 'image/jpeg' },
    selfie: { bytes: Buffer.from(`手持护照自拍-${crypto.randomUUID()}`), mime: 'image/jpeg' },
  });
  if (!init.ok) throw new Error(`护照流水没落成：${init.message}`);
  const fileIds = (
    db.prepare('SELECT id FROM files ORDER BY id').all() as { id: number }[]
  ).map((r) => r.id);
  const encPaths = (
    db.prepare('SELECT enc_path FROM files ORDER BY id').all() as { enc_path: string }[]
  ).map((r) => r.enc_path);
  return { verificationId: init.verificationId, fileIds, encPaths };
}

function seedCodes(): void {
  db.prepare(
    "INSERT INTO sms_codes (phone_hash, code, purpose, expires_at) VALUES (?, '1111', 'login', '2030-01-01 00:00:00')",
  ).run(hashLookup(PHONE));
  db.prepare(
    "INSERT INTO sms_codes (phone_hash, code, purpose, expires_at) VALUES (?, '2222', 'cancel', '2030-01-01 00:00:00')",
  ).run(hashLookup(PHONE));
  db.prepare(
    "INSERT INTO email_codes (email, code, purpose, expires_at) VALUES (?, '3333', 'verify', '2030-01-01 00:00:00')",
  ).run(EMAIL);
}

describe('实名核验流水：姓名与证件号的第二份副本', () => {
  it('抹之前在、抹之后一行不剩（变异：把 eraseUserIdentity 里那句 deleteAllByUser 删掉 → 本条红）', () => {
    seedCloudauth();
    // 正对照：这一行确实解得出姓名与证件号——没有它，下面那条断言可能只是在验一张空表
    const before = realnameStore.latestByUser(db, uid)!;
    expect(before.cert_no).toBe('certify-9527');
    expect(before.raw_meta_enc).not.toBeNull();

    eraseUserIdentity(db, uid);

    expect(count('SELECT COUNT(*) AS n FROM realname_verifications WHERE user_id=?', uid)).toBe(0);
    expect(realnameStore.latestByUser(db, uid)).toBeUndefined();
  });

  it('别人的流水一行都不动（按 user_id 抹，不是清表）', () => {
    seedCloudauth();
    const other = Number(db.prepare("INSERT INTO users (email) VALUES ('b@t.com')").run().lastInsertRowid);
    realnameStore.insertVerification(db, { userId: other, provider: 'cloudauth', certNo: 'x' });

    eraseUserIdentity(db, uid);

    expect(count('SELECT COUNT(*) AS n FROM realname_verifications WHERE user_id=?', other)).toBe(1);
  });

  it('幂等：再抹一遍每一项都回 0，不抛', () => {
    seedCloudauth();
    seedCodes();
    expect(eraseUserIdentity(db, uid).realname_rows).toBe(1);
    const again = eraseUserIdentity(db, uid);
    expect(again).toEqual({ realname_rows: 0, code_rows: 0, released_file_ids: [] });
  });
});

describe('护照材料：姓名与证件号的第三份副本（两张照片）', () => {
  it('删信封之前先把 file_id 问出来，回收之后库行与盘文件都没了（变异：把 released_file_ids 改成恒空 → 本条红）', () => {
    const { fileIds, encPaths } = seedPassport();
    expect(fileIds).toHaveLength(2);
    // 正对照：这两份密文此刻确实在盘上
    for (const p of encPaths) expect(fs.existsSync(path.join(FILES_DIR, p))).toBe(true);

    const erased = eraseUserIdentity(db, uid);
    expect([...erased.released_file_ids].sort(), '信封删掉之后就再也问不出这两个 id 了').toEqual(
      [...fileIds].sort(),
    );

    const removed: string[] = [];
    const gc = gcOrphanFilesAmong(db, erased.released_file_ids, {
      deleteFromDisk: (p) => {
        removed.push(p);
        fs.rmSync(path.join(FILES_DIR, p), { force: true });
      },
    });
    expect(gc.removed).toBe(2);
    expect(removed.sort()).toEqual([...encPaths].sort());
    expect(count('SELECT COUNT(*) AS n FROM files')).toBe(0);
    for (const p of encPaths) expect(fs.existsSync(path.join(FILES_DIR, p))).toBe(false);
  });

  it('还被别人引着的同一份文件不许删——判据仍是「无人引用」，不是「这个人的就删」', () => {
    const { fileIds } = seedPassport();
    const other = Number(db.prepare("INSERT INTO users (email) VALUES ('b@t.com')").run().lastInsertRowid);
    const otherCase = Number(
      db.prepare('INSERT INTO cases (user_id, title) VALUES (?,?)').run(other, '别人的').lastInsertRowid,
    );
    // 同哈希全局去重：别人的案子引着同一份 files 行的情形
    db.prepare('INSERT INTO evidence (case_id, user_id, file_id, name) VALUES (?,?,?,?)').run(
      otherCase,
      other,
      fileIds[0],
      '同一份文件',
    );

    const erased = eraseUserIdentity(db, uid);
    const gc = gcOrphanFilesAmong(db, erased.released_file_ids, { deleteFromDisk: () => {} });
    expect(gc.removed, '把别人还引着的那份文件一起删了').toBe(1);
    expect(count('SELECT COUNT(*) AS n FROM files WHERE id=?', fileIds[0])).toBe(1);
  });

  it('信封解不开的那一行不让整次注销失败（坏行按"没有材料"算，其余照抹）', () => {
    seedCloudauth();
    realnameStore.insertVerification(db, {
      userId: uid,
      provider: 'passport',
      status: 'pending',
      rawMetaEnc: '这不是一段能解开的密文',
    });
    expect(() => eraseUserIdentity(db, uid)).not.toThrow();
    expect(count('SELECT COUNT(*) AS n FROM realname_verifications WHERE user_id=?', uid)).toBe(0);
  });
});

describe('验证码行：手机号哈希与明文邮箱的第四份副本', () => {
  it('抹之前三行在、抹之后一行不剩（变异：把 purgeAuthCodes 那一句删掉 → 本条红）', () => {
    seedCodes();
    expect(count('SELECT COUNT(*) AS n FROM sms_codes')).toBe(2);
    expect(count('SELECT COUNT(*) AS n FROM email_codes')).toBe(1);

    const erased = eraseUserIdentity(db, uid);

    expect(erased.code_rows).toBe(3);
    expect(count('SELECT COUNT(*) AS n FROM sms_codes')).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM email_codes')).toBe(0);
  });

  it('别人的码一行都不动（按这个人的 phone_hash / email 找，不是清表）', () => {
    seedCodes();
    db.prepare(
      "INSERT INTO sms_codes (phone_hash, code, purpose, expires_at) VALUES ('别人的哈希', '9999', 'login', '2030-01-01 00:00:00')",
    ).run();
    eraseUserIdentity(db, uid);
    expect(count('SELECT COUNT(*) AS n FROM sms_codes')).toBe(1);
  });

  it('顺序不能倒：抹完 users 行再删码就一行都找不到了（本函数按 users 上的 phone_hash 去找）', () => {
    seedCodes();
    // 先单独抹 users 行，模拟"顺序写反了"的那个版本
    lifecycleStore.anonymizeUser(db, uid);
    expect(lifecycleStore.purgeAuthCodes(db, uid), '抹完 users 还能按它找到码行？').toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM sms_codes'), '这 3 行就是那样留下来的').toBe(2);
  });
});

describe('结构守卫：anonymizeUser 只许经这一个入口', () => {
  /**
   * 【为什么要有这道守卫】users 行只是四份副本里的第一份。谁绕过 identity-erase 直接调
   * anonymizeUser，就等于重新写了一遍"只抹第一份"的那个 bug——而它跑起来一切正常。
   * 2026-09-07 复审逮到的就是这个形态：注销与到期清理两处都只调了 anonymizeUser。
   */
  it('全仓只有 lib/db/lifecycle.ts（定义）与 lib/lifecycle/identity-erase.ts 提到它', () => {
    const srcRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)), '..', '..');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        if (fs.statSync(full).isDirectory()) {
          if (name !== '__tests__' && name !== 'node_modules') walk(full);
        } else if (full.endsWith('.ts') || full.endsWith('.tsx')) {
          files.push(full);
        }
      }
    };
    walk(path.join(srcRoot, 'lib'));
    walk(path.join(srcRoot, 'app'));
    // 只看代码行：抬头注释里点名它是好事（那是给下一个人看的指路牌），不算调用。
    const callers = files.filter((f) =>
      fs
        .readFileSync(f, 'utf-8')
        .split('\n')
        .some((line) => !/^\s*(\/\/|\*|\/\*)/.test(line) && /anonymizeUser\s*\(/.test(line)),
    );
    expect(callers.map((f) => path.relative(srcRoot, f)).sort()).toEqual([
      'lib/db/lifecycle.ts',
      'lib/lifecycle/identity-erase.ts',
    ]);
    // 对照臂：扫描确实覆盖到了那两个文件（空名单会让上面那条永远绿）
    expect(files.length).toBeGreaterThan(50);
  });
});
