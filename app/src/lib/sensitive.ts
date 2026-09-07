// app/src/lib/sensitive.ts
// 敏感级出口（设计稿 §16「敏感级」）的**唯一入口**。
//
// 【它管的是哪几个出口】一个领域声明了 DomainPack.sensitive，意思是这个领域的档案里
// 写着**第三人**的敏感个人信息（个保法 §28 那一类）。这样的档案有三个出口：
//   ① 每轮喂给模型的事实卡  → lib/agent/case-facts.ts（读 sensitive.factsNotice）
//   ② 免登录分享页 / 导出   → lib/shares.ts、lib/drafts/export.ts（读本文件）
//   ③ 转介数据包            → lib/referral/packet.ts（读本文件）
//
// 【为什么必须收成一个入口】三处各写一遍"记得脱敏"的形态是——总有一个出口忘了，
// 而它照常返回 200、页面上什么都不缺。**独立写 N 次就会忘掉其中某一次**，
// 所以政策只写在这里，改口径只改这里。
//
// 【为什么脱敏是不可逆的，不复用 lib/llm/pii 的占位符会话】那一条链路要**还原**
// （文书里本来就要填身份证号），所以它把真值留在内存映射表里。分享页与转介包是
// 交出去就不在我们手里的东西，留一张能还原的表没有意义，只有风险。
// 两处共用的只有**识别规则**（PII_PATTERNS），那份必须同源：
// 某次给手机号补一种写法只补一处的形态是，另一处从此漏掉那种写法，而两处都不报错。
//
// 【没声明 sensitive 的领域一个字都不变】本文件所有函数在那种情况下原样返回输入，
// 所以第一个领域的分享页、导出 PDF 与转介包逐字不变。

import type { Database } from 'better-sqlite3';

import { PII_PATTERNS } from '@/lib/llm/pii';
import { domainPackOrDefault, type DomainSensitivity } from '@/lib/domains/registry';

/**
 * 脱敏后留下的占位。**明说这里被挡掉了一段**，不是留白——
 * 留白的形态是：读的人以为这一栏本来就没填，于是回头去问"你怎么没写联系方式"。
 */
export const SENSITIVE_MASK = '〔已脱敏〕';

/**
 * 这个领域的敏感级声明；没声明回 null（= 本领域不按敏感级处理，是结论不是待填项）。
 *
 * 走 `domainPackOrDefault` 而不是 `getDomainPack`：这是**读路径**，
 * 一行 domain 写坏的案件不该让用户连自己的分享链接都打不开（政策见 registry 的头注释）。
 * 代价是那种案件会按缺省领域的敏感级处理——而缺省领域没有敏感级声明，
 * 于是退回"不脱敏"。这一点写在这里，不是遗漏：**要改成"取不到就按最严处理"，改这一行**。
 */
export function sensitivityOf(domain: string | null | undefined): DomainSensitivity | null {
  return domainPackOrDefault(domain).sensitive ?? null;
}

/** 一次脱敏的结果。`hits` 只报**条数**，不报值——报值等于在同一份产物里附上一张原文清单。 */
export interface RedactResult {
  text: string;
  /** 换掉了几处（去重前的出现次数）。0 = 这段文本本来就是干净的 */
  hits: number;
}

/**
 * 把一段文本里的联系方式类标识（身份证 / 手机号 / 银行卡）**不可逆**地换成占位。
 *
 * 识别规则与出境脱敏同源（PII_PATTERNS），方向同样是「宁可多替，不可漏替」：
 * 多替一次只是读的人少看见一个订单号，漏替一次是把一个第三人的联系方式发了出去。
 */
export function maskContacts(text: string): RedactResult {
  let hits = 0;
  let out = text;
  for (const { re } of PII_PATTERNS) {
    // 正则带 g 且是模块级共享对象，lastIndex 会跨调用残留 —— 每次新建一个
    out = out.replace(new RegExp(re.source, re.flags), () => {
      hits += 1;
      return SENSITIVE_MASK;
    });
  }
  return { text: out, hits };
}

/**
 * 一个来访化名/编号的**最短长度**。比它短的登记名不参与替换。
 *
 * 【为什么不是替换一切】替换是**整段文本里的字面量替换**：一个单字的登记名
 *（用户随手把对方记成「甲」）会把正文里每一个「甲」都换成占位，
 * 于是「甲方」变成「〔已脱敏〕方」，整份文书读不成句。
 * 漏掉一个单字化名的代价是它留在页面上；替掉它的代价是整份产物作废——
 * 而后者还会让人以为系统坏了。
 */
const ALIAS_MIN_LEN = 2;

/**
 * 把**本案登记过的对方称呼**（这个领域里就是来访化名或编号）换成占位。
 *
 * 【为什么这一道不能只靠 PII 规则】PII 规则认的是身份证/手机号/银行卡这类**有形状**的串。
 * 而这个领域的来访者身份根本不是那种形状——§16 明说不收真实姓名，
 * 身份**就是**那个化名或编号（「来访A」「2026-031」）。只跑 PII 规则的形态是：
 * 分享页上同时出现「来访甲乙丙」和一句声称化名已被替换的说明，两边都不报错，
 * 而读的人会把这个真化名当成占位符。
 *
 * 长的先替：短名是长名的一截时（「来访甲」与「来访甲乙丙」），先替短的会把长的切碎，
 * 剩下的半截留在页面上。
 */
function maskAliases(text: string, aliases: readonly string[]): RedactResult {
  let hits = 0;
  let out = text;
  for (const alias of [...aliases].sort((a, b) => b.length - a.length)) {
    const parts = out.split(alias);
    if (parts.length === 1) continue;
    hits += parts.length - 1;
    out = parts.join(SENSITIVE_MASK);
  }
  return { text: out, hits };
}

/**
 * 出口二（分享页 / 导出）交出去的产物要过的**全部**脱敏。
 *
 * @returns `notice` 是要**印在产物上**的那句话（说明这里被脱敏过、要核对该找谁）。
 *   不印这句话的形态是：读的人看到一串〔已脱敏〕，以为是系统出错或者对方在藏什么，
 *   于是回头找当事人索要真值——脱敏挡住了数据，却把索要真值这件事推给了当事人本人。
 *   没声明敏感级的领域回 `notice: null` 且正文逐字不变。
 */
export interface ShareRedactor {
  /** 印在产物上的那句话；null = 本领域不按敏感级处理，下面两个函数原样返回输入 */
  notice: string | null;
  /** 一段正文 */
  text(text: string | null): { text: string | null; hits: number };
  /** 键值对（分享页的证据元数据）：值逐个过，键不动 */
  record(meta: Record<string, string> | null): { meta: Record<string, string> | null; hits: number };
}

/** 本案所属领域。取不到（案件被删）回 null——由 sensitivityOf 决定那时按什么处理。 */
function caseDomain(db: Database, caseId: number): string | null {
  const row = db.prepare('SELECT domain FROM cases WHERE id = ?').get(caseId) as
    | { domain: string }
    | undefined;
  return row?.domain ?? null;
}

/**
 * 本案登记过的对方称呼。这个领域的 company_profiles 里装的就是来访化名/编号
 *（首诊那一格逐字写着"填化名或编号，不要填真实姓名"）。
 */
function caseAliases(db: Database, caseId: number): string[] {
  return (
    db.prepare('SELECT name FROM company_profiles WHERE case_id = ?').all(caseId) as {
      name: string;
    }[]
  )
    .map((r) => r.name.trim())
    .filter((n) => n.length >= ALIAS_MIN_LEN);
}

/**
 * **出口二的唯一入口**：按案件取一次，分享页与导出两条路共用。
 *
 * 【为什么是"按案件取一个脱敏器"，不是"按领域调一个脱敏函数"】要洗的东西有两类：
 * 有形状的联系方式（跨案件同一套规则）与**本案登记的化名**（每个案件各不相同）。
 * 做成两个参数的形态是：某条路只传了领域、忘了传化名清单，而它照常返回 200、
 * 页面上什么都不缺——正是这一票开工时分享页的实际状态。
 * 收成"拿不到 db 与 caseId 就构造不出脱敏器"，忘掉化名这件事在类型上就做不到。
 */
export function shareRedactorFor(db: Database, caseId: number): ShareRedactor {
  const sensitive = sensitivityOf(caseDomain(db, caseId));
  if (!sensitive) {
    return {
      notice: null,
      text: (text) => ({ text, hits: 0 }),
      record: (meta) => ({ meta, hits: 0 }),
    };
  }
  const aliases = caseAliases(db, caseId);
  const scrub = (t: string): RedactResult => {
    const byPattern = maskContacts(t);
    const byAlias = maskAliases(byPattern.text, aliases);
    return { text: byAlias.text, hits: byPattern.hits + byAlias.hits };
  };
  return {
    notice: sensitive.redactNotice,
    text: (text) => (text === null ? { text, hits: 0 } : scrub(text)),
    record: (meta) => {
      if (meta === null) return { meta, hits: 0 };
      let hits = 0;
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(meta)) {
        const masked = scrub(v);
        hits += masked.hits;
        out[k] = masked.text;
      }
      return { meta: out, hits };
    },
  };
}
