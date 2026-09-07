// app/src/app/__tests__/terms-live-ui.test.tsx
// 协议生效旗 LAWER_TERMS_LIVE 在**页面上**的两臂（经理裁决 2026-09-07）。
//
// 【这一组拦的是什么】旗的服务端那一半有自己的判据（lib/auth/__tests__/terms-live-flag.test.ts）。
// 页面这一半坏起来是另一种形态，而且更难看出来：
//  · 关臂上勾选框仍然渲染 ⇒ 用户勾了三个框、提交，服务端**不据它落行**——
//    他以为自己同意了一份协议，而库里什么都没有；
//  · 关臂上发码闸仍然盯着那两个 state ⇒ 页面上没有框，按钮永远是灰的，
//    旁边一句「先勾选下方的说明」指着一处空白，整站没有一个人能注册；
//  · 三张条款页少了那条横幅 ⇒ 用户读到的是一份看起来已经生效的合同；
//  · 开臂上横幅没退掉 ⇒ 协议正式发布之后，页顶还写着"尚未生效"。
// 四样都不影响页面渲染，删掉/写反了都不会有任何东西报错。
//
// 【为什么按渲染出来的字验】旗决定的是"摆不摆"，不是"逻辑对不对"。
// 只验源码里有没有那个 `termsLive &&` 的形态是：条件写反了照样绿。
//
// 【变异矩阵】2026-09-07 逐条实跑（改产线代码 → 跑本文件 → 改回），本文件 17 例：
//  · U-1 ConsentGate 改回无条件渲染                       ⇒ 2 失败 / 15 通过。
//  · U-2 发码闸改回只看两个勾选位（agreed 去掉旗那一支）  ⇒ 1 失败 / 16 通过。
//  · U-3 页脚「注册即表示你同意」改回无条件               ⇒ 2 失败 / 15 通过。
//  · U-4 TermsPreviewBanner 删掉旗判断（横幅永远挂着）    ⇒ 6 失败 / 11 通过。
//  · U-5 OverseasRow 的 unavailable 恒假                  ⇒ 1 失败 / 16 通过。
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {} }) }));

const { TERMS_LIVE_ENV } = await import('@/lib/auth/consent');
const {
  ADULT_CHECKBOX_LABEL,
  OVERSEAS_CHECKBOX_LABEL,
  OVERSEAS_SWITCH_LABEL,
  OVERSEAS_UNAVAILABLE_LABEL,
  TERMS_CHECKBOX_LABEL,
  TERMS_PREVIEW_BANNER,
} = await import('@/lib/consent');

const { default: LoginPage } = await import('@/app/login/page');
const { default: TermsPage } = await import('@/app/terms/page');
const { default: OverseasTermsPage } = await import('@/app/terms/overseas/page');
const { default: ProcessorsPage } = await import('@/app/terms/processors/page');
const { default: AiLabelingPage } = await import('@/app/terms/ai-labeling/page');
const { OverseasRow } = await import('@/app/(app)/settings/_components/PrivacyCard');

/** 旗按这一臂渲染一次，渲完立刻还原——本文件不给同一个 worker 里的别人留下开着的旗 */
function underFlag(live: boolean, render: () => string): string {
  if (live) process.env[TERMS_LIVE_ENV] = '1';
  else delete process.env[TERMS_LIVE_ENV];
  try {
    return render();
  } finally {
    delete process.env[TERMS_LIVE_ENV];
  }
}

const strip = (html: string): string => html.replace(/<[^>]+>/g, '');

beforeEach(() => {
  delete process.env[TERMS_LIVE_ENV];
});
afterAll(() => {
  delete process.env[TERMS_LIVE_ENV];
});

/* ───────────────────────── 登录页那三个框 ───────────────────────── */

describe('登录页：协议没生效时那三个勾选框整块不摆', () => {
  const CHECKBOXES = [TERMS_CHECKBOX_LABEL, ADULT_CHECKBOX_LABEL, OVERSEAS_CHECKBOX_LABEL];
  const login = (live: boolean) => underFlag(live, () => renderToStaticMarkup(<LoginPage />));

  it('量具自检：开臂上三个框都在（否则下面那条"都没有"是假绿）', () => {
    const text = strip(login(true));
    for (const label of CHECKBOXES) {
      expect(text, `开臂上就找不到「${label}」，这条判据失去了对象`).toContain(label);
    }
  });

  it('关臂：三个框一个都不渲染（变异：把 {termsLive && <ConsentGate/>} 改回无条件 → 本条红）', () => {
    const text = strip(login(false));
    for (const label of CHECKBOXES) {
      expect(text, `协议还没生效，页面却还在请用户勾「${label}」`).not.toContain(label);
    }
  });

  it('关臂：发码闸是开的——没有那句指着空白的「先勾选下方的说明」', () => {
    // 【为什么这句话就是闸】ChannelStep 只在 !gateOk 时渲染 gateHint。
    // 关臂上 agreed 恒真 ⇒ 这句不出现；闸没跟着改的形态是它出现，
    // 而它指的那"下方的说明"已经不在页面上了。
    const HINT = '先勾选下方的说明';
    expect(strip(login(true)), `开臂上就没有「${HINT}」，这条判据失去了对象`).toContain(HINT);
    expect(
      strip(login(false)),
      '关臂上按钮仍被闸着：页面上没有可勾的框，而提示让用户去勾',
    ).not.toContain(HINT);
  });

  it('关臂：页脚不再断言「注册即表示你同意」（那句话此刻不成立）', () => {
    const CLAIM = '注册即表示你同意';
    expect(strip(login(true))).toContain(CLAIM);
    expect(
      strip(login(false)),
      '三个框拿掉了，而"你注册就等于同意了那份协议"原样留在页脚',
    ).not.toContain(CLAIM);
  });

  it('AI 标识说明那条链两臂都在（它与协议是两件事，不跟着旗走）', () => {
    for (const live of [true, false]) {
      expect(login(live), `旗=${live} 时标识说明页的入口不见了`).toContain(
        'href="/terms/ai-labeling"',
      );
    }
  });

  it('关臂：这一页不再指向协议正文——协议不生效，注册路上就不该有它的入口', () => {
    // 【为什么"少一条链"在这里是对的】那条链的全部意义是民法典 §496 要的
    // "他在按下按钮之前读得到它"——而此刻按下按钮并不产生对那份文本的同意。
    // 留着它的形态是：注册页指着一份还在改的合同，用户读完以为自己受它约束。
    // 页**本身**仍然读得到（/terms 直接打开就是，顶上挂着预览横幅），
    // 首页页脚那条路也没动；关掉的只是"注册路上的那一条"。
    expect(login(true), '开臂上就没有这条链，这条判据失去了对象').toContain('href="/terms"');
    expect(login(false), '协议没生效，注册页却还指着它').not.toContain('href="/terms"');
  });

  it('关臂不影响这一页别的东西：手机号那一格照常在', () => {
    expect(strip(login(false))).toContain('手机号验证码登录，大约半分钟。');
  });
});

/* ───────────────────────── 三张条款页顶上的横幅 ───────────────────────── */

describe('条款页：协议没生效时顶上挂预览横幅', () => {
  const PAGES: [string, () => React.JSX.Element][] = [
    ['/terms', () => <TermsPage />],
    ['/terms/overseas', () => <OverseasTermsPage />],
    ['/terms/processors', () => <ProcessorsPage />],
  ];

  for (const [href, page] of PAGES) {
    it(`${href}：关臂有横幅、开臂没有（变异：把 TermsPreviewBanner 里的判断删掉 → 本条红）`, () => {
      const off = underFlag(false, () => renderToStaticMarkup(page()));
      expect(off, `${href} 上没有那条横幅：读的人会当它是已经生效的正本`).toContain(
        'data-terms-preview="1"',
      );
      expect(strip(off)).toContain(TERMS_PREVIEW_BANNER);

      const on = underFlag(true, () => renderToStaticMarkup(page()));
      expect(on, `${href} 协议发布之后页顶还写着"尚未生效"`).not.toContain(
        'data-terms-preview="1"',
      );
      expect(strip(on)).not.toContain(TERMS_PREVIEW_BANNER);
    });

    it(`${href}：横幅之外的正文两臂逐字相同（旗不许顺手改条款内容）`, () => {
      const off = underFlag(false, () => renderToStaticMarkup(page()));
      const on = underFlag(true, () => renderToStaticMarkup(page()));
      // 关臂产物剥掉横幅那一个元素之后，应当与开臂逐字节相同
      const withoutBanner = off.replace(/<p data-terms-preview="1"[^>]*>[\s\S]*?<\/p>/, '');
      expect(withoutBanner, `${href} 的正文跟着旗变了`).toBe(on);
    });
  }

  it('/terms/ai-labeling 不受旗控制：两臂都没有横幅（它不是这份协议的一部分）', () => {
    for (const live of [true, false]) {
      const html = underFlag(live, () => renderToStaticMarkup(<AiLabelingPage />));
      expect(html, `旗=${live} 时标识说明页也挂上了协议的横幅`).not.toContain(
        'data-terms-preview="1"',
      );
    }
  });
});

/* ───────────────────────── 设置页那张境外卡 ───────────────────────── */

describe('设置页：协议没生效时境外那一行换成「暂未开放」且开不动', () => {
  const row = (live: boolean | null, checked = false) =>
    renderToStaticMarkup(
      <OverseasRow live={live} checked={checked} disabled={false} onCheckedChange={() => {}} />,
    );

  it('旗关：标题是「境外模型暂未开放」，开关关着且禁用', () => {
    const html = row(false, true /* 库里那一位是开着的：更严的一臂 */);
    expect(strip(html)).toContain(OVERSEAS_UNAVAILABLE_LABEL);
    expect(html, '开关还是可点的：点下去页面显示已开启，而对话全部走境内').toContain('disabled');
    expect(
      html,
      '库里开关是开的就照着画：页面显示"已开启"，而 overseasModelsAllowed 恒 false',
    ).not.toContain('data-state="checked"');
  });

  it('旗开：回到常态，开关跟着库里那一位走（变异：把 unavailable 恒真 → 本条红）', () => {
    const html = row(true, true);
    expect(strip(html)).toContain(OVERSEAS_SWITCH_LABEL);
    expect(strip(html), '协议已经生效了还写着"暂未开放"').not.toContain(
      OVERSEAS_UNAVAILABLE_LABEL,
    );
    expect(html).toContain('data-state="checked"');
  });

  it('还没问到（me 还没回来）：画常态但禁用，不闪一句"暂未开放"再变回去', () => {
    const html = renderToStaticMarkup(
      <OverseasRow live={null} checked={false} disabled onCheckedChange={() => {}} />,
    );
    expect(strip(html)).toContain(OVERSEAS_SWITCH_LABEL);
    expect(strip(html)).not.toContain(OVERSEAS_UNAVAILABLE_LABEL);
    expect(html, '还没问到的时候开关是可点的').toContain('disabled');
  });
});
