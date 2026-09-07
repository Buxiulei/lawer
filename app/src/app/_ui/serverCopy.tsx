'use client';

/**
 * 服务端下发的那些句子，画到页面上时怎么画。
 *
 * 【为什么需要这一处】协议那几条的正本文案全在服务端（会删什么、会留下什么、撤回后会发生
 * 什么、余额怎么算、删除请求到底送没送出去），网页**照念不另写一份**——这是对的，
 * 但那些句子同时也是给 agent 读的，里头带着 `**…**` 这种强调。原样丢进 JSX 的形态是：
 * 用户在最该读清的那一句上看到四个裸星号（「点这个按钮 **不会** 注销任何东西」、
 * 「余额处理方式 **尚未定稿** 」），而没有一处报错、快照也照旧全绿。
 *
 * 【为什么是一个组件而不是各处 replace 掉星号】星号不是噪音，它标的正是那句话里最要紧的
 * 半句。就地删掉等于把强调丢了；各处自己写一遍解析，则是"独立写 N 次忘 N 次"。
 * 所以收成这一个组件：凡是画服务端文案的地方都过它，判据钉着「页面上不出现裸星号」。
 *
 * 只认 `**粗体**` 这一种记号——服务端文案里今天只用这一种。多认几种没有需求支撑，
 * 而每多认一种就多一条会把用户文案渲染错的路径。
 */

import { Fragment } from 'react';

/** 把一句服务端文案切成「普通段 / 粗体段」交替的片段。导出供判据直接验切法。 */
export function splitBold(text: string): { bold: boolean; text: string }[] {
  const out: { bold: boolean; text: string }[] = [];
  // 非贪婪且不跨越空的一对：`****` 这种退化写法照原样当普通文本，不产出空的粗体段。
  const re = /\*\*([^*]+?)\*\*/g;
  let last = 0;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    if (m.index > last) out.push({ bold: false, text: text.slice(last, m.index) });
    out.push({ bold: true, text: m[1] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ bold: false, text: text.slice(last) });
  return out;
}

/** 画一句服务端文案。没有强调记号时与直接写 {text} 逐字等价。 */
export function ServerCopy({ text }: { text: string }) {
  return (
    <>
      {splitBold(text).map((seg, i) => (
        <Fragment key={`${i}-${seg.text}`}>
          {seg.bold ? <strong className="font-medium text-ink">{seg.text}</strong> : seg.text}
        </Fragment>
      ))}
    </>
  );
}
