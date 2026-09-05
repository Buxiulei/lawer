/**
 * 文件解读 / 文书 / 对话页那条状态提要，对**真实案件**不许出现演示数据。
 *
 * 立这组的由头：这三处此前一律读 mock——
 *   docs/page.tsx    `docs={mockDocs}`      对任何 caseId 都是那四份「星曜网络」的文件
 *   drafts/page.tsx  `const drafts = mockDrafts`  同上，异议函与仲裁申请书全是别人的
 *   Workbench        `demoCase.stage` + `demoDeadlines`  阶段与最近期限恒是演示值
 * 页面看起来完全正常：有标题、有版本号、有更新时间、有倒计时。只是那不是他的案子。
 * 真实用户今天就在用，读到别家公司的解除通知是不可接受的。
 *
 * 判据分两半，缺一半都不算数：
 *   ① 真实案件那几页整份 HTML 里「星曜网络」0 命中；
 *   ② 空的时候确实画出了诚实空态与两个真去处（否则「0 命中」白屏也能通过）。
 * demo 侧留正对照：演示案件照旧渲染演示数据，不然①可能只是因为 mock 被删干净了。
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
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
  useRouter: () => ({ push: () => {} }),
}));
vi.mock('@/components/ui/Toast', () => ({
  useToast: () => () => {},
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

const { fetchDrafts, findDraft, toDraftView } = await import('../drafts/_components/draftsData');
const { DraftsListView } = await import('../drafts/_components/DraftsListView');
const { RealDraftBody } = await import('../drafts/_components/RealDraftView');
const { DocsEmpty } = await import('../docs/_components/DocsEmpty');
const { CaseStatusBar, CaseStatusBarBody } = await import('../_components/CaseStatusBar');
const { fetchCaseStatus, demoCaseStatus, hasStatus } = await import('../_components/caseStatus');
const { mockDrafts, mockDocs, getDoc } = await import('@/app/_mock/docs-drafts');

const DocsPage = (await import('../docs/page')).default;
const DocDetailPage = (await import('../docs/[docId]/page')).default;
const DraftsPage = (await import('../drafts/page')).default;
const DraftDetailPage = (await import('../drafts/[draftId]/page')).default;

const ssr = (node: React.ReactNode) => renderToStaticMarkup(<>{node}</>);
const text = (html: string) => html.replace(/<[^>]+>/g, '');
const SRC = join(process.cwd(), 'src');
const MOCK_FILE = join(SRC, 'app/_mock/docs-drafts.ts');

/** 只看代码行，注释里提到 demo 不算（注释误报会让下一个人把守卫当噪音关掉） */
function codeLines(relPath: string): string[] {
  return readFileSync(join(SRC, relPath), 'utf8')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\/?\*)/.test(l));
}

/** 一个真实案件的文书行，字段名逐字照后端行（lib/db/agent 的 DraftRow） */
function realDraftRows() {
  return [
    {
      id: 7,
      case_id: 1,
      kind: '异议函',
      title: '《解除劳动合同通知书》异议函',
      content: '朗华智联数据服务有限公司：\n本人不认可解除理由……',
      version: 2,
      status: 'draft',
      created_at: '2026-08-20T10:00:00+08:00',
      updated_at: '2026-08-21T11:30:00+08:00',
    },
    {
      id: 5,
      case_id: 1,
      kind: '证据清单',
      title: '证据清单（第一批）',
      content: '一、劳动合同一份……',
      version: 1,
      status: 'draft',
      created_at: '2026-08-18T09:00:00+08:00',
      updated_at: '2026-08-18T09:00:00+08:00',
    },
  ];
}

beforeEach(() => {
  for (const k of Object.keys(responses)) delete responses[k];
  calls.length = 0;
  responses['/cases/1/drafts'] = { drafts: realDraftRows() };
  responses['/cases/1?'] = { case: { id: 1, title: '我的案件', stage: '已收通知' } };
  responses['/cases/1/deadlines'] = {
    deadlines: [
      { id: 21, due_at: '2027-07-24T23:59:00+08:00' },
      { id: 22, due_at: '2026-09-05T18:00:00+08:00' },
    ],
  };
});

/* ── 零、正对照：演示数据确实带着那家公司的名字 ───────────────── */

describe('正对照', () => {
  it('演示数据里确实有「星曜网络」——下面的 0 命中才有意义', () => {
    expect(readFileSync(MOCK_FILE, 'utf8')).toContain('星曜网络');
    expect(getDoc('cd_2')?.ocrText).toContain('星曜网络');
    expect(JSON.stringify(mockDrafts)).toContain('星曜网络');
  });
});

/* ── 一、文书：接口的行确实变成了视图 ───────────────────────── */

describe('文书取数与字段映射', () => {
  it('查的是这个案件的文书，不是别人的', async () => {
    await fetchDrafts('1');
    expect(calls).toEqual(['/cases/1/drafts']);
  });

  it('标题、版本、更新时间照后端行搬过来', async () => {
    const drafts = await fetchDrafts('1');
    expect(drafts).toHaveLength(2);
    expect(drafts[0]).toMatchObject({
      id: '7',
      kind: '异议函',
      title: '《解除劳动合同通知书》异议函',
      version: 2,
      updatedAt: '2026-08-21T11:30:00+08:00',
    });
  });

  it('库里的英文 draft 翻成「草稿」——不能显示成一个用户看不懂的词', async () => {
    const drafts = await fetchDrafts('1');
    expect(drafts.map((d) => d.status)).toEqual(['草稿', '草稿']);
  });

  it('content 为 NULL 时给空串，不让详情页拿到 null 去渲染', () => {
    expect(toDraftView({ ...realDraftRows()[0], content: null }).content).toBe('');
  });

  it('认不出的类型按「其他」渲染但要出声，不静默改归类', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    responses['/cases/1/drafts'] = {
      drafts: [{ ...realDraftRows()[0], kind: '和解协议' }],
    };
    const drafts = await fetchDrafts('1');
    expect(drafts[0].kind).toBe('其他');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('认不出的状态按「草稿」渲染——往「已发出」错会让人以为对方收到了', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    responses['/cases/1/drafts'] = {
      drafts: [{ ...realDraftRows()[0], status: 'sent' }],
    };
    expect((await fetchDrafts('1'))[0].status).toBe('草稿');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('详情页按 id 挑得出那一份，挑不到就是 undefined 不是兜底给第一份', async () => {
    const drafts = await fetchDrafts('1');
    expect(findDraft(drafts, '5')?.title).toBe('证据清单（第一批）');
    expect(findDraft(drafts, 'dr_1')).toBeUndefined();
  });
});

/* ── 二、真实案件三页：0 命中 + 空态确实画出来了 ───────────────── */

describe('真实案件的文书页', () => {
  it('列表画的是自己的文书，不掺一个字的演示数据', async () => {
    const html = ssr(<DraftsListView caseId="1" drafts={await fetchDrafts('1')} />);
    expect(text(html)).toContain('《解除劳动合同通知书》异议函');
    expect(text(html)).toContain('证据清单（第一批）');
    expect(html).not.toContain('星曜网络');
    expect(html).not.toContain('劳动仲裁申请书（朝阳区仲裁委）');
  });

  it('一份都没有时是诚实空态 + 两个真去处，不是拿 mock 兜底', () => {
    const html = ssr(<DraftsListView caseId="1" drafts={[]} />);
    expect(text(html)).toContain('还没有文书');
    expect(html).toContain('href="/case/1/ask"');
    expect(html).toContain('href="/case/1/evidence"');
    expect(html).not.toContain('星曜网络');
  });

  it('详情只读：正文是这一份的正文，且说清了改稿要去哪儿', async () => {
    const draft = findDraft(await fetchDrafts('1'), '7')!;
    const html = ssr(<RealDraftBody caseId="1" draft={draft} />);
    expect(text(html)).toContain('本人不认可解除理由');
    expect(text(html)).toContain('这一页现在只能读，改不了');
    expect(html).toContain('href="/case/1/ask"');
    expect(html).not.toContain('星曜网络');
  });
});

describe('真实案件的文件解读页', () => {
  it('空态说清了「还在接」，并给出对话与证据库两个入口', () => {
    const html = ssr(<DocsEmpty caseId="1" />);
    expect(text(html)).toContain('还没有解读过的文件');
    expect(html).toContain('href="/case/1/ask"');
    expect(html).toContain('href="/case/1/evidence"');
    expect(html).not.toContain('星曜网络');
  });

  it('空态里不给「上传文件」——那条流水线是演示件，会把人送到样张', () => {
    expect(text(ssr(<DocsEmpty caseId="1" />))).not.toContain('上传');
  });
});

describe('对话页的状态提要', () => {
  it('阶段与最近期限取自本案件的真数据', async () => {
    const status = await fetchCaseStatus('1');
    expect(status).toEqual({ stage: '已收通知', nearestDueAt: '2026-09-05T18:00:00+08:00' });
    const html = ssr(<CaseStatusBarBody status={status} />);
    expect(text(html)).toContain('已收通知');
    expect(text(html)).toContain('2026/09/05');
    expect(text(html)).not.toContain('仲裁准备');
  });

  it('阶段是空字符串时按取不到算，不画一个空徽标', async () => {
    responses['/cases/1?'] = { case: { id: 1, title: '我的案件', stage: '  ' } };
    expect((await fetchCaseStatus('1')).stage).toBeNull();
  });

  it('两样都取不到就整条不出现——空壳提要比没有更让人以为案子是空的', () => {
    expect(hasStatus(null)).toBe(false);
    expect(hasStatus({ stage: null, nearestDueAt: null })).toBe(false);
    expect(hasStatus({ stage: null, nearestDueAt: '2026-09-05T18:00:00+08:00' })).toBe(true);
    expect(hasStatus({ stage: '已收通知', nearestDueAt: null })).toBe(true);
  });

  it('只有其中一样时画出那一样，另一样不占位', () => {
    const html = ssr(<CaseStatusBarBody status={{ stage: '已收通知', nearestDueAt: null }} />);
    expect(text(html)).toContain('已收通知');
    expect(html).not.toContain('星曜网络');
  });
});

/**
 * 上面那一节验的是**画法**那一层（CaseStatusBarBody：给什么画什么）。
 * 接线那一层——`useState(demo ? demoCaseStatus() : null)`——它管不着：
 * 把初值改成恒 `demoCaseStatus()`，真实案件的第一帧就会挂出「仲裁准备」和一个别人的到期日，
 * 而画法层的判据一条都不会红。取数在 useEffect 里，SSR 到不了第二帧，
 * **首帧正是用户瞥见的那一帧**，也正是这类回潮唯一露头的地方（骨架层标题那次就是这么发作的）。
 */
describe('状态提要的首帧', () => {
  it('真实案件首帧什么都不画——宁可晚一步，也不先闪一下演示阶段', () => {
    const html = ssr(<CaseStatusBar caseId="1" demo={false} />);
    expect(html).toBe('');
    expect(html).not.toContain('仲裁准备');
    expect(html).not.toContain('星曜网络');
  });

  /** 正对照：演示案件首帧就该有演示阶段，否则上一条可能只是这个组件压根画不出东西 */
  it('演示案件首帧就是演示阶段与演示期限', () => {
    const html = ssr(<CaseStatusBar caseId="demo" demo={true} />);
    expect(text(html)).toContain('仲裁准备');
    expect(text(html)).toContain('当前阶段与最近期限');
  });
});

/* ── 三、路由分叉：真实 caseId 走的到底是哪一条 ────────────────── */

describe('页面按 caseId 分叉', () => {
  it('文件解读页：真实案件走取数（此刻是骨架），不是 mock 列表', async () => {
    // 这条原来断言的是「真实案件恒空态」——那是 company_docs 还没有任何写入路径时的实情。
    // doc_submit 落地后这一页改成现查接口，首帧是骨架；「确实一份都没有」时才画空态
    // （由 RealDocs 判空，见 real-docs-branches 那组把三条岔路逐条推过去）。
    const html = ssr(await DocsPage({ params: Promise.resolve({ id: '1' }) }));
    expect(html).not.toContain('星曜网络');
    expect(text(html)).not.toContain('协商解除劳动合同协议书');
  });

  it('文件解读详情：真实案件下样张 id 一律 404，不摆到别人档案里', async () => {
    await expect(
      DocDetailPage({ params: Promise.resolve({ id: '1', docId: 'cd_2' }) }),
    ).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('文书页：真实案件走取数（此刻是骨架），不是 mock 列表', async () => {
    const html = ssr(await DraftsPage({ params: Promise.resolve({ id: '1' }) }));
    expect(html).not.toContain('星曜网络');
    expect(html).not.toContain('劳动仲裁申请书（朝阳区仲裁委）');
  });

  it('文书详情：真实案件下演示 id 不渲染演示文书', async () => {
    const html = ssr(
      await DraftDetailPage({ params: Promise.resolve({ id: '1', draftId: 'dr_1' }) }),
    );
    expect(html).not.toContain('星曜网络');
  });
});

/* ── 四、demo 正对照：演示案件照旧 ─────────────────────────── */

describe('演示案件照旧显示演示数据', () => {
  it('文件解读页仍列出那四份样张', async () => {
    const html = ssr(await DocsPage({ params: Promise.resolve({ id: 'demo' }) }));
    expect(text(html)).toContain('协商解除劳动合同协议书');
    expect(text(html)).toContain(mockDocs[0].title);
  });

  it('文件解读详情仍打得开样张，正文就是那家公司的原文', async () => {
    const html = ssr(
      await DocDetailPage({ params: Promise.resolve({ id: 'demo', docId: 'cd_2' }) }),
    );
    expect(html).toContain('星曜网络');
  });

  it('文书页仍列出演示文书', async () => {
    const html = ssr(await DraftsPage({ params: Promise.resolve({ id: 'demo' }) }));
    expect(text(html)).toContain('劳动仲裁申请书（朝阳区仲裁委）');
  });

  it('状态提要仍是演示案件的阶段与期限', () => {
    const html = ssr(<CaseStatusBarBody status={demoCaseStatus()} />);
    expect(text(html)).toContain('仲裁准备');
  });
});

/* ── 五、结构守卫：接线回潮会被点名 ─────────────────────────── */

/**
 * 状态提要那两个 prop 是**跨 effect 那条缝**的接线：
 * `demo` 决定读演示值还是现查接口，`caseId` 决定查谁的案子。
 * 本仓 vitest 没有 DOM、SSR 跑不到 effect，这两个 prop 传错的后果在渲染判据里看不见——
 * `demo={true}` 会让每一个真实案件都读演示阶段，`caseId={'demo'}` 会让它去查演示案件，
 * 两者在上面**任何一条**判据下都是绿的。所以这里按源码行钉死。
 */
describe('结构守卫', () => {
  it('Workbench 把本案的 caseId 与「是不是演示案件」原样交给状态提要', () => {
    const lines = codeLines('app/(app)/case/[id]/_components/Workbench.tsx');
    expect(lines.filter((l) => l.includes('<CaseStatusBar')).map((l) => l.trim())).toEqual([
      '<CaseStatusBar caseId={caseId} demo={seeded} />',
    ]);
  });

  /**
   * 上一条只钉住「传的是 seeded」。seeded 本身若变成恒 true（或跟别的东西挂钩），
   * 那条守卫照样绿。判定的原文一并钉住，两句合起来才是完整的一句话。
   */
  it('seeded 的定义就是「这个 id 是演示案件」，没有第二种解释', () => {
    const lines = codeLines('app/(app)/case/[id]/_components/Workbench.tsx');
    expect(lines.filter((l) => l.includes('const seeded')).map((l) => l.trim())).toEqual([
      'const seeded = caseId === demoCase.id;',
    ]);
  });
});
