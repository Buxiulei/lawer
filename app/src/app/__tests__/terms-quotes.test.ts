// app/src/app/__tests__/terms-quotes.test.ts
// 《用户服务协议》正文上**每一段引文**都要逐字对得上登记在册的官方原件。
//
// 【这条判据补的是哪个缺口】与 ai-labeling-quotes.test.ts 同一个缺口，只是换了一份表：
// 页面上的法条引文不经 knowledge/ 卡片，verify-quotes.py 扫不到 .tsx。
// 于是把「不得以律师名义从事法律服务业务」记成「不得以律师名义提供法律服务」、
// 把民法典 §496 第二款记成第一款、把生成式办法 §14 第二款的处置措施少抄一项，
// 页面照常渲染、读起来仍然像一句法条，一处都不会红——
// 而这一页正是我们与用户订立合同的地方。**引错条号比不写更糟**：
// 它给了一个看起来可以核对、实际核不回去的出处。
//
// 【尺子与那一份一致：只折空白，字形一律不折】引文是人从 text.txt 里**复制**过来的，
// 本来就该一个码位都不差。取不准时偏向报警：折得越少，"差一点"越会被判红。
//
// 【为什么另起一份判据，不并进 ai-labeling-quotes】那一份顺带钉死了
//「引到的每一份原件 kind 都是部门规章、official_host 都是 www.cac.gov.cn」——
// 那是它该有的牙（标识说明页依据的就是那两部规章）。协议正文引的多半是**法律**，
// 并进去只能把那条放松成"什么 kind 都行"，于是标识页那侧从此不设防。
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { TERMS_QUOTES, type TermsQuote } from '@/app/terms/quotes';

const KNOWLEDGE = path.resolve(__dirname, '../../../../knowledge');

/** 归一：只去掉全部空白（含换行与全角空格 U+3000）。字形一律不折。 */
function norm(s: string): string {
  return s.replace(/\s+/g, '');
}

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

const entries = Object.entries(TERMS_QUOTES) as [string, TermsQuote][];

/** 书名号里的那几个字。判据按它与登记簿里的正式名对齐。 */
function bareLawName(law: string): string {
  return law.replace(/[《》]/g, '');
}

/**
 * 把一部法拆成「条 → 款」。原件里**款就是行**（几份原件的行首缩进各不相同，
 * 归一时一并去掉），所以按行切就是按款切。
 *
 * 【为什么要拆到款，而不是"整份原件里能搜到"就算数】上面那条 includes 判据只证明
 * 这段话**在这部法里存在**，不证明它在我们标的那一条那一款。于是把民法典 §496 第二款
 * 记成第一款、把生成式办法 §14 两款对调，判据全绿——而页面上印着「《民法典》
 * 第四百九十六条第一款：…」，读的人拿着这个出处去查，查到的是另一段话，
 * 然后认定我们在编。**引错条号比不写更糟**，这句话写在本文件开头，
 * 而在这条判据补上之前，它只是一句写在注释里的话。
 *
 * 【项被数成款，这条已知且是往严的方向】有的条下面带（一）（二）（三）项，
 * 按行切会把项也数成一款。代价是"款号比真实款数大"时可能放过——
 * 而我们要拦的是**款号指错地方**，那一类照拦不误。
 */
function clausesOf(sourceId: string, article: string): string[] | null {
  const lines = originalText(sourceId)
    .split('\n')
    .map(norm)
    .filter((l) => l.length > 0);
  const isArticleStart = (l: string) => /^第[一二三四五六七八九十百千零]+条/.exec(l);
  for (let i = 0; i < lines.length; i += 1) {
    const m = isArticleStart(lines[i]);
    if (!m || m[0] !== article) continue;
    const out = [lines[i]];
    for (let j = i + 1; j < lines.length && !isArticleStart(lines[j]); j += 1) out.push(lines[j]);
    return out;
  }
  return null;
}

const CN_DIGIT: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

describe('协议正文的法条引文 ↔ 官方原件', () => {
  it('引文表非空，且横跨多部法（空表会让下面每一条都空过）', () => {
    expect(entries.length).toBeGreaterThan(8);
    const laws = new Set(entries.map(([, q]) => q.law));
    expect(laws.size, '协议只引到了一部法，八成是表被写坏了').toBeGreaterThan(4);
  });

  for (const [key, q] of entries) {
    it(`${key}（${q.law}${q.at}）逐字出自原件（变异：改掉引文里任一个字 → 红）`, () => {
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

  /**
   * 【这条与上面那条的分工】上面那条问「这段话在不在这部法里」，
   * 这条问「它在不在**我们标的那一条那一款**」。少了这一条，`at` 这一栏
   * 就是一段没有任何人核对的自由文本——而它恰恰是读者据以复核的唯一线索。
   */
  for (const [key, q] of entries) {
    const article = /^第[一二三四五六七八九十百千零]+条/.exec(q.at)?.[0];
    const kuan = /第([一二三四五六七八九])款/.exec(q.at)?.[1];
    it(`${key} 的出处「${q.at}」指得准（变异：把第二款写成第一款 → 红）`, () => {
      expect(article, `${key} 的 at「${q.at}」里读不出条号`).toBeTruthy();
      const clauses = clausesOf(q.source, article!);
      expect(clauses, `${q.source} 的原件里找不到${article}`).toBeTruthy();
      const target = norm(q.text);
      if (kuan) {
        const k = CN_DIGIT[kuan];
        const landed = clauses!.map((c, i) => (c.includes(target) ? i + 1 : 0)).filter(Boolean);
        expect(
          landed,
          `缺什么：页面上标的是${q.at}，而这段话不在该条第 ${k} 款里` +
            `（该条共 ${clauses!.length} 款，这段话实际落在第 ${landed.join('、') || '—'} 款）。\n` +
            '为什么缺：条号与原文是同一句话里的两半，只核原文等于只核了一半。\n' +
            '怎么办：照原件把 at 改对，别改引文去迁就 at。',
        ).toContain(k);
      } else {
        expect(
          clauses!.some((c) => c.includes(target)),
          `页面上标的是${q.at}，而这段话不在该条的任何一款里。`,
        ).toBe(true);
      }
    });
  }

  it('引到的每一份原件都登记在册、有 sha256、且来自官方站（变异：把 source 改成没登记过的 id → 红）', () => {
    for (const [key, q] of entries) {
      const row = REGISTRY.find((e) => e.source_id === q.source);
      expect(row, `${key} 引的 ${q.source} 不在 knowledge/sources.json 里`).toBeTruthy();
      expect(row!.content_sha256, `${q.source} 没有 sha256`).toMatch(/^[0-9a-f]{64}$/);
      expect(row!.official_host, `${q.source} 不是从官方站抓的`).toMatch(/\.gov\.cn$/);
      expect(['法律', '部门规章'], `${q.source} 的 kind 不是法律或部门规章`).toContain(row!.kind);
    }
  });

  /**
   * 【为什么法名也要核】条号对、原文对，而法名写错的形态是：读的人拿着
   *「《民法典》第十四条」去查，查到的是另一条完全无关的规定，然后认定我们在编。
   * 页面上法名与条号是**同一句话里的两半**，只核一半等于没核。
   */
  it('每段引文的法名与登记簿里的正式名对得上（变异：把《律师法》写成《律师执业法》→ 红）', () => {
    for (const [key, q] of entries) {
      const row = REGISTRY.find((e) => e.source_id === q.source)!;
      expect(q.law, `${key} 的 law 没带书名号`).toMatch(/^《.+》$/);
      expect(
        row.name.includes(bareLawName(q.law)),
        `${key} 写的法名「${q.law}」不是 ${q.source} 的正式名「${row.name}」的一部分`,
      ).toBe(true);
    }
  });

  /**
   * 【单钉这三条】它们是协议里"约束我们自己"的那几条：
   *   · 民法典 §496 第二款 —— 加粗与单独提示这件事的**法律依据**，没有它加粗只是排版；
   *   · 律师法 §13        —— 第二条第 1 款那句"我们不是律师"就是照它写的；
   *   · 生成式办法 §15    —— 「帮助与投诉」那一页存在的理由（公布处理流程和反馈时限）。
   * 引成别的款不会有任何报错，只会让协议里那几句自我约束在原件那一侧接不上。
   */
  it('三条自我约束的条款各就各位', () => {
    expect(TERMS_QUOTES.minfadian496.at).toContain('第四百九十六条');
    expect(TERMS_QUOTES.minfadian496.text).toContain('提示对方注意');
    expect(TERMS_QUOTES.lvshifa13.text).toContain('不得以律师名义从事法律服务业务');
    expect(TERMS_QUOTES.shengcheng15.text).toContain('公布处理流程和反馈时限');
  });
});
