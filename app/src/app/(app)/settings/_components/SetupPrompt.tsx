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
  /** 当前那把 key 的明文（来自 useAgentKeySecret）；取不到就渲染占位符 */
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
        /*
         * 【为什么不再说「密钥只在生成那一次显示」】那句话从 secret_enc 落库那天起就是假的，
         * 而它的代价是让人为了一件不必要的事去吊销重建。落到占位符只剩三种场合，
         * 上面那一小节（CurrentKey）会说清是哪一种、出路是什么，这里只提醒别把占位符原样粘走。
         */
        <p className="mt-3 text-[13px] leading-5 text-ink-2">
          还没填进真密钥，话术里是占位符{' '}
          <span className="font-mono">{KEY_PLACEHOLDER}</span>
          ——按上面那一小节的提示拿到密钥后，这段会自动填上，别把占位符原样粘给助手。
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

      {tab === 'claude' && <SkillDownload skillUrl={info.skill_url} />}
    </div>
  );
}

/**
 * 配套 skill 的入口。
 *
 * 【按钮为什么是链接而不是下载】skill 包现在是三份公开的 Markdown（/skill/…，免鉴权），
 * 话术第一步已经让对方 agent 自己去取；这里给的是**人**想先读一眼时的入口。
 * 这一档之前是个置灰的「即将提供」，现在东西真的在了，就别再摆一个点了没反应的按钮。
 */
function SkillDownload({ skillUrl }: { skillUrl: string }) {
  return (
    <div className="mt-4 border-t border-line pt-3">
      <p className="text-[14px] leading-6 text-ink-2">
        配套 skill 已经在话术第一步里了：你的助手会自己取走它，按里面写的规矩办。
        想自己先读一眼就点这里。
      </p>
      <div className="mt-2">
        <Button asChild size="sm" variant="secondary">
          <a href={skillUrl} target="_blank" rel="noreferrer">
            打开配套 skill
          </a>
        </Button>
      </div>
    </div>
  );
}
