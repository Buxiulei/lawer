/**
 * 「用你自己的 agent」这件事对外说的每一句话，只在这里写一次。
 *
 * 【为什么收一个入口】这句话要出现在首页、欢迎页、驾驶舱、账户页、对话页、
 * 接入指南、skill/接入说明 七处。计费口径是零容错的：产品负责人 2026-09-02 明示
 * ——「对话与案件分析不收费」**仅指在用户自己的 agent 上处理时**，
 * 任何位置不得写成泛泛的「对话免费 / 分析免费」。散着写七遍，改口径那天必漏一处，
 * 而漏掉的那处**看起来完全正常**。守卫见 __tests__/byo-agent-copy.test.ts。
 *
 * 【纯常量 + 纯函数】不引 React、不碰网络：首页与欢迎页是 server component，
 * 驾驶舱与对话页是 client component，同一份文案要能被两边直接 import。
 */

/** 条件从句。**一字不许改**——守卫按字面断言它出现在每一句计费话术里。 */
export const BYO_CONDITION = '在你自己的 agent 上';

export const BYO = {
  title: '用你自己的 AI 助手办这件事',
  /** 低调模式下的标题：不带任何案情词 */
  titleNeutral: '接入你自己的助手',
  lead:
    '你惯用的 Claude、ChatGPT、Cursor、Codex、豆包……哪个顺手就接哪个。' +
    '档案还放在这边，对话在你那边进行——传证据、跑解读、起草文书，都在你熟悉的那个对话框里完成。',
  how: '支持 MCP 的走 MCP，不支持的走 REST，两条路能力一样。不接也不影响，网页端功能同样齐全。',
  cta: '看怎么接',
  ctaSignedOut: '注册后两分钟就能接上',
  /**
   * PC 侧栏那一栏的名字。**壳层不许手写这几个字**——
   * 侧栏、底部栏、面包屑将来都可能要念它，散着写就会分叉成三个说法。
   * 守卫见 components/shell/__tests__/sidebar-agent-nav.test.tsx 的结构那条。
   */
  navLabel: '接入我的 agent',
  /** 低调模式下的栏目名：不带案情词，也不点出"这是我的助手"。 */
  navLabelNeutral: '接入助手',
  /** 栏目右侧状态小标——还没连进来过时推一把。两种模式共用：这两个字本来就中性。 */
  navBadgeIdle: '推荐',
  /** 同上，已经连进来过时的那一态。 */
  navBadgeConnected: '已接入',
} as const;

/**
 * 计费口径唯一句式，三要素齐全：①条件 ②网页对话仍按轮计 ③后台按用量收。
 *
 * 【为什么两种模式不共用一句】低调模式下这句会出现在带 data-veil 的正文里，
 * 而 self-host-hint.test 断言那一段不含「案件 / 仲裁 / 劳动 / 维权」——
 * 所以低调变体把「案件分析」收成「分析」。常规变体则不许出现「额度」二字
 * （同一组测试的反向对照断言 not.toContain('额度')），所以「烧的是它那边的额度」
 * 这类话**只准写在别的段落**，不准并进这一句。
 *
 * 【存储那半句故意没有】存储计费本仓尚未实现（lib/billing 与 lib/company 全域无存储结算点，
 * 见 byo-agent-copy.test 的 J4）。落地当天在此加「与存储」，并让 J4 那条对照断言开始生效。
 * 提前写上，页面当天就在说谎。
 */
export function byoBillingLine(opts: { credit: string; watch: string; discreet: boolean }): string {
  const what = opts.discreet ? '对话与分析' : '对话与案件分析';
  return (
    `${BYO_CONDITION}处理的${what}，我们不收${opts.credit}；` +
    `网页里的对话仍按轮计；后台的${opts.watch}订阅按用量收。`
  );
}

/**
 * 已接入态。name 来源见 useConnectedAgent：客户端自报名优先（MCP initialize 的
 * clientInfo.name），没有就退到用户给钥匙起的名。
 */
export function byoConnectedLine(name: string, when: string): string {
  return `已接入：${name} · 最近一次 ${when}`;
}

/**
 * 名字退到钥匙名时必须补的一句。
 * **不补这句，用户会以为我们认出了他的助手**——而我们只是在念他自己填的备注。
 */
export const BYO_NAME_IS_KEY_NAME = '（这是你给钥匙起的名字——你的客户端没报自己的名字）';

/** 已接入之后的一行提要：那边不扣、这里按轮计。比整段计费话术短，用在常驻位。 */
export function byoConnectedBillingLine(credit: string): string {
  return `${BYO_CONDITION}对话不扣${credit}；这里对话按轮计。`;
}

/** 接入指南的地址。四处入口都指它，别各写各的。 */
export const BYO_GUIDE_HREF = '/settings/agent';
