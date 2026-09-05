// app/src/app/api/manifest/route.ts
// 自描述清单（spec §8 MCP/API 行）。公开无鉴权：用户的 agent 要先读到这里才知道
// 往哪儿连、怎么鉴权。因此**只描述接口形状，不含任何账号或案件数据**。
//
// 【本文件不再手打任何清单】tools 段来自能力注册表（lib/capabilities），rest 段来自
// 端点索引（lib/capabilities/rest-index），错误码段来自 lib/capabilities/error-codes。
// 此前 rest 段是这里手打的 25 条字面量，而实际端点有六十余条——漏掉的那些，对方 agent
// 无从知道能调，且清单看起来完整（设计稿缺口 4）。判据对着磁盘上的 route.ts 双向核对。
import { ALL_SCOPES } from '@/lib/auth/api-key';
import { ERROR_CODES } from '@/lib/capabilities/error-codes';
import { REST_CATEGORIES, REST_INDEX, type RestCategory } from '@/lib/capabilities/rest-index';
import { toolsVersion } from '@/lib/capabilities/version';
import { PROTOCOL_VERSION, SERVER_INFO } from '@/lib/mcp/jsonrpc';
import { TOOLS } from '@/lib/mcp/tools';

/** rest 段的输出顺序：公开 → agent 面 → 网页会话 → 管理员 */
const CATEGORY_ORDER: readonly RestCategory[] = ['public', 'agent', 'web', 'admin'];

export async function GET() {
  return Response.json({
    name: SERVER_INFO.name,
    title: SERVER_INFO.title,
    version: SERVER_INFO.version,
    // 注册表内容指纹。存下它，下次发现变了就重读本清单与接入说明。
    tools_version: toolsVersion(),
    description:
      '北京朝阳劳动仲裁陪跑：案件档案、时间线、行动卡、法定期限与证据清单的读写接口。',
    auth: {
      // 两种凭据同一个头，服务端按验得过哪种来判定（见 lib/auth/identity.ts）
      header: 'Authorization: Bearer <token>',
      alternative_header: 'X-API-Key: <api key>',
      modes: [
        { via: 'jwt', description: '网页登录态，手机 OTP + 邮箱验证后签发，7 天有效' },
        { via: 'api_key', description: 'agent 直连用的长期凭据，在 /api/v1/keys 自助创建' },
      ],
      scopes: ALL_SCOPES,
    },
    mcp: {
      endpoint: '/api/mcp',
      transport: 'streamable-http',
      protocol_version: PROTOCOL_VERSION,
      tools: TOOLS.map((t) => ({
        name: t.name,
        title: t.title,
        scope: t.scope,
        kind: t.kind,
        // 同一能力的 REST 映射；没有对应端点的（如事实卡、知识检索）为 null
        rest: t.rest ?? null,
      })),
    },
    skill: {
      // 接进来之前先读这个：总纲 SKILL.md 会指路到《接入说明》与《陪跑指南》。
      // 与本清单同为公开无鉴权——第一步就要鉴权的话，用户还没有 key 可用。
      entry: '/skill/SKILL.md',
      files: ['/skill/SKILL.md', '/skill/接入说明.md', '/skill/陪跑指南.md'],
    },
    rest: {
      base: '/api/v1',
      categories: REST_CATEGORIES,
      endpoints: CATEGORY_ORDER.flatMap((category) =>
        REST_INDEX.filter((e) => e.category === category).map((e) => ({
          category: e.category,
          method: e.method,
          path: e.path,
          auth: e.auth,
          // 不校 scope 的端点不写这个字段（此前的手写清单也是这个约定）
          ...(e.scope ? { scope: e.scope } : {}),
          description: e.description,
        })),
      ),
    },
    errors: {
      shape: { ok: false, error_code: 'string', message: 'string' },
      note: '按 error_code 分支，不要按 HTTP status 分支。',
      codes: ERROR_CODES.map((e) => ({
        code: e.code,
        status: e.status,
        when: e.when,
        ...(e.recovery ? { recovery: e.recovery } : {}),
      })),
    },
  });
}
