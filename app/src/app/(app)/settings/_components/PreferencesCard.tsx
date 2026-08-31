'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { clearToken, useSignedIn } from '@/app/_ui/auth';
import { cn } from '@/app/_ui/cn';
import { useDiscreet } from '@/app/_ui/discreet';
import { useTheme, type ThemeMode } from '@/app/_ui/theme';
import { Button } from '@/components/shadcn/button';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/shadcn/card';
import { ConfirmDialog } from '@/components/shadcn/confirm-dialog';
import { Label } from '@/components/shadcn/label';
import { Switch } from '@/components/shadcn/switch';

const THEME_OPTIONS: { mode: ThemeMode; label: string }[] = [
  { mode: 'system', label: '跟随系统' },
  { mode: 'light', label: '浅色' },
  { mode: 'dark', label: '深色' },
];

export function PreferencesCard() {
  const router = useRouter();
  const { mode, setMode } = useTheme();
  const { discreet, setDiscreet } = useDiscreet();
  const signedIn = useSignedIn();
  const [signOutOpen, setSignOutOpen] = useState(false);

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>通用</CardTitle>
        </CardHeader>
        <CardContent>
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
              <Label htmlFor="discreet-switch" className="text-[15px]">
                低调模式
              </Label>
              <p className="mt-0.5 text-[14px] leading-6 text-ink-2">
                金额、公司名和案件标题打码，点一下才显示 3 秒；标签页只写「工作台」。
                顶栏那个眼睛图标是同一个开关。
              </p>
            </div>
            {/* 这层只做一件事：把开关在这行右侧居中并占住固定宽度。
                **触区不在这层**——它在 Switch 自己身上（伪元素扩区，见 shadcn/switch.tsx）。
                这里原先的注释把触区算在这层头上，而纯 CSS 居中不转发点击（审查台账 SYS-03）。 */}
            <div className="flex size-11 shrink-0 items-center justify-center">
              <Switch
                id="discreet-switch"
                checked={discreet}
                onCheckedChange={setDiscreet}
                aria-label="低调模式"
              />
            </div>
          </div>

          {signedIn && (
            <div className="border-t border-line pt-4">
              <Button variant="secondary" onClick={() => setSignOutOpen(true)}>
                退出登录
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={signOutOpen}
        title="退出登录"
        description="这台设备上会清掉登录状态，案件档案和证据都留在账号里。下次回来还要走一遍手机和邮箱验证。"
        confirmLabel="确认退出登录"
        tone="primary"
        onConfirm={() => {
          setSignOutOpen(false);
          // 弹窗答应了「清掉登录状态」，就得真清掉：只跳 /login 的话 token 还留在本机
          clearToken();
          router.push('/login');
        }}
        onCancel={() => setSignOutOpen(false)}
      />
    </>
  );
}
