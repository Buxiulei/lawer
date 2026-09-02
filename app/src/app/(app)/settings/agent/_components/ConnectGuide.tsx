'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { apiFetch, humanError } from '@/app/_ui/api';
import {
  BYO,
  BYO_NAME_IS_KEY_NAME,
  byoBillingLine,
  byoConnectedLine,
} from '@/app/_ui/byoAgent';
import { DiscreetCollapse } from '@/app/_ui/DiscreetCollapse';
import { useDiscreet } from '@/app/_ui/discreet';
import { NEUTRAL_WORD } from '@/app/_ui/neutral';
import {
  pickConnected,
  useConnectedAgent,
  type ApiKeyBrief,
  type ConnectedAgent,
} from '@/app/_ui/useConnectedAgent';
import { Button } from '@/components/shadcn/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/shadcn/card';
import { InputField } from '@/components/shadcn/field';
import { Skeleton } from '@/components/shadcn/skeleton';
import { CodeBlock } from '../../_components/CodeBlock';
import { SetupPrompt } from '../../_components/SetupPrompt';
import { SignInHint } from '../../_components/SignInHint';
import type { SetupUrls } from '../../_components/agentSetup';
import { useAgentSetup } from '../../_components/useAgentSetup';

/**
 * 一页式接入指南：从零到"接上了"四步走完，中途不用跳去别的页面翻。
 *
 * 【为什么不复用设置页那两张卡】ApiKeysCard 是**管理**用的（列出、吊销、看最近使用），
 * AgentSetupCard 是**查配置**用的（地址、工具清单、话术）。两张都假设你已经知道自己在干什么。
 * 第一次接的人要的是顺序：先生成什么、再粘到哪、怎么知道成没成。那三件事散在两张卡里，
 * 中间还缺最后一步——**没有任何地方告诉他"接上了没有"**。
 *
 * 【话术零新代码】第二步整段复用 SetupPrompt + agentSetup 的六档，一个字都不抄。
 * 抄一遍就等于以后改地址要改两处，而漏掉的那处生成的配置**看起来完全正常**。
 *
 * 【低调模式】这一页是四处入口的落地页，而低调模式下那张入口卡显示的是中性的
 * 「接入你自己的助手」——点进来却看见「我的劳动仲裁案件档案库」，等于入口改名白改。
 * 所以三处各归各的层：
 *   ① 话术那一整块（逐字带着土八鼠 / 劳动仲裁）折叠，与设置页 AgentSetupCard 同一个壳；
 *   ② 引子与第四步说明是普通正文，进糊层（按住能看清）；
 *   ③ 标题换成 BYO.titleNeutral。
 * 守卫按**页面**锁在 __tests__/agent-page-discreet.test.tsx——按组件名锁的守卫看不见新页面，
 * 这一页第一版正是这么漏出去的。
 */
export function ConnectGuide() {
  const { discreet } = useDiscreet();
  const setup = useAgentSetup();
  const agent = useConnectedAgent();
  const [issued, setIssued] = useState<CreatedKey | null>(null);

  const credit = discreet ? NEUTRAL_WORD.credits : '公道值';
  const watch = discreet ? NEUTRAL_WORD.watch : '守望';
  /** 有刚生成的就用它（话术里能带上明文密钥），否则用 agent-setup 那份（话术里只能给占位符） */
  const urls: SetupUrls | null = issued ?? setup.info;

  return (
    <div className="pt-1 pb-4">
      <header className="py-3">
        <h1 className="text-[22px] leading-8 font-semibold tracking-tight text-ink">
          {discreet ? BYO.titleNeutral : BYO.title}
        </h1>
        <p data-veil="" className="prose-measure mt-2 text-[15px] leading-7 text-ink-2">
          {BYO.lead}
        </p>
        <p
          data-veil=""
          className="prose-measure mt-2 border-l-[3px] border-primary pl-3 text-[14px] leading-6 font-semibold text-primary-ink"
        >
          {byoBillingLine({ credit, watch, discreet })}
        </p>
        <p className="prose-measure mt-2 text-[14px] leading-6 text-ink-2">{BYO.how}</p>
      </header>

      {agent.connected && <ConnectedBanner agent={agent} />}

      {setup.unauthorized ? (
        <Card className="mt-4">
          <CardContent className="pt-4">
            <SignInHint>密钥是你账号的凭据，登录之后才能生成。</SignInHint>
          </CardContent>
        </Card>
      ) : (
        <div className="mt-4 flex flex-col gap-4">
          <Step no="一" title="生成一把密钥">
            <IssueKey issued={issued} onIssued={setIssued} />
          </Step>

          <Step no="二" title="复制配置">
            {setup.loading && !issued && <Skeleton className="h-40 w-full" />}
            {setup.error && !setup.loading && !issued && (
              <p className="text-[14px] leading-6 text-ink-2">
                接入信息这次没取到（{setup.error}），刷新一下再试。
              </p>
            )}
            {urls && (
              <>
                <p className="text-[14px] leading-6 text-ink-2">
                  选你手里那个客户端；不确定就用「通用」，让它自己判断走 MCP 还是 REST。
                </p>
                <div className="mt-2">
                  <DiscreetCollapse label="接入配置（点开查看）">
                    <SetupPrompt info={urls} apiKey={issued?.key} />
                  </DiscreetCollapse>
                </div>
              </>
            )}
          </Step>

          <Step no="三" title="粘到你的助手里">
            <p className="text-[14px] leading-6 text-ink-2">
              支持 MCP 的客户端：按上面那段写进配置文件或 MCP 面板，然后
              <span className="font-semibold text-ink">重启客户端</span>
              ——多数客户端不重启不会重新读配置。不支持 MCP 的：把整段话术发给它，让它照着调 REST。
            </p>
          </Step>

          <Step no="四" title="验一下接上没有">
            <VerifyStep issuedId={issued?.id ?? null} />
          </Step>
        </div>
      )}

      <p className="mt-6 text-[14px] leading-6 text-ink-2">
        管理已有的密钥（看最近使用、吊销）在
        <Link href="/settings" className="mx-1 text-primary-ink underline underline-offset-4">
          设置页
        </Link>
        。
      </p>
    </div>
  );
}

function Step({ no, title, children }: { no: string; title: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <span className="mr-2 text-primary-ink">第{no}步</span>
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

/** 已接入状态的常驻横幅：这一页每次打开都先回答「现在到底接上没有」 */
function ConnectedBanner({ agent }: { agent: ConnectedAgent }) {
  return (
    <div
      role="status"
      className="mt-3 rounded-[10px] border-l-4 border-success bg-success-wash px-3 py-2.5"
    >
      <p className="text-[14px] leading-6 font-semibold text-success-ink">
        {byoConnectedLine(agent.name, agent.when)}
      </p>
      {agent.nameIsKeyName && (
        <p className="mt-0.5 text-[13px] leading-5 text-success-ink">{BYO_NAME_IS_KEY_NAME}</p>
      )}
    </div>
  );
}

/** POST /api/v1/keys 的成功响应：明文 + 接入地址（服务端顺手给全） */
interface CreatedKey extends SetupUrls {
  id: number;
  name: string;
  key: string;
}

function IssueKey({
  issued,
  onIssued,
}: {
  issued: CreatedKey | null;
  onIssued: (k: CreatedKey) => void;
}) {
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (issued) {
    return (
      <div>
        <p className="text-[15px] leading-7 text-ink">
          这串是「{issued.name}」的密钥，
          <span className="font-semibold text-danger-ink">只显示这一次</span>
          ——现在就存下来，下一步的配置里已经替你填好了。
        </p>
        <div className="mt-2">
          <CodeBlock
            code={issued.key}
            wrap
            copyLabel="复制完整密钥"
            copiedMessage="密钥已复制，记得妥善保管"
          />
        </div>
      </div>
    );
  }

  const create = async () => {
    setCreating(true);
    setError(null);
    try {
      onIssued(
        await apiFetch<CreatedKey>('/keys', {
          method: 'POST',
          // 两项权限都给：接入的意义就是让它替你读写档案，
          // 想收紧到只读的人走设置页那张卡自己勾。
          body: { name: name.trim(), scopes: ['case:read', 'case:write'] },
        }),
      );
    } catch (err) {
      setError(humanError(err));
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <InputField
        label="给这把密钥起个名"
        hint="就写你要接的那个助手，比如「我的 Claude」。以后要吊销时靠它认人。"
        placeholder="我的 Claude"
        value={name}
        onChange={(e) => setName(e.target.value)}
        maxLength={30}
      />
      {error && <p className="text-[14px] leading-6 text-ink-2">{error}</p>}
      <Button disabled={!name.trim() || creating} onClick={() => void create()}>
        {creating ? '正在生成…' : '生成密钥'}
      </Button>
      <p className="text-[13px] leading-5 text-ink-2">
        已经有密钥了？跳过这一步，下一步的配置里把占位符换成你当时存下的那串就行。
      </p>
    </div>
  );
}

type VerifyPhase = 'idle' | 'checking' | 'ok' | 'timeout';

/** 轮询上限：60 秒，每 3 秒一次 */
const VERIFY_WINDOW_MS = 60_000;
const VERIFY_INTERVAL_MS = 3_000;

/**
 * 「接上没有」的判据 = `api_keys.last_used_at` 有值。
 *
 * 【为什么不需要新接口】resolveIdentity（lib/auth/identity.ts）在**任何**用 api key 的
 * 请求上都会 touch 这一列。用户在自己的助手里问一句、或跑一条话术里那条 curl，
 * 这一列就落了。另立一个 /ping 端点，验的是那个端点通不通，不是他的助手接没接上。
 *
 * 【刚生成的那把要单独盯】否则一把很久以前用过的旧密钥会让这一步立刻"成功"，
 * 而他其实一个字都还没粘。
 */
function VerifyStep({ issuedId }: { issuedId: number | null }) {
  const [phase, setPhase] = useState<VerifyPhase>('idle');
  const [hit, setHit] = useState<ConnectedAgent | null>(null);

  useEffect(() => {
    if (phase !== 'checking') return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = Date.now() + VERIFY_WINDOW_MS;

    const tick = async () => {
      try {
        const body = await apiFetch<{ keys: ApiKeyBrief[] }>('/keys');
        if (!alive) return;
        const rows = issuedId === null ? body.keys : body.keys.filter((k) => k.id === issuedId);
        const found = pickConnected(rows);
        if (found.connected) {
          setHit(found);
          setPhase('ok');
          return;
        }
      } catch {
        // 网络抖一下不算失败，接着等到超时——这一步唯一的坏结局是"到点还没连进来"
        if (!alive) return;
      }
      if (Date.now() >= deadline) {
        setPhase('timeout');
        return;
      }
      timer = setTimeout(() => void tick(), VERIFY_INTERVAL_MS);
    };

    void tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [phase, issuedId]);

  if (phase === 'ok' && hit) {
    return (
      <div>
        <p className="text-[15px] leading-7 font-semibold text-success-ink">
          接上了。{byoConnectedLine(hit.name, hit.when)}
        </p>
        {hit.nameIsKeyName && (
          <p className="mt-1 text-[13px] leading-5 text-ink-2">{BYO_NAME_IS_KEY_NAME}</p>
        )}
      </div>
    );
  }

  return (
    <div>
      <p data-veil="" className="text-[14px] leading-6 text-ink-2">
        在你的助手里问一句「读一下我的案件档案」，然后回来点下面这颗。
      </p>
      {phase === 'timeout' && (
        /* 自述错误三段式：缺什么 / 为什么缺 / 怎么办。裸一句「失败」会让人从头再来一遍。 */
        <p className="mt-2 rounded-[10px] bg-amber-wash px-3 py-2.5 text-[14px] leading-6 text-amber-ink">
          还没看到你的助手连进来。常见原因：配置里的密钥少了 <span className="font-mono">Bearer</span>{' '}
          前缀、密钥粘漏了一截、或者客户端还没重启（多数客户端不重启不重读配置）。
          把上面那段配置重贴一次，重启客户端，再点一次这颗。
        </p>
      )}
      <Button
        variant="secondary"
        className="mt-3"
        disabled={phase === 'checking'}
        onClick={() => setPhase('checking')}
      >
        {phase === 'checking' ? '正在等你的助手连进来…' : '我接好了，检查一下'}
      </Button>
    </div>
  );
}
