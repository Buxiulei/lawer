// scripts/gen-agent-docs.test.ts
// 生成物守卫：在内存里跑一遍生成器，跟仓库里那两份文件逐字比。
//
// 【为什么这条判据必须存在】生成器只在有人想起来跑的时候才跑。没有守卫的话，
// 「注册表改了、说明书没重生成」的形态是：用户的 agent 照着一份过期说明书调工具，
// 而仓库里两份文件看起来都很正常，CI 全绿。这条把「忘了跑」变成当场红。
//
// 【为什么不 mock 文件系统】读的就是仓库里的真文件——判据要盯的正是「落盘的那份对不对」，
// 换成内存夹具就变成「生成器自己跟自己一致」，那句话恒真。
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { CLIENT_MATRIX } from '../app/src/lib/capabilities/client-matrix';
import {
  ACCESS_DOC,
  CLAUDE_SKILL,
  REGEN_HINT,
  generate,
  inputHints,
  renderCapabilities,
  renderClients,
  renderErrors,
} from './gen-agent-docs';

describe('说明书生成物与注册表一致', () => {
  for (const { file, content } of generate()) {
    it(`${path.basename(file)} 是最新的`, () => {
      expect(fs.existsSync(file), `${file} 不存在。${REGEN_HINT}`).toBe(true);
      expect(fs.readFileSync(file, 'utf-8'), REGEN_HINT).toBe(content);
    });
  }

  it('生成器幂等：拿生成结果再生成一次，结果不变', () => {
    const once = generate();
    const twice = generate();
    expect(twice.map((x) => x.content)).toEqual(once.map((x) => x.content));
  });
});

describe('生成物本身没退化成空表', () => {
  // 上面那条比的是「文件 == 生成结果」。生成器要是回了空串，两边同样相等、同样全绿——
  // 于是说明书里一条能力都没有，而判据说一切正常。这里盯住内容确实有东西。
  it('能力表列出了注册表里全部对外能力', () => {
    const table = renderCapabilities();
    for (const name of ['case_list', 'intake_submit', 'case_facts', 'knowledge_search']) {
      expect(table, `能力表里缺 ${name}`).toContain(`\`${name}\``);
    }
    expect(table).toContain('| 工具 | REST | scope | 读写 | 用途 | 入参要点 |');
  });

  it('错误码表列出了对方一定会碰上的那几个', () => {
    const table = renderErrors();
    for (const code of ['UNAUTHORIZED', 'FORBIDDEN_SCOPE', 'CASE_NOT_FOUND', 'REALNAME_REQUIRED']) {
      expect(table, `错误码表里缺 ${code}`).toContain(`\`${code}\``);
    }
  });

  it('接入说明的手写区没被生成器碾掉', () => {
    const text = fs.readFileSync(ACCESS_DOC, 'utf-8');
    for (const kept of ['## 凭据', '## 边界红线', '## 接入步骤', '不冒充律师']) {
      expect(text, `手写区的「${kept}」不见了——生成器只该动 GEN 标记之间`).toContain(kept);
    }
  });

  it('claude 变体带 frontmatter 与「勿手改」横幅', () => {
    const text = fs.readFileSync(CLAUDE_SKILL, 'utf-8');
    expect(text.startsWith('---\nname: ')).toBe(true);
    expect(text).toContain('生成文件，勿手改');
    // 变体是正本的同源产物：正本里的边界红线必须原样在场
    expect(text).toContain('## 边界红线');
  });
});

describe('入参要点的取法', () => {
  it('必填在前、可选带 ?，并带上各自的说明', () => {
    expect(
      inputHints({
        type: 'object',
        properties: { b: { description: '乙' }, a: { description: '甲' } },
        required: ['a'],
      }),
    ).toBe('`a` 甲；`b`? 乙');
  });

  it('没有入参的能力如实说「无入参」，不给一张空壳', () => {
    expect(inputHints({ type: 'object', properties: {} })).toBe('无入参');
  });
});

describe('客户端矩阵（与设置页同一份数据、同一批片段函数）', () => {
  it('十个客户端每个都在表里，且各有步骤与可复制片段', () => {
    const text = renderClients();
    expect(CLIENT_MATRIX.length).toBe(10);
    for (const c of CLIENT_MATRIX) {
      expect(text, `矩阵表里缺 ${c.label}`).toContain(`### ${c.label}`);
      expect(text, `${c.label} 缺片段小标题`).toContain(`${c.snippetLabel}：`);
    }
  });

  it('每个客户端至少给了一条步骤与一段非空片段', () => {
    const vars = {
      mcpUrl: 'https://m.example.test/api/mcp',
      apiBase: 'https://m.example.test/api/v1',
      manifestUrl: 'https://m.example.test/api/manifest',
      openapiUrl: 'https://m.example.test/api/openapi.json',
      skillUrl: 'https://m.example.test/skill/SKILL.md',
      apiKey: 'k-测试',
    };
    for (const c of CLIENT_MATRIX) {
      expect(c.steps(vars).length, `${c.label} 的步骤`).toBeGreaterThan(0);
      expect(c.snippet(vars).trim().length, `${c.label} 的片段`).toBeGreaterThan(0);
    }
  });

  /**
   * 变异臂：往任一片段里写死一个地址（比如把 mcpUrl 换成生产域名）——这条当场红。
   * 写死的那份在预发环境上指向生产，而它看起来完全正常。
   */
  it('片段与步骤里的每一个 http(s) 地址都从入参派生（写死地址 ⇒ 红）', () => {
    const base = 'https://mut.example.test';
    const vars = {
      mcpUrl: `${base}/api/mcp`,
      apiBase: `${base}/api/v1`,
      manifestUrl: `${base}/api/manifest`,
      openapiUrl: `${base}/api/openapi.json`,
      skillUrl: `${base}/skill/SKILL.md`,
      apiKey: 'k-测试',
    };
    const foreign: string[] = [];
    for (const c of CLIENT_MATRIX) {
      const text = [...c.steps(vars), c.snippet(vars)].join('\n');
      for (const hit of text.match(/https?:\/\/[^\s"'`]+/g) ?? []) {
        if (!hit.startsWith(base)) foreign.push(`${c.label}: ${hit}`);
      }
    }
    expect(foreign, `这些地址不是从入参派生的：\n  ${foreign.join('\n  ')}`).toEqual([]);
  });

  it('接不通的那几档必须在步骤里写清楚现在该走哪条（不许含糊成「支持」）', () => {
    const vars = {
      mcpUrl: 'https://m.example.test/api/mcp',
      apiBase: 'https://m.example.test/api/v1',
      manifestUrl: 'https://m.example.test/api/manifest',
      openapiUrl: 'https://m.example.test/api/openapi.json',
      skillUrl: 'https://m.example.test/skill/SKILL.md',
    };
    const blocked = CLIENT_MATRIX.filter((c) => c.status === 'blocked');
    expect(blocked.length, '至少有一档还在等 OAuth').toBeGreaterThan(0);
    for (const c of blocked) {
      const text = c.steps(vars).join('\n');
      expect(text, `${c.label} 没说清替代路`).toMatch(/改选|改用|用 |先走|等我们的 OAuth/);
    }
  });

  it('片段里没有明文密钥的第二种占位符（两种并存会让人以为要填两个东西）', () => {
    const withKey = CLIENT_MATRIX.map((c) =>
      c.snippet({
        mcpUrl: 'https://m.example.test/api/mcp',
        apiBase: 'https://m.example.test/api/v1',
        manifestUrl: 'https://m.example.test/api/manifest',
        openapiUrl: 'https://m.example.test/api/openapi.json',
        skillUrl: 'https://m.example.test/skill/SKILL.md',
        apiKey: 'k-真密钥',
      }),
    ).join('\n');
    expect(withKey).not.toContain('<粘贴你生成时保存的密钥>');
  });
});
