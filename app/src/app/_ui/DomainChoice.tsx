'use client';

/**
 * 「这件事属于哪一类纠纷」——建案前的领域选择（设计稿 §13 落法 5、§16 分期 W4）。
 *
 * ───────────────── ⚠️ 本文件是共用层 ⚠️ ─────────────────
 * 一个具体领域的名字都不许写死：选项文字逐字来自领域包的 `label`，
 * 由服务端的 /api/v1/domains 按灰度开关给出。由 app/__tests__/page-domain-guard.test.ts 机检。
 * ─────────────────────────────────────────────────────
 *
 * 【只有一个领域时整块不渲染，不是渲染成禁用态】灰度只开着一个领域时，
 * 这个问题**没有第二个答案**：摆一个只有一项的单选，是让每个注册的人先替一个
 * 不存在的选择停一次。所以 `domains.length <= 1` 直接回 null——
 * 页面 HTML 与没有这个控件时逐字节一致（judged by domain-choice.test.tsx）。
 *
 * 【取不到清单也回 null】/api/v1/domains 挂了或还没回来时，清单是空的，
 * 控件不出现，建案落缺省领域（服务端的 ensureDefaultCase 省略 domain 即缺省）。
 * 这是**有意的降级**：一个空的或半截的选择控件会让人以为自己选过了。
 */

import { useEffect, useState } from 'react';

import { apiFetch } from './api';
import { cn } from './cn';
import { RadioGroup, RadioGroupItem } from '@/components/shadcn/radio-group';

/** 一个可选领域。key 落进 cases.domain，label 是给人看的名字。 */
export interface DomainOption {
  key: string;
  label: string;
}

interface DomainsResponse {
  domains: DomainOption[];
}

/**
 * 当前环境开着哪几个领域。**挂载后现问一次**，首帧恒为空清单。
 *
 * 【为什么不能在服务端组件里算】灰度开关只在服务端读得到，但 /login 是静态预渲染页：
 * 在那里调 enabledDomainKeys() 会把开关**烙进构建产物**，改完开关重启也不生效，
 * 而页面上一个报错都不会有——运维只会看见「开关没生效」，去反复改变量名。
 * 所以走一条 force-dynamic 的端点现问（见 app/api/v1/domains/route.ts）。
 *
 * 【失败静默】问不到就是空清单 → 控件不出现 → 落缺省领域。这一条与页面别处
 * 「查不到不等于没有」的口径不同，是因为这里**没有可损失的东西**：
 * 用户还没有案件，缺省领域正是他不选时会得到的那个。
 */
export function useEnabledDomains(): DomainOption[] {
  const [domains, setDomains] = useState<DomainOption[]>([]);
  useEffect(() => {
    let alive = true;
    void apiFetch<DomainsResponse>('/domains', { auth: false })
      .then((res) => {
        if (alive && Array.isArray(res.domains)) setDomains(res.domains);
      })
      .catch(() => {
        // 见上：问不到就不摆控件，建案落缺省领域
      });
    return () => {
      alive = false;
    };
  }, []);
  return domains;
}

/**
 * 领域单选。`value` 为空串＝还没选，提交时不带这个字段。
 *
 * 【不选时落的是**缺省领域**，与这份清单的顺序无关】清单的顺序确实是开关里写的顺序，
 * 但服务端不选时取的是 registry.DEFAULT_DOMAIN（见 cases.ensureDefaultCase 的
 * `domain ?? DEFAULT_DOMAIN`），不是清单的第一项。把这两件事说成一件的形态是：
 * 运维调换 `LAWER_DOMAINS_ENABLED` 里的顺序想改缺省，改完一点变化都没有，而没有报错。
 *
 * @param domains 可选领域，顺序即开关里写的顺序
 */
export function DomainChoice({
  domains,
  value,
  onChange,
  className,
}: {
  domains: readonly DomainOption[];
  value: string;
  onChange: (next: string) => void;
  className?: string;
}) {
  if (domains.length <= 1) return null;
  return (
    <div className={cn('flex flex-col gap-2.5', className)}>
      <p className="text-[15px] leading-7 font-medium text-ink">这件事属于哪一类</p>
      <RadioGroup
        aria-label="这件事属于哪一类"
        value={value}
        onValueChange={onChange}
        className="flex-nowrap"
      >
        {domains.map((d) => (
          <RadioGroupItem key={d.key} value={d.key} className="flex-1">
            {d.label}
          </RadioGroupItem>
        ))}
      </RadioGroup>
      {/* 选错了不是死局，但也不是「随便选」：档案建好之后换类目要重新建档 */}
      <p className="text-[13px] leading-5 text-ink-2">
        选的这一类决定后面问你什么、按哪套期限和文书办事。建好档之后要换，得重新建一份。
      </p>
    </div>
  );
}
