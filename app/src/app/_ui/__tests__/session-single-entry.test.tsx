/**
 * F-202：登录态失效之后，案件路由上得有一条**指向登录页**的出路，而且只有一条。
 *
 * ─────────────── 这组守的是哪个缺口 ───────────────
 * 小白第二轮实测：把 localStorage 里的 token 改成乱码再刷新 /case/5，
 * 页面写着「登录状态已失效，请重新验证 / 你的案件和材料都还在，只是这次没读到」，
 * 唯一那颗按钮是**重试**——它拿的是同一个坏 token，控制台里排着 7 条 401，
 * 整条案件路由上没有任何一个能去登录页的入口。同一时刻 /account 是对的。
 *
 * 也就是说正确的出路早就写过一遍，只是写在别处；案件页这边六个子页各写各的重试。
 * 所以这一组盯的是一条链，四个环各自有判据，缺哪个环用户都走不出去：
 *   ① 401（本机原本有 token）→ 立起「这次会话失效了」那面旗
 *   ② 旗立起来 → 闸门整块让位给「去登录」，**不给重试**
 *   ③ 那颗「去登录」→ /login?next=<被踢出来的那一页>，且点下去先清 token
 *   ④ 闸门挂在案件路由的 layout 上（挂一次盖六个子页），子页里不许有第二处 401 处理
 */
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

const {
  SessionExpiredScreen,
  SessionGate,
  forgetSession,
  isSessionExpired,
  loginHref,
  resetSessionExpired,
  sessionGateContent,
} = await import('../session');
const { apiFetch } = await import('../api');
const { TOKEN_STORAGE_KEY } = await import('../auth');

/* ── 本机 localStorage 的最小替身：只记「现在有什么」和「谁被删了」 ── */

function stubStorage(initial: Record<string, string>) {
  const store = new Map(Object.entries(initial));
  const removed: string[] = [];
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => {
      removed.push(k);
      store.delete(k);
    },
  });
  return { store, removed };
}

/** 后端那一句 401 的形状照 lib/auth/http.ts */
function stubFetch401() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(
        JSON.stringify({ ok: false, error_code: 'UNAUTHORIZED', message: '登录状态已失效' }),
        { status: 401, headers: { 'Content-Type': 'application/json' } },
      ),
    ),
  );
}

beforeEach(() => {
  resetSessionExpired();
});
afterEach(() => {
  vi.unstubAllGlobals();
  resetSessionExpired();
});

/* ── 环① 401 → 立旗 ────────────────────────────────────── */

describe('环①：401 且本机原本有 token → 这次会话被记成「失效」', () => {
  it('坏 token 换来一个 401，旗子立起来', async () => {
    stubStorage({ [TOKEN_STORAGE_KEY]: '乱码乱码乱码' });
    stubFetch401();
    expect(isSessionExpired(), '前置：这一刻还没失效').toBe(false);
    await expect(apiFetch('/cases/5')).rejects.toThrow();
    expect(
      isSessionExpired(),
      '缺什么：401 回来了，token 也清了，但没人记下「这次会话失效过」。\n' +
        '为什么缺：清 token 只让登录态翻成"未登录"；页面手里拿着的是一个异常，' +
        '各自画各自的「重试」，而重试拿的是同一个坏 token——这正是 F-202 那个点不完的死循环。\n' +
        '怎么办：_ui/api.ts 的 handleUnauthorized 里，hadToken 为真时调 markSessionExpired()。',
    ).toBe(true);
  });

  it('反向对照：本机压根没有 token 的 401 不立旗——那是「请先登录」，不是「你的登录失效了」', async () => {
    stubStorage({});
    stubFetch401();
    await expect(apiFetch('/cases/5')).rejects.toThrow();
    expect(
      isSessionExpired(),
      '从没登录过的人撞到 401，屏幕上该说「登录后才能看…」（各子页自己拦着，不发请求），' +
        '说「你的登录状态已失效」会让他以为自己弄坏了什么。',
    ).toBe(false);
  });

  it('反向对照：正常的 200 不立旗', async () => {
    stubStorage({ [TOKEN_STORAGE_KEY]: '好 token' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ ok: true, cases: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    await apiFetch('/cases');
    expect(isSessionExpired()).toBe(false);
  });
});

/* ── 环② 立旗 → 整块让位，且不给重试 ─────────────────────── */

const CHILD = <p>驾驶舱的正文（时间线 / 行动卡 / 期限）</p>;
const html = (node: ReactNode) => renderToStaticMarkup(<>{node}</>);

describe('环②：失效那一屏给的是「去登录」，不是「重试」', () => {
  it('失效时闸门整块让位：出现「去登录」，子页正文不再渲染', () => {
    const h = html(sessionGateContent(true, '/case/5', CHILD));
    expect(
      h,
      '缺什么：登录态失效了，屏幕上没有任何一个能去登录页的入口。\n' +
        '为什么缺：这是 F-202 的原形——子页只会说「这一屏没取出来，点下面再试一次」。\n' +
        '怎么办：案件路由的 layout 上挂 _ui/session 的 SessionGate。',
    ).toContain('去登录');
    expect(h, '底下那些屏此刻能画出来的每一格都是拿坏 token 换来的，不该留在屏幕上').not.toContain(
      '驾驶舱的正文',
    );
  });

  it('这一屏不许有「重试」——重试拿的是同一个坏 token，点一百次就是一百个 401', () => {
    const h = html(<SessionExpiredScreen next="/case/5" />);
    for (const word of ['重试', '重新加载', '再试一次']) {
      expect(
        h.includes(word),
        `失效屏上出现了「${word}」。它拿的还是那个已经不作数的 token，` +
          '这正是这一单要消灭的死循环；能救人的只有去登录那一条。',
      ).toBe(false);
    }
  });

  it('反向对照：没失效时闸门什么都不做，子页照常渲染', () => {
    // 少了这条，把闸门写成「恒展示去登录」也全绿——那时整条案件路由都打不开了。
    const h = html(sessionGateContent(false, '/case/5', CHILD));
    expect(h).toContain('驾驶舱的正文');
    expect(h).not.toContain('去登录');
  });
});

/* ── 环③ 出路：带回跳路径 + 点下去先清 token ───────────────── */

describe('环③：「去登录」指向 /login 并带着被踢出来的那一页', () => {
  it('地址是 /login，next 参数解出来正是那一页', () => {
    const href = loginHref('/case/5');
    expect(href.startsWith('/login?next=')).toBe(true);
    expect(new URL(href, 'https://law.example').searchParams.get('next')).toBe('/case/5');
  });

  it('渲染出来的按钮就是这个地址（不是另拼一个）', () => {
    expect(html(<SessionExpiredScreen next="/case/5" />)).toContain(`href="${loginHref('/case/5')}"`);
  });

  it('那颗按钮点下去先清 token——挂的就是 forgetSession 本尊', () => {
    // 认函数身份不认字符串：改了实现名字这条照样绿，把 onClick 摘掉才该红。
    // 展开这一屏本身（不是 <SessionExpiredScreen/> 那个未渲染的元素）再找
    const cta = findCta(SessionExpiredScreen({ next: '/case/5' }));
    expect(
      cta?.props.onClick,
      '缺什么：「去登录」没有清掉本机那个已经不作数的 token。\n' +
        '为什么缺：apiFetch 在收到 401 的那一刻清过一次，但这一屏可能停留很久，' +
        '期间任何一处把旧 token 写回去（多标签页、还原的会话），点下去就又带着坏 token 进登录页。\n' +
        '怎么办：给那颗按钮挂 onClick={forgetSession}。',
    ).toBe(forgetSession);
  });

  it('forgetSession 真的把 token 从本机抹掉', () => {
    const { removed, store } = stubStorage({ [TOKEN_STORAGE_KEY]: '乱码乱码乱码' });
    forgetSession();
    expect(removed, `本机 token 没被删；还留着 ${JSON.stringify([...store.keys()])}`).toContain(
      TOKEN_STORAGE_KEY,
    );
    expect(store.has(TOKEN_STORAGE_KEY)).toBe(false);
  });
});

/**
 * 在元素树里找那颗「去登录」的锚。
 * **要走遍所有 prop 而不只是 children**：这颗按钮是当作 EmptyState 的 `action` 传进去的，
 * 只顺着 children 走会走空——那时这条判据永远绿，而按钮上有没有挂清 token 无人知晓。
 */
function findCta(node: unknown): ReactElement<{ onClick?: unknown; href?: string }> | null {
  if (Array.isArray(node)) {
    for (const n of node) {
      const hit = findCta(n);
      if (hit) return hit;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  const props = node.props as Record<string, unknown>;
  if (props.children === '去登录') return node as ReactElement<{ onClick?: unknown }>;
  for (const value of Object.values(props)) {
    const hit = findCta(value);
    if (hit) return hit;
  }
  return null;
}

/* ── 环④ 挂在 layout 上，子页里没有第二处 ─────────────────── */

const CASE_ROUTE = join(process.cwd(), 'src/app/(app)/case/[id]');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === '__tests__') continue;
      out.push(...sourceFiles(p));
    } else if (/\.tsx?$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

describe('环④：闸门挂在案件路由的 layout 上，子页里不许有第二处 401 处理', () => {
  it('case/[id]/layout.tsx 挂着 SessionGate，next 指向这个案件自己', async () => {
    const CaseLayout = (await import('../../(app)/case/[id]/layout')).default;
    const tree = (await CaseLayout({
      children: <div />,
      params: Promise.resolve({ id: '5' }),
    })) as ReactElement;
    const gate = findGate(tree);
    expect(
      gate,
      '缺什么：案件路由的 layout 上没有登录态失效的闸门。\n' +
        '为什么缺：驾驶舱、问它、证据、文书、公司档案、关系图各有各的取数与各自的「重试」，' +
        '出路挂在 layout 上才是挂一次盖六个；挂进某一个子页，其余五个照旧是死胡同。\n' +
        '怎么办：在 (app)/case/[id]/layout.tsx 里用 <SessionGate next={`/case/${id}`}> 包住 children。',
    ).not.toBeNull();
    expect(gate?.props.next, '回跳路径要指向被踢出来的这个案件').toBe('/case/5');
  });

  it('子页里没有第二处：整棵 case/[id] 子树既不出现 UNAUTHORIZED，也不 import _ui/session', () => {
    const files = sourceFiles(CASE_ROUTE);
    expect(files.length, '正对照：扫描器得真的扫到文件，扫了个空也会全绿').toBeGreaterThan(20);
    const offenders: string[] = [];
    for (const file of files) {
      const rel = file.slice(CASE_ROUTE.length + 1);
      const src = readFileSync(file, 'utf8');
      if (rel !== 'layout.tsx' && /_ui\/session/.test(src)) offenders.push(`${rel}（自己引了出路）`);
      if (/UNAUTHORIZED/.test(src)) offenders.push(`${rel}（自己认 401 的错误码）`);
    }
    expect(
      offenders,
      '缺什么：案件子页里又出现了自己处理 401 的地方：\n  ' +
        offenders.join('\n  ') +
        '\n为什么缺：出路复制第二份，就有第三份、第四份；F-202 的成因正是' +
        '「/account 写对了一次，案件页六个子页各写各的重试」。\n' +
        '怎么办：401 的出路只归 (app)/case/[id]/layout.tsx 上那道闸门，子页一行都不用写。',
    ).toEqual([]);
  });
});

/** 在 layout 的元素树里找 SessionGate 本尊（认组件身份，不认名字字符串） */
function findGate(node: ReactNode): ReactElement<{ next?: string }> | null {
  if (Array.isArray(node)) {
    for (const n of node) {
      const hit = findGate(n);
      if (hit) return hit;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  if (node.type === SessionGate) return node as ReactElement<{ next?: string }>;
  return findGate((node.props as { children?: ReactNode }).children);
}
