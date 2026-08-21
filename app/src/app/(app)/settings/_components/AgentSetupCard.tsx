'use client';

import { useState } from 'react';
import { useDiscreet } from '@/app/_ui/discreet';
import { Button } from '@/components/shadcn/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/shadcn/card';
import { Skeleton } from '@/components/ui/Skeleton';
import { SetupPrompt } from './SetupPrompt';
import { useAgentSetup } from './useAgentSetup';

/**
 * 一键接入：把这份档案库接到用户自己的 AI 助手上（spec D4）。
 *
 * 地址与工具清单全部来自 GET /api/v1/agent-setup，页面不硬编码——
 * 接口是自描述的正本，这里抄一份必然在改地址那天忘了同步。
 *
 * 【低调模式】话术里逐字带着「裁员应对专员 / 劳动仲裁」，整卡打码不现实（那是一整段要复制的文本），
 * 所以改成折叠：标题换成中性的「接入配置」，正文点开才渲染，任何提示也不带案件字样。
 */
export function AgentSetupCard() {
  const { discreet } = useDiscreet();
  const { info, loading, error } = useAgentSetup();
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

            {loading && <Skeleton className="mt-3 h-40 w-full" />}

            {error && !loading && (
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
