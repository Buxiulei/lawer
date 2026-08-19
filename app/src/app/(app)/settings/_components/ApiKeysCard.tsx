'use client';

import { useState } from 'react';
import {
  API_KEY_SCOPES,
  DEFAULT_SCOPES,
  mockApiKeys,
  mockCreateApiKey,
  type ApiKeyRecord,
} from '@/app/_mock/authpay';
import { cn } from '@/app/_ui/cn';
import { formatDateTime } from '@/app/_ui/format';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Input } from '@/components/ui/Field';
import { Sheet } from '@/components/ui/Sheet';
import { useToast } from '@/components/ui/Toast';
import { CodeBlock } from './CodeBlock';
import { Switch } from './Switch';

const SCOPE_LABEL = new Map<string, string>(
  API_KEY_SCOPES.map((s) => [s.key, s.label]),
);

export function ApiKeysCard() {
  const toast = useToast();
  const [keys, setKeys] = useState<ApiKeyRecord[]>(mockApiKeys);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<string[]>(DEFAULT_SCOPES);
  /** 生成后的完整 key：只在这一次露面，关掉就再也拿不到 */
  const [issued, setIssued] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<ApiKeyRecord | null>(null);

  const closeSheet = () => {
    setSheetOpen(false);
    setIssued(null);
    setName('');
    setScopes(DEFAULT_SCOPES);
  };

  const create = () => {
    const { record, secret } = mockCreateApiKey(name.trim(), scopes);
    setKeys((prev) => [record, ...prev]);
    setIssued(secret);
  };

  const toggleScope = (key: string) => {
    setScopes((prev) =>
      prev.includes(key) ? prev.filter((s) => s !== key) : [...prev, key],
    );
  };

  const toggleEnabled = (record: ApiKeyRecord, next: boolean) => {
    setKeys((prev) =>
      prev.map((k) => (k.id === record.id ? { ...k, enabled: next } : k)),
    );
    toast(next ? `${record.name} 已启用` : `${record.name} 已停用`, 'neutral', '已更新');
  };

  const remove = (record: ApiKeyRecord) => {
    setKeys((prev) => prev.filter((k) => k.id !== record.id));
    setDeleting(null);
    toast(`${record.name} 已删除`, 'neutral', '已更新');
  };

  return (
    <>
      <Card>
        <CardHeader
          title="API key"
          action={
            <Button size="sm" variant="secondary" onClick={() => setSheetOpen(true)}>
              新建
            </Button>
          }
        />
        <CardBody>
          <p className="text-[14px] leading-6 text-ink-2">
            给你自己的 agent 用。一把 key 能做什么由勾选的权限决定，随时可以停用或删掉。
          </p>

          <ul className="mt-3">
            {keys.map((record) => (
              <li
                key={record.id}
                className="flex items-start gap-3 border-t border-line py-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[15px] font-semibold text-ink">
                      {record.name}
                    </span>
                    <span className="num font-mono text-[13px] text-ink-2">
                      {record.masked}
                    </span>
                  </div>

                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {record.scopes.map((scope) => (
                      <Badge key={scope} tone="neutral">
                        {SCOPE_LABEL.get(scope) ?? scope}
                      </Badge>
                    ))}
                  </div>

                  <p className="num mt-1.5 text-[13px] text-ink-2">
                    {record.lastUsedAt
                      ? `最近使用 ${formatDateTime(record.lastUsedAt)}`
                      : '还没被用过'}
                  </p>

                  <button
                    type="button"
                    onClick={() => setDeleting(record)}
                    className="mt-1 flex min-h-11 items-center text-[14px] text-ink-2 hover:text-danger"
                  >
                    删除
                  </button>
                </div>

                <Switch
                  checked={record.enabled}
                  onChange={(next) => toggleEnabled(record, next)}
                  label={`${record.name} 启用开关`}
                />
              </li>
            ))}
          </ul>
        </CardBody>
      </Card>

      <Sheet
        open={sheetOpen}
        onClose={closeSheet}
        title={issued ? '这把 key 只显示这一次' : '新建 API key'}
        footer={
          issued ? (
            <Button fullWidth variant="secondary" onClick={closeSheet}>
              我已经存好了
            </Button>
          ) : (
            <Button fullWidth disabled={!name.trim() || scopes.length === 0} onClick={create}>
              生成 key
            </Button>
          )
        }
      >
        {issued ? (
          <div className="flex flex-col gap-4">
            <p className="text-[15px] leading-7 text-ink">
              请现在就复制保存。关掉这个弹层之后，我们只留下加密后的指纹，没法再给你看一遍——丢了只能重新生成一把。
            </p>
            <CodeBlock code={issued} copyLabel="复制完整 key" copiedMessage="key 已复制，记得妥善保管" />
            <p className="rounded-[10px] bg-amber-wash px-3 py-2.5 text-[14px] leading-6 text-amber">
              妥善保管：拿到这串字符的人，就能以你的身份读写案件档案。不要贴进聊天群、截图或公开仓库。
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-5">
            <Input
              label="名称"
              hint="写清楚给谁用，比如「我的 Claude 桌面端」，方便以后停用。"
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
                {API_KEY_SCOPES.map((scope) => {
                  const checked = scopes.includes(scope.key);
                  return (
                    <label
                      key={scope.key}
                      className="flex min-h-11 cursor-pointer items-center gap-3 border-b border-line py-2 last:border-b-0"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleScope(scope.key)}
                        className="size-5 shrink-0 accent-primary"
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
          </div>
        )}
      </Sheet>

      <ConfirmDialog
        open={deleting !== null}
        title="删除这把 API key"
        description={
          <>
            正在用「{deleting?.name}」的 agent 会立刻断连，这把 key 也没法恢复。需要的话可以先停用观察几天，再回来删。
          </>
        }
        confirmLabel="确认删除这把 key"
        tone="danger"
        onConfirm={() => deleting && remove(deleting)}
        onCancel={() => setDeleting(null)}
      />
    </>
  );
}
