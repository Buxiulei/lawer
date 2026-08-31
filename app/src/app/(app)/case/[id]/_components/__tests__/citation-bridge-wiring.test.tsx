/**
 * 引用桥两端的**接线**判据（配 citations.test.ts 的连接逻辑一起看）。
 *
 * 逻辑对了、但属性没挂上，桥照样断——所以这里 SSR 渲染对话端的法条卡，
 * 钉住 data-cite 的值**等于** lawCiteId(cite)。把 Messages/LawRefCard 里那处接线
 * 拆掉（不传 citeId、或 LawRefCard 不再落 data-cite）→ 本组红。
 *
 * 另一半是**可选 prop 契约**：不给 citeId 就一个属性都不多出——这正是「移动端与
 * 所有旧调用点逐像素不变」的机器证据（旧调用点全都不传 citeId）。
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { LawRef } from '@/app/_mock/types';
import { LawRefCard } from '@/components/case/LawRefCard';
import { lawCiteId } from '../citations';

const law: LawRef = {
  cite: '《中华人民共和国劳动争议调解仲裁法》第二十一条',
  conclusion: '两地仲裁委都能管；两边都申请的由劳动合同履行地管辖。',
  fullText: '劳动争议仲裁委员会负责管辖本区域内发生的劳动争议……',
};

describe('对话端接线：LawRefCard 的 data-cite', () => {
  it('给了 citeId → 落上 data-cite，且值等于 lawCiteId(cite)', () => {
    const html = renderToStaticMarkup(
      <LawRefCard law={law} citeId={lawCiteId(law.cite)} />,
    );
    expect(html).toContain(`data-cite="${lawCiteId(law.cite)}"`);
  });

  it('不给 citeId → 一个 data-cite 属性都不多出（旧调用点/移动端逐像素不变）', () => {
    const html = renderToStaticMarkup(<LawRefCard law={law} />);
    expect(html).not.toContain('data-cite=');
  });

  it('逐字原文始终在 DOM 里（折叠也在）——引用桥不改这条既有契约', () => {
    const html = renderToStaticMarkup(
      <LawRefCard law={law} citeId={lawCiteId(law.cite)} />,
    );
    expect(html).toContain(law.fullText);
  });
});
