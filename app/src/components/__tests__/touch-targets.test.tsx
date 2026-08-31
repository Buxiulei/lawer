/**
 * 触达区家族回归（审查台账 SYS-01 / SYS-03 / P-02 / P-03）。
 *
 * 【先说这些断言各有多强，免得后来人高估它们】
 *
 * - **类名断言（中）**：证明**组件基类**确实吐出扩区类。它挡得住"有人把 min-h-11 /
 *   before:-inset-3 删掉"——那正是本轮修的东西被撤销时的形态，也是台账 SYS-01/SYS-03
 *   记录的那次回归的形态。它挡不住"Tailwind 没把这个类编进产物"或"父级 overflow-hidden
 *   把伪元素裁了"。
 *   注：`before:absolute before:-inset-3` 会不会自带 `content:""`，是用本仓装着的
 *   tailwindcss@4.3.3 实编过的（两条规则都带 `content: var(--tw-content)`，
 *   `@property --tw-content` 的 initial-value 是 `""`），不是照文档推的。
 *
 * - **结构断言（中）**：Checkbox / Switch 的根元素必须是 `<button>`。
 *   label 把点击转发给控件是浏览器对 **labelable 元素**才做的事；
 *   哪天有人把根换成 `<span role="checkbox">`，"点标题＝勾掉这件事"会静默失效，
 *   而且没有任何别的信号——tsc 绿、类名断言也绿。
 *
 * - **源码断言（最弱）**：只证类名写在源文件里，不证渲染、不证像素。
 *   ApiKeysCard 的「吊销」按钮只有 fetch 回来之后才渲染（useEffect 在
 *   renderToStaticMarkup 下不跑），本仓又没有 DOM 测试环境，只能退到这一档。
 *
 * - **像素断言（无 —— 本仓做不到）**：vitest 配的是 `environment: 'node'`，
 *   没装 jsdom/happy-dom；而且就算装了也没用——jsdom 不做布局，
 *   `getBoundingClientRect()` 恒返回 0，量不出 44px，更量不出伪元素热区。
 *   真实命中区只能靠浏览器量（台账里那些 42×23.8 / 20×20 的数字来自 Playwright 实测）。
 *   本文件不假装量到了像素。
 */
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ActionItem } from '@/app/_mock/types';

vi.mock('next/link', () => ({
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('@/app/_ui/discreet', () => ({ useDiscreet: () => ({ discreet: false }) }));
vi.mock('@/app/_ui/auth', () => ({ useAuthToken: () => 'tok' }));

const { Breadcrumbs } = await import('@/components/shell/breadcrumbs');
const { DemoBanner } = await import('@/components/shell/DemoBanner');
const { Checkbox } = await import('@/components/shadcn/checkbox');
const { Switch } = await import('@/components/shadcn/switch');
const { ActionCard } = await import('@/components/case/ActionCard');
const { DegradedBadge } = await import(
  '@/app/(app)/case/[id]/_components/StreamParts'
);

/** 取出 html 里所有 `<a>` 的 class 值 */
function anchorClasses(html: string): string[] {
  return [...html.matchAll(/<a\b[^>]*\bclass="([^"]*)"/g)].map((m) => m[1]);
}

/** 取出承载某个属性片段的那个标签名——用来问"这个 id 挂在什么元素上" */
function tagCarrying(html: string, needle: string): string {
  const at = html.indexOf(needle);
  expect(at, `html 里没有 ${needle}`).toBeGreaterThanOrEqual(0);
  const open = html.lastIndexOf('<', at);
  return /^<([a-zA-Z][\w-]*)/.exec(html.slice(open))?.[1] ?? '';
}

// ---------------------------------------------------------------- SYS-01

describe('SYS-01 面包屑返回链接（全站子页唯一返回入口）', () => {
  // 台账列的七条路由。/account 只有一级、不出链接，不在此列。
  const ROUTES = [
    '/intake',
    '/settings',
    '/case/demo/ask',
    '/case/demo/evidence',
    '/case/demo/graph',
    '/case/demo/docs',
    '/case/demo/drafts',
  ];

  it.each(ROUTES)('%s 的返回链接带满 44px 扩区类', (pathname) => {
    const html = renderToStaticMarkup(<Breadcrumbs pathname={pathname} caseId="demo" />);
    const classes = anchorClasses(html);
    expect(classes, `${pathname} 没渲染出返回链接`).toHaveLength(1);
    const cls = classes[0];
    // 高度靠 min-h-11(44px)；inline-flex+items-center 是让它在 56px 顶栏里仍居中
    expect(cls).toContain('min-h-11');
    expect(cls).toContain('inline-flex');
    expect(cls).toContain('items-center');
    // 宽度靠 px-2 往两侧各扩 8px，-mx-2 再把这 16px 从版式里减掉。
    // **两个必须成对**：只留 px-2 会在最窄的顶栏里挤掉别的控件，
    // 只留 -mx-2 则是白扩了个负边距、命中区一点没变大。
    expect(cls).toContain('px-2');
    expect(cls).toContain('-mx-2');
    // 纵向同理：面包屑列表是 flex-wrap 的，顶栏挤到极限会折两行。
    // 少了 -my-2.5，两行各 44px 叠起来会顶穿 56px 的顶栏（实测 8.4px）。
    expect(cls).toContain('-my-2.5');
  });
});

// ---------------------------------------------------------------- P-02

describe('P-02 DemoBanner「回到我的案件」', () => {
  it('链接自带 44px 高命中区，且用等量负边距抵掉、不撑高横幅', () => {
    const cls = anchorClasses(renderToStaticMarkup(<DemoBanner />))[0];
    expect(cls).toContain('min-h-11');
    expect(cls).toContain('inline-flex');
    // 44 - 2*10 = 24px = 这段文案的 leading-6，横幅高度不变
    expect(cls).toContain('-my-2.5');
  });
});

// ---------------------------------------------------------------- SYS-03

describe('SYS-03 勾选框 / 开关自带扩区（不再指望调用方包一层）', () => {
  // 渲染放进用例体里、不在模块层跑：模块层抛异常会让整个文件"0 test"，
  // 变异核就分不清是断言红了还是文件根本没跑起来。
  const CASES = [
    ['Checkbox', () => renderToStaticMarkup(<Checkbox checked={false} />)],
    ['Switch', () => renderToStaticMarkup(<Switch checked={false} />)],
  ] as const;

  it.each(CASES)('%s 的伪元素扩区类在基类里', (_name, render) => {
    const cls = /\bclass="([^"]*)"/.exec(render())?.[1] ?? '';
    expect(cls).toContain('before:absolute');
    expect(cls).toContain('before:-inset-3');
    // absolute 的伪元素要贴着控件自己算 inset，控件必须是包含块。
    // 少了 relative，热区会跑到最近的定位祖先上去——那是比没扩区更难查的形态。
    expect(cls).toContain('relative');
  });

  it.each(CASES)('%s 的根元素是 button（label 只对 labelable 元素转发点击）', (_name, render) => {
    expect(render().startsWith('<button')).toBe(true);
  });

  it('ActionCard：标题 label 的 htmlFor 指向的确实是那个 button', () => {
    const item: ActionItem = {
      id: 'a1',
      caseId: 'demo',
      title: '把解除通知拍下来',
      detail: '原件、信封、快递单一起拍。',
      dueAt: null,
      priority: 1,
      status: '待办',
      sourceMessageId: null,
      createdAt: '2026-08-29 10:00:00',
    };
    const html = renderToStaticMarkup(<ActionCard item={item} />);
    // 点标题＝勾掉这件事，靠的是浏览器把 label 的点击转发给被标注控件。
    // 这里只能验证转发成立的两个前提：for 对得上、被指的是 button。
    expect(html).toContain('for="action-a1"');
    expect(tagCarrying(html, 'id="action-a1"')).toBe('button');
  });

  it('两处调用方不再自称"外层撑满 44px 触区"（台账 SYS-03 点名的假注释）', () => {
    const files = [
      new URL('../case/ActionCard.tsx', import.meta.url),
      new URL('../../app/(app)/settings/_components/PreferencesCard.tsx', import.meta.url),
    ];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      expect(src).not.toMatch(/外层撑满 44px 触区/);
      expect(src).not.toMatch(/外层撑到 44px 触区/);
    }
  });
});

// ---------------------------------------------------------------- P-03

describe('P-03 零散未达标触区', () => {
  it('降级徽标高度补到 44（原来 py-0.5 只有 28）', () => {
    const html = renderToStaticMarkup(<DegradedBadge />);
    const cls = /<button\b[^>]*\bclass="([^"]*)"/.exec(html)?.[1] ?? '';
    expect(cls).toContain('min-h-11');
    expect(cls).toContain('py-2.5');
    expect(cls).toContain('px-3');
  });

  it('ApiKeysCard「吊销」按钮宽度补到 ≥44（源码断言，见文件头强度说明）', () => {
    const src = readFileSync(
      new URL('../../app/(app)/settings/_components/ApiKeysCard.tsx', import.meta.url),
      'utf8',
    );
    // 只截「吊销」那个按钮的开标签，别让文件里别处的 px-3 蒙混过关：
    // 从「吊销」这两个字往**回**找最近的 <button，不能从文件开头往下找非贪婪匹配——
    // 那样会从第一个 <button 一路吃过来，把别的按钮的类名也算进去（本轮变异核就是这么发现的）。
    const at = src.search(/>\s*吊销\s*</);
    expect(at, '没找到「吊销」按钮').toBeGreaterThan(0);
    const btn = src.slice(src.lastIndexOf('<button', at), at);
    // **只认 className 的值**，不认整段标签：标签里还有解释这几个类的注释，
    // 拿整段做 toContain 的话，把 className 改回去、注释留着，断言照样是绿的
    // ——那就又是一条"注释说了算"的假守卫（本轮变异核实测复现过）。
    const cls = /className="([^"]*)"/.exec(btn)?.[1] ?? '';
    expect(cls).toContain('min-h-11');
    expect(cls).toContain('px-3');
  });

  it('驾驶舱行内文字链接**有意不补**，且这个决定写在代码旁边', () => {
    // 25×14 不达标是取舍不是遗漏（台账 P-03）。这条断言挡的是
    // "后来人看见不达标就顺手补 44px、把说明行撑成阶梯状"——
    // 注释在，改动者就会先读到理由。
    for (const f of ['Dashboard.tsx', 'RecentRecords.tsx']) {
      const src = readFileSync(
        new URL(`../../app/(app)/case/[id]/_components/${f}`, import.meta.url),
        'utf8',
      );
      expect(src, `${f} 缺 P-03 决策注释`).toContain('台账 P-03');
    }
  });
});
