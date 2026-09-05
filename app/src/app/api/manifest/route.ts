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
    skill: {
      // 接进来之前先读这个：总纲 SKILL.md 会指路到《接入说明》与《陪跑指南》。
      // 与本清单同为公开无鉴权——第一步就要鉴权的话，用户还没有 key 可用。
      entry: '/skill/SKILL.md',
      files: ['/skill/SKILL.md', '/skill/接入说明.md', '/skill/陪跑指南.md'],
    },
    rest: {
      base: '/api/v1',
      endpoints: [
        { method: 'POST', path: '/api/v1/auth/sms/send', auth: 'none', description: '发送手机验证码' },
        { method: 'POST', path: '/api/v1/auth/sms/verify', auth: 'none', description: '校验手机验证码，签发 token' },
        { method: 'POST', path: '/api/v1/auth/email/send', auth: 'jwt', description: '发送邮箱验证码（已登录账号补绑邮箱）' },
        { method: 'POST', path: '/api/v1/auth/email/verify', auth: 'jwt', description: '校验邮箱验证码（已登录账号补绑邮箱）' },
        { method: 'POST', path: '/api/v1/auth/email/register/send', auth: 'none', description: '发送邮箱注册验证码（无手机号开户）' },
        { method: 'POST', path: '/api/v1/auth/email/register/verify', auth: 'none', description: '校验邮箱注册验证码，建号并签发 token' },
        { method: 'POST', path: '/api/v1/realname/init', auth: 'jwt', description: '发起实人认证，返回 H5 认证页 URL' },
        { method: 'GET', path: '/api/v1/realname/status', auth: 'jwt', description: '查实人认证结果' },
        { method: 'GET', path: '/api/v1/agent-setup', auth: 'jwt|api_key', description: '一键接入信息：mcp_url / api_base、工具清单、接入说明全文' },
        { method: 'GET', path: '/api/v1/keys', auth: 'jwt', description: '列出自己的 api key' },
        { method: 'POST', path: '/api/v1/keys', auth: 'jwt', description: '创建 api key，明文只返回这一次' },
        { method: 'GET', path: '/api/v1/keys/{id}/secret', auth: 'jwt', description: '取回这把 key 的明文（本列上线前签发的旧密钥没有密文，回 KEY_NOT_VIEWABLE）' },
        { method: 'POST', path: '/api/v1/keys/{id}/rotate', auth: 'jwt', description: '轮换：换发新明文，旧明文立即失效；id / name / scopes / client_name 不变' },
        { method: 'DELETE', path: '/api/v1/keys/{id}', auth: 'jwt', description: '吊销 api key' },
        { method: 'GET', path: '/api/v1/cases', auth: 'jwt|api_key', scope: 'case:read', description: '列出自己名下的全部案件（对应 MCP case_list）' },
        { method: 'GET', path: '/api/v1/cases/{id}', auth: 'jwt|api_key', scope: 'case:read', description: '案件档案 + 时间线' },
        { method: 'PATCH', path: '/api/v1/cases/{id}', auth: 'jwt|api_key', scope: 'case:write', description: '更新 stage / goal / bottom_line 及用工基本盘（入职时间/月薪/岗位/合同次数）' },
        { method: 'POST', path: '/api/v1/cases/{id}/intake', auth: 'jwt|api_key', scope: 'case:write', description: '首诊建档：一次性写入四项基本盘 + 时间线 + 诉求（对应 MCP intake_submit）' },
        { method: 'POST', path: '/api/v1/cases/{id}/timeline', auth: 'jwt|api_key', scope: 'case:write', description: '追加时间线事件，支持 client_ref 幂等' },
        { method: 'GET', path: '/api/v1/cases/{id}/actions', auth: 'jwt|api_key', scope: 'case:read', description: '列出行动卡' },
        { method: 'PATCH', path: '/api/v1/cases/{id}/actions/{actionId}', auth: 'jwt|api_key', scope: 'case:write', description: '完成/放弃行动卡' },
        { method: 'GET', path: '/api/v1/cases/{id}/deadlines', auth: 'jwt|api_key', scope: 'case:read', description: '列出法定期限' },
        { method: 'GET', path: '/api/v1/cases/{id}/evidence', auth: 'jwt|api_key', scope: 'case:read', description: '列出证据条目' },
        { method: 'POST', path: '/api/v1/evidence/{id}/attest', auth: 'jwt|api_key', scope: 'case:write', description: '证据固化出证（需已实名，否则 REALNAME_REQUIRED）' },
        { method: 'GET', path: '/api/v1/verify/{orderNo}', auth: 'none', description: '按存证订单号公开查询（轻量读库）' },
        { method: 'POST', path: '/api/v1/verify/{orderNo}/recheck', auth: 'none', description: '服务端实时复核：重算原件哈希 + 重新验签，按 IP 限流' },
      ],
    },
    errors: {
      shape: { ok: false, error_code: 'string', message: 'string' },
      note: '按 error_code 分支，不要按 HTTP status 分支。',
    },
  });
}
