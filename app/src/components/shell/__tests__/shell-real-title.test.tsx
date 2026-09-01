/**
 * 骨架层不许在真实案件上写演示案件名。
 *
 * 【立这组的由头（用户亲测 2026-09-01）】主页点「进入我的案件」，中转的 /case 那一瞬
 * 标签页闪出「星曜网络 · 解除通知异议」，用户判定自己被送进了示例案例。
 * 实际落点 /case/2 是对的、数据也是真的——错的只有骨架层那一行字：
 * `(app)/layout.tsx` 恒传 `demoCase.title`，于是**每一个**挂壳层的页面
 * （真实案件页、「我的」、设置、中转页）标签页与 PC 侧栏都写着别家公司名。
 *
 * mycase 那组红线（dashboard-real-data「这一屏上没有任何演示案件的痕迹」）盯的是
 * 驾驶舱里的**数据部件**；这组把同一条红线扩到**壳层**——AppShell / PC 侧栏 /
 * document.title 这三处骨架，一个都不许漏。
 *
 * 【量具边界】本仓 vitest 跑 node 环境、没有 DOM，SSR 跑不到 useEffect。
 * 所以这里验的是：
 *   ① 首帧一定中性（**正是用户瞥见的那一瞬**，也正是原病灶发作的那一帧）；
 *   ② 拿到真标题后写的是真标题（纯函数 shellTitles）；
 *   ③ 真标题确实从已有那条接口取得到（loadCaseTitle）。
 * 三段拼起来才是「浏览器里最终写对了」，本文件不冒充最后那一步；
 * 跨过 effect 那条缝的接线由末尾的源码守卫钉住。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** 演示案件标题里的两个词。全站在非 demo 上下文出现任何一个都算破线。 */
const DEMO_WORDS = ['星曜网络', '解除通知异议'] as const;

let pathname = '/';
vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
  useRouter: () => ({ replace: () => {}, push: () => {}, refresh: () => {} }),
}));
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

/** DocumentTitle 只在 effect 里写 document.title，SSR 到不了；这里把它收到的那行字截下来 */
const captured = { title: '' };
vi.mock('@/app/_ui/discreet', () => ({
  useDiscreet: () => ({ discreet: false, setDiscreet: () => {}, toggle: () => {} }),
  DocumentTitle: ({ title }: { title: string }) => {
    captured.title = title;
    return null;
  },
}));

/** 接口替身：形状照 GET /api/v1/cases 的真实响应 */
const calls: string[] = [];
let respond: (path: string) => Promise<unknown> = () => Promise.resolve({ cases: [] });
vi.mock('@/app/_ui/api', () => ({
  apiFetch: (path: string) => {
    calls.push(path);
    return respond(path);
  },
  humanError: (err: unknown) => (err instanceof Error ? err.message : '出错了'),
}));

const { AppShell } = await import('../AppShell');
const { NEUTRAL_CASE_TITLE, loadCaseTitle, resetCaseTitleCache, shellTitles } =
  await import('../caseTitle');
const { ToastProvider } = await import('@/components/ui/Toast');
const { ThemeProvider } = await import('@/app/_ui/theme');
const { demoCase } = await import('@/app/_mock/demo');

const SRC = join(process.cwd(), 'src');
const REAL_TITLE = '恒昇科技 · 违法解除';

/** 壳层底下要的两个 Provider（主题、Toast）都用真的，只有低调模式那层是替身 */
const ssr = (node: React.ReactNode) =>
  renderToStaticMarkup(
    <ThemeProvider>
      <ToastProvider>{node}</ToastProvider>
    </ThemeProvider>,
  );

/** 在某条路由上渲染整个壳层（侧栏 + 顶栏 + 底部 Tab 全在里面），回整份文档标记 */
function shellAt(path: string): string {
  pathname = path;
  captured.title = '';
  return ssr(
    <AppShell>
      <p>正文</p>
    </AppShell>,
  );
}

beforeEach(() => {
  calls.length = 0;
  resetCaseTitleCache();
  respond = () =>
    Promise.resolve({ cases: [{ id: 2, title: REAL_TITLE, stage: '仲裁准备' }] });
});

/* ── 〇、正对照：这两个词确实是演示数据里的原文 ─────────────────── */

it('演示串取自 _mock/demo 的原文，不是我随手编的', () => {
  const mock = readFileSync(join(SRC, 'app/_mock/demo.ts'), 'utf8');
  for (const word of DEMO_WORDS) expect(mock).toContain(word);
  expect(demoCase.title).toBe(DEMO_WORDS.join(' · '));
});

/* ── 一、标题该写谁：纯函数 ───────────────────────────────── */

describe('shellTitles', () => {
  it('真标题取到了就写真标题，侧栏与标签页同一份', () => {
    expect(shellTitles({ onDemoCase: false, realTitle: REAL_TITLE })).toEqual({
      sidebar: REAL_TITLE,
      document: `${REAL_TITLE} · 土八鼠`,
    });
  });

  /** 变异核：把这一支的兜底改成 demoCase.title，这条立刻红 */
  it('还没取到 / 取不到 → 中性词，绝不拿演示标题顶', () => {
    const titles = shellTitles({ onDemoCase: false, realTitle: null });
    expect(titles.sidebar).toBe(NEUTRAL_CASE_TITLE);
    expect(titles.document).toBe('土八鼠');
    for (const word of DEMO_WORDS) {
      expect(titles.sidebar).not.toContain(word);
      expect(titles.document).not.toContain(word);
    }
  });

  it('中性词本身不含公司名（否则上面那条等于在同一个串上自证）', () => {
    for (const word of DEMO_WORDS) expect(NEUTRAL_CASE_TITLE).not.toContain(word);
  });

  /** 正对照：演示案件页该显示演示标题——别把 demo 页一起中性化了还以为修好了 */
  it('演示案件页照常写演示标题', () => {
    expect(shellTitles({ onDemoCase: true, realTitle: null })).toEqual({
      sidebar: demoCase.title,
      document: `${demoCase.title} · 土八鼠`,
    });
  });
});

/* ── 二、真标题从哪儿来 ─────────────────────────────────── */

describe('loadCaseTitle', () => {
  it('走已有那条通路 GET /cases，拿回这个案件的真标题', async () => {
    expect(await loadCaseTitle('2')).toBe(REAL_TITLE);
    expect(calls).toEqual(['/cases']);
  });

  it('缓存住，路由每切一次不再问一遍接口', async () => {
    await loadCaseTitle('2');
    await loadCaseTitle('2');
    expect(calls).toEqual(['/cases']);
  });

  it('这个 id 不在名下 → null，不编一个，也不回演示标题', async () => {
    expect(await loadCaseTitle('999')).toBeNull();
  });

  it('接口挂了 → null，不抛（壳层因此写中性词，不是崩掉）', async () => {
    respond = () => Promise.reject(new Error('网络没连上'));
    expect(await loadCaseTitle('2')).toBeNull();
  });
});

/* ── 三、整个壳层渲染出来，全文档 0 命中 ─────────────────────── */

/**
 * 这一节是本组的主判据：**渲染的是壳层本身**（AppShell → PC 侧栏 + 顶栏面包屑 +
 * 底部 Tab + DocumentTitle），不是驾驶舱里的数据部件。原病灶就落在这一层。
 */
describe('真实案件路由上的壳层', () => {
  const REAL_ROUTES = ['/case/2', '/case/2/evidence', '/case/2/drafts'];

  it.each(REAL_ROUTES)('%s：整份文档里一个演示词都没有', (route) => {
    const html = shellAt(route);
    for (const word of DEMO_WORDS) expect(html).not.toContain(word);
  });

  it.each(REAL_ROUTES)('%s：标签页标题也没有', (route) => {
    shellAt(route);
    for (const word of DEMO_WORDS) expect(captured.title).not.toContain(word);
  });

  it('取数前 PC 侧栏写中性词——短暂中性，好过闪一下别家公司名', () => {
    expect(shellAt('/case/2')).toContain(NEUTRAL_CASE_TITLE);
  });

  it('取数前标签页写 APP_TITLE', () => {
    shellAt('/case/2');
    expect(captured.title).toBe('土八鼠');
  });
});

describe('中转与非案件页', () => {
  /** 用户亲测那一瞬就在这儿：/case 是解析口，它自己不属于任何案件 */
  it('解析页 /case 的标题中性，中转全程不出现任何案件标题', () => {
    const html = shellAt('/case');
    for (const word of DEMO_WORDS) expect(html).not.toContain(word);
    expect(captured.title).toBe('土八鼠');
    expect(html).toContain(NEUTRAL_CASE_TITLE);
  });

  it.each(['/account', '/settings', '/intake'])('%s 同样干净', (route) => {
    const html = shellAt(route);
    for (const word of DEMO_WORDS) expect(html).not.toContain(word);
    expect(captured.title).toBe('土八鼠');
  });
});

/**
 * 正对照：同一套断言在演示案件页上必须**看得见**那两个词。
 * 没有这一条，上面全部 not.toContain 可能只是因为壳层压根没渲染出标题来。
 */
describe('演示案件页（正对照）', () => {
  it.each(['/case/demo', '/case/demo/evidence'])('%s：演示标题照常在', (route) => {
    const html = shellAt(route);
    for (const word of DEMO_WORDS) expect(html).toContain(word);
    expect(captured.title).toBe(`${demoCase.title} · 土八鼠`);
  });
});

/* ── 四、结构守卫：回潮会被点名 ─────────────────────────────── */

/** 只看代码行，注释里提到 demo 不算（注释误报会让下一个人把守卫当噪音关掉） */
function codeLines(relPath: string): string[] {
  return readFileSync(join(SRC, relPath), 'utf8')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\/?\*)/.test(l));
}

describe('结构守卫', () => {
  /** 变异核：把 `<AppShell caseTitle={demoCase.title}>` 加回去，这条立刻红 */
  it('(app)/layout.tsx 不再把演示案件递给壳层', () => {
    const lines = codeLines('app/(app)/layout.tsx');
    expect(lines.filter((l) => l.includes('demoCase'))).toEqual([]);
    expect(lines.filter((l) => l.includes('_mock/demo'))).toEqual([]);
    // 正对照：这个文件确实还在渲染壳层，不是被我整个删空了
    expect(lines.some((l) => l.includes('<AppShell>'))).toBe(true);
  });

  /**
   * 跨 effect 那条缝的接线（SSR 验不到真标题那一支，见文件抬头的量具边界）：
   * 钉住 AppShell 确实按**路径里**那个案件去取真标题，并把结果喂给 shellTitles。
   */
  it('AppShell 的标题来自 useRealCaseTitle(路径里的 id)，且喂给了 shellTitles', () => {
    const lines = codeLines('components/shell/AppShell.tsx');
    expect(lines.some((l) => l.includes('useRealCaseTitle(caseIdFromPath(pathname))'))).toBe(
      true,
    );
    expect(lines.some((l) => l.includes('shellTitles({ onDemoCase, realTitle })'))).toBe(true);
    expect(lines.some((l) => l.includes('DocumentTitle title={titles.document}'))).toBe(true);
    expect(lines.some((l) => l.includes('caseTitle={titles.sidebar}'))).toBe(true);
  });

  /** 同一条缝的另一半：那个 hook 真的去取了数，不是永远回 null 让全站停在中性词上 */
  it('useRealCaseTitle 的 effect 里确实调了 loadCaseTitle', () => {
    const lines = codeLines('components/shell/caseTitle.ts');
    expect(lines.some((l) => l.includes('loadCaseTitle(key)'))).toBe(true);
  });

  /**
   * CaseHeaderBar（桌面案由条）整块仍取演示数据——标题、阶段、期限、里程碑都是。
   * 它现在**没有被任何页面挂载**（Dashboard 里只剩一段说明它为什么不挂）。
   * 那就一天没接真数据、一天不许挂上去：只换标题会造出「真标题 + 假期限」的半真顶栏，
   * 比整块明显是演示更危险。
   */
  it('CaseHeaderBar 在接真数据之前不许被挂载', () => {
    const src = readFileSync(
      join(SRC, 'app/(app)/case/[id]/_components/CaseHeaderBar.tsx'),
      'utf8',
    );
    // 正对照：它确实还在渲染演示标题，所以这条守卫不是在守一个空文件
    expect(src).toContain('demoCase.title');

    // 认 import 不认 `<CaseHeaderBar`：Dashboard 那段说明"为什么不挂"的注释里
    // 正写着这个标签，按标签数会当场误报。
    const importers = productionTsx(SRC).filter((file) =>
      /from\s+'[^']*\/CaseHeaderBar'/.test(readFileSync(file, 'utf8')),
    );
    expect(importers).toEqual([]);
  });
});

/** src 下的 .tsx，跳过 __tests__（测试直接 import 组件是正当的，不算"挂上了页面"） */
function productionTsx(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...productionTsx(full));
    else if (entry.name.endsWith('.tsx')) out.push(full);
  }
  return out;
}
