// app/src/lib/paste/clients.ts
// 无工具模式支持的客户端与各自的默认档位（设计稿 §15 路径 D，查证 rd-mcp-design/agent-clients.md）。
//
// 【为什么按客户端给默认值，而不是让用户自己挑长短】用户不知道自己那个客户端一次能吃多少字，
// 挑长了会被截断——而截断发生在客户端里，我们看不见，他也不一定看得见：
// 开场白尾巴上的证据简报没进去，助手照样答得很流畅。
//
// 【为什么这个文件不 import 别的东西】设置页那张卡是客户端组件，import 到 lib/paste/index
// 会把 better-sqlite3 拖进浏览器包。这里只放纯数据，档位常量的正本在 opener.ts。
export type NoToolTier = 'long' | 'medium' | 'short';

export interface NoToolClient {
  id: string;
  label: string;
  /** 默认档位 */
  tier: NoToolTier;
  /** 这一家的注意事项，逐字显示给用户 */
  note: string;
}

export const NO_TOOL_CLIENTS: readonly NoToolClient[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek 网页版',
    tier: 'medium',
    note: '没有工具/插件入口，也记不住上一轮的设定：每开一个新对话都要把开场白重贴一次。',
  },
  {
    id: 'doubao',
    label: '豆包网页版',
    tier: 'short',
    note: '同样没有工具入口，单条输入偏短，所以默认给最精简的一档；每开新对话都要重贴。',
  },
  {
    id: 'gemini',
    label: 'Gemini 网页版',
    tier: 'long',
    note: '国内账号用不了它的连接器，但单条能吃下的字数最多，默认给最全的一档。',
  },
  {
    id: 'other',
    label: '其他只能聊天的客户端',
    tier: 'medium',
    note: '不确定它一次能吃多少字就先用这一档；被截断了（助手看不到事实卡）就换短的一档。',
  },
] as const;

export function clientById(id: string): NoToolClient | undefined {
  return NO_TOOL_CLIENTS.find((c) => c.id === id);
}
