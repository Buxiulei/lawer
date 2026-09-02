// app/src/app/(app)/case/[id]/_stream/__tests__/message-id-shape.test.ts
// 【SSE 边界上的类型不是声明出来的，是收进来的】
//
// ─────────────── 这组补的是哪个缺口 ───────────────
// 真机（2026-09-02，chatfin-live 本机产线栈）：真对话每一轮回答**刚渲染完**，
// 整页变成 "This page couldn't load"。浏览器里的原始报错：
//     TypeError: r.startsWith is not a function
//       at Array.find …  at Workbench (mockLawRefs(turn.messageId))
//
// 病因是一条**两边都写得很自信、却对不上**的契约：
//   · 服务端 `lib/agent/events.ts`：meta / done 的 `message_id` 是数据库主键，**number**
//   · 前端   `_stream/frames.ts`：`MetaFrame` / `DoneFrame` 写的是 **string**
// 中间那句 `return { ...payload, type } as StreamFrame` 是**无校验断言**，
// 于是 tsc 全绿、单测全绿、演示页也全绿——因为演示替身发的 `m_<剧本id>_<时间戳>`
// 真的是字符串。**只有真对话会走到那个 number**，而那恰恰是没人拿浏览器跑过的一条路。
//
// 所以这组判据不问"类型声明写了什么"，只问"喂进去真的服务端报文，出来的是什么"。
//
// 【变异臂】
//  · M-I1 toFrame 去掉 message_id 归一 ⇒ 「number 收成 string」两条红
//  · M-I2 归一改成 `String(payload.message_id)` 无条件执行（把 undefined 造成 "undefined"）
//        ⇒ 「没有这个字段就不要凭空造一个」那条红
import { describe, expect, it } from 'vitest';

import { toFrame, type DoneFrame, type MetaFrame } from '../frames';

/** 服务端 events.ts 里 done 帧的真实形状：message_id 是 number。 */
const SERVER_DONE = {
  message_id: 41,
  finish_reason: 'stop',
  model: 'deepseek-v4-pro',
  served_model: 'deepseek-v4-pro',
  served_mismatch: false,
};

/** 服务端 meta 帧同样把主键当 number 发。 */
const SERVER_META = {
  thread_id: 7,
  message_id: 41,
  mode: '陪跑',
  intake_stage: '已完成',
  task_class: 'critical',
  model: 'deepseek-v4-pro',
  degraded: false,
};

describe('★真服务端报文喂进来：主键收成字符串，别让消费方对着 number 调字符串方法', () => {
  it('done.message_id 是 number ⇒ 出来是 string，且值不变', () => {
    const frame = toFrame('done', SERVER_DONE) as DoneFrame;
    expect(typeof frame.message_id, 'number 漏到了下游').toBe('string');
    expect(frame.message_id).toBe('41');
  });

  it('meta.message_id 同样归一（两个帧都带主键，只修一个等于没修）', () => {
    const frame = toFrame('meta', SERVER_META) as MetaFrame;
    expect(typeof frame.message_id).toBe('string');
    expect(frame.message_id).toBe('41');
  });

  /**
   * 这条是上面那个 TypeError 的**直接复现**：Workbench 收尾时拿 messageId 去
   * `mockLawRefs` 里 `startsWith`。它抛在 React 渲染里，整棵树垮掉。
   */
  it('归一之后，消费方那句 startsWith 不再炸（真机那一行的最小复现）', () => {
    const frame = toFrame('done', SERVER_DONE) as DoneFrame;
    expect(() => frame.message_id.startsWith('m_')).not.toThrow();
    expect(frame.message_id.startsWith('m_'), '真主键本来就不该匹配演示剧本前缀').toBe(false);
  });

  it('演示替身发的本来就是字符串 ⇒ 原样不动', () => {
    const frame = toFrame('done', { ...SERVER_DONE, message_id: 'm_xieshang_1788' }) as DoneFrame;
    expect(frame.message_id).toBe('m_xieshang_1788');
  });
});

describe('别过度归一：没有这个字段的帧不许被凭空造出一个', () => {
  it('usage 帧没有 message_id ⇒ 不长出一个 "undefined"', () => {
    const frame = toFrame('usage', { model: 'x', prompt: 1, completion: 2, cached_read: null, cached_write: null });
    expect(frame).not.toBeNull();
    expect('message_id' in (frame as object), '凭空多出一个字段比缺一个更难查').toBe(false);
  });

  it('未知帧类型照旧返回 null（后端加帧不该让老前端崩掉）', () => {
    expect(toFrame('brand_new_frame', { message_id: 1 })).toBeNull();
  });
});
