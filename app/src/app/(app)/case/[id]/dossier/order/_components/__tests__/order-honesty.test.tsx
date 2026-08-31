/**
 * 报价页与「一键加守望」入口的呈现判据。
 *
 * 这一组和档案页那一组同形：断言的是**界面拒绝显示什么**。
 * 报价页的错误全都不是"显示坏了"，而是"显示得太自信"——一个买不到的模块标着价、
 * 一句被改写过的降级说明、一个藏在付款之后才说的时延承诺，都会照常渲染、照常好看，
 * 然后让用户花掉他本来不会花的钱、等一个永远不来的交付。
 *
 * 每条测试的注释里写着它的变异臂（把哪一行改坏它就该变红）。
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ discreet: false }));

vi.mock('@/app/_ui/discreet', () => ({
  useDiscreet: () => ({ discreet: state.discreet, setDiscreet: () => {}, toggle: () => {} }),
}));
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

import type { DossierModule, DossierQuote, DossierQuoteItem } from '@/lib/company/dossier-billing';
import type { ProbeResult } from '@/lib/company/probe';
import { mockProbe, mockQuote, mockDossier } from '@/app/_mock/company-dossier';
import {
  MODULE_CATALOG,
  moduleAvailability,
  preChargeDisclosures,
  summarizeSelection,
} from '@/lib/dossier/order';
import { describeWideElements, findWideElements } from '@/lib/ui/viewport393';
import { WATCH_TIER_GONGDAO } from '@/lib/billing/pricing';
import { TIER_ORDER, WatchEntry, WatchTierPicker } from '@/components/case/WatchEntry';
import { DossierBody } from '../../../_components/DossierBody';
import {
  ConfirmButton,
  DisclosureList,
  ModuleCard,
  OrderQuote,
  OrderSummary,
  ProbeCard,
} from '../OrderQuote';

const ssr = (node: React.ReactNode) => renderToStaticMarkup(<>{node}</>);
const visibleText = (html: string) => html.replace(/<[^>]+>/g, '');

const itemOf = (module: DossierModule): DossierQuoteItem =>
  mockQuote.items.find((it) => it.module === module)!;
const cardOf = (module: DossierModule) => MODULE_CATALOG.find((c) => c.module === module)!;

function renderModule(
  module: DossierModule,
  opts: {
    quote?: DossierQuote;
    probeOverride?: Partial<NonNullable<ProbeResult['payload']>> | null;
    deepBlocked?: string | null;
    item?: DossierQuoteItem | null;
  } = {},
): string {
  const quote = opts.quote ?? mockQuote;
  const payload =
    opts.probeOverride === null
      ? null
      : { ...mockProbe.payload!, ...(opts.probeOverride ?? {}) };
  return ssr(
    <ModuleCard
      card={cardOf(module)}
      item={opts.item === undefined ? itemOf(module) : opts.item}
      quote={quote}
      availability={moduleAvailability(module, payload, opts.deepBlocked ?? null)}
      dependencyNote={null}
      checked={false}
      onToggle={() => {}}
    />,
  );
}

/* ── 探测卡 ───────────────────────────────────────────── */

describe('免费探测卡：命中出四个数，降级一个数都不出', () => {
  /**
   * 变异臂：给 ProbeCard 的降级分支编一份全 0 的 payload（"反正也是没有"），这条会红。
   * 那正是这条端点花力气区分的两件事——「这一刻没去查」与「查无此公司」——
   * 在界面上被抹成同一个样子。
   */
  it('no_collector 降级：逐字渲染服务端那句话，屏幕上没有任何公司侧的计数', () => {
    const degraded: ProbeResult = {
      company_key: 'name:x',
      status: 'no_collector',
      cache_state: 'none',
      quota_left: 2,
      reason:
        '这家公司 24 小时内没有探测缓存，需要外勤工作站在线采集一次；本次未接入采集器，' +
        '无法即时出数——**这不是「查无此公司」，是「这一刻没去查」**。稍后缓存到货即可秒出。',
    };
    const text = visibleText(ssr(<ProbeCard probe={degraded} />));
    expect(text).toContain(degraded.reason!);
    expect(text).not.toContain('关联主体');
    expect(text).not.toContain('涉诉记录');
  });

  it('quota_exhausted 降级：同样只有那句话，且照实说今日还剩 0 次', () => {
    const exhausted: ProbeResult = {
      company_key: 'name:x',
      status: 'quota_exhausted',
      cache_state: 'none',
      quota_left: 0,
      reason: '今日免费探测已用完（每日 2 次），且这家公司 24 小时内没有可复用的探测缓存。',
    };
    const text = visibleText(ssr(<ProbeCard probe={exhausted} />));
    expect(text).toContain('今日免费探测已用完');
    expect(text).toContain('0');
    expect(text).not.toContain('工商状态');
  });

  /** as_of 是硬门槛：四个数字没有采集时点就是四个悬浮的数。 */
  it('命中时四个数与采集时点同屏，且写明这一步不扣费', () => {
    const text = visibleText(ssr(<ProbeCard probe={mockProbe} />));
    for (const label of ['关联主体', '涉诉记录', '其中劳动争议', '其中有公开文书链接']) {
      expect(text).toContain(label);
    }
    expect(text).toContain('数据截至');
    expect(text).toContain('不扣费');
  });
});

/* ── 模块卡：置灰与披露 ───────────────────────────────── */

describe('不可售的模块置灰、给原因句、且一个价都不出', () => {
  /**
   * 变异臂（任一条都让本组变红）：
   *   · ModuleCard 里把 `!availability.sellable` 这一支删掉（置灰形同虚设，照常可勾可买）；
   *   · 置灰分支里把 reason 换成「暂不可售」四个字（原因句没了）；
   *   · 置灰分支里把价也印出来（一个买不到的东西标着价）。
   */
  it('关联主体 0 个 ⇒ 关联谱系置灰、带那个 0、不出价、勾不上', () => {
    const html = renderModule('graph', { probeOverride: { relation_count: 0 } });
    expect(html).toContain('data-sellable="false"');
    const text = visibleText(html);
    expect(text).toContain('0 个');
    expect(text).toContain('暂不可售');
    // 服务端确实为这一块报了 200，但它买不到，所以屏幕上不许出现这个价
    expect(itemOf('graph').gongdao).toBe(200);
    expect(text).not.toContain('200');
    expect(html).not.toContain('data-slot="checkbox"');
  });

  it('深度两块被服务端判为够不着门槛 ⇒ 用服务端那句原话置灰，不自己复述门槛', () => {
    const serverSays =
      '涉诉深度统计与人事套路归纳暂不可售：该主体有公开文书链接的劳动争议为 2 篇，低于可售门槛 5 篇。';
    const html = renderModule('docs_stats', {
      probeOverride: { doc_url_count: 2 },
      deepBlocked: serverSays,
      item: null,
    });
    expect(visibleText(html)).toContain(serverSays);
    expect(html).toContain('data-sellable="false"');
  });

  it('可售却没有报价行（不该出现的组合）：说得出是什么、为什么、怎么办，不是一片空白', () => {
    const html = renderModule('entity', { item: null });
    const text = visibleText(html);
    expect(text).toContain('没有报出价来');
    expect(text).toContain('重新查一次');
  });
});

describe('可售的模块：口径 / 算式 / 时延 / 退款四样在扣费前就摊开', () => {
  /**
   * 变异臂：把 ModuleCard 里 `{d.formula}` 那一段删掉（只剩一个黑盒总数），
   * 或把 refundPromise 那一段删掉（退款承诺挪到付款之后再说），这一组会红。
   */
  it('按篇计价那块：算式、工作日上限、真人取证说明、退款承诺一样不少', () => {
    const text = visibleText(renderModule('docs_stats'));
    expect(text).toContain('9 篇 × 70 = 630');
    expect(text).toContain('按篇计价');
    expect(text).toContain(`最长 ${mockQuote.litigationSlaDays} 个工作日`);
    expect(text).toContain('真人登录裁判文书网取证');
    expect(text).toContain('全额退还');
  });

  it('起价那块的算式不印算不通的项（未超基线篇数时不挂那个负增量）', () => {
    const text = visibleText(renderModule('patterns'));
    expect(text).toContain('240 起（含前 20 篇，本次 9 篇）= 240');
    expect(text).not.toContain('−20)×4');
  });

  it('核心块不挂工作日上限（给秒级出货的块编一个时延承诺就是编承诺）', () => {
    const text = visibleText(renderModule('entity'));
    expect(text).toContain('几分钟内出');
    expect(text).not.toContain('工作日');
  });

  it('免费那块照样摊开口径，不含糊成"赠品"', () => {
    const text = visibleText(renderModule('venue'));
    expect(text).toContain('0 公道值');
    expect(text).toContain('信任锚');
  });
});

/* ── 扣费前的那几句 ───────────────────────────────────── */

describe('扣费前的诚实红线在屏幕上，不折叠', () => {
  /**
   * 变异臂：把 DisclosureList 换成 <details><summary>…</summary>，这条会红——
   * 它就不在"不点开就能读到"的那份文字里了。
   */
  it('三句常驻且都不在折叠块里', () => {
    const html = ssr(<DisclosureList lines={preChargeDisclosures(mockQuote, 9)} />);
    expect(html).not.toContain('<details');
    const text = visibleText(html);
    expect(text).toContain('分开买');
    expect(text).toContain(`最长 ${mockQuote.litigationSlaDays} 个工作日`);
    expect(text).toContain('自动全额退还该模块费用');
  });

  it('探测到的篇数超过计费上限时，多出「超出的不入档、不处理、不收费」那一句', () => {
    const text = visibleText(
      ssr(<DisclosureList lines={preChargeDisclosures(mockQuote, mockQuote.billableDocs + 7)} />),
    );
    expect(text).toContain('不入档、不处理、也不收费');
  });
});

/* ── 合计与余额 ───────────────────────────────────────── */

describe('合计与余额对照', () => {
  const core: DossierModule[] = ['venue', 'entity', 'graph', 'docs_list'];

  /**
   * 变异臂：把 OrderSummary 的 shortfall 那一段删掉，这条会红——
   * 用户会点一个必然失败的按钮，然后自己去猜是不是钱不够。
   */
  it('余额不够时给出缺口与两条出路（充值 / 少勾几块）', () => {
    const poor: DossierQuote = { ...mockQuote, balance: 100 };
    const summary = summarizeSelection(poor, core);
    const html = ssr(<OrderSummary summary={summary} quote={poor} />);
    expect(html).toContain('data-testid="shortfall-note"');
    const text = visibleText(html);
    expect(text).toContain(String(summary.shortfall));
    expect(text).toContain('充值');
    expect(text).toContain('分开买');
  });

  /**
   * 变异臂：把 intakeAtRisk 那一段改成 `disabled` 掉确认按钮，这条仍绿但
   * OrderQuote 的按钮判据会变——所以这里同时钉住"黄条出现"与"不是拦截"两件事：
   * 守护是提醒顺序，不是替用户决定钱该怎么花。
   */
  it('赠送额守护出黄条，但缺口仍为 0（不阻断下单）', () => {
    const tight: DossierQuote = { ...mockQuote, balance: 400 };
    const summary = summarizeSelection(tight, core);
    expect(summary.shortfall).toBe(0);
    const html = ssr(<OrderSummary summary={summary} quote={tight} />);
    expect(html).toContain('data-testid="intake-reserve-note"');
    expect(visibleText(html)).toContain(String(summary.intakeReserve));
  });

  /**
   * 确认按钮的四个失效条件里，只有 `stale`（报价是上一家的）在界面上看不出异样：
   * 那条黄色提示照常显示，按钮只是从灰变成可点。**本仓 2026-08-31 实测**：
   * 把 `stale` 从 disabled 里删掉，2656 条测试全绿。这条与 lib 侧 isQuoteStale 的
   * 直接断言是补上的那颗牙——一条量"判定算得对不对"，一条量"判定有没有接到按钮上"。
   *
   * 变异臂：ConfirmButton 的 disabled 里去掉 `stale`，本条会红。
   */
  it('报价是上一家的 ⇒ 确认按钮点不动；不过期且钱够 ⇒ 点得动', () => {
    const summary = summarizeSelection(mockQuote, core);
    expect(summary.shortfall).toBe(0);
    expect(summary.modules.length).toBeGreaterThan(0);

    // 断言的是 **disabled 属性**，不是字符串「disabled」——那三个字母也出现在
    // `disabled:opacity-45` 这类 class 里，按子串判会两边都绿（判据看着在、其实恒真）。
    const isDisabled = (html: string) => /<button[^>]*\sdisabled(?:=""|[\s>])/.test(html);

    const staleHtml = ssr(
      <ConfirmButton busy={false} stale summary={summary} onConfirm={() => {}} />,
    );
    expect(staleHtml).toContain('data-testid="confirm-charge"');
    expect(isDisabled(staleHtml)).toBe(true);

    const freshHtml = ssr(
      <ConfirmButton busy={false} stale={false} summary={summary} onConfirm={() => {}} />,
    );
    expect(isDisabled(freshHtml)).toBe(false);
  });

  it('核心小计与深度小计分开摆，不合成一个说不清构成的总数', () => {
    const summary = summarizeSelection(mockQuote, MODULE_CATALOG.map((c) => c.module));
    const text = visibleText(ssr(<OrderSummary summary={summary} quote={mockQuote} />));
    expect(text).toContain('核心四块小计');
    expect(text).toContain('深度两块小计');
    expect(text).toContain(String(summary.payableGongdao));
  });
});

/* ── 一键加守望 ───────────────────────────────────────── */

describe('一键加守望：三档在点之前摊开，低调模式不露那三个词', () => {
  const NEVER = ['监控', '守望', '公司'];

  /**
   * 变异臂：把任一档说明写成早先图例那套含「监控」的说法（「圈1·每日监控」），这条会红。
   * （图例那套本身也已经不含这三个词了，判据见 graph/_components/__tests__/tier-labels。）
   * 一封写着「某某公司的守望监控」的东西被工位旁人瞟见，暴露的是他正在准备什么——
   * 口径同 lib/notify/copy 的守望计费通知。
   */
  it('低调模式下，整块入口文字里没有「监控 / 守望 / 公司」', () => {
    state.discreet = true;
    try {
      const collapsed = visibleText(ssr(<WatchEntry caseId="demo" name="星曜网络科技（北京）有限公司" />));
      for (const word of NEVER) expect(collapsed).not.toContain(word);
      // 收起态是个按钮，展开态才是三档；两态都要干净
      expect(collapsed).toContain('关注');
    } finally {
      state.discreet = false;
    }
  });

  /**
   * 三档说明两种模式**同一句**（一句话两个版本，漂了没有任何一处会报错），
   * 所以这里在明文模式下断言，结论对低调模式同样成立。
   * 价来自 WATCH_TIER_GONGDAO——界面不写死 199/60/0，改价改那一处。
   */
  it('三档与月费都在，且逐字取自价目表', () => {
    const html = ssr(<WatchTierPicker tier="daily" onPick={() => {}} />);
    const text = visibleText(html);
    expect(html).toContain('data-testid="watch-tiers"');
    for (const t of TIER_ORDER) {
      expect(text).toContain(`${WATCH_TIER_GONGDAO[t]} 额度/月`);
    }
    expect(TIER_ORDER.map((t) => WATCH_TIER_GONGDAO[t])).toEqual([199, 60, 0]);
    for (const word of NEVER) expect(text).not.toContain(word);
  });

  it('三档说明里不出现「圈1/圈2/圈3」那套图例词（那套里带着「监控」）', () => {
    const text = visibleText(ssr(<WatchTierPicker tier="daily" onPick={() => {}} />));
    for (const legend of ['圈1', '圈2', '圈3']) expect(text).not.toContain(legend);
  });

  it('主体名字不进入口的可见文字（它在抽屉/档案页各自的打码块里已经出现过一次）', () => {
    const text = visibleText(ssr(<WatchEntry caseId="demo" name="星曜网络科技（北京）有限公司" />));
    expect(text).not.toContain('星曜');
  });
});

/* ── 整页（demo 态）────────────────────────────────────── */

describe('整页拼起来：探测卡 + 六张模块卡 + 四句 + 合计，一屏都在', () => {
  /**
   * 上面那些都是单个组件的判据；这一条测的是**页面把它们拼对了没有**——
   * 六块少渲染一块、合计块忘了挂、四句被漏在某个分支外面，单组件测试一条都不会红。
   * demo 态走 mock（不发请求），所以 SSR 拿得到完整的一屏。
   */
  const html = () => ssr(<OrderQuote caseId="demo" />);

  it('六个模块卡一个不少，且顺序是核心四项在前', () => {
    const out = html();
    for (const card of MODULE_CATALOG) {
      expect(out).toContain(`data-testid="module-card-${card.module}"`);
    }
    const at = (m: DossierModule) => out.indexOf(`data-testid="module-card-${m}"`);
    expect(at('docs_list')).toBeLessThan(at('docs_stats'));
    expect(at('docs_stats')).toBeLessThan(at('patterns'));
  });

  it('探测卡、扣费前四句、合计块都在，且四句排在确认按钮之前', () => {
    const out = html();
    for (const id of ['probe-card', 'pre-charge-disclosures', 'order-summary']) {
      expect(out).toContain(`data-testid="${id}"`);
    }
    expect(out.indexOf('data-testid="pre-charge-disclosures"')).toBeLessThan(
      out.indexOf('确认并扣费'),
    );
  });

  it('页面上没有一处「已扣」之类的说法（这一页零扣费）', () => {
    const text = visibleText(html());
    expect(text).toContain('不扣任何公道值');
    expect(text).not.toContain('已扣');
  });

  it('公司全名不进 h1（低调模式红线：顶栏最容易被旁人瞥见）', () => {
    state.discreet = true;
    try {
      const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/.exec(html())?.[1] ?? '';
      expect(visibleText(h1)).not.toContain('星曜');
    } finally {
      state.discreet = false;
    }
  });
});

/* ── 393 宽零横溢 ─────────────────────────────────────── */

describe('393 宽（移动端基准）没有写死过宽的盒子', () => {
  /**
   * 这把尺子量的是"有没有人写死一个宽于 393 的盒子"，**不是**真实布局
   * （没有浏览器就没有排版引擎，长串不换行、表格自然宽度这类它量不到，见
   * lib/ui/viewport393.ts 文件头）。尺子自己的体检在 lib/ui/__tests__/viewport393.test.ts：
   * 造一个 520px 的盒子必须被抓到——否则这一组的绿只是"尺子坏了"。
   *
   * 变异臂：给下面任一组件加一个 `min-w-[420px]`，这一组会红并点名那条声明。
   *
   * NodeSheet 不在这份名单里，是因为它整棵树在 Radix 的 Portal 后面、SSR 出不来
   * （渲染出空串）——把一个恒空的串喂给量尺，得到的绿是假的。它新增的那一块
   * （WatchEntry）在名单里单独量。
   */
  const cases: [string, React.ReactNode][] = [
    ['探测卡·命中', <ProbeCard key="a" probe={mockProbe} />],
    [
      '探测卡·降级',
      <ProbeCard
        key="b"
        probe={{
          company_key: 'name:x',
          status: 'no_collector',
          cache_state: 'none',
          quota_left: 2,
          reason: '这家公司 24 小时内没有探测缓存，需要外勤工作站在线采集一次。',
        }}
      />,
    ],
    ['扣费前四句', <DisclosureList key="c" lines={preChargeDisclosures(mockQuote, 40)} />],
    [
      '合计（余额不足态）',
      <OrderSummary
        key="d"
        quote={{ ...mockQuote, balance: 100 }}
        summary={summarizeSelection({ ...mockQuote, balance: 100 }, ['venue', 'entity'])}
      />,
    ],
    ['一键加守望入口', <WatchEntry key="e" caseId="demo" name="某某科技有限公司" />],
    ['一键加守望三档', <WatchTierPicker key="e2" tier="daily" onPick={() => {}} />],
    ['档案页正文', <DossierBody key="f" caseId="demo" dossier={mockDossier} />],
    ['报价整页（demo 态）', <OrderQuote key="g" caseId="demo" />],
  ];

  for (const [label, node] of cases) {
    it(`${label}：零横溢`, () => {
      const found = findWideElements(ssr(node));
      expect(describeWideElements(found)).toBe('');
    });
  }

  it('六个模块卡（可售态与置灰态）都零横溢', () => {
    for (const card of MODULE_CATALOG) {
      const sellable = findWideElements(renderModule(card.module));
      expect(`${card.module}:${describeWideElements(sellable)}`).toBe(`${card.module}:`);
      const greyed = findWideElements(
        renderModule(card.module, { probeOverride: null, item: null, deepBlocked: '这一块暂不可售。' }),
      );
      expect(`${card.module}:${describeWideElements(greyed)}`).toBe(`${card.module}:`);
    }
  });
});
