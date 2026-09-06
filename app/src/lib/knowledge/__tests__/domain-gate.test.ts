// app/src/lib/knowledge/__tests__/domain-gate.test.ts
// 领域闸：跨域检索默认关闭（设计稿 §13），以及缺省域的**召回快照**。
//
// 【这道闸守的是"召回集合"，不是"既有条目"】第二个领域包进库时，既有卡一条都没被改动——
// 改的是"同一句 query 会捞回哪一批卡"。而库里既有的全部判据（含 5400+ 条全量测试）
// 盯的都是条目：某张卡在不在、某个字段对不对。**召回集合变了，它们一条都不会红。**
// 实测形态（未过闸时，真实索引 259 张卡）：
//   query「诉讼时效」第一名是另一个领域的民法典 188 条卡（诉讼时效三年），
//   而缺省域用户问时效要的是本域时效口径——一个精确、可引用、且错的数字；
//   query「投诉」「退费」「知情同意」「危机 自杀」的前 5 名整屏都是另一个领域的卡。
//   region=北京 拦不住（那批卡 region 是全国）。
//
// 判据读**真实的 knowledge/**（不是夹具）：要守的正是真实库长出第二个领域包这件事。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_DOMAIN } from '@/lib/domains/registry';

import { __resetForTest, listPacks, packDomain, search } from '../index';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
/** __tests__ → knowledge → lib → src → app → 仓库根 */
const KNOWLEDGE_DIR = path.resolve(TEST_DIR, '../../../../..', 'knowledge');
const ORIGINAL_ENV = process.env.LAWER_KNOWLEDGE_DIR;

beforeEach(() => {
  process.env.LAWER_KNOWLEDGE_DIR = KNOWLEDGE_DIR;
  __resetForTest();
});

afterAll(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.LAWER_KNOWLEDGE_DIR;
  else process.env.LAWER_KNOWLEDGE_DIR = ORIGINAL_ENV;
  __resetForTest();
});

/**
 * 缺省域的召回**下限**：20 句 query 各配一个条数——前 8 条是复审实测泄漏的那 8 句，
 * 后 12 条是本域的核心问法。数字取自**本支之前的库**（第二个领域包尚未入库的那一版
 * index.json，220 张卡）逐 query 实测的 top-5 条数。
 *
 * 【为什么钉的是条数，而不是 top-5 的 id】钉 id 的那一版顺带把"库长什么样"也钉住了：
 * 别人的票往本域加一张卡、或调一个关键词，这 20 条就一起变红——而红的是**别人的票**；
 * 更坏的是那一刻的判断只有两种（"更新基线"或"闸破了"），判据本身给不出区分。
 * 条数下限只盯**反方向的坏事**：闸关过头，把本域的卡也一起挡了。加卡只会让条数上升，
 * 不给任何人留维护税。泄漏方向由下面那条逐 query 的零泄漏判据盯，那一条才是这道闸的正题。
 */
const RECALL_MIN_COUNT: ReadonlyArray<readonly [string, number]> = [
  ['投诉', 3],
  ['退费', 0],
  ['诉讼时效', 5],
  ['隐私泄露', 1],
  ['知情同意', 0],
  ['未成年人', 0],
  ['危机 自杀', 0],
  ['心理热线', 4],
  ['经济补偿 计算', 5],
  ['违法解除 2N', 5],
  ['竞业限制', 5],
  ['加班费 举证', 5],
  ['被迫解除', 5],
  ['调岗降薪', 5],
  ['年假', 5],
  ['工伤', 3],
  ['试用期', 5],
  ['社保', 5],
  ['双倍工资', 5],
  ['仲裁时效', 5],
];

const ALL_QUERIES = RECALL_MIN_COUNT.map(([q]) => q);
/** 复审实测泄漏的那 8 句（表的前 8 条）。零泄漏判据对整张表都跑，这里单拎出来是为了点名它们 */
const LEAK_QUERIES = ALL_QUERIES.slice(0, 8);

describe('跨域检索默认关闭（设计稿 §13）', () => {
  it('判据自身不空跑：库里确实有非缺省域的卡（一张都没有的话，下面几条全是空转）', () => {
    const others = listPacks().filter((m) => packDomain(m) !== DEFAULT_DOMAIN);
    expect(
      others.length,
      '库里一张非缺省域的卡都没有 ⇒ 这道闸没有任何东西可拦，本文件的判据全部退化成空跑',
    ).toBeGreaterThan(30);
  });

  it.each(ALL_QUERIES)('「%s」：不传 domain 时一张别的领域的卡都不回（变异：拿掉 passesFilters 的领域闸 → 红）', (query) => {
    const hits = search(query, { limit: 10 });
    const leaked = hits.filter((h) => packDomain(h) !== DEFAULT_DOMAIN).map((h) => `${h.id}(${packDomain(h)})`);
    expect(leaked, `这句 query 把别的领域的卡召回到了缺省域用户手里：${leaked.join('、')}`).toEqual([]);
  });

  it.each(LEAK_QUERIES)('「%s」不是"这些卡搜不到"，而是被闸拦住了：显式指定该域就有命中', (query) => {
    const hits = search(query, { limit: 10, domain: 'counseling' });
    expect(
      hits.length,
      '显式指定领域也搜不到 ⇒ 上一条判据其实是在测"这句 query 谁也匹不上"，不是在测闸',
    ).toBeGreaterThan(0);
    expect(hits.every((h) => packDomain(h) === 'counseling')).toBe(true);
  });

  // 【这一条钉的是"不传 domain 时闸什么"】本支按设计稿 §13 的字面实现：**不传 = 只回缺省域**，
  // 跨域要显式要。这个口径与"不传 = 不过滤（全库）"是同一处代码的两种相反读法，
  // 取舍尚无台账裁决——本判据不替谁决定，它只保证**口径被改的那一刻有人当场看见**：
  // 改成"不传 = 全库"时，这 20 条会连同上面的零泄漏判据一起红，
  // 而不是静默地多回一批别的领域的卡（回包 200、字段齐全、没有一处报错）。
  it.each(ALL_QUERIES)('「%s」：不传 domain 与显式传缺省域，结果逐 id 一致', (query) => {
    const implicit = search(query, { limit: 10 }).map((h) => h.id);
    const explicit = search(query, { limit: 10, domain: DEFAULT_DOMAIN }).map((h) => h.id);
    expect(
      implicit,
      '"不传 domain"与"显式传缺省域"给出了不同的召回 ⇒ 缺省语义被改过了（口径待裁，见本文件上方注释）',
    ).toEqual(explicit);
  });

  it.each(RECALL_MIN_COUNT)('「%s」缺省域召回不少于 %i 条（闸不能关过头，把本域的卡也挡了）', (query, min) => {
    expect(
      search(query, { limit: 5 }).length,
      `「${query}」的缺省域召回比上一版（220 张卡那一版）少了。往本域加卡只会让这个数变大，` +
        '变小说明本域的卡被挡住了——那不是"更新基线"的事。',
    ).toBeGreaterThanOrEqual(min);
  });

  // 【复审 P4-W2 二轮 minor⑤】此前查询侧对 opts.domain 一个字都不查：域名字拼错时
  // 过滤器一条都匹不上，回的是空列表 + 200 + 无错误码，上层照着"没有相关卡"往下讲。
  // 索引侧的闸管的是**条目**的 domain，管不到**调用方传进来**的那个。
  describe('查询侧的域名字也要被认（拼错不静默空手）', () => {
    /** 库里真有的那个非缺省域名字（现取，不在判据里抄死一个拼写） */
    function otherDomain(): string {
      const real = listPacks()
        .map(packDomain)
        .find((d) => d !== DEFAULT_DOMAIN);
      expect(real, '库里没有非缺省域的卡 ⇒ 本组判据无从构造"拼错的域名字"').toBeTruthy();
      return real!;
    }
    /** 把它改掉最后一个字母 = 一个谁也不认识的域名字 */
    const typoOf = (d: string) => `${d.slice(0, -1)}x`;

    it('判据自身不空跑：这个拼错的域名字确实不属于任何一张卡', () => {
      const typo = typoOf(otherDomain());
      expect(listPacks().some((m) => packDomain(m) === typo)).toBe(false);
    });

    it('传一个谁也不认识的 domain → 抛自述错误（变异：拿掉 search 里那道未知域闸 → 红）', () => {
      const typo = typoOf(otherDomain());
      expect(() => search('投诉', { domain: typo })).toThrow(/不认识/);
      // 错误里要说清"现在认得哪些"，否则调用方只知道自己错了、不知道该传什么
      expect(() => search('投诉', { domain: typo })).toThrow(new RegExp(DEFAULT_DOMAIN));
    });

    it('拼对的域名字照常可用（闸不能关过头：注册过的、以及库里卡声明过的，都算认识）', () => {
      expect(() => search('投诉', { domain: DEFAULT_DOMAIN })).not.toThrow();
      expect(() => search('投诉', { domain: otherDomain() })).not.toThrow();
    });
  });

  it('region 过滤替代不了领域闸（那批卡 region 是全国，北京用户照样吃得到）', () => {
    const others = listPacks().filter((m) => packDomain(m) !== DEFAULT_DOMAIN);
    expect(others.every((m) => m.region === '全国')).toBe(true);
  });
});

describe('index.json 的 domain 与卡片 frontmatter 同步（变异：卡上删掉 domain 而不重跑生成器 → 红）', () => {
  /** 卡片 frontmatter 里声明的 domain；没声明返回 undefined。只读第一对 --- 之间那段 */
  function domainInCard(relPath: string): string | undefined {
    const raw = fs.readFileSync(path.join(KNOWLEDGE_DIR, relPath), 'utf-8');
    const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(raw);
    if (!m) throw new Error(`${relPath} 缺少 frontmatter`);
    const line = /^domain:\s*(.+?)\s*$/m.exec(m[1]);
    return line ? line[1] : undefined;
  }

  // 【为什么比的是"解析后的域"，而不是两边的字段原样相等】卡上不写 domain 与写成缺省域，
  // 对检索是同一件事（加载器补齐，见 lib/knowledge 的 PackMeta.domain）。
  // 要求两边字段原样相等的形态是：生成器哪天把缺省域也显式写进 index.json，
  // 这条就在几百张一个字没动过的存量卡上整批变红，而库其实没变。
  // 真正要拦的分叉——卡上写 counseling 而索引里是缺省域（那批卡会出现在缺省域用户的结果里）——
  // 在解析后的比对里照样红。
  it('每一条索引条目解析出的 domain，都与它指向的卡片解析出的一致', () => {
    const drift: string[] = [];
    for (const meta of listPacks()) {
      const onCard = packDomain({ domain: domainInCard(meta.path) });
      if (onCard !== packDomain(meta)) {
        drift.push(`${meta.id}：index 算 ${packDomain(meta)}，卡里算 ${onCard}`);
      }
    }
    expect(
      drift,
      `index.json 与卡片 frontmatter 的 domain 分叉了：\n  ${drift.join('\n  ')}\n` +
        '重跑 `python3 scripts/gen-knowledge-index.py`。分叉期间检索按 index 走，' +
        '卡上写什么都不算数——而两边都不会报错。',
    ).toEqual([]);
  });

  it('判据自身不空跑：确实有卡在 frontmatter 里声明了非缺省域', () => {
    // 【为什么数的是卡片、不是索引条目】索引条目加载后恒有 domain（缺省补齐），
    // 拿它数"声明过的"等于数了全库，这条就恒真。
    const declared = listPacks().filter((m) => domainInCard(m.path) !== undefined);
    expect(declared.length, '一张卡都没在 frontmatter 里声明 domain ⇒ 上一条判据无从分叉').toBeGreaterThan(30);
    for (const m of declared) expect(domainInCard(m.path)).toBe(packDomain(m));
  });
});
