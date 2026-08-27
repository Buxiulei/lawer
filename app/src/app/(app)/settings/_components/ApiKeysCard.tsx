'use client';

import { useEffect, useState } from 'react';
import { ApiError, apiFetch, humanError } from '@/app/_ui/api';
import { cn } from '@/app/_ui/cn';
import { formatDateTime } from '@/app/_ui/format';
import { Badge } from '@/components/shadcn/badge';
import { AppSheet } from '@/components/shadcn/app-sheet';
import { Button } from '@/components/shadcn/button';
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/shadcn/card';
import { Checkbox } from '@/components/shadcn/checkbox';
import { ConfirmDialog } from '@/components/shadcn/confirm-dialog';
import { InputField } from '@/components/shadcn/field';
import { Skeleton } from '@/components/shadcn/skeleton';
import { useToast } from '@/components/ui/Toast';
import { CodeBlock } from './CodeBlock';
import { SetupPrompt } from './SetupPrompt';
import { SignInHint } from './SignInHint';
import type { SetupUrls } from './agentSetup';

/**
 * API key：用户自己的 agent 直连档案库的长期凭据。
 *
 * 【明文只有一次】POST /api/v1/keys 的响应是这串明文唯一一次出现的地方，
 * 库里只留 SHA256。所以创建成功页把「接入话术」也一并组装好——用户在这一屏
 * 复制走的那段话术里已经带着真密钥，不必自己去拼。关掉就只剩占位符了。
 */

/** 后端 ALL_SCOPES（lib/auth/api-key.ts）就这两项，多传一项会被 INVALID_SCOPES 打回 */
const SCOPES = [
  { key: 'case:read', label: '读案件档案与证据' },
  { key: 'case:write', label: '写档案、传证据、起草文书' },
] as const;

const DEFAULT_SCOPES: string[] = SCOPES.map((s) => s.key);

interface ApiKeyRow {
  id: number;
  name: string;
  scopes: string[];
  enabled: boolean;
  last_used_at: string | null;
}

/**
 * 接口给的时间是 ADR-002 的 canonical 格式（UTC，空格分隔），
 * 而 new Date('2026-08-21 10:00:00') 会被当成本地时间——补个 Z 再交给 formatDateTime，
 * 否则「最近使用」会整整差 8 小时。
 */
function toIso(sqlUtc: string): string {
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(sqlUtc)
    ? `${sqlUtc.replace(' ', 'T')}Z`
    : sqlUtc;
}

/** POST /api/v1/keys 的成功响应：key 明文 + 接入地址（服务端顺手给全） */
interface CreatedKey extends SetupUrls {
  id: number;
  name: string;
  scopes: string[];
  key: string;
  warning: string;
}

const SCOPE_LABEL = new Map<string, string>(SCOPES.map((s) => [s.key, s.label]));

export function ApiKeysCard() {
  const toast = useToast();
  const [keys, setKeys] = useState<ApiKeyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** 没登录（或 token 已失效）：key 是绑账号的，整卡换成登录引导 */
  const [unauthorized, setUnauthorized] = useState(false);

  const [sheetOpen, setSheetOpen] = useState(false);
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<string[]>(DEFAULT_SCOPES);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  /** 生成后的完整 key：只在这一次露面，关掉就再也拿不到 */
  const [issued, setIssued] = useState<CreatedKey | null>(null);
  const [revoking, setRevoking] = useState<ApiKeyRow | null>(null);

  // 挂载时拉一次；之后的新建与吊销就地改本地列表，不再回源
  useEffect(() => {
    let alive = true;
    apiFetch<{ keys: ApiKeyRow[] }>('/keys').then(
      (body) => {
        if (!alive) return;
        setKeys(body.keys);
        setLoading(false);
      },
      (err) => {
        if (!alive) return;
        if (err instanceof ApiError && err.errorCode === 'UNAUTHORIZED') setUnauthorized(true);
        else setLoadError(humanError(err));
        setLoading(false);
      },
    );
    return () => {
      alive = false;
    };
  }, []);

  const closeSheet = () => {
    setSheetOpen(false);
    setIssued(null);
    setCreateError(null);
    setName('');
    setScopes(DEFAULT_SCOPES);
  };

  const create = async () => {
    setCreating(true);
    setCreateError(null);
    try {
      const body = await apiFetch<CreatedKey>('/keys', {
        method: 'POST',
        body: { name: name.trim(), scopes },
      });
      setIssued(body);
      setKeys((prev) => [
        {
          id: body.id,
          name: body.name,
          scopes: body.scopes,
          enabled: true,
          last_used_at: null,
        },
        ...prev,
      ]);
    } catch (err) {
      setCreateError(humanError(err));
    } finally {
      setCreating(false);
    }
  };

  const toggleScope = (key: string) => {
    setScopes((prev) =>
      prev.includes(key) ? prev.filter((s) => s !== key) : [...prev, key],
    );
  };

  const revoke = async (row: ApiKeyRow) => {
    setRevoking(null);
    try {
      await apiFetch(`/keys/${row.id}`, { method: 'DELETE' });
      setKeys((prev) => prev.map((k) => (k.id === row.id ? { ...k, enabled: false } : k)));
      toast(`${row.name} 已吊销`, 'neutral', '已更新');
    } catch (err) {
      toast(humanError(err), 'amber', '这一步没成功');
    }
  };

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>API key</CardTitle>
          <CardAction>
            {!unauthorized && (
              <Button size="sm" variant="secondary" onClick={() => setSheetOpen(true)}>
                新建
              </Button>
            )}
          </CardAction>
        </CardHeader>
        <CardContent>
          <p className="text-[14px] leading-6 text-ink-2">
            给你自己的 agent 用。一把 key 能做什么由勾选的权限决定，随时可以吊销。
          </p>

          {loading && <Skeleton className="mt-3 h-20 w-full" />}

          {!loading && unauthorized && (
            <SignInHint>key 是你账号的凭据，登录之后才能生成。</SignInHint>
          )}

          {!loading && !unauthorized && loadError && (
            <p className="mt-3 text-[14px] leading-6 text-ink-2">
              key 列表这次没读到（{loadError}），稍后回来再看。
            </p>
          )}

          {!loading && !loadError && !unauthorized && keys.length === 0 && (
            <p className="mt-3 text-[14px] leading-6 text-ink-2">
              还没有 key。要让自己的 AI 助手接进来，先在这儿生成一把。
            </p>
          )}

          <ul className="mt-3">
            {keys.map((row) => (
              <li key={row.id} className="flex items-start gap-3 border-t border-line py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[15px] font-semibold text-ink">{row.name}</span>
                    {row.enabled ? (
                      <Badge tone="success">启用中</Badge>
                    ) : (
                      <Badge tone="neutral">已吊销</Badge>
                    )}
                  </div>

                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {row.scopes.map((scope) => (
                      <Badge key={scope} tone="neutral">
                        {SCOPE_LABEL.get(scope) ?? scope}
                      </Badge>
                    ))}
                  </div>

                  <p className="num mt-1.5 text-[13px] text-ink-2">
                    {row.last_used_at
                      ? `最近使用 ${formatDateTime(toIso(row.last_used_at))}`
                      : '还没被用过'}
                  </p>
                </div>

                {row.enabled && (
                  <button
                    type="button"
                    onClick={() => setRevoking(row)}
                    className="flex min-h-11 shrink-0 items-center text-[14px] text-ink-2 hover:text-danger-ink"
                  >
                    吊销
                  </button>
                )}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <AppSheet
        open={sheetOpen}
        onClose={closeSheet}
        title={issued ? '这把 key 只显示这一次' : '新建 API key'}
        footer={
          issued ? (
            <Button className="w-full" variant="secondary" onClick={closeSheet}>
              我已经存好了
            </Button>
          ) : (
            <Button
              className="w-full"
              disabled={!name.trim() || scopes.length === 0 || creating}
              onClick={() => void create()}
            >
              {creating ? '正在生成…' : '生成 key'}
            </Button>
          )
        }
      >
        {issued ? (
          <IssuedKey issued={issued} />
        ) : (
          <div className="flex flex-col gap-5">
            <InputField
              label="名称"
              hint="写清楚给谁用，比如「我的 Claude 桌面端」，方便以后吊销。"
              placeholder="我的 Claude 桌面端"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={30}
            />

            <div>
              <p className="text-[14px] font-medium text-ink">权限</p>
              <p className="mt-1 text-[13px] leading-5 text-ink-2">
                只勾用得上的。少给一项，泄露时少一分损失。
              </p>
              <div className="mt-2 flex flex-col">
                {SCOPES.map((scope) => {
                  const checked = scopes.includes(scope.key);
                  return (
                    <label
                      key={scope.key}
                      className="flex min-h-11 cursor-pointer items-center gap-3 border-b border-line py-2 last:border-b-0"
                    >
                      <Checkbox
                        checked={checked}
                        onCheckedChange={() => toggleScope(scope.key)}
                      />
                      <span className="text-[15px] text-ink">{scope.label}</span>
                      <span
                        className={cn(
                          'num ml-auto font-mono text-[13px]',
                          checked ? 'text-primary-ink' : 'text-ink-2',
                        )}
                      >
                        {scope.key}
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>

            {createError && (
              <p className="text-[14px] leading-6 text-ink-2">{createError}</p>
            )}
          </div>
        )}
      </AppSheet>

      <ConfirmDialog
        open={revoking !== null}
        title="吊销这把 API key"
        description={
          <>
            正在用「{revoking?.name}」的 agent 会立刻断连，这把 key 也没法恢复，只能重新生成一把新的。
          </>
        }
        confirmLabel="确认吊销"
        tone="danger"
        onConfirm={() => revoking && void revoke(revoking)}
        onCancel={() => setRevoking(null)}
      />
    </>
  );
}

/**
 * 密钥生成成功页。两件事必须在这一屏办完：把明文存下来、把带明文的接入话术复制走。
 * 警示用 danger 措辞不用 danger 底色——用户刚做完一件对的事，不该被一块红警报迎面砸。
 */
function IssuedKey({ issued }: { issued: CreatedKey }) {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-[15px] leading-7 text-ink">
        现在就复制保存。关掉这一屏之后我们只留下加密后的指纹，
        <span className="font-semibold text-danger-ink">此密钥不会再次显示</span>
        ——丢了只能吊销后重新生成一把。
      </p>

      <CodeBlock
        code={issued.key}
        wrap
        copyLabel="复制完整 key"
        copiedMessage="key 已复制，记得妥善保管"
      />

      <div className="border-t border-line pt-4">
        <p className="text-[14px] font-medium text-ink">直接把接入话术发给你的 AI 助手</p>
        <p className="mt-1 text-[13px] leading-5 text-ink-2">
          下面这段已经填好了刚生成的密钥，整段复制粘过去就能接上。
        </p>
        <div className="mt-2">
          <SetupPrompt info={issued} apiKey={issued.key} />
        </div>
      </div>

      <p className="rounded-[10px] bg-amber-wash px-3 py-2.5 text-[14px] leading-6 text-amber-ink">
        妥善保管：拿到这串字符的人，就能以你的身份读写案件档案。不要贴进聊天群、截图或公开仓库。
      </p>
    </div>
  );
}
