'use client';

import { useCallback, useRef, useState, type DragEvent } from 'react';
import { EVIDENCE_CATEGORIES } from '@/app/_mock/intake-evidence';
import type { EvidenceCategory } from '@/app/_mock/types';
import { formatBytes } from '@/app/_ui/format';
import { Button } from '@/components/shadcn/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/shadcn/dialog';
import { Select } from '@/components/shadcn/select';
import { Textarea } from '@/components/shadcn/textarea';

/**
 * 拖拽入库（设计 §四「拖拽」）。桌面独有：手机上没有「从别的窗口拖过来」这件事。
 *
 * 三条硬要求逐条落地：
 * 1. **遮罩不糊内容**——只压一层半透明主色和一圈虚线（.drop-veil），底下拖到哪儿还看得清；
 * 2. **多文件弹一张批量归类表**，不弹 N 次 Sheet；
 * 3. **必须留键盘路径**——遮罩里明说「也可以用上面的选文件按钮」，那三个按钮本来就在。
 */

/**
 * `dragleave` 的必踩坑：鼠标从容器移到**容器内部的子元素**上时，浏览器照样发一次
 * dragleave（目标是被离开的那个子元素）。只看事件不计数的话，遮罩会在拖动过程中疯狂闪。
 * 计数器只在 enter/leave 配平回 0 时才收遮罩，这是唯一稳的写法。
 */
export function useFileDrop(onFiles: (files: File[]) => void) {
  const depth = useRef(0);
  const [dragging, setDragging] = useState(false);

  /** 只认真的文件拖拽：从页面里拖一段选中的文字过来不该亮遮罩 */
  const carriesFiles = (e: DragEvent) =>
    Array.from(e.dataTransfer?.types ?? []).includes('Files');

  const onDragEnter = useCallback((e: DragEvent) => {
    if (!carriesFiles(e)) return;
    e.preventDefault();
    depth.current += 1;
    setDragging(true);
  }, []);

  const onDragOver = useCallback((e: DragEvent) => {
    if (!carriesFiles(e)) return;
    // 不 preventDefault 的话浏览器会把文件当导航处理，当场跳走、页面上的东西全没
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  }, []);

  const onDragLeave = useCallback((e: DragEvent) => {
    if (!carriesFiles(e)) return;
    depth.current = Math.max(0, depth.current - 1);
    if (depth.current === 0) setDragging(false);
  }, []);

  const onDrop = useCallback(
    (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      e.preventDefault();
      depth.current = 0;
      setDragging(false);
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length > 0) onFiles(files);
    },
    [onFiles],
  );

  return {
    dragging,
    handlers: { onDragEnter, onDragOver, onDragLeave, onDrop },
  };
}

/** 拖拽中的遮罩。`pointer-events: none`（在 .drop-veil 里），不挡下面的 drop 事件。 */
export function DropVeil({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <div className="drop-veil" aria-hidden>
      <p className="rounded-[10px] bg-surface px-4 py-2.5 fs-m font-medium text-primary-ink shadow-soft">
        松手就存进证据库 · 也可以用上面的「选文件」
      </p>
    </div>
  );
}

export interface BatchAssignment {
  file: File;
  category: EvidenceCategory;
}

/**
 * 批量归类表里每一行的键。
 * **必须带下标**：同一次拖拽里出现两个同名同大小的文件是常事（从两个文件夹各拖一份
 * 「截图.png」），只用 name+size 当键会让它们共用一行的选择，改一个另一个跟着变，
 * 而表面上完全看不出来。
 */
export function batchKey(file: { name: string; size: number }, index: number): string {
  return `${index}:${file.name}:${file.size}`;
}

/** 逐行落定类别：给了例外用例外，没给用「全部归入」那个。 */
export function assignCategories<F extends { name: string; size: number }>(
  files: readonly F[],
  bulk: EvidenceCategory,
  overrides: Readonly<Record<string, EvidenceCategory>>,
): { file: F; category: EvidenceCategory }[] {
  return files.map((file, i) => ({
    file,
    category: overrides[batchKey(file, i)] ?? bulk,
  }));
}

/**
 * 批量归类表：一次定一个类别给全部，再逐行改例外。
 * 证明目的**留空是合法的**——一次拖进来八个文件，逼人当场写八段说明只会让人放弃，
 * 详情页里补得上。
 */
export function BatchCategorizeDialog({
  files,
  onCancel,
  onConfirm,
}: {
  files: File[];
  onCancel: () => void;
  onConfirm: (items: BatchAssignment[], provePurpose: string) => void;
}) {
  const [bulk, setBulk] = useState<EvidenceCategory>(EVIDENCE_CATEGORIES[0]);
  const [each, setEach] = useState<Record<string, EvidenceCategory>>({});
  const [purpose, setPurpose] = useState('');

  const open = files.length > 0;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent className="max-w-[600px]">
        <DialogTitle>把这 {files.length} 份材料归个类</DialogTitle>
        <p className="fs-s text-ink-2">
          先给全部选一个类别，个别不一样的在下面单独改。证明目的可以留到详情页再补。
        </p>

        <div className="mt-3 flex items-center gap-2">
          <span className="fs-s text-ink">全部归入</span>
          {/* Select 自己外面还有一层 relative 包装（见 shadcn/select.tsx），
              宽度要给那一层，光给内层 select 会在 flex 里被拉满 */}
          <span className="w-40 shrink-0">
            <Select
              aria-label="全部归入的类别"
              value={bulk}
              onChange={(e) => {
                setBulk(e.target.value as EvidenceCategory);
                // 统一改类别时把逐行的例外清掉——否则「全部归入」名不副实
                setEach({});
              }}
            >
              {EVIDENCE_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          </span>
        </div>

        <ul className="mt-3 max-h-[38vh] overflow-y-auto">
          {files.map((f, i) => {
            const k = batchKey(f, i);
            return (
              <li
                key={k}
                data-veil=""
                className="flex items-center gap-3 border-b border-line py-2 last:border-b-0"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate fs-s text-ink">{f.name}</span>
                  <span className="num fs-xs text-ink-2">{formatBytes(f.size)}</span>
                </span>
                <span className="w-32 shrink-0">
                  <Select
                    aria-label={`${f.name} 的类别`}
                    value={each[k] ?? bulk}
                    onChange={(e) =>
                      setEach((prev) => ({ ...prev, [k]: e.target.value as EvidenceCategory }))
                    }
                  >
                    {EVIDENCE_CATEGORIES.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </Select>
                </span>
              </li>
            );
          })}
        </ul>

        <div className="mt-3">
          <label htmlFor="batch-purpose" className="mb-1 block fs-s text-ink">
            证明目的（可留空，全部共用）
          </label>
          <Textarea
            id="batch-purpose"
            rows={2}
            value={purpose}
            onChange={(e) => setPurpose(e.target.value)}
          />
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel}>
            取消
          </Button>
          <Button onClick={() => onConfirm(assignCategories(files, bulk, each), purpose)}>
            存进证据库
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
