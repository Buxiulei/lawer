/**
 * 设置页「我的数据」：协议附一第 7 项点名的四个入口——**案件删除、整案导出、账号注销、
 * 撤回同意**——在网页上真的点得到，且点下去打的是对的那条请求。
 *
 * 【这一组要拦的四种静默错法】
 *   · 四个入口只有 API/MCP，网页上一个都没有——而每一条接口自测都是绿的
 *     （注销与撤回同意的端点只认网页登录态，api key 一律 403，于是它们对任何用户都不可达）；
 *   · 撤回同意后回给用户的那句话把人指到「设置 → 我的同意」，而设置页上没有这四个字；
 *   · 删除 / 注销的第一步就把东西删了（两步式塌成一步，回包与两步式的第二步同形）；
 *   · 删除那条把 confirm_token 放进 DELETE 的请求体——一些客户端与网关会把 DELETE 的体丢掉，
 *     丢掉之后那次调用**看起来像第一步**：页面上点了删除却什么都没发生，且没有一处报错。
 *
 * 本仓库 vitest 跑 node 环境、没有 DOM，所以把组件当普通函数调用、在返回的元素树上取 props
 * 触发。只替掉 React 的状态层（useState / useEffect / useCallback）与 apiFetch，
 * **判定与接线仍是组件里真的那一份**。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isValidElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Props = Record<string, unknown>;
type Updater = unknown;

const bus = {
  inited: false,
  state: undefined as unknown,
  effects: [] as (() => void)[],
};

const api = {
  calls: [] as { path: string; method: string; body?: unknown }[],
  reply: (() => Promise.resolve({})) as (path: string, options: Props) => Promise<unknown>,
};

vi.mock('react', async (importOriginal) => {
  const real = await importOriginal<typeof import('react')>();
  return {
    ...real,
    useState: (init: unknown) => {
      if (!bus.inited) {
        bus.inited = true;
        bus.state = typeof init === 'function' ? (init as () => unknown)() : init;
      }
      return [
        bus.state,
        (u: Updater) => {
          bus.state = typeof u === 'function' ? (u as (p: unknown) => unknown)(bus.state) : u;
        },
      ];
    },
    useEffect: (fn: () => void) => {
      bus.effects.push(fn);
    },
    useCallback: (fn: unknown) => fn,
  };
});

const push = vi.fn<(href: string) => void>();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

const clearToken = vi.fn();
vi.mock('@/app/_ui/auth', () => ({ clearToken: () => clearToken() }));

vi.mock('@/app/_ui/api', () => ({
  apiFetch: (p: string, options: Props = {}) => {
    api.calls.push({
      path: p,
      method: (options.method as string) ?? 'GET',
      body: options.body,
    });
    return api.reply(p, options);
  },
  humanError: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

const {
  CONSENTS_SECTION_TITLE,
  CancelAccountSection,
  CaseDataSection,
  ConsentsSection,
  DataRightsCard,
} = await import('../_components/DataRightsCard');
const { EMOTION_REVOKED_NOTE } = await import('@/lib/lifecycle/consents');

// ───────────────────────────── 迷你渲染器 ─────────────────────────────

function walk(node: ReactNode, visit: (props: Props, type: unknown) => void): void {
  if (Array.isArray(node)) {
    for (const child of node as ReactNode[]) walk(child, visit);
    return;
  }
  if (!isValidElement(node)) return;
  const props = node.props as Props;
  visit(props, node.type);
  walk(props.children as ReactNode, visit);
  // description / title 这类"插槽"里也可能挂着元素（确认框的两份清单就在 description 上）
  for (const key of ['description', 'title']) {
    if (isValidElement(props[key])) walk(props[key] as ReactNode, visit);
  }
}

/** 元素树里的全部可见文字（含插槽），用来断言"页面上写着这句话"。 */
function textOf(node: ReactNode): string {
  const parts: string[] = [];
  const collect = (n: ReactNode): void => {
    if (typeof n === 'string' || typeof n === 'number') {
      parts.push(String(n));
      return;
    }
    if (Array.isArray(n)) {
      for (const c of n as ReactNode[]) collect(c);
      return;
    }
    if (!isValidElement(n)) return;
    const props = n.props as Props;
    collect(props.children as ReactNode);
    // 'text' 是 ServerCopy 的入参：服务端下发的那些句子挂在这个 prop 上，不在 children 里
    // （页面不许直接 {note} 出去，见 _ui/serverCopy 抬头）。不收它，页面上明明写着的话
    // 在这个迷你渲染器里会凭空消失，判据于是验了个空。
    for (const key of ['description', 'title', 'confirmLabel', 'aria-label', 'text']) {
      collect(props[key] as ReactNode);
    }
  };
  collect(node);
  return parts.join(' ');
}

/** 找一个"文字恰好是 label"的可点元素。 */
function button(tree: ReactNode, label: string): Props {
  let hit: Props | null = null;
  walk(tree, (props) => {
    if (typeof props.onClick !== 'function') return;
    if (textOf(props.children as ReactNode).trim() === label) hit = props;
  });
  if (!hit) throw new Error(`元素树上没有「${label}」这个按钮：${textOf(tree).slice(0, 200)}`);
  return hit;
}

function findByProp(tree: ReactNode, key: string): Props | null {
  let hit: Props | null = null;
  walk(tree, (props) => {
    if (hit === null && key in props) hit = props;
  });
  return hit;
}

type Section = () => ReactNode;

/** 渲染一次；把这一轮登记的 effect 都跑掉（load 就是在那里发的第一条请求）。 */
function render(section: Section): ReactNode {
  bus.effects = [];
  const tree = section() as ReactNode;
  for (const fn of bus.effects) fn();
  return tree;
}

/** 等 apiFetch 那几个 then 落地，再按新状态重渲一次。 */
async function settle(section: Section): Promise<ReactNode> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  bus.effects = [];
  return section() as ReactNode;
}

/** 按路径 + 方法路由的假后端。没配到的路径直接抛，免得判据在一个空回包上悄悄绿。 */
function backend(table: Record<string, unknown | ((body: unknown) => unknown)>) {
  // async：假后端抛出来的错必须变成**被拒的 Promise**，不是一个同步异常——
  // 同步抛的话组件那条 .catch 根本接不到，判据验的就成了另一件事。
  api.reply = async (p, options) => {
    const key = `${(options.method as string) ?? 'GET'} ${p}`;
    if (!(key in table)) throw new Error(`判据没给这条路配回包：${key}`);
    const v = table[key];
    return typeof v === 'function' ? (v as (b: unknown) => unknown)(options.body) : v;
  };
}

/**
 * 「会删什么 / 会留下什么」那两份清单元素。
 *
 * 断言的是**传给它的那两个数组**，不是渲染出来的文字：页面上那几行是服务端回包原样透传的，
 * 一旦有人在中间改写、截断或换成页面自己攒的一份，这里当场不等。
 */
function consequenceProps(node: ReactNode): Props {
  const hit = findByProp(node, 'removes');
  if (!hit) throw new Error(`这里没有会删什么/会留下什么那两份清单：${textOf(node).slice(0, 120)}`);
  return hit;
}

beforeEach(() => {
  bus.inited = false;
  bus.state = undefined;
  bus.effects = [];
  api.calls = [];
  push.mockClear();
  clearToken.mockClear();
});

// ───────────────────────────── 入口在不在 ─────────────────────────────

const SETTINGS_DIR = fileURLToPath(new URL('..', import.meta.url));

describe('四个入口在设置页上', () => {
  it('设置页真的挂了这张卡（变异：把 <DataRightsCard /> 从 page.tsx 拿掉 → 本条红）', () => {
    const page = fs.readFileSync(path.join(SETTINGS_DIR, 'page.tsx'), 'utf-8');
    expect(page).toContain('<DataRightsCard />');
    expect(page).toContain("from './_components/DataRightsCard'");
  });

  it('卡里三段齐全，四个动作各有一个按钮', () => {
    const tree = DataRightsCard() as ReactNode;
    const kinds = new Set<unknown>();
    walk(tree, (_p, type) => kinds.add(type));
    for (const section of [CaseDataSection, ConsentsSection, CancelAccountSection]) {
      expect(kinds.has(section), `卡里少了 ${section.name}`).toBe(true);
    }
  });

  it('撤回同意后那句话把人指到「设置 → 我的同意」，而这四个字真的在页面上（两处逐字一致）', () => {
    expect(EMOTION_REVOKED_NOTE).toContain(`设置 → ${CONSENTS_SECTION_TITLE}`);
    backend({ 'GET /me/consents': { consents: [] } });
    const tree = render(ConsentsSection);
    expect(textOf(tree)).toContain(CONSENTS_SECTION_TITLE);
  });
});

// ───────────────────────────── 撤回同意 ─────────────────────────────

const CONSENTS = [
  {
    kind: 'emotion',
    label: '情绪状态与危机识别记录',
    effect: '撤回后不再记录新的情绪档位。',
    revoked: false,
    revoked_at: null,
  },
  {
    kind: 'overseas',
    label: '境外模型处理',
    effect: '撤回后你的对话一律只走境内模型。',
    revoked: true,
    revoked_at: '2026-09-01 00:00:00',
  },
];

describe('撤回同意', () => {
  it('点「撤回同意」先弹确认框、一条请求都不发（变异：把 onClick 直接接到 revokeConsent → 本条红）', async () => {
    backend({ 'GET /me/consents': { consents: CONSENTS } });
    render(ConsentsSection);
    const listed = await settle(ConsentsSection);

    api.calls = [];
    (button(listed, '撤回同意').onClick as () => void)();
    expect(api.calls, '还没确认就把同意撤了').toEqual([]);

    const dialog = findByProp(ConsentsSection() as ReactNode, 'confirmLabel');
    expect(dialog!.open).toBe(true);
    // 后果那句话是服务端给的，页面照念不另写（过 ServerCopy 画出来，逐字不改）
    expect(textOf(dialog!.description as ReactNode)).toBe(CONSENTS[0].effect);
  });

  it('确认之后 POST /me/consents 带上 kind（已撤回的那一项没有按钮，撤不了第二遍）', async () => {
    backend({
      'GET /me/consents': { consents: CONSENTS },
      'POST /me/consents': { effect: '撤回后不再记录新的情绪档位。' },
    });
    render(ConsentsSection);
    const listed = await settle(ConsentsSection);
    // 两项里只有没撤过的那一项有按钮
    let buttons = 0;
    walk(listed, (p) => {
      if (typeof p.onClick === 'function' && textOf(p.children as ReactNode).trim() === '撤回同意') {
        buttons += 1;
      }
    });
    expect(buttons).toBe(1);

    (button(listed, '撤回同意').onClick as () => void)();
    api.calls = [];
    const dialog = findByProp(ConsentsSection() as ReactNode, 'confirmLabel');
    (dialog!.onConfirm as () => void)();

    expect(api.calls[0]).toEqual({
      path: '/me/consents',
      method: 'POST',
      body: { kind: 'emotion' },
    });
  });
});

// ───────────────────────── 整案导出 / 删除案件 ─────────────────────────

const CASES = { cases: [{ id: 7, title: '甲的档案' }] };

const DELETE_CONFIRM = {
  stage: 'confirm',
  case_id: 7,
  title: '甲的档案',
  confirm_token: 'tok-abc/def',
  removes: ['上传的材料条目与它们的原件文件'],
  keeps: ['已经出具过的存证证明'],
  retention_days: 30,
};

describe('整案导出', () => {
  it('点「导出整案副本」走 GET /cases/{id}/export，回包里的下载地址落到页面上', async () => {
    backend({
      'GET /cases': CASES,
      'GET /cases/7/export': {
        filename: '案件7-整案副本-2026-09-07.zip',
        download_url: '/api/v1/files/download/abc',
        expires_at: '2026-09-07 00:10:00',
        omissions: [],
        note: '导出不收费。',
      },
    });
    render(CaseDataSection);
    const listed = await settle(CaseDataSection);

    api.calls = [];
    (button(listed, '导出整案副本').onClick as () => void)();
    expect(api.calls).toEqual([{ path: '/cases/7/export', method: 'GET', body: undefined }]);

    const after = await settle(CaseDataSection);
    expect(textOf(after)).toContain('案件7-整案副本-2026-09-07.zip');
    expect(findByProp(after, 'href')!.href).toBe('/api/v1/files/download/abc');
  });
});

describe('删除案件', () => {
  it('第一步只取确认单，**不带 confirm_token**（变异：第一步就把令牌带上 → 本条红）', async () => {
    backend({ 'GET /cases': CASES, 'DELETE /cases/7': DELETE_CONFIRM });
    render(CaseDataSection);
    const listed = await settle(CaseDataSection);

    api.calls = [];
    (button(listed, '删除这个档案').onClick as () => void)();
    expect(api.calls).toEqual([{ path: '/cases/7', method: 'DELETE', body: undefined }]);
    expect(api.calls[0].path).not.toContain('confirm_token');
  });

  it('确认框里念的是服务端给的两份清单（页面不自己攒一份「会删什么」）', async () => {
    backend({ 'GET /cases': CASES, 'DELETE /cases/7': DELETE_CONFIRM });
    render(CaseDataSection);
    const listed = await settle(CaseDataSection);
    (button(listed, '删除这个档案').onClick as () => void)();
    const opened = await settle(CaseDataSection);

    const dialog = findByProp(opened, 'confirmLabel')!;
    expect(dialog.open).toBe(true);
    const lists = consequenceProps(dialog.description as ReactNode);
    expect(lists.removes).toEqual(DELETE_CONFIRM.removes);
    expect(lists.keeps).toEqual(DELETE_CONFIRM.keeps);
    expect(lists.tail).toContain('30 日后彻底删除');
    expect(textOf(dialog.title as ReactNode)).toContain('甲的档案');
  });

  it('第二步把 confirm_token 放在查询串里（变异：改成放请求体 → 本条红）', async () => {
    backend({
      'GET /cases': CASES,
      'DELETE /cases/7': DELETE_CONFIRM,
      'DELETE /cases/7?confirm_token=tok-abc%2Fdef': {
        stage: 'deleted',
        case_id: 7,
        purge_after: '2026-10-07 00:00:00',
        shares_revoked: 1,
        note: '已删除。',
      },
    });
    render(CaseDataSection);
    const listed = await settle(CaseDataSection);
    (button(listed, '删除这个档案').onClick as () => void)();
    const opened = await settle(CaseDataSection);

    api.calls = [];
    (findByProp(opened, 'confirmLabel')!.onConfirm as () => void)();

    expect(api.calls).toHaveLength(1);
    expect(api.calls[0].method).toBe('DELETE');
    // 令牌里的 '/' 必须转义，否则它会被当成路径的一节
    expect(api.calls[0].path).toBe('/cases/7?confirm_token=tok-abc%2Fdef');
    expect(api.calls[0].body, 'confirm_token 放进了 DELETE 的请求体').toBeUndefined();
  });
});

// ───────────────────────────── 注销账号 ─────────────────────────────

const CHALLENGE = {
  stage: 'challenge',
  confirm_token: 'cancel-token',
  sent_to: '138****8000',
  cases: 2,
  removes: ['全部免登录分享链接（确认那一刻立即失效）'],
  keeps: ['已经出具过的存证证明'],
  balance_note: '账户余额与已购套餐的处理方式尚未定稿。',
};

describe('注销账号', () => {
  it('第一步零删除：不带 code，回一份确认单并把码发出去（变异：第一步就带上 code → 本条红）', async () => {
    backend({ 'POST /me/cancel': CHALLENGE });
    const first = render(CancelAccountSection);

    api.calls = [];
    (button(first, '注销账号').onClick as () => void)();
    expect(api.calls).toEqual([{ path: '/me/cancel', method: 'POST', body: {} }]);

    const after = await settle(CancelAccountSection);
    const lists = consequenceProps(after);
    expect(lists.removes, '确认单没把「会删什么」原样念出来').toEqual(CHALLENGE.removes);
    expect(lists.keeps).toEqual(CHALLENGE.keeps);
    // 余额与套餐那句仍是【待主理人确认】，页面照念服务端给的那句，不替他定
    expect(lists.tail).toBe(CHALLENGE.balance_note);
    expect(textOf(after)).toContain('138****8000');
  });

  it('第二步 confirm_token + 验证码两样齐；成功后清本机 token 并回登录页', async () => {
    backend({
      'POST /me/cancel': (body: unknown) =>
        (body as { code?: string }).code
          ? {
              stage: 'cancelled',
              purge_after: '2026-10-07 00:00:00',
              cases_deleted: 2,
              shares_revoked: 1,
              note: '已注销。',
            }
          : CHALLENGE,
    });
    render(CancelAccountSection);
    (button(render(CancelAccountSection), '注销账号').onClick as () => void)();
    const opened = await settle(CancelAccountSection);

    // 码没填之前，确认按钮是禁着的
    expect(button(opened, '确认注销，删除我的全部档案').disabled).toBe(true);
    const input = findByProp(opened, 'inputMode')!;
    (input.onChange as (e: { target: { value: string } }) => void)({ target: { value: '424242' } });
    const filled = await settle(CancelAccountSection);

    api.calls = [];
    (button(filled, '确认注销，删除我的全部档案').onClick as () => void)();
    expect(api.calls).toEqual([
      { path: '/me/cancel', method: 'POST', body: { code: '424242', confirm_token: 'cancel-token' } },
    ]);

    await settle(CancelAccountSection);
    expect(clearToken, '注销成功却把本机那张 token 留着').toHaveBeenCalled();
    expect(push).toHaveBeenCalledWith('/login');
  });

  it('码错了不清 token、不跳走（错一次还能再输一次）', async () => {
    backend({
      'POST /me/cancel': (body: unknown) => {
        if (!(body as { code?: string }).code) return CHALLENGE;
        throw new Error('验证码错误，请检查。本次没有做任何改动。');
      },
    });
    (button(render(CancelAccountSection), '注销账号').onClick as () => void)();
    const opened = await settle(CancelAccountSection);
    (findByProp(opened, 'inputMode')!.onChange as (e: { target: { value: string } }) => void)({
      target: { value: '000000' },
    });
    const filled = await settle(CancelAccountSection);
    (button(filled, '确认注销，删除我的全部档案').onClick as () => void)();
    const failed = await settle(CancelAccountSection);

    expect(clearToken).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    expect(textOf(failed)).toContain('验证码错误');
  });
});
