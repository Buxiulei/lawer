// app/src/lib/knowledge/__tests__/index.test.ts
// 检索错一张卡，劳动者拿到的就是错的法条口径：命中率、过滤器、正文完整性、数据一致性四条都要盯。
// 夹具用仓库里真实的 knowledge/（52 张卡），不造 mock——mock 过不了「index 与 packs 不一致」这类真问题。
import { describe, test, expect, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { search, get, listPacks, __resetForTest } from '../index';

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

describe('search', () => {
  test('「被迫解除」前 3 名含第38条法条卡', () => {
    const ids = search('被迫解除').slice(0, 3).map((hit) => hit.id);
    expect(ids).toContain('statute-lhtf-38-beipo-jiechu');
  });

  test('type 过滤：「经济补偿」+ 计算规则只出计算规则，且含 N 的算法卡', () => {
    const hits = search('经济补偿', { type: '计算规则' });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((hit) => hit.type === '计算规则')).toBe(true);
    expect(hits.map((hit) => hit.id)).toContain('calc-jingji-buchang-n');
  });

  test('applies_to 过滤：「调岗」+ 调岗降薪命中调岗应对 SOP', () => {
    const hits = search('调岗', { applies_to: '调岗降薪' });
    expect(hits.every((hit) => hit.applies_to.includes('调岗降薪'))).toBe(true);
    expect(hits.map((hit) => hit.id)).toContain('sop-tiaogang-yingdui');
  });

  test('region 过滤：限定北京时不排除 region 为「全国」的司解二卡', () => {
    const hits = search('司法解释二 二倍工资', { region: '北京', limit: 20 });
    expect(hits.map((hit) => hit.id)).toContain('statute-fashi-2025-12-jieshi-2');
    expect(hits.every((hit) => hit.region === '北京' || hit.region === '全国')).toBe(true);
  });

  test('limit 默认 5，可覆盖', () => {
    expect(search('工资').length).toBeLessThanOrEqual(5);
    expect(search('工资', { limit: 2 })).toHaveLength(2);
  });

  test('结果按 score 降序且可重复（同分按 id 字典序）', () => {
    const first = search('调岗降薪', { limit: 10 });
    const second = search('调岗降薪', { limit: 10 });
    expect(second.map((hit) => hit.id)).toEqual(first.map((hit) => hit.id));
    for (let i = 1; i < first.length; i += 1) {
      expect(first[i - 1].score).toBeGreaterThanOrEqual(first[i].score);
      if (first[i - 1].score === first[i].score) {
        expect(first[i - 1].id.localeCompare(first[i].id)).toBeLessThan(0);
      }
    }
  });

  test('毫不相关的 query 返回空数组，不硬凑结果', () => {
    expect(search('如何烤制舒芙蕾')).toEqual([]);
  });

  test('空 query 或纯空白 → 抛错', () => {
    expect(() => search('')).toThrow(/query 不能为空/);
    expect(() => search('   ')).toThrow(/query 不能为空/);
  });
});

describe('get', () => {
  test('返回正文且已剥掉 frontmatter', () => {
    const hit = get('statute-lhtf-38-beipo-jiechu');
    expect(hit.content).toContain('第三十八条');
    expect(hit.content).not.toMatch(/^id:/m);
    expect(hit.content.startsWith('---')).toBe(false);
    expect(hit.id).toBe('statute-lhtf-38-beipo-jiechu');
  });

  test('不存在的 id → 抛错，不返回空卡', () => {
    expect(() => get('不存在的id')).toThrow(/knowledge pack 不存在/);
  });
});

describe('数据完整性', () => {
  test('listPacks 与 index.json 等量，且不含正文', () => {
    const packs = listPacks();
    const raw = JSON.parse(fs.readFileSync(path.join(KNOWLEDGE_DIR, 'index.json'), 'utf-8'));
    expect(packs).toHaveLength(raw.length);
    expect(packs.every((meta) => !('content' in meta))).toBe(true);
  });

  test('每条 path 指向的文件都存在，且 frontmatter id 与索引一致', () => {
    for (const meta of listPacks()) {
      const abs = path.join(KNOWLEDGE_DIR, meta.path);
      expect(fs.existsSync(abs), `缺文件：${meta.id} → ${meta.path}`).toBe(true);
      const frontmatterId = /^id:\s*(\S+)\s*$/m.exec(fs.readFileSync(abs, 'utf-8').split('\n---')[0])?.[1];
      expect(frontmatterId, `frontmatter id 不符：${meta.path}`).toBe(meta.id);
    }
  });

  test('id 唯一', () => {
    const ids = listPacks().map((meta) => meta.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('目录解析', () => {
  test('目录不存在 → 抛错并写明找了哪个路径与覆盖方式', () => {
    process.env.LAWER_KNOWLEDGE_DIR = path.join(KNOWLEDGE_DIR, '不存在的子目录');
    __resetForTest();
    expect(() => listPacks()).toThrow(/knowledge 目录不存在/);
    expect(() => listPacks()).toThrow(/LAWER_KNOWLEDGE_DIR/);
  });

  test('不设 env 时按 cwd 上跳一层找到 knowledge/（Next 与 vitest 的 cwd 都是 app/）', () => {
    delete process.env.LAWER_KNOWLEDGE_DIR;
    __resetForTest();
    expect(listPacks().length).toBeGreaterThan(0);
  });

  test('目录里没有 index.json → 抛错而不是当作零张卡', () => {
    process.env.LAWER_KNOWLEDGE_DIR = TEST_DIR;
    __resetForTest();
    expect(() => search('被迫解除')).toThrow(/knowledge 索引不存在/);
  });
});
