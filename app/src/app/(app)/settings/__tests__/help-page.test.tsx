// app/src/app/(app)/settings/__tests__/help-page.test.tsx
// 「设置 → 帮助与投诉」这一页（协议第十二条第 1 款 /
//《生成式人工智能服务管理暂行办法》第十五条「设置便捷的投诉、举报入口，公布处理流程和反馈时限」）。
//
// 【这一组拦的是什么】§15 要的两半都能单独坏，而且坏了都不报错：
//   · 入口在，但设置页上没有任何一条指过去的路 —— "找不到"与"没有"在合规上同形；
//   · 表单在，但没公布时限 —— 用户提完不知道什么时候能有回音，于是隔天再提一条；
//   · 时限被写死在页面里，与协议第十二条各说各的 —— 两句都像承诺，只是数不一样；
//   · 服务邮箱被顺手编了一个 —— 页面上一个看起来完全正常、发过去没人收的地址。
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));
// 设置主页上那几张卡都是客户端件、要 fetch 与登录态；本组验的是那条入口链接。
vi.mock('@/app/(app)/settings/_components/AgentKeyCards', () => ({ AgentKeyCards: () => null }));
vi.mock('@/app/(app)/settings/_components/PreferencesCard', () => ({ PreferencesCard: () => null }));
vi.mock('@/app/(app)/settings/_components/RealnameCard', () => ({ RealnameCard: () => null }));
vi.mock('@/app/(app)/settings/_components/ReferralCard', () => ({ ReferralCard: () => null }));

const { default: HelpPage } = await import('@/app/(app)/settings/help/page');
const { ComplaintForm } = await import('@/app/(app)/settings/help/_components/ComplaintForm');
const { default: SettingsPage } = await import('@/app/(app)/settings/page');
const {
  HELP_COMPLAINTS_HREF,
  HELP_COMPLAINTS_TITLE,
  SERVICE_EMAIL_PENDING,
  TERMS_HREF,
} = await import('@/app/_ui/termsLinks');
const {
  COMPLAINT_ACK_WORKDAYS,
  COMPLAINT_BODY_MAX,
  COMPLAINT_KINDS,
  COMPLAINT_REPLY_WORKDAYS,
} = await import('@/lib/complaints-policy');

const pageHtml = renderToStaticMarkup(<HelpPage />);
const formHtml = renderToStaticMarkup(<ComplaintForm />);
const pageText = pageHtml.replace(/<[^>]+>/g, '');
const formText = formHtml.replace(/<[^>]+>/g, '');

describe('入口够得着（§15「便捷的投诉、举报入口」）', () => {
  it('设置页上有一条指过去的链接（变异：删掉那张卡 → 红）', () => {
    const html = renderToStaticMarkup(<SettingsPage />);
    expect(html, '设置页上找不到通往投诉入口的路').toContain(`href="${HELP_COMPLAINTS_HREF}"`);
    expect(html.replace(/<[^>]+>/g, '')).toContain(HELP_COMPLAINTS_TITLE);
  });

  it('这一页指得回协议第十二条（用户要能核对我们承诺过什么）', () => {
    expect(pageHtml).toContain(`href="${TERMS_HREF}"`);
    expect(pageText).toContain('第十二条');
  });
});

describe('表单三样齐：类型、描述、联系方式', () => {
  it('三类都摆在选项里（变异：漏掉「个人信息权利请求」→ 红）', () => {
    for (const k of COMPLAINT_KINDS) {
      expect(formHtml, `选项里没有「${k}」`).toContain(`value="${k}"`);
    }
    expect(formHtml.match(/<option/g)?.length).toBe(COMPLAINT_KINDS.length);
  });

  it('描述与联系方式两栏都在，且都标了必填', () => {
    expect(formText).toContain('描述');
    expect(formText).toContain('联系方式');
    expect(formHtml, '必填标记没画出来').toContain('必填');
    expect(formHtml).toContain('<textarea');
  });

  it('描述有长度上限，且上限就是 policy 里那个数', () => {
    // React 的 SSR 把这个属性原样输出成 maxLength（驼峰），不是 HTML 里的小写 maxlength
    expect(formHtml).toContain(`maxLength="${COMPLAINT_BODY_MAX}"`);
  });

  it('两样没填时提交按钮是禁用的，并说清还缺什么（禁用的按钮不解释自己＝一堵没有门的墙）', () => {
    expect(formHtml).toContain('disabled=""');
    expect(formText).toContain('还缺：描述、联系方式');
  });
});

describe('时限公布（§15「公布处理流程和反馈时限」）', () => {
  it('两个工作日数印在页上，且与 lib/complaints-policy 同源（变异：把 3 改成 5 → 红）', () => {
    expect(formText).toContain(`${COMPLAINT_ACK_WORKDAYS}`);
    expect(formText).toContain('个工作日内确认受理并给出编号');
    expect(formText).toContain(`${COMPLAINT_REPLY_WORKDAYS}`);
    expect(formText).toContain('个工作日内答复处理结果');
  });

  it('说清了任何人都可以举报，不限于本站用户（协议第十二条第 1 款）', () => {
    expect(formText).toContain('任何人都可以');
    expect(formText).toContain('向网信、市场监管等主管部门投诉、举报');
  });
});

describe('服务邮箱是占位，不是编出来的地址', () => {
  it('画成醒目占位（变异：写死一个 support@… → 红）', () => {
    expect(formHtml).toContain('data-pending="1"');
    expect(formText).toContain(`【${SERVICE_EMAIL_PENDING}】`);
  });

  it('页面上没有任何一个具体邮箱地址', () => {
    expect(
      `${pageText}${formText}`,
      '页面上出现了一个看起来完全正常、发过去却没有人收的地址',
    ).not.toMatch(/[\w.-]+@[\w.-]+\.\w+/);
  });
});
