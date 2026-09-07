// app/src/app/(app)/settings/__tests__/consent-wiring.test.ts
// 设置页两处同意接线的**结构守卫**（经理裁决 2026-09-07 合入 P5-C1/C2/C3 时的两条）：
//   ① 实名卡的「已同意采用」初值取自服务端（GET /api/v1/me 的 consents），不是本地 false；
//   ② 开启境外模型那一屏用的是 /terms/overseas 那一份告知，站内不留第二份文案。
//
// 【为什么是结构守卫，而不是渲染出来验】本仓 vitest 跑 node 环境、没有 DOM，
// renderToStaticMarkup **不执行 useEffect**——而这两处恰恰都发生在 effect 里。
// 把它写成"渲染完断言按钮不见了"的形态是：判据永远绿，因为那次取数根本没跑过。
// 所以这里如实只守到源码这一层，并把守不到的部分写出来：
//   · 守得到：那次取数与那次赋值还在、设置页念的是同一份告知件；
//   · 守不到：取回来之后有没有真的用在按钮的显隐上。后者由
//     app/api/v1/__tests__/consent-routes.test.ts 守住**数据通路**那一半
//     （/api/v1/me 确实把 realname_adopt 带回来），两组合起来才是完整的一条链。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string => readFileSync(path.join(HERE, '..', rel), 'utf-8');

describe('实名卡：采用 NBDpsy 实名结果的同意状态来自服务端', () => {
  const src = read(path.join('_components', 'RealnameCard.tsx'));

  it('刷新时取一次 /me 的 consents（变异：删掉那次取数 → 本条红）', () => {
    expect(src, '这张卡不再从服务端读同意状态，昨天点过的人今天又会看见那个按钮').toContain(
      "apiFetch<{ consents: string[] }>('/me')",
    );
  });

  it('取回来的那一位真的落到 adoptGranted 上（变异：取了不用 → 本条红）', () => {
    expect(src).toContain('setAdoptGranted(me.consents.includes(CONSENT_KINDS.realnameAdopt))');
  });

  it('那次取数失败不把整张卡判成加载失败（认证发起不能被它挡住）', () => {
    // setLoadError / setUnauthorized 只属于外层那次 /realname/status
    const inner = src.slice(src.indexOf("apiFetch<{ consents: string[] }>('/me')"));
    const from = inner.indexOf('} catch {');
    expect(from, '那次取数外面没有自己的 catch，失败会冒到外层被判成整卡加载失败').toBeGreaterThan(0);
    // 只取到这个 catch 自己的右花括号为止：多截一点就会把外层那个 catch 一起读进来，
    // 于是这条判据永远红——而它红的原因与它要拦的事无关。
    const catchBlock = inner.slice(from, inner.indexOf('}', from + '} catch {'.length) + 1);
    expect(catchBlock).not.toContain('setLoadError');
    expect(catchBlock).not.toContain('setUnauthorized');
  });
});

describe('隐私卡：开启境外模型那一屏念的是 /terms/overseas 那一份告知', () => {
  const src = read(path.join('_components', 'PrivacyCard.tsx'));

  it('同意件从协议页那边引进来（变异：改回本地组件 → 本条红）', () => {
    expect(src).toContain("import { OverseasConsent } from '@/app/terms/overseas/OverseasConsent'");
  });

  it('站内不再有第二份境外告知文案（正本在 OverseasDetails）', async () => {
    // 【为什么盯的是这个名字】P5-C1 曾在 lib/consent.ts 里放过一份占位文案
    // （OVERSEAS_CONSENT_COPY：接收方 / 目的 / 种类 / 脱敏 / 权利五项）。
    // 两份告知慢慢分叉的形态是：用户点头时看的是设置页那一屏，而我们对外公示的是
    // /terms/overseas 那一页——《个人信息保护法》第三十九条要的是告知**并**取得单独同意，
    // 两段话不是同一段时，合规上等于没有取得对那份告知的同意。
    const mod = await import('@/lib/consent');
    expect(Object.keys(mod), 'lib/consent.ts 里又出现了第二份境外告知文案').not.toContain(
      'OVERSEAS_CONSENT_COPY',
    );
  });
});
