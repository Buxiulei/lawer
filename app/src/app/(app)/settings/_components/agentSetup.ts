/**
 * 一键接入话术的生成。纯函数，不碰网络也不碰 React——密钥生成成功页和设置页的常驻接入卡
 * 复制的必须是同一份文本，抄两遍必然分叉。
 *
 * 【不假设用户用什么 AI】（spec D4 修订）：主文案是通用话术，只讲 MCP 与 REST 两个标准，
 * 让对面的助手自己判断走哪条；Claude / Codex / 纯 REST 三个变体只是同一份字段的不同包装，
 * 不是三种不同的接入方式。
 *
 * 字段一律来自 GET /api/v1/agent-setup（mcp_url / api_base / manifest_url），本文件不硬编码地址。
 */

/**
 * 话术只用得上这三个地址。它们同时出现在 GET /api/v1/agent-setup 和
 * POST /api/v1/keys 的响应里（服务端同一个 setupUrls()），所以密钥生成成功页
 * 直接用创建响应里的那份，不必再打一次 agent-setup。
 */
export interface SetupUrls {
  mcp_url: string;
  api_base: string;
  manifest_url: string;
}

export interface AgentSetupInfo extends SetupUrls {
  tools: { name: string; description: string }[];
}

export type SetupTabKey = 'general' | 'claude' | 'codex' | 'rest';

export const SETUP_TABS: { key: SetupTabKey; label: string }[] = [
  { key: 'general', label: '通用' },
  { key: 'claude', label: 'Claude' },
  { key: 'codex', label: 'Codex' },
  { key: 'rest', label: '仅 REST' },
];

/**
 * 没有明文密钥可填时的占位。密钥明文只在创建响应里出现一次，
 * 之后设置页只能给占位符，让用户自己换成当时存下的那串。
 */
export const KEY_PLACEHOLDER = '<粘贴你生成时保存的密钥>';

export interface PromptVars extends SetupUrls {
  /** 生成时拿到的明文；没有就传 undefined，落到 KEY_PLACEHOLDER */
  apiKey?: string;
}

function key(vars: PromptVars): string {
  return vars.apiKey || KEY_PLACEHOLDER;
}

/** MCP 客户端通用 JSON 配置，与通用话术里那一行是同一份 */
export function clientJson(vars: PromptVars): string {
  return JSON.stringify({
    mcpServers: {
      lawer: {
        type: 'http',
        url: vars.mcp_url,
        headers: { Authorization: `Bearer ${key(vars)}` },
      },
    },
  });
}

const ABILITIES =
  '【接入后你能替我做】读案件档案与时间线、上传并固化证据（可信时间戳）、OCR 解读公司文件、按北京口径计算赔偿、检索劳动法知识库、起草文书、管理待办与法定期限。';

const BOUNDARY =
  '【边界】发给公司的文书必须经我本人确认；档案数据仅用于本案维权；此密钥是我的私人凭据，不要写进共享配置或转发他人。';

const OPENING = '请帮我接入「土拨鼠劳动仲裁」法律陪跑平台（我的劳动仲裁案件档案库）。';

/** 通用话术：主文案，三个客户端变体都在它后面追加自己那段 */
function general(vars: PromptVars): string {
  return [
    OPENING,
    `【若你支持 MCP（Model Context Protocol）】传输：Streamable HTTP；服务地址：${vars.mcp_url}；鉴权请求头：Authorization: Bearer ${key(vars)}。常见客户端 JSON 配置：`,
    clientJson(vars),
    `【若你不支持 MCP】直接调 REST：先读能力清单 GET ${vars.manifest_url}（免鉴权，含全部接口自描述）；业务基址 ${vars.api_base}，同样 Bearer 鉴权。`,
    ABILITIES,
    BOUNDARY,
  ].join('\n');
}

export function claudeCommand(vars: PromptVars): string {
  return `claude mcp add --transport http lawer ${vars.mcp_url} --header "Authorization: Bearer ${key(vars)}"`;
}

/**
 * Codex CLI 的 config.toml 段（~/.codex/config.toml）。
 * 有 url 字段就走 streamable-http，无需任何 experimental 开关。
 * 密钥用 bearer_token_env_var 走环境变量——它是 Codex 专为 bearer token 提供的字段，
 * 且与话术里「不要把密钥写进共享配置」那条边界一致；要写死在配置里的写法见 codexLiteralHeader。
 */
export function codexToml(vars: PromptVars): string {
  return [
    '[mcp_servers.lawer]',
    `url = "${vars.mcp_url}"`,
    'bearer_token_env_var = "LAWER_API_KEY"',
  ].join('\n');
}

export function codexLiteralHeader(vars: PromptVars): string {
  return `http_headers = { Authorization = "Bearer ${key(vars)}" }`;
}

function codex(vars: PromptVars): string {
  return [
    general(vars),
    '',
    '【如果你是 Codex CLI】把这段写进 ~/.codex/config.toml：',
    codexToml(vars),
    '',
    `再把密钥放进环境变量：export LAWER_API_KEY=${key(vars)}`,
    `（不想用环境变量，就把 bearer_token_env_var 那行换成 ${codexLiteralHeader(vars)}，代价是密钥明文躺在配置文件里。）`,
    '等价命令：',
    `codex mcp add lawer --url ${vars.mcp_url} --bearer-token-env-var LAWER_API_KEY`,
  ].join('\n');
}

function claude(vars: PromptVars): string {
  return [
    general(vars),
    '',
    '【如果你是 Claude Code / Claude 桌面端】一条命令就能接上：',
    claudeCommand(vars),
  ].join('\n');
}

/** 验通不通用的 curl：agent-setup 需要鉴权但不要求任何 scope，拿它试密钥最干净 */
export function restCurl(vars: PromptVars): string {
  return `curl -H "Authorization: Bearer ${key(vars)}" ${vars.api_base}/agent-setup`;
}

/** 豆包这类不支持 MCP 的客户端：不提 MCP，只给 manifest 与带 Bearer 的 curl */
function rest(vars: PromptVars): string {
  return [
    `${OPENING}你不需要支持 MCP，直接调 REST 就行。`,
    '第一步，读能力清单（免鉴权，全部接口都在里面自描述）：',
    `curl ${vars.manifest_url}`,
    `第二步，业务接口都在 ${vars.api_base} 下，每个请求都带上我的密钥。先用这条验一下通不通：`,
    restCurl(vars),
    ABILITIES,
    BOUNDARY,
  ].join('\n');
}

const BUILDERS: Record<SetupTabKey, (vars: PromptVars) => string> = {
  general,
  claude,
  codex,
  rest,
};

/** 某个 Tab 当前该复制的全文 */
export function setupPrompt(tab: SetupTabKey, vars: PromptVars): string {
  return BUILDERS[tab](vars);
}
