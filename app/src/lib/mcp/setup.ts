// app/src/lib/mcp/setup.ts
// 「一键接入」需要的自描述信息：往哪儿连（mcp_url / api_base / manifest_url）、能干什么（工具清单）、
// 怎么用（通用《接入说明》全文）。
//
// 【接入面与客户端无关】（spec D4）：用户可能用 Claude、Codex、豆包、Trae 或自己写的 agent。
// 这里出的是数据与通用文档，不含任何某一家客户端的假设；针对具体客户端的话术包装归前端。
//
// 工具清单从 lib/mcp/tools.ts 的注册表现取，不手抄一份——手抄的那份必然在某次加工具时忘了改，
// 于是用户 agent 拿到的说明书和服务端真实能力悄悄分叉。
import fs from 'node:fs';
import path from 'node:path';

import { TOOLS } from './tools';

/**
 * 通用《接入说明》正本（仓库根 skill/ 目录，spec §6）。
 * skill/variants/ 下另有按客户端格式包装的变体（如 Claude skill），那些是同源副本，
 * 由前端按用户所用客户端下发；服务端这一面只认正本。
 */
const SETUP_DOC = '接入说明.md';

/**
 * 对外基址。生产由 env LAWER_PUBLIC_URL 给（用户的 agent 从公网连进来，
 * 拿到的必须是公网地址而不是容器内地址）；没配就退回本次请求的 origin，本地开发够用。
 */
export function resolveBaseUrl(req: Request): string {
  const configured = process.env.LAWER_PUBLIC_URL?.trim().replace(/\/+$/, '');
  return configured || new URL(req.url).origin;
}

export interface SetupUrls {
  mcp_url: string;
  /** REST 基址：客户端不支持 MCP 时走这条，能力完全一样 */
  api_base: string;
  manifest_url: string;
}

export function setupUrls(req: Request): SetupUrls {
  const base = resolveBaseUrl(req);
  return {
    mcp_url: `${base}/api/mcp`,
    api_base: `${base}/api/v1`,
    manifest_url: `${base}/api/manifest`,
  };
}

/** 读接入说明全文。路径解析与 lib/knowledge 同款：env 覆盖优先，否则仓库根 skill/。 */
export function readSetupMarkdown(): string {
  const dir = process.env.LAWER_SKILL_DIR ?? path.resolve(process.cwd(), '..', 'skill');
  const file = path.join(dir, SETUP_DOC);
  if (!fs.existsSync(file)) {
    throw new Error(
      `接入说明不存在：${file}（cwd=${process.cwd()}）；用 env LAWER_SKILL_DIR 指向 skill/ 目录可覆盖`,
    );
  }
  return fs.readFileSync(file, 'utf-8');
}

export interface AgentSetup extends SetupUrls {
  tools: { name: string; description: string }[];
  setup_markdown: string;
}

export function agentSetup(req: Request): AgentSetup {
  return {
    ...setupUrls(req),
    tools: TOOLS.map((t) => ({ name: t.name, description: t.description })),
    setup_markdown: readSetupMarkdown(),
  };
}
