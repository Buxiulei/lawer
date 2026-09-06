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
 * 缺省域的召回快照：**基线取自本支之前的库**（第二个领域包尚未入库的那一版 index.json，
 * 220 张卡），逐 query 跑出来的 top-5 id 原样钉在这里。
 *
 * 【怎么读这张表】它不是"检索应该返回什么"的理想答案，它是"上一版返回过什么"的实测留痕。
 * 改动让它变红，说明**召回集合变了**——这本身不一定是错，但必须有人看见并解释：
 * 是新加了一张本域的卡（那就更新这张表，并在提交信息里说明动了哪几条），
 * 还是别的领域的卡漏了进来（那就是闸破了）。
 *
 * 前 8 条正是复审实测泄漏的那 8 句；后 12 条是本域的核心问法，用来发现"闸关过头、
 * 把本域的卡也一起挡了"这种反方向的坏事。
 */
const RECALL_BASELINE: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['投诉', ['sop-jiancha-vs-zhongcai', 'sop-lengbaoli-guli', 'case-xujia-tijian-daijian-2023']],
  ['退费', []],
  ['诉讼时效', ['calc-weiqian-hetong-shuangbei', 'statute-dianzi-qianming-fa', 'statute-tjzcf-core', 'sop-yishen-ersheng-sop', 'sop-zhongcai-guanxia-shixiao']],
  ['隐私泄露', ['case-jingye-baogao-zuixiao-biyao-bjzc25-8']],
  ['知情同意', []],
  ['未成年人', []],
  ['危机 自杀', []],
  ['心理热线', ['data-beijing-qiuzhu-ziyuan', 'script-tanpan-xinli-gongju', 'emotion-caiyuan-xinli-jieduan', 'emotion-kaiting-xinli-jianshe']],
  ['经济补偿 计算', ['calc-jingji-buchang-n', 'statute-lhtf-jiechu-buchang-core', 'case-shebao-yueding-wuxiao-buchang-zgf25-6', 'case-huanqian-gongling-lianxu-bjzc25-1', 'case-xianjing-tiaokuan-bjzc25-3']],
  ['违法解除 2N', ['sop-jixu-lvxing-vs-2n', 'statute-lhtf-jiechu-buchang-core', 'case-huanqian-jiangxin-gongling-11711', 'case-yunqi-tiqian-jiesan-hunton-sz2512', 'case-guandian-tiaogang-kuanggong-16940']],
  ['竞业限制', ['statute-rsty-2025-40-jingye-zhiyin', 'calc-jingye-buchang-weiyuejin', 'review-jingye-xianzhi', 'case-jingye-baogao-zuixiao-biyao-bjzc25-8', 'case-jingye-fanhua-jianshen-jiaolian-bjzc24-9']],
  ['加班费 举证', ['calc-jiabanfei', 'case-weiji-zhengju-buzu-jixiao-87802', 'case-weixin-youxing-jiaban-sz25-1', 'case-yinxing-jiaban-jing03-9602', 'calc-tuoqian-jiafu-peichang']],
  ['被迫解除', ['statute-lhtf-38-beipo-jiechu', 'sop-shumian-songda-liucun', 'template-beipo-jiechu-tongzhishu', 'case-shengyu-jintie-tuoqian-bjzc25-4', 'case-zhichang-baling-38tiao-bjzc24-7']],
  ['调岗降薪', ['sop-jiangxin-yingdui', 'sop-tiaogang-yingdui', 'case-huanqian-jiangxin-gongling-11711', 'case-jiangxin-30-geshui-zhengju-7478', 'statute-fashi-2020-26-jieshi-yi-43']],
  ['年假', ['case-fuli-nianjia-anyue-sz25-4', 'case-xiaoji-daigong-minzhuchengxu-jing03-94', 'calc-nianjia-300', 'case-keguan-yiqing-yewuliang-jing03-15429', 'case-keguan-zhanlue-tiaozheng-jing03-20183']],
  ['工伤', ['sop-gongshang-jiechu-xianzhi', 'case-zhuanbao-gongshang-daiyu-zgf25-1', 'case-gongshang-fuzhen-guodu-diaocha-2024']],
  ['试用期', ['sop-shiyongqi-quanli', 'case-shiye-danwei-daigang-jiepin-bjzc25-10', 'case-shiyongqi-jiechu-minzhu-chengxu-101', 'case-shiyongqi-xiangshou-nianjia-sz25-3', 'review-laodong-hetong']],
  ['社保', ['sop-shebao-tingjiao-jiangji', 'case-shebao-yueding-wuxiao-buchang-zgf25-6', 'sop-zhongcai-qijian-zijiu', 'data-beijing-shebao-jishu', 'sop-gongzi-shebao-geshui-beijing']],
  ['双倍工资', ['calc-weiqian-hetong-shuangbei', 'case-buqian-tongzhi-shuangbei-8452', 'case-guyi-buqian-hetong-bjzc24-2', 'case-guyi-buqian-hetong-zgf25-3', 'case-hunton-wugu-shuangbei-43551']],
  ['仲裁时效', ['statute-tjzcf-core', 'sop-zhongcai-guanxia-shixiao', 'calc-weiqian-hetong-shuangbei', 'sop-lengbaoli-guli', 'data-beijing-lian-zuobiao']],
];

/** 复审实测泄漏的那 8 句（RECALL_BASELINE 的前 8 条），单拎出来做泄漏方向的判据 */
const LEAK_QUERIES = RECALL_BASELINE.slice(0, 8).map(([q]) => q);

describe('跨域检索默认关闭（设计稿 §13）', () => {
  it('判据自身不空跑：库里确实有非缺省域的卡（一张都没有的话，下面几条全是空转）', () => {
    const others = listPacks().filter((m) => packDomain(m) !== DEFAULT_DOMAIN);
    expect(
      others.length,
      '库里一张非缺省域的卡都没有 ⇒ 这道闸没有任何东西可拦，本文件的判据全部退化成空跑',
    ).toBeGreaterThan(30);
  });

  it.each(LEAK_QUERIES)('「%s」：不传 domain 时一张别的领域的卡都不回（变异：拿掉 passesFilters 的领域闸 → 红）', (query) => {
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

  it.each(RECALL_BASELINE)('召回快照「%s」与上一版逐字一致（改了召回集合就要有人看见）', (query, expected) => {
    expect(
      search(query, { limit: 5 }).map((h) => h.id),
      `「${query}」的召回变了。要么是本域新加/改了卡（更新 RECALL_BASELINE 并在提交信息里说明），` +
        '要么是领域闸破了（那就不是更新基线的事）。',
    ).toEqual([...expected]);
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

  it('每一条索引条目的 domain 都与它指向的卡片写的一致', () => {
    const drift: string[] = [];
    for (const meta of listPacks()) {
      const onCard = domainInCard(meta.path);
      if (onCard !== meta.domain) {
        drift.push(`${meta.id}：index 说 ${meta.domain ?? '（无）'}，卡里写的是 ${onCard ?? '（无）'}`);
      }
    }
    expect(
      drift,
      `index.json 与卡片 frontmatter 的 domain 分叉了：\n  ${drift.join('\n  ')}\n` +
        '重跑 `python3 scripts/gen-knowledge-index.py`。分叉期间检索按 index 走，' +
        '卡上写什么都不算数——而两边都不会报错。',
    ).toEqual([]);
  });

  it('判据自身不空跑：确实有卡在 frontmatter 里声明了 domain', () => {
    const declared = listPacks().filter((m) => m.domain !== undefined);
    expect(declared.length).toBeGreaterThan(30);
    for (const m of declared) expect(domainInCard(m.path)).toBe(m.domain);
  });
});
