/**
 * 每条回答底下要标出**这一轮实际是谁答的**。
 *
 * ─────────────── 这组补的是哪个缺口 ───────────────
 * 用户按型号付费，页面却从不告诉他这一轮拿到的是什么。更要命的是，
 * 唯一现成可标的值是 `meta.model`——那是我们**请求**的型号，不是实际服务的。
 * 中转按渠道分组路由，请求 opus 完全可能由 sonnet 返回（billing/served-model.ts 文件头实测），
 * 拿请求值当"实际"标出去，就是用一个我们自己都知道可能不对的数字回答
 * "我这一轮拿到了什么"。**标错比不标更坏**：不标只是缺信息，标错是给了一个假答案。
 *
 * 【三态】实际有 → 标实际；实际没有（厂商没回显）→ 退回请求值；两个都没有 → 整行不出现。
 *
 * 【变异臂】
 *  · B1 `servedModelLabel` 改成读 requested 优先（忽略 served）⇒ 「实际优先」那条红
 *  · B2 删掉 Messages 里那行落款 ⇒ 「落款画出来了」那几条红
 *  · B3 mismatch 时不加「（替代）」⇒ 替代标记那条红
 *  · B4 流式途中也标 ⇒ 「流式中不标」那条红
 */
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/app/_ui/discreet', () => ({
  useDiscreet: () => ({ discreet: false, setDiscreet: () => {}, toggle: () => {} }),
}));

const { servedModelLabel } = await import('../../_stream/frames');
const { AssistantMessage, UserMessage } = await import('../Messages');
const { demoMessages } = await import('@/app/_mock/demo');

const ssr = (node: ReactNode) => renderToStaticMarkup(<>{node}</>);
const text = (html: string) => html.replace(/<[^>]+>/g, '');

/** 一条落定的助手消息，除了型号三件套之外都是最朴素的形状 */
function assistant(extra: Record<string, unknown>) {
  return {
    id: 'm_42',
    threadId: 'th_1',
    role: 'assistant' as const,
    content: '先别签任何文件。',
    createdAt: '2026-08-20T10:00:12+08:00',
    ...extra,
  };
}

function render(extra: Record<string, unknown>, streaming = false) {
  return ssr(
    <AssistantMessage
      message={assistant(extra) as never}
      actions={[]}
      onToggleAction={() => {}}
      caseId="9"
      confirmedDrafts={new Set()}
      onRequestConfirmDraft={() => {}}
      streaming={streaming}
    />,
  );
}

describe('一、口径：实际优先，缺实际才退回请求值', () => {
  /** 变异臂 B1：改成 requested 优先 ⇒ 这条红。它是整组的由头 */
  it('两个都有 ⇒ 标**实际**那个，不标请求那个', () => {
    const label = servedModelLabel({ served: 'claude-sonnet-5', requested: 'claude-opus-5' });
    expect(label).toBe('claude-sonnet-5 · 主力');
    expect(label).not.toContain('claude-opus-5');
  });

  it('厂商没回显 ⇒ 退回请求值（总比什么都不说强）', () => {
    expect(servedModelLabel({ served: null, requested: 'claude-opus-5' })).toBe('claude-opus-5 · 深度推理');
  });

  it('两个都没有 ⇒ 返回 null（整行不渲染，不猜一个名字出来）', () => {
    expect(servedModelLabel({ served: null, requested: null })).toBeNull();
    expect(servedModelLabel({})).toBeNull();
    expect(servedModelLabel({ served: '  ', requested: '' })).toBeNull();
  });

  /** 变异臂 B3：mismatch 不加标记 ⇒ 这条红 */
  it('服务端判定换过型号 ⇒ 加「（替代）」', () => {
    expect(
      servedModelLabel({ served: 'claude-sonnet-5', requested: 'claude-opus-5', mismatch: true }),
    ).toBe('claude-sonnet-5 · 主力（替代）');
  });

  it('认不出的型号串原样显示，不硬编一个好听的假名字（也不硬扣一个档位）', () => {
    expect(servedModelLabel({ served: 'claude-opus-5-20260901' })).toBe('claude-opus-5-20260901');
  });

  /**
   * ★这条是本次规格改动的由头（变异臂 B5：改回只印中文档位名 ⇒ 这条红）。
   * 用户按型号付费，落款必须印**型号 id 本身**——只印「主力模型」的话，
   * 把 sonnet 换成 flash 这行字一个像素都不变，那就不叫可核对。
   */
  it('★落款必须印出型号 id 本身，中文档位只能是跟在后面的小字', () => {
    for (const [id, tier] of [
      ['claude-opus-5', '深度推理'],
      ['claude-sonnet-5', '主力'],
      ['deepseek-v4-pro', '深度推理'],
      ['deepseek-v4-flash', '快速'],
      ['qwen3.7-max', '备用主力'],
      ['qwen3.6-flash', '快速'],
    ] as const) {
      const label = servedModelLabel({ served: id })!;
      expect(label, `${id} 的落款里没有型号 id`).toContain(id);
      expect(label.startsWith(id), `${id} 的落款不是以型号 id 打头`).toBe(true);
      expect(label).toBe(`${id} · ${tier}`);
    }
  });
});

describe('二、落款真的画在回答底下', () => {
  it('有实际型号 ⇒ 底下出现那一行', () => {
    expect(text(render({ model: 'claude-opus-5', servedModel: 'claude-opus-5' }))).toContain(
      'claude-opus-5 · 深度推理',
    );
  });

  /** 变异臂 B1 的渲染侧：接线读错字段时，屏幕上会出现"深度推理模型"而实际是 sonnet */
  it('实际与请求不同 ⇒ 屏幕上是实际那个 +（替代）', () => {
    const html = render({
      model: 'claude-opus-5',
      servedModel: 'claude-sonnet-5',
      modelMismatch: true,
    });
    expect(text(html)).toContain('claude-sonnet-5 · 主力（替代）');
    expect(text(html)).not.toContain('claude-opus-5');
  });

  it('两个都没有 ⇒ 一个字都不加（历史行可能就是没有）', () => {
    const html = render({});
    expect(text(html)).toContain('先别签任何文件');
    expect(text(html)).not.toContain('模型');
  });

  /**
   * 变异臂 B4：流式途中也标 ⇒ 这条红。
   * 型号要到 done 帧才回显，半路先标一个请求值、收完再换成实际值，
   * 等于当着用户的面改口——他会以为中途被换了模型。
   */
  it('流式途中不标（那时只知道请求了谁）', () => {
    const html = render({ model: 'claude-opus-5', servedModel: 'claude-opus-5' }, true);
    expect(text(html)).not.toContain('claude-opus-5');
  });

  it('用户消息不标型号', () => {
    const html = ssr(
      <UserMessage
        message={
          {
            id: 'm_41',
            threadId: 'th_1',
            role: 'user',
            content: '我上周三被通知解除。',
            createdAt: '2026-08-20T10:00:00+08:00',
            model: 'claude-opus-5',
          } as never
        }
      />,
    );
    expect(text(html)).toContain('我上周三被通知解除');
    expect(text(html)).not.toContain('claude-opus-5');
  });
});

/* ── 三、演示页那四条回答 ─────────────────────────────────────
   演示页是核心客户的首屏：风闻裁员的人第一眼看到的就是这四轮。
   `demoMessages` 的 `model` 曾经写的是 `'claude'`——一个**不存在的型号 id**，
   落款接上之后被原样印在每条回答底下。修法不是"别印 id"，而是"印**真的** id"：
   演示页与真对话页走同一个 `servedModelLabel`，用户在演示里看见的形状
   就是他自己那一轮会看见的形状。
   变异臂：demo.ts 的 model 改回 `'claude'`（或任何没登记的串）⇒ 这一组红。 */

describe('三、演示页落款：印真型号 id，且与真对话页同一套口径', () => {
  const demoAssistants = demoMessages.filter((m) => m.role === 'assistant');

  it('演示剧本里确实有四条回答（数量变了这组要重看）', () => {
    expect(demoAssistants.length).toBe(4);
  });

  it.each(demoAssistants.map((m) => [m.id, m] as const))(
    '%s 的落款是「真型号 id · 档位」，不是编出来的串',
    (id, message) => {
      const requested = message.model;
      expect(requested, `${id} 没写型号`).toBeTruthy();

      // 认得出的型号才会被缀上档位；认不出的 servedModelLabel 原样返回那串 id。
      // 所以「label !== id」就是「这个 id 在已登记的档位表里」——即它是个真型号。
      const label = servedModelLabel({ requested });
      expect(label, `${id} 的型号 ${requested} 不在已登记档位表里`).not.toBe(requested);
      expect(label).toBe('claude-sonnet-5 · 主力');

      const markup = ssr(
        <AssistantMessage
          message={message as never}
          actions={[]}
          onToggleAction={() => {}}
          caseId="demo"
          confirmedDrafts={new Set()}
          onRequestConfirmDraft={() => {}}
        />,
      );
      const seen = text(markup);

      expect(seen).toContain(label);
      // ★用户必须**看得见**这一轮跑在谁身上，型号 id 原样在屏幕上
      expect(seen).toContain(requested);

      /* 正文块用 RichText 那个 data-rich-text 锚住：全篇恰一处，
         落款排在它之后（先读完回答，再看这一行小字）。
         渲染器要是把正文降级成纯文本、锚点没了，这两条会红。 */
      expect(markup.match(/data-rich-text=""/g) ?? []).toHaveLength(1);
      expect(markup.indexOf(label!)).toBeGreaterThan(markup.indexOf('data-rich-text'));
    },
  );
});
