// 回填约定的**说明书与校验器读同一份种类清单**。
//
// 【为什么单开一条盯这一行】回填走的是诉求登记（claim_register），能收的种类是
// `DomainPack.claimKinds`；服务端**真能替你算**的那份是 `calculatorKinds`，两者只有一半重叠。
// P4-W1 把这两份清单拆成两个字段之后，protocol.ts 那一行没跟着改，于是说明书报的是
// 算钱器那份——**比服务端更窄**：能记一笔账的名目里有几项（欠薪 / 年终奖 / 其他）
// 模型再也不会写出来，连这段说明书自己的示例 `"kind": "欠薪"` 都落在被禁之列。
// 两边都不报错，用户只是发现有些账一直记不进去。
//
// 这条判据把两个读者钉在一起：说明书里列的每一个种类，parsePasteBack 都得收。
import { describe, expect, it } from 'vitest';

import { LABOR } from '@/lib/domains/labor';

import { parsePasteBack } from '../parse';
import { buildProtocolSection, FENCE_TAG } from '../protocol';

const TIMELINE_KINDS = ['公司动作', '我方动作', '系统动作', '期限'];

const section = () => buildProtocolSection({ pack: LABOR, timelineKinds: TIMELINE_KINDS });

/** 把一条 claim 包成结构块，走真正的解析器 */
function parseClaim(kind: string) {
  const block = '```' + FENCE_TAG + '\n' + JSON.stringify({ claims: [{ kind, amount_yuan: 1 }] }) + '\n```';
  const res = parsePasteBack(block, LABOR);
  expect(res.ok, `解析整体失败：${JSON.stringify(res)}`).toBe(true);
  if (!res.ok) throw new Error('unreachable');
  return res.items[0];
}

describe('回填约定里 claims 的种类清单', () => {
  it('说明书报的是诉求登记的值集，不是算钱器那份（变异：改回 pack.calculatorKinds → 红）', () => {
    expect(section()).toContain(`\`kind\` 只能是 ${LABOR.claimKinds.join(' / ')}`);
    expect(section()).not.toContain(LABOR.calculatorKinds.join(' / '));
  });

  it('说明书里列的每一个种类，解析器都收（说明书比服务端窄或宽都是分叉）', () => {
    for (const kind of LABOR.claimKinds) {
      expect(parseClaim(kind).error, `说明书宣告了「${kind}」，解析器却拒收`).toBeNull();
    }
  });

  it('说明书自己那个示例（欠薪）也收得下（变异：把校验换成 calculatorKinds → 红）', () => {
    expect(section()).toContain('"kind": "欠薪"');
    expect(parseClaim('欠薪').error).toBeNull();
  });

  it('不在清单里的种类照旧 INVALID_KIND，且错误信息报的是同一份清单', () => {
    const item = parseClaim('不存在的种类');
    expect(item.error?.code).toBe('INVALID_KIND');
    expect(item.error?.message).toBe(`kind 只能是 ${LABOR.claimKinds.join(' / ')}`);
  });
});
