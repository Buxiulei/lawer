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

// ── 各端点的客户端超时与超时文案 ──
//
// 【为什么必须有】fetch 默认永不超时。sidecar 那侧最坏要串行外呼几十秒（构成见下表），
// 一旦它或它的上游（TSA / CA 的 CRL、OCSP）卡住，无超时的调用就一直挂着：
// 用户的浏览器原样转圈到自己放弃，Next 这边的请求也一直占着不放——千人级并发下这会堆死。
//
// 【怎么定的】一律「sidecar 侧最坏耗时 + 余量」，逐条写明依据，不拍脑袋取整数：
// 定太短会砍掉正在成功的请求（时间戳白申请一次），定太长等于没设。

/** 出证链路（/tsa、/evidence-pdf、/pades）的重试建议——全流程幂等，重发安全 */
const ATTEST_RETRY_ADVICE =
  '稍后重新发起存证即可。出证全流程幂等：已落库的时间戳不会被第二次申请，' +
  '重发只从没做完的那一段续跑（见 evidence/attest.ts 的分段推进）。';

/** 公开复核（/verify）的重试建议——只读，重试无副作用 */
const RECHECK_RETRY_ADVICE = '稍后重试即可。复核是只读操作，不改动任何存证记录，重试没有副作用。';

const ENDPOINT_SPEC = {
  /**
   * 30s：sidecar /tsa 只向 RFC3161 TSA 外呼一次，其自身 timeout=15s
   * （sidecar/rfc3161_timestamp.py request_timestamp 默认值，main.py 未覆盖）。
   * 取 2 倍余量，容纳 TCP 重连与 sidecar 侧排队。
   */
  '/tsa': {
    timeoutMs: 30_000,
    missing: '缺可信时间戳',
    why: 'sidecar 要向 RFC3161 TSA 外呼一次（sidecar 侧自身超时 15 秒），超过这个数说明 TSA 或 sidecar 本身卡住了',
    advice: ATTEST_RETRY_ADVICE,
  },
  /**
   * 30s：/signer 只在本地读一个 pfx 文件并解出证书主体，不外呼（sidecar/pades_sign.py
   * load_signer_info），正常是毫秒级。这 30s 不是给读证书用的，是给 sidecar 被别的请求
   * 排满时的排队时间——砍早了会在出证链路刚起步时就把它掐掉。
   */
  '/signer': {
    timeoutMs: 30_000,
    missing: '缺签章主体名称',
    why: 'sidecar 只在本地读签名证书、不外呼，正常是毫秒级；超这么久通常是 sidecar 被别的请求排满或已假死',
    advice: ATTEST_RETRY_ADVICE,
  },
  /**
   * 60s：/evidence-pdf 是纯本地渲染，不外呼（sidecar/main.py evidence_pdf → build_evidence_pdf）。
   * 正常是秒级；给到 60s 是留给 sidecar 被别的请求排满时的排队时间，不是给渲染本身的。
   */
  '/evidence-pdf': {
    timeoutMs: 60_000,
    missing: '缺《存证证明》PDF',
    why: 'sidecar 在本地渲染 PDF、不外呼，正常是秒级；超这么久通常是 sidecar 被别的请求排满或已假死',
    advice: ATTEST_RETRY_ADVICE,
  },
  /**
   * 90s：/pades 内部串行外呼最坏约 70s——
   *   TSA 2 次 × 15s（pyHanko 要做 estimation + 正式两次，见 sidecar/pades_sign.py 的注释）
   * + 证书链逐张取吊销信息：CRL 10s + OCSP 10s，签名证书与中间 CA 各一遍 = 40s。
   * 必须容得下这 70s，否则会在 sidecar 即将成功时把它砍掉；90s 留 20s 余量给签名与文件 IO。
   */
  '/pades': {
    timeoutMs: 90_000,
    missing: '缺《存证证明》上的数字签名',
    why: 'sidecar 内部串行外呼最坏约 70 秒（TSA 2×15 秒 + 证书链 CRL/OCSP 各 2×10 秒），超过 90 秒说明它或其上游卡住了',
    advice: ATTEST_RETRY_ADVICE,
  },
  /**
   * 30s：/verify 是离线验签，allow_fetching=False、信任锚内置
   * （sidecar/verify_evidence_pdf.py），不外呼，纯 CPU，正常是秒级。
   */
  '/verify': {
    timeoutMs: 30_000,
    missing: '缺验签裁决',
    why: 'sidecar 离线验签（不外呼、信任锚内置），正常是秒级；超这么久通常是 sidecar 被别的请求排满或已假死',
    advice: RECHECK_RETRY_ADVICE,
  },
} as const;

type SidecarEndpoint = keyof typeof ENDPOINT_SPEC;

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

/**
 * 超时是**我方主动中止**，sidecar 那边并没有回过任何 HTTP 状态。
 *
 * status 记 504 只为让既有的分级逻辑照旧工作（attest.ts / recheck.ts 只对 503 特判，
 * 其余一律算上游失败）；message 则完全重写、不套 SidecarError 的「(HTTP xxx)」格式——
 * 印一个 504 出去会让排障的人去 sidecar 日志里找一条根本不存在的记录。
 */
const TIMEOUT_STATUS = 504;

export class SidecarTimeoutError extends SidecarError {
  readonly timeoutMs: number;

  constructor(endpoint: SidecarEndpoint) {
    const spec = ENDPOINT_SPEC[endpoint];
    super(endpoint, TIMEOUT_STATUS, '客户端超时');
    this.name = 'SidecarTimeoutError';
    this.timeoutMs = spec.timeoutMs;
    // 自述三段式：缺什么 / 为什么缺 / 怎么办
    this.message =
      `${spec.missing}：调 sidecar ${endpoint} 等了 ${spec.timeoutMs / 1000} 秒仍无响应，已主动中止。` +
      `为什么：${spec.why}。` +
      `怎么办：${spec.advice}`;
  }
}

/**
 * 打一次 sidecar：带超时、非 2xx 转 SidecarError、响应体一次读完返回字节。
 *
 * 超时覆盖**整次调用**（连接 + 响应头 + 读完响应体），所以读体也放在 try 里：
 * 只掐前半段的话，卡在读体上照样能把调用方挂死，等于白设。
 */
async function callSidecar(endpoint: SidecarEndpoint, init: RequestInit): Promise<Buffer> {
  const signal = AbortSignal.timeout(ENDPOINT_SPEC[endpoint].timeoutMs);
  try {
    const res = await fetch(`${baseUrl()}${endpoint}`, { ...init, signal });
    if (!res.ok) throw await failFrom(endpoint, res);
    return Buffer.from(await res.arrayBuffer());
  } catch (err) {
    // 这条 signal 只有超时会触发，故它一响就确定是超时；别的错（连不上、DNS）原样上抛
    if (signal.aborted) throw new SidecarTimeoutError(endpoint);
    throw err;
  }
}

function parseJson<T>(bytes: Buffer): T {
  return JSON.parse(bytes.toString('utf8')) as T;
}

export interface TimestampResult {
  tstB64: string;
  genTime: string;
  serial: string;
  tsaUrl: string;
}

/** 对一个 SHA-256 申请 RFC3161 可信时间戳 */
export async function requestTimestamp(sha256: string): Promise<TimestampResult> {
  const bytes = await callSidecar('/tsa', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sha256 }),
  });
  const body = parseJson<{
    tst_b64: string;
    gen_time: string;
    serial: string;
    tsa_url: string;
  }>(bytes);
  return {
    tstB64: body.tst_b64,
    genTime: body.gen_time,
    serial: body.serial,
    tsaUrl: body.tsa_url,
  };
}

/**
 * 取签章主体名称（签名证书的 CN）。
 *
 * 《存证证明》抬头印的「签章主体」必须与 Acrobat 签名面板里显示的持有人是同一个名字，
 * 所以只能从证书里读、不能写死：换证之后写死的那个不会报错，只会开始骗人。
 */
export async function fetchSignerCn(): Promise<string> {
  const bytes = await callSidecar('/signer', { method: 'GET' });
  return parseJson<{ signer_cn: string }>(bytes).signer_cn;
}

/** 渲染《存证证明》PDF（未签名）。payload 形状见 sidecar/README.md。 */
export async function renderEvidencePdf(payload: unknown): Promise<Buffer> {
  return callSidecar('/evidence-pdf', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

/** 对 PDF 施加 PAdES-B-LT 签名 */
export async function signPdf(pdf: Buffer): Promise<Buffer> {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(pdf)], { type: 'application/pdf' }), 'evidence.pdf');
  return callSidecar('/pades', { method: 'POST', body: form });
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

  // 200 以外才是「没验成」，与「验了但不通过」是两回事，必须区分（callSidecar 负责抛）
  const verdict = parseJson<VerifyVerdict>(await callSidecar('/verify', { method: 'POST', body: form }));
  return { passed: verdict.overall_ok === true, verdict };
}
