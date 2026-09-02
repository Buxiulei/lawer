/**
 * 驾驶舱必须渲染**这个案件的真实数据**，不是演示值、也不是空态。
 *
 * 立这组的由头：这一页此前只有一句 `const seeded = caseId === demoCase.id`，
 * 认的是字面量 demo；真实案件一律 `return <FirstCase/>`。于是名下躺着整套
 * 时间线、行动卡、期限、证据的人打开驾驶舱，看到的是「还没有你的案件」——
 * **页面看起来完全正常**，没有报错、没有空白格，只是他的东西一样都不在。
 * 这是 P0 的第三层：前两层把人送到了对的地址，这一层决定那个地址上有没有东西。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/app/_ui/discreet', () => ({
  useDiscreet: () => ({ discreet: false, toggle: () => {} }),
  DocumentTitle: () => null,
}));
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

/** 接口替身：按路径回预置的行，形状照后端路由的真实响应 */
const responses: Record<string, unknown> = {};
const calls: string[] = [];
vi.mock('@/app/_ui/api', () => ({
  apiFetch: (path: string) => {
    calls.push(path);
    const key = Object.keys(responses).find((k) => path.startsWith(k));
    return key === undefined
      ? Promise.reject(new Error(`测试没给 ${path} 预置响应`))
      : Promise.resolve(responses[key]);
  },
  humanError: (err: unknown) => (err instanceof Error ? err.message : '出错了'),
}));

const { fetchDashboard, demoRecords, isBlank, viewState } = await import('../dashboardData');
const { Dashboard, DashboardBody } = await import('../Dashboard');
const { MilestoneTrack } = await import('../MilestoneTrack');
const { DeadlineTiles } = await import('../DeadlineTiles');
const { RecentRecords } = await import('../RecentRecords');
const { ActionGroup } = await import('@/components/case/ActionCard');
const { FULL_JOURNEY } = await import('../milestones');
const COMPONENTS = join(process.cwd(), 'src/app/(app)/case/[id]/_components');

const ssr = (node: React.ReactNode) => renderToStaticMarkup(<>{node}</>);
const text = (html: string) => html.replace(/<[^>]+>/g, '');

/* 一个"整套数据都有"的真实案件，字段名逐字照后端行 */
function seedResponses() {
  responses['/cases/1?'] = {
    case: { id: 1, title: '我的案件', stage: '已收通知' },
    timeline: [
      {
        id: 91,
        happened_at: '2026-07-24T10:00:00+08:00',
        kind: '公司动作',
        title: '收到《解除劳动合同通知书》',
        detail: null,
        milestone: '协商',
      },
      {
        id: 90,
        happened_at: '2026-07-01T09:00:00+08:00',
        kind: '系统动作',
        title: '档案已建立',
        detail: null,
        milestone: null,
      },
    ],
  };
  responses['/cases/1/actions'] = {
    actions: [
      {
        id: 11,
        case_id: 1,
        title: '去社保中心打参保证明',
        detail: '窗口或线上都行',
        due_at: '2026-09-10T00:00:00+08:00',
        priority: 1,
        status: '待办',
        created_at: '2026-08-01T00:00:00+08:00',
      },
      {
        id: 12,
        case_id: 1,
        title: '把考勤截图导出来',
        detail: '',
        due_at: null,
        priority: 2,
        status: '待办',
        created_at: '2026-08-02T00:00:00+08:00',
      },
    ],
  };
  responses['/cases/1/deadlines'] = {
    deadlines: [
      {
        id: 21,
        case_id: 1,
        kind: '仲裁时效',
        due_at: '2027-07-24T23:59:00+08:00',
        derived_from: '自 2026-07-24 收到解除通知起算一年',
      },
    ],
  };
  responses['/cases/1/evidence'] = {
    evidence: [
      { id: 31, name: '劳动合同扫描件.pdf', status: '已固化', created_at: '2026-08-03T00:00:00+08:00' },
    ],
  };
}

beforeEach(() => {
  for (const k of Object.keys(responses)) delete responses[k];
  calls.length = 0;
  seedResponses();
});

/* ── 一、接口的行确实变成了视图 ─────────────────────────────── */

describe('取数与字段映射', () => {
  it('四条接口都查了，一条都不少', async () => {
    await fetchDashboard('1');
    expect(calls.some((p) => p.startsWith('/cases/1?'))).toBe(true);
    expect(calls).toContain('/cases/1/actions');
    expect(calls).toContain('/cases/1/deadlines');
    expect(calls).toContain('/cases/1/evidence');
  });

  it('时间线要满 200 条——里程碑压在很早的位置时，取少了会静默少一格', async () => {
    await fetchDashboard('1');
    expect(calls.find((p) => p.startsWith('/cases/1?'))).toContain('timeline_limit=200');
  });

  it('行动卡带着标题、期限、优先级过来', async () => {
    const data = await fetchDashboard('1');
    expect(data.actions).toHaveLength(2);
    expect(data.actions[0]).toMatchObject({
      id: '11',
      title: '去社保中心打参保证明',
      dueAt: '2026-09-10T00:00:00+08:00',
      priority: 1,
      status: '待办',
    });
  });

  it('期限用 kind 当卡面标题（库里没有 title 这一列）', async () => {
    const data = await fetchDashboard('1');
    expect(data.deadlines[0]).toMatchObject({ kind: '仲裁时效', title: '仲裁时效' });
  });

  it('带 milestone 的时间线事件变成轨道上的达成点，不带的不算', async () => {
    const data = await fetchDashboard('1');
    expect(data.attainments).toEqual([
      { milestone: '协商', happenedAt: '2026-07-24T10:00:00+08:00' },
    ]);
  });

  it('认不出的里程碑丢掉但要出声，不静默少一格', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    (responses['/cases/1?'] as { timeline: { milestone: string | null }[] }).timeline[0].milestone =
      '和解';
    const data = await fetchDashboard('1');
    expect(data.attainments).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('材料只取证据，不掺演示案件那几份公司文件', async () => {
    const data = await fetchDashboard('1');
    expect(data.records.map((r) => r.name)).toEqual(['劳动合同扫描件.pdf']);
    // 正对照：这几个串确实是演示数据里的原文，不是我随手编的
    const mock = readFileSync(join(process.cwd(), 'src/app/_mock/demo.ts'), 'utf8');
    expect(mock).toContain('星曜网络');
    expect(JSON.stringify(data)).not.toContain('星曜网络');
  });

  it('四块都有东西时不算空案件', async () => {
    expect(isBlank(await fetchDashboard('1'))).toBe(false);
  });

  it('四块全空才算空案件——刚建的档该出建档引导', async () => {
    responses['/cases/1?'] = { case: { id: 1, title: '我的案件', stage: '风声' }, timeline: [] };
    responses['/cases/1/actions'] = { actions: [] };
    responses['/cases/1/deadlines'] = { deadlines: [] };
    responses['/cases/1/evidence'] = { evidence: [] };
    expect(isBlank(await fetchDashboard('1'))).toBe(true);
  });
});

/* ── 一之二、「没取到」与「确实没有」是两回事 ─────────────────── */

/**
 * 这一组是整份改动里最要紧的一条界线。两种情况在屏幕上都是"一片什么都没有"，
 * 但一个该说「再试一次」、另一个该说「去建档」。把前者画成后者，
 * 等于对一个名下有整套记录的人说：你没有案件。
 */
describe('四种屏幕状态', () => {
  const full: Parameters<typeof viewState>[0]['data'] = {
    actions: [],
    deadlines: [],
    attainments: [{ milestone: '协商', happenedAt: '2026-07-24T10:00:00+08:00' }],
    records: [],
    timelineCount: 1,
  };
  const transient = { message: '网络没连上', kind: 'transient' as const };

  it('取数失败 → 报错重试，绝不是空案件', () => {
    expect(viewState({ error: transient, data: null })).toBe('failed');
  });

  it('失败时手里就算还攥着上一次的数据，也照样报错，不拿旧数据盖住', () => {
    expect(viewState({ error: transient, data: full })).toBe('failed');
  });

  it('还没回来 → 骨架，不是空案件（否则每次进页面都闪一句"你没有案件"）', () => {
    expect(viewState({ error: null, data: null })).toBe('loading');
  });

  it('查到了、确实是空的 → 建档引导', () => {
    expect(
      viewState({
        error: null,
        data: { actions: [], deadlines: [], attainments: [], records: [], timelineCount: 0 },
      }),
    ).toBe('blank');
  });

  it('查到了、有东西 → 正常渲染', () => {
    expect(viewState({ error: null, data: full })).toBe('ready');
  });
});

/* ── 二、真数据确实画到了屏幕上（正向断言）───────────────────── */

describe('三块部件用真数据渲染', () => {
  it('轨道：达成的那格显示真实日期，不是演示案件的日期', async () => {
    const data = await fetchDashboard('1');
    const html = ssr(<MilestoneTrack track={FULL_JOURNEY} attainments={data.attainments} />);
    expect(text(html)).toContain('协商');
    // 07/24 是上面那条真实事件的日子；轨道把它标成"完成"才会印出来
    // （日期按 _ui/format 的斜杠式渲染，窄屏缩成 07/24、≥sm 是完整年月日）
    expect(html).toContain('07/24');
    expect(html).toContain('2026/07/24');
  });

  it('轨道：没有达成点时不许凭空长出完成态', async () => {
    const html = ssr(<MilestoneTrack track={FULL_JOURNEY} attainments={[]} />);
    expect(html).not.toContain('07/24');
  });

  it('行动卡：真实标题在屏幕上，计数按全量算', async () => {
    const data = await fetchDashboard('1');
    const html = ssr(<ActionGroup items={data.actions} limit={1} />);
    expect(text(html)).toContain('去社保中心打参保证明');
    expect(text(html)).toContain('0/2'); // limit=1 只画一条，计数仍是 2
  });

  it('期限：真实类型与到期日在屏幕上', async () => {
    const data = await fetchDashboard('1');
    const html = ssr(<DeadlineTiles deadlines={data.deadlines} now={new Date('2026-08-30')} />);
    expect(text(html)).toContain('仲裁时效');
    expect(text(html)).toContain('2027/07/24');
  });

  it('材料：真实文件名在屏幕上，演示文件名一个都不在', async () => {
    const data = await fetchDashboard('1');
    const html = ssr(<RecentRecords caseId="1" records={data.records} />);
    expect(text(html)).toContain('劳动合同扫描件.pdf');
    for (const demoName of demoRecords('demo').map((r) => r.name)) {
      expect(text(html)).not.toContain(demoName);
    }
  });
});

/**
 * 上面几条分别验了每个部件"给它真数据它会画"，
 * 这一组验的是**驾驶舱到底有没有把真数据递给它们**——
 * 两件事分开验：部件没问题、但页面递的是空数组或演示值，屏幕上照样什么都没有。
 */
describe('驾驶舱把真数据递到了四块部件', () => {
  it('一屏之内同时出现：轨道日期、行动卡标题、期限、材料', async () => {
    const data = await fetchDashboard('1');
    const out = text(ssr(<DashboardBody caseId="1" data={data} />));

    // 轨道那格断言写全年份：只写 `07/24` 会被期限卡的 `2027/07/24` 顺带满足，
    // 于是把轨道换成空数组这条断言照样绿——**跑变异时才抓到，正是它没牙的样子**。
    expect(out).toContain('2026/07/24'); // 轨道：真实达成日
    expect(out).toContain('去社保中心打参保证明'); // 行动卡：真实标题
    expect(out).toContain('仲裁时效'); // 期限：真实类型
    expect(out).toContain('2027/07/24'); // 期限：真实到期日
    expect(out).toContain('劳动合同扫描件.pdf'); // 材料：真实文件名
  });

  it('这一屏上没有任何演示案件的痕迹', async () => {
    const data = await fetchDashboard('1');
    const html = ssr(<DashboardBody caseId="1" data={data} />);
    // 正对照：这些串确实是演示数据里的原文
    const mock = readFileSync(join(process.cwd(), 'src/app/_mock/demo.ts'), 'utf8');
    for (const w of ['星曜网络', '解除通知异议']) expect(mock).toContain(w);
    for (const w of ['星曜网络', '解除通知异议']) expect(html).not.toContain(w);
  });

  /**
   * 「只推一件事」推的必须是接口给的第一条。
   * 排序是后端的活（`ORDER BY priority DESC`，且 tools.ts 写明「数字越大越急」），
   * 这一页**不许自己再排一次**——两处各排各的，迟早推出不一样的那件事。
   */
  it('推的是接口给的第一条，页面不自作主张重排', async () => {
    const data = await fetchDashboard('1');
    const out = text(ssr(<DashboardBody caseId="1" data={data} />));
    expect(data.actions[0].title).toBe('去社保中心打参保证明'); // 替身按接口顺序给的
    expect(out).toContain('去社保中心打参保证明');
    expect(out).not.toContain('把考勤截图导出来'); // limit=1，第二条不画
  });

  it('「其余 N 件」按全量算，不按只画出来的那一条算', async () => {
    const data = await fetchDashboard('1');
    const out = text(ssr(<DashboardBody caseId="1" data={data} />));
    expect(out).toContain('其余 1 件'); // 两条待办，画了一条
  });

  it('案件内的链接指向这个案件，不指演示案件', async () => {
    const data = await fetchDashboard('1');
    const html = ssr(<DashboardBody caseId="1" data={data} />);
    expect(html).toContain('/case/1/ask');
    expect(html).not.toContain('/case/demo');
  });
});

/* ── 三、Dashboard 本身：变异核 ─────────────────────────────── */

/**
 * 这两条盯的是**首帧**。SSR 跑不到 useEffect，所以看到的正是
 * 「这一页在拿到数据之前先画什么」——旧代码在这一帧就已经把
 * 「还没有你的案件」定死了，数据回来与否都改不了它。
 */
describe('真实案件的首帧', () => {
  it('不是空态：真实案件在取数之前先画骨架，不先扣一顶"你没有案件"的帽子', () => {
    const out = text(ssr(<Dashboard caseId="1" />));
    expect(out).not.toContain('还没有你的案件');
    expect(out).not.toContain('这个案件还是空的');
    expect(out).not.toContain('开始建档');
  });

  it('也不是演示数据', () => {
    expect(ssr(<Dashboard caseId="1" />)).not.toContain('星曜网络');
  });

  it('演示案件照旧直接画演示数据，一次请求都不发（别把演示路径改坏了）', () => {
    calls.length = 0;
    const out = text(ssr(<Dashboard caseId="demo" />));
    expect(out).toContain('土八鼠守望中');
    expect(calls).toEqual([]);
  });
});

/**
 * 结构守卫：**这条是「必须能红」的那条。**
 * 有人把 mock 接回驾驶舱（哪怕只是"临时先跑起来"），这里立刻红。
 * 断言 import 语句本身而不是渲染结果——演示值和真值长得像的时候，渲染结果看不出区别。
 */
describe('驾驶舱不许再从 mock 取案件数据', () => {
  function importsOf(src: string): { from: string; bindings: string }[] {
    return [...src.matchAll(/import\s+([\s\S]*?)\s+from\s+'([^']+)'/g)].map((m) => ({
      bindings: m[1],
      from: m[2],
    }));
  }

  const read = (f: string) => readFileSync(join(COMPONENTS, f), 'utf8');

  it('正对照：这两个文件确实有 import，否则下面几条是在空集上断言', () => {
    expect(importsOf(read('Dashboard.tsx')).length).toBeGreaterThan(0);
    expect(importsOf(read('RecentRecords.tsx')).length).toBeGreaterThan(0);
  });

  it('Dashboard 从 _mock/demo 只取 demoCase（用来认出演示案件那一个 id）', () => {
    for (const imp of importsOf(read('Dashboard.tsx')).filter((i) => i.from === '@/app/_mock/demo')) {
      for (const forbidden of ['demoActions', 'demoDeadlines', 'demoEvidence', 'demoCompanyDocs']) {
        expect(imp.bindings).not.toContain(forbidden);
      }
    }
  });

  it('RecentRecords 一点 mock 都不碰——它现在只认传进来的行', () => {
    expect(importsOf(read('RecentRecords.tsx')).map((i) => i.from)).not.toContain(
      '@/app/_mock/demo',
    );
  });
});
