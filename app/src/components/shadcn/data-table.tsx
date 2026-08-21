'use client';

import type { ReactNode } from 'react';
import { useDiscreet } from '@/app/_ui/discreet';
import { Sensitive } from '@/components/Sensitive';
import { cn } from './utils';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from './table';

/**
 * 列表的两副面孔：≥sm 是数据表格（布局手感照 TailAdmin），<sm 降级成卡片列表。
 *
 * 为什么不给窄屏留横向滚动：390 宽下六列表格必然溢出，而横向拖动会把
 * 「这一行是什么」拖出视野——移动端的正解是每行自己占一张卡。
 * 两副面孔共用同一份 columns：每列用 `card` 说明自己在卡片里落到哪个位置，
 * 免得将来加一列时表格加了、卡片忘了。
 *
 * 低调模式：列上标 `sensitive` 即可。行可点时打码但不给点按解码
 * （点按要留给「打开详情」），去详情里看；行不可点时包 <Sensitive>，点按临时显示 3 秒。
 */
export interface DataTableColumn<T> {
  key: string;
  /** 表头文字；窄屏卡片里 meta 位会拿它当前缀 */
  header: string;
  cell: (row: T) => ReactNode;
  /** 数字/时间列右对齐并走等宽数字 */
  numeric?: boolean;
  /**
   * 这一列在窄屏卡片里的位置：
   * title 主标题行、badge 与主标题同排的右侧徽标、meta 副行（带表头前缀）、
   * footnote 末行小字（多列以 · 相连）、hide 窄屏不显示。
   */
  card?: 'title' | 'badge' | 'meta' | 'footnote' | 'hide';
  /** 低调模式下这一列要打码 */
  sensitive?: boolean;
  /** 表格里这一列的额外样式（宽度、截断等） */
  className?: string;
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  rowLabel,
  caption,
  faces = 'both',
  className,
}: {
  columns: DataTableColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  /** 行可点：表格里首列文字变成按钮（整行都是它的热区），卡片整张是按钮 */
  onRowClick?: (row: T) => void;
  /**
   * 行按钮的无障碍名字。不给的话按钮就用自己包着的那段文字当名字——
   * 首列文字本身已经说清是哪一行时，这样比硬造一句 aria-label 更贴。
   */
  rowLabel?: (row: T) => string;
  /** 表格说明，读屏用户用它知道这张表是什么 */
  caption?: string;
  /**
   * 只出一副面孔。用在两副面孔的**分组方式不一样**的场合：
   * 证据库 ≥sm 是一张平表（类别是其中一列），<sm 仍按类别分节，
   * 于是表格那半用 'table'、每个分节各用一次 'cards'。
   * 断点该藏该显不受影响，两个取值各自还带着自己那条 sm 断点。
   */
  faces?: 'both' | 'table' | 'cards';
  className?: string;
}) {
  const { discreet } = useDiscreet();

  const cellContent = (col: DataTableColumn<T>, row: T): ReactNode => {
    const content = col.cell(row);
    if (!col.sensitive || !discreet) return content;
    // 行可点时点按要留给「打开详情」，这里只打码不接管点击
    if (onRowClick) return <span className="discreet-blur">{content}</span>;
    return <Sensitive>{content}</Sensitive>;
  };

  return (
    <>
      {/* ≥sm：表格 */}
      {faces !== 'cards' && (
      <div className={cn('hidden sm:block', className)}>
        <div className="overflow-hidden rounded-[12px] border border-border bg-card shadow-soft">
          <Table>
            {caption && <caption className="sr-only">{caption}</caption>}
            <TableHeader className="bg-muted/60">
              <TableRow>
                {columns.map((col) => (
                  <TableHead
                    key={col.key}
                    className={cn(col.numeric && 'text-right', col.className)}
                  >
                    {col.header}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow
                  key={rowKey(row)}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  className={cn(onRowClick && 'cursor-pointer hover:bg-muted')}
                >
                  {columns.map((col, i) => (
                    <TableCell
                      key={col.key}
                      className={cn(
                        col.numeric && 'num text-right whitespace-nowrap',
                        col.className,
                      )}
                    >
                      {/* 首列包一层 button：整行的点击交给 tr（button 的点击会冒上去），
                          button 本身只负责当键盘停靠点和读屏能念出的那个名字 */}
                      {i === 0 && onRowClick ? (
                        <button
                          type="button"
                          aria-label={rowLabel?.(row)}
                          className="rounded-[6px] text-left"
                        >
                          {cellContent(col, row)}
                        </button>
                      ) : (
                        cellContent(col, row)
                      )}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>
      )}

      {/* <sm：卡片列表 */}
      {faces !== 'table' && (
      <ul className={cn('flex flex-col gap-2 sm:hidden', className)}>
        {rows.map((row) => {
          const inner = <CardFace columns={columns} row={row} cellContent={cellContent} />;
          return (
            <li key={rowKey(row)}>
              {onRowClick ? (
                <button
                  type="button"
                  onClick={() => onRowClick(row)}
                  aria-label={rowLabel?.(row)}
                  className="w-full rounded-[12px] border border-border bg-card p-3.5 text-left transition-colors duration-150 ease-out hover:bg-muted"
                >
                  {inner}
                </button>
              ) : (
                <div className="rounded-[12px] border border-border bg-card p-3.5">
                  {inner}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      )}
    </>
  );
}

function CardFace<T>({
  columns,
  row,
  cellContent,
}: {
  columns: DataTableColumn<T>[];
  row: T;
  cellContent: (col: DataTableColumn<T>, row: T) => ReactNode;
}) {
  const pick = (role: DataTableColumn<T>['card']) =>
    columns.filter((c) => (c.card ?? 'meta') === role);

  // 脚注以 · 相连，空的那几列先剔掉，免得连出「 · 2026-01-01」这种开头
  const footnotes = pick('footnote')
    .map((col) => ({ col, node: cellContent(col, row) }))
    .filter(({ node }) => node !== null && node !== undefined && node !== '');

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-start justify-between gap-3">
        <span className="min-w-0 flex-1 text-[15px] leading-7 font-medium text-foreground">
          {pick('title').map((col) => (
            <span key={col.key} className="block">
              {cellContent(col, row)}
            </span>
          ))}
        </span>
        {pick('badge').length > 0 && (
          <span className="flex shrink-0 flex-wrap items-center gap-1.5">
            {pick('badge').map((col) => (
              <span key={col.key}>{cellContent(col, row)}</span>
            ))}
          </span>
        )}
      </div>

      {pick('meta')
        .map((col) => ({ col, node: cellContent(col, row) }))
        .filter(({ node }) => node !== null && node !== undefined && node !== '')
        .map(({ col, node }) => (
          <span key={col.key} className="text-[14px] leading-6 text-muted-foreground">
            {node}
          </span>
        ))}

      {footnotes.length > 0 && (
        <span className="num text-[13px] text-muted-foreground">
          {footnotes.map(({ col, node }, i) => (
            <span key={col.key}>
              {i > 0 && ' · '}
              {node}
            </span>
          ))}
        </span>
      )}
    </div>
  );
}
