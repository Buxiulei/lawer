import { EVIDENCE_CHECKLIST } from '@/app/_mock/intake-evidence';
import { Badge } from '@/components/shadcn/badge';
import { Card } from '@/components/shadcn/card';

const LEAD = '权限被收走之后很多材料就取不到了。按下面这几项对一遍，有哪份传哪份，不用一次传全。';

/**
 * 常见证据清单。每项写清「为什么重要」——用户不知道该传什么，
 * 光说"暂无证据"等于没说。库里已经有东西时收起来，让列表本身占主位。
 */
export function EvidenceChecklist({ collapsible = false }: { collapsible?: boolean }) {
  if (!collapsible) {
    return (
      <section>
        <h3 className="text-[16px] font-semibold text-ink">这些先传，越早越好</h3>
        <p className="prose-measure mt-1 text-[15px] leading-7 text-ink-2">{LEAD}</p>
        <List />
      </section>
    );
  }

  return (
    <details className="rounded-[12px] border border-line bg-surface">
      <summary className="flex min-h-12 cursor-pointer list-none items-center px-3.5 text-[15px] font-medium text-primary-ink">
        对一遍常见证据清单，看还差什么
      </summary>
      <div className="px-3.5 pb-3.5">
        <p className="prose-measure text-[14px] leading-6 text-ink-2">{LEAD}</p>
        <List />
      </div>
    </details>
  );
}

function List() {
  return (
    <ul className="mt-3 flex flex-col gap-2.5">
      {EVIDENCE_CHECKLIST.map((c) => (
        <li key={c.name}>
          <Card className="p-3.5">
            <div className="flex flex-wrap items-center gap-2">
              <Badge>{c.category}</Badge>
              <span className="text-[15px] leading-7 font-semibold text-ink">{c.name}</span>
            </div>
            <p className="mt-1 text-[14px] leading-6 text-ink-2">{c.why}</p>
          </Card>
        </li>
      ))}
    </ul>
  );
}
