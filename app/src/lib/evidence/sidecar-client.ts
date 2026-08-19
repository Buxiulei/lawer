// app/src/lib/evidence/sidecar-client.ts
// Python sidecar 的薄客户端。基址取 env SIDECAR_URL（容器内 http://sidecar:8100，
// 不映射宿主端口）。接口形状见 sidecar/README.md 的端点表。
//
// 状态码约定（sidecar 侧）：入参不合法 400/422；依赖未配置（无 key / 无签名证书）503；
// 上游 TSA / DashScope 报错 502。本文件把非 2xx 一律转成 SidecarError 抛出，
// 由 lib/evidence 决定怎么映射成对用户的 DomainFailure。

const DEFAULT_BASE = 'http://127.0.0.1:8100';

function baseUrl(): string {
  return process.env.SIDECAR_URL ?? DEFAULT_BASE;
}

export class SidecarError extends Error {
  readonly status: number;
  readonly endpoint: string;

  constructor(endpoint: string, status: number, detail: string) {
    super(`sidecar ${endpoint} 失败 (HTTP ${status}): ${detail}`);
    this.name = 'SidecarError';
    this.status = status;
    this.endpoint = endpoint;
  }
}

async function failFrom(endpoint: string, res: Response): Promise<SidecarError> {
  let detail = res.statusText;
  try {
    const body = (await res.json()) as { detail?: unknown };
    if (typeof body?.detail === 'string') detail = body.detail;
  } catch {
    // 非 JSON 响应（如反代返回的 HTML 错误页），保留 statusText
  }
  return new SidecarError(endpoint, res.status, detail);
}

export interface TimestampResult {
  tstB64: string;
  genTime: string;
  serial: string;
  tsaUrl: string;
}

/** 对一个 SHA-256 申请 RFC3161 可信时间戳 */
export async function requestTimestamp(sha256: string): Promise<TimestampResult> {
  const res = await fetch(`${baseUrl()}/tsa`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sha256 }),
  });
  if (!res.ok) throw await failFrom('/tsa', res);
  const body = (await res.json()) as {
    tst_b64: string;
    gen_time: string;
    serial: string;
    tsa_url: string;
  };
  return {
    tstB64: body.tst_b64,
    genTime: body.gen_time,
    serial: body.serial,
    tsaUrl: body.tsa_url,
  };
}

/** 渲染《存证证明》PDF（未签名）。payload 形状见 sidecar/README.md。 */
export async function renderEvidencePdf(payload: unknown): Promise<Buffer> {
  const res = await fetch(`${baseUrl()}/evidence-pdf`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw await failFrom('/evidence-pdf', res);
  return Buffer.from(await res.arrayBuffer());
}

/** 对 PDF 施加 PAdES-B-LT 签名 */
export async function signPdf(pdf: Buffer): Promise<Buffer> {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(pdf)], { type: 'application/pdf' }), 'evidence.pdf');
  const res = await fetch(`${baseUrl()}/pades`, { method: 'POST', body: form });
  if (!res.ok) throw await failFrom('/pades', res);
  return Buffer.from(await res.arrayBuffer());
}

/** sidecar /verify 的裁决。字段名保持 sidecar 的下划线原样，便于逐字对照排障。 */
export interface VerifyVerdict {
  file_sha256: string;
  expect_hash: string | null;
  hash_match: boolean | null;
  num_signatures: number;
  signatures: unknown[];
  overall_ok: boolean;
  error: string | null;
}

/**
 * 独立验签。
 *
 * ⚠ sidecar 的 /verify **验签不通过也返回 HTTP 200**，裁决在响应体的 overall_ok。
 * 把 200 当成「验过了」会让无效证据静默通过——仲裁场上会直接害到用户。
 * 故本函数返回的 `passed` 已经是读过 overall_ok 的结论，调用方用它，
 * 不要自己去看 HTTP 状态；完整裁决在 `verdict` 里供展示与排障。
 */
export async function verifyPdf(
  pdf: Buffer,
  expectHash?: string,
): Promise<{ passed: boolean; verdict: VerifyVerdict }> {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(pdf)], { type: 'application/pdf' }), 'signed.pdf');
  if (expectHash) form.append('expect_hash', expectHash);

  const res = await fetch(`${baseUrl()}/verify`, { method: 'POST', body: form });
  // 200 以外才是「没验成」，与「验了但不通过」是两回事，必须区分
  if (!res.ok) throw await failFrom('/verify', res);

  const verdict = (await res.json()) as VerifyVerdict;
  return { passed: verdict.overall_ok === true, verdict };
}
