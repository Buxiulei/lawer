/**
 * useConnectedAgent 的**副作用**判据：取不到数据时它说什么、没登录时它发不发请求。
 *
 * ─────────────── 这组补的是哪个缺口 ───────────────
 * 对抗复审跑变异矩阵时，这两条改动**整套 3789 条全绿**：
 *   ① 把取数失败的回落从 NOT_CONNECTED 改成「已接入」——/keys 一抖，
 *      四个位置（驾驶舱常驻行、账户页、对话页提示条、接入指南横幅）同时对所有人显示
 *      「已接入：… · 最近一次 …」，而那个人可能一个字都还没粘。
 *   ② 去掉「没登录不发请求」那道门——给未登录访客打一枪 401，
 *      而 apiFetch 的 401 会顺手清 token。
 * 两条都藏在 useEffect 里，而 SSR 不跑 effect：全仓所有既有判据都是
 * renderToStaticMarkup，**够不着这段代码**。
 *
 * 【为什么手搓一个 hook 驱动】本仓 vitest 跑在 environment: 'node'，没有 jsdom，
 * 也没有 testing-library。与其为这两条判据装一整套渲染器，不如把 React 的两个 hook
 * 换成最小驱动：状态存在数组里、effect 收进队列由测试自己触发。
 * 被测的是 useConnectedAgent 里那段**真代码**（登录门、then/catch 两条回落、alive 清理），
 * 驱动只负责替 React 记状态——它不参与任何断言。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

/* ── 最小 hook 驱动 ────────────────────────────────────── */

let cells: unknown[] = [];
let cursor = 0;
let effects: Array<() => void | (() => void)> = [];

vi.mock('react', () => ({
  useState: (init: unknown) => {
    const i = cursor++;
    if (!(i in cells)) cells[i] = typeof init === 'function' ? (init as () => unknown)() : init;
    return [
      cells[i],
      (next: unknown) => {
        cells[i] = typeof next === 'function' ? (next as (p: unknown) => unknown)(cells[i]) : next;
      },
    ];
  },
  useEffect: (fn: () => void | (() => void)) => {
    effects.push(fn);
  },
}));

const auth = { signedIn: true };
vi.mock('../auth', () => ({ useSignedIn: () => auth.signedIn }));

const net = { apiFetch: vi.fn() };
vi.mock('../api', () => ({ apiFetch: (path: string) => net.apiFetch(path) }));

const { useConnectedAgent } = await import('../useConnectedAgent');
type Connected = ReturnType<typeof useConnectedAgent>;

/** 渲染一次：返回这一帧的值，effect 收进队列但不跑（跟 React 一样，先出帧再跑 effect） */
function render(): Connected {
  cursor = 0;
  effects = [];
  return useConnectedAgent();
}

/** 跑掉这一帧收集到的 effect，再渲染一帧读新状态 —— 微任务排干后才读 */
async function settle(): Promise<Connected> {
  const cleanups = effects.map((fn) => fn());
  await Promise.resolve();
  await Promise.resolve();
  const next = render();
  for (const c of cleanups) if (typeof c === 'function') c();
  return next;
}

beforeEach(() => {
  cells = [];
  cursor = 0;
  effects = [];
  auth.signedIn = true;
  net.apiFetch.mockReset();
});

/* ── 取不到数据：一律当"没接上"，绝不回落成"已接入" ──── */

describe('/keys 取不到数据时不许说「已接入」', () => {
  const shouldNotClaimConnected = (got: Connected, how: string) => {
    expect(
      got.connected,
      `缺什么：${how}时 useConnectedAgent 说「已接入」。\n` +
        `为什么缺：接口一抖，四个位置同时对所有人显示「已接入：… · 最近一次 …」，` +
        `而那个人可能一个字都还没粘。这个错的形态是静默的：页面读起来完全正常，` +
        `只是内容是编的。\n` +
        `怎么办：取不到就回落到 NOT_CONNECTED——「没接上」是这里唯一诚实的默认值。`,
    ).toBe(false);
    expect(got.name).toBe('');
    expect(got.when).toBe('');
    expect(got.nameIsKeyName).toBe(false);
    expect(got.loading).toBe(false);
  };

  it('接口报错（如 500 / 401）', async () => {
    net.apiFetch.mockRejectedValue(new Error('HTTP_500'));
    render();
    shouldNotClaimConnected(await settle(), '接口报错');
  });

  it('网络断了（fetch 直接抛）', async () => {
    net.apiFetch.mockRejectedValue(new TypeError('Failed to fetch'));
    render();
    shouldNotClaimConnected(await settle(), '网络断开');
  });

  it('正对照：真取到用过的钥匙时确实说「已接入」——否则上面两条在恒假上永远绿', async () => {
    net.apiFetch.mockResolvedValue({
      keys: [
        {
          id: 1,
          name: '我的 Claude',
          enabled: true,
          last_used_at: '2026-09-01 10:00:00',
          client_name: 'claude-code',
        },
      ],
    });
    render();
    const got = await settle();
    expect(got.connected).toBe(true);
    expect(got.name).toBe('claude-code');
    expect(got.nameIsKeyName).toBe(false);
  });
});

/* ── 没登录：一枪都不许发 ──────────────────────────────── */

describe('没登录不发请求', () => {
  it('未登录时 /keys 一次都不请求', async () => {
    auth.signedIn = false;
    net.apiFetch.mockResolvedValue({ keys: [] });
    render();
    const got = await settle();
    expect(
      net.apiFetch.mock.calls,
      `缺什么：未登录时仍然请求了 ${JSON.stringify(net.apiFetch.mock.calls)}。\n` +
        `为什么缺：没登录就没有钥匙可查，这一枪只会拿回 401——而 apiFetch 的 401 ` +
        `会顺手清 token。首页与 demo 页上都挂着这个 hook，给未登录访客打这一枪毫无必要。\n` +
        `怎么办：effect 里那句 \`if (!signedIn) { setState(NOT_CONNECTED); return; }\` 要留着。`,
    ).toEqual([]);
    expect(got.connected).toBe(false);
    expect(got.loading).toBe(false);
  });

  it('正对照：登录了就请求 /keys 一次——否则上一条在「从不请求」上永远绿', async () => {
    auth.signedIn = true;
    net.apiFetch.mockResolvedValue({ keys: [] });
    render();
    await settle();
    expect(net.apiFetch.mock.calls).toEqual([['/keys']]);
  });
});
