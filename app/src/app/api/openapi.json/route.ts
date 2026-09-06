// app/src/app/api/openapi.json/route.ts
// OpenAPI 3.1 文档（设计稿 §15 路径 C）。公开无鉴权：只吃 OpenAPI 的客户端
//（Custom GPT Actions、各家「导入一个 API」的面板）要先取到它才知道能调什么，
// 而那时用户手上还没有 key。文档只描述接口形状，不含任何账号或案件数据。
//
// 路由照例是薄的：定基址 → 选档 → 交给 lib/capabilities/openapi 生成。
// 本文件不打任何路径、参数或错误码字面量——打了就是第二份清单，而两份都在仓库里。
import { buildOpenApi, type OpenApiProfile } from '@/lib/capabilities/openapi';
import { toolsVersion } from '@/lib/capabilities/version';
import { resolveBaseUrl } from '@/lib/mcp/setup';

/**
 * profile 只认 `actions` 这一个值。写错（比如 `action`）时**退回全量**而不是报错：
 * 这份文档多半是被某个面板直接 fetch 走的，那边看不见 400 的 body，
 * 只会显示「导入失败」，而用户无从知道是自己 URL 里少了个 s。
 */
function readProfile(req: Request): OpenApiProfile {
  return new URL(req.url).searchParams.get('profile') === 'actions' ? 'actions' : 'full';
}

export async function GET(req: Request) {
  const doc = buildOpenApi({
    baseUrl: resolveBaseUrl(req),
    profile: readProfile(req),
    version: toolsVersion(),
  });
  return Response.json(doc);
}
