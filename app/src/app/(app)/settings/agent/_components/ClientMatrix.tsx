'use client';

import { useState } from 'react';

import {
  ACCESS_PATHS,
  CLIENT_MATRIX,
  type ClientEntry,
  type SnippetVars,
} from '@/lib/capabilities/client-matrix';
import { Select } from '@/components/shadcn/select';
import { CodeBlock } from '../../_components/CodeBlock';
import { KEY_PLACEHOLDER, type SetupUrls } from '../../_components/agentSetup';

/**
 * 客户端接入矩阵（设计稿 §15）：选你手里那个客户端，给你这一家的步骤与一段可复制的配置。
 *
 * 【为什么名单与文案不在这个文件里】它们的正本是 lib/capabilities/client-matrix.ts，
 * 《接入说明》里那张表由**同一份数据、同一批 snippet 函数**生成。抄一份到页面上的形态是：
 * 改了地址或步骤只改一处，另一处生成出来的配置**看起来完全正常**，
 * 用户照着粘、接不上，而页面上没有任何报错。
 *
 * 【地址从哪来】info 来自 GET /api/v1/agent-setup（服务端按 env 算出公网基址）。
 * 这一层不拼、不改、不兜底任何地址——写死的那份在预发环境上指向的是生产。
 */
export function ClientMatrix({ info, apiKey }: { info: SetupUrls; apiKey?: string }) {
  const [id, setId] = useState(CLIENT_MATRIX[0].id);
  const current: ClientEntry = CLIENT_MATRIX.find((c) => c.id === id) ?? CLIENT_MATRIX[0];

  const vars: SnippetVars = {
    mcpUrl: info.mcp_url,
    apiBase: info.api_base,
    manifestUrl: info.manifest_url,
    openapiUrl: info.openapi_url,
    skillUrl: info.skill_url,
    apiKey,
  };

  return (
    <div>
      <label
        htmlFor="client-matrix-picker"
        className="text-[14px] leading-6 font-semibold text-ink"
      >
        你手里是哪个客户端
      </label>
      <Select
        id="client-matrix-picker"
        className="mt-1.5"
        value={id}
        onChange={(e) => setId(e.target.value)}
      >
        {CLIENT_MATRIX.map((c) => (
          <option key={c.id} value={c.id}>
            {c.label}
          </option>
        ))}
      </Select>

      <p className="mt-2 text-[13px] leading-5 text-ink-2">
        接入路径 {current.path}·{ACCESS_PATHS[current.path]}
      </p>

      {current.status === 'blocked' && (
        /*
         * 【为什么这条要摆在最显眼处】这几家客户端只认我们还没上线的授权方式。
         * 不说清楚的形态是：用户照着步骤做、连不上、以为是自己密钥填错了，
         * 于是回去重新生成一把——而重生成一百次也不会有用。
         */
        <p
          role="status"
          className="mt-2 rounded-[10px] border-l-4 border-amber bg-amber-wash px-3 py-2.5 text-[14px] leading-6 text-amber-ink"
        >
          这一家现在还接不上：它只接受我们尚未上线的授权方式。下面的步骤里写了现在该走哪条替代路。
        </p>
      )}

      <ol className="mt-3 flex list-decimal flex-col gap-1.5 pl-5 text-[14px] leading-6 text-ink-2">
        {current.steps(vars).map((step, i) => (
          <li key={i}>{step}</li>
        ))}
      </ol>

      {!apiKey && (
        <p className="mt-3 text-[13px] leading-5 text-ink-2">
          还没填进真密钥，片段里是占位符 <span className="font-mono">{KEY_PLACEHOLDER}</span>
          ——按第一步拿到密钥后这里会自动填上，别把占位符原样粘走。
        </p>
      )}

      <div className="mt-3">
        <p className="text-[13px] leading-5 font-semibold text-ink">{current.snippetLabel}</p>
        <div className="mt-1.5">
          <CodeBlock
            code={current.snippet(vars)}
            wrap
            maxHeight="max-h-80"
            copyLabel="复制这段"
            copiedMessage="已复制，按上面的步骤粘过去"
          />
        </div>
      </div>
    </div>
  );
}
