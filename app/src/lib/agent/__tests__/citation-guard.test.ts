// app/src/lib/agent/__tests__/citation-guard.test.ts
// 案号运行时闸门。这条守的是 charter §7.1「不编造」——C04 全量跑实测被破过一次
// （S15 输出「（2023）京0105民初88888号」，知识库查无此号），而同一剧本此前连过两次。
// 提示词只能降低概率，确定性代码才守得住。
import { describe, expect, it } from 'vitest';

import {
  CitationGuard,
  extractCaseNumbers,
  isObviousPlaceholderSerial,
  normalizeCaseNo,
  UNVERIFIED_CITATION,
} from '../citation-guard';

/** 一张带真案号的 pack */
const PACK = {
  id: 'case-tanpan-poulie-shiwei-xieshang-15407',
  title: '谈判破裂案',
  body: '案号：（2023）京03民终15407号\n北京三中院……另见（2023）京0105民初6093号。',
};

function guard() {
  const g = new CitationGuard();
  g.allowFrom([PACK]);
  return g;
}

/** 把整段文本逐字符喂进闸门（最狠的分片，验证缓冲逻辑） */
function stream(g: CitationGuard, text: string, size = 1): string {
  let out = '';
  for (let i = 0; i < text.length; i += size) out += g.push(text.slice(i, i + size));
  return out + g.flush();
}

describe('真案号放行', () => {
  it('检索原文里逐字有的案号原样通过', () => {
    const g = guard();
    expect(stream(g, '依据（2023）京03民终15407号，北京三中院认定违法解除。')).toBe(
      '依据（2023）京03民终15407号，北京三中院认定违法解除。',
    );
    expect(g.found).toHaveLength(0);
  });

  it('同一张卡里的第二个案号一样放行', () => {
    const g = guard();
    expect(stream(g, '另见（2023）京0105民初6093号')).toContain('（2023）京0105民初6093号');
    expect(g.found).toHaveLength(0);
  });

  it('全半角与空格差异不误伤（归一化后比对）', () => {
    const g = guard();
    expect(normalizeCaseNo('(2023) 京03民终15407号')).toBe(normalizeCaseNo('（2023）京03民终15407号'));
    expect(stream(g, '依据 (2023) 京03民终15407号')).toContain('(2023) 京03民终15407号');
    expect(g.found).toHaveLength(0);
  });
});

describe('假案号拦截', () => {
  it('查无此号的案号被替换成【案号待核实】，用户看不到假号', () => {
    const g = guard();
    const out = stream(g, '北京有个案子判了 2N，（2023）京0105民初88888号。');
    expect(out).not.toContain('88888');
    expect(out).toContain(UNVERIFIED_CITATION);
    expect(g.found.map((v) => v.cited)).toEqual(['（2023）京0105民初88888号']);
  });

  it('逐字符流式喂入也拦得住——案号被切碎时必须先缓冲再判定', () => {
    const g = guard();
    const out = stream(g, '参见（2024）京01民终12345号。', 1);
    expect(out).not.toContain('12345');
    expect(out).toContain(UNVERIFIED_CITATION);
  });

  it('切片正好切在案号中间也拦得住', () => {
    for (const size of [2, 3, 5, 7, 11]) {
      const g = guard();
      const out = stream(g, '前文（2024）京01民终12345号后文', size);
      expect(out).not.toContain('12345');
      expect(out).toBe(`前文${UNVERIFIED_CITATION}后文`);
    }
  });

  it('真假混在一段里：真的放行、假的拦下', () => {
    const g = guard();
    const out = stream(g, '真的：（2023）京03民终15407号；编的：（2024）京01民终99999号。');
    expect(out).toContain('（2023）京03民终15407号');
    expect(out).not.toContain('99999');
    expect(g.found).toHaveLength(1);
  });

  it('一张卡都没检索到时，任何案号都拦下', () => {
    const g = new CitationGuard(); // 白名单为空
    const out = stream(g, '参见（2023）京03民终15407号');
    expect(out).toContain(UNVERIFIED_CITATION);
  });
});

describe('不误伤正常文本', () => {
  it.each([
    '依据京高法发〔2024〕534号《解答（一）》第 73 问',
    '（2026 年 8 月 19 日）我收到了解除通知',
    '月薪 22000 元，工龄 3 年 2 个月',
    '《劳动合同法》第三十八条第二项',
  ])('「%s」原样通过', (text) => {
    const g = guard();
    expect(stream(g, text)).toBe(text);
    expect(g.found).toHaveLength(0);
  });

  it('孤立的左括号不会把后续输出永久扣住', () => {
    const g = guard();
    const out = stream(g, '（这是一段普通的括号说明，里面没有案号）后面还有正文。');
    expect(out).toBe('（这是一段普通的括号说明，里面没有案号）后面还有正文。');
  });
});

describe('白名单可中途扩充（模型先检索再引用）', () => {
  it('检索到新卡之后，卡里的案号即可引用', () => {
    const g = new CitationGuard();
    expect(stream(g, '（2023）京03民终15407号')).toContain(UNVERIFIED_CITATION);

    const g2 = new CitationGuard();
    g2.allowFrom([{ id: 'x', body: '（2023）京03民终15407号' }]);
    expect(stream(g2, '（2023）京03民终15407号')).toContain('15407');
  });
});

describe('check()：文书走拒收而不是打补丁', () => {
  it('返回查无此号的列表，不改写内容——文书要由模型改对了重写', () => {
    const g = guard();
    const bad = g.check('本人依据（2024）京01民终88888号主张…', '文书《仲裁申请书》');
    expect(bad).toEqual(['（2024）京01民终88888号']);
    expect(g.found[0].where).toContain('仲裁申请书');
  });

  it('全是真案号时返回空数组', () => {
    expect(guard().check('依据（2023）京03民终15407号', '文书')).toEqual([]);
  });
});

describe('extractCaseNumbers', () => {
  it('抽得出多种括号形态，且去重', () => {
    expect(extractCaseNumbers('（2023）京03民终15407号 和 (2023)京03民终15407号 和 （2024）京01民初1号')).toHaveLength(3);
  });
});

describe('明显占位号启发式（manager 补充②）：不查库也知道是假的', () => {
  it.each([
    '（2023）京0105民初88888号',
    '（2024）京01民终12345号',
    '（2024）京01民终11111号',
    '（2024）京01民终54321号',
  ])('「%s」判为占位号', (n) => {
    expect(isObviousPlaceholderSerial(n)).toBe(true);
  });

  it.each([
    '（2023）京03民终15407号',
    '（2023）京0105民初6093号',
    '（2022）京0105民初33722号',
  ])('真实案号「%s」不误判', (n) => {
    expect(isObviousPlaceholderSerial(n)).toBe(false);
  });

  it('即便这个号出现在检索到的 pack 里，占位号照样拦——白名单与启发式是两道独立的闸', () => {
    const g = new CitationGuard();
    g.allowFrom([{ id: 'x', body: '示例：（2024）京01民终88888号' }]);
    expect(g.isSupported('（2024）京01民终88888号')).toBe(false);
    const out = g.push('参见（2024）京01民终88888号') + g.flush();
    expect(out).toContain(UNVERIFIED_CITATION);
  });
});

describe('豁免：「官方未公开案号」是我们鼓励的说法，不能误伤（manager 补充①）', () => {
  it.each([
    '北京市人社局 2025 年十大典型案例·案例六（官方发布，未公开案号）',
    '该案例官方未公开案号，谈判时报名头即可',
    '这是官方案例，未公开案号——所以我不给你编一个',
    '北京市人社局《2025年劳动人事争议仲裁十大典型案例》，官方本就不公开案号',
  ])('「%s」原样通过，且不计违规', (text) => {
    const g = guard();
    expect(stream(g, text)).toBe(text);
    expect(g.found).toHaveLength(0);
  });
});
