// 驾驶舱按案件所属领域渲染（设计稿 §13「网页」行、§16 并行轨）。
//
// ─────────────── 这组守的是什么 ───────────────
// 驾驶舱上有两处是**按领域变**的：顶上那条轨道的格子，和「当前轨」那一行。
// 两处的坏法都不出错、也不空白，而是**印着另一个行当的话**：
//   · 轨道格子写死一份 ⇒ 第二个领域的用户看到八个与自己无关的格子，一格都不亮，
//     页面看起来只是「还没开始走」；
//   · 「当前轨」那一行恒出 ⇒ 没有并行轨的领域每次都白摆一行「当前轨：无」，
//     而用户会以为这里本该有点什么；
//   · 那一行恒说「还没有记录」⇒ cases.track 已经有值了它也照说，
//     于是一个正在危机处置轨上的案子在屏幕上显示为"只在主线"。
// 三种都不会让任何既有判据变红——既有判据只认「这一屏能不能画出来」。
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/app/_ui/discreet', () => ({
  useDiscreet: () => ({ discreet: false, toggle: () => {} }),
  DocumentTitle: () => null,
}));
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

const { DashboardBody } = await import('../Dashboard');
type DashboardData = Awaited<ReturnType<typeof import('../dashboardData').fetchDashboard>>;
const { DOMAINS } = await import('@/lib/domains/registry');
const { journeyOf } = await import('@/app/_ui/domain');

const ssr = (node: React.ReactNode) => renderToStaticMarkup(<>{node}</>);
const text = (html: string) => html.replace(/<[^>]+>/g, '');

const dataFor = (domain: string, track: string | null = null): DashboardData => ({
  domain,
  track,
  actions: [],
  deadlines: [],
  attainments: [],
  records: [],
  // 空态那一屏不画轨道，所以这里必须不是空案件
  timelineCount: 3,
});

describe.each(Object.keys(DOMAINS))('%s 的驾驶舱', (key) => {
  const pack = DOMAINS[key];

  it('轨道格子是这个领域的那几格（变异：把 journeyOf(data.domain) 换成写死一份 → 红）', () => {
    const out = text(ssr(<DashboardBody caseId="7" data={dataFor(key)} />));
    for (const cell of journeyOf(key)) {
      expect(out, `轨道上没有「${cell}」这一格`).toContain(cell);
    }
  });

  it('轨道上不出现别的领域**独有**的格子（串味的形态是每一格都对、只是不是这个人的事）', () => {
    const out = text(ssr(<DashboardBody caseId="7" data={dataFor(key)} />));
    const mine = journeyOf(key);
    for (const [otherKey] of Object.entries(DOMAINS)) {
      if (otherKey === key) continue;
      for (const cell of journeyOf(otherKey)) {
        // 【跳过两种】① 两个领域本来就共用的那一格；② 别人那一格是我这边某一格的**子串**
        //（labor 的「协商」之于 counseling 的「协商（退费/和解）」）——含不含它是恒真的，
        // 按子串问只会得到一个永远红或永远绿的答案，两种都没在验串味。
        if (mine.some((m) => m.includes(cell))) continue;
        expect(out, `轨道上混进了 ${otherKey} 的「${cell}」`).not.toContain(cell);
      }
    }
  });

  it('并行轨那一行：本领域没有并行轨就整行不渲染，有就把轨名逐条摆出来', () => {
    const html = ssr(<DashboardBody caseId="7" data={dataFor(key)} />);
    if (pack.tracks.length === 0) {
      expect(html, '没有并行轨的领域摆出了「当前轨」那一行').not.toContain('aria-label="并行轨"');
      expect(text(html)).not.toContain('当前轨');
      return;
    }
    expect(html).toContain('aria-label="并行轨"');
    const out = text(html);
    for (const t of pack.tracks) expect(out, `没列出并行轨「${t}」`).toContain(t);
  });

  it('在轨与主线是两句不同的话（变异：把 track 这个入参丢掉、恒说主线 → 红）', () => {
    if (pack.tracks.length === 0) return;
    const on = pack.tracks[0];
    const onTrack = text(ssr(<DashboardBody caseId="7" data={dataFor(key, on)} />));
    const mainline = text(ssr(<DashboardBody caseId="7" data={dataFor(key, null)} />));
    // 在轨那一屏说得出自己在哪一轨，并且说清主线没有被顶掉
    expect(onTrack).toContain(`当前轨：${on}`);
    expect(onTrack).toContain('主线');
    // 主线那一屏不许印出某一条具体的轨名当成"当前在这一轨"
    expect(mainline).toContain('当前轨：主线');
    expect(onTrack).not.toBe(mainline);
  });
});
