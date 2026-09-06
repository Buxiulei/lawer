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
  it('每一条都有 domain，且是注册过的领域（变异：往 index.json 塞一条 domain: "x" → 加载即抛）', () => {
    const packs = listPacks();
    expect(packs.length).toBeGreaterThan(0);
    const known = Object.keys(DOMAINS);
    for (const p of packs) {
      expect(typeof p.domain, p.id).toBe('string');
      expect(known, `${p.id} 的 domain`).toContain(p.domain);
    }
  });

  it('存量卡片全在缺省领域（本票只做管道与缺省领域的数据迁移，不写第二个领域的内容）', () => {
    expect(new Set(listPacks().map((p) => p.domain))).toEqual(new Set([DEFAULT_DOMAIN]));
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

  it('search 不带 domain ⇒ 不过滤（跨域检索是显式选择，不是默认拒绝）', () => {
    expect(search('经济补偿', { limit: 20 }).length).toBeGreaterThan(0);
  });

  /**
   * 生成器（python）里那份领域键是注册表的**影子**。两边分叉的形态是：
   * 注册表加了一个领域，而生成器把那个领域的卡判成非法 domain——或者更糟，
   * 生成器放行了一个注册表不认识的 domain，那批卡加载时全站抛错。
   */
  it('gen-knowledge-index.py 认的领域键覆盖注册表里的每一个（变异：往注册表加一个领域而不改脚本 → 红）', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'scripts/gen-knowledge-index.py'), 'utf-8');
    const m = /^DOMAINS = \{([^}]*)\}/m.exec(src);
    expect(m, 'gen-knowledge-index.py 里找不到 DOMAINS 集合').not.toBeNull();
    const inScript = [...m![1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
    for (const key of Object.keys(DOMAINS)) expect(inScript, `脚本缺领域键 ${key}`).toContain(key);

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
