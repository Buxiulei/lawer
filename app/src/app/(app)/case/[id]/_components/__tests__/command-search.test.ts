/**
 * 命令面板的两处纯逻辑：子串过滤与上下键绕圈。
 * 快捷键注册走 `_ui/hotkeys.ts`（不自挂监听），那条由 hotkeys 的结构守卫盯着，
 * 这里不重复。
 */
import { describe, expect, it } from 'vitest';
import { filterEntries, nextIndex } from '../CommandSearch';

const entries = [
  { id: '1', label: '证据库', hint: '栏目', href: '/a' },
  { id: '2', label: '劳动仲裁申请书', hint: '文书 · 仲裁申请书', href: '/b' },
  { id: '3', label: '工资流水.pdf', hint: '证据 · 银行流水', href: '/c' },
];

describe('filterEntries：子串匹配（不做模糊匹配）', () => {
  it('空查询回全部（拷贝，不是原数组）', () => {
    const out = filterEntries(entries, '  ');
    expect(out).toHaveLength(3);
    expect(out).not.toBe(entries);
  });
  it('命中 label', () => {
    expect(filterEntries(entries, '仲裁').map((e) => e.id)).toEqual(['2']);
  });
  it('也命中 hint（按类别找）', () => {
    expect(filterEntries(entries, '流水').map((e) => e.id)).toEqual(['3']);
  });
  it('大小写无关', () => {
    expect(filterEntries(entries, 'PDF').map((e) => e.id)).toEqual(['3']);
  });
  it('无匹配回空', () => {
    expect(filterEntries(entries, '不存在的东西')).toEqual([]);
  });
});

describe('nextIndex：上下键在 [0,n) 绕圈', () => {
  it('向下走到末尾回到 0', () => {
    expect(nextIndex(2, 3, 1)).toBe(0);
  });
  it('向上从 0 绕到末尾', () => {
    expect(nextIndex(0, 3, -1)).toBe(2);
  });
  it('中间正常走', () => {
    expect(nextIndex(0, 3, 1)).toBe(1);
  });
  it('n 为 0 时恒回 0，不算出 NaN 当索引', () => {
    expect(nextIndex(0, 0, 1)).toBe(0);
    expect(nextIndex(5, 0, -1)).toBe(0);
  });
});
