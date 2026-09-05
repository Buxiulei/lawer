/**
 * 文件解读页接真数据。
 *
 * ─────────────── 这组测的是什么 ───────────────
 * ① **端到端**：库里跑一次真的 doc_submit（假模型 + 直接粘原文），把 lib/docs 读出来的行
 *    原样喂进页面的映射与画法，看渲染出来的 HTML 里是不是这份真解读。
 *    上一版这一页对任何案件都渲染 mockDocs，页面看起来完全正常——有标题、有结论、
 *    有标红处数，只是那是「星曜网络」的文件。所以每条判据都配一句
 *    `not.toContain('星曜网络')`：光断言「画出了东西」挡不住这一类。
 * ② **三条岔路**：取数中 / 没取到 / 确实没有。后两者在屏幕上都是一片空白，
 *    把「没取到」画成「还没有」，等于对一个确实解读过文件的人说他没有。
 *    取数在 useEffect 里、SSR 跑不到，所以这里照同仓 real-drafts-branches 的老办法
 *    把 effect 推过去，只替掉 React 的状态层，判定与接线仍是组件里真的那一份。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

process.env.LAWER_DATA_KEY = Buffer.alloc(32, 5).toString('base64');
process.env.FILES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'real-docs-'));

vi.mock('@/app/_ui/discreet', () => ({
  useDiscreet: () => ({ discreet: false, setDiscreet: () => {}, toggle: () => {} }),
}));
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a>,
}));

/** 接口替身：`fails` 打开就抛，否则回 `rows`（形状照后端 DocListItem） */
const bus: { fails: boolean; rows: unknown[]; calls: string[] } = { fails: false, rows: [], calls: [] };
vi.mock('@/app/_ui/api', () => ({
  apiFetch: (p: string) => {
    bus.calls.push(p);
    return bus.fails ? Promise.reject(new Error('网络没连上')) : Promise.resolve({ docs: bus.rows });
  },
  humanError: (err: unknown) => (err instanceof Error ? `${err.message}。` : '出错了。'),
}));

/* ── hooks 台架（照 real-drafts-branches）：推帧期间接管三个 hook，渲染期间还给真 React ── */
const harness = {
  on: false,
  cursor: 0,
  slots: [] as Array<{ value: unknown }>,
  effects: [] as Array<() => unknown>,
};
vi.mock('react', async (importOriginal) => {
  const real = await importOriginal<typeof import('react')>();
  const isFn = (v: unknown): v is (...args: never[]) => unknown => typeof v === 'function';
  return {
    ...real,
    useState: (init?: unknown) => {
      if (!harness.on) return real.useState(init as never);
      const i = harness.cursor++;
      harness.slots[i] ??= { value: isFn(init) ? (init as () => unknown)() : init };
      const slot = harness.slots[i];
      return [
        slot.value,
        (next: unknown) => {
          slot.value = isFn(next) ? (next as (prev: unknown) => unknown)(slot.value) : next;
        },
      ];
    },
    useEffect: (fn: () => unknown, deps?: unknown[]) => {
      if (!harness.on) return real.useEffect(fn as never, deps as never);
      harness.effects.push(fn);
    },
    useCallback: (fn: unknown, deps?: unknown[]) =>
      harness.on ? fn : real.useCallback(fn as never, deps as never),
  };
});

const { RealDocs } = await import('../RealDocs');
const { RealDocBody } = await import('../RealDocView');
const { toDocView } = await import('../docsData');
const { runMigrations } = await import('@/lib/db/migrate');
const { gongdaoGrant } = await import('@/lib/billing');
const { GONGDAO_LEDGER_TYPE } = await import('@/lib/billing/pricing');
const { listDocs, getDoc, submitDoc } = await import('@/lib/docs');

const ssr = (node: ReactNode) => renderToStaticMarkup(<>{node}</>);
const text = (html: string) => html.replace(/<[^>]+>/g, '');
const SKELETON = 'data-slot="skeleton"';

const NOTICE =
  '解除劳动合同协议书\n' +
  '甲乙双方经协商，因本人个人原因申请离职，自 2026-09-30 起解除劳动合同。\n';

const FAKE_REVIEW = {
  summary: '这份协议把解除定性成个人原因。',
  advice: '改签',
  advice_detail: '把解除原因改成协商一致由公司提出之后再签。',
  findings: [
    { rule_id: 'xsjc-001', clause_ref: '因本人个人原因申请离职', issue: '解除原因被写成个人原因' },
  ],
};

/** 真跑一遍 doc_submit（报价 → 确认），回库里那份解读的读侧行 */
async function realDocRows() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const uid = Number(db.prepare('INSERT INTO users (email) VALUES (?)').run('a@t.com').lastInsertRowid);
  const caseId = Number(
    db.prepare('INSERT INTO cases (user_id, title) VALUES (?,?)').run(uid, '本人案件').lastInsertRowid,
  );
  gongdaoGrant(uid, 500, GONGDAO_LEDGER_TYPE.recharge, `top-${uid}`, null, db);
  const llm = { billingModel: 'fake', chatJSON: async () => JSON.stringify(FAKE_REVIEW) };

  const quoted = await submitDoc(db, { userId: uid, caseId, text: NOTICE, docKind: '解除通知' }, { llm });
  if (!quoted.ok || quoted.stage !== 'quote') throw new Error('报价没出来');
  const done = await submitDoc(
    db,
    { userId: uid, caseId, text: NOTICE, docKind: '解除通知', quoteId: quoted.quote.quote_id },
    { llm },
  );
  if (!done.ok || done.stage !== 'done') throw new Error('解读没做成');
  return { list: listDocs(db, caseId, uid), detail: getDoc(db, done.doc.id, uid)! };
}

function frame<P>(Comp: (props: P) => ReactNode, props: P): ReactNode {
  harness.on = true;
  harness.cursor = 0;
  harness.effects.length = 0;
  try {
    return Comp(props);
  } finally {
    harness.on = false;
  }
}

/** 首帧 → 跑 effect → 等 promise 落定 → 再推一帧。回**落定后**那一屏。 */
async function settled<P>(Comp: (props: P) => ReactNode, props: P): Promise<ReactNode> {
  harness.slots.length = 0;
  frame(Comp, props);
  const queued = [...harness.effects];
  expect(queued.length, '组件没有登记任何 effect：台架接错了 hook').toBeGreaterThan(0);
  for (const run of queued) run();
  await new Promise((resolve) => setTimeout(resolve, 0));
  return frame(Comp, props);
}

beforeEach(() => {
  bus.fails = false;
  bus.rows = [];
  bus.calls.length = 0;
});

describe('台架自证', () => {
  it('首帧是骨架，落定帧不是（否则下面的 not.toContain 全是空过）', async () => {
    const first = ssr(frame(RealDocs, { caseId: '1' }));
    expect(first).toContain(SKELETON);
    expect(ssr(await settled(RealDocs, { caseId: '1' }))).not.toContain(SKELETON);
    expect(bus.calls).toEqual(['/cases/1/docs']);
  });
});

describe('① 端到端：库里那份真解读被画了出来', () => {
  it('列表页画的是这份文件的标题、结论与标红处数，没有一个演示字段', async () => {
    const { list } = await realDocRows();
    bus.rows = list;
    const html = ssr(await settled(RealDocs, { caseId: '1' }));
    const plain = text(html);

    // 标题取自原文第一行（这张表没有 title 列，拿种类当标题会让同类的几份长得一样）
    expect(plain).toContain('解除劳动合同协议书');
    expect(plain).toContain('改签');
    expect(plain).toContain('1 处标红');
    expect(plain).toContain('粘贴的原文');
    // 真实案件不给「上传文件」：那条流水线是演示件，会把人送到样张
    expect(plain).not.toContain('上传文件');
    expect(plain).not.toContain('星曜网络');
    expect(plain).not.toContain('还没有解读过的文件');
  });

  it('详情页画的是真原文、真结论、真依据，且标红引文能在原文里对上', async () => {
    const { detail } = await realDocRows();
    const html = ssr(<RealDocBody caseId="1" doc={detail} />);
    const plain = text(html);

    expect(plain).toContain('因本人个人原因申请离职');
    expect(plain).toContain('改签');
    // severity 取自规则库常量（must），页面上是「必须改」；模型说什么不算数
    expect(plain).toContain('必须改');
    // 依据来自规则库那一条，不是模型编的
    expect(plain).toContain('534号§73');
    expect(plain).toContain('这份文件说了什么');
    expect(plain).not.toContain('星曜网络');
    // 高亮真的落在原文上：OcrView 按 indexOf 切片，对不上就一处也标不出来
    expect(detail.ocr_text!.includes(detail.risk_flags[0].quote)).toBe(true);
  });

  it('映射层：库里的 canonical 时间串会补上时区，不按本地时区漂八小时', () => {
    const view = toDocView({
      id: 3,
      case_id: 1,
      file_id: 2,
      doc_type: '解除通知',
      advice: '不签',
      advice_detail: '别签',
      risk_flags: [],
      title_line: '解除通知书',
      source_name: '通知.png',
      created_at: '2026-09-05 03:00:00',
    });
    expect(view.createdAt).toBe('2026-09-05T03:00:00Z');
    expect(view.docType).toBe('解除通知');
  });
});

describe('② 三条岔路：取不到 ≠ 没有', () => {
  /** 变异臂：把 `catch { setError(...) }` 换成 `setDocs([])` ⇒ 这条红 */
  it('接口抛错 ⇒ 说清没取出来 + 给重试，绝不说「还没有解读过的文件」', async () => {
    bus.fails = true;
    const plain = text(ssr(await settled(RealDocs, { caseId: '1' })));
    expect(plain).toContain('这一页没取出来');
    expect(plain).toContain('重试');
    expect(plain).not.toContain('还没有解读过的文件');
  });

  /** 变异臂：落定分支把 `docs={docs}` 换成 `docs={[]}` ⇒ 这条红 */
  it('取回一份 ⇒ 就画那一份，不落到空态', async () => {
    const { list } = await realDocRows();
    bus.rows = list;
    const plain = text(ssr(await settled(RealDocs, { caseId: '1' })));
    expect(plain).toContain('解除劳动合同协议书');
    expect(plain).not.toContain('还没有解读过的文件');
    expect(plain).not.toContain('重试');
  });

  /** 正对照：确实一份都没有时才轮到空态说话（否则上面两条可能只是空态坏了） */
  it('接口回空数组 ⇒ 这时才是空态，且给的是对话与证据库两个真去处', async () => {
    bus.rows = [];
    const html = ssr(await settled(RealDocs, { caseId: '1' }));
    expect(text(html)).toContain('还没有解读过的文件');
    expect(html).toContain('href="/case/1/ask"');
    expect(html).toContain('href="/case/1/evidence"');
    expect(text(html)).not.toContain('重试');
  });
});
