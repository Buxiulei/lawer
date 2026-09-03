'use client';

import { formatBytes } from '@/app/_ui/format';
import { cn } from '@/components/shadcn/utils';

/**
 * 证件材料的**上传格**。实名认证两条通道共用这一个原语——
 * 谁再要一格「传张照片」就 import 它，**不许自己写 `input[type=file]`**。
 *
 * 【为什么收成一格，而不是原来那颗孤立的「选择照片」小按钮】
 * 原样式里标题、提示、按钮三样各自成行，按钮只有一个词宽，
 * 屏幕上看不出「这块是要我传东西的地方」，也看不出这一格和上一格谁管谁；
 * 电脑上两组各占满一整行，一张卡里塞了两条断裂的流程。
 * 收成一格之后：虚线边＝这里是个坑位，整格可点＝触区从一个词涨到整块，
 * 选中后原地换成缩略图，一格从头到尾只讲一件事。
 *
 * 【缩略图为什么还要给到整格宽】这张预览的唯一用途是让用户自己看出糊没糊、
 * 反光没反光。两格并排之后单格宽度减半（560px 表单里约 270px），
 * 所以图片一律 `w-full` 撑满格子、`object-contain` 不裁边，
 * 高度给到 176px——**别为了让两格更矮再压缩略图**，压到看不出糊就等于没给预览。
 *
 * 【为什么整格是 label 而不是 button】label 关联 input 是浏览器原生的转发，
 * 键盘、辅助技术、移动端相机入口都照旧；换成 button + ref.click() 要自己补一遍，
 * 而且「换一张」若做成 label 里嵌 button，就是把可交互元素套进可交互元素。
 * 所以「换一张」只是格子里的一段视觉指示，点哪儿都等于点这一格。
 */
export function UploadTile({
  id,
  label,
  hint,
  file,
  preview,
  error,
  disabled = false,
  accept = 'image/*',
  onPick,
}: {
  /** input 的 id，同一页里两格不能撞 */
  id: string;
  label: string;
  /** 拍成什么样才算能用——可操作的一行，不是「请上传清晰照片」 */
  hint: string;
  file?: File;
  preview?: string;
  /** 这一格自己的错误（太大、格式不对）：红边 + 一句原因 */
  error?: string;
  disabled?: boolean;
  accept?: string;
  onPick: (file: File | undefined) => void;
}) {
  const picked = Boolean(file);
  return (
    <div className="flex flex-col">
      <label
        htmlFor={id}
        data-upload-tile=""
        data-state={picked ? 'picked' : 'empty'}
        className={cn(
          'flex min-h-[148px] flex-1 cursor-pointer flex-col rounded-[12px] border border-dashed border-line bg-surface p-3.5 transition-colors duration-150 ease-out hover:bg-surface-2',
          picked && 'border-solid',
          error && 'border-solid border-danger-ink bg-danger-wash/40',
          disabled && 'pointer-events-none opacity-60',
        )}
      >
        <span className="text-[15px] font-medium text-ink">{label}</span>

        {picked ? (
          /* 证件影像与文件名都是本人身份信息，低调模式下整块进糊层（按住看清） */
          <span data-veil="" className="mt-2 flex flex-col">
            {preview && (
              <img
                src={preview}
                alt={`${label}预览`}
                className="block h-44 w-full rounded-[8px] border border-line object-contain"
              />
            )}
            <span className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span className="min-w-0 flex-1 truncate text-[13px] leading-5 text-ink-2">
                {file!.name}
              </span>
              <span className="num text-[13px] leading-5 text-ink-2">
                {formatBytes(file!.size)}
              </span>
            </span>
          </span>
        ) : (
          <span className="mt-2 flex flex-1 flex-col items-start justify-center gap-2">
            <CameraIcon />
            <span className="text-[13px] leading-5 text-ink-2">{hint}</span>
          </span>
        )}

        <span className="mt-2 text-[14px] font-medium text-primary-ink underline underline-offset-4">
          {picked ? '换一张' : '点这里选照片'}
        </span>
      </label>

      <input
        id={id}
        type="file"
        accept={accept}
        disabled={disabled}
        className="sr-only"
        onChange={(e) => {
          onPick(e.target.files?.[0]);
          // 允许连着选同一个文件：不清空的话第二次不触发 change
          e.target.value = '';
        }}
      />

      {error && (
        <p className="mt-1.5 text-[13px] leading-5 text-danger-ink">{error}</p>
      )}
    </div>
  );
}

function CameraIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="size-7 text-ink-2"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="round"
    >
      <path d="M3.5 8.5h3.2l1.4-2.2h7.8l1.4 2.2h3.2v10H3.5z" />
      <circle cx="12" cy="13.2" r="3.2" />
    </svg>
  );
}
