// app/src/lib/mcp/tools.ts
// MCP 工具面：**能力注册表（lib/capabilities）的一层薄视图**，本文件不再定义任何工具。
//
// 【为什么只剩四行】工具此前只在这里定义一份，站内 agent 那边另有一份 AGENT_TOOLS，
// REST 路由又各写各的 schema——同一个能力三处形状，改一处漏两处的形态是
// 「agent 走 MCP 能干的事和用户在网页上能干的事悄悄分叉」（设计稿 P1/P7）。
// 现在唯一真源是 lib/capabilities/registry.ts，这里只做「取出 exposeTo 含 mcp 的那些」。
//
// 顺序照注册表原样（listCapabilities 不排序）：客户端把清单原样展示给用户，
// 重排等于面板重排，判据钉着它。
import { listCapabilities, type Capability } from '@/lib/capabilities';

/** 历史名字，等同于一条能力；调用方（api/mcp、api/manifest）不必知道换过底座 */
export type ToolDefinition = Capability;

export const TOOLS: ToolDefinition[] = listCapabilities({ exposeTo: 'mcp' });

export function findTool(name: string): ToolDefinition | undefined {
  return TOOLS.find((t) => t.name === name);
}
