// C 族（knowledge_search / knowledge_get）的判据。
//
// 这一族两条能力都不碰数据库，run 的 db / identity 参数原样忽略——所以这里直接调 run，
// 不搭 sqlite。走 MCP 路由的那一层（鉴权、JSON-RPC 包壳、tools/list 顺序）另有判据。
import fs from 'node:fs';
import path from 'node:path';

import type { Database } from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { AGENT_TOOLS } from '@/lib/agent/tools';
import type { Identity } from '@/lib/auth/identity';
import { KNOWLEDGE_TYPES } from '@/lib/knowledge/types';

import { knowledgeGet, knowledgeSearch } from '../families/knowledge';

const DB = null as unknown as Database;
const ID: Identity = { uid: 1, via: 'api_key', scopes: ['case:read'], keyId: 1 };

interface SearchOut {
  query: string;
  full_text: boolean;
  packs: Array<{ id: string; type: string; excerpt: string; truncated: boolean; citation_guide: string }>;
}
interface GetOut {
  id: string;
  type: string;
  body: string;
  truncated: boolean;
  facts: {
    statute_quotes?: unknown[];
    values?: unknown[];
    hotlines?: Array<{ phone: string; status: string }>;
    review_rules?: unknown[];
  };
}
interface Failure {
  ok: false;
  errorCode: string;
  message: string;
}

const search = (args: Record<string, unknown>) => knowledgeSearch.run(DB, ID, args) as SearchOut;
const get = (args: Record<string, unknown>) => knowledgeGet.run(DB, ID, args) as GetOut;

// ────────────── 库存实测数据（判据读 index.json，不抄第二份清单）──────────────

interface IndexEntry {
  id: string;
  type: string;
  keywords: string[];
}
const KNOWLEDGE_DIR = process.env.LAWER_KNOWLEDGE_DIR ?? path.resolve(process.cwd(), '..', 'knowledge');
const INDEX: IndexEntry[] = JSON.parse(
  fs.readFileSync(path.join(KNOWLEDGE_DIR, 'index.json'), 'utf-8'),
);

/** 唯一一张正文超过全文上限（8000 字）的卡；截断判据钉着它 */
const LONGEST_PACK_ID = 'statute-jgf-2024-534-jieda-1';
/** 唯一一张带 forbidden 号码的资源卡 */
const HOTLINE_PACK_ID = 'data-beijing-qiuzhu-ziyuan';
/** 卡里声明为禁用、绝不能出现在任何出口的号码（正本在该卡的 facts.hotlines） */
const FORBIDDEN_PHONES = ['010-85961236', '010-65060953'];

describe('枚举唯一真源', () => {
  /**
   * **这条按引用相等断言，不是按内容相等**。内容相等在两处各自手抄一份、
   * 恰好抄对时也是绿的——而那正是这次要根治的形态（两份抄漏了同样的两类）。
   * 引用相等只有「真的是同一个数组」才成立。
   */
  it('站内 AGENT_TOOLS 与 MCP 能力面的 type 枚举是同一个数组（变异：任一处改成 [...KNOWLEDGE_TYPES] 副本 → 红）', () => {
    const agentTool = AGENT_TOOLS.find((t) => t.function.name === 'knowledge_search');
    const agentEnum = (
      agentTool!.function.parameters as {
        properties: { type: { enum: readonly string[] } };
      }
    ).properties.type.enum;
    const mcpEnum = (
      knowledgeSearch.inputSchema as { properties: { type: { enum: readonly string[] } } }
    ).properties.type.enum;

    expect(agentEnum).toBe(KNOWLEDGE_TYPES);
    expect(mcpEnum).toBe(KNOWLEDGE_TYPES);
    expect(mcpEnum).toBe(agentEnum);
  });
});

describe('十类都能按 type 检索到卡（用 index.json 实测）', () => {
  /**
   * 对每一类，从库里取一张真实的卡、拿它自己的 keyword 当 query，再带上 type 过滤。
   * 【为什么不用一句自造的 query 扫十类】自造 query 命中不了某类时，红的原因是
   * 「我这句话没写好」还是「这类卡在工具面上不存在」分不出来——而后者正是判据要抓的。
   */
  for (const type of KNOWLEDGE_TYPES) {
    it(`type=${type} 至少回一张，且回的全是这一类（变异：把该类从 KNOWLEDGE_TYPES 删掉 → 红）`, () => {
      const sample = INDEX.filter((e) => e.type === type).find((e) =>
        e.keywords.some((k) => k.length >= 2),
      );
      expect(sample, `库里没有 ${type} 的卡，或它一个 ≥2 字的 keyword 都没有`).toBeTruthy();
      const query = sample!.keywords.find((k) => k.length >= 2)!;

      const out = search({ query, type });
      expect(out.packs.length, `${type}：query「${query}」一张都没回`).toBeGreaterThan(0);
      for (const p of out.packs) expect(p.type, `${type} 过滤漏了一张 ${p.type}`).toBe(type);
    });
  }
});

describe('full_text 与截断标记', () => {
  it('默认给摘要：正文超 1200 字的卡回截断标记，且 excerpt 明显短于全文', () => {
    const brief = search({ query: '534号', type: '法条卡' });
    const hit = brief.packs.find((p) => p.id === LONGEST_PACK_ID);
    expect(hit, '判据夹具失效：这张卡检索不到了').toBeTruthy();
    expect(brief.full_text).toBe(false);
    expect(hit!.truncated).toBe(true);
    // 1200 字 + 尾注；给一点余量，钉的是"摘要档"而不是某个精确长度
    expect(hit!.excerpt.length).toBeLessThan(1400);
  });

  it('full_text=true 回整张正文，超 8000 字才截断并标 truncated（变异：clip 里把 truncated 恒写死 false → 红）', () => {
    const full = search({ query: '534号', type: '法条卡', full_text: true });
    expect(full.full_text).toBe(true);
    const hit = full.packs.find((p) => p.id === LONGEST_PACK_ID)!;
    // 这张卡正文 1.5 万字 > 8000 上限 ⇒ 必须截断且标记
    expect(hit.truncated).toBe(true);
    expect(hit.excerpt.length).toBeGreaterThan(8000);
    expect(hit.excerpt.length).toBeLessThan(8100);
    // 同一张卡，全文档拿到的正文必须**确实**比摘要档长——否则 full_text 是个没接线的开关
    const brief = search({ query: '534号', type: '法条卡' }).packs.find(
      (p) => p.id === LONGEST_PACK_ID,
    )!;
    expect(hit.excerpt.length).toBeGreaterThan(brief.excerpt.length * 5);
  });

  it('没超上限的卡 truncated=false（截断标记不能恒为 true——那样它同样什么都没说）', () => {
    const out = search({ query: '经济补偿 计算', full_text: true });
    expect(out.packs.length).toBeGreaterThan(0);
    expect(out.packs.some((p) => p.truncated === false)).toBe(true);
  });

  it('full_text 只认 true / "true"，别的值落回摘要（安全方向：猜错时少给，不吃掉对方一轮上下文）', () => {
    for (const v of [1, 'yes', {}, null, 'false']) {
      expect(search({ query: '534号', type: '法条卡', full_text: v }).full_text, String(v)).toBe(
        false,
      );
    }
    expect(search({ query: '534号', type: '法条卡', full_text: 'true' }).full_text).toBe(true);
  });
});

describe('court 过滤', () => {
  it('按结构化字段 facts.case_facts.court 子串匹配，只回该法院的判例', () => {
    const out = search({ query: '违法解除 赔偿金', court: '朝阳' });
    expect(out.packs.length).toBeGreaterThan(0);
    for (const p of out.packs) {
      const meta = INDEX.find((e) => e.id === p.id) as unknown as {
        facts?: { case_facts?: { court?: string } };
      };
      expect(meta.facts?.case_facts?.court, p.id).toContain('朝阳');
    }
  });

  it('没有审理机构的卡在传 court 时一律滤掉（否则这个过滤条件换回的是一批无关卡）', () => {
    const all = search({ query: '经济补偿 计算' });
    const filtered = search({ query: '经济补偿 计算', court: '朝阳' });
    expect(all.packs.length).toBeGreaterThan(filtered.packs.length);
  });
});

describe('knowledge_get', () => {
  it('按 id 回全文 + facts 的四个字段', () => {
    const out = get({ id: LONGEST_PACK_ID });
    expect(out.id).toBe(LONGEST_PACK_ID);
    expect(out.type).toBe('法条卡');
    // 这张卡正文 1.5 万字，按 8000 上限截断
    expect(out.truncated).toBe(true);
    expect(out.body.length).toBeGreaterThan(8000);
    expect(Array.isArray(out.facts.statute_quotes)).toBe(true);
    expect(out.facts.statute_quotes!.length).toBeGreaterThan(0);
  });

  it('审查规则卡的 review_rules 透传（此前类型上没声明这个字段，值拿得到但读不出来）', () => {
    const sample = INDEX.find(
      (e) => e.type === '审查规则' && (e as unknown as { facts?: { review_rules?: unknown[] } }).facts?.review_rules?.length,
    );
    expect(sample, '库里没有带 review_rules 的审查规则卡').toBeTruthy();
    const out = get({ id: sample!.id });
    expect(out.facts.review_rules!.length).toBeGreaterThan(0);
  });

  it('空 id / 不存在的 id 走 isError 且说清怎么办，不回空壳', () => {
    const blank = knowledgeGet.run(DB, ID, {}) as unknown as Failure;
    expect(blank.ok).toBe(false);
    expect(blank.errorCode).toBe('INVALID_ID');

    const missing = knowledgeGet.run(DB, ID, { id: '我自己拼的-id' }) as unknown as Failure;
    expect(missing.ok).toBe(false);
    expect(missing.errorCode).toBe('PACK_NOT_FOUND');
    expect(missing.message).toContain('knowledge_search');
  });
});

describe('禁用号码永不出现在任何出口', () => {
  /**
   * 【为什么正文也要查，而不只查 facts】资源卡正文里有一行
   * 「⛔ 禁用号码（agent 绝不输出）：<号码>」——那行是写给人看的说明，
   * 而这一侧的读者是另一个模型：⛔ 和「绝不输出」对它只是散文。
   * 号码进了上下文就有被转述给用户的路径，而用户拨过去接的是公证处。
   */
  it('判据夹具有效：这两个号码确实在卡的原始正文里（否则下面几条是空跑）', () => {
    const meta = INDEX.find((e) => e.id === HOTLINE_PACK_ID)!;
    const raw = fs.readFileSync(
      path.join(KNOWLEDGE_DIR, (meta as unknown as { path: string }).path),
      'utf-8',
    );
    for (const phone of FORBIDDEN_PHONES) expect(raw).toContain(phone);
  });

  it('knowledge_get 的 body 与 facts.hotlines 里都没有禁用号码（变异：去掉 redactBanned → 红）', () => {
    const out = get({ id: HOTLINE_PACK_ID });
    const blob = JSON.stringify(out);
    for (const phone of FORBIDDEN_PHONES) expect(blob, phone).not.toContain(phone);
    // 可用的那几条必须还在——把整张热线表滤空同样是错，只是错在另一个方向
    expect(out.facts.hotlines!.length).toBeGreaterThan(0);
    for (const h of out.facts.hotlines!) expect(h.status).not.toBe('forbidden');
  });

  it('knowledge_search 的 excerpt 里也没有禁用号码（摘要档与全文档都查）', () => {
    for (const full of [false, true]) {
      const out = search({ query: '心理援助 热线', full_text: full });
      const blob = JSON.stringify(out);
      for (const phone of FORBIDDEN_PHONES) expect(blob, `full_text=${full} ${phone}`).not.toContain(phone);
    }
  });
});
