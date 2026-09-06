// app/src/lib/capabilities/openapi.ts
// OpenAPI 3.1 文档，由**能力注册表 + 端点索引**生成，`/api/openapi.json` 原样吐出来。
//
// 【它给谁用】只吃 OpenAPI、不吃 MCP 的客户端（ChatGPT 的 Custom GPT Actions、
// 各家「导入一个 API」的低码平台、自建脚本的代码生成）。这些客户端拿不到 MCP 工具面，
// 此前只能对着 /api/manifest 的散文自己拼请求。
//
// 【为什么不手写一份 yaml】手写的形态是：注册表加一条能力、端点索引加一条路径，
// 而这份文档不动——它看起来仍然完整，导入进去也照常工作，只是少了那条。
// 判据（__tests__/openapi.test.ts）钉着「文档里的 operation 集合 == 索引里的端点集合」，
// 少一条当场红。
//
// ───────────────── ⚠️ 本文件是共用层 ⚠️ ─────────────────
// 不得出现具体领域的字面量（见 registry.ts 抬头，由 __tests__/registry-guard.test.ts 机检）。
// ─────────────────────────────────────────────────────
import { ERROR_CODES } from './error-codes';
import { CAPABILITIES, type Capability } from './registry';
import { REST_INDEX, type RestEndpoint } from './rest-index';

export type OpenApiProfile = 'full' | 'actions';

/**
 * 精简集（`?profile=actions`）。
 *
 * 【为什么需要它】ChatGPT 的 Custom GPT Actions 对一份 schema 里的 operation 数量有上限
 * （公开说法是 30 上下），而全量端点有七十余条。不裁的形态是：用户导入时被截断，
 * 而**截掉哪些由对方决定**——很可能正好截掉事实卡这种「答任何问题之前先调」的那条。
 * 所以裁剪权在我们手里，并且按「一个陪跑对话真正用得上的最小集」来裁。
 *
 * 这里写的是**能力名**，不是路径：路径会变，能力名是对外契约的那一半。
 */
export const ACTIONS_PROFILE: readonly string[] = [
  'case_list',
  'case_facts',
  'case_report_get',
  'timeline_add',
  'action_create',
  'claims_list',
  'deadline_list',
  'evidence_list',
  'knowledge_search',
  'intake_submit',
];

/**
 * 精简集里**当前还没有 REST 端点**的能力名，连同原因。
 *
 * 【为什么要显式登记，而不是静默跳过】静默跳过时，「这条还没做」与「这条被谁误删了」
 * 在文档里完全同形。登记在册 + 判据钉住（见 openapi.test.ts：登记项必须真的没有端点、
 * 有了端点还留在这儿就红），能力一落地就会被逼着把它从这份名单里划掉。
 */
export const ACTIONS_PROFILE_PENDING: Readonly<Record<string, string>> = {
  // 暂无：case_report_get 已由个案报告族落地并挂上 GET /cases/{id}/report，故从本名单划掉。
  // 未来若有「进了精简集但还没端点」的能力，按上面的格式登记在此。
};

/** 精简集里已经能出成 operation 的那些 */
export function actionsProfileResolved(): string[] {
  const named = new Set(CAPABILITIES.filter((c) => c.rest).map((c) => c.name));
  return ACTIONS_PROFILE.filter((name) => named.has(name));
}

/** `{actionId}` → `action_id`（路径参数名与能力入参名的写法差异只在这一处抹平） */
function snake(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

/** 路径里的动态段，按出现顺序 */
function pathParams(path: string): string[] {
  return [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
}

/**
 * 端点 → 能力（同 method 同 path 即同一件事）。同一路径上不同方法各归各的能力。
 */
function capabilityFor(ep: RestEndpoint): Capability | undefined {
  return CAPABILITIES.find((c) => c.rest?.method === ep.method && c.rest.path === ep.path);
}

/**
 * 路径参数 ↔ 能力入参的配对。
 *
 * 规则：先精确（`{actionId}` ↔ `action_id`），再后缀（`{id}` ↔ `case_id` / `evidence_id`）；
 * 精确的先占位，剩下的才轮到 `{id}` 去认后缀。反过来做的话，`/cases/{id}/actions/{actionId}`
 * 上的 `{id}` 会先把 `action_id` 认走，于是路径里两个参数都指同一个字段——
 * 生成出来的文档形状完全正常，只是案件编号那一位永远填不进去。
 *
 * 配不上的参数不是"没关系"：那说明这条端点的能力入参与路径对不上，得有人看一眼。
 * 所以回 undefined 由调用方决定怎么记，不在这里悄悄编一个。
 */
function bindPathParams(
  path: string,
  props: Record<string, unknown>,
): Map<string, string | undefined> {
  const bound = new Map<string, string | undefined>();
  const taken = new Set<string>();
  const names = Object.keys(props);
  // 长的先配：`action_id` 比 `id` 具体，先让它认走自己的那个
  const ordered = [...pathParams(path)].sort((a, b) => snake(b).length - snake(a).length);
  for (const raw of ordered) {
    const want = snake(raw);
    const exact = names.find((n) => n === want && !taken.has(n));
    const suffix = exact ?? names.find((n) => n.endsWith(`_${want}`) && !taken.has(n));
    if (suffix) taken.add(suffix);
    bound.set(raw, suffix);
  }
  return bound;
}

/**
 * operationId。有对应能力的用**能力名**——它就是对方 agent 在 MCP 那侧看到的工具名，
 * 两侧同名才能让人把两份文档对上。没有能力的（登录、密钥管理、后台）按方法 + 路径派生。
 */
export function operationIdFor(ep: RestEndpoint): string {
  const cap = capabilityFor(ep);
  if (cap) return cap.name;
  const tail = ep.path
    .replace(/^\/api\//, '')
    .replace(/\{([^}]+)\}/g, (_m, p1: string) => `by_${snake(p1)}`)
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return `${ep.method.toLowerCase()}_${tail}`;
}

/** JSON Schema 里的一条属性（手写字面量，只取得到这几位） */
interface PropSchema {
  type?: string;
  description?: string;
  [k: string]: unknown;
}

function propsOf(cap: Capability): Record<string, PropSchema> {
  return ((cap.inputSchema.properties ?? {}) as Record<string, PropSchema>) ?? {};
}

function requiredOf(cap: Capability): string[] {
  return (cap.inputSchema.required as string[] | undefined) ?? [];
}

/** 读方法的入参进 query，写方法的进 requestBody——OpenAPI 这一侧没有第三种放法 */
function isBodyMethod(method: string): boolean {
  return method === 'POST' || method === 'PATCH' || method === 'PUT';
}

interface Operation {
  operationId: string;
  summary: string;
  description: string;
  tags: string[];
  security: { bearerAuth: [] }[] | [];
  parameters?: unknown[];
  requestBody?: unknown;
  responses: Record<string, unknown>;
}

/** 一条端点的 operation */
function buildOperation(ep: RestEndpoint): Operation {
  const cap = capabilityFor(ep);
  const params: unknown[] = [];
  const bound = cap ? bindPathParams(ep.path, propsOf(cap)) : new Map<string, undefined>();
  const props = cap ? propsOf(cap) : {};
  const required = cap ? new Set(requiredOf(cap)) : new Set<string>();

  for (const raw of pathParams(ep.path)) {
    const prop = bound.get(raw);
    const schema = prop ? props[prop] : undefined;
    params.push({
      name: raw,
      in: 'path',
      required: true,
      description: schema?.description ?? `路径参数 ${raw}`,
      // 路径段永远是字符串形态；能力那侧收到后自己解析成数字
      schema: { type: 'string' },
    });
  }

  const consumed = new Set([...bound.values()].filter((v): v is string => !!v));
  const rest = Object.keys(props).filter((n) => !consumed.has(n));

  if (cap && !isBodyMethod(ep.method)) {
    for (const name of rest) {
      params.push({
        name,
        in: 'query',
        required: required.has(name),
        description: props[name]?.description ?? '',
        schema: stripDescription(props[name]),
      });
    }
  }

  const op: Operation = {
    operationId: operationIdFor(ep),
    summary: cap ? cap.title : ep.description,
    description: cap ? cap.description : ep.description,
    tags: [ep.category],
    // 公开端点不要求凭据；其余都走 bearer（api key 或网页 token 同一个头）
    security: ep.auth === 'none' ? [] : [{ bearerAuth: [] }],
    responses: responsesFor(ep),
  };
  if (params.length > 0) op.parameters = params;

  if (cap && isBodyMethod(ep.method)) {
    const bodyProps: Record<string, unknown> = {};
    for (const name of rest) bodyProps[name] = props[name];
    op.requestBody = {
      required: rest.some((n) => required.has(n)),
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: bodyProps,
            required: rest.filter((n) => required.has(n)),
            // 路径里已经带了的那位不要在体里再写一遍：写了也不作数（路由以路径为准）
            additionalProperties: false,
          },
        },
      },
    };
  }
  return op;
}

/** query 参数的 schema 不重复放 description（OpenAPI 里它已经在参数那一层了） */
function stripDescription(schema: PropSchema | undefined): Record<string, unknown> {
  if (!schema) return { type: 'string' };
  const { description: _drop, ...rest } = schema;
  return Object.keys(rest).length > 0 ? rest : { type: 'string' };
}

/**
 * 错误响应。**按 error_code 分支不按 status 分支**是全站约定，所以这里给的是
 * 「这个 status 底下可能是哪几个码」，而不是让对方以为一个 status 只有一种含义。
 */
function responsesFor(ep: RestEndpoint): Record<string, unknown> {
  const responses: Record<string, unknown> = {
    '200': {
      description: '成功。回包是 `{ ok: true, ... }`，各端点的字段见 /api/manifest 与接入说明。',
      content: { 'application/json': { schema: { type: 'object' } } },
    },
  };
  const statuses = [...new Set(ERROR_CODES.map((e) => e.status))].sort((a, b) => a - b);
  for (const status of statuses) {
    // 公开端点不会回鉴权类错误，别让对方为一条它碰不到的分支写代码
    if (ep.auth === 'none' && (status === 401 || status === 403)) continue;
    const codes = ERROR_CODES.filter((e) => e.status === status);
    responses[String(status)] = {
      description: codes.map((e) => `\`${e.code}\`：${e.when}`).join('；'),
      content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
    };
  }
  return responses;
}

export interface OpenApiOptions {
  /** 对外基址（生产由 env LAWER_PUBLIC_URL 给）。本文件不硬编码任何地址。 */
  baseUrl: string;
  profile?: OpenApiProfile;
  /** 注册表内容指纹，进 info.version；调用方从 lib/capabilities/version 取 */
  version: string;
}

/** 这一档要出哪些端点 */
function endpointsFor(profile: OpenApiProfile): RestEndpoint[] {
  if (profile === 'full') return [...REST_INDEX];
  const wanted = new Set(actionsProfileResolved());
  return REST_INDEX.filter((ep) => {
    const cap = capabilityFor(ep);
    return !!cap && wanted.has(cap.name);
  });
}

export function buildOpenApi(options: OpenApiOptions): Record<string, unknown> {
  const profile = options.profile ?? 'full';
  const base = options.baseUrl.replace(/\/+$/, '');
  const paths: Record<string, Record<string, unknown>> = {};
  for (const ep of endpointsFor(profile)) {
    const path = (paths[ep.path] ??= {});
    path[ep.method.toLowerCase()] = buildOperation(ep);
  }

  return {
    openapi: '3.1.0',
    info: {
      title: '土八鼠 · 案件档案 API',
      version: options.version,
      description:
        (profile === 'actions'
          ? '精简集：只含一次陪跑对话真正用得上的那几条端点（导入进只吃 OpenAPI 的客户端时，' +
            '全量端点会超出它们的 operation 上限）。全量文档去掉 `?profile=actions` 即可。\n\n'
          : '') +
        '全部端点只能读写当前凭据所属用户自己的档案。回包统一 `{ ok, ... }`；' +
        '失败时是 `{ ok: false, error_code, message }`，**请按 error_code 分支，不要按 HTTP 状态码分支**。' +
        '更全的自描述（工具面、错误码全表、接入说明）见 `/api/manifest`。',
    },
    servers: [{ url: base, description: '公网基址' }],
    tags: [
      { name: 'public', description: '公开：不带凭据即可调用' },
      { name: 'agent', description: 'agent 面：网页登录态或 api key 都认，按 scope 判权限' },
      { name: 'web', description: '网页会话专用：只认网页登录态，api key 一律拒' },
      { name: 'admin', description: '管理员：网页登录态 + 白名单，非白名单一律 404' },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description:
            'api key：`Authorization: Bearer <key>`。在网页端「设置 → 接入你自己的助手」自助生成。',
        },
      },
      schemas: {
        Error: {
          type: 'object',
          required: ['ok', 'error_code', 'message'],
          properties: {
            ok: { type: 'boolean', const: false },
            error_code: {
              type: 'string',
              enum: ERROR_CODES.map((e) => e.code),
              description: '按它分支；同一个 HTTP 状态码底下挂着好几个语义不同的码',
            },
            message: { type: 'string', description: '给人读的一句话，可直接转述给用户' },
          },
        },
      },
    },
    security: [{ bearerAuth: [] }],
    paths,
  };
}
