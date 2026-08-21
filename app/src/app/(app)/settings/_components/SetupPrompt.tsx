'use client';

import { useState } from 'react';
import { Button } from '@/components/shadcn/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/shadcn/tabs';
import { CodeBlock } from './CodeBlock';
import {
  KEY_PLACEHOLDER,
  SETUP_TABS,
  setupPrompt,
  type SetupTabKey,
  type SetupUrls,
} from './agentSetup';

/**
 * 一键接入话术：一段可以整段复制、直接发给自己 AI 助手的文本。
 *
 * 默认停在「通用」——我们不假设用户手里是哪家助手（spec D4 修订）。
 * 三个客户端 Tab 只是同一份字段的不同包装，复制按钮永远复制**当前 Tab 那一版**。
 */
export function SetupPrompt({
  info,
  apiKey,
}: {
  info: SetupUrls;
  /** 密钥明文只在创建那一次拿得到；没有就渲染占位符 */
  apiKey?: string;
}) {
  const [tab, setTab] = useState<SetupTabKey>('general');
  const text = setupPrompt(tab, { ...info, apiKey });

  return (
    <div>
      {/* 四个 Tab 是同一份文本的不同包装，正文只有一份，不用 TabsContent 分四遍 */}
      <Tabs value={tab} onValueChange={(key) => setTab(key as SetupTabKey)}>
        <TabsList>
          {SETUP_TABS.map((item) => (
            <TabsTrigger key={item.key} value={item.key}>
              {item.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {!apiKey && (
        <p className="mt-3 text-[13px] leading-5 text-ink-2">
          话术里的 <span className="font-mono">{KEY_PLACEHOLDER}</span>{' '}
          要换成你生成密钥时保存的那串。密钥只在生成那一次显示，这里补不出来。
        </p>
      )}

      <div className="mt-3">
        <CodeBlock
          code={text}
          wrap
          maxHeight="max-h-80"
          copyLabel="复制这段话术"
          copiedMessage="话术已复制，粘给你的 AI 助手就行"
        />
      </div>

      {tab === 'claude' && <SkillDownload />}
    </div>
  );
}

/**
 * 配套 skill 的下载入口。
 * GET /api/v1/agent-setup 目前只回地址、工具清单与《接入说明》全文，没有 skill 包的下载地址，
 * 所以这里只能置灰——接口给了地址再把按钮接上，绝不先摆一个点了没反应的按钮。
 */
function SkillDownload() {
  return (
    <div className="mt-4 border-t border-line pt-3">
      <p className="text-[14px] leading-6 text-ink-2">
        配套 skill 把问诊、金额核算和文书的提示词打成一包，装进 Claude 就能直接用。
      </p>
      <div className="mt-2">
        <Button size="sm" variant="secondary" disabled>
          下载配套 skill（即将提供）
        </Button>
      </div>
    </div>
  );
}
