// app/src/app/__tests__/ai-labeling-quotes.test.ts
// 标识说明页上**每一段引文**都要逐字对得上登记在册的官方原件。
//
// 【这条判据补的是哪个缺口】页面上的法条引文是这个仓里唯一一处**不经 knowledge/ 卡片**
// 的引文：verify-quotes.py 核的是 knowledge/packs 下卡片的 facts，扫不到 .tsx。
// 于是把「文本的生成或者编辑服务」记成「文本生成或者编辑服务」、把两款并成一款、
// 把 §17 记成 §16，页面照常渲染、读起来仍然像一句法条，一处都不会红——
// 而这一页恰恰是我们向用户交代"凭什么这么做"的地方。引错条号比不写更糟：
// 它给了一个看起来可以核对、实际核不回去的出处。
//
// 【尺子比 python 那把更紧，这是有意的】scripts/knowledge_sources.normalize_quote 还做
// NFKC 与 markdown 记号剥除，因为它比的是**卡片正文**（引用块、加粗记号、
// 从 PDF 抽出来的全角字符都真实存在）。这一页的引文是人从 text.txt 里**复制**过来的，
// 本来就该一个码位都不差；只折空白（原件里段落间有换行）。
// 取不准时偏向报警：折得越少，"差一点"越会被判红，而这一页宁可红也不该悄悄放过。
// 也因此这里不调 String 的 NFKC 归一——那个写法被 lib/company 那道结构守卫按
// "有人在别处自己算公司名键"拦着（它按源码文本扫，连注释里的写法都算），
// 与本文件无关，不去动它。
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  LAW_QUOTES,
  SRC_BIAOSHI_BANFA,
  SRC_SHENDU_HECHENG,
  type LawQuote,
} from '@/app/terms/ai-labeling/quotes';

const KNOWLEDGE = path.resolve(__dirname, '../../../../knowledge');

/** 归一：只去掉全部空白（含换行与全角空格 U+3000）。字形一律不折。 */
function norm(s: string): string {
  return s.replace(/\s+/g, '');
}

/** 那份原件抽出来的纯文本（scripts/fetch-source.py 落的 text.txt）。 */
function originalText(sourceId: string): string {
  return fs.readFileSync(
    path.join(KNOWLEDGE, 'sources', 'originals', sourceId, 'text.txt'),
    'utf8',
  );
}

interface RegistryEntry {
  source_id: string;
  kind: string;
  name: string;
  official_host: string;
  url: string;
  content_sha256: string;
}

const REGISTRY: RegistryEntry[] = JSON.parse(
  fs.readFileSync(path.join(KNOWLEDGE, 'sources.json'), 'utf8'),
) as RegistryEntry[];

const entries = Object.entries(LAW_QUOTES) as [string, LawQuote][];

describe('标识说明页的法条引文 ↔ 官方原件', () => {
  it('引文表非空，且两份原件都被引到（空表会让下面每一条都空过）', () => {
    expect(entries.length).toBeGreaterThan(5);
    const used = new Set(entries.map(([, q]) => q.source));
    expect(used).toContain(SRC_BIAOSHI_BANFA);
    expect(used, '适用链条的第二跳没有引到深度合成规定').toContain(SRC_SHENDU_HECHENG);
  });

  for (const [key, q] of entries) {
    it(`${key}（${q.at}）逐字出自原件（变异：改掉引文里任一个字 → 红）`, () => {
      const body = norm(originalText(q.source));
      expect(
        body.includes(norm(q.text)),
        `缺什么：这段引文在 ${q.source} 的原件里找不到。\n` +
          '为什么缺：页面上的引文没有任何一处自动核对，改错一个字仍然读起来像法条。\n' +
          '怎么办：从 knowledge/sources/originals/' +
          `${q.source}/text.txt 里复制那一段，不要照记忆敲；` +
          '条文本身变了就先用 scripts/fetch-source.py 重新抓原件。',
      ).toBe(true);
    });
  }

  it('引到的每一份原件都登记在册，且是部门规章（变异：把 source 改成没登记过的 id → 红）', () => {
    for (const [key, q] of entries) {
      const row = REGISTRY.find((e) => e.source_id === q.source);
      expect(row, `${key} 引的 ${q.source} 不在 knowledge/sources.json 里`).toBeTruthy();
      expect(row!.kind, `${q.source} 的 kind 不是部门规章`).toBe('部门规章');
      expect(row!.official_host, `${q.source} 不是从官方站抓的`).toBe('www.cac.gov.cn');
      expect(row!.content_sha256, `${q.source} 没有 sha256`).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  /**
   * 【为什么单钉这一条】整条适用链条的落点就是这一项：本平台是"智能对话、智能写作"，
   * 所以标识办法 §4 才管得到我们。把它引成 §17 的别的项（人脸、语音）不会有任何报错，
   * 只会让这一页的推理在原件那一侧接不上——而读的人核不动两份规章。
   */
  it('链条落点引的是第（一）项：智能对话、智能写作', () => {
    expect(LAW_QUOTES.shendu17Item1.source).toBe(SRC_SHENDU_HECHENG);
    expect(LAW_QUOTES.shendu17Item1.at).toContain('第十七条第一款');
    expect(LAW_QUOTES.shendu17Item1.text).toContain('智能对话');
    expect(LAW_QUOTES.shendu17Item1.text).toContain('智能写作');
    // 标识办法 §4 那一跳必须指向深度合成规定 §17 第一款，否则链条第一环就断了
    expect(LAW_QUOTES.banfa4Head.text).toContain('《互联网信息服务深度合成管理规定》第十七条第一款');
  });
});
