// app/src/lib/knowledge/__tests__/domain-index.test.ts
// 知识索引按领域（设计稿 §13-3）。
//
// 【为什么这几条必须有】按领域过滤的失效形态**全是静默的**：
//   · 某批卡的 domain 漏了 ⇒ 它们在过滤时凭空消失，而检索照常返回 200 与更短的列表；
//   · 生成器认的领域键与注册表分叉 ⇒ 新领域的卡要么进不来、要么进来了没人认；
//   · 过滤条件写反 ⇒ 只回别的领域的卡，而每一张卡本身都是真的。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { DEFAULT_DOMAIN, DOMAINS } from '@/lib/domains/registry';

import { listPacks, search } from '..';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)), '..', '..', '..', '..');

describe('知识索引带 domain', () => {
  // 「塞一条不认识的 domain → 加载即抛」那条**负对照**在 index-guard.test.ts（⑨ 两条）：
  // 它有临时知识库夹具，能真的把 index.json 弄坏再看闸认不认。本条只查真实索引的现状。
  it('每一条都有 domain，且是注册过的领域', () => {
    const packs = listPacks();
    expect(packs.length).toBeGreaterThan(0);
    const known = Object.keys(DOMAINS);
    for (const p of packs) {
      expect(typeof p.domain, p.id).toBe('string');
      expect(known, `${p.id} 的 domain`).toContain(p.domain);
    }
  });

  /**
   * 【本条在 P4-W3 改过口径，原因写在这里】W1 写它时库里只有缺省领域一批卡，
   * 判据是「domain 的取值集合 = {缺省领域}」。W2 落了第二个领域的 39 张卡之后，
   * 那个写法只能整条删掉或改绿——两种都会把它守的东西一起丢掉。
   *
   * 它真正要守的是**布局与领域的对应**：一张卡在哪个目录下，决定它属于哪个领域。
   * 对不上的形态是——一张写在缺省领域目录里的卡自称属于第二个领域（或反过来），
   * 于是它对**两边**的用户都不可见，而检索照常返回 200 与一个更短的列表。
   */
  it('卡片所在目录与它的 domain 严格对应（变异：把一张卡的 domain 改成别的领域 → 红）', () => {
    const drift: string[] = [];
    for (const p of listPacks()) {
      const inSubPack = /^packs\/([^/]+)\//.exec(p.path)?.[1];
      // packs/<领域键>/ 下的卡必须属于那个领域；不在任何领域子目录下的（存量布局）属缺省领域
      const expected = inSubPack && inSubPack in DOMAINS ? inSubPack : DEFAULT_DOMAIN;
      if (p.domain !== expected) drift.push(`${p.id}（${p.path}）：domain=${p.domain}，按布局应是 ${expected}`);
    }
    expect(drift, `卡片布局与 domain 对不上：\n  ${drift.join('\n  ')}`).toEqual([]);
  });

  it('判据自身不空跑：两个领域的卡都真的在库里', () => {
    const byDomain = new Map<string, number>();
    for (const p of listPacks()) byDomain.set(p.domain, (byDomain.get(p.domain) ?? 0) + 1);
    for (const key of Object.keys(DOMAINS)) {
      expect(byDomain.get(key) ?? 0, `领域 ${key} 一张卡都没有，上面那条对它恒真`).toBeGreaterThan(0);
    }
  });

  it('search 带 domain ⇒ 只回该领域的卡；带一个没有卡的领域 ⇒ 空手（变异：把过滤条件删掉 → 红）', () => {
    const q = '经济补偿';
    const all = search(q, { limit: 20 });
    expect(all.length).toBeGreaterThan(0);
    expect(search(q, { limit: 20, domain: DEFAULT_DOMAIN }).map((p) => p.id)).toEqual(
      all.map((p) => p.id),
    );
    expect(search(q, { limit: 20, domain: '一个还没有任何卡的领域' })).toEqual([]);
  });

  /**
   * 【本条在 P4-W3 改过口径】W1 原本写的是「不带 domain ⇒ 不过滤」，而 W2 按设计稿 §13-3
   * 「跨域检索**默认关闭**」把过滤器改成了「不传 = 只回缺省领域」。两支合到一起时，
   * 原判据仍然是绿的——因为它只断言「结果非空」，而缺省领域的卡本来就非空。
   * 也就是说它在**新语义下恒真**，守不住任何东西。改成直接钉住默认关闭这件事。
   */
  it('search 不带 domain ⇒ 只回缺省领域（跨域是显式要的，不是忘了传就发生的）', () => {
    const other = Object.keys(DOMAINS).find((k) => k !== DEFAULT_DOMAIN);
    expect(other, '注册表里只有一个领域，本条恒真').toBeDefined();
    // 用第二个领域的卡一定命中、缺省领域一定不命中的词去问
    const q = '知情同意';
    expect(search(q, { limit: 20, domain: other }).length).toBeGreaterThan(0);
    for (const hit of search(q, { limit: 20 })) expect(hit.domain).toBe(DEFAULT_DOMAIN);
  });

  /**
   * 生成器（python）里那份领域键是注册表的**影子**，两边必须**严格相等**。
   *
   * 【为什么两个方向都要钉，且"多一个"那个方向更要紧】(复审 2026-09-06 点名，原来只钉了一向)
   *   · 脚本**少**一个注册表有的领域 ⇒ 那批卡生成时即被判非法 domain，当场失败，有人看见；
   *   · 脚本**多**一个注册表没有的领域 ⇒ 生成器放行、index.json 进仓库，
   *     而 loadIndex 不认识那个 domain 会抛错**且不缓存**——**全站每一轮对话**
   *     （预检索、knowledge_search、危机资源卡取卡）当场 500，连本来好好的那个领域一起。
   *     那条路径的负对照在 index-guard.test.ts「domain 是注册表不认识的」一条。
   */
  it('gen-knowledge-index.py 认的领域键与注册表**严格相等**（变异：脚本里多写/少写一个领域 → 红）', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'scripts/gen-knowledge-index.py'), 'utf-8');
    const m = /^DOMAINS = \{([^}]*)\}/m.exec(src);
    expect(m, 'gen-knowledge-index.py 里找不到 DOMAINS 集合').not.toBeNull();
    const inScript = [...m![1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
    // 少一个：那个领域的卡生成不出来
    for (const key of Object.keys(DOMAINS)) expect(inScript, `脚本缺领域键 ${key}`).toContain(key);
    // 多一个：生成器会放行一个加载器不认识的 domain，而那是全站 500
    for (const key of inScript) {
      expect(
        Object.keys(DOMAINS),
        `脚本认「${key}」而注册表没有它：生成器会放行这批卡，加载时全站抛错`,
      ).toContain(key);
    }

    const def = /^DEFAULT_DOMAIN = "([^"]+)"/m.exec(src);
    expect(def?.[1], '脚本的缺省领域与注册表不一致').toBe(DEFAULT_DOMAIN);
  });

  /**
   * `packs/<domain>/` 分包布局是**允许**的（设计稿 §13），但现在一张卡都还没搬。
   * 这条钉的是「脚本认得这种布局」——认不得的形态是 W2 建了 packs/<第二个领域>/ 之后，
   * 那批卡被判成缺省领域，于是第二个领域的用户检索到的全是第一个领域的卡。
   */
  it('生成器认 packs/<domain>/ 这种布局（变异：删掉 domain_of 里的路径分支 → 红）', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'scripts/gen-knowledge-index.py'), 'utf-8');
    expect(src).toContain('def domain_of(');
    expect(src).toMatch(/parts\[1\] in DOMAINS/);
  });
});
