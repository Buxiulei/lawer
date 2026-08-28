/**
 * 「我的」页必须渲染**这个账户的真实数据**，不是演示值。
 *
 * 立这组的由头：这一页此前整半边读 `_mock/authpay`——余额是 `mockLedger[0].balanceAfter`，
 * 流水是 15 条写死的演示条目，而页面上印着「每一笔都记着，只增不改」。
 * **承诺与渲染源对不上**，且页面看起来完全正常，没有任何异常信号。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/app/_ui/discreet', () => ({
  useDiscreet: () => ({ discreet: false, toggle: () => {} }),
}));
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

const billingState = {
  data: null as null | Record<string, unknown>,
  loading: false,
  error: null as string | null,
  unauthorized: false,
  hasMore: false,
  loadMore: () => {},
};
const meState = { data: null as null | Record<string, unknown>, loading: false, unauthorized: false };
vi.mock('../_components/useBilling', () => ({ useBilling: () => billingState }));
vi.mock('../_components/useMe', () => ({ useMe: () => meState }));
vi.mock('@/app/_ui/auth', () => ({ useSignedIn: () => true }));

const { LedgerList } = await import('../_components/LedgerList');
const { AccountView } = await import('../_components/AccountView');
const COMPONENTS = join(process.cwd(), 'src/app/(app)/account/_components');

type Billing = Parameters<typeof LedgerList>[0]['billing'];

const entry = (id: number, delta: number, feature: string) => ({
  id,
  delta,
  type: delta > 0 ? '充值' : '消耗',
  feature,
  createdAt: '2026-08-20T10:00:00+08:00',
  balanceAfter: 100 + id,
});

function billing(over: Partial<NonNullable<Billing['data']>> & { entries: ReturnType<typeof entry>[] }): Billing {
  return {
    data: { balance: 0, ledgerSum: 0, reconciled: true, complete: true, ...over },
    loading: false,
    error: null,
    unauthorized: false,
    hasMore: false,
    loadMore: () => {},
  };
}

const text = (html: string) => html.replace(/<[^>]+>/g, '');

describe('空账户', () => {
  const html = renderToStaticMarkup(<LedgerList billing={billing({ entries: [] })} />);

  it('显示空态，而不是演示流水', () => {
    expect(text(html)).toContain('还没有流水');
  });

  it('一条演示条目都不许出现', () => {
    // 正对照：这两句确实是演示流水里的原文，不是我随手编的断言
    const mock = readFileSync(join(process.cwd(), 'src/app/_mock/authpay.ts'), 'utf8');
    const samples = ['兑换码到账', '开庭材料清单核对'];
    for (const w of samples) expect(mock).toContain(w);
    for (const w of samples) expect(text(html)).not.toContain(w);
  });
});

describe('有流水的账户', () => {
  const rows = [entry(1, 500, '充值'), entry(2, -12, '对话')];
  const html = renderToStaticMarkup(
    <LedgerList billing={billing({ entries: rows, balance: 588, ledgerSum: 588 })} />,
  );

  it('只渲染传进来的条目，条数与之相等', () => {
    expect(text(html)).toContain('共 2 条');
    for (const r of rows) expect(text(html)).toContain(r.feature);
  });

  it('演示数据的条数（15 条）不会出现', () => {
    expect(text(html)).not.toContain('共 15 条');
  });
});

/**
 * 结构守卫：**这条是「必须能红」的那条。**
 * 有人把 mock 接回来（哪怕只是"临时先跑起来"），这里立刻红。
 * 断言的是 import 语句本身，不是渲染结果——渲染结果在演示值和真值长得像的时候看不出区别。
 */
describe('账户页不许再从 mock 取用户数据', () => {
  const files = readdirSync(COMPONENTS).filter((f) => f.endsWith('.tsx') || f.endsWith('.ts'));

  /**
   * 只看 **import 语句**，不看整份源码。
   * 第一版写成「源码里不含 `_mock/demo` 这个串」，当场三条误报：
   * 注释里提了一句「不拿 `_mock/demo` 顶」也算，我自己定义的同名常量
   * `LEDGER_PAGE_SIZE` 也算。**守卫误报和守卫漏报一样坏**——
   * 会被下一个人当噪音关掉，然后真回归时没人拦。
   */
  function importsOf(src: string): { from: string; bindings: string }[] {
    return [...src.matchAll(/import\s+([\s\S]*?)\s+from\s+'([^']+)'/g)].map((m) => ({
      bindings: m[1],
      from: m[2],
    }));
  }

  it('清单非空——空清单会永远绿', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('至少有一个文件真的有 import——否则上面那条也是空的', () => {
    expect(files.some((f) => importsOf(readFileSync(join(COMPONENTS, f), 'utf8')).length > 0)).toBe(
      true,
    );
  });

  it.each(files)('%s 不导入 _mock/demo', (f) => {
    const froms = importsOf(readFileSync(join(COMPONENTS, f), 'utf8')).map((i) => i.from);
    expect(froms).not.toContain('@/app/_mock/demo');
  });

  it.each(files)('%s 不从 _mock/authpay 取账户数据', (f) => {
    const src = readFileSync(join(COMPONENTS, f), 'utf8');
    const authpay = importsOf(src).filter((i) => i.from === '@/app/_mock/authpay');
    // 定价常量（PLANS / TOPUP_* / GONGDAO_PER_YUAN）是公开价目，允许留在 mock 里；
    // 余额与流水是**这个账户的**数据，一个都不许从那儿来
    for (const imp of authpay) {
      for (const forbidden of ['mockLedger', 'gongdaoBalance', 'ledgerPage']) {
        expect(imp.bindings).not.toContain(forbidden);
      }
    }
  });
});

/**
 * 余额与账本对不上时必须**看得见**。
 *
 * 后端特意把 `balance` 与 `ledger_sum` 分开返回（注释原话：只给一个数，
 * 不符时页面会渲染出「一个看起来完全正常的错数」）。前端只挑一个数显示，
 * 等于把后端留出的告警信号扔掉——而这一页上印着
 * 「每一笔都记着，只增不改。对不上账随时把这页截给我们。」
 * **这条对账信号唯一的读者就是用户本人。**
 */
describe('余额与账本对不上', () => {
  const render = (balance: number, ledgerSum: number) => {
    billingState.data = {
      balance,
      ledgerSum,
      reconciled: balance === ledgerSum,
      complete: true,
      entries: [],
    };
    meState.data = null;
    return text(renderToStaticMarkup(<AccountView />));
  };

  // 断言必须挑警告**独有**的那句：页面常驻文案里本来就有「对不上账随时把这页截给我们」，
  // 拿「对不上」当判据会永远命中，这条断言就成了摆设
  const WARNING = '这个余额和下面的流水对不上';

  it('对得上时不出提示——不许制造无谓的警报', () => {
    const out = render(588, 588);
    expect(out).toContain('对不上账随时把这页截给我们'); // 常驻那句还在
    expect(out).not.toContain(WARNING); // 但警告没出
  });

  it('对不上时出提示，并且把两个数都摆出来', () => {
    const out = render(588, 600);
    expect(out).toContain(WARNING);
    expect(out).toContain('588');
    expect(out).toContain('600');
  });

  it('提示里要说清以哪个为准，以及这不是用户的错', () => {
    const out = render(588, 600);
    expect(out).toContain('以流水为准');
    expect(out).toContain('不会算在你头上');
  });
});

describe('负余额', () => {
  it('是设计内的透支，要解释一句，不能只甩一个负数', () => {
    billingState.data = { balance: -522, ledgerSum: -522, reconciled: true, complete: true, entries: [] };
    meState.data = null;
    const out = text(renderToStaticMarkup(<AccountView />));
    expect(out).toContain('-522');
    expect(out).toContain('扣穿');
  });
});
