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

/**
 * 设置页这个开关**保留直切**：人是特地翻进设置来改偏好的，不是在地铁上误蹭到，
 * 所以不套顶栏那种 600ms 长按。但方向仍然不对称——**开启直切，关闭要过一次确认**，
 * 因为关掉的后果（余额、公司名当场明文）比多点一下重得多。
 *
 * 判定拎成纯函数是为了能被直接测：本仓库 vitest 跑 node 环境、没有 DOM，
 * 组件只能当普通函数调用。与 useDiscreetToggle / createDiscreetPress 同一套分法。
 */
export function createDiscreetSwitch({
  setDiscreet,
  openConfirm,
}: {
  setDiscreet: (on: boolean) => void;
  openConfirm: () => void;
}) {
  return (next: boolean) => {
    if (next) setDiscreet(true);
    else openConfirm();
  };
}

/** 上面那条判定的 React 状态层。单独一层，好让组件测试整层替掉、只留真判定。 */
export function useDiscreetOffConfirm() {
  const { discreet, setDiscreet } = useDiscreet();
  const [confirmOpen, setConfirmOpen] = useState(false);

  return {
    discreet,
    confirmOpen,
    onCheckedChange: createDiscreetSwitch({
      setDiscreet,
      openConfirm: () => setConfirmOpen(true),
    }),
    onConfirm: () => {
      setConfirmOpen(false);
      setDiscreet(false);
    },
    onCancel: () => setConfirmOpen(false),
  };
}

/**
 * 低调模式那一行 + 它的关闭确认。
 * 导出是给 __tests__/preferences-discreet-confirm 直接调用，卡片内部照旧自己用。
 */
export function DiscreetPreference() {
  const { discreet, confirmOpen, onCheckedChange, onConfirm, onCancel } =
    useDiscreetOffConfirm();

  return (
    <>
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
        {/* 开关本体 28px 高，外层撑到 44px 触区 */}
        <div className="flex size-11 shrink-0 items-center justify-center">
          <Switch
            id="discreet-switch"
            checked={discreet}
            onCheckedChange={onCheckedChange}
            aria-label="低调模式"
          />
        </div>
      </div>

      {/* 关着的时候 Radix 不落任何 DOM 节点，所以摆在卡片里也不占位 */}
      <ConfirmDialog
        open={confirmOpen}
        title="关闭低调模式"
        description="关闭后余额等敏感信息将明文显示：金额、公司名和案件标题当场恢复明文，标签页也写回真实标题。随时可以在侧栏或顶栏单击眼睛图标重新开启。"
        confirmLabel="确认关闭，恢复明文显示"
        cancelLabel="保持开启"
        tone="primary"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />
    </>
  );
}

export function PreferencesCard() {
  const router = useRouter();
  const { mode, setMode } = useTheme();
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

          <DiscreetPreference />

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
