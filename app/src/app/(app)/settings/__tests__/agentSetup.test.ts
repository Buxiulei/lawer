import { describe, expect, it } from 'vitest';
import {
  KEY_PLACEHOLDER,
  SETUP_TABS,
  setupPrompt,
  type SetupTabKey,
} from '../_components/agentSetup';

const VARS = {
  mcp_url: 'https://example.test/api/mcp',
  api_base: 'https://example.test/api/v1',
  manifest_url: 'https://example.test/api/manifest',
};
const KEY = 'sk-test-abc123';
const keys = SETUP_TABS.map((t) => t.key);

describe('接入话术', () => {
  it('Tab 清单非空——空清单会让下面每条 it.each 都跑零次', () => {
    expect(keys.length).toBeGreaterThan(0);
  });

  it.each(keys)('%s：有密钥时把密钥写进去，不留占位符', (k) => {
    const out = setupPrompt(k, { ...VARS, apiKey: KEY });
    expect(out).toContain(KEY);
    expect(out).not.toContain(KEY_PLACEHOLDER);
  });

  it.each(keys)('%s：没密钥时给占位符，绝不出现空的 Bearer', (k) => {
    const out = setupPrompt(k, VARS);
    expect(out).toContain(KEY_PLACEHOLDER);
    // 「Bearer 」后面直接换行/结束＝话术里少了密钥，用户粘过去必然 401
    expect(out).not.toMatch(/Bearer\s*$/m);
  });

  it.each(keys)('%s：话术里带得上业务地址', (k) => {
    const out = setupPrompt(k, { ...VARS, apiKey: KEY });
    expect(out.includes(VARS.mcp_url) || out.includes(VARS.api_base)).toBe(true);
  });

  it('仅 REST 那版不许提 MCP——它是给不支持 MCP 的客户端的', () => {
    const out = setupPrompt('rest', { ...VARS, apiKey: KEY });
    expect(out).toContain('你不需要支持 MCP');
    expect(out).not.toContain(VARS.mcp_url);
  });

  describe('按客户端给的那几段，各自要落到自己的配置位置', () => {
    const EXPECT: Partial<Record<SetupTabKey, string[]>> = {
      claude: ['claude mcp add'],
      codex: ['~/.codex/config.toml'],
      // Trae 官方文档：全局 ~/.trae/mcp.json，项目级 .trae/mcp.json
      trae: ['~/.trae/mcp.json'],
      // WorkBuddy 官方文档：配置文件 ~/.workbuddy/mcp.json，远程 server 走 UI 添加
      workbuddy: ['~/.workbuddy/mcp.json', 'Add MCP Server'],
    };

    it.each(Object.entries(EXPECT))('%s', (k, needles) => {
      const out = setupPrompt(k as SetupTabKey, { ...VARS, apiKey: KEY });
      for (const n of needles!) expect(out).toContain(n);
    });
  });

  /*
   * 这条是跑变异时补的。原来只断言「整段话术里含密钥」——**通用前言里本来就有一份**，
   * 所以某个客户端专属配置块把密钥弄丢了（比如 headers 写成空的 `Bearer `），
   * 断言照样绿。用户复制的恰恰是那个块。
   */
  it.each(['claude', 'codex', 'trae', 'workbuddy'] as SetupTabKey[])(
    '%s：客户端专属那一段里也要有密钥，不能只靠前言那份',
    (k) => {
      const out = setupPrompt(k, { ...VARS, apiKey: KEY });
      const i = out.indexOf('【如果你是');
      expect(i).toBeGreaterThan(-1); // 正对照：确实有专属段
      expect(out.slice(i)).toContain(KEY);
    },
  );

  it('WorkBuddy 那版不给命令行——替用户猜二进制名只会让他敲出 command not found', () => {
    expect(setupPrompt('workbuddy', { ...VARS, apiKey: KEY })).not.toContain('mcp add');
  });

  /*
   * 这条守的是我自己犯过的错：第一版把 CodeBuddy CLI 文档（同域名不同路径）当成
   * WorkBuddy 的文档，抄了 `~/.codebuddy/.mcp.json` 这个**错的路径**，还把通用 JSON
   * 当作它官方文档认可的 schema 写了进去。**域名对上了不等于来源对上了。**
   */
  it('WorkBuddy 那版不许出现 codebuddy 的路径，也不许把通用 JSON 说成它官方确认过的', () => {
    const out = setupPrompt('workbuddy', { ...VARS, apiKey: KEY });
    expect(out).not.toContain('codebuddy');
    expect(out).toContain('未经 WorkBuddy 官方文档确认');
  });
});
