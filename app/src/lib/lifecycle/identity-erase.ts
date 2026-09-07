// app/src/lib/lifecycle/identity-erase.ts
// 「把这个人的可识别信息抹干净」的**唯一入口**（协议第五条第 8、9 款；注销回包
// CANCEL_REMOVES 第 4 条那句「手机号、邮箱、姓名与证件号（确认那一刻立即抹除）」）。
//
// 【为什么要有这一层，而不是各自调 anonymizeUser】姓名与证件号在库里有四份副本，
// 而 anonymizeUser 只抹得掉第一份：
//   ① users 行（phone/email/real_name_enc/id_card_enc…）      —— anonymizeUser
//   ② realname_verifications.cert_no 与 raw_meta_enc          —— 后者明写「内含姓名身份证」
//   ③ 护照材料那两份密文文件（资料页 + 手持自拍）             —— file_id 只在 ② 的信封里
//   ④ sms_codes.phone_hash / email_codes.email               —— 邮箱还是明文
// 2026-09-07 复审逮到的正是这条：注销回包对用户说「已经抹掉」，而 ②③④ 原样留着，
// 30 日后的清理也只是把 ① 再抹一遍——**外面看不出来，两条路都不报错**。
// 独立写四次就会忘三次，所以收成这一个函数，调用方名单由 __tests__/identity-erase 的
// 结构守卫钉着：除本文件外谁都不许再调 anonymizeUser。
//
// 【为什么密文文件不在这里删】删盘要在事务外做（回收器自带事务，嵌不进注销那个事务），
// 而且判据仍是「无人引用」那一份（lib/db/filesGc）——本文件只负责**把 file_id 问出来**
// 并交给调用方，不自己决定谁能删。顺序不能倒：信封删掉之后就再也问不出来了。
import type { Database } from 'better-sqlite3';

import { passportMaterialFileIds } from '@/lib/auth/passport-realname';
import * as lifecycle from '@/lib/db/lifecycle';
import * as realname from '@/lib/db/realname';

export interface IdentityErasure {
  /** 删掉的实名核验流水行数 */
  realname_rows: number;
  /** 删掉的验证码行数（sms_codes + email_codes 合计） */
  code_rows: number;
  /**
   * 本次因为删掉信封而失去唯一引用的密文文件 id（护照资料页 / 手持自拍）。
   * 调用方要把它交给 gcOrphanFilesAmong——不交的形态是：这两张护照照片永远留在盘上，
   * 而库里已经没有一处说得出它属于谁。
   */
  released_file_ids: number[];
}

/**
 * 抹掉这个人全部可识别信息。**幂等**：抹第二遍每一步都回 0 / 空数组。
 *
 * 步骤顺序是硬的：
 *   1. 先问护照材料的 file_id（信封还在时才问得出来）
 *   2. 再删验证码行（要按 users 行上的 phone_hash / email 去找）
 *   3. 再删实名流水（②③ 的正本）
 *   4. 最后抹 users 行（抹完就什么都问不出来了）
 * 全程同步、不开事务：注销那条路本来就在一个事务里调它，到期清理那条路一行一事务。
 */
export function eraseUserIdentity(db: Database, userId: number): IdentityErasure {
  const released = passportMaterialFileIds(db, userId);
  const codeRows = lifecycle.purgeAuthCodes(db, userId);
  const realnameRows = realname.deleteAllByUser(db, userId);
  lifecycle.anonymizeUser(db, userId);
  return { realname_rows: realnameRows, code_rows: codeRows, released_file_ids: released };
}
