/**
 * 期限瓦片催办角标的**布局预留**守卫。
 *
 * 【守的是什么】角标是 `position: absolute` + `-top-5`，脱离文档流探出瓦片上沿 20px。
 * 脱离文档流的东西不占位置，它压到谁头上取决于上面那一段今天有多高——
 * 组件里原本就自注过一句「今天底下恰好没有可点元素，但**那是运气不是设计**」。
 * 现在改成：有角标时 section 自己把这 20px 让出来（`mt-9` 而不是 `mt-4`）。
 *
 * 【为什么不是断言两个类名】钉死 `mt-9` / `-top-5` 两个字符串的话，谁把角标挪高到
 * `-top-8` 而没动 mt，测试照样全绿——**它守的是拼写，不是那个减法**。
 * 所以这里从渲染结果里把两个数字**现算**出来，守的是不等式：
 *   预留 − 探出 ≥ 无角标时的间距（即：角标上沿到上一区块，不比没有角标时更近）。
 *
 * 【为什么这条只能靠 SSR 文本】vitest 跑在 node 环境、没有布局引擎，量不到真实像素；
 * 但 Tailwind 的间距是 `n × 0.25rem` 的定值，从类名反算出来的 px 与浏览器一致。
 * 反算的前提写死在 PX_PER_UNIT 上，spacing 尺度若被改，这条会算错——
 * 所以下面有一条正对照钉着「无角标时确实是 16px」。
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// Mascot 自己要 useDiscreet；SSR 下没有 Provider，顶成「低调关」，角标才会渲染出来
vi.mock('@/app/_ui/discreet', () => ({
  useDiscreet: () => ({ discreet: false, toggle: () => {} }),
}));

import type { Deadline } from '@/app/_mock/types';
import { DeadlineTiles } from '../DeadlineTiles';

/** Tailwind 间距刻度：`mt-9` = 9 × 0.25rem = 36px（根字号 16px） */
const PX_PER_UNIT = 4;

const NOW = new Date('2026-08-29T10:00:00+08:00');
const day = (n: number) =>
  new Date(NOW.getTime() + n * 86_400_000).toISOString();

const deadline = (id: string, days: number): Deadline => ({
  id,
  caseId: 'demo',
  kind: '自定义',
  title: `期限 ${id}`,
  dueAt: day(days),
  derivedFrom: '测试夹具',
});

/** ≤3 天 ⇒ 会挂角标；两张卡，最急的那张才有 */
const URGENT = [deadline('a', 2), deadline('b', 40)];
/** 全都远在天边 ⇒ 一个角标也没有 */
const CALM = [deadline('a', 40), deadline('b', 90)];

const render = (deadlines: Deadline[]) =>
  renderToStaticMarkup(<DeadlineTiles deadlines={deadlines} now={NOW} />);

/** 取 `<section aria-label="期限倒计时">` 那一层的 class */
function sectionClass(html: string): string {
  const m = /<section[^>]*aria-label="期限倒计时"[^>]*>/.exec(html);
  return m ? (/class="([^"]*)"/.exec(m[0])?.[1] ?? '') : '';
}

/** 从一串 class 里取 `mt-N` 的 N（换算成 px）；没有或有多条都返回 null */
function marginTopPx(cls: string): number | null {
  const hits = [...cls.matchAll(/(?:^|\s)mt-(\d+)(?=\s|$)/g)];
  return hits.length === 1 ? Number(hits[0][1]) * PX_PER_UNIT : null;
}

/** 角标 img 们的 `-top-N`（换算成 px，正数表示探出多少） */
function badgeOverhangsPx(html: string): number[] {
  return [...html.matchAll(/<img[^>]*class="([^"]*)"[^>]*>/g)]
    .map((m) => /(?:^|\s)-top-(\d+)(?=\s|$)/.exec(m[1]))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => Number(m[1]) * PX_PER_UNIT);
}

describe('夹具自检：这两组夹具确实分别渲染出「有角标」和「没角标」', () => {
  // 【为什么先要这两条】下面的不等式只在真有角标时才有意义。角标要是压根没渲染，
  // `badgeOverhangsPx` 返回空数组，不等式退化成恒真——**守卫看起来在守，其实在守空气**。
  // （同 dashboard-discreet 那次：空样本上的否定断言什么也没守。）
  it('有紧急期限时，恰好一个角标', () => {
    const n = badgeOverhangsPx(render(URGENT)).length;
    expect(
      n,
      `缺什么：URGENT 夹具没渲染出恰好一个催办角标（实际 ${n} 个）。\n` +
        `为什么缺：0 个＝角标被删、或 URGENT_DAYS 阈值改了让 2 天不再算紧急、` +
        `或 Mascot 被低调模式收走（本文件已把 useDiscreet 顶成低调关）；` +
        `>1 个＝「只给最急那张挂」的规则丢了。\n` +
        `怎么办：先看是规则变了还是夹具过时了。这条不红，下面的预留不等式就是在空样本上恒真。`,
    ).toBe(1);
  });

  it('没有紧急期限时，一个角标也没有', () => {
    expect(badgeOverhangsPx(render(CALM))).toEqual([]);
  });

  it('无角标时的上间距是 16px（PX_PER_UNIT 换算的正对照）', () => {
    const px = marginTopPx(sectionClass(render(CALM)));
    expect(
      px,
      `缺什么：无角标时 section 的上间距不是 16px（读到 ${px}）。\n` +
        `为什么缺：要么 mt 类被改/被写成了两条（本函数只认恰好一条 mt-N），` +
        `要么 Tailwind 的 spacing 刻度不再是 0.25rem——那样本文件 PX_PER_UNIT 的换算全错，` +
        `下面的不等式会拿一堆错数字比大小，结论不可信。\n` +
        `怎么办：确认 DeadlineTiles 的 section 只有一条 mt-N；若真改了 spacing 刻度，` +
        `同步改本文件的 PX_PER_UNIT。`,
    ).toBe(16);
  });
});

describe('🔴 角标探出多少，section 就得多留多少', () => {
  it('预留 − 探出 ≥ 无角标时的间距', () => {
    const baseline = marginTopPx(sectionClass(render(CALM)));
    const reserved = marginTopPx(sectionClass(render(URGENT)));
    const overhang = Math.max(...badgeOverhangsPx(render(URGENT)));
    const gap = (reserved ?? 0) - overhang;
    expect(
      gap,
      `缺什么：有角标时角标上沿到上一区块只剩 ${gap}px，比无角标时的 ${baseline}px 还窄。\n` +
        `　　section 预留 ${reserved}px，角标探出 ${overhang}px。\n` +
        `为什么缺：角标是绝对定位、不占文档流，它探出瓦片上沿的那一截**没有任何人替它留位置**，` +
        `于是直接压在上一个区块（驾驶舱里是「其余 N 件排在后面」那行字，里面带一个「问它」链接）身上。` +
        `今天压没压到可点元素靠的是上面那段文字当天的高度——那是运气不是设计。\n` +
        `怎么办：两条路二选一。` +
        `①（默认）把 DeadlineTiles 的 section 上间距调大到「探出量 + ${baseline}px」；` +
        `② 或者把角标改成不脱离文档流的形态（不再用 absolute + 负 top），那时本条自然成立。` +
        `别只改角标的 -top 不改 section 的 mt——这条守的就是那个减法。`,
    ).toBeGreaterThanOrEqual(baseline ?? 0);
  });
});
