'use client';

import {
  MCP_CLIENT_CONFIG,
  MCP_CURL,
  MCP_ENDPOINT,
  MCP_TOOLS,
} from '@/app/_mock/authpay';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { useToast } from '@/components/ui/Toast';
import { CodeBlock } from './CodeBlock';

/**
 * MCP 接入指引：只读说明，配置本身不在这页改（spec D4）。
 */
export function McpCard() {
  const toast = useToast();

  return (
    <Card>
      <CardHeader title="用自己的 agent 接进来（MCP）" />
      <CardBody>
        <p className="text-[14px] leading-6 text-ink-2">
          把你自己的 Claude 挂上来，它就能直接读写这里的案件档案：传证据、跑解读、起草文书都在你自己的对话里完成。
          网页端功能一样齐全，没有 MCP 也不影响。
        </p>

        <dl className="mt-3 border-t border-line pt-3 text-[14px] leading-6">
          <div className="flex gap-3 py-1">
            <dt className="w-20 shrink-0 text-ink-2">接入地址</dt>
            <dd className="num min-w-0 font-mono break-all text-ink">{MCP_ENDPOINT}</dd>
          </div>
          <div className="flex gap-3 py-1">
            <dt className="w-20 shrink-0 text-ink-2">鉴权</dt>
            <dd className="min-w-0 text-ink">
              上面新建的 API key，放在 <span className="font-mono">Authorization: Bearer</span> 头里
            </dd>
          </div>
          <div className="flex gap-3 py-1">
            <dt className="w-20 shrink-0 text-ink-2">可用工具</dt>
            <dd className="num min-w-0 font-mono text-[13px] break-words text-ink-2">
              {MCP_TOOLS.join(' · ')}
            </dd>
          </div>
        </dl>

        <div className="mt-4">
          <p className="text-[14px] font-medium text-ink">客户端配置</p>
          <div className="mt-2">
            <CodeBlock code={MCP_CLIENT_CONFIG} copyLabel="复制配置" copiedMessage="配置已复制" />
          </div>
        </div>

        <div className="mt-4">
          <p className="text-[14px] font-medium text-ink">先验一下通不通</p>
          <div className="mt-2">
            <CodeBlock code={MCP_CURL} copyLabel="复制命令" copiedMessage="命令已复制" />
          </div>
        </div>

        <div className="mt-4 border-t border-line pt-4">
          <p className="text-[14px] leading-6 text-ink-2">
            配套 skill 打包了问诊、金额核算和文书的提示词，装进你的 Claude 就能直接用。
          </p>
          <div className="mt-2">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => toast('skill 打包下载开发中', 'neutral', '有一条新的更新')}
            >
              下载配套 skill
            </Button>
          </div>
        </div>
      </CardBody>
    </Card>
  );
}
