// app/src/lib/referral/identity-link.ts
// 实名互认的**读侧**（设计稿 §14 决定 3）：本地没实名时，去问一次 NBDpsy——
// 对方人级终态是 approved 就认，写一条 provider=nbdpsy 的核验流水并放行。
//
// 【口径只有一条：对方的人级终态】不看对方那张 24 小时新鲜期的事件表（它只服务
// 对方自签合同那个场景）。看那张表的形态是：同一个人今天能出证、明天不能，
// 而两天里他什么都没做。
//
// 【证件号只存掩码，且是我们自己再掩一次的】对方回的是 `id_masked`。
// 即便哪天对方改了实现、往那个键里塞了全号，本文件也会**再掩一次**才落库——
// 「相信上游已经脱敏」这个假设一旦不成立，代价是一个明文证件号躺进我们的库，
// 而没有任何一处会报错。
//
// 【本文件不判「本地实名了没有」】那个判定只有 lib/auth/guard.isRealnameVerified 一份。
// 在这里再写一句 `auth_status === '已实名'` 就是同一件事两个答案；调用顺序由 guard 编排。
import type { Database } from 'better-sqlite3';

import { AUTH_STATUS } from '@/lib/auth/realname';
import { decryptField, encryptField } from '@/lib/crypto';
import { maskCertNo } from '@/lib/evidence/attest';
import * as users from '@/lib/db/otp';
import * as realnameStore from '@/lib/db/realname';
import {
  identityStatus,
  nbdpsyConfigured,
  type FetchImpl,
  type NbdpsyIdentity,
} from '@/lib/nbdpsy/client';

/** realname_verifications.provider 里代表「对方认过」的那个值。 */
export const NBDPSY_PROVIDER = 'nbdpsy';

/** 已经带星号的就不再动；没有星号说明对方给的是全号，就地掩掉。 */
export function ensureMasked(raw: string | null): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;
  if (s.includes('*')) return s;
  return maskCertNo(s, null);
}

/** 落进 raw_meta_enc 的快照。**没有证件号明文这个键**——它在结构上就不存在。 */
export interface NbdpsySnapshot {
  provider: typeof NBDPSY_PROVIDER;
  real_name: string | null;
  id_type: string | null;
  /** 掩码后的证件号，如 `1101**********1234` */
  id_masked: string | null;
  /** 对方那边通过的时刻 */
  verified_at: string | null;
  customer_code: string | null;
  /** 我们采信它的时刻 */
  adopted_at: string;
}

/**
 * 把对方的实名终态落成本地的一条核验流水，并把 users 推到「已实名」。
 *
 * 返回 true 表示这次采信成功（调用方可以放行）。
 *
 * 【为什么 cert_no 列留空】那一列在 cloudauth 通道存的是**阿里云流水号**（可明文查），
 * 护照通道按设计恒为 null。这里既没有可查的流水号，也不该把证件号往那儿放——
 * 掩码进加密信封，那一列留 null，与护照通道同形。
 */
export function adoptIdentity(db: Database, userId: number, id: NbdpsyIdentity): boolean {
  if (!id.approved) return false;
  const snapshot: NbdpsySnapshot = {
    provider: NBDPSY_PROVIDER,
    real_name: id.realName,
    id_type: id.idType,
    id_masked: ensureMasked(id.idMasked),
    verified_at: id.verifiedAt,
    customer_code: id.customerCode,
    adopted_at: new Date().toISOString(),
  };
  db.transaction(() => {
    realnameStore.insertVerification(db, {
      userId,
      provider: NBDPSY_PROVIDER,
      certNo: null,
      status: AUTH_STATUS.verified,
      rawMetaEnc: encryptField(JSON.stringify(snapshot)),
    });
    users.setUserAuthStatus(db, userId, AUTH_STATUS.verified);
    // 姓名回填 users：出证的 holder 快照读的是那一列（lib/evidence/attest）。
    // 不回填的形态是：闸门放行了，可《存证证明》上的持有人是空的。
    if (id.realName) users.setUserRealNameOnly(db, userId, encryptField(id.realName));
    if (id.customerCode) users.setLinkedNbdpsyCustomerCode(db, userId, id.customerCode);
  })();
  return true;
}

/**
 * 去问一次对方「这个人在你们那儿实名了没有」，**只问不写**。
 *
 * 【为什么要把「问」和「采用」拆开】协议三.3：在 NBDpsy 实名过的人，首次在这里用到
 * 需要实名的功能时，我们要**先说明并征求他的单独同意，同意后才采用**。
 * 拆开之后，闸门才答得出"是没实名，还是实名了但你还没同意我们采用"——
 * 这两句话对用户是完全不同的两条路（去认证 / 点一下同意），而合成一句的形态是：
 * 一个已经认证过的人被反复要求再认证一次，而那条一步就能走完的路我们知道、他不知道。
 *
 * @returns 对方人级终态为 approved 时回那份身份；否则（没接通 / 连不上 / 没实名）回 null。
 * 一律不抛错、不重试：这条挂在用户的一次请求上，多等一轮不如让他走本地实名。
 */
export async function peekNbdpsyRealname(
  db: Database,
  userId: number,
  fetchImpl?: FetchImpl,
): Promise<NbdpsyIdentity | null> {
  // 没接通就别去解密手机号：那是一次没有用处的敏感字段解密。
  if (!nbdpsyConfigured()) return null;

  const enc = users.findUserPhoneEnc(db, userId);
  if (!enc) return null;
  let phone: string;
  try {
    phone = decryptField(enc);
  } catch {
    return null; // 解不开就当没绑手机；绝不拿密文去当匹配键
  }

  const res = await identityStatus(phone, fetchImpl ?? fetch);
  return res.ok && res.approved ? res : null;
}

/**
 * 去问一次对方，approved 就采信并放行。**只在本地未实名、且用户已单独同意采用时调**
 * （由 guard 编排，见 lib/auth/guard.ts realnameGate）。
 *
 * 对方不可用（没接通 / 连不上 / 回了看不懂的东西）一律返回 false ＝ 按未实名处理。
 */
export async function adoptNbdpsyRealname(
  db: Database,
  userId: number,
  fetchImpl?: FetchImpl,
): Promise<boolean> {
  const identity = await peekNbdpsyRealname(db, userId, fetchImpl);
  return identity ? adoptIdentity(db, userId, identity) : false;
}
