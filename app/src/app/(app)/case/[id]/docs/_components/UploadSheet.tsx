'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { DEMO_UPLOAD_DOC_ID, OCR_STEPS } from '@/app/_mock/docs-drafts';
import { AppSheet } from '@/components/shadcn/app-sheet';
import { Button } from '@/components/shadcn/button';
import { Progress } from '@/components/shadcn/progress';
import { useToast } from '@/components/ui/Toast';

/**
 * 上传 → 解读的模拟流程。进度文案是确定的四步，不写「AI 思考中」。
 * 接后端前不落地文件，走完直接跳到样张的解读结果页。
 */
export function UploadSheet({
  open,
  onClose,
  caseId,
}: {
  open: boolean;
  onClose: () => void;
  caseId: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [step, setStep] = useState(-1);

  useEffect(() => {
    if (!open) setStep(-1);
  }, [open]);

  useEffect(() => {
    if (step < 0 || step > OCR_STEPS.length) return;

    if (step === OCR_STEPS.length) {
      const t = setTimeout(() => {
        toast('解读完成，已生成签署建议', 'success', '有一条新的更新');
        onClose();
        router.push(`/case/${caseId}/docs/${DEMO_UPLOAD_DOC_ID}`);
      }, 400);
      return () => clearTimeout(t);
    }

    const t = setTimeout(() => setStep((s) => s + 1), OCR_STEPS[step].ms);
    return () => clearTimeout(t);
  }, [step, caseId, onClose, router, toast]);

  const running = step >= 0;
  const percent = running
    ? Math.round((Math.min(step + 1, OCR_STEPS.length) / OCR_STEPS.length) * 100)
    : 0;

  return (
    <AppSheet open={open} onClose={onClose} title="上传公司给你的文件">
      {!running ? (
        <div className="flex flex-col gap-3">
          <p className="fs-m text-ink-2">
            解除通知、协商协议、调岗通知、PIP、警告信都可以传。拍照拍全整页，四角要在画面里；多页文件一次传多张。
          </p>
          <Button className="w-full" onClick={() => setStep(0)}>
            拍照上传
          </Button>
          <Button variant="secondary" className="w-full" onClick={() => setStep(0)}>
            从文件中选择
          </Button>
          <p className="rounded-[10px] bg-surface-2 px-3 py-2 fs-s text-ink-2">
            当前是演示版本：这里不会真的读取你的相册或文件，会用一份《协商解除劳动合同协议书》样张走完整套解读流程。
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-4 py-2">
          <div>
            <div className="flex items-baseline justify-between gap-3">
              <p className="fs-m font-semibold text-ink">
                {OCR_STEPS[Math.min(step, OCR_STEPS.length - 1)].label}
              </p>
              <span className="num fs-s text-ink-2">{percent}%</span>
            </div>
            <Progress className="mt-2" value={percent} label="解读进度" />
          </div>

          <ol className="flex flex-col gap-2">
            {OCR_STEPS.map((s, i) => {
              const done = i < step;
              const current = i === step;
              return (
                <li
                  key={s.label}
                  className={
                    'flex items-center gap-2.5 fs-m ' +
                    (done || current ? 'text-ink' : 'text-ink-2')
                  }
                >
                  <span
                    aria-hidden
                    className={
                      'flex size-5 shrink-0 items-center justify-center rounded-full fs-xs ' +
                      (done
                        ? 'bg-success text-on-primary'
                        : current
                          ? 'bg-primary text-on-primary'
                          : 'bg-surface-2 text-ink-2')
                    }
                  >
                    {done ? '✓' : i + 1}
                  </span>
                  {s.label}
                </li>
              );
            })}
          </ol>

          <p className="fs-s text-ink-2">
            文件在服务器上加密存放，只有你自己能看到。
          </p>
        </div>
      )}
    </AppSheet>
  );
}
