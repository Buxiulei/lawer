---
name: 裁员应对档案
description: 通过 MCP 连接「土八鼠」的案件档案库，读写案件阶段、时间线、行动卡、法定期限与证据清单。当用户提到自己的劳动仲裁、裁员、被辞退、协商解除、欠薪、竞业等事情，或要求记录事情经过、查看下一步该做什么、确认某个期限还剩几天时使用。
---

<!--
  ⚠️ 生成文件，勿手改。由 scripts/gen-agent-docs.ts 从 ../接入说明.md 生成。
  要改内容请改那份正本，再到 app/ 下跑 `npm run gen:docs`；直接改这里，下次生成会被覆盖。
  接入面本身与客户端无关（MCP + REST 两个标准），别的客户端不需要这个文件。
-->

# 裁员应对档案

这份说明给**任何** AI 助手看：Claude、Codex、豆包、Trae、Cursor、自己写的 agent 都一样。
本服务只依赖两个标准——MCP（Streamable HTTP）与普通 HTTP REST，没有任何客户端专属要求。

## 这是什么

「土八鼠」是一个陪劳动者走完劳动仲裁全程的平台。用户在上面有一份**案件档案**：
案件走到哪一步、发生过什么事、下一步该做什么、哪些法定期限在逼近、手上有哪些证据。

接进来之后，用户跟你说的事情可以直接记进那份档案，你给的建议也能落成行动卡。
换台设备、换个助手、换个对话，档案都还在。

档案是长期记忆，也是仲裁时的陈述骨架——**时间线只追加不修改**，记错了补一条更正事件，
不要试图改写历史。

## 凭据

在网页端「设置 → API keys」创建一把 key。明文当场就能复制走；**忘了也不要紧**——
密钥是加密留存的，随时可以回设置页再看一次，或者轮换换一把新的（轮换后旧密钥立即失效，
名称与权限不变）。两种带法都认，用你的客户端支持的那种：

```
Authorization: Bearer <你的 api key>
X-API-Key: <你的 api key>
```

## 计费

- 在你自己的 agent 上处理的对话与案件分析，本服务不收费：下面这些工具与 REST 端点
  读写的是档案数据，**服务端一次模型都不调**，扣费自然无从谈起。
- 网页端（土八鼠站内）的对话仍按轮计公道值——那是我们这边真的替用户调模型。
- 后台的守望订阅按用量按月计费，下单前一定先报价、用户确认才扣。
- ⚠️ 例外一：`POST /api/v1/cases/{id}/chat` 是「让土八鼠这边的模型跑一轮」的端点，
  **调一次扣一轮公道值**。你自己会思考，不要调它；它不在下面的能力清单里。
- ⚠️ 例外二：`POST /api/v1/company/dossiers/confirm` 是公司档案的**下单确认**端点，
  **调一次就按报价把钱扣掉**（有会员赠送券的先核销券）。价钱由报价端点
  `POST /api/v1/company/dossiers/quote` 给出，报价只给数字、不动余额——
  先把报价原样念给用户、等他明确说买，再调 confirm，**不要替他下单**。
  这两条同样不在下面的能力清单里。

## 接入方式一：MCP

标准 Streamable HTTP transport，端点是 `<mcp_url>`（具体地址见 `GET /api/v1/agent-setup`
的 `mcp_url` 字段，或网页端设置页）。

多数客户端的配置文件长这样：

```json
{
  "mcpServers": {
    "lawer": {
      "type": "http",
      "url": "<mcp_url>",
      "headers": { "Authorization": "Bearer <你的 api key>" }
    }
  }
}
```

字段名各家不一：有的叫 `servers` 而不是 `mcpServers`，有的把 transport 写成 `transport: "http"`
或 `"streamable-http"`，有的在图形界面里填而不是写文件。以你所用客户端的文档为准——
本服务这边只要求：HTTP 传输 + 上面那个鉴权头。

握手用标准 `initialize`，支持的协议版本在 `GET /api/manifest` 的 `mcp.protocol_version` 里。

## 接入方式二：REST

客户端不支持 MCP 时走这条，能力完全一样（MCP 工具和 REST 端点调的是同一批服务端函数）。

- 接口基址：`<api_base>`
- 自描述清单：`GET /api/manifest`，**无需鉴权**，列出全部端点、鉴权方式、权限项与错误形状。
  不确定某个能力怎么调时先读它，不要猜。

## 能力清单

<!-- 本节与下面的错误码表由能力注册表生成，勿手改；改动请改 app/src/lib/capabilities/ 再跑 `npm run gen:docs`。 -->

**档案与事实**

| 工具 | REST | scope | 读写 | 用途 | 入参要点 |
|---|---|---|---|---|---|
| `case_get` | `GET /cases/{id}` | `case:read` | 读 | 读取一个案件的档案（阶段、目标、底线）以及最近的时间线事件。只能读自己的案件。 | `case_id` 案件 id；`timeline_limit`? 带回多少条时间线事件，默认 50，最多 200 |
| `case_update` | `PATCH /cases/{id}` | `case:write` | 写 | 更新案件档案：阶段 stage、目标 goal、底线 bottom_line，以及用工基本盘四项——入职时间 employed_from（YYYY-MM-DD）、月工资 monthly_wage_yuan（单位元）、岗位 position、合同签署次数 contract_count。**至少传一个**，用于零散补齐，不必重走首诊。stage 必须是法定枚举值之一。 | `case_id` 案件 id；`stage`? 案件所处阶段；`goal`? 用户自述的诉求目标；`bottom_line`? 用户自述的底线；`employed_from`? 入职时间，YYYY-MM-DD，不能晚于今天；工龄年限的起点；`monthly_wage_yuan`? 月工资，单位元（会换算成分落库）；所有赔偿金额的基数；`position`? 岗位；`contract_count`? 合同签署次数，用户自述原样记录，如「只签过一次」 |
| `case_facts` | — | `case:read` | 读 | 一次拿全这个案子的当前事实：当事人、案件抬头、法定期限、用工基本盘（入职时间/月薪/岗位）、公司主体、行动卡、诉求金额、时间线、证据清单。**回答任何与案情有关的问题之前先调它**。档案里没有的项会明写「未记录」——那是「档案里没有这一项」，不是「不存在」，不要自己脑补一个值。 | `case_id` 案件 id |
| `case_list` | `GET /cases` | `case:read` | 读 | 列出当前 api key 所属用户自己的全部案件（case_id、抬头 title、阶段 stage、建档时间），新的在前。**连上后先调它认领案件**：只有一个案件（绝大多数人）就直接用它的 case_id，不要开口问用户要编号；有多个就把抬头列出来让用户挑；一个都没有就请用户去网页端建档（首诊）。无需任何入参。 | 无入参 |
| `intake_submit` | `POST /cases/{id}/intake` | `case:write` | 写 | 把首诊问下来的内容一次性写进这个案件：阶段、公司名、入职时间、月工资、岗位、合同次数、经过（时间线）、诉求、底线。**新用户或用工基本盘还空着时用它一次建档**，问齐了再调，不要让用户回网页填。金额传元（monthly_wage_yuan），服务端换算成分。校验不过会逐字段回原因（如 INVALID_MONTHLY_WAGE），照着补齐再提交即可。 | `case_id` 案件 id；`stage` 案件所处阶段；`company_name` 公司名称，就是仲裁里的被申请人；`employed_from` 入职时间，YYYY-MM-DD，不能晚于今天；`monthly_wage_yuan` 月工资，单位元（会换算成分落库）；`goals` 诉求，至少一项；`position`? 岗位，可省略；`contract_count`? 合同签署次数，用户自述原样记录，可省略；`events`? 用户记得的事件，每条含 date（YYYY-MM-DD，可留空）与 text；`free_text`? 用户整段自述的经过，可省略；`company_docs`? 公司给过哪些文件（键 terminationNotice / settlementAgreement / otherPaper）；`company_wording`? 公司口头给的说法，可省略；`bottom_line`? 用户的底线，可省略 |

**时间线**

| 工具 | REST | scope | 读写 | 用途 | 入参要点 |
|---|---|---|---|---|---|
| `timeline_add` | `POST /cases/{id}/timeline` | `case:write` | 写 | 给案件时间线追加一条事件。时间线只追加不修改，记错了就再补一条更正事件。写入自带幂等：传相同 client_ref 重放只落一条（返回 deduped:true）；不传 client_ref 时，同一天、同类别、标题去掉标点空白后相同的事件也不会重复落库。 | `case_id` 案件 id；`happened_at` 事件发生时间，ISO8601 时间串；`kind` 事件类别；`title` 一句话概括发生了什么；`detail`? 细节补充，可省略；`client_ref`? 幂等键，一次业务操作给一个稳定值；重试用同一个 ref，服务端不会重复落库 |

**行动**

| 工具 | REST | scope | 读写 | 用途 | 入参要点 |
|---|---|---|---|---|---|
| `action_list` | `GET /cases/{id}/actions` | `case:read` | 读 | 列出案件下的行动项，可按状态过滤（待办 / 完成 / 放弃）。 | `case_id` 案件 id；`status`? 只看某个状态 |
| `action_complete` | `PATCH /cases/{id}/actions/{actionId}` | `case:write` | 写 | 把一条行动项标记为完成；也可以传 status 标记为放弃。 | `case_id` 案件 id；`action_id` 行动项 id；`status`? 目标状态，默认「完成」 |

**期限**

| 工具 | REST | scope | 读写 | 用途 | 入参要点 |
|---|---|---|---|---|---|
| `deadline_list` | `GET /cases/{id}/deadlines` | `case:read` | 读 | 列出案件的法定期限（仲裁时效、起诉 15 日、开庭等），默认只列生效中的，按到期时间升序。 | `case_id` 案件 id；`include_resolved`? 是否连已履行/作废的一起列出 |

**证据**

| 工具 | REST | scope | 读写 | 用途 | 入参要点 |
|---|---|---|---|---|---|
| `evidence_list` | `GET /cases/{id}/evidence` | `case:read` | 读 | 列出案件下已登记的证据条目（名称、分类、证明目的、固化状态）。 | `case_id` 案件 id |

**法律依据**

| 工具 | REST | scope | 读写 | 用途 | 入参要点 |
|---|---|---|---|---|---|
| `knowledge_search` | — | `case:read` | 读 | 按自然语言检索法条卡/判例卡/计算规则/流程SOP/文书模板/话术卡/情绪指南/数据卡。任何涉法断言、任何数字、任何文书起草之前都先调它——你记忆里的条号和数字一律不可用。每张卡带 citation_guide（可直接照抄的引用块）与 confidence；confidence 是「待核实」的必须如实转达给用户。检索不到就说查不到，不要编条号和案号。 | `query` 检索词，用案情关键词而非整句话，如「客观情况重大变化 北京口径」；`type`? 只要某一类卡时传，一般不传；`limit`? 最多几张，默认与上限都是 6；超出这个范围会被夹回 1~6 |

只能读写用户自己的案件。传了别人的 `case_id`，服务端一律回「案件不存在」——
不区分"不存在"和"不是你的"，别据此推断案件号的有效性。

## 边界红线

- **对外的东西由本人拍板。** 异议函、被迫解除通知、仲裁申请书、给 HR 的回复——可以起草，
  但发出去之前必须由用户本人逐字确认。任何情况下都不要代替用户发送。
- **档案数据只用于本案。** 里面是解除通知、工资流水、身份信息、谈话录音。
  不要把这些内容带到与本案无关的对话、工具或外部服务里去。
- **不可逆的决定留给用户。** 签字、不签字、接受方案、放弃某项诉求、撤回仲裁——
  可以分析利弊，但不要替他做，也不要用"建议你现在就签"这类推着走的说法。
- **不冒充律师。** 你提供的是法律信息与行动建议，不是律师意见，也不构成委托代理关系。
  同样地，不必反复劝用户去找律师——用得上这个平台的人，多半正是请不起律师的那些人。
- **人比案子重要。** 用户表现出持续的严重情绪痛苦时，先接住人，再谈案子。

## 接入步骤

1. 网页端创建 api key（忘了可以回去再看，见「凭据」节）。
2. 按上面任一方式接上（MCP 优先；不支持就走 REST）。
3. 连上后先调 `case_list`（走 REST 就 `GET /cases`）认领案件：只有一个案件就直接用它的
   case_id、**不要问用户要编号**；有多个就让用户挑；一个都没有（或基本盘还空着）就按首诊清单
   问齐后用 `intake_submit` 建档，**别把用户支回网页填**。
4. 拿到 case_id 后再调一次 `case_facts`（走 REST 就 `GET /cases/{id}`），把当前事实拿到手再开始对话。
   事实卡里写着「未记录」的项是**档案里没有这一项**，不是"不存在"——缺哪一项就问用户，
   不要拿默认值替它。
5. 陪跑时的对话纪律、引用规则与危机处理见 `GET /skill/陪跑指南.md`（免鉴权）；
   总纲入口是 `GET /skill/SKILL.md`。

## 错误约定

响应统一是这个形状：

```json
{ "ok": false, "error_code": "CASE_NOT_FOUND", "message": "案件不存在" }
```

**按 `error_code` 分支，不要按 HTTP 状态码分支。** 对方会碰上的码：

**凭据与权限**

| error_code | HTTP | 什么时候拿到它 | 拿到之后怎么办 |
|---|---|---|---|
| `UNAUTHORIZED` | 401 | 没带凭据，或凭据无效／已吊销（两种不区分） | 让用户回网页设置页取一把新 key |
| `FORBIDDEN_SCOPE` | 403 | 凭据有效，但这把 key 没被授予该端点要的权限 | 换一把带该 scope 的 key，或让用户在设置页给它补权限 |
| `WEB_SESSION_REQUIRED` | 403 | 这条端点只认网页登录态；api key 一律拒（key 不能自我增殖） | 请用户在网页上做，不要试图用 key 绕 |

**服务端闸门**

| error_code | HTTP | 什么时候拿到它 | 拿到之后怎么办 |
|---|---|---|---|
| `REALNAME_REQUIRED` | 403 | 该动作要求用户已完成实名（证据上传、固化出证）；「待审」不算已实名 | 把这一步是干什么的说清楚，请用户在网页上完成实名后再来 |

**找不到对象**

| error_code | HTTP | 什么时候拿到它 | 拿到之后怎么办 |
|---|---|---|---|
| `CASE_NOT_FOUND` | 404 | 案件不存在，**或不属于本人**——两者刻意不区分 | 先调 case_list 拿本人名下真实的 case_id，不要据此推断编号有效性 |
| `ACTION_NOT_FOUND` | 404 | 行动卡 id 不在本案下 | — |
| `EVENT_NOT_FOUND` | 404 | 时间线事件 id 不在本案下 | — |
| `EVIDENCE_NOT_FOUND` | 404 | 证据 id 不存在或不属于本人 | — |
| `ORDER_NOT_FOUND` | 404 | 存证订单号查不到 | — |
| `DOSSIER_NOT_FOUND` | 404 | 公司档案 id 查不到 | — |
| `KEY_NOT_FOUND` | 404 | api key id 不在本人名下 | — |

**入参不合法**

| error_code | HTTP | 什么时候拿到它 | 拿到之后怎么办 |
|---|---|---|---|
| `INVALID_BODY` | 400 | 请求体不是合法 JSON，或缺必填字段 | 照 manifest 里该端点的入参重发；不要重试同一份体 |
| `INVALID_CASE_ID` | 400 | case_id 不是正整数 | — |
| `INVALID_STAGE` | 400 | stage 不在法定枚举里 | 取值见 case_get 回包里的当前 stage 与工具入参说明 |
| `INVALID_HAPPENED_AT` | 400 | 时间不是 ISO8601，或落在合理区间之外 | — |
| `INVALID_KIND` | 400 | kind 不在该表的法定枚举里 | — |
| `INVALID_MONTHLY_WAGE` | 400 | 月薪不是正数（单位是**元**，不是分） | — |
| `NO_FIELDS` | 400 | 更新类调用一个字段都没传 | — |
| `FILE_TOO_LARGE` | 413 | 上传文件超过单文件上限 | — |

**余额与并发**

| error_code | HTTP | 什么时候拿到它 | 拿到之后怎么办 |
|---|---|---|---|
| `GONGDAO_EXHAUSTED` | 402 | 余额不足以完成这次扣费动作 | 把差额如实告诉用户，不要改小参数重试 |
| `UPLOAD_BUSY` | 429 | 同时进行的上传过多（内存闸门） | 退避后重试 |
| `TURN_IN_FLIGHT` | 409 | 本案已有一轮站内对话在跑 | 等上一轮结束，不要并发发起 |
