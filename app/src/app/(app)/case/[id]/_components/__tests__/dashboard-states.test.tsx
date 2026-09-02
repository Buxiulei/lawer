/**
 * 驾驶舱的三条界线，都属于「屏幕看起来完全正常、说的却是反话」那一类：
 *
 * ① 空态判据：刚把全部经过讲完的人，行动卡还没有、里程碑也没有，
 *    旧判据照样判成「这个案件还是空的」——他刚说完的那几条时间线就在库里躺着。
 * ② 不存在 / 不属于你：旧代码把它塞进「临时读取失败」那一屏，用户读到的是
 *    「案件不存在你的案件和材料都还在，点下面再试一次」——两句粘在一起、互相矛盾，
 *    而且重试一万次也一样。
 * ③ 公司档案没有入口：整套背调功能做好了，驾驶舱上找不到门。
 */
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

const { failureOf, isBlank, viewState } = await import('../dashboardData');
type DashboardData = Awaited<ReturnType<typeof import('../dashboardData').fetchDashboard>>;
const { CaseMissing, DashboardBody } = await import('../Dashboard');
const { ApiError, NetworkError } = await import('@/app/_ui/api');

const EMPTY: DashboardData = {
  actions: [],
  deadlines: [],
  attainments: [],
  records: [],
  timelineCount: 0,
};

const ssr = (node: React.ReactNode) => renderToStaticMarkup(<>{node}</>);
const text = (html: string) => html.replace(/<[^>]+>/g, '');

/* ── ① 空态判据 ─────────────────────────────────────────── */

describe('空态只在真的什么都没有时出现', () => {
  it('四块全空且时间线也空 → 空态', () => {
    expect(isBlank(EMPTY)).toBe(true);
    expect(viewState({ error: null, data: EMPTY })).toBe('blank');
  });

  it('**有时间线、没有行动卡** → 不是空态（首诊刚讲完就是这个形态）', () => {
    const justTold = { ...EMPTY, timelineCount: 6 };
    expect(isBlank(justTold)).toBe(false);
    expect(viewState({ error: null, data: justTold })).toBe('ready');
  });

  it('材料（证据）单独非空也不是空态', () => {
    const withRecord: DashboardData = {
      ...EMPTY,
      records: [
        { key: 'ev-1', name: '劳动合同.pdf', tag: '已上传', tone: 'neutral', href: '/x', at: '2026-09-01' },
      ],
    };
    expect(isBlank(withRecord)).toBe(false);
  });

  it('行动卡 / 期限 / 里程碑 三项照旧各自算数（别把老判据改坏了）', () => {
    expect(
      isBlank({
        ...EMPTY,
        deadlines: [
          { id: '1', caseId: '1', kind: '仲裁时效', title: '仲裁时效', dueAt: '2027-01-01', derivedFrom: '' },
        ],
      }),
    ).toBe(false);
    expect(isBlank({ ...EMPTY, attainments: [{ milestone: '协商', happenedAt: '2026-07-24' }] })).toBe(
      false,
    );
  });
});

/* ── ② 不存在 / 不属于你 ────────────────────────────────── */

describe('「不存在或不属于你」与「这次没读到」分开说', () => {
  it('CASE_NOT_FOUND → 终局，不是可重试的失败', () => {
    const f = failureOf(new ApiError('CASE_NOT_FOUND', '案件不存在', 404));
    expect(f.kind).toBe('missing');
    expect(viewState({ error: f, data: null })).toBe('missing');
  });

  it('网络断了 / 5xx → 可重试', () => {
    expect(failureOf(new NetworkError()).kind).toBe('transient');
    expect(failureOf(new ApiError('INTERNAL', '服务器开小差', 500)).kind).toBe('transient');
    expect(viewState({ error: failureOf(new NetworkError()), data: null })).toBe('failed');
  });

  it('终局那一屏：说清是不存在或不属于你，给「回我的案件」，**没有重试按钮**', () => {
    const out = text(ssr(<CaseMissing />));
    expect(out).toContain('这个案件不存在或不属于你');
    // 这三句是旧文案里对着「不属于你」说的谎，一句都不许再出现
    expect(out).not.toContain('你的案件和材料都还在');
    expect(out).not.toContain('再试一次');
    expect(out).not.toContain('重试');
    expect(ssr(<CaseMissing />)).toContain('href="/case"');
  });
});

/* ── ③ 公司档案入口 ─────────────────────────────────────── */

describe('驾驶舱给公司档案一个明确入口', () => {
  const data: DashboardData = { ...EMPTY, timelineCount: 3 };

  it('入口卡指向本案的公司档案，不是演示案件', () => {
    const html = ssr(<DashboardBody caseId="7" data={data} />);
    expect(html).toContain('href="/case/7/dossier"');
    expect(html).not.toContain('/case/demo');
  });

  it('入口上写明「先免费查有没有货」——不写清楚免费，没人敢点', () => {
    const out = text(ssr(<DashboardBody caseId="7" data={data} />));
    expect(out).toContain('公司档案：先免费查有没有货');
  });
});
