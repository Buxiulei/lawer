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
import { CurrentKey } from '../../_components/CurrentKey';
import { SetupPrompt } from '../../_components/SetupPrompt';
import { SignInHint } from '../../_components/SignInHint';
import type { SetupUrls } from '../../_components/agentSetup';
import { useAgentSetup } from '../../_components/useAgentSetup';
import {
  useAgentKeySecret,
  type AgentKeySecret,
  type IssuedKey,
} from '../../_components/useAgentKeySecret';

/**
 * 生成那一次的响应里，这一页还用得上的部分：接入地址（省一次 agent-setup 往返）
 * 与 id（第四步只盯这把刚生成的钥匙）。
 *
 * **明文故意不在这个类型里**。留一份的形态见下面 apiKey 那段——这里不留，
 * 是为了让「再从 issued 里取明文」连编译都过不去，而不是靠下一个人记得别取。
 */
type IssuedRef = SetupUrls & { id: number };

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
  /**
   * 手上那把 key 的明文。**二次进这一页也要有**——以前这里只认「本次刚生成的那把」
   * （issued），关掉页面再回来就退回占位符，而用户能做的只剩再生成一把。
   */
  const secret = useAgentKeySecret();
  const [issued, setIssued] = useState<IssuedRef | null>(null);

  const credit = discreet ? NEUTRAL_WORD.credits : '公道值';
  const watch = discreet ? NEUTRAL_WORD.watch : '守望';
  /** 地址：刚生成的响应里就带着（省一次往返），否则用 agent-setup 那份 */
  const urls: SetupUrls | null = issued ?? setup.info;
  /**
   * 话术里填哪一串：**只认 hook**。
   *
   * 这里曾经写成 `issued?.key ?? hook`——本次刚生成的那把永远压过 hook。形态是：
   * 在这一页生成一把、随手点「轮换密钥」，第一步「当前这把」已经换成新的，
   * 下面第二步的话术与配置块却还内嵌着那把**刚刚失效**的，两块并排摆在同一屏上；
   * 「复制这段话术」复制走的就是一把 401 的钥匙，粘过去接不上，而页面没有任何报错。
   *
   * 明文只有一处正本：useAgentKeySecret（生成时 adopt 顶上、轮换时就地换成新的）。
   * 这一页不再留第二份——留了就得记得每条改动路径都去同步它，而漏掉的那条
   * 生成的配置**看起来完全正常**。
   */
  const apiKey = secret.state.kind === 'ready' ? secret.state.secret : undefined;

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
          {/*
            标题不随状态变：它在首帧（还没问过服务端）与水合后必须是同一句，
            否则第一步的名字会当着用户的面跳一下。「拿到你的密钥」两种情形都成立——
            没有就生成一把，有就把它取回来。
          */}
          <Step no="一" title="拿到你的密钥">
            <IssueKey issued={issued} secret={secret} onIssued={setIssued} />
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
                    <SetupPrompt info={urls} apiKey={apiKey} />
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

/**
 * 第一步。
 *
 * 【它不再只是「生成」】以前这一步只有一条路：填个名字、生成、把明文当场存走。
 * 二次进这一页时 issued 是空的，于是页面装作你还没有密钥，而你其实有一把在用——
 * 唯一的出路是再生成一把，接着两把 key 挂在那儿谁也不知道哪把在用。
 * 现在有 key 就把那把亮出来（明文可取回），没有才给生成表单。
 */
function IssueKey({
  issued,
  secret,
  onIssued,
}: {
  issued: IssuedRef | null;
  secret: AgentKeySecret;
  onIssued: (k: IssuedRef) => void;
}) {
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 已经有一把（含刚生成的）：亮出来 + 给轮换，不再摆生成表单
  if (issued || (secret.state.kind !== 'none' && secret.state.kind !== 'signedOut')) {
    return (
      <div>
        {issued && (
          <p className="text-[15px] leading-7 text-ink">
            生成好了。下一步的配置里已经替你填上它——
            <span className="font-semibold text-ink">忘了也不要紧，随时回这一页看</span>。
          </p>
        )}
        <div className={issued ? 'mt-2' : undefined}>
          {/*
            低调模式下这一小节要**折叠**，和第二步的话术同一个壳。
            摆在折叠外面的形态是：屏幕上常驻一串密钥明文——它不是案情词，
            按词表点名的那条页面守卫一个字都不会红，而旁人扫一眼就看得出
            这台手机上挂着个要拿密钥连的服务。折叠标签保持中性。
            接入指南自己就是「去生成」那条路的落地页，所以不再给一条指回自己的链接。
          */}
          <DiscreetCollapse label="当前密钥（点开查看）">
            <CurrentKey secret={secret} offerIssueLink={false} />
          </DiscreetCollapse>
        </div>
      </div>
    );
  }

  const create = async () => {
    setCreating(true);
    setError(null);
    try {
      const body = await apiFetch<IssuedKey>('/keys', {
        method: 'POST',
        // 两项权限都给：接入的意义就是让它替你读写档案，
        // 想收紧到只读的人走设置页那张卡自己勾。
        body: { name: name.trim(), scopes: ['case:read', 'case:write'] },
      });
      onIssued(body);
      // 顶掉 hook 的 'none' 态：刚生成的这把就是当前那把，不必再往返一趟去问
      secret.adopt(body);
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
