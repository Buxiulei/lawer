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
- OpenAPI 3.1 文档：`GET /api/openapi.json`，**无需鉴权**，可直接导入吃 OpenAPI 的客户端或代码生成器。
  带 `?profile=actions` 出精简集——有些客户端对一份 schema 里的接口数量有上限，全量会被它自己截断，
  而**截掉哪几条由它决定**。

## 客户端矩阵

<!-- 本节由 app/src/lib/capabilities/client-matrix.ts 生成，勿手改；改动请改那份再跑 `npm run gen:docs`。
     地址一律写成占位符：真地址由服务端按 env 算出来，写死的那份在预发环境上指向的是生产。 -->

| 客户端 | 接入路径 | 现状 |
|---|---|---|
| ChatGPT 网页 · 连接器 | A. MCP + OAuth | 现在可用 |
| ChatGPT · 自定义 GPT Actions | C. REST + API key | 现在可用 |
| Claude 网页 · 连接器 | A. MCP + OAuth | 现在可用 |
| Claude Code | B. MCP + Bearer | 现在可用 |
| Gemini CLI | B. MCP + Bearer | 现在可用 |
| Cursor / Cline | B. MCP + Bearer | 现在可用 |
| Kimi | A. MCP + OAuth | 现在可用 |
| 扣子空间 | A. MCP + OAuth | 现在可用 |
| 自建 agent（REST） | C. REST + API key | 现在可用 |
| 无工具网页对话（DeepSeek / 豆包 / Gemini 网页） | D. 无工具模式（复制粘贴） | 现在可用 |

### ChatGPT 网页 · 连接器

路径 A（MCP + OAuth）·现在可用

1. ChatGPT 的自定义连接器只接受 OAuth，不接受在界面里填 Bearer 密钥——走 OAuth 这条路，密钥你一个字都不用填。
2. 设置 → 连接器 → 添加，地址粘下面这个：<mcp_url>。鉴权那栏留给它自己发现（它会自己去注册一个客户端 ID）。
3. 它会跳到本站的授权页。没登录先登录（手机号或邮箱验证码），登完自动跳回；授权页上写着是哪个客户端在申请、要哪些权限，点「同意并接入」就接完了。
4. 接完在「设置 → API key」里会多出一行「来自 <客户端名> 的授权」，吊销那一行即断开它。

连接器地址：

```
<mcp_url>
```

### ChatGPT · 自定义 GPT Actions

路径 C（REST + API key）·现在可用

1. 在 ChatGPT 里新建一个 GPT：右上角头像 → My GPTs → Create a GPT → Configure → 拉到底点 Create new action。
2. 点 Import from URL，粘下面这个地址导入。它是精简集（只含最常用的那几条），因为 Actions 对一份 schema 里的接口数量有上限：<openapi_url>?profile=actions
3. Authentication 选 API Key，Auth Type 选 Bearer，把你的密钥粘进 API Key 那一栏。
4. 保存后在预览里问一句「读一下我的档案」，它会请求你授权调用，允许即可。
5. 要全量接口（自己写脚本或用别的能吃 OpenAPI 的工具）就去掉 `?profile=actions`。

OpenAPI 导入地址（精简集）：

```
<openapi_url>?profile=actions
```

### Claude 网页 · 连接器

路径 A（MCP + OAuth）·现在可用

1. 设置 → 连接器 → 添加自定义连接器，地址填下面这个：<mcp_url>。标准配置里只有 OAuth 字段，而 OAuth 正是这条路要走的，不用你填任何密钥。
2. 点添加后它会跳到本站的授权页。没登录先登录（手机号或邮箱验证码），登完自动跳回；在授权页上确认申请方与权限，点「同意并接入」。
3. 接完在「设置 → API key」里会多出一行「来自 <客户端名> 的授权」，吊销那一行即断开它。
4. 桌面版与 Claude Code 接的是同一个服务，能力完全一样，接哪个都行。

连接器地址：

```
<mcp_url>
```

### Claude Code

路径 B（MCP + Bearer）·现在可用

1. 在终端里跑下面这条命令，一条就接上了。
2. 跑完 `claude mcp list` 能看到它，就是好了。

一条命令：

```
claude mcp add --transport http lawer <mcp_url> --header "Authorization: Bearer <你的密钥>"
```

### Gemini CLI

路径 B（MCP + Bearer）·现在可用

1. 在终端里跑下面这条命令（Gemini CLI 原生支持自定义请求头）。
2. 也可以把等价配置写进 `~/.gemini/settings.json` 的 mcpServers 段。
3. 装好后用 `/mcp` 看一眼列表里有没有它。

一条命令：

```
gemini mcp add --transport http lawer <mcp_url> --header "Authorization: Bearer <你的密钥>"
```

### Cursor / Cline

路径 B（MCP + Bearer）·现在可用

1. Cursor：Settings → MCP → Add new MCP server → 选 Raw JSON，把下面这段粘进去。
2. Cline：MCP Servers 面板 → Configure MCP Servers → 同一段 JSON 粘进配置文件。
3. 粘完重启一次客户端——多数客户端不重启不会重新读配置。

MCP 配置（JSON）：

```
{
  "mcpServers": {
    "lawer": {
      "type": "http",
      "url": "<mcp_url>",
      "headers": {
        "Authorization": "Bearer <你的密钥>"
      }
    }
  }
}
```

### Kimi

路径 A（MCP + OAuth）·现在可用

1. 网页端：在连接器里填地址 <mcp_url>，鉴权走 OAuth（它自己发现、自己注册），跳到本站授权页点「同意并接入」即可，不用填密钥。
2. 命令行版（Kimi CLI）能填自定义请求头，把地址 <mcp_url> 与 Authorization 头按下面这段写进它的 MCP 配置即可。
3. 两端接的是同一个服务，档案与能力完全一样。

MCP 配置（JSON，命令行版用）：

```
{
  "mcpServers": {
    "lawer": {
      "type": "http",
      "url": "<mcp_url>",
      "headers": {
        "Authorization": "Bearer <你的密钥>"
      }
    }
  }
}
```

### 扣子空间

路径 A（MCP + OAuth）·现在可用

1. 豆包的聊天框本身不能接外部工具；能接的是同一生态里的扣子空间。
2. 在扣子空间里新建一个 MCP 连接，传输选 HTTP。
3. 服务地址：<mcp_url>。鉴权那一栏能自定义请求头就填 Authorization: Bearer <你的密钥>；只给 OAuth 选项也行，点下去会跳到本站授权页，同意即接上。
4. 两种鉴权都接不上的话，用最后一档「无工具网页对话」在豆包里照样能陪跑，只是每次要重贴开场白。

服务地址与请求头：

```
<mcp_url>
Authorization: Bearer <你的密钥>
```

### 自建 agent（REST）

路径 C（REST + API key）·现在可用

1. 先读能力清单（免鉴权，含全部接口自描述）：<manifest_url>
2. 要生成客户端代码就用 OpenAPI 文档：<openapi_url>
3. 业务基址 <api_base>，每个请求都带 Authorization: Bearer <你的密钥>。
4. 下面这条 curl 用来验密钥通不通——它需要鉴权但不要求任何权限项，拿它试最干净。

验一下通不通：

```
curl -H "Authorization: Bearer <你的密钥>" <api_base>/agent-setup
```

### 无工具网页对话（DeepSeek / 豆包 / Gemini 网页）

路径 D（无工具模式（复制粘贴））·现在可用

1. 这几家的网页聊天框都没有工具/插件入口，也没有常驻的系统提示词位——所以走「复制粘贴」这条路。
2. 每开一个新对话，先把下面这段开场白贴进去，再把你的档案摘要贴在它后面。
3. 对方回复末尾会带一个 ```tubashu 代码块，列出这一轮的新增。把整段回复复制回本页下面那张「接不了工具的客户端」卡的「粘贴回填」框，先出预览，逐条勾完再确认写入档案。
4. （ChatGPT 与 Claude 网页版有常驻自定义指令位，可以把这段一次性放进去，不用每次重贴。）

开场白（每次新对话贴一遍）：

```
你接下来要陪我处理一件事。你没有工具可用，所以下面这些信息由我贴给你，不要自己去查。
【背景资料】我会把我的档案摘要贴在这条消息后面。你也可以让我去取：<skill_url>（一份公开的使用说明，我可以复制粘贴给你）。
【你要守的规矩】任何条号、任何数字、任何案例，都只能引用我贴给你的材料里逐字出现的内容；材料里没有的就说「材料里没有」，不要凭印象补。
【回复格式】正常回答之后，如果这一轮产生了新的事实、待办、金额或期限，请在末尾附一个 ```tubashu 代码块，里面是 JSON：{"timeline":[],"actions":[],"claims":[],"deadlines":[],"report_updates":[]}。我会把整段回复贴回档案系统，由它逐条解析、我确认后入库。没有新增就不要附。
```

## 接入方式三：OAuth（网页版连接器）

<!-- 本节由 scripts/gen-agent-docs.ts 从 app/src/lib/auth/oauth.ts 的路径表生成，勿手改。 -->

ChatGPT 网页（Developer mode）与 Claude 网页/桌面的连接器**只认 OAuth**，不接受在配置里手填
`Authorization: Bearer`。这类客户端按下面这样接：

1. 在客户端里选「添加连接器 / 添加 MCP 服务器」，地址填 `<mcp_url>`；
2. 鉴权方式选 **OAuth**（有的客户端会自己发现，不必手选）；
3. 客户端会跳到土八鼠的授权页。没登录的话先登录（手机号或邮箱验证码），登完自动跳回；
4. 授权页上写着是哪个客户端在申请、要哪些权限，点「同意并接入」即回到客户端，接入完成。

客户端不需要预先申请任何 ID：它自己会去 `/api/oauth/register` 注册。
要手工核对的话，这几个地址是公开的：

| 用途 | 地址 |
|---|---|
| 授权服务器元数据 | `/.well-known/oauth-authorization-server` |
| 受保护资源元数据 | `/.well-known/oauth-protected-resource` |
| 授权页（用户看的那一屏） | `/oauth/authorize` |
| 动态客户端注册 | `/api/oauth/register` |
| 换取 / 续期令牌 | `/api/oauth/token` |
| 交还令牌 | `/api/oauth/revoke` |

授权成功后，网页端「设置 → API key」里会多出一条记录，写着「来自 <客户端名> 的授权」。
它没有可复制的明文——凭据在客户端手里，每小时自动换一次。
**吊销那一行即断开该客户端的接入**，它手上的令牌当场失效。

授权只影响你自己的档案；被授权的客户端与你自己的 api key 权限完全相同，别人的案件一样看不见。

## 能力清单

<!-- 本节与下面的错误码表由能力注册表生成，勿手改；改动请改 app/src/lib/capabilities/ 再跑 `npm run gen:docs`。 -->

> **时间一律是北京时间（Asia/Shanghai，+08:00）**。所有接口回包里的 `*_at` / `*_time` 字段都是带偏移的 ISO 8601（形如 `2026-09-06T00:30:00+08:00`），直接丢给 `new Date()` 即可，**不要再自己补时区**。**入参请务必自己带上偏移**（`…+08:00` 或 `…Z`）：不带偏移的串按服务端进程时区解析，那是部署环境的属性、不是接口约定，别赌它。服务端内部按 UTC 存储，这一层与调用方无关。

REST = 专用端点 + `/tools/{name}` 通用桥。表里 REST 列给的是专用端点，没有专用端点的那些写成 `POST /tools/<name>`；**每一条能力都可以走通用桥**——`POST /api/v1/tools/{name}`，请求体就是该能力的入参 JSON，鉴权、scope、前置闸与 MCP 同一批判定。当前可调的清单随时可以 `GET /api/v1/tools` 取。

**档案与事实**

| 工具 | REST | scope | 读写 | 用途 | 入参要点 |
|---|---|---|---|---|---|
| `case_get` | `GET /cases/{id}` | `case:read` | 读 | 读取一个案件的档案（阶段、目标、底线）以及最近的时间线事件。只能读自己的案件。 | `case_id` 案件 id；`timeline_limit`? 带回多少条时间线事件，默认 50，最多 200 |
| `case_update` | `PATCH /cases/{id}` | `case:write` | 写 | 更新案件档案：阶段 stage、目标 goal、底线 bottom_line，以及用工基本盘四项——入职时间 employed_from（YYYY-MM-DD）、月工资 monthly_wage_yuan（单位元）、岗位 position、合同签署次数 contract_count，以及并行轨 track（有并行轨的领域才有，传 null 表示回主线）。**至少传一个**，用于零散补齐，不必重走首诊。stage 必须是法定枚举值之一。 | `case_id` 案件 id；`stage`? 案件所处阶段；`goal`? 用户自述的诉求目标；`bottom_line`? 用户自述的底线；`employed_from`? 入职时间，YYYY-MM-DD，不能晚于今天；工龄年限的起点；`monthly_wage_yuan`? 月工资，单位元（会换算成分落库）；所有赔偿金额的基数；`position`? 岗位；`contract_count`? 合同签署次数，用户自述原样记录，如「只签过一次」；`track`? 并行轨：可以与主线同时在走的那条线（不是阶段）。进轨传轨名，处置完传 null 回主线。**它不覆盖 stage**——进轨时主线走到哪一步不变。不是每个领域都有并行轨；这个案子所属领域没有的话，只能传 null。 |
| `case_facts` | `GET /cases/{id}/facts` | `case:read` | 读 | 一次拿全这个案子的当前事实：当事人、案件抬头、法定期限、用工基本盘（入职时间/月薪/岗位）、公司主体、行动卡、诉求金额、时间线、证据清单。**回答任何与案情有关的问题之前先调它**。档案里没有的项会明写「未记录」——那是「档案里没有这一项」，不是「不存在」，不要自己脑补一个值。 | `case_id` 案件 id |
| `case_list` | `GET /cases` | `case:read` | 读 | 列出当前 api key 所属用户自己的全部案件（case_id、抬头 title、阶段 stage、建档时间），新的在前。**连上后先调它认领案件**：只有一个案件（绝大多数人）就直接用它的 case_id，不要开口问用户要编号；有多个就把抬头列出来让用户挑；一个都没有就请用户去网页端建档（首诊）。无需任何入参。 | 无入参 |
| `intake_submit` | `POST /cases/{id}/intake` | `case:write` | 写 | 把首诊问下来的内容一次性写进这个案件：阶段、公司名、入职时间、月工资、岗位、合同次数、经过（时间线）、诉求、底线。**新用户或用工基本盘还空着时用它一次建档**，问齐了再调，不要让用户回网页填。金额传元（monthly_wage_yuan），服务端换算成分。校验不过会逐字段回原因（如 INVALID_MONTHLY_WAGE），照着补齐再提交即可。 | `case_id` 案件 id；`stage` 案件所处阶段；`company_name` 公司名称，就是仲裁里的被申请人；`employed_from` 入职时间，YYYY-MM-DD，不能晚于今天；`monthly_wage_yuan` 月工资，单位元（会换算成分落库）；`goals` 诉求，至少一项；`position`? 岗位，可省略；`contract_count`? 合同签署次数，用户自述原样记录，可省略；`events`? 用户记得的事件，每条含 date（YYYY-MM-DD，可留空）与 text；`free_text`? 用户整段自述的经过，可省略；`company_docs`? 公司给过哪些文件（键 terminationNotice / settlementAgreement / otherPaper）；`company_wording`? 公司口头给的说法，可省略；`bottom_line`? 用户的底线，可省略 |

**时间线**

| 工具 | REST | scope | 读写 | 用途 | 入参要点 |
|---|---|---|---|---|---|
| `timeline_add` | `POST /cases/{id}/timeline` | `case:write` | 写 | 给案件时间线追加一条事件。时间线只追加不修改，记错了就再补一条更正事件。写入自带幂等：传相同 client_ref 重放只落一条（返回 deduped:true）；不传 client_ref 时，同一天、同类别、标题去掉标点空白后相同的事件也不会重复落库。 | `case_id` 案件 id；`happened_at` 事件发生时间，ISO8601 时间串；`kind` 事件类别；`title` 一句话概括发生了什么；`detail`? 细节补充，可省略；`client_ref`? 幂等键，一次业务操作给一个稳定值；重试用同一个 ref，服务端不会重复落库 |
| `timeline_list` | `GET /cases/{id}/timeline` | `case:read` | 读 | 按时间倒序读案件时间线，可按发生时间下界 since 与类别 kind 过滤，limit 默认 50、最多 200。返回里带 total（过滤后的真总数）与 next_offset（没有下一页时为 null）——**别把一页当成全部**：case_get 只带最近若干条，早期事件（入职、第一次约谈）要靠翻页才拿得到。 | `case_id` 案件 id；`since`? 只要这个时刻之后发生的事件，ISO8601 时间串；`kind`? 只要这一类事件；`limit`? 本页最多几条，默认 50，最多 200；`offset`? 从第几条开始，默认 0；续页用上一页回的 next_offset |
| `timeline_milestone` | `POST /cases/{id}/timeline/{eventId}/milestone` | `case:write` | 写 | 给一条已存在的时间线事件盖上里程碑。**必须先拿到用户的明确确认再调**，user_confirmed 传 true 就是在代用户签字：里程碑是只追加、没有撤销语义的事实断言，盖错一次就永久留在案件史里。你只负责提议，落笔的是用户。 | `case_id` 案件 id；`event_id` 要盖章的时间线事件 id（本案内）；`milestone` 达成的里程碑；`user_confirmed` 用户已明确确认这一格达成。没问过用户就不要传 true |

**行动**

| 工具 | REST | scope | 读写 | 用途 | 入参要点 |
|---|---|---|---|---|---|
| `action_list` | `GET /cases/{id}/actions` | `case:read` | 读 | 列出案件下的行动项，可按状态过滤（待办 / 完成 / 放弃）。 | `case_id` 案件 id；`status`? 只看某个状态 |
| `action_complete` | `PATCH /cases/{id}/actions/{actionId}` | `case:write` | 写 | 把一条行动项标记为完成；也可以传 status 标记为放弃。 | `case_id` 案件 id；`action_id` 行动项 id；`status`? 目标状态，默认「完成」 |
| `action_create` | `POST /cases/{id}/actions` | `case:write` | 写 | 给案件加行动卡，一次最多 3 张。超过这个数就不是「现在做什么」，是又一份待办清单——用户看完照样不知道先干哪件。每张必须齐三样：what（做什么）、how（怎么做）、why（为什么），外加 due_at（什么时候之前做完，ISO8601 时刻；「今天下班前」也要换算成具体时刻）。同案下已有同题待办不会重复落库，回 created:false。 | `case_id` 案件 id；`items` 要新建的行动卡，1~3 张；`client_ref`? 幂等键，一次业务操作给一个稳定值；重试用同一个 ref，服务端不会重复落库 |

**期限**

| 工具 | REST | scope | 读写 | 用途 | 入参要点 |
|---|---|---|---|---|---|
| `deadline_list` | `GET /cases/{id}/deadlines` | `case:read` | 读 | 列出案件的法定期限（仲裁时效、起诉 15 日、开庭等），默认只列生效中的，按到期时间升序。 | `case_id` 案件 id；`include_resolved`? 是否连已履行/作废的一起列出 |
| `deadline_set` | `POST /tools/deadline_set` | `case:write` | 写 | 给一个锚点日期（收到某份文书的日子、解除的日子……），服务端**按规则推算**到期日并登记。日期不由你算：返回里带 derived_from（一步步的推算过程）与 basis（条号与逐字原文），把到期日、推算依据和全部 caveats（尤其「未含法定节假日顺延」）一起讲给用户，别只报一个日子。天数由办案机构在通知书上指定的那类期限必须传 days——缺了会明确告诉你缺哪一项。同案同 kind 同锚点重复调用不会多出一条。 | `case_id` 案件 id；`kind` 期限种类；`anchor_date` 起算锚点，YYYY-MM-DD（如文书签收日、解除日）；`days`? 天数由办案机构指定的期限才要传，照通知书上写的填，不要猜；`client_ref`? 幂等键，一次业务操作给一个稳定值；重试用同一个 ref，服务端不会重复落库 |
| `deadline_resolve` | `POST /tools/deadline_resolve` | `case:write` | 写 | 把一条期限标记为已履行/作废，停止提醒。**幂等**：已经标记过的再调不报错、也不刷新时间戳，只回 already_resolved:true——「什么时候办完的」不该被后来的重复调用改掉。不属于本案的 id 一律当作不存在。 | `case_id` 案件 id；`deadline_id` 期限 id（从 deadline_list 取）；`client_ref`? 幂等键，一次业务操作给一个稳定值 |

**证据**

| 工具 | REST | scope | 读写 | 用途 | 入参要点 |
|---|---|---|---|---|---|
| `evidence_list` | `GET /cases/{id}/evidence` | `case:read` | 读 | 列出案件下已登记的证据条目（名称、分类、证明目的、固化状态、提取状态、简报状态，以及有简报时的一句话摘要）。brief_status=failed 说明自动生成失败过，brief_error 里是原因，可用 evidence_brief_regenerate 再试一次。要读全文或整份简报用 evidence_get / evidence_brief_get。**已作废的条目默认不在清单里**（当事人声明"这份不作数"的那些）——要看得把 include_voided 传真。 | `case_id` 案件 id；`include_voided`? 是否把已作废的条目也列出来（默认不列） |
| `evidence_get` | `GET /evidence/{id}` | `case:read` | 读 | 读一件证据的元数据、提取状态与简报；include_text 为真时附上已提取的文本（超 8000 字截断并标 truncated，要全文去网页详情页）。文件二进制不经本接口。 | `evidence_id` 证据 id（取自 evidence_list）；`include_text`? 是否带上已提取的文本正文（默认不带，省上下文） |
| `evidence_extract` | `POST /evidence/{id}/extract` | `case:write` | 写·耗算力 | 把一件材料的内容提取成文字：ocr（图片/PDF 认字）、asr（录音转写，带说话人与时间轴）、video（抽音轨转写 + 关键帧识别）。**两步**：不带 quote_id 调一次先拿报价（这一步只看价，不产生任何扣费）；把报价里的 quote_id 带回来再调一次才确认扣费并排队。完成后 evidence_get 能读到文本，并自动附一份简报（价已含在提取里，不另计）。 | `evidence_id` 证据 id（取自 evidence_list）；`mode` ocr = 图片/PDF 认字；asr = 录音转写；video = 视频；`quote_id`? 不填 = 只看价，这一步不产生扣费；填上一次报价回的 quote_id = 确认扣费并开始提取 |
| `evidence_brief_get` | `GET /evidence/{id}/brief` | `case:read` | 读 | 读一件证据的简报：能证明什么、关键事实（时间/人物/事项/原话/位置）、与诉求的关系、弱点与补强建议、引用位置。要改写就把回包里的 version 原样带给 evidence_brief_update。 | `evidence_id` 证据 id（取自 evidence_list） |
| `evidence_brief_update` | `PUT /evidence/{id}/brief` | `case:write` | 写 | 整份替换一件证据的简报。base_version 必须是你刚用 evidence_brief_get 读到的那个版本号——对不上会返回 409 并告诉你库里现在是第几版，重读、把你的改动合进去再提交。brief 必须含 proves，其余分节可为空。 | `evidence_id` 证据 id（取自 evidence_list）；`brief` 固定 schema：{proves, key_facts:[{when,who,what,quote,where}], relation_to_claims, weaknesses[], suggested_followups[], citations[]}。key_facts 里的 quote 必须是提取文本里的原话，引不到就留空字符串。；`reason` 为什么改（留痕，回包原样带回）；`base_version` 你读到的版本号；0 = 之前没有简报 |
| `evidence_upload_url` | `POST /tools/evidence_upload_url` | `case:write` | 写 | 为一份要上传的材料签发一条一次性 PUT 地址与 upload_token。拿到之后把**文件字节本身**作为 body PUT 到那条地址（不是表单、不是 JSON、不是 base64），再用同一个 upload_token 调 evidence_register 填名称、分类与证明目的。地址只收一次文件、10 分钟内有效，过期或用过都要重新签一条。体积上限按 mime 分档：图片与 PDF 25 MB、音频 100 MB、视频 100 MB；size 报得超档会在这一步就被拒，不必先把文件传一遍才知道。需已完成实名认证。 | `case_id` 案件 id；`filename` 文件名，例如 面谈录音.m4a；`mime`? 文件的 mime 类型，例如 image/jpeg、application/pdf、audio/m4a、video/mp4。决定体积档位，报不准会按最严的 25 MB 那档算；`size`? 文件字节数（据实报；服务端收到字节后还会再量一次） |
| `evidence_register` | `POST /tools/evidence_register` | `case:write` | 写 | 把已经 PUT 上去的字节登记成一条正式条目：填名称、分类、证明目的与原始载体。必须先有 evidence_upload_url 签发的 upload_token 且字节已经传完；同一个 upload_token 只能登记一条。category 只能取：合同 / 工资 / 社保 / 考勤 / 沟通记录 / 公司文件 / 录音 / 其他。prove_purpose 写"这份材料想证明什么"，日后出证与整理都靠它——空着的话，后面谁也说不清当初为什么留这一份。需已完成实名认证。 | `case_id` 案件 id；`upload_token` evidence_upload_url 给的 token，字节 PUT 完之后用它登记；`name` 条目名称，一眼能认出是什么的那种；`category`? 分类，只能取：合同 / 工资 / 社保 / 考勤 / 沟通记录 / 公司文件 / 录音 / 其他；`prove_purpose`? 这份材料想证明什么；`original_medium`? 原始载体，例如 手机拍摄 / 微信导出 / 纸质扫描；`client_ref`? 幂等键，一次业务操作给一个稳定值；重试用同一个 ref，服务端不会重复落库 |
| `evidence_attest` | `POST /tools/evidence_attest` | `case:write` | 写 | 给已登记的条目盖可信时间戳、渲染《存证证明》PDF 并签名，回订单号。**这一步按 0 公道值计价**，没有报价步骤，也不消耗任何额度。幂等：同一条反复发起只会有一个订单号，中途失败原地续跑，不会出第二份证明。一次最多 10 件——每件都要走三次外部调用，给多了这次请求会挂很久。逐件独立成败：某件失败不影响别件，回包里每件各有各的结果，请照结果逐件复述，不要笼统说"都办好了"。需已完成实名认证（证明上要印实名快照）。 | `evidence_ids` 要出证的条目 id，1~10 个 |
| `attest_verify` | `GET /verify/{orderNo}` | `case:read` | 读 | 拿订单号查一份存证记录：哈希、时间戳（签发时刻、序列号、TSA 地址、原始 tst）与条目元数据。与公开页 /verify/{订单号} 同一份数据，**不含持证人姓名与证件号**——这个接口谁拿到订单号都能查，身份只在《存证证明》PDF 上，由持证人自己出示。任何人的订单号都能查，不限于本账号：核验方本来就该不注册账号也能核。 | `order_no` 存证订单号，形如 LAWER-ATT-20260905-<16位hex> |
| `evidence_void` | `POST /evidence/{id}/void` | `case:write` | 写 | 把一件材料标成「已作废」：当事人确认它不作数（重复上传、拿错版本、内容与本案无关）。作废之后它**不再出现在 evidence_list 默认清单里**（要看得传 include_voided）、不再进案件事实卡，也不能再发起出证。文件本身不删除，仍占用户的存储配额；已经出过证的条目，**那张存证订单不撤销**——订单号照旧可被对方核验，作废只表示当事人不再拿这份材料当证据用。reason 必填：没有理由的作废，日后与"手滑点错了"分不开。 | `evidence_id` 证据 id（取自 evidence_list）；`reason` 为什么作废，例如「与条目 12 重复」「当事人确认这是草稿版」 |
| `evidence_brief_regenerate` | `POST /evidence/{id}/brief/regenerate` | `case:write` | 写 | 给一件**还没有简报**的材料重新生成一份（自动生成失败过的走这条）。**这一步按 0 公道值计价**，没有报价步骤，也不消耗任何额度——价已经含在当初那次内容提取里。同步返回，不排队。已经有简报的一律拒绝（不覆盖人手写过的那一版，要换用 evidence_brief_update）。这一次再失败会把失败原文原样回给你，不翻译成一句"生成失败"。 | `evidence_id` 证据 id（取自 evidence_list） |

**法律依据**

| 工具 | REST | scope | 读写 | 用途 | 入参要点 |
|---|---|---|---|---|---|
| `knowledge_search` | `GET /knowledge/search` | `case:read` | 读 | 按自然语言检索法条卡/判例卡/计算规则/流程SOP/文书模板/话术卡/情绪指南/数据卡/审查规则/方法卡。任何涉法断言、任何数字、任何文书起草之前都先调它——你记忆里的条号和数字一律不可用。每张卡带 citation_guide（可直接照抄的引用块）与 confidence；confidence 是「待核实」的必须如实转达给用户。默认给摘要，要整张正文时传 full_text=true，或用 knowledge_get 单取一张。检索不到就说查不到，不要编条号和案号。 | `query` 检索词，用案情关键词而非整句话，如「客观情况重大变化 北京口径」；`type`? 只要某一类卡时传，一般不传；`court`? 只要某个法院的判例时传，子串即可（如「朝阳」）。传了就只回判例卡——没有审理机构的卡会被滤掉；`full_text`? 传 true 回整张正文（单卡上限 8000 字，超出截断并标 truncated）；默认只回 1200 字摘要；`limit`? 最多几张，默认与上限都是 6；超出这个范围会被夹回 1~6；`case_id`? 给了就只检索这个案件所属领域的卡（推荐带上）；不给则跨领域检索，可能回来一批与本案无关的卡 |
| `knowledge_get` | `POST /tools/knowledge_get` | `case:read` | 读 | 按 id 取一张知识卡的正文与结构化事实（facts）。id 从 knowledge_search 的结果里拿。要逐字引用条文、要取一个数、要照着审查规则逐条核对时用它——facts 里的 statute_quotes / values / review_rules 是**结构化原文**，比正文散文更该被照抄；正文上限 8000 字，超出会截断并标 truncated。 | `id` 知识卡 id，形如 `<域单数>-<slug>`，从 knowledge_search 结果里取 |
| `citation_check` | `POST /tools/citation_check` | `case:read` | 读 | 核验条号与判例：写进任何对外文书或确定结论之前，把你打算引的每一条法条（法名+条号）与每一个判例卡 id 交给它。法条回「库里有没有收录这一条」与逐字原文（法名全称、简称、带《》都认同一条）；判例回审理机构、案号、要旨，以及判例核验四步法的逐条结论。任何一条回 found:false 就是**不要引用**——不要凭记忆补条号、原文或案号。它只做核验，不产出依据：要找依据用 knowledge_search。 | `citations`? 要核的条文，一次最多 20 条；`precedent_ids`? 要核的判例卡 id（从 knowledge_search 结果里取），一次最多 10 个；`assert_terms`? 你打算用这些判例支持的主张里的关键词（如「连带」）。给了才能做四步法第三步的否定性核验：在卡内数这些词的出现次数，零出现即不能作该论点的先例。 |

**金额主张**

| 工具 | REST | scope | 读写 | 用途 | 入参要点 |
|---|---|---|---|---|---|
| `claim_calc` | `POST /tools/claim_calc` | `case:write` | 写 | 按案情算一笔金额并直接落库（同案同 kind 只留一条，再算一次是修正）。返回金额、算式 formula、逐步骤 steps、依据 basis（条号 + 逐字原文 + 来源卡 id）与封顶提示。**任何要写进文书、说给用户听或拿去谈的金额都必须经它算**，不要自己心算、也不要转述记忆里的数。入参不齐时**一次把缺的和填错的全部列出来**（回包里有 missing / invalid 两张表，七种算法的必填项互不相同）——那就是本次全部的问题，一次补齐再调一次，不要一次只补一个。金额单位一律是**分**，且是「应得」不是「到手」。 | `case_id` 案件 id；`kind` 算哪一项；`inputs`? 这一项算法要的输入，键名照服务端回的错误提示填（如 avg_monthly_wage_fen / employed_from / terminated_at / months / anchor_date …）。也可以把它们平铺在顶层。；`evidence_backed`? 哪些输入字段是有证据支撑的（不列的一律标「用户自述」，展示时要说明待核实）；`client_ref`? 幂等键，一次业务操作给一个稳定值；重试用同一个 ref，服务端不会重复落库 |
| `claims_upsert` | `POST /tools/claims_upsert` | `case:write` | 写 | 登记或修正案件下的一条诉求项（同案同 kind 只有一条，再调是覆盖不是追加）。**算得出来的项不要在这里填金额**——它们必须走 claim_calc（那条会带算式、输入快照与依据一起落库）；这里只用于登记「用户陈述的数额」一类的项，以及给已有的项补依据 basis。金额单位是分。 | `case_id` 案件 id；`kind` 诉求种类；`amount_fen`? 金额，单位分，非负；还没算出来就给 0；`basis`? 依据（条号、来源卡 id 等），可省略；`calc_json`? 这个数从哪来、待证状态，JSON 串，可省略；`status`? 默认 draft；`client_ref`? 幂等键，一次业务操作给一个稳定值；重试用同一个 ref，服务端不会重复落库 |
| `claims_list` | `GET /cases/{id}/claims` | `case:read` | 读 | 列出案件下的全部诉求项与**合计金额**（合计由服务端算，不要自己把各项加起来——这个总数正是拿去跟对方谈的那个数）。每项带 calc_json：那是算这笔钱时的完整快照，可复算。 | `case_id` 案件 id |

**文书**

| 工具 | REST | scope | 读写 | 用途 | 入参要点 |
|---|---|---|---|---|---|
| `draft_list` | `GET /cases/{id}/drafts` | `case:read` | 读 | 列出案件名下已有的文书（类型、标题、版本、状态、时间），**不含正文**——正文用 draft_get 按 draft_id 单取。仲裁材料一般会改好几稿，同一题的多版都在这里。 | `case_id` 案件 id |
| `draft_get` | `POST /tools/draft_get` | `case:read` | 读 | 按 draft_id 取一份文书的正文、版本号与发出后果说明。**改稿前先读它**：拿到的正文就是用户手上那一份，凭记忆重写会把上一稿里用户自己改过的措辞抹掉。 | `draft_id` 文书 id，从 draft_list 取 |
| `draft_write` | `POST /tools/draft_write` | `case:write` | 写 | 把一份文书存进案件档案。同一个案子里 kind 与 title 都相同的再写一次是**新版本**，旧稿留着可回看。发给公司的文书（异议函/被迫解除通知/仲裁申请书/答辩状/上诉状）**必须**同时给 send_consequences 说清发出后果，缺了服务端直接拒收、一个字都不写库。改稿时把上一稿的 id 填进 based_on_draft_id。存下来的永远是草稿：发不发、什么时候发、怎么送达都由用户决定，系统不会代发。 | `case_id` 案件 id；`kind` 文书类型；`title` 文书标题。同案同 kind 同 title 即视为同一份的新一稿；`body` 文书全文。填空位保留【】并附填写说明；`send_consequences`? 发出后果说明：发出后法律关系会怎么变、对方可能怎么应对、哪些是不可逆的。发给公司的文书（异议函/被迫解除通知/仲裁申请书/答辩状/上诉状）必填，缺了会被拒收。；`based_on_draft_id`? 这一稿是在哪一稿基础上改的（本案内的 draft_id），从零起草则不传；`client_ref`? 幂等键，一次业务操作给一个稳定值；重试用同一个 ref，服务端不会重复落库 |
| `share_create` | `POST /tools/share_create` | `case:write` | 写 | 为一份文书或一件材料签发一条**免登录只读**链接，谁拿到谁能打开（不需要账号）。draft_id 与 evidence_id 恰好给一个：一条链接只分享一份东西，要分享两份就建两条、可分别撤销。expires_in 是小时数，不给按 72 小时，上限 720 小时。材料类链接只展示名称、分类、证明目的与文件哈希，**不给文件本身**——一条免登录地址直连原始文件，被转发一次就等于永久公开。改主意了用 share_revoke 立刻收回。需已完成实名认证。 | `draft_id`? 要分享的文书 id，从 draft_list 取；与 evidence_id 二选一；`evidence_id`? 要分享的材料 id，从 evidence_list 取；与 draft_id 二选一；`expires_in`? 有效期小时数（1 到 720）。不给按 72 小时。别默认往上限报：链接不带任何凭据，有效期越长，收回的机会越小；`client_ref`? 幂等键，一次业务操作给一个稳定值；重试用同一个 ref，服务端不会重复签发第二条链接 |
| `share_revoke` | `POST /tools/share_revoke` | `case:write` | 写 | 立刻作废一条分享链接：此后任何人打开它都只会看到「链接已失效」。**幂等**——已经撤销过的再撤一次照样成功，返回 already_revoked=true，首次撤销的时点不变。撤销不删记录：谁在什么时候撤了哪一条留得下来。 | `share_id` 分享链接 id，从 share_create 的回包里取 |
| `draft_export` | `POST /tools/draft_export` | `case:write` | 写·耗算力 | 把一份文书渲染成 PDF，回一条**一次性、限时**的下载地址（浏览器直接打开即可，不必带凭据）。**两步**：先不带 quote_id 调一次，回一张写明价钱与算式的报价单，这一步只出价、不动账；确认价钱之后带上 quote_id 再调一次，才渲染 PDF 并按报价扣费。format 目前只支持 pdf。导出的是正文原文，不含站内那段「发出前必读」提醒——那段是给起草人自己看的，印在要递出去的件上等于把自己的顾虑一起交出去。这一步的服务定额目前是 **0 公道值**，但报价这一步照走不误：价目哪天调整，用户看到的仍是确认前就报给他的那个数。**确认那一步可以原样重试**：没收到回包就带同一个 client_ref（不给时同一个 quote_id）再发一次，服务端回上次那一份 PDF、重签一条新地址，deduped=true 且一分不再扣。需已完成实名认证。 | `draft_id` 要导出的文书 id，从 draft_list 取；`format`? 导出格式，不给按 pdf；`quote_id`? 上一步拿到的报价号。不给 = 只出价、不动账；给了 = 按这张报价确认并渲染导出；`client_ref`? 幂等键，重试用同一个值：确认那步没收到回包时原样重发，回上次那一份、不重扣。不给时按 quote_id 去重，同一张报价不会导出两份 |

**公司主体**

| 工具 | REST | scope | 读写 | 用途 | 入参要点 |
|---|---|---|---|---|---|
| `company_profile_upsert` | `POST /tools/company_profile_upsert` | `case:write` | 写 | 登记或补充公司主体档案。签约主体、发工资主体、实际用工主体可能是三家公司，仲裁列谁为被申请人由此判定，所以只要用户提到公司名就要落档。同案同名只有一条，反复补充即更新。 | `case_id` 案件 id；`name` 公司全称，尽量与营业执照一致；`role`? 这一方在本案里是哪个角色位。不填时：这个名字在本案已经登记过就沿用它已有的角色，是新名字才落本领域声明的缺省角色位——**各领域的缺省不是同一个**，拿不准就点名。；`uscc`? 统一社会信用代码，不知道就不传；`legal_rep`? 法定代表人；`note`? 风险点：注册资本、经营异常、关联公司等；`sources`? 结论出处（用户自述 / 企业信息平台 / 用户回传截图），必须可溯源；`client_ref`? 幂等键，一次业务操作给一个稳定值；重试用同一个 ref，服务端不会重复落库 |
| `company_probe` | `POST /company/probe` | `case:read` | 读 | 先免费探一眼这家用人单位的公开概况：有没有命中主体、工商状态、关联主体数、涉诉记录数、其中与劳动者相关的件数、有公开文书链接的篇数，以及这批数字采于哪一天。**不扣任何费用、也不建档**，它是下一步报价的底数——没有它，深度两块（涉诉深度统计 / 人事套路归纳）报不出价。缓存命中不占免费次数；未命中且今日免费次数用完、或采集侧暂时不可用时，回包会如实说是哪一种，**不会拿一个空结果冒充「查无此公司」**——照它的原话转告用户，别自己补一句「这家公司没查到」。 | `name` 对方主体全称（用人单位、关联公司、平台都算），尽量与营业执照一致；查得准不准全看这个名字；`uscc`? 统一社会信用代码，知道就传（比名字更能锁准主体） |
| `dossier_quote` | `POST /tools/dossier_quote` | `case:read` | 读 | 给这家用人单位的档案报价：买哪几块、每块多少公道值、算式是什么、余额够不够。**这一步绝不动钱**（不扣费、不建档、不占额度），所以可以放心先报一次给用户看。回包里的 quote_id 才是下单凭据，交给 dossier_confirm 才会真扣费；报价有有效期（expires_at），过期要重报——价目会被调整，拿过期报价确认等于按一个已经不作数的价收钱。同一场纠纷对面常常不止一家（关联公司、平台），一家一张报价、各买各的。 | `case_id` 案件 id；`name` 对方主体全称（用人单位、关联公司、平台都算），尽量与营业执照一致；查得准不准全看这个名字；`blocks` 要买哪几块：venue=仲裁地实操 / entity=主体体检 / graph=关联谱系 / docs_list=涉诉清单 / docs_stats=涉诉深度统计 / patterns=人事套路归纳。可以只买核心几块；深度两块按篇数计价，要先有一份新鲜的 company_probe 结果才报得出价。；`uscc`? 统一社会信用代码，知道就传 |
| `dossier_confirm` | `POST /tools/dossier_confirm` | `case:write` | 写·耗算力 | 按一张报价确认下单：扣公道值（有会员赠送券时核心几块自动抵扣）并建档。**同一张报价重复确认只扣一次**——回包 deduped=true 表示这次没有产生第二笔扣费，要如实说「之前那单已经付过了」，不要说成又买了一次。余额不够时整笔失败：不建档、不扣任何钱，把差额如实告诉用户，不要改小参数重试。 | `quote_id` dossier_quote 回包里的 quote_id，原样回传 |
| `dossier_get` | `GET /cases/{id}/dossier` | `case:read` | 读 | 读这家用人单位的档案：辖区实操、主体体检、关联谱系、涉诉清单与统计、人事套路。status=none 表示这案还没建过档（**不是错误**，也不代表这家公司没问题），要买先 dossier_quote。 | `case_id` 案件 id |
| `company_graph_get` | `GET /cases/{id}/company-graph` | `case:read` | 读 | 读本案的对方主体关系图：节点（用人单位与关联公司、平台各自的角色）、边（股权 / 同法代 / 同址等）、以及每个节点在守望里的档位。一个主体都还没登记时回 graph=null——那是「这案还没做过主体调查」，不是错误。 | `case_id` 案件 id |
| `company_watch_set` | `POST /cases/{id}/watch` | `case:write` | 写 | 把一家对方主体挂进守望，之后按档持续盯它的工商与涉诉变化（关联公司、平台同样可以各挂一条）。**这一次调用不扣钱**：档位定的是下个月按哪档收月费，别对用户说成「已扣」。同案同主体只会有一条，重复调用命中已有那条、**不会改它的档位**；回包里的 tier 是库里真正生效的那一档，照它说，不要回显你传进去的那个。 | `case_id` 案件 id；`name` 对方主体全称（用人单位、关联公司、平台都算），尽量与营业执照一致；查得准不准全看这个名字；`tier` 盯多勤：daily=199 公道值/月 / weekly=60 公道值/月 / archive=0 公道值/月。不传按最勤那档（daily）建，**别靠默认值**：说清楚再传。；`uscc`? 统一社会信用代码，知道就传；`company_profile_id`? company_graph_get 里那个节点的 id；给了就按节点去重（比按名字更准） |

**情绪与危机**

| 工具 | REST | scope | 读写 | 用途 | 入参要点 |
|---|---|---|---|---|---|
| `emotion_log` | `POST /tools/emotion_log` | `case:write` | 写 | 记一笔用户当前的情绪档位。识别到低落/焦虑/严重痛苦时都要记——这是长期陪跑看走向的依据，不是评价。refer_nbdpsy 只在符合持续焦虑抑郁表现时置 true：档位没到「焦虑」以上、或这个案子此前已经转介过一次，服务端都会把它降回 false 并在返回里说明原因（记录照常落库）。 | `case_id` 案件 id；`level` 情绪档位；`note`? 判断依据：用户说了什么（引原话片段）；`refer_nbdpsy`? 本次是否转介心理咨询，默认 false；一个案子最多一次；`client_ref`? 幂等键，一次业务操作给一个稳定值；重试用同一个 ref，服务端不会重复落库 |
| `crisis_check` | `POST /tools/crisis_check` | `case:read` | 读 | 把用户刚说的这句话原样传进来，服务端用确定性词表判有没有自伤/求死表述。hit=true 时**必须把 first_segment 一字不改地放在你这一轮回复的最前面**，然后再说别的——它里面是可以立刻拨打的号码，不要改写、不要缩写、不要挪到末尾。hotlines 是同一批号码的结构化版本，只用于你自己核对，不要另外编号码。hit=false 时什么都不用做，正常回答即可。 | `text` 用户这条消息的**原文**，不要转述、不要摘要；`case_id`? 有案子就带上，命中会记进这个案子的危机留痕；没有就不传 |

**来文与录音**

| 工具 | REST | scope | 读写 | 用途 | 入参要点 |
|---|---|---|---|---|---|
| `doc_submit` | `POST /tools/doc_submit` | `case:write` | 写·耗算力 | 把对方发来的文件逐条读一遍：命中的审查规则、有风险的条款（原文引用 + 轻重 + 一句话说明）、该怎么改，以及一个总结论（签 / 不签 / 改签 / 待定）。**两步**：先不带 quote_id 调一次，回一张写明价钱与算式的报价单，这一步只出价、不动账；确认价钱之后带上 quote_id 再调一次，才开始解读并按报价扣费。来源二选一：evidence_id（已登记的材料，没有文字的会先做一次文字识别，费用已含在同一张报价里）或 text（直接粘原文）。 | `case_id` 案件 id；`doc_kind` 这份文件是什么：按它挑要比对的审查规则集；`evidence_id`? 已登记材料的 id；与 text 二选一；`text`? 直接粘贴的文件原文；与 evidence_id 二选一；`quote_id`? 上一步拿到的报价号。不给 = 只出价、不动账；给了 = 按这张报价确认并开始解读；`client_ref`? 幂等键，重试用同一个值；不给时按 quote_id 去重，同一张报价不会解读两次 |
| `doc_list` | `GET /cases/{id}/docs` | `case:read` | 读 | 列出这个案件下已经解读过的对方来文（种类、总结论、有几处风险、时间），**不含原文与逐条发现**——那两样用 doc_get 按 doc_id 单取。 | `case_id` 案件 id |
| `doc_get` | `GET /docs/{id}` | `case:read` | 读 | 按 doc_id 取一份解读：识别出的原文、总结论与理由、逐条发现（引用原文、轻重、依据、怎么改、谈判怎么说）。别人的 doc_id 与不存在的 doc_id 同样回「不存在」。 | `doc_id` 解读结果的 id（doc_list 里的 id） |
| `transcript_submit` | `POST /tools/transcript_submit` | `case:read` | 读 | 读一件**已经转写好**的录音的文字稿，给出要点，并挑出稿子里说到的事整理成候选事件（发生时间 / 类别 / 一句话 / 细节）。**本工具只读不写、不走报价、也不做转写**：要求这件材料的提取状态已经是 done 且有转写文本，否则回 EXTRACTION_REQUIRED——这时先调 evidence_extract mode=asr 做转写（那一步走报价确认、按分钟计价），完成后再调本工具。**候选事件不会自动写进档案**：逐条与用户核对（尤其是日期）之后，再对确认过的那几条调 timeline_add。 | `evidence_id` 录音材料的 id |

**个案报告**

| 工具 | REST | scope | 读写 | 用途 | 入参要点 |
|---|---|---|---|---|---|
| `case_report_get` | `GET /cases/{id}/report` | `case:read` | 读 | 读这个案子的**长期记忆**：整理过的分节报告 + 渲染稿 + 最后由谁在什么时候更新 + 过期标记。开工先读它——它是历次整理的结论，比现拼一遍档案更完整。第一次读会自动从档案生成初稿。回包里的 version 是改写时要回传的那个版本号；stale 非空表示档案在报告之后又变过，**这时先整理报告再回答用户**，别拿一份过期的结论去下判断。 | `case_id` 案件 id；`section`? 只要某一节时传它的标题（取值见回包 section_order）；不传即整份 |
| `case_report_update` | `POST /tools/case_report_update` | `case:write` | 写 | 把整理好的内容写进报告的某一节。**必须先 case_report_get 拿到 version，原样回传成 base_version**：中间有人改过就回 REPORT_VERSION_CONFLICT（409），这时读回最新版、把你的改动合上去再重试，不要重发同一份。reason 会自动记进「变更日志」那一节，所以写清楚这一改是为什么。改成功后报告的过期标记一并清掉。 | `case_id` 案件 id；`section` 要改哪一节，写它的标题（取值见 case_report_get 的 section_order）；`content` 这一节的**新全文**（Markdown 片段，不含标题行）；不是追加；`reason` 这一改是为什么，一句话，会原样进变更日志；`base_version` case_report_get 回包里的 version，原样回传；`client_ref`? 幂等键，一次业务操作给一个稳定值；重试用同一个 ref，服务端不会重复落库 |

**身份与账户**

| 工具 | REST | scope | 读写 | 用途 | 入参要点 |
|---|---|---|---|---|---|
| `me_get` | `POST /tools/me_get` | `case:read` | 读 | 一次读齐：实名状态、会员档与到期时间、余额、存储用量、有没有别的 agent 也连着这个账号。**在引导用户做需要实名的动作之前先调它**（auth_status 不是「已实名」就先说清要先实名，别让用户白填一整份材料到最后一步才被拒）；在发起要花钱的动作之前也先看一眼 balance。不接受任何入参——它读的永远是拿着这把凭据的那个人自己。 | 无入参 |
| `quote_list` | `POST /tools/quote_list` | `case:read` | 读 | 列本人**还能确认的报价**与**已确认的订单**：报好价还没确认的（status=open，过了 expires_at 就要重新报价）、以及已经确认扣过费的（status=confirmed，paid_by 说明是扣的余额还是用的会员额度）。已过期又没确认的不会出现在这里——它已经确认不了了，不要拿它的 quote_id 去试。传 case_id 只看某个案子的。 | `case_id`? 只看某个案子的报价；不传就看本人全部 |

**转介**

| 工具 | REST | scope | 读写 | 用途 | 入参要点 |
|---|---|---|---|---|---|
| `referral_create` | `POST /tools/referral_create` | `case:write` | 写 | 把用户转介给 NBDpsy 的心理咨询。**调之前必须先把下面这段逐项念给用户听，得到明确同意再带 consent:true 调**——服务端只认 consent，不认「我觉得他同意了」。 会发过去的：identity：你的姓名与手机号，以及你在本站是否已完成实名（含实名是在哪一侧完成的）；emotion_summary：一段不超过 200 字的情绪状态摘要，由近 30 天的情绪记录与最近的对话生成（连同「其中被我们挡掉了几个词」这个数字）；referral_reason：你为什么想找人聊聊，一句话（我们会先把其中的公司名与事件细节滤掉）；needs：你勾选或写下的需求（例如情绪疏导、睡眠、焦虑、决策支持）；stage_sentence：你的事情办到哪一步了，一句话（不含任何细节）；urgency：近 72 小时内有没有出现过需要紧急关注的信号；consent_at：你点下同意的时间；source_case_hash：一串由本案编号算出的哈希，用于两边对账；它反查不出你的案情。 不会发过去的：你公司的名字，以及任何能指认出这家公司的字眼；你的事情本身：经过、金额、证据、文书，一个字都不传；你上传的材料与它们的内容；你的证件号码（对方即使已有，我们这边也只存掩码）。 情绪状态摘要由服务端生成并过一道过滤（公司名与事件细节会被替换成「（略）」），reason 与 needs 也走同一道过滤，所以不必替用户自我审查，如实写即可。返回 status 恒为 pending：发送是异步的，稍后用 referral_list 看它有没有送达。 | `case_id` 案件 id；`consent` 用户是否已明确同意本次转介。**必须为 true**，且必须是用户真的说过；`reason`? 用户为什么想找人聊聊，一句话（会过滤后原样带走）；`needs`? 用户的需求，如「情绪疏导」「睡眠」「焦虑」「决策支持」；最多 8 条；`client_ref`? 幂等键，一次业务操作给一个稳定值；重试用同一个 ref，服务端不会重复落库 |
| `referral_list` | `POST /tools/referral_list` | `case:read` | 读 | 列出本案发起过的转介与它们的状态：pending 还在等着发出去（last_error 说的是上次为什么没发成）、sent 对方已收下（external_ref 是对方那条线索的号）、accepted / declined 是对方后来的回执、failed 是重试用尽。**没有记录就是从没转介过**，不要据此推断用户不需要。 | `case_id` 案件 id |

只能读写用户自己的案件。传了别人的 `case_id`，服务端一律回「案件不存在」——
不区分"不存在"和"不是你的"，别据此推断案件号的有效性。

## 边界红线

- **对外的东西由本人拍板。** 异议函、被迫解除通知、仲裁申请书、给 HR 的回复——可以起草，
  但发出去之前必须由用户本人逐字确认。任何情况下都不要代替用户发送。
- **档案数据只用于本案。** 里面是解除通知、工资流水、身份信息、谈话录音。
  不要把这些内容带到与本案无关的对话、工具或外部服务里去。
- **不可逆的决定留给用户。** 签字、不签字、接受方案、放弃某项诉求、撤回仲裁——
  可以分析利弊，但不要替他做，也不要用"建议你现在就签"这类推着走的说法。
- **不冒充律师，也不把用户支出去。** 你提供的是法律信息与行动建议，不是律师意见，
  也不构成委托代理关系。**能你做完的一律做完**：查依据、算金额、起草文书、列证据目录、
  排期限、写可直接照读的原句；做不动的那一步说清卡在哪、需要用户提供什么，
  **不要用"建议咨询律师""请专业人士看一下"收尾**——用得上这个平台的人，
  多半正是请不起律师的那些人，这句话对他没有用。
  法律上确实只能由执业律师做的只有两件：**由别人代他出庭打官司**（诉讼代理与辩护）、
  **以律师事务所名义出具律师函**（《中华人民共和国律师法》第十三条）。
  碰上这两件，照实说明是哪一条法律这么定的，并把已经替他做完的那一半一并交代清楚。
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
| `CONSENT_REQUIRED` | 400 | 要把用户资料交给站外机构的动作没带上本人的明示同意（consent 必须为 true） | 把「会传什么、不会传什么」逐项念给用户听，得到明确同意后带 consent:true 再调一次；不要替用户点头 |
| `REFERRAL_UNAVAILABLE` | 500 | 服务端这会儿生成不了要外发的数据包（本机加密配置缺失），本次零外发 | 这是我们的运维问题，不是用户填错了；如实告诉用户稍后再试，不要改参数重试 |

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
| `TOOL_NOT_FOUND` | 404 | 通用桥 POST /tools/{name} 里的 name 不是一条可调用的能力 | 调 GET /tools 拿当前可用的能力名，不要按旧说明书里的名字重试 |

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
| `REPORT_VERSION_CONFLICT` | 409 | 改个案报告时 base_version 与服务端当前版本对不上（中间有人改过），本次未写入 | 重新 case_report_get 读回最新版，把你的改动合到它上面，用新的 version 重试；不要重发同一份 |
