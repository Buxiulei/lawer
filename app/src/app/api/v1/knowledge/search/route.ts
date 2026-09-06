// app/src/app/api/v1/knowledge/search/route.ts
// GET 按自然语言检索知识库（对应 MCP 工具 knowledge_search）。
// 入参走 query string；限流、截断标记、禁用号码抹除全在能力那一条里，本路由不复制。
import { runCapabilityRest } from '@/lib/capabilities/rest-runner';

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  // 只把「真的传了」的项交上去：传 undefined 与传空串在能力那侧语义不同
  //（空串会被判成入参错误，而没传是「不按这一维过滤」）。
  const args: Record<string, unknown> = { query: q.get('query') ?? '' };
  for (const name of ['type', 'court', 'full_text', 'limit'] as const) {
    const value = q.get(name);
    if (value !== null) args[name] = value;
  }
  return runCapabilityRest(req, 'knowledge_search', args);
}
