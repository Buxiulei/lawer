// app/src/lib/referral/consent.ts
// 转介同意文案（设计稿 §14 决定 4：「同意文案逐项列出要传什么」）。
//
// 【为什么是一份数据，不是网页上的一段话】这段话有两个出口：网页上的「同意并转介」，
// 和用户自己的 agent 在对话里替我们复述。两处各写一份的形态是——网页上写着七条，
// agent 念了五条，而用户是照 agent 念的那五条同意的。所以正本在这里，两处都引它。
//
// 【每一条对应数据包里的一个字段】改数据包就要改这里；packet.ts 的判据钉着两者一一对应，
// 加了字段却没加条目会当场变红。

/** 同意项：`field` 是数据包里的键，`label` 是给人看的那句话。 */
export interface ConsentItem {
  field: string;
  label: string;
}

export const REFERRAL_CONSENT_ITEMS: readonly ConsentItem[] = [
  { field: 'identity', label: '你的姓名与手机号，以及你在本站是否已完成实名（含实名是在哪一侧完成的）' },
  { field: 'emotion_summary', label: '一段不超过 200 字的情绪状态摘要，由近 30 天的情绪记录与最近的对话生成（连同「其中被我们挡掉了几个词」这个数字）' },
  { field: 'referral_reason', label: '你为什么想找人聊聊，一句话（我们会先把其中的公司名与事件细节滤掉）' },
  { field: 'needs', label: '你勾选或写下的需求（例如情绪疏导、睡眠、焦虑、决策支持）' },
  { field: 'stage_sentence', label: '你的事情办到哪一步了，一句话（不含任何细节）' },
  { field: 'urgency', label: '近 72 小时内有没有出现过需要紧急关注的信号' },
  { field: 'consent_at', label: '你点下同意的时间' },
  { field: 'source_case_hash', label: '一串由本案编号算出的哈希，用于两边对账；它反查不出你的案情' },
];

/**
 * **明确不会传出去的东西**。同意文案只列「会传什么」是不够的：
 * 一个正在被裁的人最担心的恰恰是「你们会不会把我的事告诉别人」，
 * 而那个答案不在「会传什么」那张清单里——它是那张清单的补集，没人读得出来。
 */
export const REFERRAL_NOT_SHARED: readonly string[] = [
  '你公司的名字，以及任何能指认出这家公司的字眼',
  '你的事情本身：经过、金额、证据、文书，一个字都不传',
  '你上传的材料与它们的内容',
  '你的证件号码（对方即使已有，我们这边也只存掩码）',
];

/** 给 agent 逐项复述用的整段文案。**agent 引导转介时应当原样念一遍**。 */
export function consentScript(): string {
  const will = REFERRAL_CONSENT_ITEMS.map((i, n) => `${n + 1}. ${i.label}`).join('\n');
  const wont = REFERRAL_NOT_SHARED.map((s) => `· ${s}`).join('\n');
  return (
    '转介到 NBDpsy 心理咨询之前，请先确认这几件事会被发过去：\n' +
    `${will}\n\n` +
    '不会发过去的：\n' +
    `${wont}\n\n` +
    '确认之后我才会发；你随时可以不发。'
  );
}
