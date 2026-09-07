// app/src/app/login/__tests__/consent-gate-ui.test.tsx
// 注册/登录页那组同意控件的**结构守卫**（协议附一 #1、#2、#6；民法典 §496 提示义务）。
//
// 【为什么合规文案需要结构守卫】三条重大条款提示、两个必勾框、境外那个可选框、
// 两条外链——**任意删掉一个，页面都照常能用，整套测试也照常绿**。
// 那正是合规文案最容易静默消失的形态：它不参与任何逻辑，删了没有任何东西会坏。
//
// 【2026-09-07 起它不再回答"用户看不看得见"】本文件把 ConsentGate **直接**渲染出来，
// 绕过了登录页那一处挂载点；而协议生效旗关着时那一处整块不渲染（见 LoginFlow）。
// 于是本组全绿只意味着"这组控件本身长得对"，不再意味着"注册路上摆着它"。
// 后一半在 app/__tests__/terms-live-ui.test.tsx（两臂各渲染一次整页 /login）。
// 不写这一句的形态是：某天旗的两臂被改反，本组照常 9 通过，读的人以为框还在。
//
// 【这条判据有多强，免得后来人高估】
// · 强：三条提示在不在、加粗在不在、三个框在不在、两条链指向对不对、可选那条的措辞在不在。
// · 弱：挡不住 Tailwind 没把类编进产物，也挡不住视觉上的层次（本仓 vitest 是 node 环境，
//   没有布局引擎）。"境外那个框看起来和上面两个一样"这种事，它判不出来。
//
// 【变异矩阵】2026-09-07 实跑（改 ConsentGate.tsx / lib/consent.ts、跑本文件、再改回），本文件 9 例：
//  · U-1 KEY_CLAUSE_NOTICES 里删掉「管辖」那一条        ⇒ 1 失败 / 8 通过。
//  · U-2 三条提示不再加粗（<strong> 换成 <span>）        ⇒ 1 失败 / 8 通过。
//  · U-3 境外那个勾选框整块删掉                          ⇒ 4 失败 / 5 通过。
//  · U-4 境外链接改指 /terms（与总协议同一页）           ⇒ 1 失败 / 8 通过。
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  ADULT_CHECKBOX_LABEL,
  KEY_CLAUSE_NOTICES,
  OVERSEAS_CHECKBOX_HINT,
  OVERSEAS_CHECKBOX_LABEL,
  OVERSEAS_TERMS_HREF,
  TERMS_CHECKBOX_LABEL,
  TERMS_HREF,
  TERMS_LINK_TEXT,
} from '@/lib/consent';

import { ConsentGate } from '../_components/ConsentGate';

/** 三个框都没勾的初始态——注册页第一眼看到的就是这个 */
const html = renderToStaticMarkup(
  <ConsentGate
    terms={false}
    adult={false}
    overseas={false}
    onTermsChange={() => {}}
    onAdultChange={() => {}}
    onOverseasChange={() => {}}
  />,
);

const text = html.replace(/<[^>]+>/g, '');

describe('三类重大条款提示（民法典 §496：提示 + 说明）', () => {
  it('免责、管辖、个人信息三条一条都不少', () => {
    // 只给一条协议链接，等于把提示义务折算成"用户会不会点进去"
    expect(KEY_CLAUSE_NOTICES).toHaveLength(3);
    for (const clause of KEY_CLAUSE_NOTICES) {
      expect(text, `「${clause.title}」这条提示没出现在页面上`).toContain(clause.title);
      expect(text, `「${clause.title}」的要点没出现在页面上`).toContain(clause.emphasis);
    }
  });

  it('三条的要点都是**加粗**的（提示义务落在"看得见"上，不是"写在那儿"）', () => {
    for (const clause of KEY_CLAUSE_NOTICES) {
      const bolded = new RegExp(`<strong[^>]*>${escapeRe(clause.emphasis)}</strong>`);
      expect(bolded.test(html), `「${clause.title}」的要点没加粗`).toBe(true);
    }
  });

  it('三条提示排在勾选框**之前**（读完再勾，不是勾完再读）', () => {
    const lastNotice = Math.max(...KEY_CLAUSE_NOTICES.map((c) => html.indexOf(c.emphasis)));
    const firstCheckbox = html.indexOf(TERMS_CHECKBOX_LABEL);
    expect(lastNotice).toBeGreaterThan(-1);
    expect(firstCheckbox).toBeGreaterThan(lastNotice);
  });
});

describe('两个必勾框 + 协议链接', () => {
  it('协议与年龄两个框各自独立出现', () => {
    // 合成一个框的形态是：用户为了登录顺手勾了，而我们事后说不清他确认过的是哪一条
    expect(text).toContain(TERMS_CHECKBOX_LABEL);
    expect(text).toContain(ADULT_CHECKBOX_LABEL);
  });

  it('协议链接指向 /terms，且在新标签页打开（别把人从填了一半的表单里带走）', () => {
    expect(html).toContain(TERMS_LINK_TEXT);
    const anchor = anchorFor(TERMS_HREF);
    expect(anchor, `页面上没有指向 ${TERMS_HREF} 的链接`).not.toBeNull();
    expect(anchor!).toContain('target="_blank"');
  });
});

describe('境外模型那个框：单独一项、可选、指向自己那页说明', () => {
  it('框在，且措辞就是主理人定的那一句', () => {
    expect(text).toContain(OVERSEAS_CHECKBOX_LABEL);
    expect(OVERSEAS_CHECKBOX_LABEL).toContain('Claude');
    expect(OVERSEAS_CHECKBOX_LABEL).toContain('境外');
  });

  it('页面上写明**可以不勾、不勾也能注册**', () => {
    // 少了这句的形态是：用户看不出这一个和上面两个有什么区别，于是照勾不误，
    // 而我们事后拿着一条"他自己勾的"记录，说不清他知不知道可以不勾。
    expect(text).toContain(OVERSEAS_CHECKBOX_HINT);
    expect(OVERSEAS_CHECKBOX_HINT).toContain('可以不勾');
  });

  it('链接指向 /terms/overseas，**不是**总协议那一页', () => {
    // 指错页的形态是：用户点开读了一遍总协议，以为自己读的是境外接收方说明
    expect(html).toContain(`href="${OVERSEAS_TERMS_HREF}"`);
    expect(OVERSEAS_TERMS_HREF).not.toBe(TERMS_HREF);
  });

  it('它排在两个必勾框**之后**（先把注册要件读完，再看可选项）', () => {
    expect(html.indexOf(OVERSEAS_CHECKBOX_LABEL)).toBeGreaterThan(html.indexOf(ADULT_CHECKBOX_LABEL));
  });
});

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 取出 href 恰好等于给定地址的那个 <a …> 开标签（属性顺序由 React 决定，别按位置切） */
function anchorFor(href: string): string | null {
  const tag = [...html.matchAll(/<a\b[^>]*>/g)].find((m) => m[0].includes(`href="${href}"`));
  return tag ? tag[0] : null;
}
