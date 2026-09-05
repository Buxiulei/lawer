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

import {
  ACCESS_DOC,
  CLAUDE_SKILL,
  REGEN_HINT,
  generate,
  inputHints,
  renderCapabilities,
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
