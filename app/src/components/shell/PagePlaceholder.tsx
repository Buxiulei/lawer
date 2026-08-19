import { EmptyState } from '@/components/ui/EmptyState';

/**
 * 骨架期占位：页面本体由各自负责的窗口实现。
 * 保留页名，让导航连通性可验证。
 */
export function PagePlaceholder({
  pageName,
  description,
}: {
  pageName: string;
  description: string;
}) {
  return (
    <div className="pt-4">
      <h2 className="mb-3 text-[20px] font-semibold text-ink">{pageName}</h2>
      <EmptyState title="页面建设中" description={description} />
    </div>
  );
}
