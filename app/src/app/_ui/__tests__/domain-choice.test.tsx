// app/src/app/_ui/__tests__/domain-choice.test.tsx
// 建案那一步的领域选择（设计稿 §13 落法 5、§16 分期 W4）。
//
// ─────────────── 这组守的是两件相反的事 ───────────────
// ① **开着第二个领域时，选项必须真的是注册表里那几个包**，label 逐字取自包。
//    坏法：控件里写死两行中文。写死的形态是——第三个包挂进来，注册页上一个字都不多，
//    而没有任何一处会报错；或者反过来，把某个包的 label 改了一个字，页面还印着旧的。
// ② **只开着一个领域时，这一屏与没有这个控件的时候逐字节一致**。
//    坏法：渲染成一个只有一项的单选、或者一句「当前只支持某某纠纷」。
//    两种都让每个注册的人先替一个不存在的选择停一次，而它们看起来都很正常、
//    也都不会让任何既有判据变红——既有判据只认「注册流程能不能走完」。
//
// 【为什么②要按字节比，而不是"看看有没有那句话"】看有没有那句话，只能挡住我这次
// 写下的那句；下次有人加一句别的（一行灰字、一个 aria-live 空容器、一段 margin），
// 那条判据照样绿。按字节比的意思是：**这一屏在单领域下的产物不许因为这个控件而改变**，
// 不管改变的是哪一个字节。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const { DomainChoice } = await import('../DomainChoice');
const { CompletionPane } = await import('@/app/login/_components/LoginFlow');
const { DOMAINS, DOMAINS_ENABLED_ENV, DEFAULT_DOMAIN, listDomains } = await import(
  '@/lib/domains/registry'
);

const ssr = (node: React.ReactNode) => renderToStaticMarkup(<>{node}</>);
const readSrc = (rel: string) => readFileSync(join(process.cwd(), 'src', rel), 'utf8');
const optionsOf = (keys: string[]) => keys.map((k) => ({ key: k, label: DOMAINS[k].label }));

afterEach(() => {
  delete process.env[DOMAINS_ENABLED_ENV];
});

/* ── ① 开着第二个领域：选项来自注册表 ─────────────────────────── */

describe('开着不止一个领域时', () => {
  it('每个包的 label 逐字摆出来，取值是 key（变异：把某个 label 抄成一句自己编的话 → 红）', () => {
    const keys = Object.keys(DOMAINS);
    expect(keys.length, '注册表里只有一个包，本组下面几条恒真').toBeGreaterThan(1);
    const html = ssr(<DomainChoice domains={optionsOf(keys)} value="" onChange={() => {}} />);
    for (const key of keys) {
      expect(html, `选项里没有「${DOMAINS[key].label}」`).toContain(DOMAINS[key].label);
      // 落进 cases.domain 的是 key，不是 label：这两者对不上时，用户选了 A 却建了 B 的档
      expect(html, `选项的取值不是 ${key}`).toContain(`value="${key}"`);
    }
  });

  it('选中的那一项是传进来的 value（页面记住了用户选的那个）', () => {
    const keys = Object.keys(DOMAINS);
    const picked = keys[1];
    const html = ssr(<DomainChoice domains={optionsOf(keys)} value={picked} onChange={() => {}} />);
    // shadcn 的 RadioGroupItem 用 aria-checked 表达选中态
    const items = [...html.matchAll(/<button[^>]*value="([^"]*)"[^>]*>/g)];
    expect(items.length, '一个可选项都没渲染出来').toBe(keys.length);
    const checked = [...html.matchAll(/<button([^>]*)>/g)]
      .filter((m) => /aria-checked="true"/.test(m[1]))
      .map((m) => /value="([^"]*)"/.exec(m[1])?.[1]);
    expect(checked).toEqual([picked]);
  });

  it('说清「选的这一类决定后面问什么」——选错了要重新建档这件事必须在选之前说', () => {
    const html = ssr(<DomainChoice domains={optionsOf(Object.keys(DOMAINS))} value="" onChange={() => {}} />);
    const text = html.replace(/<[^>]+>/g, '');
    expect(text).toContain('重新建');
  });
});

/* ── ② 只开着一个领域：这一屏一个字节都不许多 ───────────────── */

describe('只开着一个领域时（今天的生产缺省）', () => {
  it('控件整块不渲染，SSR 产物是空串（变异：把 `domains.length <= 1` 改成 `< 1` → 红）', () => {
    expect(ssr(<DomainChoice domains={optionsOf([DEFAULT_DOMAIN])} value="" onChange={() => {}} />)).toBe('');
  });

  it('清单还没问到（空数组）也不渲染：半截的选择控件会让人以为自己选过了', () => {
    expect(ssr(<DomainChoice domains={[]} value="" onChange={() => {}} />)).toBe('');
  });

  it('注册那一屏的 HTML 与「没有这个控件」时**逐字节一致**', () => {
    const withOne = ssr(
      <CompletionPane
        email="a@example.com"
        onEmailChange={() => {}}
        agreed={false}
        domains={optionsOf([DEFAULT_DOMAIN])}
        domain=""
        onDomainChange={() => {}}
        onBack={() => {}}
      />,
    );
    // 基线：这个控件根本不存在的那一版（清单为空 ⇒ DomainChoice 回 null，产物里一个节点都没有）
    const baseline = ssr(
      <CompletionPane
        email="a@example.com"
        onEmailChange={() => {}}
        agreed={false}
        onBack={() => {}}
      />,
    );
    expect(withOne).toBe(baseline);
    // 顺带钉住基线本身不是空的——两边都渲染失败时上面那句同样会绿
    expect(baseline.length).toBeGreaterThan(200);
  });

  /**
   * **「逐字节一致」说的只是 HTML，不是"完全没变化"**（2026-09-07 复审点名）。
   *
   * 注册补绑那一屏挂载时照样会问一次 `GET /api/v1/domains`——清单只有一项，
   * 于是控件不渲染、页面产物一个字节不差，但**请求日志与免鉴权端点面上多了一条**。
   * 这一次问答躲不掉：灰度开关只有服务端读得到（客户端包里 process.env 恒为 undefined），
   * 不问就永远只知道缺省领域，运维把第二个领域打开了页面也一个选项都不会多。
   *
   * 【为什么把它写成判据而不是写在交付说明里】写在说明里的那句话没人会再读第二遍，
   * 而"对既有用户完全无变化"这句话正是因此被说出口的。钉在这里，
   * 以后谁想把这次问答挪走或加一次，都会先撞见这段解释。
   */
  it('页面产物没变，但清单那一次问答照发不误——网络面不是零变化', () => {
    const loginFlow = readSrc('app/login/_components/LoginFlow.tsx');
    const domainChoice = readSrc('app/_ui/DomainChoice.tsx');
    // 挂载即问：这一行是**无条件的**（没有 `if (多领域)` 可言——那正是要问才知道的事）
    expect(loginFlow, '注册那一屏不再问领域清单了？那控件就永远只有缺省领域一项').toContain(
      'useEnabledDomains()',
    );
    expect(domainChoice, '问的不再是 /domains 那条端点').toContain("'/domains'");
    // 免鉴权：注册页要在建号之前就摆出选择，那一刻还没有任何凭据
    expect(domainChoice, '这一问带上了鉴权 = 注册页在拿不到凭据时问不出清单').toContain(
      'auth: false',
    );
  });

  it('灰度开关缺省下服务端给页面的清单就只有缺省领域（页面据此不摆控件）', () => {
    delete process.env[DOMAINS_ENABLED_ENV];
    const enabled = listDomains();
    expect(enabled.map((d) => d.key)).toEqual([DEFAULT_DOMAIN]);
    expect(
      ssr(
        <DomainChoice
          domains={enabled.map((d) => ({ key: d.key, label: d.label }))}
          value=""
          onChange={() => {}}
        />,
      ),
    ).toBe('');
  });

  it('开关里写上第二个领域之后，同一段代码就摆出控件了（不是"这个控件从来不出现"）', () => {
    process.env[DOMAINS_ENABLED_ENV] = Object.keys(DOMAINS).join(',');
    const enabled = listDomains();
    expect(enabled.length).toBeGreaterThan(1);
    expect(
      ssr(
        <DomainChoice
          domains={enabled.map((d) => ({ key: d.key, label: d.label }))}
          value=""
          onChange={() => {}}
        />,
      ),
    ).not.toBe('');
  });
});
