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
  { category: 'public', method: 'GET', path: '/api/openapi.json', auth: 'none', description: 'OpenAPI 3.1 文档，由能力注册表与本索引生成；`?profile=actions` 出精简集（供只吃 OpenAPI 的客户端一键导入）' },
  { category: 'public', method: 'GET', path: '/api/mcp', auth: 'none', description: 'MCP 端点的自述（传输方式与协议版本）；真正的调用走同路径的 POST' },
  { category: 'public', method: 'GET', path: '/api/v1/version', auth: 'none', description: '当前产物的构建信息（commit sha 可能为 null，读到 null 应判「无法核验」）' },
  { category: 'public', method: 'GET', path: '/api/v1/domains', auth: 'none', description: '当前环境开着哪几类纠纷（key 即案件的 domain，label 是给人看的名字）。注册页在建号之前要摆选择控件，那一刻还没有凭据，所以免鉴权' },
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
  { category: 'public', method: 'GET', path: '/api/v1/share/{token}', auth: 'none', description: '按分享 token 读一份文书正文或一件材料的说明（刻意无鉴权：分享给没有账号的人看的）。到期回 410 SHARE_EXPIRED、被收回回 410 SHARE_REVOKED，与 404 分开' },
  { category: 'public', method: 'GET', path: '/api/v1/files/download/{token}', auth: 'none', description: '用一次性 token 取回一份导出件（浏览器直接打开即可）。只能取一次、10 分钟内有效；用过或过期回 410' },
  // OAuth 2.1 授权服务器。四条全部无鉴权，凭据是 PKCE 与令牌本身；唯一由本人确认的一步
  // 是同意页的 POST /api/oauth/authorize（在下面的「网页会话专用」里）。
  { category: 'public', method: 'GET', path: '/api/oauth/metadata/authorization-server', auth: 'none', description: '授权服务器元数据；对外地址是 /.well-known/oauth-authorization-server（next.config 的 rewrite）' },
  { category: 'public', method: 'GET', path: '/api/oauth/metadata/protected-resource', auth: 'none', description: '受保护资源元数据；对外地址是 /.well-known/oauth-protected-resource' },
  { category: 'public', method: 'POST', path: '/api/oauth/register', auth: 'none', description: '动态客户端注册：登记客户端名与回调地址白名单，发一个 client_id（public client，无 secret）' },
  { category: 'public', method: 'GET', path: '/api/oauth/authorize', auth: 'none', description: '校验一次授权请求并回「谁在申请、要什么权限」给同意页显示；不签发任何凭据' },
  { category: 'public', method: 'POST', path: '/api/oauth/token', auth: 'none', description: '换令牌：authorization_code（校 PKCE、一次性）与 refresh_token（旋转）' },
  { category: 'public', method: 'POST', path: '/api/oauth/revoke', auth: 'none', description: '交还令牌，吊销整条授权链；认不出的令牌同样回 200（不做令牌探测器）' },

  // ──────── agent 面（jwt 或 api key）────────
  { category: 'agent', method: 'POST', path: '/api/mcp', auth: 'jwt|api_key', description: 'MCP JSON-RPC 2.0 入口（Streamable HTTP），工具面见本清单 mcp.tools' },
  { category: 'agent', method: 'GET', path: '/api/v1/agent-setup', auth: 'jwt|api_key', description: '一键接入信息：mcp_url / api_base、工具清单、接入说明全文（不校 scope）' },
  { category: 'agent', method: 'GET', path: '/api/v1/tools', auth: 'jwt|api_key', description: '通用桥能调的能力清单：名、scope、读写、前置闸、入参 schema（不校 scope）' },
  { category: 'agent', method: 'POST', path: '/api/v1/tools/{name}', auth: 'jwt|api_key', description: '通用工具桥：按能力名调任意一条能力，body = 该能力 inputSchema 的入参 JSON。scope 按能力自身要求判，与 MCP 同一批判定' },
  { category: 'agent', method: 'GET', path: '/api/v1/me', auth: 'jwt|api_key', scope: 'case:read', description: '本人身份摘要（手机号在服务端已掩码）' },
  { category: 'agent', method: 'GET', path: '/api/v1/referrals', auth: 'jwt|api_key', scope: 'case:read', description: '本人名下的转介台账与状态，外加「转介会传什么、不会传什么」那份同意文案；不回数据包全文' },
  { category: 'agent', method: 'POST', path: '/api/v1/referrals/{id}/delete-request', auth: 'jwt|api_key', scope: 'case:write', description: '要求删除一条已发出的转介（对应工具 referral_delete_request）。今天只记在本站并由人工转达，回包 delivered 恒为 false' },
  { category: 'agent', method: 'GET', path: '/api/v1/me/storage', auth: 'jwt|api_key', scope: 'case:read', description: '本人的存储用量；不接受任何指定用户的入参' },
  { category: 'agent', method: 'GET', path: '/api/v1/realname/status', auth: 'jwt|api_key', description: '查本人实名状态。网页登录态会去上游拉一次结果；api key 只读三态（已实名/待审/未认证），不回姓名证件（不校 scope）' },
  { category: 'agent', method: 'GET', path: '/api/v1/billing/ledger', auth: 'jwt|api_key', scope: 'case:read', description: '本人的公道值余额与流水（同时给 balance 与 ledger_sum）' },
  { category: 'agent', method: 'POST', path: '/api/v1/redeem', auth: 'jwt|api_key', scope: 'case:write', description: '兑换码入账（一码一兑，失败有锁）' },
  { category: 'agent', method: 'GET', path: '/api/v1/cases', auth: 'jwt|api_key', scope: 'case:read', description: '名下案件清单，新的在前（对应工具 case_list）' },
  { category: 'agent', method: 'GET', path: '/api/v1/cases/{id}', auth: 'jwt|api_key', scope: 'case:read', description: '案件档案 + 最近时间线（对应工具 case_get）' },
  { category: 'agent', method: 'GET', path: '/api/v1/cases/{id}/facts', auth: 'jwt|api_key', scope: 'case:read', description: '案件事实卡全文，与站内每轮同一渲染（对应工具 case_facts）' },
  { category: 'agent', method: 'PATCH', path: '/api/v1/cases/{id}', auth: 'jwt|api_key', scope: 'case:write', description: '更新阶段 / 目标 / 底线及用工基本盘（对应工具 case_update）' },
  { category: 'agent', method: 'DELETE', path: '/api/v1/cases/{id}', auth: 'jwt|api_key', scope: 'case:write', description: '删除案件档案（对应工具 case_delete）。不带 ?confirm_token= 只回确认单、一行不删；带上才执行。软删即刻生效，30 日后彻底删除，不可撤销' },
  { category: 'agent', method: 'GET', path: '/api/v1/cases/{id}/export', auth: 'jwt|api_key', scope: 'case:read', description: '导出整案副本 zip（档案 JSON + 文书 PDF + 证据原件），回一条一次性下载地址（对应工具 case_export）。免费。**需已实名**' },
  { category: 'agent', method: 'POST', path: '/api/v1/cases/{id}/intake', auth: 'jwt|api_key', scope: 'case:write', description: '首诊建档：一次原子写入基本盘 + 时间线 + 诉求（对应工具 intake_submit）' },
  { category: 'agent', method: 'GET', path: '/api/v1/cases/{id}/messages', auth: 'jwt|api_key', scope: 'case:read', description: '案件的历史对话（只读；写那一路在同级 chat）' },
  { category: 'agent', method: 'POST', path: '/api/v1/cases/{id}/chat', auth: 'jwt|api_key', scope: 'case:write', description: '让本服务的模型跑一轮并回 SSE。**调一次扣一轮公道值**，自带模型的 agent 不要调' },
  { category: 'agent', method: 'GET', path: '/api/v1/cases/{id}/report', auth: 'jwt|api_key', scope: 'case:read', description: '读个案报告：整理过的分节长期记忆 + 渲染稿 + 过期标（对应工具 case_report_get；首次读会惰性生成初稿）' },
  { category: 'agent', method: 'GET', path: '/api/v1/cases/{id}/timeline', auth: 'jwt|api_key', scope: 'case:read', description: '分页读时间线，可按 since / kind 过滤（对应工具 timeline_list）' },
  { category: 'agent', method: 'POST', path: '/api/v1/cases/{id}/timeline', auth: 'jwt|api_key', scope: 'case:write', description: '追加一条时间线事件，只追加无改删（对应工具 timeline_add）' },
  { category: 'agent', method: 'POST', path: '/api/v1/cases/{id}/timeline/{eventId}/milestone', auth: 'jwt|api_key', scope: 'case:write', description: '给一条时间线事件盖里程碑' },
  { category: 'agent', method: 'GET', path: '/api/v1/cases/{id}/actions', auth: 'jwt|api_key', scope: 'case:read', description: '列出行动卡，可按状态过滤（对应工具 action_list）' },
  { category: 'agent', method: 'POST', path: '/api/v1/cases/{id}/actions', auth: 'jwt|api_key', scope: 'case:write', description: '新建行动卡，一次一批（对应工具 action_create）' },
  { category: 'agent', method: 'PATCH', path: '/api/v1/cases/{id}/actions/{actionId}', auth: 'jwt|api_key', scope: 'case:write', description: '把行动卡标为完成或放弃（对应工具 action_complete）' },
  { category: 'agent', method: 'GET', path: '/api/v1/cases/{id}/deadlines', auth: 'jwt|api_key', scope: 'case:read', description: '列出法定期限（对应工具 deadline_list）' },
  { category: 'agent', method: 'GET', path: '/api/v1/cases/{id}/claims', auth: 'jwt|api_key', scope: 'case:read', description: '列出诉求清单与合计金额（对应工具 claims_list）' },
  { category: 'agent', method: 'GET', path: '/api/v1/cases/{id}/elements', auth: 'jwt|api_key', scope: 'case:read', description: '读要件表：每项已登记诉求各靠哪几个要件成立、状态、该谁举证、缺什么（对应工具 element_sheet_get）；?claim_kind= 只看一项' },
  { category: 'agent', method: 'GET', path: '/api/v1/cases/{id}/issues', auth: 'jwt|api_key', scope: 'case:read', description: '读争点表：由要件表派生的争点与每条的下一步（对应工具 issue_list）' },
  { category: 'agent', method: 'GET', path: '/api/v1/cases/{id}/evidence', auth: 'jwt|api_key', scope: 'case:read', description: '列出案件下的证据条目，只给元数据（对应工具 evidence_list）；已作废的默认不列，传 ?include_voided=1 才回' },
  { category: 'agent', method: 'GET', path: '/api/v1/cases/{id}/drafts', auth: 'jwt|api_key', scope: 'case:read', description: '列出案件下的文书，正文一并返回' },
  { category: 'agent', method: 'GET', path: '/api/v1/cases/{id}/docs', auth: 'jwt|api_key', scope: 'case:read', description: '列出案件下已解读的对方来文，不含原文与逐条发现（对应工具 doc_list）' },
  { category: 'agent', method: 'GET', path: '/api/v1/cases/{id}/opener', auth: 'jwt|api_key', scope: 'case:read', description: '「无工具模式」的开场白纯文本：陪跑纪律 + 回填约定 + 事实卡 + 简报摘要，?tier=long|medium|short 决定篇幅' },
  { category: 'agent', method: 'GET', path: '/api/v1/cases/{id}/dossier', auth: 'jwt|api_key', scope: 'case:read', description: '本案对方主体的公司档案（页面手上只有 case_id 时走这条）' },
  { category: 'agent', method: 'GET', path: '/api/v1/cases/{id}/company-graph', auth: 'jwt|api_key', scope: 'case:read', description: '本案的公司关系图谱；没做过调查时 graph 为 null（不是错误）' },
  { category: 'agent', method: 'POST', path: '/api/v1/cases/{id}/watch', auth: 'jwt|api_key', scope: 'case:write', description: '给对方主体加守望。本次不扣钱，扣费在月度巡检；同案同主体去重' },
  { category: 'agent', method: 'POST', path: '/api/v1/evidence', auth: 'jwt|api_key', scope: 'case:write', description: '上传证据文件（multipart）。**需已实名**，未实名回 REALNAME_REQUIRED' },
  { category: 'agent', method: 'PUT', path: '/api/v1/evidence/upload/{token}', auth: 'jwt|api_key', scope: 'case:write', description: '用一次性 token 上传字节（body 就是文件本身）。**需已实名**；地址只收一次文件、10 分钟内有效；传完再用同一个 token 调工具 evidence_register 登记条目' },
  { category: 'agent', method: 'GET', path: '/api/v1/evidence/{id}', auth: 'jwt|api_key', scope: 'case:read', description: '单条证据详情（含其存证订单，如果已发起过固化）' },
  { category: 'agent', method: 'GET', path: '/api/v1/docs/{id}', auth: 'jwt|api_key', scope: 'case:read', description: '单份来文解读的全文：原文、总结论与逐条发现（对应工具 doc_get）' },
  { category: 'agent', method: 'POST', path: '/api/v1/evidence/{id}/attest', auth: 'jwt|api_key', scope: 'case:write', description: '发起证据固化出证（时间戳 + 证明 PDF + 签名）。**需已实名**；重复 POST 幂等' },
  { category: 'agent', method: 'POST', path: '/api/v1/evidence/{id}/extract', auth: 'jwt|api_key', scope: 'case:write', description: '内容提取（对应工具 evidence_extract）。不带 quote_id = 只看价、这一步不产生扣费；带上 = 确认扣费并排队。**需已实名**' },
  { category: 'agent', method: 'GET', path: '/api/v1/evidence/{id}/brief', auth: 'jwt|api_key', scope: 'case:read', description: '读一件材料的简报与它的版本号（对应工具 evidence_brief_get）' },
  { category: 'agent', method: 'PUT', path: '/api/v1/evidence/{id}/brief', auth: 'jwt|api_key', scope: 'case:write', description: '整份改写简报（对应工具 evidence_brief_update）。base_version 对不上回 409，不覆盖' },
  { category: 'agent', method: 'POST', path: '/api/v1/evidence/{id}/brief/regenerate', auth: 'jwt|api_key', scope: 'case:write', description: '重新生成简报（对应工具 evidence_brief_regenerate）。不计费；已有简报的一律拒，不覆盖' },
  { category: 'agent', method: 'POST', path: '/api/v1/evidence/{id}/void', auth: 'jwt|api_key', scope: 'case:write', description: '作废一件材料（对应工具 evidence_void）。reason 必填；作废后不进默认清单与事实卡、不能出证，已出的证不撤销' },
  { category: 'agent', method: 'POST', path: '/api/v1/company/probe', auth: 'jwt|api_key', scope: 'case:read', description: '免费前置探测：扣费前先给数字与工商状态，降级时如实回 reason' },
  { category: 'agent', method: 'GET', path: '/api/v1/knowledge/search', auth: 'jwt|api_key', scope: 'case:read', description: '按自然语言检索知识库（对应工具 knowledge_search）' },
  { category: 'agent', method: 'POST', path: '/api/v1/company/dossiers/quote', auth: 'jwt|api_key', scope: 'case:read', description: '公司档案报价。**不动钱**：不扣费、不建档、不占额度' },
  { category: 'agent', method: 'POST', path: '/api/v1/company/dossiers/confirm', auth: 'jwt|api_key', scope: 'case:write', description: '公司档案下单确认，**调一次就按报价扣费**。先把报价念给用户、等他明确说买再调' },
  { category: 'agent', method: 'GET', path: '/api/v1/company/dossiers/{id}', auth: 'jwt|api_key', scope: 'case:read', description: '一条公司档案的当前状态与计费实况' },

  // ──────── 网页会话专用（api key 不认）────────
  { category: 'web', method: 'POST', path: '/api/oauth/authorize', auth: 'jwt', description: 'OAuth 同意页点「同意」：签发一次性授权码；只认网页登录态（不能用令牌换新授权）' },
  { category: 'web', method: 'POST', path: '/api/v1/cases/{id}/paste-back', auth: 'jwt', description: '把助手回复里的结构块解析成待写入条目并回预览，**一行都不写库**' },
  { category: 'web', method: 'POST', path: '/api/v1/cases/{id}/paste-back/confirm', auth: 'jwt', description: '写入上一步预览里勾中的条目，走与 MCP 同一批能力；同批重放零双写' },
  // 【为什么它在 web 而不是 agent 面】时间线的 event_type 是**登记人自己的判断**，
  // 而要件判定优先读这一格、不再回落到谓词。开给 key 的形态是：模型读完那段自述替用户把
  // 类型定了，归类从此压过服务端的谓词，且库里看不出这一格是人选的还是模型填的。
  // 登记那一条（POST /timeline）照旧开给 agent：那是把用户说过的事第一次记下来。
  { category: 'web', method: 'PATCH', path: '/api/v1/cases/{id}/timeline/{eventId}', auth: 'jwt', description: '补选（或改写）一条时间线事件的类型 event_type。这是时间线上唯一可改的一列——时间、类别、标题、详情、来源档一律只追加不改删，记错了补一条新的' },
  { category: 'web', method: 'GET', path: '/api/v1/keys', auth: 'jwt', description: '列出自己的 api key（永不回显明文或 hash）' },
  { category: 'web', method: 'POST', path: '/api/v1/keys', auth: 'jwt', description: '创建 api key，明文在本次响应里给出，同时以密文落库' },
  { category: 'web', method: 'GET', path: '/api/v1/keys/{id}/secret', auth: 'jwt', description: '取回这把 key 的明文（本能力上线前签发的旧密钥无密文，回 KEY_NOT_VIEWABLE）' },
  { category: 'web', method: 'POST', path: '/api/v1/keys/{id}/rotate', auth: 'jwt', description: '轮换：换发新明文，旧明文立即失效；id / name / scopes 不变' },
  { category: 'web', method: 'DELETE', path: '/api/v1/keys/{id}', auth: 'jwt', description: '吊销 api key（置 enabled=0，留行保审计线索）' },
  { category: 'web', method: 'POST', path: '/api/v1/consents', auth: 'jwt', description: '记一次单独同意（realname_adopt / emotion）。协议、年龄、实名、境外模型四类各有自己的采集点，不从这条收' },
  // 【TERMS_NOT_LIVE 为什么只写在这条描述里、不进 error-codes.ts】那张表收的是**对方 agent
  // 会拿到并需要分支处理**的码（见该文件抬头），而本条是 web 面：api key 一律拒，
  // 走 key 的调用在这道闸之前就已经拿到 WEB_SESSION_REQUIRED 了，永远碰不到 TERMS_NOT_LIVE。
  // 登记进去的形态是：接入说明里多一句对方永远读不到的错误处理指引。
  // 描述里不写那个环境变量的名字，是因为它只允许出现在唯一读取口 lib/auth/consent.ts
  // 与 .env.example / docs（由 lib/__tests__/terms-live-single-read.test.ts 机检）。
  { category: 'web', method: 'POST', path: '/api/v1/me/preferences', auth: 'jwt', description: '境外模型与评测授权两个开关；开启境外模型要带 consent:true（读过 /terms/overseas 之后）。协议未生效期间（服务端的协议生效旗关着，见 lib/auth/consent.termsLive）开境外一律 400 TERMS_NOT_LIVE：开关不动、台账不落行；关闭境外任何时候都不受这道闸影响' },
  { category: 'web', method: 'POST', path: '/api/v1/realname/init', auth: 'jwt', description: '发起实人认证，返回 H5 活体认证页 URL；要带 consent:true（收证件号前的单独同意）' },
  { category: 'web', method: 'POST', path: '/api/v1/realname/passport', auth: 'jwt', description: '护照实名提交（multipart，含 consent=true），落「待审」等人工核；只有护照的人走这条' },
  { category: 'web', method: 'GET', path: '/api/v1/me/consents', auth: 'jwt', description: '本人的单独同意清单与此刻状态（每项带「撤回之后会发生什么」）' },
  { category: 'web', method: 'POST', path: '/api/v1/me/consents', auth: 'jwt', description: '撤回一项单独同意（幂等；撤回不删记录）。撤回情绪那一项即停止写入情绪记录，撤回境外那一项即只走境内模型' },
  { category: 'web', method: 'POST', path: '/api/v1/me/cancel', auth: 'jwt', description: '注销账号。不带 code 只出确认单并把验证码发到本人手机/邮箱（零删除）；带 confirm_token + code 才执行。不可撤销' },
  // 【为什么这两条在 web 而不是 agent 面】提投诉/举报/个人信息权利请求是**本人的法律行为**，
  // 一条「请删除我的个人信息」要在 15 个工作日内办结。让 api key 也能提的形态是：
  // 用户接进来的某个助手替他提了一条，钟已经在走、答复寄往那条记录里留的联系方式，而本人不知情。
  { category: 'web', method: 'POST', path: '/api/v1/complaints', auth: 'jwt', description: '提交投诉 / 举报 / 个人信息权利请求，回一串受理编号；受理与答复时限见协议第十二条' },
  { category: 'web', method: 'GET', path: '/api/v1/complaints', auth: 'jwt', description: '自己提过的那几条（含受理编号与提交时间）' },

  // ──────── 管理员 ────────
  { category: 'admin', method: 'GET', path: '/api/v1/admin/audit', auth: 'admin', description: '最近的后台操作流水，只读（无删改端点）' },
  { category: 'admin', method: 'GET', path: '/api/v1/admin/users', auth: 'admin', description: '账号列表 + 检索 + 分页（手机号服务端已掩码）' },
  { category: 'admin', method: 'POST', path: '/api/v1/admin/users/{uid}/gongdao', auth: 'admin', description: '后台发公道值，op_ref 为幂等键' },
  { category: 'admin', method: 'POST', path: '/api/v1/admin/users/{uid}/membership', auth: 'admin', description: '后台调会员档（立即生效；降档 = 当前行提前到期 + 新行）' },
  { category: 'admin', method: 'GET', path: '/api/v1/admin/complaints', auth: 'admin', description: '投诉 / 举报 / 个人信息权利请求的受理台账，**只读**（无改状态的端点：后台页也没有那个按钮）；响应含投诉人联系方式，刻意如此' },
  { category: 'admin', method: 'GET', path: '/api/v1/admin/codes', auth: 'admin', description: '兑换码列表' },
  { category: 'admin', method: 'POST', path: '/api/v1/admin/codes', auth: 'admin', description: '批量签发兑换码' },
  { category: 'admin', method: 'GET', path: '/api/v1/admin/realname/pending', auth: 'admin', description: '待人工审核的护照实名队列（响应含 PII，刻意如此）' },
  { category: 'admin', method: 'GET', path: '/api/v1/admin/realname/{id}', auth: 'admin', description: '一条护照实名流水的详情；已落定的也能翻出来看' },
  { category: 'admin', method: 'GET', path: '/api/v1/admin/realname/{id}/photo/{kind}', auth: 'admin', description: '证件照原始字节，鉴权后流式返回（kind ∈ id_page | selfie）' },
  { category: 'admin', method: 'POST', path: '/api/v1/admin/realname/{id}/approve', auth: 'admin', description: '人工核过后落定实名' },
  { category: 'admin', method: 'POST', path: '/api/v1/admin/realname/{id}/reject', auth: 'admin', description: '驳回并写下谁驳的/何时/为什么，用户可重交' },
];
