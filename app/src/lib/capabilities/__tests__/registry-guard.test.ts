// 能力注册表的结构守卫 + 共用层领域中立守卫。
//
// 这两条都是「读得出来的清单」类判据：注册表是全站唯一真源（MCP tools/list、
// /api/manifest、接入说明能力表都由它生成），一条填错的元数据会同时错在三个出口，
// 而三处看起来都完全正常。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { CAPABILITIES, getCapability, listCapabilities } from '..';

const CAP_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC_ROOT = path.resolve(CAP_ROOT, '..', '..');

const FAMILIES = ['case', 'timeline', 'actions', 'deadlines', 'evidence', 'knowledge', 'drafts', 'company', 'emotion'];
const SCOPES = ['case:read', 'case:write'];
const KINDS = ['read', 'write', 'spend'];
const SURFACES = ['mcp', 'site'];
const PRECONDITIONS = ['realname', 'balance'];

describe('注册表结构守卫', () => {
  it('name 唯一（变异：复制一条能力改个别字段但留同名 → 红）', () => {
    const names = CAPABILITIES.map((c) => c.name);
    const dup = names.filter((n, i) => names.indexOf(n) !== i);
    expect(dup, `注册表里有重名能力：${dup.join(', ')}`).toEqual([]);
  });

  it('每条的 family / scope / kind / exposeTo / domains / precondition 都合法', () => {
    for (const c of CAPABILITIES) {
      expect(FAMILIES, `${c.name}.family`).toContain(c.family);
      expect(SCOPES, `${c.name}.scope`).toContain(c.scope);
      expect(KINDS, `${c.name}.kind`).toContain(c.kind);

      // 空 exposeTo 的能力谁都看不见——它不是"暂时不暴露"，它是一条写了等于没写的条目
      expect(c.exposeTo.length, `${c.name}.exposeTo 不能为空`).toBeGreaterThan(0);
      for (const s of c.exposeTo) expect(SURFACES, `${c.name}.exposeTo`).toContain(s);

      // 同理：空 domains 会被 listCapabilities 的领域过滤全部滤掉
      expect(c.domains.length, `${c.name}.domains 不能为空`).toBeGreaterThan(0);
      for (const p of c.precondition) expect(PRECONDITIONS, `${c.name}.precondition`).toContain(p);
    }
  });

  /**
   * kind 与 scope 必须对得上。**这条比"取值在枚举里"更有牙**：
   * 一条 kind:'write' 却挂着 case:read 的能力，会让只读 key 写档案——
   * 鉴权那侧只看 scope，它不会觉得有任何不对。
   */
  it('read 的能力用 case:read，write/spend 的用 case:write（变异：把某条写能力的 scope 改成 case:read → 红）', () => {
    for (const c of CAPABILITIES) {
      expect(c.scope, `${c.name} 的 kind=${c.kind}`).toBe(
        c.kind === 'read' ? 'case:read' : 'case:write',
      );
    }
  });

  it('每条都有 title / description / object 型 inputSchema / run', () => {
    for (const c of CAPABILITIES) {
      expect(c.title, `${c.name}.title`).toBeTruthy();
      expect(c.description, `${c.name}.description`).toBeTruthy();
      expect(c.inputSchema.type, `${c.name}.inputSchema.type`).toBe('object');
      expect(typeof c.run, `${c.name}.run`).toBe('function');
    }
  });

  it('读能力不声明幂等约定（idempotency 是写侧的东西）', () => {
    for (const c of CAPABILITIES) {
      if (c.kind === 'read') expect(c.idempotency, `${c.name}`).toBeUndefined();
    }
  });

  it('listCapabilities 按暴露面与领域过滤，且保持注册表顺序', () => {
    const mcp = listCapabilities({ exposeTo: 'mcp' });
    expect(mcp.map((c) => c.name)).toEqual(
      CAPABILITIES.filter((c) => c.exposeTo.includes('mcp')).map((c) => c.name),
    );
    // domains 全是 ['*'] 时，给不给 domain 结果一样；给一个谁都不认的领域也一样
    expect(listCapabilities({ exposeTo: 'mcp', domain: '不存在的领域' }).map((c) => c.name)).toEqual(
      mcp.map((c) => c.name),
    );
  });

  it('getCapability 按名取，取不到回 undefined', () => {
    expect(getCapability('case_get')?.name).toBe('case_get');
    expect(getCapability('没有这个能力')).toBeUndefined();
  });
});

// ========== 共用层领域中立 ==========

/** 递归收集 .ts 文件，跳过 __tests__ */
function walk(dir: string, out: string[] = []): string[] {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) {
      if (name === '__tests__') continue;
      walk(full, out);
    } else if (name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('共用层不许写死领域内容（设计稿 §13-6）', () => {
  /**
   * 领域词一旦散落进共用层，第二个领域接进来时就得去共用代码里把上一个领域留下的
   * 硬编码一条条翻出来——而它们看起来都很正常。所以这里按**文件**拦，不按人记性拦。
   *
   * 领域文案的正本在 lib/domains/<key>.ts；能力条目引用它，对外那几句话逐字不变。
   */
  const FORBIDDEN = ['劳动', '仲裁'];

  const SHARED_FILES = [
    ...walk(CAP_ROOT),
    path.join(SRC_ROOT, 'lib/domains/registry.ts'),
  ];

  it('lib/capabilities/** 与 lib/domains/registry.ts 里没有领域字面量（变异：往 registry.ts 写一句带「仲裁」的注释 → 红）', () => {
    const hits: string[] = [];
    for (const file of SHARED_FILES) {
      const text = fs.readFileSync(file, 'utf-8');
      for (const word of FORBIDDEN) {
        if (text.includes(word)) hits.push(`${path.relative(SRC_ROOT, file)} 里出现「${word}」`);
      }
    }
    expect(
      hits,
      `共用层出现了领域字面量：\n  ${hits.join('\n  ')}\n` +
        '把这些文案挪到 lib/domains/<key>.ts 的领域包里，由能力条目引用（见 LABOR_CAPABILITY_COPY）。',
    ).toEqual([]);
  });

  it('守卫扫到的确实是那几个文件（空名单会让上面那条永远绿）', () => {
    expect(SHARED_FILES.length).toBeGreaterThanOrEqual(9);
    for (const f of SHARED_FILES) expect(fs.existsSync(f), f).toBe(true);
  });
});
