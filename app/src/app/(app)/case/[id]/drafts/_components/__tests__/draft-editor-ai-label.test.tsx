// 演示案件那一版文书页（DraftEditor）也要带生成合成内容的显式标识。
//
// 【为什么演示这一版单独钉一条】真实案件那一版（RealDraftView）另有判据，
// 而这两版是**两个组件**：给真实那版加了标识、演示这版没加，两页都照常渲染，
// 看不出任何区别。而演示页恰恰是没登录的人第一次看到"文书长什么样"的那一屏，
// 也是最容易被截图转发出去的那一份。
//
// 【首帧问不到领域】useCaseDomain 在 SSR 那一遍恒回空串 ⇒ 后半截走缺省领域包。
// 所以这里只验**法定那半句在不在**；后半截随领域变，由 page-copy-by-domain 那组管。
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/app/_ui/discreet', () => ({
  useDiscreet: () => ({ discreet: false, setDiscreet: () => {}, toggle: () => {} }),
}));
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));
// 编辑器里的「保存 / 恢复 / 标记已发出」都要吐 toast，而 useToast 没有 Provider 就抛。
// 本组验的是这一页画了什么，与吐不吐 toast 无关。
vi.mock('@/components/ui/Toast', () => ({ useToast: () => () => {} }));

const { DraftEditor } = await import('../DraftEditor');
const { mockDrafts } = await import('@/app/_mock/docs-drafts');
const { AI_GENERATED_LABEL } = await import('@/lib/ai-label');
const { demoCase } = await import('@/app/_mock/demo');

const html = () =>
  renderToStaticMarkup(<DraftEditor caseId={demoCase.id} draft={mockDrafts[0]} />);
const text = (s: string) => s.replace(/<[^>]+>/g, '');

describe('演示案件的文书页（标识办法 §4 第（一）项）', () => {
  it('正文之前画了标识（变异：把 <CaseAiGeneratedNotice/> 删掉 → 红）', () => {
    const body = text(html());
    expect(body, '这一页的标题没画出来，下面在验空页').toContain(mockDrafts[0].title);
    expect(body).toContain(AI_GENERATED_LABEL);
  });

  it('标识排在正文之前，不是末尾（变异：挪到版本历史后面 → 红）', () => {
    const raw = html();
    const labelAt = raw.indexOf(AI_GENERATED_LABEL);
    const bodyAt = raw.indexOf('<textarea');
    expect(labelAt, '这一页上没有标识').toBeGreaterThan(-1);
    expect(bodyAt, '这一页上没有正文编辑框，位置验不出东西').toBeGreaterThan(-1);
    expect(labelAt, '读的人一路读到底才知道这是 AI 写的，而多数人读到一半就去照着发了').toBeLessThan(
      bodyAt,
    );
  });
});
