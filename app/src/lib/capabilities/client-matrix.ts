// app/src/lib/capabilities/client-matrix.ts
// 客户端接入矩阵：十个客户端各自「怎么接」的**唯一真源**。设置页那张选择器、
// 接入说明里的那张表、以及一键复制的配置片段，全部由这一份出。
//
// 【为什么必须只有一份】此前设置页有六档话术，而《接入说明》里另有一段手写的接入步骤——
// 同一件事两处写法，改地址要改两处，漏掉的那处**生成出来的配置看起来完全正常**，
// 用户照着粘、接不上，页面上也没有任何报错。
//
// 【为什么片段是函数而不是常量串】地址来自服务端（生产由 env 给），密钥来自用户当前那把。
// 写成常量串就意味着把地址写死在代码里——那份在本地开发与预发环境上指向的是生产，
// 而它看起来完全正常。判据按「渲染出来的每一个 http(s) 地址都必须从入参派生」钉住。
//
// ───────────────── ⚠️ 本文件是共用层 ⚠️ ─────────────────
// 不得出现具体领域的字面量（见 registry.ts 抬头，由 __tests__/registry-guard.test.ts 机检）。
// 这一层的文案本来也该是中性的：它讲的是「怎么连一个服务」，与案情无关。
// ─────────────────────────────────────────────────────

/** 设计稿 §15 的四条接入路径 */
export type AccessPath = 'A' | 'B' | 'C' | 'D';

export const ACCESS_PATHS: Record<AccessPath, string> = {
  A: 'MCP + OAuth',
  B: 'MCP + Bearer',
  C: 'REST + API key',
  D: '无工具模式（复制粘贴）',
};

/** 片段里要填的那几个值。**全部由调用方给**，本文件不含任何地址常量。 */
export interface SnippetVars {
  mcpUrl: string;
  apiBase: string;
  manifestUrl: string;
  openapiUrl: string;
  skillUrl: string;
  /** 当前这把 key 的明文；取不到就落到占位符 */
  apiKey?: string;
}

/** 没有明文可填时的占位（与设置页话术那侧同一句，避免两种占位符并存） */
export const KEY_PLACEHOLDER = '<粘贴你生成时保存的密钥>';

function key(vars: SnippetVars): string {
  return vars.apiKey || KEY_PLACEHOLDER;
}

export interface ClientEntry {
  id: string;
  /** 选择器上显示的名字 */
  label: string;
  path: AccessPath;
  /**
   * 这条路今天通不通。
   * `ready` = 照下面的步骤现在就能接上；
   * `blocked` = 这个客户端**只认我们还没上线的鉴权方式**，步骤里必须写清楚现在该走哪条替代路。
   *   写成 ready 的形态是：用户照着做、连不上、以为是自己填错了。
   */
  status: 'ready' | 'blocked';
  /** 一段步骤，逐条来 */
  steps: (vars: SnippetVars) => string[];
  /** 复制按钮上方的小标题 */
  snippetLabel: string;
  /** 一键复制的那段 */
  snippet: (vars: SnippetVars) => string;
}

/** MCP 客户端最通行的那份 JSON（多数客户端认这套字段名） */
function mcpJson(vars: SnippetVars): string {
  return JSON.stringify(
    {
      mcpServers: {
        lawer: {
          type: 'http',
          url: vars.mcpUrl,
          headers: { Authorization: `Bearer ${key(vars)}` },
        },
      },
    },
    null,
    2,
  );
}

/**
 * 无工具模式的开场白。
 *
 * 【为什么这一档也要有片段】DeepSeek 网页版与豆包网页版都没有常驻系统提示词位，
 * 每开一个新对话都要重贴一遍。不给一段可复制的文本，用户每次都要自己组织语言，
 * 而组织得不一样，对面的回答口径就不一样。
 */
function pasteOpening(vars: SnippetVars): string {
  return [
    '你接下来要陪我处理一件事。你没有工具可用，所以下面这些信息由我贴给你，不要自己去查。',
    `【背景资料】我会把我的档案摘要贴在这条消息后面。你也可以让我去取：${vars.skillUrl}（一份公开的使用说明，我可以复制粘贴给你）。`,
    '【你要守的规矩】任何条号、任何数字、任何案例，都只能引用我贴给你的材料里逐字出现的内容；材料里没有的就说「材料里没有」，不要凭印象补。',
    '【回复格式】正常回答之后，如果这一轮产生了新的事实、待办、金额或期限，请在末尾附一个 ```tubashu 代码块，里面是 JSON：{"timeline":[],"actions":[],"claims":[],"deadlines":[]}。我会把它贴回我的档案系统。没有新增就不要附。',
  ].join('\n');
}

/**
 * 十个客户端。**顺序即页面选择器上的顺序**：从最多人用的往下排，
 * 最后一档是「什么工具都没有」的兜底。
 */
export const CLIENT_MATRIX: readonly ClientEntry[] = [
  {
    id: 'chatgpt-connector',
    label: 'ChatGPT 网页 · 连接器',
    path: 'A',
    status: 'blocked',
    steps: () => [
      'ChatGPT 的自定义连接器目前只接受 OAuth，不接受在界面里填 Bearer 密钥——我们的 OAuth 授权还没上线，这条路现在接不通。',
      '现在要在 ChatGPT 里用，请改选下一档「ChatGPT · 自定义 GPT Actions」：那条走 REST + 密钥，是现在就能用的。',
      '（这一档等 OAuth 上线后会在本页直接给出地址，不用你做别的事。）',
    ],
    snippetLabel: '连接器地址（OAuth 上线后可用）',
    snippet: (vars) => vars.mcpUrl,
  },
  {
    id: 'chatgpt-actions',
    label: 'ChatGPT · 自定义 GPT Actions',
    path: 'C',
    status: 'ready',
    steps: (vars) => [
      '在 ChatGPT 里新建一个 GPT：右上角头像 → My GPTs → Create a GPT → Configure → 拉到底点 Create new action。',
      `点 Import from URL，粘下面这个地址导入。它是精简集（只含最常用的那几条），因为 Actions 对一份 schema 里的接口数量有上限：${vars.openapiUrl}?profile=actions`,
      'Authentication 选 API Key，Auth Type 选 Bearer，把你的密钥粘进 API Key 那一栏。',
      '保存后在预览里问一句「读一下我的档案」，它会请求你授权调用，允许即可。',
      '要全量接口（自己写脚本或用别的能吃 OpenAPI 的工具）就去掉 `?profile=actions`。',
    ],
    snippetLabel: 'OpenAPI 导入地址（精简集）',
    snippet: (vars) => `${vars.openapiUrl}?profile=actions`,
  },
  {
    id: 'claude-connector',
    label: 'Claude 网页 · 连接器',
    path: 'A',
    status: 'blocked',
    steps: (vars) => [
      'Claude 网页端的自定义连接器标准配置只有 OAuth 字段，我们的 OAuth 授权还没上线。',
      `如果你的账号是组织管理员、且后台有「静态请求头」这一项，可以填：地址 ${vars.mcpUrl}，请求头名 authorization，值 Bearer <你的密钥>。这一项各账号不一定都有。`,
      '没有那一项的话，用 Claude Code（下一档）接同一个服务，能力完全一样。',
    ],
    snippetLabel: '服务地址与请求头',
    snippet: (vars) => `${vars.mcpUrl}\nauthorization: Bearer ${key(vars)}`,
  },
  {
    id: 'claude-code',
    label: 'Claude Code',
    path: 'B',
    status: 'ready',
    steps: () => [
      '在终端里跑下面这条命令，一条就接上了。',
      '跑完 `claude mcp list` 能看到它，就是好了。',
    ],
    snippetLabel: '一条命令',
    snippet: (vars) =>
      `claude mcp add --transport http lawer ${vars.mcpUrl} --header "Authorization: Bearer ${key(vars)}"`,
  },
  {
    id: 'gemini-cli',
    label: 'Gemini CLI',
    path: 'B',
    status: 'ready',
    steps: () => [
      '在终端里跑下面这条命令（Gemini CLI 原生支持自定义请求头）。',
      '也可以把等价配置写进 `~/.gemini/settings.json` 的 mcpServers 段。',
      '装好后用 `/mcp` 看一眼列表里有没有它。',
    ],
    snippetLabel: '一条命令',
    snippet: (vars) =>
      `gemini mcp add --transport http lawer ${vars.mcpUrl} --header "Authorization: Bearer ${key(vars)}"`,
  },
  {
    id: 'cursor-cline',
    label: 'Cursor / Cline',
    path: 'B',
    status: 'ready',
    steps: () => [
      'Cursor：Settings → MCP → Add new MCP server → 选 Raw JSON，把下面这段粘进去。',
      'Cline：MCP Servers 面板 → Configure MCP Servers → 同一段 JSON 粘进配置文件。',
      '粘完重启一次客户端——多数客户端不重启不会重新读配置。',
    ],
    snippetLabel: 'MCP 配置（JSON）',
    snippet: mcpJson,
  },
  {
    id: 'kimi',
    label: 'Kimi',
    path: 'A',
    status: 'blocked',
    steps: (vars) => [
      'Kimi 各端都能接 MCP，但网页端的连接器走的是 OAuth，我们的 OAuth 授权还没上线。',
      `Kimi 的命令行版（Kimi CLI）能填自定义请求头，把地址 ${vars.mcpUrl} 与 Authorization 头按下面这段写进它的 MCP 配置即可。`,
      '只用网页版的话，先走最后一档「无工具网页对话」，等 OAuth 上线再回来接。',
    ],
    snippetLabel: 'MCP 配置（JSON，命令行版用）',
    snippet: mcpJson,
  },
  {
    id: 'coze-space',
    label: '扣子空间',
    path: 'A',
    status: 'blocked',
    steps: (vars) => [
      '豆包的聊天框本身不能接外部工具；能接的是同一生态里的扣子空间。',
      '在扣子空间里新建一个 MCP 连接，传输选 HTTP。',
      `服务地址：${vars.mcpUrl}。鉴权那一栏若能自定义请求头，填 Authorization: Bearer <你的密钥>；若只给 OAuth 选项，则这条路要等我们的 OAuth 上线。`,
      '接不上的话，用最后一档「无工具网页对话」在豆包里照样能陪跑，只是每次要重贴开场白。',
    ],
    snippetLabel: '服务地址与请求头',
    snippet: (vars) => `${vars.mcpUrl}\nAuthorization: Bearer ${key(vars)}`,
  },
  {
    id: 'custom-rest',
    label: '自建 agent（REST）',
    path: 'C',
    status: 'ready',
    steps: (vars) => [
      `先读能力清单（免鉴权，含全部接口自描述）：${vars.manifestUrl}`,
      `要生成客户端代码就用 OpenAPI 文档：${vars.openapiUrl}`,
      `业务基址 ${vars.apiBase}，每个请求都带 Authorization: Bearer <你的密钥>。`,
      '下面这条 curl 用来验密钥通不通——它需要鉴权但不要求任何权限项，拿它试最干净。',
    ],
    snippetLabel: '验一下通不通',
    snippet: (vars) => `curl -H "Authorization: Bearer ${key(vars)}" ${vars.apiBase}/agent-setup`,
  },
  {
    id: 'no-tools',
    label: '无工具网页对话（DeepSeek / 豆包 / Gemini 网页）',
    path: 'D',
    status: 'ready',
    steps: () => [
      '这几家的网页聊天框都没有工具/插件入口，也没有常驻的系统提示词位——所以走「复制粘贴」这条路。',
      '每开一个新对话，先把下面这段开场白贴进去，再把你的档案摘要贴在它后面。',
      '对方回复末尾会带一个 ```tubashu 代码块，把整段回复复制回本站的「粘贴回填」，逐条确认后写进档案。',
      '（ChatGPT 与 Claude 网页版有常驻自定义指令位，可以把这段一次性放进去，不用每次重贴。）',
    ],
    snippetLabel: '开场白（每次新对话贴一遍）',
    snippet: pasteOpening,
  },
];

export function findClient(id: string): ClientEntry | undefined {
  return CLIENT_MATRIX.find((c) => c.id === id);
}
