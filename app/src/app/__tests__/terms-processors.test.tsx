// app/src/app/__tests__/terms-processors.test.tsx
// 受托方清单页（协议第五条第 7 款）。
//
// 【这一组拦的是什么】这一页存在的全部意义是"逐条说清谁拿到了什么、在哪儿"。
// 它的失败形态是静默的：漏掉一栏「所在地」，那一格就是空白，
// 读的人以为这一条本来就不需要填；而少一条受托方，页面照常渲染、读起来还很完整——
// 只有那家拿到了数据的公司自己知道它不在清单上。
//
// 【为什么按数据核，不按字面核】清单是数据（processors.ts），页面只是它的渲染面。
// 只核页面上有没有某几个词的形态是：加一条受托方而忘了写所在地，那几个词照样在。
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

const { default: ProcessorsPage } = await import('@/app/terms/processors/page');
const { PROCESSORS, isPending } = await import('@/app/terms/processors/processors');
const { TERMS_HREF, TERMS_OVERSEAS_HREF } = await import('@/app/_ui/termsLinks');

const html = renderToStaticMarkup(<ProcessorsPage />);
const text = html.replace(/<[^>]+>/g, '');
const rows = [...html.matchAll(/data-processor-row="1"/g)];

describe('受托方清单：每一条三栏齐', () => {
  it('清单不空，且协议里点名的六类都在（变异：删掉一条 → 红）', () => {
    expect(PROCESSORS.length).toBe(6);
    expect(rows.length, '数据里有几条，页面上就该画几条').toBe(PROCESSORS.length);
  });

  PROCESSORS.forEach((p, i) => {
    const label = isPending(p.name) ? `【${p.name.pending}】` : p.name;
    it(`第 ${i + 1} 条「${label.slice(0, 16)}」名称/用途/所在地都不空`, () => {
      // 用途是纯字符串，空串在页面上就是一个空格子——而空格子看起来像"这一栏不需要填"
      expect(p.purpose.trim().length, '用途是空的').toBeGreaterThan(8);
      for (const cell of [p.name, p.location]) {
        if (isPending(cell)) {
          expect(cell.pending.trim().length, '待确认也要说清在等谁').toBeGreaterThan(4);
        } else {
          expect(cell.trim().length, '这一栏是空串').toBeGreaterThan(1);
        }
      }
    });
  });

  it('每一条的名称与用途都真的渲染到了页面上', () => {
    for (const p of PROCESSORS) {
      if (!isPending(p.name)) expect(text, `${p.name} 没画出来`).toContain(p.name);
      expect(text, `「${p.purpose.slice(0, 12)}…」没画出来`).toContain(p.purpose);
    }
  });

  it('所在地这一栏逐条画出来了（变异：把 <CellText cell={p.location}/> 删掉 → 红）', () => {
    // 数的是 <dt>所在地</dt> 这个栏头，不是正文里出现过几次「所在地」——
    // 后者会把某一条注释里提到的那次也算进来（境外那条的备注就写着"中转服务商的…所在地"），
    // 于是这条判据在"少画一栏"时仍然绿。
    const heads = html.match(/<dt[^>]*>所在地<\/dt>/g)?.length ?? 0;
    expect(heads, '有几条就该有几个「所在地」栏头').toBe(PROCESSORS.length);
  });
});

describe('受托方清单：待确认与空白长得不一样', () => {
  /**
   * 【为什么这条重要】协议 v0.2 附二第 4 项把「短信与实名核验服务商名称」列为待主理人确认。
   * 用空串表示"还没定"的形态是：页面上一个空格子，读的人以为这一栏不需要填；
   * 而受托方清单上一个名字都没有的那一条，恰恰是拿着用户手机号的那一家。
   */
  it('待确认的名称画成了醒目占位，不是空格子', () => {
    const pending = PROCESSORS.filter((p) => isPending(p.name));
    expect(pending.length, '短信通道那一条的名称本该还是待确认').toBeGreaterThanOrEqual(1);
    expect(html).toContain('data-pending="1"');
    for (const p of pending) {
      expect(text).toContain((p.name as { pending: string }).pending);
    }
  });

  it('境内 / 境外分得清楚：有且仅有境外那一条写着境外', () => {
    const overseas = PROCESSORS.filter((p) => !isPending(p.location) && p.location.includes('境外'));
    expect(overseas.length, '境外接收方不是恰好一条了？那要连同 /terms/overseas 一起改').toBe(1);
    expect(overseas[0].note ?? '', '境外那一条没说默认关闭、要单独同意').toContain('单独');
  });
});

describe('受托方清单：与其余两页互指', () => {
  it('指得回协议与境外说明页', () => {
    expect(html).toContain(`href="${TERMS_HREF}"`);
    expect(html).toContain(`href="${TERMS_OVERSEAS_HREF}"`);
  });

  it('说清了证据文件什么时候才会经过它们（变异：改回"一律不经过第三方" → 红）', () => {
    // 提取 / 转写 / 简报确实会把材料交给模型服务商（lib/evidence/brief-llm、sidecar → DashScope）。
    // 写成"证据文件不经过任何第三方"是一句**往好里说的假话**，比不写更糟。
    expect(text).toContain('只有你自己发起');
    expect(text).toContain('按量服务');
  });
});
