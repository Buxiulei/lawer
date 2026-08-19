'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { cn } from '@/app/_ui/cn';
import { useDiscreet } from '@/app/_ui/discreet';
import { useTheme, type ThemeMode } from '@/app/_ui/theme';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Switch } from './Switch';

const THEME_OPTIONS: { mode: ThemeMode; label: string }[] = [
  { mode: 'system', label: '跟随系统' },
  { mode: 'light', label: '浅色' },
  { mode: 'dark', label: '深色' },
];

export function PreferencesCard() {
  const router = useRouter();
  const { mode, setMode } = useTheme();
  const { discreet, setDiscreet } = useDiscreet();
  const [signOutOpen, setSignOutOpen] = useState(false);

  return (
    <>
      <Card>
        <CardHeader title="通用" />
        <CardBody>
          <div className="border-t border-line py-3">
            <p className="text-[15px] font-medium text-ink">主题</p>
            <div className="mt-2 flex gap-1 rounded-[10px] bg-surface-2 p-1">
              {THEME_OPTIONS.map((option) => {
                const active = option.mode === mode;
                return (
                  <button
                    key={option.mode}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setMode(option.mode)}
                    className={cn(
                      'h-11 flex-1 rounded-[8px] text-[15px] transition-colors duration-150 ease-out',
                      active ? 'bg-surface font-semibold text-ink shadow-soft' : 'text-ink-2',
                    )}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex items-start gap-3 border-t border-line py-3">
            <div className="min-w-0 flex-1">
              <p className="text-[15px] font-medium text-ink">低调模式</p>
              <p className="mt-0.5 text-[14px] leading-6 text-ink-2">
                金额、公司名和案件标题打码，点一下才显示 3 秒；标签页只写「工作台」。
                顶栏那个眼睛图标是同一个开关。
              </p>
            </div>
            <Switch checked={discreet} onChange={setDiscreet} label="低调模式" />
          </div>

          <div className="border-t border-line pt-4">
            <Button variant="secondary" onClick={() => setSignOutOpen(true)}>
              退出登录
            </Button>
          </div>
        </CardBody>
      </Card>

      <ConfirmDialog
        open={signOutOpen}
        title="退出登录"
        description="这台设备上会清掉登录状态，案件档案和证据都留在账号里。下次回来还要走一遍手机和邮箱验证。"
        confirmLabel="确认退出登录"
        tone="primary"
        onConfirm={() => {
          setSignOutOpen(false);
          router.push('/login');
        }}
        onCancel={() => setSignOutOpen(false)}
      />
    </>
  );
}
