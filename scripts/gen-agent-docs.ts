// scripts/gen-agent-docs.ts
// 说明书生成器（设计稿 P7「一个注册表生成一切」）。用法：
//   cd app && npm run gen:docs          写回文件
//   cd app && npm run gen:docs -- --check  只比对不写（守卫测试用的是导出的纯函数，不是这个开关）
//
// 【它管哪些字】
//   · skill/接入说明.md 的 <!-- GEN:capabilities --> 与 <!-- GEN:errors --> 两段之间——
//     能力表由 lib/capabilities 的注册表生成，错误码表由 lib/capabilities/error-codes 生成。
//     标记之外的**手写区一个字都不动**：那里是「这是什么／凭据／边界红线／接入步骤」，
//     是人写给人的纪律，不该被生成器碾过。
//   · skill/variants/claude-skill.md 整份——它是《接入说明》的 Claude 变体，
//     内容同源、只多一段 frontmatter。此前靠人手同步，形态是两份说明书悄悄分叉：
//     用户的 agent 读的是变体，而正本已经改了。
//
// 【为什么整份生成变体，而不是只生成它的表】只生成表的话，变体里那些从正本抄来的段落
// （这是什么／边界红线／接入步骤）仍然是手抄的第二份，仍然会分叉。要么全生成，要么
// 承认它是独立文档——中间态是最坏的：看起来同源，实际各写各的。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { listCapabilities, type Capability, type CapabilityFamily } from '../app/src/lib/capabilities';
import { ERROR_CODES, ERROR_GROUPS, type ErrorGroup } from '../app/src/lib/capabilities/error-codes';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ACCESS_DOC = path.join(REPO_ROOT, 'skill', '接入说明.md');
export const CLAUDE_SKILL = path.join(REPO_ROOT, 'skill', 'variants', 'claude-skill.md');

/** 重跑命令，写进每一条判据的失败信息里——报错要自己说清怎么办 */
export const REGEN_HINT = '内容与注册表对不上了。到 app/ 下跑 `npm run gen:docs` 重新生成。';

/**
 * 族名 → 表里的小标题。类型是 Record<CapabilityFamily, string>，所以注册表加一个族
 * 而这里忘了给标题时，**tsc 当场红**——不会安静地漏掉一整族能力。
 */
const FAMILY_LABELS: Record<CapabilityFamily, string> = {
  case: '档案与事实',
  timeline: '时间线',
  actions: '行动',
  claims: '金额主张',
  deadlines: '期限',
  evidence: '证据',
  knowledge: '法律依据',
  drafts: '文书',
  company: '公司主体',
  emotion: '情绪',
  docs: '来文与录音',
};

const KIND_LABELS = { read: '读', write: '写', spend: '写·耗算力' } as const;

/** 单元格里的 | 会把表劈成两列，换行会把表截断 */
function cell(text: string): string {
  return text.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();
}

/** 从手写的 JSON Schema 字面量里读出「入参要点」：必填在前，可选带 ? */
export function inputHints(schema: Record<string, unknown>): string {
  const properties = (schema.properties ?? {}) as Record<string, { description?: string }>;
  const required = new Set((schema.required as string[] | undefined) ?? []);
  const names = Object.keys(properties);
  if (names.length === 0) return '无入参';
  const ordered = [...names.filter((n) => required.has(n)), ...names.filter((n) => !required.has(n))];
  return ordered
    .map((name) => {
      const description = properties[name]?.description ?? '';
      return `\`${name}\`${required.has(name) ? '' : '?'}${description ? ` ${description}` : ''}`;
    })
    .join('；');
}

function capabilityRow(c: Capability): string {
  const rest = c.rest ? `\`${c.rest.method} ${c.rest.path.replace(/^\/api\/v1/, '')}\`` : '—';
  return `| \`${c.name}\` | ${rest} | \`${c.scope}\` | ${KIND_LABELS[c.kind]} | ${cell(c.description)} | ${cell(inputHints(c.inputSchema))} |`;
}

/** 能力表：按族分节，族内保持注册表顺序（客户端原样展示，重排等于面板重排） */
export function renderCapabilities(): string {
  const caps = listCapabilities({ exposeTo: 'mcp' });
  const families = [...new Set(caps.map((c) => c.family))];
  const lines: string[] = [];
  for (const family of families) {
    lines.push(`**${FAMILY_LABELS[family]}**`, '');
    lines.push('| 工具 | REST | scope | 读写 | 用途 | 入参要点 |');
    lines.push('|---|---|---|---|---|---|');
    for (const c of caps.filter((x) => x.family === family)) lines.push(capabilityRow(c));
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

/** 错误码表：按组分节 */
export function renderErrors(): string {
  const groups = [...new Set(ERROR_CODES.map((e) => e.group))] as ErrorGroup[];
  const lines: string[] = [];
  for (const group of groups) {
    lines.push(`**${ERROR_GROUPS[group]}**`, '');
    lines.push('| error_code | HTTP | 什么时候拿到它 | 拿到之后怎么办 |');
    lines.push('|---|---|---|---|');
    for (const e of ERROR_CODES.filter((x) => x.group === group)) {
      lines.push(`| \`${e.code}\` | ${e.status} | ${cell(e.when)} | ${cell(e.recovery ?? '—')} |`);
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

/**
 * 把 <!-- GEN:tag --> … <!-- /GEN:tag --> 之间换成 body。
 * 找不到标记就抛——**不静默追加到文末**：那样会生出第二份表，而两份都在文件里。
 */
export function applyBlock(text: string, tag: string, body: string): string {
  const open = `<!-- GEN:${tag} -->`;
  const close = `<!-- /GEN:${tag} -->`;
  const start = text.indexOf(open);
  const end = text.indexOf(close);
  if (start < 0 || end < 0 || end < start) {
    throw new Error(`接入说明里找不到成对的 ${open} … ${close}，无法生成该段。`);
  }
  return `${text.slice(0, start + open.length)}\n\n${body}\n\n${text.slice(end)}`;
}

/** 接入说明：两段生成区换掉，其余逐字保留 */
export function renderAccessDoc(current: string): string {
  return applyBlock(applyBlock(current, 'capabilities', renderCapabilities()), 'errors', renderErrors());
}

/**
 * Claude skill 变体的 frontmatter。**这是本变体唯一的手写内容**：name 与 description
 * 决定 Claude 什么时候想起来用它，无法从注册表推出来。改触发词改这里。
 */
const CLAUDE_FRONTMATTER = [
  '---',
  'name: 裁员应对档案',
  'description: 通过 MCP 连接「土八鼠」的案件档案库，读写案件阶段、时间线、行动卡、法定期限与证据清单。当用户提到自己的劳动仲裁、裁员、被辞退、协商解除、欠薪、竞业等事情，或要求记录事情经过、查看下一步该做什么、确认某个期限还剩几天时使用。',
  '---',
].join('\n');

const CLAUDE_TITLE = '裁员应对档案';

/** 变体 = frontmatter + 勿手改横幅 + 接入说明正文（换掉 H1、去掉生成标记注释） */
export function renderClaudeSkill(accessDoc: string): string {
  const body = accessDoc
    .replace(/^#\s+.*\n/, `# ${CLAUDE_TITLE}\n`)
    .replace(/^<!-- \/?GEN:[a-z]+ -->\n\n?/gm, '')
    .trimEnd();
  const banner = [
    '<!--',
    '  ⚠️ 生成文件，勿手改。由 scripts/gen-agent-docs.ts 从 ../接入说明.md 生成。',
    '  要改内容请改那份正本，再到 app/ 下跑 `npm run gen:docs`；直接改这里，下次生成会被覆盖。',
    '  接入面本身与客户端无关（MCP + REST 两个标准），别的客户端不需要这个文件。',
    '-->',
  ].join('\n');
  return `${CLAUDE_FRONTMATTER}\n\n${banner}\n\n${body}\n`;
}

/** 期望的两份文件内容。守卫测试与写盘走同一条路径，不会各算各的。 */
export function generate(): { file: string; content: string }[] {
  const accessDoc = renderAccessDoc(fs.readFileSync(ACCESS_DOC, 'utf-8'));
  return [
    { file: ACCESS_DOC, content: accessDoc },
    { file: CLAUDE_SKILL, content: renderClaudeSkill(accessDoc) },
  ];
}

function main(): void {
  const check = process.argv.includes('--check');
  let stale = 0;
  for (const { file, content } of generate()) {
    const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '';
    if (current === content) {
      console.error(`unchanged  ${path.relative(REPO_ROOT, file)}`);
      continue;
    }
    stale += 1;
    if (check) {
      console.error(`STALE      ${path.relative(REPO_ROOT, file)}`);
    } else {
      fs.writeFileSync(file, content);
      console.error(`written    ${path.relative(REPO_ROOT, file)}`);
    }
  }
  if (check && stale > 0) {
    console.error(`\n${stale} 份文件与注册表对不上。${REGEN_HINT}`);
    process.exit(1);
  }
}

// 被 import 时（守卫测试）不跑 main，只有直接执行才写盘
const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
