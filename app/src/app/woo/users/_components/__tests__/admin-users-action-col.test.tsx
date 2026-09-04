/**
 * 账号表最后一列「操作」的守卫。
 *
 * 【立这组的由头】主理人 2026-09-04 在生产的 /woo/users（约 1100px 宽）说
 * 「发放公道值 / 调整会员没了」。功能一直都在——那一列被横向滚出了视口，
 * 而表头那一格是**空的**，屏幕上没有一个字暗示右边还有东西。
 * 这是最难查的一种坏：页面不报错、不空白，只是那个按钮谁也够不着。
 *
 * 所以钉两件事：
 *   ① 最后一个表头有字（「操作」）——空表头等于把这一列藏起来；
 *   ② 表头与每一行的那一格都 sticky 在右缘——任何宽度下都留在视口内。
 *
 * 【量具边界】本仓 vitest 跑 node 环境、没有 DOM，量的是静态 HTML 上的 class，
 * 不是"浏览器里它真的没被滚走"。后者要真机量。但 class 掉了这一条会先红。
 * 每条断言都配一条对照臂（拿同一把尺子量非操作列），证明尺子不是恒真。
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// 组件模块顶层 import 了 REST 客户端（它连着 localStorage）。这一组只渲染表格本体，
// 一次请求都不发，所以把那一层顶掉即可，不必给响应。
vi.mock('@/app/_ui/api', () => ({
  ApiError: class ApiError extends Error {},
  apiFetch: () => Promise.reject(new Error('本组不该发请求')),
  humanError: (err: unknown) => (err instanceof Error ? err.message : '出错了'),
}));

const { AdminUsersTable } = await import('../AdminUsersView');

const ROWS = [
  {
    uid: 101,
    email: 'a@example.com',
    phone: '13800000001',
    phone_error: null,
    created_at: '2026-08-01 03:00:00',
    auth_status: '已实名',
    plan: 'pro',
    plan_expires_at: '2027-08-01 03:00:00',
    balance: 1200,
    case_count: 2,
  },
  {
    uid: 102,
    email: null,
    phone: null,
    phone_error: null,
    created_at: '2026-08-02 03:00:00',
    auth_status: '未实名',
    plan: null,
    plan_expires_at: null,
    balance: 0,
    case_count: 0,
  },
];

const html = renderToStaticMarkup(<AdminUsersTable rows={ROWS} onPick={() => {}} />);

/** 取 html 里所有 <th>（或 <td>）的 [属性串, 内文]。 */
function cells(source: string, tag: 'th' | 'td'): { attrs: string; text: string }[] {
  const re = new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)</${tag}>`, 'g');
  return [...source.matchAll(re)].map((m) => ({
    attrs: m[1],
    text: m[2].replace(/<[^>]+>/g, '').trim(),
  }));
}

const rows = [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => m[1]);

describe('账号表：最后一列是「操作」，且钉在视口右缘', () => {
  it('表头最后一格写着「操作」，不再是空格子', () => {
    const th = cells(html, 'th');
    expect(th).toHaveLength(9);
    expect(th[th.length - 1].text).toBe('操作');
  });

  it('表头最后一格 sticky right-0（对照臂：第一格不 sticky，证明尺子不是恒真）', () => {
    const th = cells(html, 'th');
    const last = th[th.length - 1].attrs;
    expect(last).toContain('sticky');
    expect(last).toContain('right-0');
    // 底色缺了的话，横滚时下面的列会从按钮底下穿过去——sticky 元素吃不到 <tr> 的底。
    expect(last).toContain('bg-card');
    expect(th[0].attrs).not.toContain('sticky');
  });

  it('每一行的操作格都 sticky，且「操作」按钮就在那一格里', () => {
    // 表头那一行也被 <tr> 匹到，去掉它，剩下的才是数据行。
    const bodyRows = rows.filter((r) => !r.includes('<th'));
    expect(bodyRows).toHaveLength(ROWS.length);

    for (const row of bodyRows) {
      const td = cells(row, 'td');
      expect(td).toHaveLength(9);
      const last = td[td.length - 1];
      expect(last.attrs).toContain('sticky');
      expect(last.attrs).toContain('right-0');
      expect(last.text).toBe('操作');
      // 对照臂：同一把尺子量 UID 那一格 → 不 sticky。
      expect(td[0].attrs).not.toContain('sticky');
    }
  });
});
