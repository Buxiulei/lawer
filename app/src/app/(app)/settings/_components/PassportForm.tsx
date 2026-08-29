'use client';

import { useEffect, useRef, useState } from 'react';
import { ApiError, apiUpload, humanError } from '@/app/_ui/api';
import { formatBytes } from '@/app/_ui/format';
import { Button } from '@/components/shadcn/button';
import { InputField } from '@/components/shadcn/field';

/**
 * 护照实名通道。**给没有身份证的人用**——阿里云那条刷脸通道只认大陆二代证，
 * 拿护照的人在原来的卡片上是走不下去的，连"为什么走不了"都看不到。
 *
 * 与刷脸通道的根本差别：这条是**人工审核**。提交完不是几秒出结果，而是进「待审」，
 * 所以文案不能沿用刷脸那套「马上就好」的语气。
 */

/** 后端契约：POST /api/v1/realname/passport（multipart） */
interface PassportResponse {
  verification_id: number;
  auth_status: string;
  verification_status: string;
}

/**
 * 错误码 → 人话。后端那四个码都是**用户能自己改**的问题，所以每条都要说清楚改哪儿；
 * 只有 ALREADY_VERIFIED 不是错误，是他已经办完了。
 */
export function submitFailureCopy(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.errorCode) {
      case 'INVALID_PASSPORT_NO':
        return '护照号没通过校验，对着证件资料页再核一遍——字母和数字都要跟上面一致。';
      case 'MISSING_MATERIAL':
        return '两张照片都要传：资料页一张，手持护照一张。';
      case 'INVALID_NAME':
        return '姓名要和护照上的拼写一致（护照上是拼音就填拼音）。';
      case 'ALREADY_VERIFIED':
        return '这个账号已经实名过了，不用再交一次。';
      case 'MATERIAL_TOO_LARGE':
        return '照片太大了，单张不能超过 8MB。用手机相册里的「编辑」压一下，或者拍的时候把分辨率调低一档。';
    }
    /*
     * 上面四个是**用户能自己改**的问题。剩下的服务端故障（端点没上、5xx）要明说是我们的问题——
     * 否则一个刚把护照照片交上去的人，看到「这一步没成功」只会怀疑自己的证件或照片有毛病，
     * 然后一遍遍重拍。同 initFailureCopy 对 REALNAME_INIT_FAILED 的处理。
     * 401/网络错交给 humanError，那两类不是我们的锅、文案也另有一套。
     */
    if (err.status >= 500 || err.status === 404) {
      return '提交没送到我们这边，是我们的问题，不是你的信息或照片有毛病。过一会儿再点一次提交，照片不用重选。';
    }
  }
  return humanError(err);
}

/**
 * 单张上限，与服务端 `passport-realname.ts` 的 `MAX_MATERIAL_BYTES` 同值（8 MiB）。
 * **前端预检不是替服务端把关**（它照样强校验并回 MATERIAL_TOO_LARGE），
 * 而是**别让人用移动数据把几 MB 传完了再被拒**——那是实打实的流量损失。
 * 数值抄自服务端源码，不是照转述；改了那边这里要跟。
 */
const MAX_MATERIAL_BYTES = 8 * 1024 * 1024;

interface Shot {
  key: 'id_page' | 'selfie';
  label: string;
  /** 拍成什么样才算能用——可操作的指引，不是「请上传清晰照片」这种废话 */
  hint: string;
}

const SHOTS: Shot[] = [
  {
    key: 'id_page',
    label: '护照资料页',
    hint: '就是有照片和护照号的那一页。四个角都拍进去，别裁掉边；避开反光，字要能看清。',
  },
  {
    key: 'selfie',
    label: '手持护照自拍',
    hint: '一只手举着翻开的资料页，脸和护照在同一张照片里，两样都要看得清。',
  },
];

export function passportReady({
  realName,
  passportNo,
  hasIdPage,
  hasSelfie,
}: {
  realName: string;
  passportNo: string;
  hasIdPage: boolean;
  hasSelfie: boolean;
}): boolean {
  return (
    realName.trim().length > 0 && passportNo.trim().length > 0 && hasIdPage && hasSelfie
  );
}

export function PassportForm({
  onSubmitted,
  onCancel,
  rejectedMessage,
}: {
  /** 提交成功：外层去刷 status，卡片会切到「审核中」 */
  onSubmitted: () => void;
  onCancel: () => void;
  /** 上一次人工审核没通过时的原因。**打回的人最需要能执行的指引** */
  rejectedMessage?: string;
}) {
  const [realName, setRealName] = useState('');
  const [passportNo, setPassportNo] = useState('');
  const [files, setFiles] = useState<Partial<Record<Shot['key'], File>>>({});
  const [previews, setPreviews] = useState<Partial<Record<Shot['key'], string>>>({});
  const [submitting, setSubmitting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // object URL 用完要还回去，否则这张卡开合几次就攒下一把没释放的大图
  const urls = useRef<string[]>([]);
  useEffect(
    () => () => {
      urls.current.forEach((u) => URL.revokeObjectURL(u));
    },
    [],
  );

  const pick = (key: Shot['key'], file: File | undefined) => {
    if (!file) return;
    // 传之前就拦：8MB 的图在移动数据上传完再被服务端退，那几 MB 是白花的
    if (file.size > MAX_MATERIAL_BYTES) {
      setError(
        `这张 ${formatBytes(file.size)}，超过单张 8MB 的上限。用手机相册里的「编辑」压一下，或者把拍摄分辨率调低一档再选一次。`,
      );
      return;
    }
    const url = URL.createObjectURL(file);
    urls.current.push(url);
    setFiles((prev) => ({ ...prev, [key]: file }));
    setPreviews((prev) => ({ ...prev, [key]: url }));
    setError(null);
  };

  /**
   * **护照号只拦"明显没填"，不做格式正则。**
   * 各国护照号规则不一（纯数字的、字母数字混的、长度 6–9 不等），前端写正则必然
   * 误拒一部分真实护照——**而误拒的代价是用户被自己的证件挡在门外，且他没有申诉入口**。
   * 格式判断交给后端（它有 INVALID_PASSPORT_NO），前端只做非空。
   */
  const ready = passportReady({
    realName,
    passportNo,
    hasIdPage: Boolean(files.id_page),
    hasSelfie: Boolean(files.selfie),
  });

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    setProgress(0);
    try {
      const form = new FormData();
      form.append('real_name', realName.trim());
      form.append('passport_no', passportNo.trim().toUpperCase());
      form.append('id_page', files.id_page!);
      form.append('selfie', files.selfie!);
      await apiUpload<PassportResponse>('/realname/passport', form, {
        onProgress: setProgress,
      });
      onSubmitted();
    } catch (err) {
      setError(submitFailureCopy(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready && !submitting) void submit();
      }}
    >
      {rejectedMessage && (
        <p className="rounded-[10px] bg-amber-wash px-3 py-2.5 text-[14px] leading-6 text-amber-ink">
          上一次没通过：{rejectedMessage}。常见原因是照片糊、有反光、四角没拍全，
          或姓名拼写与护照不一致。重拍时把护照放平、避开顶灯，字能看清就够了。
        </p>
      )}

      <p className="text-[14px] leading-6 text-ink-2">
        护照通道是<span className="font-semibold text-ink">人工审核</span>
        ，提交后一般一到两个工作日出结果，期间不影响你用其他功能。
      </p>

      <InputField
        label="姓名"
        hint="与护照上的一致；护照上是拼音就填拼音"
        autoComplete="name"
        value={realName}
        onChange={(e) => setRealName(e.target.value)}
        maxLength={60}
      />
      <InputField
        label="护照号"
        hint="护照资料页右上角那串"
        inputMode="text"
        autoComplete="off"
        value={passportNo}
        onChange={(e) => setPassportNo(e.target.value.replace(/\s/g, ''))}
        maxLength={20}
      />

      {SHOTS.map((shot) => (
        <ShotPicker
          key={shot.key}
          shot={shot}
          file={files[shot.key]}
          preview={previews[shot.key]}
          disabled={submitting}
          onPick={(f) => pick(shot.key, f)}
        />
      ))}

      {error && (
        <p className="rounded-[10px] bg-amber-wash px-3 py-2.5 text-[14px] leading-6 text-amber-ink">
          {error}
        </p>
      )}

      {submitting && progress > 0 && (
        <p className="num text-[13px] leading-5 text-ink-2">
          正在上传 {Math.round(progress * 100)}%
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={!ready || submitting}>
          {submitting ? '正在提交…' : '提交审核'}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={submitting}>
          用身份证认证
        </Button>
      </div>
    </form>
  );
}

/**
 * 一张照片的选择位。**预览要给到整列宽**——这张预览的唯一用途是让用户自己看出糊没糊，
 * 缩略图大小的预览看什么都清楚，等于没给。同时把文件大小摆出来：
 * 手机直出照片动辄好几 MB，用移动数据的人有权在点提交之前知道这件事。
 */
function ShotPicker({
  shot,
  file,
  preview,
  disabled,
  onPick,
}: {
  shot: Shot;
  file?: File;
  preview?: string;
  disabled: boolean;
  onPick: (file: File | undefined) => void;
}) {
  const inputId = `passport-${shot.key}`;
  return (
    <div>
      <p className="text-[15px] font-medium text-ink">{shot.label}</p>
      <p className="mt-0.5 text-[13px] leading-5 text-ink-2">{shot.hint}</p>

      {preview && (
        <img
          src={preview}
          alt={`${shot.label}预览`}
          className="mt-2 block w-full rounded-[10px] border border-line"
        />
      )}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        {/* label 关联 input：整块都是触区，不用另做一个假按钮 */}
        <label
          htmlFor={inputId}
          className="inline-flex min-h-11 cursor-pointer items-center rounded-[8px] border border-ink px-4 text-[14px] font-medium text-ink"
        >
          {file ? '重新选' : '选择照片'}
        </label>
        <input
          id={inputId}
          type="file"
          accept="image/*"
          disabled={disabled}
          className="sr-only"
          onChange={(e) => onPick(e.target.files?.[0])}
        />
        {file && (
          <span className="num text-[13px] text-ink-2">{formatBytes(file.size)}</span>
        )}
      </div>
    </div>
  );
}
