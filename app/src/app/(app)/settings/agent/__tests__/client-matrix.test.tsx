/**
 * 客户端接入矩阵的判据。
 *
 * 【这一组盯的是什么】十个客户端，每个都得有一段步骤和一段能一键复制的配置，
 * 而配置里的地址必须是**服务端算出来的那个公网基址**（生产由 env LAWER_PUBLIC_URL 给）。
 *
 * 少一个客户端的形态是：选择器里没有他手里那家，他不知道该照哪一档做——
 * 而页面本身毫无异常。地址写死的形态更隐蔽：预发环境上生成的配置指向生产，
 * 粘过去甚至能连上，连的是别的环境。
 *
 * 变异臂：
 *   · 往 client-matrix.ts 的任一片段里写死一个域名 ⇒「地址全部来自服务端」那条红；
 *   · 从 CLIENT_MATRIX 里删一档 ⇒「十档都在选择器里」红；
 *   · 把 setupUrls() 里的 openapi_url 改成写死的串 ⇒「基址由 env 决定」红。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CLIENT_MATRIX, type SnippetVars } from '@/lib/capabilities/client-matrix';
import { setupUrls } from '@/lib/mcp/setup';

vi.mock('@/components/ui/Toast', () => ({ useToast: () => () => {} }));

const PUBLIC_URL = 'https://law.example.com';

afterEach(() => {
  delete process.env.LAWER_PUBLIC_URL;
});

/** 页面拿到的那份地址：真走服务端 setupUrls()，不在判据里手拼 */
function urlsFromEnv(): SnippetVars & Record<string, string> {
  process.env.LAWER_PUBLIC_URL = PUBLIC_URL;
  const u = setupUrls(new Request('http://container.internal:3000/api/v1/agent-setup'));
  return {
    ...u,
    mcpUrl: u.mcp_url,
    apiBase: u.api_base,
    manifestUrl: u.manifest_url,
    openapiUrl: u.openapi_url,
    skillUrl: u.skill_url,
    apiKey: 'sk-matrix-test',
  } as SnippetVars & Record<string, string>;
}

describe('地址来自 LAWER_PUBLIC_URL，不是本次请求的 host，也不是写死的串', () => {
  it('setupUrls 的五个地址都挂在 env 给的公网基址下', () => {
    const u = urlsFromEnv();
    for (const field of ['mcp_url', 'api_base', 'manifest_url', 'openapi_url', 'skill_url']) {
      expect(u[field], field).toContain(PUBLIC_URL);
    }
    expect(u.openapi_url).toBe(`${PUBLIC_URL}/api/openapi.json`);
    expect(JSON.stringify(u)).not.toContain('container.internal');
  });
});

describe('十个客户端各有片段，且片段里的地址正确', () => {
  it('矩阵正好十档，id 与显示名都不重复', () => {
    expect(CLIENT_MATRIX.length).toBe(10);
    expect(new Set(CLIENT_MATRIX.map((c) => c.id)).size).toBe(10);
    expect(new Set(CLIENT_MATRIX.map((c) => c.label)).size).toBe(10);
  });

  it('每一档都有非空步骤、非空片段，且片段里出现的地址全在公网基址下', () => {
    const vars = urlsFromEnv();
    for (const c of CLIENT_MATRIX) {
      const steps = c.steps(vars);
      const snippet = c.snippet(vars);
      expect(steps.length, `${c.label} 的步骤`).toBeGreaterThan(0);
      expect(snippet.trim().length, `${c.label} 的片段`).toBeGreaterThan(0);
      for (const hit of [...steps, snippet].join('\n').match(/https?:\/\/[^\s"'`]+/g) ?? []) {
        expect(hit.startsWith(PUBLIC_URL), `${c.label} 的地址 ${hit} 不在公网基址下`).toBe(true);
      }
    }
  });

  it('走 MCP 的那几档片段里带着 mcp 地址，走 REST 的带着 openapi 或 api 基址', () => {
    const vars = urlsFromEnv();
    for (const c of CLIENT_MATRIX) {
      const text = [...c.steps(vars), c.snippet(vars)].join('\n');
      if (c.path === 'A' || c.path === 'B') {
        expect(text, `${c.label} 该给 MCP 地址`).toContain(vars.mcp_url);
      }
      if (c.path === 'C') {
        expect(
          text.includes(vars.openapi_url) || text.includes(vars.api_base),
          `${c.label} 该给 openapi 或 REST 基址`,
        ).toBe(true);
      }
    }
  });

  it('有明文密钥时片段里填的就是它，没有时落到占位符', () => {
    const vars = urlsFromEnv();
    const withKey = CLIENT_MATRIX.map((c) => c.snippet(vars)).join('\n');
    const without = CLIENT_MATRIX.map((c) => c.snippet({ ...vars, apiKey: undefined })).join('\n');
    expect(withKey).toContain('sk-matrix-test');
    expect(without).not.toContain('sk-matrix-test');
    expect(without).toContain('<粘贴你生成时保存的密钥>');
  });
});

describe('选择器把十档都摆出来了', () => {
  it('渲染出的 option 与矩阵逐条对应', async () => {
    const { ClientMatrix } = await import('../_components/ClientMatrix');
    const u = urlsFromEnv();
    const html = renderToStaticMarkup(
      <ClientMatrix
        info={{
          mcp_url: u.mcp_url,
          api_base: u.api_base,
          manifest_url: u.manifest_url,
          openapi_url: u.openapi_url,
          skill_url: u.skill_url,
        }}
        apiKey="sk-matrix-test"
      />,
    );
    for (const c of CLIENT_MATRIX) {
      expect(html, `选择器里缺 ${c.label}`).toContain(`value="${c.id}"`);
    }
    // 首屏那一档的步骤与片段确实渲染出来了（落在空集上的守卫永远绿）
    expect(html).toContain(CLIENT_MATRIX[0].snippetLabel);
  });
});

/**
 * 【这一组盯的是什么】矩阵文案对某个能力「上线没有」的说法，必须与本 SHA 上的路由一致。
 *
 * 两个方向都会出事，且都毫无异常可见：
 *   · 说有、其实没有：说明书写着「复制回本站的『粘贴回填』」，用户照做，站上根本没这个入口；
 *   · 说没有、其实有：三支合流的那一天正是这个形态——OAuth 与粘贴回填都在同一个 SHA 上落地了，
 *     而矩阵里四档仍写着「我们的 OAuth 授权还没上线，这条路现在接不通」，把已经能走的路劝退掉。
 * 生成物（skill/接入说明.md 与 claude 变体）还会把这句话原样冻进去。
 *
 * 判据按路由文件的**确切路径**认「上线没有」，不按目录名模糊匹配：
 * 名字对上而文件不在的目录（挪走一半的重构）在模糊匹配下会被判成已上线。
 *
 * 变异臂：
 *   · 给已上线的 OAuth 那几档写回「还没上线」⇒ 「已上线就不许写成没上线」红；
 *   · 把粘贴回填那句的对冲语删掉、同时删掉 paste-back 路由 ⇒ 「不能空口承诺」红；
 *   · 把开场白里的 report_updates 删掉 ⇒ 「结构块字段与设计稿一致」红。
 */
describe('文案对「上线没有」的说法与本 SHA 的路由一致', () => {
  /** 站内能力名 → 落地后必然存在的那个路由文件（相对 src/app） */
  const IN_SITE_ENTRIES = [
    { name: '粘贴回填', route: 'api/v1/cases/[id]/paste-back/route.ts' },
    { name: 'OAuth', route: 'api/oauth/token/route.ts' },
  ];
  const HEDGES = ['还没上线', '还未上线', '未上线', '还在做', '上线之前', '上线前', '等我们的 OAuth'];

  const landed = (entry: { route: string }): boolean =>
    existsSync(join(process.cwd(), 'src/app', entry.route));

  /** 每一档的全部文案：步骤 + 可复制片段 */
  const textOf = (c: (typeof CLIENT_MATRIX)[number], vars: SnippetVars): string =>
    [...c.steps(vars), c.snippet(vars)].join('\n');

  it('提到站内入口的那句话，要么路由已存在，要么写明还没上线', () => {
    const vars = urlsFromEnv();
    for (const c of CLIENT_MATRIX) {
      for (const entry of IN_SITE_ENTRIES) {
        if (landed(entry)) continue;
        for (const sentence of textOf(c, vars).split(/[。\n]/)) {
          if (!sentence.includes(entry.name)) continue;
          expect(
            HEDGES.some((h) => sentence.includes(h)),
            `${c.label} 提到「${entry.name}」却既无路由也无「还没上线」：${sentence}`,
          ).toBe(true);
        }
      }
    }
  });

  it('路由已经落地的能力，文案里不许再写它没上线', () => {
    const vars = urlsFromEnv();
    for (const c of CLIENT_MATRIX) {
      for (const entry of IN_SITE_ENTRIES) {
        if (!landed(entry)) continue;
        for (const sentence of textOf(c, vars).split(/[。\n]/)) {
          if (!sentence.includes(entry.name)) continue;
          const stale = HEDGES.filter((h) => sentence.includes(h));
          expect(
            stale,
            `${c.label} 里「${entry.name}」已经上线了，这句话还写着「${stale.join('/')}」：${sentence}`,
          ).toEqual([]);
        }
      }
    }
  });

  it('开场白里的结构块字段与设计稿 §15 路径 D-② 一致', () => {
    const opening = CLIENT_MATRIX.find((c) => c.id === 'no-tools')!.snippet(urlsFromEnv());
    for (const field of ['timeline', 'actions', 'claims', 'deadlines', 'report_updates']) {
      expect(opening, `开场白缺字段 ${field}`).toContain(`"${field}"`);
    }
  });
});
