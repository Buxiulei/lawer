'use client';

import { useRef, type ReactNode } from 'react';
import type { UploadSource } from '@/app/_mock/intake-evidence';
import { RealnamePrompt, REALNAME_GATE_OPEN, type RealnameGate } from '@/app/_ui/realname';

/**
 * 三个上传入口。拍照走后置摄像头、录音走麦克风，选文件不限类型——
 * 手机上「相册里的截图」和「文件管理器里的 PDF」是两条完全不同的路，不能只留一个入口。
 *
 * 未实名时（realname.blocked）三个入口一律禁用，上面顶一张提示卡：证据要与本人身份
 * 绑定，未实名的传不进来。**已实名零变化**：用 fragment 兜、提示卡作条件子节点，放行态
 * 顶层就是那张 grid，DOM 与前移实名闸之前逐节点一致——别用常驻外层 div 把它多包一层。
 */
export function UploadBar({
  onPick,
  realname = REALNAME_GATE_OPEN,
}: {
  onPick: (source: UploadSource, file: File) => void;
  realname?: RealnameGate;
}) {
  const blocked = realname.blocked;
  return (
    <>
      {blocked && <RealnamePrompt gate={realname} />}
      <div className={blocked ? 'mt-2 grid grid-cols-3 gap-2' : 'grid grid-cols-3 gap-2'}>
      <PickButton
        label="拍照"
        accept="image/*"
        capture="environment"
        disabled={blocked}
        onPick={(f) => onPick('photo', f)}
        icon={
          <svg viewBox="0 0 24 24" className="size-6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round">
            <path d="M3.5 8.5h3.2l1.4-2.2h7.8l1.4 2.2h3.2v10H3.5z" />
            <circle cx="12" cy="13.2" r="3.2" />
          </svg>
        }
      />
      <PickButton
        label="选文件"
        disabled={blocked}
        onPick={(f) => onPick('file', f)}
        icon={
          <svg viewBox="0 0 24 24" className="size-6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round">
            <path d="M6.5 3.5H14l4 4v13H6.5z" />
            <path d="M14 3.5v4h4" />
          </svg>
        }
      />
      <PickButton
        label="录音"
        accept="audio/*"
        capture
        disabled={blocked}
        onPick={(f) => onPick('audio', f)}
        icon={
          <svg viewBox="0 0 24 24" className="size-6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
            <rect x="9" y="3.5" width="6" height="10" rx="3" />
            <path d="M5.5 11.5a6.5 6.5 0 0013 0M12 18v2.5" />
          </svg>
        }
      />
      </div>
    </>
  );
}

function PickButton({
  label,
  icon,
  accept,
  capture,
  disabled = false,
  onPick,
}: {
  label: string;
  icon: ReactNode;
  accept?: string;
  capture?: boolean | 'environment' | 'user';
  disabled?: boolean;
  onPick: (file: File) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);

  return (
    <>
      <button
        type="button"
        disabled={disabled}
        onClick={() => ref.current?.click()}
        className="flex min-h-[72px] flex-col items-center justify-center gap-1.5 rounded-[12px] border border-line bg-surface text-primary-ink transition-colors duration-150 ease-out hover:bg-surface-2 disabled:pointer-events-none disabled:bg-disabled-surface disabled:text-disabled-ink"
      >
        {icon}
        <span className="fs-s font-medium">{label}</span>
      </button>
      <input
        ref={ref}
        type="file"
        accept={accept}
        capture={capture}
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onPick(file);
          // 允许连续选同一个文件：不清空的话第二次不触发 change
          e.target.value = '';
        }}
      />
    </>
  );
}
