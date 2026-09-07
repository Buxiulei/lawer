// app/src/app/terms/overseas/OverseasDetails.tsx
// 境外接收方的**逐项告知**（《个人信息保护法》第三十九条）。
//
// ───────────────── ⚠️ 本文件是共用层 ⚠️ ─────────────────
// 不得出现任何具体领域的字面量：开关在设置页，那时用户可能一个案件都没有。
// ─────────────────────────────────────────────────────
//
// 【为什么说明与同意件共用同一段正文】§39 要的是"告知**并**取得单独同意"。
// 说明页写一份、同意弹窗再写一份的形态是：两份慢慢分叉，
// 而用户点头时看的是弹窗那一份——于是我们对外公示的告知，与实际取得同意时给的告知，
// 不是同一段话。合规上这等于没有取得对那份告知的同意。所以正文只有这一份，
// /terms/overseas 与 <OverseasConsent/> 都渲染它。
//
// 【脱敏范围为什么从 PII_PATTERNS 推，不手写三个词】页面上写"我们会把身份证号、手机号、
// 银行卡号替换掉"，而真正替换什么由 lib/llm/pii 的那张规则表决定。手写的形态是：
// 某天规则表里加了一类（或去掉一类），页面上那句话照常渲染、读起来完全像一句承诺——
// 只是它承诺的范围与实际不同。**往少了说是漏做，往多了说是假承诺**，两个方向都要拦。
import { PII_PATTERNS, type PiiKind } from '@/lib/llm/pii';

import { Pending } from '@/app/_ui/Pending';

/** 境外接收方。协议第五条第 5 款（2）逐字写的那一家。 */
export const OVERSEAS_RECIPIENT = 'Anthropic PBC';
/** 它提供的东西：Claude 系列模型。 */
export const OVERSEAS_MODELS = 'Claude 系列模型';

/**
 * 真正会被替换掉的那几类，去重后按规则表的顺序。
 * 顺序即优先级（见 lib/llm/pii 的说明），这里只是把类别名摊平给人看。
 */
export const REDACTED_KINDS: readonly PiiKind[] = [...new Set(PII_PATTERNS.map((p) => p.kind))];

/** 与之相对：**不**替换的那几类。写出来是因为它才是用户要据以决定开不开的那一半。 */
export const NOT_REDACTED = ['姓名', '公司名称', '事实经过'] as const;

function Item({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1 sm:grid-cols-[8rem_1fr] sm:gap-3">
      <dt className="text-[13.5px] text-ink-2">{label}</dt>
      <dd className="text-[14.5px] leading-7 text-ink">{children}</dd>
    </div>
  );
}

/**
 * §39 要求告知的每一项，一项一行。
 *
 * 【为什么做成定义列表而不是一段话】用户要在这一页上做一个是/否的决定。
 * 写成一段流水的形态是：他读到第三行就开始跳，而跳过去的那几行恰恰是
 *「哪些信息不会被替换」——那是唯一会改变他决定的一行。
 */
export function OverseasDetails() {
  return (
    <dl className="flex flex-col gap-3 rounded-[12px] border border-line bg-surface p-4 sm:p-5">
      <Item label="境外接收方">
        {OVERSEAS_RECIPIENT}（提供 {OVERSEAS_MODELS}）。
        <strong className="font-semibold text-ink">经中转服务商接入</strong>
        ，即请求不直连对方，先到中转服务商再转发；这不改变数据到达境外这一事实。
        <Pending>待主理人确认：中转服务商名称与所在地</Pending>
      </Item>
      <Item label="联系方式">
        <Pending>待主理人确认：境外接收方的联系方式（须与其官方公示一致）</Pending>
        在它被填上之前，向境外接收方行使权利请先经我们转达（见下）。
      </Item>
      <Item label="处理目的">
        为你生成分析：整理事实、核对期限、计算金额、起草文书、解读你上传的文件。
        不用于训练它们的模型，不用于向你营销。
      </Item>
      <Item label="处理方式">
        我们把这一轮对话与档案摘要发过去，对方即时生成回复后返回；由我们落库。
        我们不在对方那里为你建账号，也不把你的账号信息发过去。
      </Item>
      <Item label="个人信息种类">
        这一轮的对话内容与档案摘要，其中可能含有你的姓名、你登记的对方主体名称、
        时间线与事实经过、金额，以及你自己在对话里写下的任何内容。
      </Item>
      <Item label="发送前替换掉的">
        <span className="text-ink">{REDACTED_KINDS.join('、')}</span>
        ——这几类在出境前一律替换为占位符，且替换不可逆。
        <strong className="font-semibold text-ink">
          {NOT_REDACTED.join('、')}不作替换
        </strong>
        ，请据此决定是否开启。
      </Item>
      <Item label="行使权利的方式">
        查阅、复制、更正、删除，撤回本项同意——都通过站内「设置 → 帮助与投诉」提出，
        由我们受理并向境外接收方转达；我们在 15 个工作日内办结，拒绝的会说明理由。
        撤回同意后不再向境外发送，但不影响撤回前已经进行的处理。
      </Item>
      <Item label="不同意的后果">
        你仍可使用仅境内模型的<strong className="font-semibold text-ink">全部</strong>服务。
        境外模型默认关闭，不点同意就不会开。
      </Item>
    </dl>
  );
}
