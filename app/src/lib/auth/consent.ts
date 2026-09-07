// app/src/lib/auth/consent.ts
// 注册/登录那一道同意闸（协议 一.3、二.6 / 附一 #1、#2）。
//
// 【为什么闸在这一层，而不是在建号函数里】"完成注册"这件事发生在**发出登录态**的那一刻，
// 而发登录态的路由只有三条（手机验码、邮箱注册验码、邮箱通道验码）。闸挂在这三条上，
// 判定与文案只有一份；挂在建号函数里则拦不住"老用户第一次登录时补勾"那一半需求——
// 他不建号，却同样必须先勾。
//
// 【为什么每次登录都要带，而不只是注册那一次】协议第一条把生效条件写成"你在注册页勾选后"，
// 而**存量用户从来没勾过**。让老用户在下一次登录时补勾，是附一 #1 的原话；
// 而"这次带没带勾选"服务端只有在每次都要求时才判得出来——只在建号那一次要求的形态是：
// 存量用户永远走不到那一次，于是永远没有同意记录，而登录一切正常。
//
// 已经勾过的人不会被多问：登录页那个勾选框本来就在（本票之前就是发码的前置条件），
// 页面每次都会把它带上来；带不上来的调用方（老版页面、脚本）会拿到一条说明怎么办的错。
import type { Database } from 'better-sqlite3';

import { CONSENT_KINDS } from '@/lib/consent';
import { hasConsent, ipDigest, recordConsent } from '@/lib/db/consents';
import { getModelPreferences, setModelPreferences } from '@/lib/db/otp';

import type { AuthFailure } from './otp';

/** 三个勾选框在请求体里的字段名。前后端只认这一份常量。 */
export const AGREE_TERMS_FIELD = 'agree_terms';
export const AGREE_ADULT_FIELD = 'agree_adult';
/** 境外模型那一个（可选，见 RegistrationConsent.overseas） */
export const AGREE_OVERSEAS_FIELD = 'agree_overseas';

export interface RegistrationConsent {
  /** 我已阅读并同意《用户服务协议》 */
  terms: boolean;
  /** 我已年满十八周岁 */
  adult: boolean;
  /**
   * 我同意使用 Claude 模型并向境外提供个人信息（主理人 2026-09-07 口径 / 附一 #6）。
   *
   * **这一位不参与闸门判定**：它是可选的，不勾照样注册（协议五.5（2）：不同意的仍可
   * 使用仅境内模型的全部服务）。把它加进 registrationConsentFailure 的形态是——
   * 一个"单独同意"变成了注册的前置条件，那它就不再是单独同意了。
   */
  overseas: boolean;
}

/** 从请求体读三个勾选位。**只认布尔真**：字符串 'true'、数字 1 一律不算勾过。 */
export function readRegistrationConsent(body: Record<string, unknown>): RegistrationConsent {
  return {
    terms: body[AGREE_TERMS_FIELD] === true,
    adult: body[AGREE_ADULT_FIELD] === true,
    overseas: body[AGREE_OVERSEAS_FIELD] === true,
  };
}

/** 这个账号此前是不是两样都同意过（老用户补勾之后就不必每次再带） */
export function hasRegistrationConsent(db: Database, userId: number): boolean {
  return (
    hasConsent(db, userId, CONSENT_KINDS.terms) && hasConsent(db, userId, CONSENT_KINDS.adult)
  );
}

/**
 * 闸门本身：两个框都勾了就过；没勾但**这个账号此前勾过**也过（补绑邮箱那一步不再问一遍）。
 *
 * @param knownUserId 这次调用之前就能确定的账号（带 token 的补绑那一路）；
 *                    验码之前拿不到账号的（手机/邮箱注册）传 null——那时只能按勾选位判。
 * @returns 过了回 null；没过回可直接 failureResponse 的失败结构。
 */
export function registrationConsentFailure(
  db: Database,
  body: Record<string, unknown>,
  knownUserId: number | null,
): AuthFailure | null {
  const consent = readRegistrationConsent(body);
  if (consent.terms && consent.adult) return null;
  if (knownUserId !== null && hasRegistrationConsent(db, knownUserId)) return null;

  const missing = [
    consent.terms ? null : '《用户服务协议》',
    consent.adult ? null : '年满十八周岁的确认',
  ].filter((x): x is string => x !== null);

  return {
    ok: false,
    status: 400,
    errorCode: 'CONSENT_REQUIRED',
    // 自述三段式：缺什么 / 为什么缺 / 怎么办
    message:
      `还缺一处勾选：${missing.join(' 与 ')}。` +
      '协议里免责、管辖、个人信息三类条款与你有重大利害关系，' +
      '要由我们提示到、并且由你自己勾选确认之后，账号才算建成（未满十八周岁不能使用本服务）。' +
      '请回到登录页把两个框都勾上再提交。',
  };
}

/**
 * 落台账。**在发出登录态之后调**：账号 id 那时才确定。
 *
 * 幂等由 consents 的唯一索引兜底（同一人同一类同一版本只有一行），
 * 所以老用户每次登录都调它也不会把台账刷满。
 *
 * 【境外那一位只往"开"的方向走，绝不往"关"的方向走】没勾时**什么都不做**，
 * 而不是把 users.overseas_models 置 0。反过来的形态是：一个在设置页开过境外模型的人，
 * 下次登录时因为注册页那个框默认未勾，开关被静默关掉——他没做任何撤回的动作，
 * 设置页却变了样，而两边都不报错。撤回是设置页那条路的事（协议五.9）。
 */
export function recordRegistrationConsent(
  db: Database,
  userId: number,
  body: Record<string, unknown>,
  ip: string | null,
): void {
  const digest = ipDigest(ip);
  const consent = readRegistrationConsent(body);

  // 【三个框都只按"这次请求里勾没勾"落行，不按"闸门放没放行"落行】闸门有一条旁路：
  // 补绑那一路（knownUserId 已同意过）不带勾选位也能过。无条件落行的形态是——
  // 协议改版之后，这个人凭旧版的同意过了闸，我们却给他记上一行**新版**的同意，
  // 而他从没读过新版那份文本。台账要回答"他当时同意的是哪一版"，编出来的那一行
  // 让这个问题永远答不对，且没有任何一处会报错。
  if (consent.terms) recordConsent(db, { userId, kind: CONSENT_KINDS.terms, ipDigest: digest });
  if (consent.adult) recordConsent(db, { userId, kind: CONSENT_KINDS.adult, ipDigest: digest });

  if (consent.overseas) {
    recordConsent(db, { userId, kind: CONSENT_KINDS.overseas, ipDigest: digest });
    // 台账记"他同意过"，开关记"现在生效的是什么"。两样都要写：
    // 只写台账的形态是他勾了框而路由照样走境内，只写开关的形态是日后证明不了他同意过。
    setModelPreferences(db, userId, { overseasModels: true });
  }
}

// ───────────────── 实名认证发起前那一次单独同意（协议 五.2（1）/ 附一 #4）─────────────────

/** 两条发起认证的路（身份证刷脸 / 护照人工审）在请求里带同意位用的字段名 */
export const REALNAME_CONSENT_FIELD = 'consent';

/**
 * 发起实名认证之前必须有过的那一次单独同意。
 *
 * 【为什么闸在"发起"而不是"落库"】证件号是在**发起**那一刻交给我们的（护照那条连
 * 资料页照片一起）。落库时再问，敏感信息已经进了进程内存；协议五.2（1）承诺的是
 * 「仅在你发起实名认证时收集」「认证页面会单独征求你的同意」——问必须在收之前。
 *
 * @param given 这次请求带上来的勾选位
 * @returns 过了回 null（并把这次点头落进台账）；没过回可直接返回的失败结构。
 */
export function realnameConsentFailure(
  db: Database,
  userId: number,
  given: boolean,
  ip: string | null,
): AuthFailure | null {
  if (given) {
    recordConsent(db, { userId, kind: CONSENT_KINDS.realname, ipDigest: ipDigest(ip) });
    return null;
  }
  // 上一次已经同意过（比如刷脸没做完、回来重发一次）就不再问第二遍：
  // 同一件事反复要求点头，用户会把它读成"点了没生效"。
  if (hasConsent(db, userId, CONSENT_KINDS.realname)) return null;

  return {
    ok: false,
    status: 400,
    errorCode: 'CONSENT_REQUIRED',
    // 自述三段式：缺什么 / 为什么缺 / 怎么办
    message:
      '还差一次单独同意：实名认证要收集你的姓名与证件号，这属于敏感个人信息。' +
      '为什么要它：存证证明必须与真实身份绑定，否则日后无法出证；' +
      '证件号加密存储，页面与文书只展示掩码。' +
      '怎么办：在实名页读完那段说明、勾选「我同意提供姓名与证件号用于实名认证」再提交。' +
      '不同意也可以继续对话、登记事实、算金额、写草稿。',
  };
}

// ───────────────── 境外模型的有效同意（协议 五.5（2）/ 五.9 / 附一 #6）─────────────────

/**
 * 这个账号此刻允不允许把对话交给**境外接收方**处理。**全站只有这一个判据**，
 * 唯一的调用点是 lib/agent/orchestrator 里取模型那一处（唯一一处按用户挑模型的地方）。
 *
 * 【为什么是"开关 ∧ 有效同意"两个都要】两件事记在两处，各自答的不是同一个问题：
 *  · users.overseas_models 是**此刻生效的状态**——用户可以随手关掉再打开，关掉不是撤回；
 *  · consents 那一行是**发生过的事实**，撤回之后 hasConsent 就不再认它（协议五.9）。
 * 只看开关的形态是：一个在设置页撤回过同意的人，开关还开着（撤回那条路忘了关它），
 * 于是他的对话继续出境；只看台账的形态是：一个同意过、但把开关关掉的人，
 * 关了跟没关一样。两个都要，缺哪个都是"页面显示的与实际发生的相反"。
 *
 * 【为什么不给缺省放行的重载】没有默认值可言：调用方只有一个，多出来的那个调用方
 * 应当被迫想清楚它凭什么放行，而不是继承一个"看起来安全"的缺省。
 */
export function overseasModelsAllowed(db: Database, userId: number): boolean {
  return hasConsent(db, userId, CONSENT_KINDS.overseas) && getModelPreferences(db, userId).overseasModels;
}
