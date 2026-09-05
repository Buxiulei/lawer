// app/src/app/api/manifest/__tests__/route.test.ts
// /api/manifest 是对方 agent 接入前读的自描述清单。此前它的 rest 段是路由里手打的
// 25 条字面量，而实际端点有六十余条：漏掉的那条与不存在的那条，在对方眼里完全同形。
//
// 所以这里的判据不是「几条重点端点在不在」，而是**清单与磁盘双向对齐**：
//   · 清单里写了磁盘上没有的路径/方法 → 红（rest-index 写错字或端点被删了没跟）
//   · 磁盘上有而清单里没有 → 红（新开端点忘了登记）
// 只留一个方向的话，另一个方向的漏法会一直绿着。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import { REST_INDEX } from '@/lib/capabilities/rest-index';
import { GET } from '../route';

type Endpoint = { method: string; path: string; auth?: string; scope?: string };

const API_ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

async function manifest() {
  return (await GET()).json() as Promise<{
    tools_version: string;
    rest: { endpoints: Endpoint[] };
    mcp: { tools: { name: string; scope: string }[] };
    errors: { codes: { code: string }[] };
  }>;
}

/** 对外的 `/api/v1/cases/{id}` ←→ 磁盘上的 `app/src/app/api/v1/cases/[id]/route.ts` */
function routeFileFor(urlPath: string): string {
  const rel = urlPath.replace(/^\/api\//, '').replace(/\{([^}]+)\}/g, '[$1]');
  return path.join(API_ROOT, rel, 'route.ts');
}

/** 该 route.ts 实际导出了哪些 HTTP 方法 */
function exportedMethods(file: string): string[] {
  const text = fs.readFileSync(file, 'utf-8');
  return [...text.matchAll(/^export\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PATCH|PUT|DELETE)\b/gm)].map(
    (m) => m[1],
  );
}

/** 递归收集磁盘上的全部 route.ts，回 [对外路径, 方法] 二元组 */
function walkRoutes(dir: string, prefix = '/api'): { method: string; path: string }[] {
  const out: { method: string; path: string }[] = [];
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) {
      if (name === '__tests__') continue;
      out.push(...walkRoutes(full, `${prefix}/${name.replace(/^\[(.+)\]$/, '{$1}')}`));
    } else if (name === 'route.ts') {
      for (const method of exportedMethods(full)) out.push({ method, path: prefix });
    }
  }
  return out;
}

describe('自描述清单 · rest 段与磁盘双向对齐', () => {
  test('rest 段条数 = rest-index 条数（路由里不许再手打第二份）', async () => {
    const { rest } = await manifest();
    expect(rest.endpoints.length).toBe(REST_INDEX.length);
  });

  test('清单里每条路径在 app/src/app/api 下真实存在，且确实导出了那个方法', async () => {
    const { rest } = await manifest();
    const bad: string[] = [];
    for (const ep of rest.endpoints) {
      const file = routeFileFor(ep.path);
      if (!fs.existsSync(file)) {
        bad.push(`${ep.method} ${ep.path} → 找不到 ${path.relative(API_ROOT, file)}`);
        continue;
      }
      if (!exportedMethods(file).includes(ep.method)) {
        bad.push(`${ep.method} ${ep.path} → 该 route.ts 没有导出 ${ep.method}`);
      }
    }
    expect(bad, `清单里有对不上磁盘的端点：\n  ${bad.join('\n  ')}`).toEqual([]);
  });

  test('磁盘上每个 route.ts 的每个方法都登记在册（新开端点忘了写进 rest-index → 红）', async () => {
    const { rest } = await manifest();
    const listed = new Set(rest.endpoints.map((e) => `${e.method} ${e.path}`));
    const missing = walkRoutes(API_ROOT)
      .map((r) => `${r.method} ${r.path}`)
      .filter((k) => !listed.has(k));
    expect(
      missing,
      `这些端点在磁盘上存在但没进清单，对方 agent 无从知道能调：\n  ${missing.join('\n  ')}\n` +
        '补进 app/src/lib/capabilities/rest-index.ts。',
    ).toEqual([]);
  });

  test('扫到的确实是那一堆路由（空名单会让上面两条永远绿）', () => {
    expect(walkRoutes(API_ROOT).length).toBe(REST_INDEX.length);
  });
});

describe('自描述清单 · 内容', () => {
  test('裸 GET /cases 已登记（对应 MCP case_list）', async () => {
    const { rest } = await manifest();
    const ep = rest.endpoints.find((e) => e.method === 'GET' && e.path === '/api/v1/cases');
    expect(ep, 'GET /cases 没进清单，对方 agent 只能靠猜').toBeDefined();
    expect(ep!.scope).toBe('case:read');
  });

  test('POST /cases/{id}/intake 已登记（对应 MCP intake_submit）', async () => {
    const { rest } = await manifest();
    const ep = rest.endpoints.find(
      (e) => e.method === 'POST' && e.path === '/api/v1/cases/{id}/intake',
    );
    expect(ep, 'POST intake 没进清单，走 REST 的客户端建不了档').toBeDefined();
    expect(ep!.scope).toBe('case:write');
  });

  test('intake_submit 在 mcp 工具列里，scope 为 case:write', async () => {
    const { mcp } = await manifest();
    const tool = mcp.tools.find((t) => t.name === 'intake_submit');
    expect(tool).toBeDefined();
    expect(tool!.scope).toBe('case:write');
  });

  test('tools_version 是注册表内容哈希的前 8 位十六进制', async () => {
    const { tools_version } = await manifest();
    expect(tools_version).toMatch(/^[0-9a-f]{8}$/);
  });

  test('错误码表非空，且含对方一定会碰上的那几个', async () => {
    const { errors } = await manifest();
    const codes = errors.codes.map((c) => c.code);
    for (const code of ['UNAUTHORIZED', 'FORBIDDEN_SCOPE', 'CASE_NOT_FOUND', 'REALNAME_REQUIRED']) {
      expect(codes, `错误码表缺 ${code}`).toContain(code);
    }
  });
});
