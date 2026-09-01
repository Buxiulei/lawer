/**
 * 「我的案件在哪儿」与「登录态存不存得住」两件事的判据。
 *
 * 用户报的是两句话——「点『我的』进的是演示案件」和「刷新一下就没登录态了」——
 * 排查下来是同一处：登录态一直好好躺在 localStorage 里，是**去处**写死成了 demo。
 * 他刷新首页被送进演示案件，再点横幅上那条「回到我的案件」被送到登录页，
 * 于是"跳错了"在他眼里就长成了"登录掉了"。两层各有判据，别再让它们混成一句。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CASE_ID_PATTERN,
  CASE_ID_STORAGE_KEY,
  CASE_RESOLVER_PATH,
  myCaseHref,
  readCachedCaseId,
  writeCachedCaseId,
  caseIdFromPath,
} from '../currentCase';
import * as bootstrap from '../bootstrap';
import { TOKEN_STORAGE_KEY } from '../bootstrap';
import { CASE_NAV_ITEMS } from '@/components/shell/navItems';
import { caseHref } from '@/components/shell/navItems';
import { crumbsFor } from '@/components/shell/breadcrumbs';

const UI = join(process.cwd(), 'src/app/_ui');
const SHELL = join(process.cwd(), 'src/components/shell');

/** localStorage 关浏览器还在，sessionStorage 关标签页就没——两个都建，好让"存错地方"验得出来 */
function installStorage() {
  const local = new Map<string, string>();
  let session = new Map<string, string>();
  const face = (m: () => Map<string, string>) => ({
    getItem: (k: string) => m().get(k) ?? null,
    setItem: (k: string, v: string) => void m().set(k, v),
    removeItem: (k: string) => void m().delete(k),
    clear: () => m().clear(),
  });
  vi.stubGlobal('localStorage', face(() => local));
  vi.stubGlobal('sessionStorage', face(() => session));
  return {
    /** 模拟重开一个标签页：sessionStorage 清空，localStorage 留着 */
    reopenTab: () => {
      session = new Map();
    },
  };
}

let storage: ReturnType<typeof installStorage>;

beforeEach(() => {
  storage = installStorage();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

/* ── 一、去处解析：三态 ─────────────────────────────────── */

describe('登录 + 名下有案件', () => {
  it('解析到他名下那个真实案件', () => {
    expect(myCaseHref({ signedIn: true, caseId: 2 })).toBe('/case/2');
  });

  // 变异核：把解析改回 demo 兜底，这条立刻红
  it('不是演示案件', () => {
    expect(myCaseHref({ signedIn: true, caseId: 2 })).not.toContain('demo');
  });
});

describe('登录 + 还不知道是哪个案件', () => {
  it('去解析页现查接口，而不是就近拿个默认值顶上', () => {
    expect(myCaseHref({ signedIn: true, caseId: null })).toBe(CASE_RESOLVER_PATH);
  });

  it('解析页不是演示案件', () => {
    expect(CASE_RESOLVER_PATH).not.toContain('demo');
  });
});

describe('未登录', () => {
  it('点「我的案件」去登录页', () => {
    expect(myCaseHref({ signedIn: false, caseId: null })).toBe('/login');
  });

  it('哪怕缓存里还留着上一个人的 id，也不许拿来用', () => {
    expect(myCaseHref({ signedIn: false, caseId: 2 })).toBe('/login');
  });
});

/* ── 二、壳层里每一条案件链接都受同一个解析管 ─────────────── */

describe('不知道是哪个案件时，壳层给的链接', () => {
  it('底部四栏全部指向解析页，一条都不指演示案件', () => {
    const hrefs = CASE_NAV_ITEMS.map((item) => item.href(null));
    expect(hrefs).toHaveLength(4); // 正对照：清单空了这条断言会永远绿
    for (const href of hrefs) expect(href).toBe(CASE_RESOLVER_PATH);
  });

  it('知道是哪个案件时照旧带 id（别把功能改没了）', () => {
    expect(CASE_NAV_ITEMS.map((item) => item.href('2'))).toEqual([
      '/case/2',
      '/case/2/ask',
      '/case/2/evidence',
      '/case/2/drafts',
    ]);
  });

  it('侧栏标题与面包屑走同一个构造', () => {
    expect(caseHref(null)).toBe(CASE_RESOLVER_PATH);
    expect(caseHref('2')).toBe('/case/2');
  });

  it('首诊页的「驾驶舱」面包屑不再指演示案件', () => {
    const home = crumbsFor('/intake', null)[0];
    expect(home.href).toBe(CASE_RESOLVER_PATH);
    expect(home.href).not.toContain('demo');
  });

  it('高亮判定在不知道案件时不乱命中', () => {
    const ask = CASE_NAV_ITEMS.find((i) => i.key === 'ask')!;
    expect(ask.match('/case/2/ask', null)).toBe(false);
    expect(ask.match('/case/2/ask', '2')).toBe(true);
    // 首诊归驾驶舱那一栏，与是哪个案件无关
    const dash = CASE_NAV_ITEMS.find((i) => i.key === 'dashboard')!;
    expect(dash.match('/intake', null)).toBe(true);
  });
});

describe('路径里的案件 id', () => {
  it('案件页取得到', () => {
    expect(caseIdFromPath('/case/2/evidence')).toBe('2');
  });

  // 变异核：这里曾经回 'demo'，正是「站在『我的』页点任何一栏都进演示案件」的病灶
  it('非案件页回 null，不回任何兜底 id', () => {
    for (const p of ['/account', '/settings', '/intake', '/']) {
      expect(caseIdFromPath(p)).toBeNull();
    }
  });
});

/* ── 三、缓存：省一次往返，但不许成为错答案的来源 ─────────── */

describe('案件 id 缓存', () => {
  it('写进去读得回来', () => {
    writeCachedCaseId(2);
    expect(readCachedCaseId()).toBe(2);
  });

  it('脏值当作没有，不拿去拼一个 404 的地址', () => {
    for (const dirty of ['demo', '0', '-1', '2x', '', '../admin']) {
      localStorage.setItem(CASE_ID_STORAGE_KEY, dirty);
      expect(readCachedCaseId()).toBeNull();
    }
  });

  it('localStorage 不可用时按没有处理，不抛', () => {
    vi.stubGlobal('localStorage', {
      getItem() {
        throw new Error('隐私模式');
      },
    });
    expect(readCachedCaseId()).toBeNull();
  });

  it('退出登录会清掉——上一个人的案件 id 不该留给下一个人', async () => {
    const auth = await import('../auth');
    auth.writeToken('t');
    writeCachedCaseId(2);

    auth.clearToken();
    expect(localStorage.getItem(CASE_ID_STORAGE_KEY)).toBeNull();
  });
});

/* ── 四、登录态持久化 ───────────────────────────────────── */

/**
 * 【这一层的真实形态】全站没有任何鉴权 cookie，JWT 存在 localStorage
 * （_ui/auth 抬头写明了理由：所有带 token 的请求都由浏览器端发起）。
 * 所以「没设 maxAge 的 session cookie」这个病因在这份代码里不成立；
 * 与之等价的失效形态是**把 token 存进了关标签页就没的地方**。下面这条盯的是它。
 */
describe('登录态存得住', () => {
  it('关掉标签页重开，token 还在', async () => {
    const auth = await import('../auth');
    auth.writeToken('jwt-abc');

    storage.reopenTab();
    vi.resetModules();
    const reloaded = await import('../auth');

    expect(reloaded.readToken()).toBe('jwt-abc');
  });

  // 变异核：把 _ui/auth 的 localStorage 换成 sessionStorage，上面那条立刻红。
  // 这条是它的正对照——两个 storage 在测试替身里确实是分开的两份。
  it('两个 storage 在替身里是分开的（否则上面那条永远绿）', () => {
    localStorage.setItem('k', 'local');
    sessionStorage.setItem('k', 'session');
    storage.reopenTab();
    expect(localStorage.getItem('k')).toBe('local');
    expect(sessionStorage.getItem('k')).toBeNull();
  });

  it('_ui/auth 只往 localStorage 写', () => {
    const src = readFileSync(join(UI, 'auth.ts'), 'utf8');
    expect(src).toContain('localStorage.setItem');
    expect(src).not.toContain('sessionStorage');
    expect(src).not.toContain('document.cookie');
  });
});

/* ── 五、首屏脚本一个都不许跳走 ─────────────────────────── */

/**
 * 【这一节反过来了，2026-09-01】原来这里验的是「有 token 就跳进案件」，
 * 逐条断言它把人送到 /case/2、/case。产品负责人亲测后裁定那整个机制是病：
 * 「不要默认都跳转到 case 里！默认就是主页！」——登录用户地址栏输 `/`
 * 在首帧前就被换成 `/case/…`，主页对他等于不存在。
 *
 * 所以现在验的是**没有任何首屏脚本会跳走**。仍然真跑脚本本尊，不照文本断言：
 * 「源码里没有 location.replace 这串字」挡不住有人换成 `location['rep'+'lace']`
 * 或 `history.replaceState` + `assign`。跑一遍才知道它到底动没动导航。
 */
describe('首屏脚本（已登录也不许把人跳走）', () => {
  /** 落地页与根布局注入的每一段首屏脚本。新增一段忘了加进来，下面那条正对照会点名。 */
  const bootScripts: [string, string][] = Object.entries(bootstrap).filter(
    (entry): entry is [string, string] =>
      typeof entry[1] === 'string' && entry[1].includes('(function(){'),
  );

  /**
   * 把脚本放进替身环境跑一遍，回它动过的导航（没动就是 null）。
   * new Function 的函数体是本仓自己的源码常量（不接受任何外部输入）。
   * 首屏脚本要摸 document（主题 class、低调标题、favicon），给一份最小替身，
   * 免得它们在第一行就被自己的 try/catch 吞掉——那样等于什么都没验。
   */
  function runBootScript(script: string, store: Record<string, string>): string | null {
    let navigated: string | null = null;
    const nav = (url: string) => {
      navigated = url;
    };
    const doc = {
      documentElement: { classList: { add: () => {} }, dataset: {} as Record<string, string> },
      title: '',
      head: { appendChild: () => {} },
      querySelectorAll: () => [] as unknown[],
      querySelector: () => null,
      createElement: () => ({ setAttribute: () => {} }),
    };
    const sandbox = new Function('localStorage', 'location', 'history', 'document', script);
    sandbox(
      { getItem: (k: string) => store[k] ?? null, setItem: () => {}, removeItem: () => {} },
      { replace: nav, assign: nav, href: '/' },
      { replaceState: (_s: unknown, _t: unknown, url: string) => nav(url), pushState: nav },
      doc,
    );
    return navigated;
  }

  /** 最"该"被跳走的那个人：登录了、缓存里还躺着案件 id、低调模式也开着。 */
  const signedInWithCase = {
    [TOKEN_STORAGE_KEY]: 'jwt-abc',
    [CASE_ID_STORAGE_KEY]: '2',
    'lawer.discreet': '1',
  };

  // 正对照：清单空了下面那条会永远绿（本仓现有主题 + 低调两段）
  it('确实取到了首屏脚本（否则下一条在空集上断言）', () => {
    expect(bootScripts.length).toBeGreaterThanOrEqual(2);
  });

  // 变异核：把 signedInRedirectScript 加回 bootstrap.ts，这条立刻红
  it.each(bootScripts)('%s：带 token 跑一遍也不动导航', (_name, script) => {
    expect(runBootScript(script, signedInWithCase)).toBeNull();
    expect(runBootScript(script, {})).toBeNull();
  });

  it('bootstrap 不再导出任何"登录即跳走"的脚本', () => {
    expect(Object.keys(bootstrap)).not.toContain('signedInRedirectScript');
    // 反过来说，解析页那个常量必须还在：主动点击的去处仍要有人给
    expect(CASE_RESOLVER_PATH).toBe('/case');
    expect(CASE_ID_PATTERN.test('2')).toBe(true);
  });
});

/* ── 六、结构守卫：新写的第四处 demo 兜底会被点名 ───────────── */

describe('壳层不许再自己决定「我的案件是哪个」', () => {
  /**
   * 只看**代码行**，注释里提 demo 不算。
   * 第一版把注释也数进去，当场误报——我自己那句「绝不兜底成 demo」的注释被判成了新兜底。
   * 守卫误报和漏报一样坏：会被下一个人当噪音关掉，然后真回归时没人拦。
   */
  function codeLinesMentioning(file: string, word: string): string[] {
    return readFileSync(join(SHELL, file), 'utf8')
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\/?\*)/.test(l))
      .filter((l) => l.includes(word));
  }

  it('AppShell 的代码里只剩「判断当前是不是 demo 页」那一处', () => {
    const lines = codeLinesMentioning('AppShell.tsx', 'demo');
    // 断言行数而不是"不含 demo"：横幅确实要判断自己在不在 demo 页，那一行合法；
    // 多出来的任何一行都是新的兜底，要在这儿被拦下。
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('onDemoCase');
  });

  it('导航构造里没有任何硬编码的案件 id', () => {
    // 正对照：这个文件确实有代码行提到 case，否则下一条等于在空集上断言
    expect(codeLinesMentioning('navItems.tsx', 'case').length).toBeGreaterThan(0);
    expect(codeLinesMentioning('navItems.tsx', 'demo')).toEqual([]);
  });

  it('演示横幅那条链接的去处由 currentCase 算，不再写死', () => {
    const src = readFileSync(join(SHELL, 'DemoBanner.tsx'), 'utf8');
    expect(src).toContain('useMyCaseHref');
    expect(src).not.toContain('href="/login"');
  });
});
