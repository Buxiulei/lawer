// 领域包判据：labor 包与它声明的那些东西的**正本**必须是同一份，不是抄来的第二份。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { CASE_STAGES } from '@/lib/cases/stages';

import { LABOR } from '../labor';
import { DOMAINS, getDomainPack } from '../registry';

const SRC_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)), '..', '..');

describe('labor 领域包', () => {
  it('挂在注册表上，取得到', () => {
    expect(getDomainPack(LABOR.key)).toBe(LABOR);
    expect(DOMAINS[LABOR.key]).toBe(LABOR);
    expect(getDomainPack('没有这个领域')).toBeUndefined();
  });

  /**
   * stages **引用** CASE_STAGES 而不是抄一份。抄一份的形态是：首诊页（客户端引
   * CASE_STAGES）与服务端 stage 校验（读领域包）某天不一致，而两边各自看都正常。
   * `toBe` 而不是 `toEqual`：同一个数组对象才算引用，逐值相等的副本要红。
   */
  it('stages 与 CASE_STAGES 是同一个数组（变异：改成 [...CASE_STAGES] 副本 → 红）', () => {
    expect(LABOR.stages).toBe(CASE_STAGES);
  });

  /**
   * factsSections 目前**没有消费点**（渲染器 lib/agent/case-facts.ts 仍自带标题，
   * P1 不动它）。没有消费点的清单最容易变成装饰，所以这里对着渲染器源码逐条比：
   * 谁改了渲染器的分节标题、或改了这份清单，两边就会对不上。
   */
  it('factsSections 与事实卡渲染器的分节标题一一对上（变异：改任一处标题 → 红）', () => {
    const src = fs.readFileSync(path.join(SRC_ROOT, 'lib/agent/case-facts.ts'), 'utf-8');
    const inRenderer = [...src.matchAll(/heading: '([^']+)'/g)].map((m) => m[1]);
    // 渲染器里「当事人」按分支写了多次，去重后比顺序
    const unique = inRenderer.filter((h, i) => inRenderer.indexOf(h) === i);
    expect(LABOR.factsSections).toEqual(unique);
  });

  /**
   * 三组种类取的是已落库那份值集（migrate.ts 的 DDL 注释）。对着注释比，
   * 免得包里列出一批库里存不进去的种类——那是一份看着像真的假清单。
   */
  it('deadlineKinds / docKinds / calculatorKinds 与 migrate.ts 的 DDL 注释同一份', () => {
    const src = fs.readFileSync(path.join(SRC_ROOT, 'lib/db/migrate.ts'), 'utf-8');
    /** 取某张表 DDL 里 kind 列后面那条 `-- a|b|c` 注释 */
    const kindEnumOf = (table: string): string[] => {
      const from = src.indexOf(`CREATE TABLE IF NOT EXISTS ${table} (`);
      expect(from, `migrate.ts 里找不到表 ${table}`).toBeGreaterThan(-1);
      const block = src.slice(from, src.indexOf(');', from));
      const m = /^\s*kind\s+TEXT NOT NULL,?\s*--\s*(\S+)\s*$/m.exec(block);
      expect(m, `${table} 的 kind 列后面没有 \`-- a|b|c\` 值集注释`).not.toBeNull();
      return m![1].split('|');
    };
    expect(LABOR.deadlineKinds).toEqual(kindEnumOf('deadlines'));
    expect(LABOR.docKinds).toEqual(kindEnumOf('drafts'));
    expect(LABOR.calculatorKinds).toEqual(kindEnumOf('claims'));
  });
});
