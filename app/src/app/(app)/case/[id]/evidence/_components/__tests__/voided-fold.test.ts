/**
 * 证据库的「已作废」折叠区，两条承重线：
 *
 * ① 列表接口要带 include_voided=1。后端默认不回作废条目——不带这个参数的话，
 *    折叠区**永远是空的**，而它看起来只是"这个案子没作废过材料"。这两件事在页面上同形。
 * ② 页面按 voidedAt 分区，主列表与「共 N 份」都只数没作废的那些；作废的收进折叠区、
 *    带着当初的理由。混在主列表里的话，"共 N 份"就把用户自己已经排除掉的材料算了进去。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchEvidenceList } from '../../_data';

const SRC = readFileSync(
  join(process.cwd(), 'src/app/(app)/case/[id]/evidence/_components/EvidenceLibrary.tsx'),
  'utf8',
);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('列表接口带 include_voided', () => {
  it('请求 URL 上有 include_voided=1，且 voided_at / void_reason 映射进视图', async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(String(url));
        return new Response(
          JSON.stringify({
            ok: true,
            evidence: [
              { id: 1, case_id: 2, name: '留着的.jpg', category: '公司文件', prove_purpose: null, status: '已上传', created_at: '2026-09-06T09:00:00+08:00' },
              { id: 2, case_id: 2, name: '重复的.jpg', category: '公司文件', prove_purpose: null, status: '已作废', created_at: '2026-09-06T09:00:00+08:00', voided_at: '2026-09-06T10:00:00+08:00', void_reason: '与条目 1 重复' },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );

    const list = await fetchEvidenceList('2');
    expect(urls[0]).toContain('include_voided=1');
    expect(list[0].voidedAt).toBeNull();
    expect(list[1].voidedAt).toBe('2026-09-06T10:00:00+08:00');
    expect(list[1].voidReason).toBe('与条目 1 重复');
  });
});

describe('页面按 voidedAt 分区', () => {
  it('主列表与份数统计只数没作废的那些', () => {
    expect(SRC).toContain("items.filter((i) => i.voidedAt === null)");
    expect(SRC).toContain("items.filter((i) => i.voidedAt !== null)");
    // 「共 N 份 / 已固化 / 已出证」三个数都从 active 来，不从 items 来
    expect(SRC).toContain('共 {active.length} 份');
    expect(SRC).toContain("const frozen = active.filter");
    expect(SRC).toContain("const issued = active.filter");
    expect(SRC).toContain('rows={active}');
  });

  it('折叠区存在、带条数与作废理由，且明说不计入份数', () => {
    expect(SRC).toContain('<details');
    expect(SRC).toContain('已作废 <span className="num">{voided.length}</span>');
    expect(SRC).toContain('不计入上面的份数');
    expect(SRC).toContain('作废理由：{item.voidReason');
  });
});
