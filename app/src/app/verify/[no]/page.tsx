import type { Metadata } from 'next';
import {
  fetchVerifyResult,
  readVerdict,
  type VerifyBody,
} from '@/app/_mock/authpay';
import { LampMark } from '@/components/shell/LampMark';
import { VerifyResult } from './_components/VerifyResult';

export const metadata: Metadata = { title: '存证验证' };

/**
 * 公开验证页：无需登录、不套 AppShell，任何人拿到存证编号都能自己核。
 *
 * 红线（DESIGN.md「API 对接约定」，来源 WS2 sidecar 契约）：
 * 真实对接时后端**验签不通过也返回 HTTP 200**，所以判定只能看响应体的 overall_ok，
 * 禁止用 res.ok / 状态码当验证结果。请求异常、JSON 解析失败、字段缺失一律落到
 * 「无法验证」中性态——绝不能因为"没报错"就显示成通过。
 */
export default async function VerifyPage({
  params,
}: {
  params: Promise<{ no: string }>;
}) {
  const { no } = await params;

  let body: unknown = null;
  try {
    body = await fetchVerifyResult(no);
  } catch {
    body = null;
  }

  const verdict = readVerdict(body);
  const fields = (body ?? {}) as Partial<VerifyBody>;

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-[760px] flex-col px-4 py-8 sm:px-6 sm:py-12">
      <header className="border-b border-line pb-5">
        <div className="flex items-center gap-2.5">
          <LampMark className="size-6 text-primary" />
          <span className="text-[15px] font-semibold text-ink">裁员应对专员</span>
        </div>
        <h1 className="mt-4 text-[20px] font-semibold text-ink sm:text-[22px]">
          存证验证
        </h1>
        <p className="num mt-1 text-[15px] break-all text-ink-2">存证编号 {no}</p>
      </header>

      <main className="flex-1 pt-6">
        <VerifyResult no={no} verdict={verdict} body={fields} />
      </main>

      <footer className="mt-10 border-t border-line pt-5 text-[13px] leading-6 text-ink-2">
        <p className="prose-measure">
          结果由平台对存证时的文件哈希、RFC 3161 可信时间戳与证书链重新计算得出。
          需要离线复核的，可凭上面的存证编号向出具方索取原始时间戳令牌自行验签。
        </p>
        <p className="mt-2">本页无需登录，供仲裁庭、用人单位或任何第三方核验。</p>
      </footer>
    </div>
  );
}
