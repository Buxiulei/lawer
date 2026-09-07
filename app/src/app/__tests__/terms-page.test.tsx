// app/src/app/__tests__/terms-page.test.tsx
// 《用户服务协议》正文页的渲染产物。
//
// 【这一组拦的是什么】协议页的失败形态全是**静默**的：
//   · 少了一条（比如第十二条），页面照常渲染、读起来通顺，只是那一条没订立；
//   · 「草案」抬头或附一附二跟着上了线，用户读到一份自称草案、还印着内部工单号的合同；
//   · 主理人还没定的空位被顺手写成一个像模像样的值（"1 公道值 = 1 元"），
//     而没有任何人做过这个决定；
//   · 加粗掉了——民法典 §496 第二款要的"合理方式提示对方注意"就没了落地形态，
//     而页面看起来只是"字体轻了一点"。
// 所以这一组按**渲染出来的字**验，不按源码验。引文与原件的逐字关系另有一组
//（terms-quotes.test.ts），两组分工不重叠。
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

const { default: TermsPage } = await import('@/app/terms/page');
const { TERMS_QUOTES } = await import('@/app/terms/quotes');
const { LAW_QUOTES } = await import('@/app/terms/ai-labeling/quotes');
const { AI_LABELING_TERMS_HREF } = await import('@/app/_ui/aiLabelingTerms');
const {
  HELP_COMPLAINTS_HREF,
  SERVICE_EMAIL_PENDING,
  TERMS_OVERSEAS_HREF,
  TERMS_PROCESSORS_HREF,
  TERMS_TITLE,
} = await import('@/app/_ui/termsLinks');
const { COMPLAINT_ACK_WORKDAYS, COMPLAINT_REPLY_WORKDAYS } = await import(
  '@/lib/complaints-policy'
);
const { DOMAINS } = await import('@/lib/domains/registry');

const html = renderToStaticMarkup(<TermsPage />);
const text = html.replace(/<[^>]+>/g, '');

/** 占位件的内容（<mark data-pending>…</mark> 里那一段，去标签） */
const pendingMarks = [...html.matchAll(/<mark data-pending="1"[^>]*>([\s\S]*?)<\/mark>/g)].map((m) =>
  m[1].replace(/<[^>]+>/g, ''),
);
/** 把占位块整段挖掉之后剩下的正文——用来验"占位没有以裸文本的形式漏在别处" */
const withoutPending = html.replace(/<mark data-pending="1"[^>]*>[\s\S]*?<\/mark>/g, '');

describe('协议正文页：十四条都在', () => {
  const SECTIONS = [
    ['一', '这份协议是什么'],
    ['二', '我们提供什么、不提供什么（重要）'],
    ['三', '账号与实名'],
    ['四', '生成合成内容的标识（请仔细阅读并理解）'],
    ['五', '个人信息与案件档案（重要）'],
    ['六', '证据存证'],
    ['七', '收费'],
    ['八', '使用规范与我们的处置'],
    ['九', '情绪支持与心理咨询转介'],
    ['十', '心理咨询服务纠纷领域的特别约定'],
    ['十一', '服务变更、中断与责任（重要）'],
    ['十二', '投诉、举报、通知与争议解决'],
    ['十三', '知识产权'],
    ['十四', '协议的变更与生效'],
  ] as const;

  for (const [no, title] of SECTIONS) {
    it(`第${no}条「${title}」在（变异：删掉这一节 → 红）`, () => {
      expect(text, `协议少了第${no}条`).toContain(title);
    });
  }

  it('条号按顺序出现（变异：把第十二条挪到第三条后面 → 红）', () => {
    const positions = SECTIONS.map(([, title]) => text.indexOf(title));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  /**
   * 【为什么标题在场还不够】上面几条只找标题。而**条号本身是引用协议的坐标**：
   * 用户投诉时写「你们第十二条承诺 3 个工作日」，我们的其它页面也逐处写着
   *「见第五条第 5 款」「协议第十二条」。条号被改坏或漏渲染时，标题照样在、
   * 页面照样通顺，只是全站所有指向条号的话都落空了——而没有一处会红。
   *
   * 所以这条按 <Section/> 真正渲染出来的那个 `<span class="num">` 逐个对：
   * 既核数量、又核**字形与顺序**。
   */
  it('十四个条号逐个渲染出来且顺序对（变异：把 no="十二" 改坏 → 红）', () => {
    const nums = [...html.matchAll(/<span class="num[^"]*">([^<]*)<\/span>/g)].map((m) => m[1]);
    const sectionNums = SECTIONS.map(([no]) => no);
    expect(
      sectionNums.filter((no) => nums.includes(no)),
      '有条号没渲染出来，或渲染成了别的字——全站写着「见第 X 条」的地方会一起落空',
    ).toEqual([...sectionNums]);
    // 顺序：条号在页面上出现的先后要与协议编号一致
    const order = sectionNums.map((no) => html.indexOf(`>${no}</span>`));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});

describe('协议正文页：草案的痕迹一点都不许上屏', () => {
  for (const word of ['草案', 'v0.2', '产品同步', '附一', '附二', 'P5 合规', '台账']) {
    it(`正文里没有「${word}」（变异：把附一整表搬上页面 → 红）`, () => {
      expect(text, `内部施工说明漏到了用户面前：「${word}」`).not.toContain(word);
    });
  }

  it('标题是协议本身的名字，不带任何限定词', () => {
    expect(text).toContain(`土八鼠${TERMS_TITLE}`);
  });
});

describe('协议正文页：待确认的空位', () => {
  /**
   * 【为什么数它】主理人还没定的东西有七八处（换算、赠送额度、套餐退款、守望欠费、
   * 短信与实名核验服务商名称、境外出境路径、服务邮箱）。它们**必须看得见**：
   * 顺手写一个像模像样的值上去，页面读起来完全正常，而没有任何人做过那个决定。
   */
  it('占位至少有七处，且每一处都画成了醒目样式（变异：把 <Pending/> 换成普通文字 → 红）', () => {
    expect(pendingMarks.length, '协议里的待确认空位少于七处，八成是有人替主理人填上了').toBeGreaterThanOrEqual(
      7,
    );
  });

  it('没有一处待确认是以裸文本漏在正文里的（变异：手写一个【待主理人确认：…】 → 红）', () => {
    expect(
      withoutPending.replace(/<[^>]+>/g, ''),
      '有一处「待主理人确认」没走 <Pending/>，它在页面上与正文同色，校对时会被一眼扫过去',
    ).not.toContain('待主理人确认');
  });

  it('服务邮箱那一处是占位，不是编出来的地址（变异：写死一个 support@… → 红）', () => {
    expect(pendingMarks.some((m) => m.includes(SERVICE_EMAIL_PENDING))).toBe(true);
    expect(text, '协议里出现了一个具体邮箱地址').not.toMatch(/[\w.-]+@[\w.-]+\.\w+/);
  });
});

describe('协议正文页：重大条款加粗（民法典 §496 第二款 / 消保法 §26）', () => {
  const keyTerms = [...html.matchAll(/<strong data-key-term="1"[^>]*>([\s\S]*?)<\/strong>/g)].map(
    (m) => m[1].replace(/<[^>]+>/g, ''),
  );

  it('加粗的条款有一批，不是零星几处（变异：把 <Key/> 全换成普通文字 → 红）', () => {
    expect(keyTerms.length).toBeGreaterThanOrEqual(20);
  });

  /**
   * 【单钉这几句】它们是三类"与用户有重大利害关系"的典型：免责、管辖、个人信息。
   * 掉了加粗不影响渲染，但《民法典》第四百九十六条第二款说的正是——
   * 未履行提示义务、致使对方没有注意到的，对方可以主张该条款不成为合同的内容。
   */
  const MUST_BE_BOLD = [
    '土八鼠是法律信息整理与陪跑工具。我们没有律师执业证书，不以律师名义提供法律服务，不替你担任诉讼代理人或辩护人。',
    '服务输出是人工智能生成合成内容，不构成律师意见，不形成委托代理关系。',
    '未满十八周岁的人不得注册或使用。',
    '链接免登录，谁拿到谁能打开，请只发给你信任的人',
    '境外模型默认关闭。',
    '服务输出不构成对纠纷结果的任何承诺。',
    '本协议不设责任上限；法律规定不得免除或限制的责任，本协议不予免除或限制。',
    '任何一方均可向被告住所地有管辖权的人民法院提起诉讼',
    '已购买且未使用的套餐部分按剩余比例退回',
  ];
  for (const line of MUST_BE_BOLD) {
    it(`加粗了：「${line.slice(0, 14)}…」（变异：改成普通 <span> → 红）`, () => {
      expect(text, '这句话根本不在页面上').toContain(line);
      expect(
        keyTerms.some((t) => t.includes(line)),
        '这一句与用户有重大利害关系，却没有加粗——提示义务没有落地形态',
      ).toBe(true);
    });
  }
});

describe('协议正文页：每一段引文都印了原文', () => {
  for (const [key, q] of Object.entries(TERMS_QUOTES)) {
    it(`${key} 的原文与出处都在页面上（变异：只写条号不印原文 → 红）`, () => {
      expect(text, `${key} 的原文没印出来`).toContain(q.text);
      expect(text, `${key} 没写清出自哪一部法的哪一条`).toContain(`${q.law}${q.at}`);
    });
  }

  it('标识办法那三条（§8 / §10 两款）借的是标识说明页那份表，不另抄一遍', () => {
    for (const q of [LAW_QUOTES.banfa8, LAW_QUOTES.banfa10Duty, LAW_QUOTES.banfa10Ban]) {
      expect(text).toContain(q.text);
    }
  });
});

describe('协议正文页：四条对外的路都指得出去', () => {
  const LINKS = [
    [AI_LABELING_TERMS_HREF, '第四条第 6 款说标识说明页是本条的组成部分'],
    [TERMS_OVERSEAS_HREF, '第五条第 5 款说境外模型另有逐项说明'],
    [TERMS_PROCESSORS_HREF, '第五条第 7 款说受托方清单在另一页'],
    [HELP_COMPLAINTS_HREF, '第十二条第 1 款说投诉入口在站内'],
  ] as const;

  for (const [href, why] of LINKS) {
    it(`指得到 ${href}（${why}）`, () => {
      expect(html, `协议里写着有这么一页，却没有一条能点过去的链接：${href}`).toContain(
        `href="${href}"`,
      );
    });
  }
});

describe('协议正文页：时限与常量同源', () => {
  it('第十二条印的两个工作日数就是 lib/complaints-policy 那两个（变异：把页面上的 3 改成 5 → 红）', () => {
    expect(text).toContain(`${COMPLAINT_ACK_WORKDAYS} 个工作日内确认受理`);
    expect(text).toContain(`${COMPLAINT_REPLY_WORKDAYS} 个工作日内答复处理结果`);
  });

  /**
   * 【为什么还要再钉一次数字本身】上面那条只证明"页面与常量同源"——
   * 它是一条**同义反复**：把常量从 3 改成 5，页面跟着变成 5，判据照旧全绿，
   * 而我们对外承诺过的那个数悄悄变了。同源是必要的，不是充分的。
   *
   * 这两个数是《用户服务协议》第十二条第 1 款**逐字承诺**的，
   * 也是《生成式人工智能服务管理暂行办法》第十五条要求"公布"的那个反馈时限。
   * 要改它，得先改协议正本（docs/legal/用户服务协议-草案.md）并由经理裁定，
   * 不能从代码这一侧顺手改掉。所以这里钉死字面值。
   */
  it('两个时限就是协议承诺的 3 / 15（变异：把常量改成 5 → 红）', () => {
    expect(
      COMPLAINT_ACK_WORKDAYS,
      '协议第十二条承诺的是 3 个工作日内确认受理。要改先改协议正本并经经理裁定。',
    ).toBe(3);
    expect(
      COMPLAINT_REPLY_WORKDAYS,
      '协议第十二条承诺的是 15 个工作日内答复 / 办结。要改先改协议正本并经经理裁定。',
    ).toBe(15);
  });
});

describe('协议正文页：领域条数（接第三个领域时这条必须红）', () => {
  /**
   * 【为什么这条是「数个数」而不是「逐个领域找名字」】协议里的领域名是**合同措辞**
   *（「心理咨询服务纠纷」），领域包里的 label 是**产品措辞**（「心理咨询纠纷」），
   * 两者今天就不一样。拿 label 去页面里找的形态是：它今天就红，
   * 而红的原因与"协议漏了一个领域"毫无关系——一条一开始就红的判据会被立刻改绿或删掉。
   *
   * 所以这里钉的是**数量**：注册表里多一个领域，这条红，逼着人回来逐条核
   * 第二条第 5 款、第三条第 4 款、第四条第 1 款、第五条第 4 款、第九条与第十条。
   * 那几款点名了领域，而页面在词表守卫的名单上（page-domain-guard 的 LEGAL_INSTRUMENT_FILES），
   * 词表那道闸不会替它响。
   */
  it('注册表里是两个领域，协议第二条第 5 款也只写了两类纠纷', () => {
    expect(
      Object.keys(DOMAINS).length,
      '领域注册表变了。回去逐条核协议里点名领域的六款（二.5 / 三.4 / 四.1 / 五.4 / 九 / 十），' +
        '改完把这里的数字一起改。',
    ).toBe(2);
    expect(text).toContain('服务目前覆盖北京市');
    expect(text).toContain('领域之外的问题，服务会明确告诉你不在范围内');
  });

  it('第四条第 1 款逐个行当写出了显式标识的后半句', () => {
    expect(text).toContain('不构成律师意见，不形成委托代理关系');
    expect(text).toContain('不构成诊断、治疗或督导意见');
  });

  it('第五条第 4 款把两个行当的分享页差异写清了（一个替换、一个原样）', () => {
    expect(text).toContain('〔已脱敏〕');
    expect(text).toContain('分享页不做替换，正文按原样展示');
  });
});

describe('第五条第 5 款：单独同意的**采集点**与规格正本一致', () => {
  // 【守的是哪种失效】C3 那一版把这一款写成「你在设置中开启前，我们会……征得你的
  // 单独同意」。而正本 v0.2 五.5（3）的原话是「这一项需要你在**同意本协议时单独勾选**」——
  // 采集点是注册页那个单独勾选框（默认未勾），设置页只是**此后可改**的地方。
  // 两种写法都读得通、页面都照常渲染、同意也都真的取得了，对不上的是**我们公示的
  // 那句话与实际实现**：而这一页正是日后要拿去证明"我们是怎么取得这次同意的"的东西。
  // （经理裁决 2026-09-07 C3 major。）
  const MUST_SAY = [
    '需要你单独勾选同意',
    '这一项需要你在同意本协议时单独勾选。',
    '你可以随时在设置中改变选择；改变只对此后的处理生效。',
    '不勾选的，你仍可使用全部服务，只是所有分析都由境内模型完成。',
    // §39 的告知项与「本款的组成部分」这句定性都来自正本（2）
    '境外接收方为 Anthropic, PBC',
    '页面（本款的组成部分）',
  ];
  for (const line of MUST_SAY) {
    it(`正本这一句在页面上：「${line.slice(0, 16)}…」`, () => {
      expect(text).toContain(line);
    });
  }

  it('「同意本协议时单独勾选」那一句加粗了（重大利害关系条款，民法典 §496 第二款）', () => {
    const keys = [...html.matchAll(/<strong[^>]*>([\s\S]*?)<\/strong>/g)].map((m) =>
      m[1].replace(/<[^>]+>/g, ''),
    );
    expect(keys.some((k) => k.includes('这一项需要你在同意本协议时单独勾选。'))).toBe(true);
  });

  it('不再把采集点说成"设置中开启前"（变异：改回 C3 那一版措辞 → 本条红）', () => {
    expect(text, '页面又把单独同意的采集点说成了设置页').not.toContain('你在设置中开启前');
  });
});
