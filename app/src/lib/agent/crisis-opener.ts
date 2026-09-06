// app/src/lib/agent/crisis-opener.ts
// 危机首段的**领域中立骨架**：热线取数（结构化 facts → 号码）与首段拼装。
//
// ───────────────── ⚠️ 本文件是共用层 ⚠️ ─────────────────
// 这里只有「怎么拼」，没有「拼成什么话」。每一句对用户说的话都由领域包给
// （DomainPack.crisis.openerText / firstSegment），本文件一个字都不写死。
//
// 【为什么要从 crisis.ts 拆出来】领域包要能自己产出首段（第二个领域的首段不是给来访者的
// 热线话术，而是给咨询师的处置骨架），于是领域包必须调得到拼装函数；而 crisis.ts 又要
// 从领域包取词表与文案。两边互引就是循环导入——它的失效形态是**模块加载顺序决定生死**：
// 谁先被 import，另一边的顶层常量就是 undefined，而报错点离病因隔着好几层。
// 拆成这个叶子模块（谁都不引它、它谁都不引）之后，环从结构上就不存在了。
// ─────────────────────────────────────────────────────

/** 结构化事实里的一条热线（形状同 lib/knowledge 的 PackFacts.hotlines） */
export interface HotlineFact {
  name: string;
  phone: string;
  /** 资源类别（WS4 PR #30）。危机首段只取 crisis，不再靠 name 含「心理」猜 */
  category?: 'crisis' | 'legal' | 'union' | 'inspection';
  status: 'usable' | 'forbidden';
  hours?: string;
  note?: string;
}

/**
 * 该号码是否**只能座机拨打**。
 *
 * 依据的是中国电信编号规则而非卡里的文案：800 开头是被叫付费号，**手机拨打不通**
 * （与之配对的 400 号则手机座机都能打）。这是号码本身的属性，任何卡、任何时候都成立，
 * 所以判据放在号码形状上，而不是去读 name 里有没有「座机」或 note 里有没有「打不通」——
 * 那两处都是散文，改一个字这层保护就没了。
 *
 * 为什么必须有这层：危机首段的全部意义是「不用等我说完，现在就能打」。一个自杀念头
 * 正强的人拿手机拨 800-810-1117 得到的是空响，那一刻的失败比不给号码更伤人。
 */
export function isLandlineOnly(phone: string): boolean {
  return /^800[-\s]?\d/.test(phone.trim());
}

/** 座机专线在用户可见文案里必须携带的标记（评测侧按同一常量校验，判据同源） */
export const LANDLINE_MARK = '座机拨打，手机打不通';

/**
 * 从卡的**结构化 facts** 里取心理危机热线。**不解析正文散文**——
 * 「让代码去猜散文」正是号码事故的根因（8 个号码里混进公证处电话），已由 manager 定为
 * 项目级根治方向：正文散文服务人与模型，结构化字段服务代码，一卡两面。
 *
 * 两道过滤：
 *   ① `status !== 'forbidden'`——禁用与否由卡自己声明，代码不再去正文里找 ⛔；
 *   ② 只取**心理**类热线——资源卡的 hotlines 里同时装着法援/工会/劳动监察，
 *      它们不该出现在危机首段（那一刻要的是能接住人的线，不是投诉渠道）。
 */
export function crisisHotlines(facts?: { hotlines?: HotlineFact[] }): HotlineFact[] {
  const all = facts?.hotlines;
  if (!Array.isArray(all)) return [];
  return all.filter((h) => h && h.category === 'crisis' && h.status === 'usable' && typeof h.phone === 'string');
}

/** 卡里声明为禁用的号码（status: forbidden）。评测侧共用这一份（判据同源）。 */
export function bannedHotlines(facts?: { hotlines?: HotlineFact[] }): Set<string> {
  const all = facts?.hotlines;
  if (!Array.isArray(all)) return new Set();
  return new Set(all.filter((h) => h?.status === 'forbidden' && typeof h.phone === 'string').map((h) => h.phone));
}

/** 只要号码（紧凑重述用） */
export function extractHotlines(facts?: { hotlines?: HotlineFact[] }): string[] {
  return crisisHotlines(facts).map((h) => h.phone);
}

/**
 * 一个领域的危机首段**固定文案**。骨架由 assembleCrisisOpener 拼，字全在这里，
 * 由领域包提供——首段是一个人在最坏的那个夜里读到的第一句话，
 * 不能有的轮次强有的轮次弱，也不能被模型的即兴发挥改写。
 */
export interface CrisisOpenerText {
  /** 号码之前的开场（逐行）。一条热线都取不到时，只发 head[0]。 */
  head: readonly string[];
  /** 号码之后的收束句 */
  tail: string;
  /** 收束句之后再跟一句（窗外首次才给；不需要时省略） */
  after?: string;
}

/**
 * 拼装确定性首段。**两态，与注入层同一套窗口口径**：
 *   · **窗外首次**：带机构名与时段等描述性内容——第一次拿到号码的人需要知道那头是谁、
 *     什么时候有人；
 *   · **窗内复现**（compact）：只给号码行，不重印整张，也不再跟 `after` 那一句。
 *
 * 座机标记两态都不能省：用户可能只看那一行就去拨号。
 */
export function assembleCrisisOpener(
  text: CrisisOpenerText,
  facts?: { hotlines?: HotlineFact[] },
  options: { compact?: boolean } = {},
): string {
  const lines = crisisHotlines(facts);
  const head = [...text.head];
  if (lines.length === 0) return head[0];

  if (options.compact) {
    const nums = lines.map((h) => (isLandlineOnly(h.phone) ? `${h.phone}（座机）` : h.phone));
    return [...head, '', `**${nums.join(' / ')}**`, '', text.tail].join('\n');
  }

  return [
    ...head,
    '',
    ...lines.map((h) => {
      const hours = h.hours ? `（${h.hours}）` : '';
      // 座机线单独给出拨打限制，并直接把配对的手机线指出来——两条线在同一段里，
      // 用户不必自己在列表里比对哪条能用手机打
      const caveat = isLandlineOnly(h.phone) ? `\n  ——**${LANDLINE_MARK}**；用手机请拨下面那条` : '';
      return `- **${h.phone}** ${h.name}${hours}${caveat}`;
    }),
    '',
    text.tail,
    ...(text.after ? ['', text.after] : []),
  ].join('\n');
}

/**
 * 把归档正文拆成「确定性首段」与「模型段」。
 *
 * 【为什么与拼装同处一个文件】拆分若照抄一份字面量，改了那边忘了这边，拆分会静默失败——
 * 而它失败的样子是「整段被当成模型段去判」，恰好制造一次凭空的闸命中。同一份 text，
 * 两边就不可能对不上。
 *
 * 非危机轮没有首段，原样返回（`opener` 为空串）。
 */
export function splitCrisisOpenerWith(
  text: CrisisOpenerText,
  raw: string,
): { opener: string; body: string } {
  if (!raw.startsWith(text.head[0])) return { opener: '', body: raw };
  const i = raw.indexOf(text.tail);
  let end = i < 0 ? text.head[0].length : i + text.tail.length;
  // 全量态首段在 tail 之后紧跟 `after` 那一句。它也是确定性首段的一部分，
  // 同样**不参与模型段的判定/剥除**，所以要一起划进 opener——否则出口侧的闸会把这句
  // 合法的系统文案当成模型自作主张剥掉。
  // 只认**紧跟在 tail 之后**的那一处（复现态没有这句；模型段偶然出现同句时不会把切分点带偏）。
  if (text.after) {
    const rest = raw.slice(end);
    const afterGap = rest.replace(/^\n+/, '');
    if (afterGap.startsWith(text.after)) {
      end += rest.length - afterGap.length + text.after.length;
    }
  }
  return { opener: raw.slice(0, end), body: raw.slice(end).replace(/^\n+/, '') };
}
