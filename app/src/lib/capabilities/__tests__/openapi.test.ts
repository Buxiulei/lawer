// OpenAPI 文档的判据。
//
// 【为什么要有快照】这份文档是由注册表 + 端点索引生成的，改注册表时**没有任何一处会提醒你
// 文档也跟着变了**——变对了还是变错了，看生成结果是看不出来的（它永远"格式正常"）。
// 快照把每次变化摆到 diff 里：加一条能力、给某条能力挂上 REST、改一个入参名，
// 都会让快照红一次，逼人当场看一眼这条变化是不是他要的。
//
// 快照存的是**紧凑摘要**而不是整份 JSON：整份 JSON 的 diff 里 90% 是描述文字换行，
// 真正的结构变化淹在里面，等于没人看。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { CAPABILITIES } from '../registry';
import { REST_INDEX } from '../rest-index';
import {
  ACTIONS_PROFILE,
  ACTIONS_PROFILE_PENDING,
  actionsProfileResolved,
  buildOpenApi,
  operationIdFor,
} from '../openapi';
import { validateOpenApi } from './openapi-validate';

/** 判据里一律用这个假基址：真基址来自 env，写死在判据里等于判据自己也得跟着环境改 */
const BASE = 'https://example.test';
const VERSION = 'testver1';

const SNAPSHOT = path.join(fileURLToPath(new URL('.', import.meta.url)), 'openapi.snapshot.txt');

function doc(profile: 'full' | 'actions' = 'full') {
  return buildOpenApi({ baseUrl: BASE, profile, version: VERSION }) as Record<string, unknown>;
}

interface Op {
  operationId: string;
  parameters?: { name: string; in: string; required?: boolean }[];
  requestBody?: {
    content: { 'application/json': { schema: { required?: string[]; properties?: object } } };
  };
  security?: object[];
}

function operations(d: Record<string, unknown>): { method: string; path: string; op: Op }[] {
  const out: { method: string; path: string; op: Op }[] = [];
  for (const [p, item] of Object.entries(d.paths as Record<string, Record<string, Op>>)) {
    for (const [method, op] of Object.entries(item)) out.push({ method, path: p, op });
  }
  return out;
}

/**
 * 快照文本。三段：能力→REST 映射、全量 operation、精简集。
 * 第一段让「注册表加一条能力」也能红——哪怕那条还没挂 REST 端点。
 */
function snapshotText(): string {
  const lines: string[] = ['# 能力 → REST（注册表）'];
  for (const c of CAPABILITIES) {
    lines.push(`${c.name}\t${c.rest ? `${c.rest.method} ${c.rest.path}` : '—'}`);
  }
  lines.push('', '# 全量 operation');
  for (const { method, path: p, op } of operations(doc())) {
    const params = (op.parameters ?? [])
      .map((x) => `${x.in}:${x.name}${x.required ? '!' : ''}`)
      .join(',');
    const body = op.requestBody
      ? Object.keys(op.requestBody.content['application/json'].schema.properties ?? {}).join(',')
      : '';
    const auth = (op.security ?? []).length > 0 ? 'bearer' : 'none';
    lines.push(
      `${method.toUpperCase()} ${p}\t${op.operationId}\t${auth}\t[${params}]\t{${body}}`,
    );
  }
  lines.push('', '# 精简集 profile=actions');
  for (const { method, path: p, op } of operations(doc('actions'))) {
    lines.push(`${method.toUpperCase()} ${p}\t${op.operationId}`);
  }
  lines.push('', '# 精简集里尚无 REST 端点的能力');
  for (const [name, why] of Object.entries(ACTIONS_PROFILE_PENDING)) lines.push(`${name}\t${why}`);
  return `${lines.join('\n')}\n`;
}

describe('openapi 文档结构', () => {
  it('全量文档通过 3.1 结构校验（含 operationId 唯一、$ref 可解析、路径参数齐）', () => {
    const problems = validateOpenApi(doc());
    expect(problems, `结构问题：\n  ${problems.join('\n  ')}`).toEqual([]);
  });

  it('精简集同样通过结构校验', () => {
    const problems = validateOpenApi(doc('actions'));
    expect(problems, `结构问题：\n  ${problems.join('\n  ')}`).toEqual([]);
  });

  it('operationId 唯一（变异：让两条端点派生出同一个 id → 红）', () => {
    const ids = operations(doc()).map((x) => x.op.operationId);
    const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
    expect(dup, `重复的 operationId：${dup.join(', ')}`).toEqual([]);
  });

  it('operation 集合与端点索引逐条对齐（漏一条 / 多一条都红）', () => {
    const fromDoc = operations(doc())
      .map((x) => `${x.method.toUpperCase()} ${x.path}`)
      .sort();
    const fromIndex = REST_INDEX.map((e) => `${e.method} ${e.path}`).sort();
    expect(fromDoc).toEqual(fromIndex);
  });

  it('有对应能力的端点用能力名当 operationId（两侧同名才能把 MCP 与 REST 两份文档对上）', () => {
    for (const c of CAPABILITIES) {
      if (!c.rest) continue;
      const ep = REST_INDEX.find((e) => e.method === c.rest!.method && e.path === c.rest!.path);
      expect(ep, `${c.name} 声明的 ${c.rest.method} ${c.rest.path} 不在端点索引里`).toBeDefined();
      expect(operationIdFor(ep!)).toBe(c.name);
    }
  });

  it('servers 与文档里的地址全部来自入参 baseUrl（变异：把地址写死 → 红）', () => {
    const text = JSON.stringify(doc());
    const hosts = [...text.matchAll(/https?:\/\/[^"'\s\\]+/g)].map((m) => m[0]);
    const foreign = hosts.filter((h) => !h.startsWith(BASE));
    expect(foreign, `文档里出现了不是从 baseUrl 派生的地址：${foreign.join(', ')}`).toEqual([]);
    expect((doc().servers as { url: string }[])[0].url).toBe(BASE);
  });

  it('末尾斜杠的 baseUrl 不会生出双斜杠', () => {
    const d = buildOpenApi({ baseUrl: `${BASE}/`, profile: 'full', version: VERSION });
    expect((d.servers as { url: string }[])[0].url).toBe(BASE);
  });

  it('公开端点不写 security，其余都挂 bearerAuth', () => {
    for (const { method, path: p, op } of operations(doc())) {
      const ep = REST_INDEX.find((e) => e.method === method.toUpperCase() && e.path === p)!;
      const has = (op.security ?? []).length > 0;
      expect(has, `${method} ${p}`).toBe(ep.auth !== 'none');
    }
  });

  it('路径参数配对不串位：/cases/{id}/actions/{actionId} 上 {id} 认的是 case_id', () => {
    const paths = doc().paths as Record<string, Record<string, Op>>;
    const op = paths['/api/v1/cases/{id}/actions/{actionId}'].patch;
    const names = (op.parameters ?? []).map((x) => x.name);
    expect(names).toEqual(['id', 'actionId']);
    // 两个路径参数各占一位后，能力入参里只剩 status 落到 body/query
    const bodyProps = Object.keys(
      op.requestBody!.content['application/json'].schema.properties ?? {},
    );
    expect(bodyProps).toEqual(['status']);
  });
});

describe('精简集 profile=actions', () => {
  it('条数 ≤ 30（只吃 OpenAPI 的客户端有 operation 上限）', () => {
    expect(operations(doc('actions')).length).toBeLessThanOrEqual(30);
  });

  it('含 case_facts', () => {
    const ids = operations(doc('actions')).map((x) => x.op.operationId);
    expect(ids).toContain('case_facts');
  });

  it('精简集就是名单里已经有 REST 端点的那些，一条不多一条不少', () => {
    const ids = operations(doc('actions')).map((x) => x.op.operationId).sort();
    expect(ids).toEqual([...actionsProfileResolved()].sort());
  });

  it('名单 = 已出的 + 登记为「尚无端点」的（变异：从名单里悄悄删掉一条 → 红）', () => {
    const covered = [...actionsProfileResolved(), ...Object.keys(ACTIONS_PROFILE_PENDING)].sort();
    expect(covered).toEqual([...ACTIONS_PROFILE].sort());
  });

  it('登记为「尚无端点」的能力确实还没有端点（有了还留着 → 红，逼人划掉）', () => {
    const withRest = new Set(CAPABILITIES.filter((c) => c.rest).map((c) => c.name));
    const stale = Object.keys(ACTIONS_PROFILE_PENDING).filter((n) => withRest.has(n));
    expect(
      stale,
      `这些能力已经有 REST 端点了，请从 ACTIONS_PROFILE_PENDING 里划掉：${stale.join(', ')}`,
    ).toEqual([]);
  });

  it('精简集是全量的子集', () => {
    const full = new Set(operations(doc()).map((x) => `${x.method} ${x.path}`));
    for (const x of operations(doc('actions'))) {
      expect(full.has(`${x.method} ${x.path}`), `${x.method} ${x.path}`).toBe(true);
    }
  });
});

describe('快照', () => {
  it('与 openapi.snapshot.txt 逐字一致（变异：注册表加一条能力 → 红）', () => {
    const actual = snapshotText();
    if (process.env.UPDATE_OPENAPI_SNAPSHOT === '1') {
      fs.writeFileSync(SNAPSHOT, actual);
    }
    const expected = fs.existsSync(SNAPSHOT) ? fs.readFileSync(SNAPSHOT, 'utf-8') : '';
    expect(
      actual,
      '接口面变了。确认这些变化都是你要的之后，跑 ' +
        '`UPDATE_OPENAPI_SNAPSHOT=1 npx vitest run src/lib/capabilities/__tests__/openapi.test.ts` 更新快照。',
    ).toBe(expected);
  });
});
