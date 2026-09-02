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
    expect(label).toBe('主力模型');
    expect(label).not.toContain('深度推理');
  });

  it('厂商没回显 ⇒ 退回请求值（总比什么都不说强）', () => {
    expect(servedModelLabel({ served: null, requested: 'claude-opus-5' })).toBe('深度推理模型');
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
    ).toBe('主力模型（替代）');
  });

  it('认不出的型号串原样显示，不硬编一个好听的假名字', () => {
    expect(servedModelLabel({ served: 'claude-opus-5-20260901' })).toBe('claude-opus-5-20260901');
  });
});

describe('二、落款真的画在回答底下', () => {
  it('有实际型号 ⇒ 底下出现那一行', () => {
    expect(text(render({ model: 'claude-opus-5', servedModel: 'claude-opus-5' }))).toContain(
      '深度推理模型',
    );
  });

  /** 变异臂 B1 的渲染侧：接线读错字段时，屏幕上会出现"深度推理模型"而实际是 sonnet */
  it('实际与请求不同 ⇒ 屏幕上是实际那个 +（替代）', () => {
    const html = render({
      model: 'claude-opus-5',
      servedModel: 'claude-sonnet-5',
      modelMismatch: true,
    });
    expect(text(html)).toContain('主力模型（替代）');
    expect(text(html)).not.toContain('深度推理模型');
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
    expect(text(html)).not.toContain('深度推理模型');
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
    expect(text(html)).not.toContain('深度推理模型');
  });
});
