// app/src/lib/cases/facts-token.ts
// **facts_token：先看档再写档的强制**（设计稿 §1.3 末行 / §4.2-4 / §4.4-1）。
//
// 【它挡的是哪一类事故】用户自己的 agent 不看档就写：它按几轮之前的印象改 stage、
// 登记一笔早就改过的诉求、按一个已经作废的锚点落期限。回包 200、格式完全正常，
// 而档案里那一格被一份过期的认知覆盖了——用户下一次读档时看到的是它，不是自己的事实。
//
// 【为什么是哈希而不是时间窗】时间窗只证明"你十分钟内读过一次"，证明不了"你基于当前状态写"：
// 读完之后自己又写了三笔、或者另一端（网页、另一个 agent）改过档，时间窗照样有效。
// 哈希把令牌绑在**那一份事实卡的逐字内容**上：档案变了，令牌当场失效。
// 时间戳仍然带着，但它是**从属条件**——用来逼出周期性重读，不是主证据。
//
// 【为什么不签名】令牌里的哈希只有读过当前事实卡的人才算得出来，而事实卡本来就是
// 调用方有权读的东西。加一把密钥挡不住任何人（它挡的是"没读过就写"，而伪造哈希
// 的前提正是读过），却要多一个必须落盘、必须轮换、缺失时整条写路径全挂的秘密。
// 时间戳可被伪造成永远新鲜——**这一点是明写的、也是可接受的**：伪造时间戳的前提
// 仍然是拿着一个与当前状态一致的哈希，而那就是本闸要的全部。
//
// 【本文件零业务依赖】只吃「事实卡的那段字」，不查库、不认识案件。取事实卡与拦截分别在
// lib/capabilities/invoke.ts（MCP/REST 面）与 lib/agent/tools.ts（站内面）。
import { createHash } from 'node:crypto';

/**
 * 挂这道闸的那几条高危写能力，**按名字**列在这里（设计稿 §4.2-4 点名的四条）。
 *
 * 【为什么名单在这个零依赖文件里，而不是从注册表现算】站内工具循环（lib/agent/tools）要用它，
 * 而注册表反过来又引着 lib/agent——现算就成环。所以名单落在这里，
 * 由 lib/capabilities/__tests__ 的一条判据机检它与注册表 precondition 逐字相等：
 * 两处漂开时当场红，而不是等某条能力悄悄脱闸。
 */
export const FACTS_TOKEN_TOOLS = ['case_update', 'claims_upsert', 'deadline_set', 'draft_write'] as const;

/** 令牌前缀。带版本号是为了将来换算法时**旧令牌当场认不出**，而不是被新算法误判成 stale。 */
const TOKEN_PREFIX = 'ft1';

/** 有效期（毫秒）。设计稿 §4.2-4 定的十分钟。 */
export const FACTS_TOKEN_TTL_MS = 10 * 60 * 1000;

/** 哈希取前多少个十六进制字符。16 位（64 bit）足够挡"没读过就写"，且令牌短到能进日志。 */
const HASH_LEN = 16;

/** 事实卡逐字内容的指纹。**只认字节**：多一个空格就是另一份事实卡，这正是想要的。 */
export function factsHash(factsText: string): string {
  return createHash('sha256').update(factsText, 'utf8').digest('hex').slice(0, HASH_LEN);
}

/** 签发一枚令牌。`now` 显式传入，判据才能造"十一分钟前签的"那一臂。 */
export function issueFactsToken(factsText: string, now: Date = new Date()): string {
  return `${TOKEN_PREFIX}.${factsHash(factsText)}.${now.getTime()}`;
}

/**
 * 核验失败的原因。**四种分开**，因为对调用方的下一步完全不同：
 *   · missing   —— 根本没带：先调 case_facts 拿一枚。
 *   · malformed —— 带了但不是我们签的形状（多半是手拼的）：不要自己造令牌。
 *   · expired   —— 过了十分钟：重读一次事实卡。
 *   · stale     —— 时间没过，但档案在这期间变过：**必须重读**，你手上的认知已经不是当前状态。
 * 合成一句「令牌无效」的形态是：对方 agent 只能盲目重试，而其中三种重试都不会成功。
 */
export type FactsTokenFailure = 'missing' | 'malformed' | 'expired' | 'stale';

export type FactsTokenCheck = { ok: true } | { ok: false; reason: FactsTokenFailure };

/**
 * 核验一枚令牌是否"基于当前事实卡、且在有效期内"。
 *
 * @param token     调用方带上来的原值（任何类型都收——它来自 JSON，可能是数字、null、对象）
 * @param factsText **此刻**渲染出来的事实卡逐字内容
 */
export function verifyFactsToken(
  token: unknown,
  factsText: string,
  now: Date = new Date(),
): FactsTokenCheck {
  if (typeof token !== 'string' || token.trim() === '') return { ok: false, reason: 'missing' };
  const parts = token.trim().split('.');
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) return { ok: false, reason: 'malformed' };
  const [, hash, issuedAt] = parts;
  const issued = Number(issuedAt);
  if (!Number.isSafeInteger(issued) || issued <= 0 || !/^[0-9a-f]+$/.test(hash)) {
    return { ok: false, reason: 'malformed' };
  }
  // 【先判 stale 再判 expired】两者同时成立时，该告诉对方的是"档案变过"——那是他必须重读的
  // 真正理由。反过来先报 expired 的形态是：对方以为只是令牌旧了，重读一次照旧写同一份内容。
  if (hash !== factsHash(factsText)) return { ok: false, reason: 'stale' };
  // 签发时间落在未来（调用方自己拼的、或两端时钟差）一律按过期处理：
  // 放行未来时间等于把 TTL 拱手让给调用方去定。
  const age = now.getTime() - issued;
  if (age < 0 || age > FACTS_TOKEN_TTL_MS) return { ok: false, reason: 'expired' };
  return { ok: true };
}

/**
 * 失败原因 → 「缺什么 / 为什么缺 / 怎么办」三段式里的**前两段**。
 * 第三段（怎么办）在两个拦截点各自补上，因为出路里要带该工具自己的名字与那张事实卡。
 */
export const FACTS_TOKEN_WHY: Record<FactsTokenFailure, string> = {
  missing:
    '缺 facts_token：这次调用没带它。' +
    '它是「你基于当前档案在写」的凭据——没有它，服务端无法分辨你是刚读过档，还是在按几轮之前的印象改档。',
  malformed:
    'facts_token 不是服务端签发的形状：多半是自己拼的或抄串了。' +
    '这枚令牌只能从回包里原样取走，不能按格式手工构造——构造出来的那一枚证明不了任何事。',
  expired:
    'facts_token 已过签发有效期（十分钟）。' +
    '有效期的作用是逼一次周期性重读：中间这段时间里档案可能被网页端或另一个 agent 改过。',
  stale:
    'facts_token 对应的不是当前档案：你读过之后，这个案子的事实变过了（你自己刚写的、网页端改的、或另一个 agent 写的都算）。' +
    '按一份过期的认知覆盖当前档案，是这道闸唯一要挡的事。',
};
