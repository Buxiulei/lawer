/**
 * 里程碑「跳过」态的**渲染**守卫。
 *
 * 【为什么单开这一条】`milestones.test.ts` 把四态的**推导**钉得很死，但它只看 `deriveTrack`
 * 返回的对象。而全站唯一渲染 `MilestoneTrack` 的地方（驾驶舱）喂的是 demo 种子，
 * demo 只达成「协商」一格 —— **「跳过」这一态在任何路由上都渲染不出来**。
 * 于是 `Dot` 里那行 `state === '跳过' && 'border-line bg-line'`、
 * 以及那对 `未经 / 未经此步` 的断点文案，谁改坏了都没有任何红：
 * 推导测试照样绿（它不渲染），肉眼也看不见（页面上没有这一格）。
 *
 * 【夹具怎么来的】按 P-11 的处方：**demo 种子 + 一条更靠后的达成事件**。
 * 补一条「立案」就让「仲裁申请」落进跳过分支，一次渲染同时拿到四态，
 * 于是圆点样式可以两两比对，而不是去钉某个类名的拼写。
 *
 * 【为什么不把这条事件写进 demo 本身】写进去，驾驶舱就会显示「仲裁申请 · 未经此步 /
 * 立案 · 完成」，而同一屏上的行动卡还写着「整理仲裁申请书」、期限卡还在倒数「申请劳动仲裁
 * 的一年时效」、案件 stage 仍是「已收通知」—— 那是一个自相矛盾的演示案件，
 * 等于用假进度换测试覆盖。demo 案件真的没有跳过任何一步，让它照实说。
 * 覆盖由这份夹具承担；**路由上仍渲染不出跳过态这件事，是产品事实，不是缺口**。
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { MilestoneTrack } from '../MilestoneTrack';
import {
  FULL_JOURNEY,
  demoAttainments,
  deriveTrack,
  type Attainment,
  type TrackState,
} from '../milestones';

const SEED_EMPTY =
  `缺什么：demoAttainments() 返回空数组，这份夹具造不出来。\n` +
  `为什么缺：demo 时间轴里那条构成达成的事件（te_4 收到解除通知）被删了/改了 id，` +
  `或 milestones.ts 的 DEMO_ATTAINED_BY_EVENT 映射没了。\n` +
  `怎么办：先看 DEMO_ATTAINED_BY_EVENT 与 _mock/demo.ts 的事件 id 对不对得上。` +
  `种子为空时「比最靠后那条再晚十天」无从算起，本文件所有断言都不可信。`;

/**
 * 夹具**惰性**构造，不放模块顶层。
 * 【为什么】顶层构造在种子为空时会当场抛（`Math.max()` 得 -Infinity ⇒ `new Date(...)`
 * `.toISOString()` 抛 RangeError），于是**收集阶段**就炸，整个文件 0 条测试跑不起来 ——
 * 下面那条夹具自检连同它的三段式文案一次也不执行。变异实测过：把 DEMO_ATTAINED_BY_EVENT
 * 清空，顶层版本给的是 `no tests`，惰性版本给的是自检那条红 + 它写好的说明。
 * （同 `lib/evidence/__tests__/caddy-upload-routes.test.ts` 第 42 行那条的教训。）
 */
type Fixture = {
  seed: Attainment[];
  later: string;
  states: TrackState[];
  cells: string[];
};
let cached: Fixture | null = null;
function fixture(): Fixture {
  if (cached === null) {
    const seed = demoAttainments();
    if (seed.length === 0) throw new Error(SEED_EMPTY);
    // 比种子里最靠后的那条再晚 10 天。「更靠后」是全部要求，不写死日期
    const later = new Date(
      Math.max(...seed.map((e) => new Date(e.happenedAt).getTime())) + 10 * 86_400_000,
    ).toISOString();
    // demo 种子 + 一条更靠后的「立案」⇒「仲裁申请」落进跳过分支
    const withSkip: Attainment[] = [...seed, { milestone: '立案', happenedAt: later }];
    cached = {
      seed,
      later,
      states: deriveTrack(FULL_JOURNEY, withSkip).map((c) => c.state),
      cells: cellsOf(
        renderToStaticMarkup(<MilestoneTrack track={FULL_JOURNEY} attainments={withSkip} />),
      ),
    };
  }
  return cached;
}

/** 按 `<li>` 切成一格一格；格内没有嵌套 li，切得干净 */
function cellsOf(html: string): string[] {
  return html.split(/(?=<li\b)/).filter((s) => s.startsWith('<li'));
}

/** 一格里那颗圆点的 class（它是格内唯一带 rounded-full 的元素） */
function dotClassOf(cell: string): string | null {
  for (const m of cell.matchAll(/<span[^>]*class="([^"]*)"/g)) {
    if (m[1].includes('rounded-full')) return m[1];
  }
  return null;
}

/**
 * 一格里**判据行**的纯文字。判据行是格内最后一个 span（class 带 `num`），
 * 从它的起始标签一直取到 `</li>`，再把标签剥掉。
 */
function judgeTextOf(cell: string): string | null {
  const m = /<span[^>]*class="[^"]*\bnum\b[^"]*"[^>]*>/.exec(cell);
  if (!m) return null;
  return cell.slice(m.index).replace(/<[^>]*>/g, '').trim();
}

/** 取某一态第一格的 html */
function firstOf(state: TrackState): string {
  const { states, cells } = fixture();
  return cells[states.indexOf(state)];
}

describe('夹具自检：这份夹具确实渲染出了四态', () => {
  // 【为什么先要这几条】下面每一条断言都是"跳过那一格里应该有/不该有什么"。
  // 夹具一旦不再产生跳过格，`states.indexOf('跳过')` 得到 -1、取到 undefined，
  // 断言要么恒真要么以看不懂的形态红 —— **守卫看起来在守，其实在守空气**
  // （同 dashboard-discreet 那次：空样本上的否定断言什么也没守）。
  it('demo 种子非空，且补出来的那条事件确实更靠后', () => {
    expect(demoAttainments().length, SEED_EMPTY).toBeGreaterThan(0);
    const { seed, later } = fixture();
    for (const e of seed) expect(later > e.happenedAt).toBe(true);
  });

  it('四态在这一次渲染里各出现至少一格', () => {
    const { states, cells } = fixture();
    const missing = (['完成', '跳过', '进行中', '未到'] as const).filter(
      (s) => !states.includes(s),
    );
    expect(
      missing.join(' / ') || '(无)',
      `缺什么：这份夹具没渲染出这些态：${missing.join(' / ')}（实际一行是 ${states.join(' ')}）。\n` +
        `为什么缺：deriveTrack 的分界改了（比如跳过被并进未到），或 FULL_JOURNEY 变短、` +
        `或补的那条「立案」不再让「仲裁申请」落进跳过分支。\n` +
        `怎么办：先跑 milestones.test.ts —— 那组盯的是推导本身。若推导是对的，` +
        `就是本文件的夹具过时了，换一条能造出缺口的达成事件。`,
    ).toBe('(无)');
    expect(cells).toHaveLength(FULL_JOURNEY.length);
  });
});

describe('🔴 跳过态必须在渲染里认得出来', () => {
  it('跳过格写着「未经 / 未经此步」，两个断点各一份', () => {
    const cell = firstOf('跳过');
    // 窄屏用「未经」、≥sm 用「未经此步」：两份都在 DOM 里，靠断点类切换显示
    expect(
      /<span class="sm:hidden">未经<\/span>/.test(cell) &&
        /<span class="hidden sm:inline">未经此步<\/span>/.test(cell),
      `缺什么：跳过那一格里没有成对的「未经」(sm:hidden) 与「未经此步」(hidden sm:inline)。\n` +
        `实际这一格是：${cell}\n` +
        `为什么缺：这行字是四态**唯一不靠颜色**的判据（色盲、深色模式、截图压缩都不影响它）。` +
        `少了它，跳过和未到在用户眼里就只剩两个灰点的细微差别——「我没走这段」与「后面还没到」` +
        `变成同一个东西。两个断点少一份则是另一种坏法：窄屏挤成两行、或宽屏只剩半个词。\n` +
        `怎么办：看 MilestoneTrack 的 Cell 里判据那一行，把 cell.state === '跳过' 的分支补回来。`,
    ).toBe(true);
  });

  it('跳过与未到的判据行读起来不是同一句话', () => {
    const skip = judgeTextOf(firstOf('跳过'));
    const notYet = judgeTextOf(firstOf('未到'));
    expect(
      `${skip} | ${notYet}`,
      `缺什么：跳过格与未到格的判据行文字相同（跳过：「${skip}」，未到：「${notYet}」）。\n` +
        `为什么缺：这一行是四态**唯一不靠颜色**的判据。两态说同一句话时，` +
        `「我没走这段」和「后面还没到」在用户那里就合并成了一件事 —— 而这正是 P-11 那条` +
        `「跳过并进未到之后照样绿」的老毛病换个层复发：推导分得开，渲染却把它们说成一样。\n` +
        `怎么办：看 MilestoneTrack 的 Cell 里判据那一行，确认 '跳过' 分支只覆盖跳过、` +
        `未到仍留空。（跳过那格**不许带日期**由 milestones.test.ts 在推导层盯，那边已被变异钉过，` +
        `这里不重复断言同一件事。）`,
    ).not.toBe(`${notYet} | ${notYet}`);
    expect(skip).not.toBe('');
    expect(notYet).toBe('');
  });

  it('四态的圆点样式两两不同——跳过不许跟未到长一个样', () => {
    const dots = new Map<TrackState, string | null>();
    for (const s of ['完成', '跳过', '进行中', '未到'] as const) {
      dots.set(s, dotClassOf(firstOf(s)));
    }
    for (const [s, c] of dots) {
      expect(c, `跳过/未到 那格里没找到圆点（state=${s}）——Dot 的 rounded-full 被改了？`).not.toBeNull();
    }
    const seen = new Map<string, TrackState>();
    const collisions: string[] = [];
    for (const [s, c] of dots) {
      const prev = seen.get(c!);
      if (prev) collisions.push(`${prev} 与 ${s}`);
      else seen.set(c!, s);
    }
    expect(
      collisions.join('；') || '(无)',
      `缺什么：这几对状态的圆点样式完全相同：${collisions.join('；')}。\n` +
        `　　跳过：${dots.get('跳过')}\n　　未到：${dots.get('未到')}\n` +
        `为什么缺：圆点是四态的加速识别层（判据仍是底下那行字）。两态共用一套样式时，` +
        `整条轨道上「跳过」就退化成看不见的一档 —— 而这一档正是本产品坚持要显示的东西：` +
        `案子可以走回头路、可以漏掉一段，轨道要如实画出来。\n` +
        `怎么办：看 MilestoneTrack 的 Dot()，把该状态自己的那套边框/底色改回去。`,
    ).toBe('(无)');
  });
});
