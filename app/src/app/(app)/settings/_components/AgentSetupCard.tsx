'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useDiscreet } from '@/app/_ui/discreet';
import { Button } from '@/components/shadcn/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/shadcn/card';
import { Skeleton } from '@/components/shadcn/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/shadcn/tabs';
import { SETUP_TABS } from './agentSetup';
import { SetupPrompt } from './SetupPrompt';
import { useAgentSetup } from './useAgentSetup';

/**
 * 一键接入：把这份档案库接到用户自己的 AI 助手上（spec D4）。
 *
 * 地址与工具清单全部来自 GET /api/v1/agent-setup，页面不硬编码——
 * 接口是自描述的正本，这里抄一份必然在改地址那天忘了同步。
 *
 * 【低调模式】话术里逐字带着「土八鼠 / 劳动仲裁」，整卡打码不现实（那是一整段要复制的文本），
 * 所以改成折叠：标题换成中性的「接入配置」，正文点开才渲染，任何提示也不带案件字样。
 */
export function AgentSetupCard() {
  const { discreet } = useDiscreet();
  const { info, loading, error, unauthorized } = useAgentSetup();
  const [expanded, setExpanded] = useState(false);

  const collapsed = discreet && !expanded;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{discreet ? '接入配置' : '接到你自己的 AI 助手上'}</CardTitle>
      </CardHeader>
      <CardContent>
        {collapsed ? (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="flex min-h-11 w-full items-center text-[15px] text-ink-2 hover:text-ink"
          >
            接入配置（点开查看）
          </button>
        ) : (
          <>
            <p className="text-[14px] leading-6 text-ink-2">
              把下面这段话整段发给你的 AI 助手，它就能直接读写这里的档案：传证据、跑解读、起草文书都在你自己的对话里完成。
              支持 MCP 的走 MCP，不支持的走 REST，两条路能力一样。网页端功能一样齐全，不接也不影响。
            </p>

            {/*
              省钱引导。**措辞的边界**：只说「MCP 这几个工具不扣公道值」，
              这是可核对的事实——`lib/mcp/tools.ts` 里七个工具全是读写案件数据，
              没有一个在我们这边调模型。**不写「接了就免费」**：网页对话照旧扣费，
              把话说满会在用户第一次看见扣费时变成谎话。
            */}
            <div className="mt-3 rounded-[8px] border-l-4 border-success bg-success-wash px-3 py-2.5">
              <p className="text-[14px] leading-6 font-semibold text-success-ink">
                用你自己的助手干活，能省下公道值
              </p>
              <p className="mt-0.5 text-[13.5px] leading-6 text-success-ink">
                接上之后，读档案、记时间线、管待办和期限、列证据这些，都是
                <span className="font-semibold">你的助手在想</span>
                ——烧的是它那边的额度，不扣公道值。
                公道值只在我们这边真的替你调模型时才扣（比如网页里的这个对话）。
              </p>
            </div>

            {loading && <Skeleton className="mt-3 h-40 w-full" />}

            {unauthorized && !loading && <LoggedOutTabs />}

            {error && !loading && !unauthorized && (
              <p className="mt-3 text-[14px] leading-6 text-ink-2">
                接入信息这次没取到（{error}），稍后回来再看。
              </p>
            )}

            {info && (
              <>
                <dl className="mt-3 border-t border-line pt-3 text-[14px] leading-6">
                  <Row label="MCP 地址" value={info.mcp_url} mono />
                  <Row label="REST 基址" value={info.api_base} mono />
                  <Row label="能力清单" value={info.manifest_url} mono />
                  <Row
                    label="可用工具"
                    value={info.tools.map((t) => t.name).join(' · ') || '（接口未返回工具清单）'}
                    mono
                  />
                </dl>

                <div className="mt-4">
                  <SetupPrompt info={info} />
                </div>
              </>
            )}

            {discreet && (
              <div className="mt-4 border-t border-line pt-3">
                <Button size="sm" variant="secondary" onClick={() => setExpanded(false)}>
                  收起
                </Button>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * 未登录时的禁用态：Tab 结构照常摆着，让人看得出接入卡长什么样、有哪几种客户端，
 * 只是内容取不到。比一句「没取到」更能说明"差的是登录，不是这功能坏了"。
 */
function LoggedOutTabs() {
  return (
    <div className="mt-3">
      <Tabs value={SETUP_TABS[0].key}>
        <TabsList aria-label="接入话术（登录后可见）">
          {SETUP_TABS.map((item) => (
            <TabsTrigger key={item.key} value={item.key} disabled className="opacity-45">
              {item.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <div className="mt-3 rounded-[10px] border border-dashed border-line p-4">
        <Skeleton className="h-4 w-3/5" />
        <Skeleton className="mt-2 h-4 w-full" />
        <Skeleton className="mt-2 h-4 w-2/5" />
        <p className="mt-3 text-[14px] leading-6 text-ink-2">登录后可见接入信息</p>
        <Button asChild size="sm" variant="secondary" className="mt-2">
          <Link href="/login">去登录</Link>
        </Button>
      </div>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex gap-3 py-1">
      <dt className="w-20 shrink-0 text-ink-2">{label}</dt>
      <dd className={mono ? 'num min-w-0 font-mono text-[13px] break-all text-ink' : 'min-w-0 text-ink'}>
        {value}
      </dd>
    </div>
  );
}
