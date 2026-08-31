/**
 * 工作区三层分野的判据。
 *
 * 这里断言的是**结构**，不是像素——像素归 scripts/perf/ws-grid.mjs 那支探针
 * （容器查询的结果只有真浏览器量得出来）。两边分工：
 *   本文件：谁可以持有什么、谁不许出现什么、只许挂一处。
 *   探针：栏数、不卸载、焦点、图标。
 *
 * 每条结构守卫都配一条变异用例：先证明这条正则对真违例会红。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/app/_ui/discreet', () => ({
  useDiscreet: () => ({ discreet: false, setDiscreet: () => {}, toggle: () => {} }),
}));

const { CaseWorkspaceProvider } = await import('../CaseWorkspaceProvider');
const { WorkspaceGrid } = await import('../WorkspaceGrid');

const SRC = join(process.cwd(), 'src');
const WS = join(SRC, 'app/(app)/case/[id]/_workspace');

/** 注释里提到某个禁用写法不算犯规——守卫看的是代码，不是说明。 */
const codeOf = (path: string) =>
  readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*(\/\/|\*).*$/gm, '');

const read = (f: string) => codeOf(join(WS, f));
const wsFiles = () => readdirSync(WS).filter((f) => /\.tsx?$/.test(f));

const html = () =>
  renderToStaticMarkup(
    <CaseWorkspaceProvider caseId="demo">
      <WorkspaceGrid>
        <p>正文</p>
      </WorkspaceGrid>
    </CaseWorkspaceProvider>,
  );

describe('单实例', () => {
  it('一棵树只渲染一个工作区根', () => {
    expect(html().match(/data-workspace/g)?.length).toBe(1);
  });

  it('三个栏各出现一次，不多不少', () => {
    const out = html();
    for (const pane of ['main', 'dossier', 'viewer']) {
      expect(out.match(new RegExp(`data-pane="${pane}"`, 'g'))?.length).toBe(1);
    }
  });

  it('Provider 只在 case/[id]/layout.tsx 里挂一次', () => {
    const users = walk(SRC).filter((p) => /<CaseWorkspaceProvider/.test(codeOf(p)));
    expect(users.map((p) => p.slice(SRC.length + 1).split('\\').join('/'))).toEqual([
      'app/(app)/case/[id]/layout.tsx',
    ]);
  });
});

describe('栏是可弃的：呈现层零业务 state、零请求', () => {
  const PANES = ['DossierPane.tsx', 'ViewerPane.tsx'];
  // 注意别把 \b 收在 `fetch(` 后面：`(` 是非词字符，后面跟引号也是非词字符，
  // 边界不成立，整条会静默漏掉 fetch —— 这条正是变异用例逮到的。
  const BUSINESS = /\buseState\b|\buseReducer\b|\bfetch\s*\(|\bEventSource\b|_stream|_mock/;

  it.each(PANES)('%s 不持有状态也不发请求', (f) => {
    expect(BUSINESS.test(read(f))).toBe(false);
  });

  it('变异核：这条正则对真违例会报（否则上一条是空转）', () => {
    expect(BUSINESS.test(`const [open, setOpen] = useState(false);`)).toBe(true);
    expect(BUSINESS.test(`await fetch('/api/v1/cases')`)).toBe(true);
    expect(BUSINESS.test(`import { demoCase } from '@/app/_mock/demo';`)).toBe(true);
    // 纯读上下文不算持有
    expect(BUSINESS.test(`const { viewer } = useCaseWorkspace();`)).toBe(false);
  });

  it('清单非空且文件都在（改名后守卫会静默守着零个文件）', () => {
    expect(PANES.length).toBeGreaterThan(0);
    for (const f of PANES) expect(() => statSync(join(WS, f))).not.toThrow();
  });
});

describe('红线①：视口判定不进 render', () => {
  // 照视口切树 = 拖窗口跨断点时 SSE 当场断，正是批 1 那个坑换个地方复现
  const VIEWPORT = /\b(matchMedia|useMediaQuery|innerWidth|outerWidth|window\.screen)\b/;

  it.each(wsFiles())('%s 里没有视口判定', (f) => {
    expect(VIEWPORT.test(read(f))).toBe(false);
  });

  it('变异核：这条正则对真违例会报', () => {
    expect(VIEWPORT.test(`const wide = window.matchMedia('(min-width: 1320px)').matches;`)).toBe(true);
    expect(VIEWPORT.test(`const wide = useMediaQuery('(min-width:920px)');`)).toBe(true);
    expect(VIEWPORT.test(`if (window.innerWidth > 920) return <Three/>;`)).toBe(true);
    // 事件回调里读几何是允许的，别把它误伤
    expect(VIEWPORT.test(`p.getClientRects().length > 0`)).toBe(false);
  });

  it('文件清单非空（目录改名后这组会静默变成守零个文件）', () => {
    expect(wsFiles().length).toBeGreaterThanOrEqual(4);
  });
});

describe('红线②：data-wide 退役', () => {
  it('src 下一处都不剩', () => {
    const left = walk(SRC).filter((p) => /data-wide/.test(codeOf(p)));
    expect(left.map((p) => p.slice(SRC.length + 1))).toEqual([]);
  });
});

describe('阈值只写在一处', () => {
  it('三个容器阈值都在 globals.css，组件里没有第二份', () => {
    const css = readFileSync(join(SRC, 'app/globals.css'), 'utf8');
    for (const n of ['990px', '1400px']) {
      expect(css).toContain(`@container work (min-width: ${n})`);
    }
    // 组件里不许出现裸的媒体查询断点数字（工作区跟可用宽度走，不跟视口走）
    for (const f of wsFiles()) {
      expect(read(f)).not.toMatch(/min-width:\s*\d/);
    }
  });
});

/** 测试文件不算产品代码：变异用例里就带着这些被禁的写法。 */
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === '__tests__') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}
