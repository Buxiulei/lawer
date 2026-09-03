// /woo 根路径必须有页且直跳 /woo/users。
// 2026-09-03 主理人在生产打开 /woo 看到「这个地址上没有内容」——后台其实在 /woo/users 与 /woo/codes，
// 只是根路径没有页。这条判据钉住：根路径存在、跳的是用户管理页、不被收录。
import { describe, expect, it, vi } from 'vitest';

const redirect = vi.fn((to: string) => {
  throw new Error(`NEXT_REDIRECT:${to}`);
});
vi.mock('next/navigation', () => ({ redirect: (to: string) => redirect(to) }));

describe('/woo 根路径', () => {
  it('直跳 /woo/users（变异：删掉 page.tsx 或改跳别处 → 红）', async () => {
    const mod = await import('../page');
    expect(() => mod.default()).toThrow('NEXT_REDIRECT:/woo/users');
    expect(redirect).toHaveBeenCalledWith('/woo/users');
  });
  it('不被搜索引擎收录', async () => {
    const mod = await import('../page');
    expect(mod.metadata?.robots).toMatchObject({ index: false, follow: false });
  });
});
