/**
 * 「我的」页上那条省公道值的引导（接到你自己的 AI 助手上）。
 *
 * 立这组的由头：这条引导做的是**一个可核对的事实断言**——「数据读写不扣公道值，
 * 只有我们替你调模型才扣」。它靠的是全仓只有 `lib/agent/orchestrator.ts` 一处调
 * `gongdaoSettle`。所以除了渲染，这里还把那条事实本身钉住（见最后一个 describe）：
 * 哪天有人给 MCP 路由加了扣费，页面上这句话就变成谎话，而**页面看起来完全正常**。
 *
 * 另一条守的是低调模式：这一页在低调模式下把「公道值」换成中性词，
 * 新加的文案漏换一处就是一次泄漏。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const ui = { discreet: false };
vi.mock('@/app/_ui/discreet', () => ({
  useDiscreet: () => ({ discreet: ui.discreet, toggle: () => {} }),
}));
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

const billingState = {
  data: { balance: 1200, ledgerSum: 1200, reconciled: true, complete: true, entries: [] },
  loading: false,
  error: null as string | null,
  unauthorized: false,
  hasMore: false,
  loadMore: () => {},
};
const meState = { data: null as null | Record<string, unknown>, loading: false, unauthorized: false };
const auth = { signedIn: true };
vi.mock('../_components/useBilling', () => ({ useBilling: () => billingState }));
vi.mock('../_components/useMe', () => ({ useMe: () => meState }));
vi.mock('@/app/_ui/auth', () => ({ useSignedIn: () => auth.signedIn }));

const { AccountView } = await import('../_components/AccountView');

const render = (discreet: boolean, signedIn = true) => {
  ui.discreet = discreet;
  auth.signedIn = signedIn;
  const html = renderToStaticMarkup(<AccountView />);
  ui.discreet = false;
  auth.signedIn = true;
  return html;
};

/** 引导句里那半句「不扣」——低调模式下前半句的词会被换掉，这半句不会 */
const HINT = '把这里接到你自己的 AI 助手上';

/**
 * 只取引导那一个 `<p>`。
 *
 * 【为什么不整页断言】这一页别处**本来就**含「公道值 / 仲裁」等字样
 * （RechargePanel 的套餐说明与「适合谁」那行，基线 6413dc5 即如此，
 * 且源码里有注释写明是有意为之）——低调模式对正文用的是**糊层**（data-veil）
 * 而不是换词（见 `_ui/neutral` 顶部说明：换词只给壳层）。
 * 拿整页去断言，测的就不是这条新文案，而是页面别处的既有行为。
 */
function hintParagraph(html: string): string {
  const i = html.indexOf(HINT);
  expect(i).toBeGreaterThan(-1); // 正对照：引导确实渲染了，不是断言落在空串上
  return html.slice(html.lastIndexOf('<p', i), html.indexOf('</p>', i));
}

describe('省公道值引导：渲染', () => {
  it('登录后出现在余额卡里，并给出通往设置页的入口', () => {
    const html = render(false);
    expect(html).toContain(HINT);
    /*
     * 入口必须在**这一段里面**。
     * 这条原来写的是整页 `toContain('href="/settings"')`——跑变异时存活了：
     * 页头本来就有一个「设置」链接，把引导里的链接整个删掉，断言照样绿。
     * 断言落在了页头那个链接上，测的根本不是这条引导。
     */
    expect(hintParagraph(html)).toContain('href="/settings"');
  });

  it('说清「不扣的是什么、什么才扣」——只说一半会被读成「接了就全免费」', () => {
    const html = render(false);
    expect(html).toContain('不扣公道值');
    // 得说清「什么才扣」：模型调用 + 主动下单（公司档案 / 盯守），不能只说「不扣」被读成全免费
    expect(html).toContain('只在两种情况下扣');
    expect(html).toContain('替你调模型时');
    expect(html).toContain('主动下单');
  });
});

describe('省公道值引导：低调模式不泄漏', () => {
  it('这一句跟着换成中性词，自己不留「公道值」', () => {
    const p = hintParagraph(render(true));
    expect(p).toContain('不扣额度');
    expect(p).not.toContain('公道值');
  });

  it('常规模式下照旧说「公道值」——换词只该发生在低调模式', () => {
    // 反向对照：少了这条，把 creditWord 写死成 '额度' 也能让上一条绿
    const p = hintParagraph(render(false));
    expect(p).toContain('不扣公道值');
    expect(p).not.toContain('额度');
  });

  it('进糊层：正文的低调策略是 data-veil，不是换词', () => {
    expect(hintParagraph(render(true))).toContain('data-veil');
  });

  it('引导本身不带案件字样', () => {
    const p = hintParagraph(render(true));
    for (const leak of ['仲裁', '案件', '劳动', '维权']) {
      expect(p).not.toContain(leak);
    }
  });
});

describe('省公道值引导：未登录时不出现', () => {
  it('没登录就没有密钥可接，先摆一条接入引导只是噪音', () => {
    expect(render(false, false)).not.toContain(HINT);
  });
});

/**
 * 页面上印着的那句事实，在代码里的**唯一依据**。
 *
 * 这不是绕远路测实现细节：这条断言正是文案敢写「不扣」的全部理由。
 * 扣费出口只有 `gongdaoSettle` 一个；只要它的非测试调用点仍然只有 orchestrator 一处，
 * MCP/REST 那些数据工具就确实一分不扣。多出任何一处调用，这句文案就需要重写。
 */
describe('文案所依据的事实：扣费只发生在模型轮次里', () => {
  const SRC = join(process.cwd(), 'src');

  const callers = (fn: string) => {
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name !== '__tests__' && e.name !== 'node_modules') walk(p);
        } else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) {
          // 只算真正的调用 `fn(`，不算 import 那行与注释里提到的名字
          const text = readFileSync(p, 'utf8');
          for (const line of text.split('\n')) {
            const t = line.trim();
            if (t.startsWith('*') || t.startsWith('//') || t.startsWith('import')) continue;
            if (new RegExp(`\\b${fn}\\s*\\(`).test(line)) {
              out.push(p.slice(SRC.length + 1));
              break;
            }
          }
        }
      }
    };
    walk(SRC);
    return out;
  };

  it('gongdaoSettle 的非测试调用点仍然只有 orchestrator 一处', () => {
    // 豁免只给这两个具名文件（index.ts 是定义处，backfill.ts 是补记账的既有调用点）。
    // 这里原来豁免整个 `lib/billing/` 目录，跑变异时存活了：在该目录下新建一个
    // `mcpCharge.ts` 包一层 gongdaoSettle 给 MCP 侧调用，扣费就真的发生了，而断言照样绿——
    // 把「最像扣费的新代码会落在哪」的那个目录整个排除在外，等于不看最该看的地方。
    const EXEMPT = ['lib/billing/index.ts', 'lib/billing/backfill.ts'];
    const found = callers('gongdaoSettle').filter((p) => !EXEMPT.includes(p));
    // 三处具名合法扣费点系 manager 2026-08-31 挂尾裁决：模型轮次(orchestrator) + 两处主动下单
    // (公司档案购买 dossier-billing / 盯守订阅 watch-billing)。**扩到第四处须再裁，别无据自扩**。
    expect([...found].sort()).toEqual([
      'lib/agent/orchestrator.ts',
      'lib/company/dossier-billing.ts',
      'lib/company/watch-billing.ts',
    ]);
  });

  it('MCP 端点与 v1 案件数据路由都不扣费', () => {
    for (const p of callers('gongdaoSettle')) {
      expect(p.startsWith('app/api/mcp')).toBe(false);
      expect(/^app\/api\/v1\/cases\/\[id\]\/(evidence|deadlines|timeline|actions)/.test(p)).toBe(false);
    }
  });
});
