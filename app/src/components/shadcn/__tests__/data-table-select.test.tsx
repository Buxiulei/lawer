/**
 * DataTable 的多选 prop（批B，桌面独占）判据。
 *
 * 两条，第二条是移动端零回归的机器证据：
 *  1. **表格面孔**：给了 selected + onSelectedChange 才长出勾选列（否则没有）。
 *  2. **卡片面孔（<sm，手机那一面）一字不变**：把同一批数据用 faces="cards" 渲染两遍，
 *     一遍带 selection prop、一遍不带，两段 HTML **必须逐字节相同**。
 *     谁要是往卡片面孔里塞了勾选框，这条当场红——这就是「手机卡片面孔一字不变」的守卫。
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/app/_ui/discreet', () => ({
  useDiscreet: () => ({ discreet: false, toggle: () => {} }),
}));

import { DataTable, type DataTableColumn } from '../data-table';

interface Row {
  id: string;
  name: string;
}
const rows: Row[] = [
  { id: 'r1', name: '甲' },
  { id: 'r2', name: '乙' },
];
const columns: DataTableColumn<Row>[] = [
  { key: 'name', header: '名称', card: 'title', cell: (r) => r.name },
];
const noop = () => {};

describe('表格面孔：勾选列跟着 prop 走', () => {
  it('不给 selection → 没有全选框', () => {
    const html = renderToStaticMarkup(
      <DataTable faces="table" columns={columns} rows={rows} rowKey={(r) => r.id} />,
    );
    expect(html).not.toContain('全选本页');
    expect(html).not.toContain('取消全选');
  });

  it('给了 selected + onSelectedChange → 长出全选框与每行的勾选框', () => {
    const html = renderToStaticMarkup(
      <DataTable
        faces="table"
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        rowLabel={(r) => r.name}
        selected={new Set<string>()}
        onSelectedChange={noop}
      />,
    );
    expect(html).toContain('全选本页');
    expect(html).toContain('选择 甲');
    expect(html).toContain('选择 乙');
  });
});

describe('卡片面孔：手机那一面一字不变（移动端零回归守卫）', () => {
  it('带 selection prop 与不带，faces="cards" 输出逐字节相同', () => {
    const withSel = renderToStaticMarkup(
      <DataTable
        faces="cards"
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        selected={new Set<string>(['r1'])}
        onSelectedChange={noop}
      />,
    );
    const without = renderToStaticMarkup(
      <DataTable faces="cards" columns={columns} rows={rows} rowKey={(r) => r.id} />,
    );
    expect(withSel).toBe(without);
    // 且卡片面孔里根本没有勾选框
    expect(withSel).not.toContain('选择 甲');
  });
});
