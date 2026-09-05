// app/src/lib/capabilities/rest-index.ts
// REST 端点索引：**全站 HTTP 面的唯一清单**，`/api/manifest` 的 rest 段由它生成。
//
// 【为什么要有这份常量】此前 manifest 的端点表是在路由里手打的一段字面量，只写了 25 条，
// 剩下的对方 agent 无从知道能调（设计稿缺口 4）。手写的形态是「新开一条端点，
// 清单不动，而清单看起来仍然完整」——漏掉的那条与不存在的那条在外部同形。
// 现在改成：这份常量是清单，判据对着 app/src/app/api 下的 route.ts **双向**核对
// （见 app/src/app/api/manifest/__tests__/route.test.ts）：
//   · 这里写了磁盘上没有的路径 → 红
//   · 磁盘上有而这里没写 → 红
// 所以加端点忘了登记会当场红，不会安静地漏掉。
//
// 【与能力注册表的分工】registry.ts 管「agent 能做什么」（MCP 工具 + 它们的 REST 映射），
// 本表管「这个服务一共开了哪些 HTTP 口」——包括登录、实名、后台、计费这些不是工具的口。
// 两者在 `rest` 字段上重合的那几条，由 registry 那侧的条目负责语义，本表只负责「口在这儿」。
//
// ───────────────── ⚠️ 本文件是共用层 ⚠️ ─────────────────
// 不得出现具体领域的字面量（见 registry.ts 抬头，由 __tests__/registry-guard.test.ts 机检）。
// ─────────────────────────────────────────────────────

import type { Scope } from '@/lib/auth/api-key';

/** 端点按「谁能调」分成四类；manifest 的 rest 段按这个顺序分组输出 */
export type RestCategory = 'public' | 'agent' | 'web' | 'admin';

export interface RestEndpoint {
  category: RestCategory;
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** 对外写法：动态段用 {name}，与磁盘上的 [name] 一一对应 */
  path: string;
  /** 认得哪种凭据 */
  auth: 'none' | 'jwt' | 'jwt|api_key' | 'admin';
  /** 仅 auth='jwt|api_key' 且真的校验 scope 的端点才有 */
  scope?: Scope;
  description: string;
}

/** 四类的说明，原样进 manifest，免得对方靠 category 的英文单词猜 */
export const REST_CATEGORIES: Record<RestCategory, string> = {
  public: '公开：不带凭据即可调用',
  agent: 'agent 面：网页登录态或 api key 都认，按 scope 判权限',
  web: '网页会话专用：只认网页登录态（jwt），api key 一律拒（不能用 key 再造 key）',
  admin: '管理员：网页登录态 + 白名单 uid，非白名单一律 404',
};

/**
 * 全部 HTTP 端点。**顺序即 manifest 里的顺序**：先公开、再 agent 面、再网页会话、最后管理员。
 * 同一类内按路径分组，便于人从上往下读。
 */
export const REST_INDEX: readonly RestEndpoint[] = [
  // ──────── 公开（无鉴权）────────
  { category: 'public', method: 'GET', path: '/api/health', auth: 'none', description: '存活探针（容器 HEALTHCHECK 打这里）' },
  { category: 'public', method: 'GET', path: '/api/manifest', auth: 'none', description: '本清单自己：接口形状、鉴权方式、权限项、工具与端点全表' },
  { category: 'public', method: 'GET', path: '/api/mcp', auth: 'none', description: 'MCP 端点的自述（传输方式与协议版本）；真正的调用走同路径的 POST' },
  { category: 'public', method: 'GET', path: '/api/v1/version', auth: 'none', description: '当前产物的构建信息（commit sha 可能为 null，读到 null 应判「无法核验」）' },
  { category: 'public', method: 'POST', path: '/api/v1/auth/sms/send', auth: 'none', description: '发送手机验证码' },
  { category: 'public', method: 'POST', path: '/api/v1/auth/sms/verify', auth: 'none', description: '校验手机验证码，签发 token' },
  { category: 'public', method: 'POST', path: '/api/v1/auth/email/send', auth: 'none', description: '发送邮箱验证码；带上登录态即为「已登录账号补绑邮箱」' },
  { category: 'public', method: 'POST', path: '/api/v1/auth/email/verify', auth: 'none', description: '校验邮箱验证码，签发 token 或完成补绑' },
  { category: 'public', method: 'POST', path: '/api/v1/auth/email/register/send', auth: 'none', description: '发送邮箱注册验证码（无手机号开户）' },
  { category: 'public', method: 'POST', path: '/api/v1/auth/email/register/verify', auth: 'none', description: '校验邮箱注册验证码，建号并签发 token' },
  { category: 'public', method: 'GET', path: '/api/v1/auth/google/start', auth: 'none', description: '跳转 Google 授权页并下发一次性 state cookie（302，不是 JSON）' },
  { category: 'public', method: 'GET', path: '/api/v1/auth/google/callback', auth: 'none', description: 'Google 授权回调：校 state、换 token、归并或建号，302 回登录页' },
  { category: 'public', method: 'GET', path: '/api/v1/verify/{orderNo}', auth: 'none', description: '按存证订单号公开查询（刻意无鉴权：对方拿到订单号就该能核）' },
  { category: 'public', method: 'POST', path: '/api/v1/verify/{orderNo}/recheck', auth: 'none', description: '服务端实时复核：重算原件哈希 + 重新验签，按 IP 限流' },

  // ──────── agent 面（jwt 或 api key）────────
  { category: 'agent', method: 'POST', path: '/api/mcp', auth: 'jwt|api_key', description: 'MCP JSON-RPC 2.0 入口（Streamable HTTP），工具面见本清单 mcp.tools' },
  { category: 'agent', method: 'GET', path: '/api/v1/agent-setup', auth: 'jwt|api_key', description: '一键接入信息：mcp_url / api_base、工具清单、接入说明全文（不校 scope）' },
  { category: 'agent', method: 'GET', path: '/api/v1/me', auth: 'jwt|api_key', scope: 'case:read', description: '本人身份摘要（手机号在服务端已掩码）' },
  { category: 'agent', method: 'GET', path: '/api/v1/me/storage', auth: 'jwt|api_key', scope: 'case:read', description: '本人的存储用量；不接受任何指定用户的入参' },
  { category: 'agent', method: 'GET', path: '/api/v1/billing/ledger', auth: 'jwt|api_key', scope: 'case:read', description: '本人的公道值余额与流水（同时给 balance 与 ledger_sum）' },
  { category: 'agent', method: 'POST', path: '/api/v1/redeem', auth: 'jwt|api_key', scope: 'case:write', description: '兑换码入账（一码一兑，失败有锁）' },
  { category: 'agent', method: 'GET', path: '/api/v1/cases', auth: 'jwt|api_key', scope: 'case:read', description: '名下案件清单，新的在前（对应工具 case_list）' },
  { category: 'agent', method: 'GET', path: '/api/v1/cases/{id}', auth: 'jwt|api_key', scope: 'case:read', description: '案件档案 + 最近时间线（对应工具 case_get）' },
  { category: 'agent', method: 'PATCH', path: '/api/v1/cases/{id}', auth: 'jwt|api_key', scope: 'case:write', description: '更新阶段 / 目标 / 底线及用工基本盘（对应工具 case_update）' },
  { category: 'agent', method: 'POST', path: '/api/v1/cases/{id}/intake', auth: 'jwt|api_key', scope: 'case:write', description: '首诊建档：一次原子写入基本盘 + 时间线 + 诉求（对应工具 intake_submit）' },
  { category: 'agent', method: 'GET', path: '/api/v1/cases/{id}/messages', auth: 'jwt|api_key', scope: 'case:read', description: '案件的历史对话（只读；写那一路在同级 chat）' },
  { category: 'agent', method: 'POST', path: '/api/v1/cases/{id}/chat', auth: 'jwt|api_key', scope: 'case:write', description: '让本服务的模型跑一轮并回 SSE。**调一次扣一轮公道值**，自带模型的 agent 不要调' },
  { category: 'agent', method: 'POST', path: '/api/v1/cases/{id}/timeline', auth: 'jwt|api_key', scope: 'case:write', description: '追加一条时间线事件，只追加无改删（对应工具 timeline_add）' },
  { category: 'agent', method: 'POST', path: '/api/v1/cases/{id}/timeline/{eventId}/milestone', auth: 'jwt|api_key', scope: 'case:write', description: '给一条时间线事件盖里程碑' },
  { category: 'agent', method: 'GET', path: '/api/v1/cases/{id}/actions', auth: 'jwt|api_key', scope: 'case:read', description: '列出行动卡，可按状态过滤（对应工具 action_list）' },
  { category: 'agent', method: 'PATCH', path: '/api/v1/cases/{id}/actions/{actionId}', auth: 'jwt|api_key', scope: 'case:write', description: '把行动卡标为完成或放弃（对应工具 action_complete）' },
  { category: 'agent', method: 'GET', path: '/api/v1/cases/{id}/deadlines', auth: 'jwt|api_key', scope: 'case:read', description: '列出法定期限（对应工具 deadline_list）' },
  { category: 'agent', method: 'GET', path: '/api/v1/cases/{id}/evidence', auth: 'jwt|api_key', scope: 'case:read', description: '列出案件下的证据条目，只给元数据（对应工具 evidence_list）' },
  { category: 'agent', method: 'GET', path: '/api/v1/cases/{id}/drafts', auth: 'jwt|api_key', scope: 'case:read', description: '列出案件下的文书，正文一并返回' },
  { category: 'agent', method: 'GET', path: '/api/v1/cases/{id}/dossier', auth: 'jwt|api_key', scope: 'case:read', description: '本案对方主体的公司档案（页面手上只有 case_id 时走这条）' },
  { category: 'agent', method: 'GET', path: '/api/v1/cases/{id}/company-graph', auth: 'jwt|api_key', scope: 'case:read', description: '本案的公司关系图谱；没做过调查时 graph 为 null（不是错误）' },
  { category: 'agent', method: 'POST', path: '/api/v1/cases/{id}/watch', auth: 'jwt|api_key', scope: 'case:write', description: '给对方主体加守望。本次不扣钱，扣费在月度巡检；同案同主体去重' },
  { category: 'agent', method: 'POST', path: '/api/v1/evidence', auth: 'jwt|api_key', scope: 'case:write', description: '上传证据文件（multipart）。**需已实名**，未实名回 REALNAME_REQUIRED' },
  { category: 'agent', method: 'PUT', path: '/api/v1/evidence/upload/{token}', auth: 'jwt|api_key', scope: 'case:write', description: '用一次性 token 上传字节（body 就是文件本身）。**需已实名**；地址只收一次文件、10 分钟内有效；传完再用同一个 token 调工具 evidence_register 登记条目' },
  { category: 'agent', method: 'GET', path: '/api/v1/evidence/{id}', auth: 'jwt|api_key', scope: 'case:read', description: '单条证据详情（含其存证订单，如果已发起过固化）' },
  { category: 'agent', method: 'POST', path: '/api/v1/evidence/{id}/attest', auth: 'jwt|api_key', scope: 'case:write', description: '发起证据固化出证（时间戳 + 证明 PDF + 签名）。**需已实名**；重复 POST 幂等' },
  { category: 'agent', method: 'POST', path: '/api/v1/company/probe', auth: 'jwt|api_key', scope: 'case:read', description: '免费前置探测：扣费前先给数字与工商状态，降级时如实回 reason' },
  { category: 'agent', method: 'POST', path: '/api/v1/company/dossiers/quote', auth: 'jwt|api_key', scope: 'case:read', description: '公司档案报价。**不动钱**：不扣费、不建档、不占额度' },
  { category: 'agent', method: 'POST', path: '/api/v1/company/dossiers/confirm', auth: 'jwt|api_key', scope: 'case:write', description: '公司档案下单确认，**调一次就按报价扣费**。先把报价念给用户、等他明确说买再调' },
  { category: 'agent', method: 'GET', path: '/api/v1/company/dossiers/{id}', auth: 'jwt|api_key', scope: 'case:read', description: '一条公司档案的当前状态与计费实况' },

  // ──────── 网页会话专用（api key 不认）────────
  { category: 'web', method: 'GET', path: '/api/v1/keys', auth: 'jwt', description: '列出自己的 api key（永不回显明文或 hash）' },
  { category: 'web', method: 'POST', path: '/api/v1/keys', auth: 'jwt', description: '创建 api key，明文在本次响应里给出，同时以密文落库' },
  { category: 'web', method: 'GET', path: '/api/v1/keys/{id}/secret', auth: 'jwt', description: '取回这把 key 的明文（本能力上线前签发的旧密钥无密文，回 KEY_NOT_VIEWABLE）' },
  { category: 'web', method: 'POST', path: '/api/v1/keys/{id}/rotate', auth: 'jwt', description: '轮换：换发新明文，旧明文立即失效；id / name / scopes 不变' },
  { category: 'web', method: 'DELETE', path: '/api/v1/keys/{id}', auth: 'jwt', description: '吊销 api key（置 enabled=0，留行保审计线索）' },
  { category: 'web', method: 'POST', path: '/api/v1/realname/init', auth: 'jwt', description: '发起实人认证，返回 H5 活体认证页 URL' },
  { category: 'web', method: 'GET', path: '/api/v1/realname/status', auth: 'jwt', description: '查实人认证结果（落定后重复调用直接回存量结论）' },
  { category: 'web', method: 'POST', path: '/api/v1/realname/passport', auth: 'jwt', description: '护照实名提交（multipart），落「待审」等人工核；只有护照的人走这条' },

  // ──────── 管理员 ────────
  { category: 'admin', method: 'GET', path: '/api/v1/admin/audit', auth: 'admin', description: '最近的后台操作流水，只读（无删改端点）' },
  { category: 'admin', method: 'GET', path: '/api/v1/admin/users', auth: 'admin', description: '账号列表 + 检索 + 分页（手机号服务端已掩码）' },
  { category: 'admin', method: 'POST', path: '/api/v1/admin/users/{uid}/gongdao', auth: 'admin', description: '后台发公道值，op_ref 为幂等键' },
  { category: 'admin', method: 'POST', path: '/api/v1/admin/users/{uid}/membership', auth: 'admin', description: '后台调会员档（立即生效；降档 = 当前行提前到期 + 新行）' },
  { category: 'admin', method: 'GET', path: '/api/v1/admin/codes', auth: 'admin', description: '兑换码列表' },
  { category: 'admin', method: 'POST', path: '/api/v1/admin/codes', auth: 'admin', description: '批量签发兑换码' },
  { category: 'admin', method: 'GET', path: '/api/v1/admin/realname/pending', auth: 'admin', description: '待人工审核的护照实名队列（响应含 PII，刻意如此）' },
  { category: 'admin', method: 'GET', path: '/api/v1/admin/realname/{id}', auth: 'admin', description: '一条护照实名流水的详情；已落定的也能翻出来看' },
  { category: 'admin', method: 'GET', path: '/api/v1/admin/realname/{id}/photo/{kind}', auth: 'admin', description: '证件照原始字节，鉴权后流式返回（kind ∈ id_page | selfie）' },
  { category: 'admin', method: 'POST', path: '/api/v1/admin/realname/{id}/approve', auth: 'admin', description: '人工核过后落定实名' },
  { category: 'admin', method: 'POST', path: '/api/v1/admin/realname/{id}/reject', auth: 'admin', description: '驳回并写下谁驳的/何时/为什么，用户可重交' },
];
