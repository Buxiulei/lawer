/**
 * F-201：/welcome 得先问一句「你是新来的还是回来的」，再决定说什么。
 *
 * ─────────────── 这组守的是哪个缺口 ───────────────
 * 小白第二轮实测：uid=7（名下有 case/5、1 条对话线程、4 条消息、1 份证据）
 * 退出后用手机号重登、又用邮箱重登，两次都落在 /welcome 上，读到的是一模一样的
 * 「档案已创建 … 接下来花几分钟做一次首诊」，唯一 CTA 是「开始首诊」。
 * 数据经核实一条没少——只是这一屏从没问过他是谁。
 *
 * 【裁决口径】不改登录后的落点（主理人对自动跳转敏感，/welcome 保留），
 * 改的是这一屏渲染两种态。所以本组分两半：
 *   ① 判定：isFreshCase 的四个维度，任一有数据即非空（少数一个维度就是又一次误判）
 *   ② 渲染：两态各说各的话，且老用户那一屏一个「首诊」字都不许有
 */
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

/* 取数那两个门面在③里被驱动，②①两组都不碰它们（判定与两屏都是纯的） */
vi.mock('@/app/_ui/currentCase', () => ({ fetchMyCases: vi.fn() }));
vi.mock('@/app/_ui/api', () => ({ apiFetch: vi.fn() }));

const { isFreshCase, intakeUntouched } = await import('@/lib/cases/freshness');
type CaseSnapshot = Parameters<typeof isFreshCase>[0];
const { welcomeStateFor, loadWelcomeState } = await import('../_components/welcomeData');
const { FreshWelcome, ReturningWelcome } = await import('../_components/WelcomeScreens');
const { fetchMyCases } = await import('@/app/_ui/currentCase');
const { apiFetch } = await import('@/app/_ui/api');
const { SessionGate } = await import('@/app/_ui/session');

/** 刚注册那一刻的案件：ensureDefaultCase 建好了，里面什么都没有 */
const BRAND_NEW: CaseSnapshot = {
  timelineCount: 0,
  messageCount: 0,
  evidenceCount: 0,
  intake: {
    employedFrom: null,
    monthlyWageFen: null,
    position: null,
    contractCount: null,
  },
};

/* ── ① 判定：四个维度，一个都不能漏 ─────────────────────── */

describe('isFreshCase：四个维度全空才算新人', () => {
  it('刚注册建的那个空案件 → 新人', () => {
    expect(isFreshCase(BRAND_NEW)).toBe(true);
  });

  /**
   * 四条各盯一个维度。**少数哪一个，就是哪一类用户被当成新人**：
   * 漏时间线 = 刚讲完全部经过的人；漏消息 = 聊了两小时的人；
   * 漏证据 = 传完解除通知书的人；漏首诊四列 = 填完工资司龄还没开口的人。
   */
  it.each([
    ['时间线', { ...BRAND_NEW, timelineCount: 6 }, '首诊把经过讲完了，行动卡还没生成'],
    ['对话', { ...BRAND_NEW, messageCount: 4 }, '聊过 4 句，库里一条不少'],
    ['证据', { ...BRAND_NEW, evidenceCount: 1 }, '传了一份解除通知书'],
    [
      '首诊·入职日期',
      { ...BRAND_NEW, intake: { ...BRAND_NEW.intake, employedFrom: '2021-03-01' } },
      '司龄填了',
    ],
    [
      '首诊·月工资',
      { ...BRAND_NEW, intake: { ...BRAND_NEW.intake, monthlyWageFen: 2000000 } },
      '工资填了',
    ],
    [
      '首诊·岗位',
      { ...BRAND_NEW, intake: { ...BRAND_NEW.intake, position: '后端工程师' } },
      '岗位填了',
    ],
    [
      '首诊·合同次数',
      { ...BRAND_NEW, intake: { ...BRAND_NEW.intake, contractCount: '续签过一次' } },
      '合同次数填了',
    ],
  ])('%s 单独有数据就不是新人（%s）', (dimension, snapshot, why) => {
    expect(
      isFreshCase(snapshot as CaseSnapshot),
      `缺什么：「${dimension}」这个维度没算进判据。\n` +
        `为什么缺：${why}——他一登录就会读到「你的档案刚建好，去做一次首诊」，` +
        '而他的记录全在库里。这个错是静默的：页面排版正常，没有任何报错。\n' +
        '怎么办：lib/cases/freshness 的 isFreshCase 四个维度缺一不可。',
    ).toBe(false);
  });

  it('月工资 0 不算「没填」——库里刻意不存 0 冒充空', () => {
    // 反向对照：把 filled 写成真值判断（!!value）时这条红，那时 0 元工资的人被当成新人。
    expect(intakeUntouched({ ...BRAND_NEW.intake, monthlyWageFen: 0 })).toBe(false);
  });

  it('空串按没填算：首诊跳过某一格时存的可能是空串', () => {
    expect(intakeUntouched({ ...BRAND_NEW.intake, position: '   ' })).toBe(true);
  });
});

describe('welcomeStateFor：取不准时往「别把老用户当新人」那边错', () => {
  it('名下没有案件 → 新人那一屏', () => {
    expect(welcomeStateFor({ caseId: null, snapshot: null })).toEqual({ kind: 'fresh' });
  });

  it('有案件且四个维度全空 → 新人那一屏', () => {
    expect(welcomeStateFor({ caseId: 5, snapshot: BRAND_NEW })).toEqual({ kind: 'fresh' });
  });

  it('有案件且有东西 → 欢迎回来，CTA 指向这个案件', () => {
    expect(welcomeStateFor({ caseId: 5, snapshot: { ...BRAND_NEW, messageCount: 4 } })).toEqual({
      kind: 'returning',
      caseId: 5,
    });
  });

  it('已知他名下有案件、但这次没读出四个维度 → 仍按「回来了」渲染', () => {
    // 判成新人 = 对一个有整套记录的人说"你的档案刚建好"，正是 F-201 那句话。
    expect(welcomeStateFor({ caseId: 5, snapshot: null })).toEqual({
      kind: 'returning',
      caseId: 5,
    });
  });
});

/* ── ② 渲染：两态各说各的话 ────────────────────────────── */

const text = (html: string) => html.replace(/<[^>]+>/g, '').replace(/\s+/g, '');

describe('两种态各自那一屏', () => {
  it('新人：档案已创建 + 开始首诊（指向 /intake）', () => {
    const h = renderToStaticMarkup(<FreshWelcome />);
    expect(text(h)).toContain('档案已创建');
    expect(text(h)).toContain('开始首诊');
    expect(h).toContain('href="/intake"');
  });

  it('老用户：欢迎回来 + 进入我的案件（指向 /case/5）', () => {
    const h = renderToStaticMarkup(<ReturningWelcome caseId={5} />);
    expect(text(h)).toContain('欢迎回来');
    expect(text(h)).toContain('进入我的案件');
    expect(
      h,
      '主 CTA 得直接把人送回他自己的案件；指到解析页或首页都等于再让他找一次。',
    ).toContain('href="/case/5"');
  });

  it('老用户那一屏一个「首诊」字都没有', () => {
    const t = text(renderToStaticMarkup(<ReturningWelcome caseId={5} />));
    for (const word of ['开始首诊', '首诊', '档案已创建', '档案已经建好']) {
      expect(
        t.includes(word),
        `缺什么：「欢迎回来」那一屏上出现了「${word}」。\n` +
          '为什么缺：F-201 的伤害就是这句话——它对一个名下有整套记录的人说"你刚开始"，' +
          '他会以为数据丢了，或者以为要重走一遍首诊（那是几十分钟的复述被裁经过）。\n' +
          '怎么办：老用户那一屏只说「欢迎回来」+「进入我的案件」，接入卡照旧收在次位。',
      ).toBe(false);
    }
  });

  it('反向对照：接入卡在两屏里都还在，且都是次要那一颗', () => {
    // 少了这条，把老用户那一屏写成只有一颗按钮也全绿——那时自带 agent 的老用户
    // 再也看不到那条更省的路。
    for (const [name, node] of [
      ['新人', <FreshWelcome key="f" />],
      ['老用户', <ReturningWelcome key="r" caseId={5} />],
    ] as const) {
      const h = renderToStaticMarkup(node);
      expect(h, `${name}那一屏上没有接入卡`).toContain('href="/settings/agent"');
      const main = h.indexOf(name === '新人' ? '开始首诊' : '进入我的案件');
      expect(main, `${name}那一屏找不到主 CTA`).toBeGreaterThan(-1);
      expect(main, `${name}：接入卡排到了主 CTA 前面`).toBeLessThan(h.indexOf('href="/settings/agent"'));
    }
  });
});

/* ── ③ 接线：问出这一屏所需的那几个数，以及问不出来时怎么办 ─── */

/**
 * 上面两组验的是「判定对不对」和「两屏各说什么」，**都是纯的**。
 * 中间那截接线（去哪儿取数、取哪一个案件、取不到怎么办）自己也会错，
 * 而它错起来的形态正是 F-201 本身：一屏「你的档案刚建好」端给一个老用户。
 */
describe('loadWelcomeState：取数接线', () => {
  beforeEach(() => {
    vi.mocked(fetchMyCases).mockReset();
    vi.mocked(apiFetch).mockReset();
  });

  /** 后端那三条的替身，按路径派活（照真实返回体的形状，逐字 snake_case） */
  function serveCase(snapshot: {
    timeline: unknown[];
    messages: unknown[];
    evidence: unknown[];
    intake?: Partial<Record<string, unknown>>;
  }) {
    vi.mocked(apiFetch).mockImplementation((path: string) => {
      if (path.includes('/messages')) return Promise.resolve({ messages: snapshot.messages });
      if (path.includes('/evidence')) return Promise.resolve({ evidence: snapshot.evidence });
      return Promise.resolve({
        case: {
          employed_from: null,
          monthly_wage_fen: null,
          position: null,
          contract_count: null,
          ...snapshot.intake,
        },
        timeline: snapshot.timeline,
      });
    });
  }

  it('名下有案件且聊过话 → 欢迎回来，CTA 指向名下最新那个案件', async () => {
    vi.mocked(fetchMyCases).mockResolvedValue([
      { id: 5, title: '被裁' },
      { id: 2, title: '旧的' },
    ]);
    serveCase({ timeline: [], messages: [{}, {}, {}, {}], evidence: [] });

    expect(
      await loadWelcomeState(),
      '缺什么：接线没把「他名下有个有东西的案件」这件事读出来。\n' +
        '为什么缺：判定函数再对，问错了案件、或者压根没问，' +
        '端到屏幕上的还是那句「你的档案刚建好」——F-201 一字不差地回来。\n' +
        '怎么办：latestOf(名下清单) 取 id，再拿它去问四个维度。',
    ).toEqual({ kind: 'returning', caseId: 5 });
  });

  it('名下有案件但四个维度全空 → 新人那一屏', async () => {
    // 反向对照：少了这条，把接线写成「查到案件就算老用户」也全绿，
    // 那时刚注册完的人一落地就被问「要不要回到你的案件」，而里面什么都没有。
    vi.mocked(fetchMyCases).mockResolvedValue([{ id: 9, title: '刚建的' }]);
    serveCase({ timeline: [], messages: [], evidence: [] });
    expect(await loadWelcomeState()).toEqual({ kind: 'fresh' });
  });

  it('四个维度这次没读出来、但清单查到了案件 → 仍按「回来了」渲染', async () => {
    vi.mocked(fetchMyCases).mockResolvedValue([{ id: 5, title: '被裁' }]);
    vi.mocked(apiFetch).mockRejectedValue(new Error('后端抖了'));
    expect(await loadWelcomeState()).toEqual({ kind: 'returning', caseId: 5 });
  });

  it('【如实记】连名下清单都查不到 → 落到新人那一屏（这条链上唯一往「新人」错的地方）', async () => {
    // 那时连个 id 都没有，「进入我的案件」无处可指。这不是理想行为，是没得选；
    // 真正兜住老用户的是下面那道闸门——token 失效走的是它，不是这一支。
    vi.mocked(fetchMyCases).mockRejectedValue(new Error('网断了'));
    expect(await loadWelcomeState()).toEqual({ kind: 'fresh' });
  });
});

/* ── ④ 登录态失效时，兜住的是闸门，不是「新人」那一屏 ───────── */

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

describe('welcome/layout.tsx 挂着登录态失效的闸门', () => {
  it('挂的是 _ui/session 的 SessionGate 本尊，next 指回 /welcome', async () => {
    const WelcomeLayout = (await import('../layout')).default;
    const gate = findGate(WelcomeLayout({ children: <div /> }));
    expect(
      gate,
      '缺什么：/welcome 的 layout 上没有登录态失效的闸门。\n' +
        '为什么缺：这一页要靠接口回答「你是新来的还是回来的」。token 坏掉时那几条请求全是 401，' +
        'loadWelcomeState 问不出答案就退回 { kind: fresh }——于是一个名下有整套记录的老用户，' +
        '读到的又是「你的档案刚建好、去做一次首诊」。**F-201 会从这条缝里原样漏回来**，' +
        '而且这一次连报错都没有：页面排版正常，判定函数的判据全绿。\n' +
        '怎么办：在 welcome/layout.tsx 里用 <SessionGate next="/welcome"> 包住 children' +
        '（就是案件路由用的那一个，不是另抄一份）。',
    ).not.toBeNull();
    expect(gate?.props.next, '回跳路径要指回这一页自己').toBe('/welcome');
  });
});
