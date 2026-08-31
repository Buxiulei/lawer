/**
 * 拖拽入库的两处纯逻辑：批量行的键、逐行落定类别。
 * dragenter/leave 的计数、遮罩显隐是 DOM 事件层，不在这里（无 jsdom）；
 * 这两个函数才是「归类归得对不对」的判据。
 */
import { describe, expect, it } from 'vitest';
import type { EvidenceCategory } from '@/app/_mock/types';
import { assignCategories, batchKey } from '../DropPanel';

describe('batchKey：批量归类表的行键', () => {
  it('带下标——同名同大小的两个文件不共用一行的选择', () => {
    const a = { name: '截图.png', size: 1024 };
    const b = { name: '截图.png', size: 1024 };
    expect(batchKey(a, 0)).not.toBe(batchKey(b, 1));
  });
  it('同一份文件同一下标键稳定', () => {
    const f = { name: 'x.pdf', size: 99 };
    expect(batchKey(f, 3)).toBe(batchKey(f, 3));
  });
});

describe('assignCategories：逐行落定类别', () => {
  const files = [
    { name: 'a.pdf', size: 1 },
    { name: 'b.pdf', size: 2 },
    { name: 'c.pdf', size: 3 },
  ];
  const bulk = '公司文件' as EvidenceCategory;

  it('没有例外时全部归入 bulk', () => {
    const out = assignCategories(files, bulk, {});
    expect(out.map((x) => x.category)).toEqual([bulk, bulk, bulk]);
    expect(out.map((x) => x.file.name)).toEqual(['a.pdf', 'b.pdf', 'c.pdf']);
  });

  it('给了例外的那一行用例外，其余仍是 bulk', () => {
    const only = '录音' as EvidenceCategory;
    const overrides = { [batchKey(files[1], 1)]: only };
    const out = assignCategories(files, bulk, overrides);
    expect(out.map((x) => x.category)).toEqual([bulk, only, bulk]);
  });

  it('例外的键必须带对下标才生效（否则串行——这正是 batchKey 带下标的理由）', () => {
    // 用 index 0 的键去覆盖，但 files[1] 与 files[0] 同名同大小时也不会误伤 files[1]
    const twins = [
      { name: '同.png', size: 5 },
      { name: '同.png', size: 5 },
    ];
    const overrides = { [batchKey(twins[0], 0)]: '录音' as EvidenceCategory };
    const out = assignCategories(twins, bulk, overrides);
    expect(out.map((x) => x.category)).toEqual(['录音', bulk]);
  });
});
