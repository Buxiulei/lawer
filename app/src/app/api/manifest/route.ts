// app/src/app/api/manifest/route.ts
// 自描述清单（spec §8 MCP/API 行）。公开无鉴权：用户的 agent 要先读到这里才知道
// 往哪儿连、怎么鉴权。因此**只描述接口形状，不含任何账号或案件数据**。
import { ALL_SCOPES } from '@/lib/auth/api-key';
import { PROTOCOL_VERSION, SERVER_INFO } from '@/lib/mcp/jsonrpc';
import { TOOLS } from '@/lib/mcp/tools';

export async function GET() {
  return Response.json({
    name: SERVER_INFO.name,
    title: SERVER_INFO.title,
    version: SERVER_INFO.version,
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
      tools: TOOLS.map((t) => ({ name: t.name, title: t.title, scope: t.scope })),
    },
    rest: {
      base: '/api/v1',
      endpoints: [
        { method: 'POST', path: '/api/v1/auth/sms/send', auth: 'none', description: '发送手机验证码' },
        { method: 'POST', path: '/api/v1/auth/sms/verify', auth: 'none', description: '校验手机验证码，签发 token' },
        { method: 'POST', path: '/api/v1/auth/email/send', auth: 'jwt', description: '发送邮箱验证码' },
        { method: 'POST', path: '/api/v1/auth/email/verify', auth: 'jwt', description: '校验邮箱验证码' },
        { method: 'GET', path: '/api/v1/keys', auth: 'jwt', description: '列出自己的 api key' },
        { method: 'POST', path: '/api/v1/keys', auth: 'jwt', description: '创建 api key，明文只返回这一次' },
        { method: 'DELETE', path: '/api/v1/keys/{id}', auth: 'jwt', description: '吊销 api key' },
        { method: 'GET', path: '/api/v1/cases/{id}', auth: 'jwt|api_key', scope: 'case:read', description: '案件档案 + 时间线' },
        { method: 'PATCH', path: '/api/v1/cases/{id}', auth: 'jwt|api_key', scope: 'case:write', description: '更新 stage / goal / bottom_line' },
        { method: 'POST', path: '/api/v1/cases/{id}/timeline', auth: 'jwt|api_key', scope: 'case:write', description: '追加时间线事件' },
        { method: 'GET', path: '/api/v1/cases/{id}/actions', auth: 'jwt|api_key', scope: 'case:read', description: '列出行动卡' },
        { method: 'PATCH', path: '/api/v1/cases/{id}/actions/{actionId}', auth: 'jwt|api_key', scope: 'case:write', description: '完成/放弃行动卡' },
        { method: 'GET', path: '/api/v1/cases/{id}/deadlines', auth: 'jwt|api_key', scope: 'case:read', description: '列出法定期限' },
        { method: 'GET', path: '/api/v1/cases/{id}/evidence', auth: 'jwt|api_key', scope: 'case:read', description: '列出证据条目' },
      ],
    },
    errors: {
      shape: { ok: false, error_code: 'string', message: 'string' },
      note: '按 error_code 分支，不要按 HTTP status 分支。',
    },
  });
}
