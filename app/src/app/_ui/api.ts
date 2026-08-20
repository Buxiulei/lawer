'use client';

/**
 * REST 客户端：同源 /api/v1，自动带 Bearer，把后端的错误包翻成可展示的人话。
 *
 * 后端的非流错误形状只有一种（lib/auth/http.ts）：
 *   { ok: false, error_code, message, retry_after? } + 对应 HTTP status
 * 前端按 error_code 分支，不按 status 分支——同一个 error_code 换过 status 也不该改前端。
 */

import { clearToken, readToken } from './auth';

export const API_BASE = '/api/v1';

export class ApiError extends Error {
  constructor(
    readonly errorCode: string,
    message: string,
    readonly status: number,
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** 网络断了/请求被中断，跟「后端说不行」是两回事，文案也不同 */
export class NetworkError extends Error {
  constructor(message = '网络没连上，检查一下再试。') {
    super(message);
    this.name = 'NetworkError';
  }
}

/**
 * 需要覆盖后端 message 的错误码。
 * 后端 message 大多已经是人话，直接用；只有这几条要么太技术、要么需要拼上 retry_after。
 */
const COPY: Record<string, (retryAfter?: number) => string> = {
  RATE_LIMITED: (s) => (s ? `发送太频繁，${s} 秒后再试` : '发送太频繁，稍后再试'),
  SMS_RATE_LIMITED: () => '这个号码今天的验证码已经发满了，明天再试或换个号码',
  SMS_CONFIG_ERROR: () => '短信通道暂时发不出验证码，这是我们这边的问题，稍后再试',
  SMS_SERVICE_DOWN: () => '短信服务暂时不可用，稍后再试',
  SMS_BALANCE_LOW: () => '短信服务暂时不可用，稍后再试',
  EMAIL_SEND_FAILED: () => '邮件没发出去，稍后再试一次',
  OTP_LOCKED: () => '验证码输错太多次了，重新获取一条',
  OTP_EXPIRED: () => '验证码已经失效，重新获取一条',
  OTP_NOT_FOUND: () => '还没收到验证码，先点发送',
  UNAUTHORIZED: () => '登录状态已失效，重新验证手机号',
  FORBIDDEN_SCOPE: () => '当前凭据没有这个权限',
  ATTEST_UNAVAILABLE: () => '存证服务还没就绪，稍后再固化',
  ATTEST_UPSTREAM_FAILED: () => '时间戳服务这次没响应，过一会儿再点一次，已完成的步骤不会重来',
};

/** 任意异常 → 可以直接显示给用户的一句话 */
export function humanError(err: unknown): string {
  if (err instanceof ApiError) {
    const custom = COPY[err.errorCode];
    if (custom) return custom(err.retryAfter);
    return err.message || '这一步没成功，稍后再试一次。';
  }
  if (err instanceof NetworkError) return err.message;
  return '这一步没成功，稍后再试一次。';
}

/** 401：token 已经不作数了，就地清掉，登录态 hook 会跟着翻成未登录 */
function handleUnauthorized(): void {
  clearToken();
}

function toApiError(body: unknown, status: number): ApiError {
  const payload = (body ?? {}) as Record<string, unknown>;
  const code = typeof payload.error_code === 'string' ? payload.error_code : `HTTP_${status}`;
  const message =
    typeof payload.message === 'string' && payload.message
      ? payload.message
      : '这一步没成功，稍后再试一次。';
  const retryAfter = typeof payload.retry_after === 'number' ? payload.retry_after : undefined;
  return new ApiError(code, message, status, retryAfter);
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
  /** 默认带上 token（有的话）；公开接口如 /verify 传 false 也无妨 */
  auth?: boolean;
}

export async function apiFetch<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, signal, auth = true } = options;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (auth) {
    const token = readToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      signal,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new NetworkError();
  }

  const payload = await res.json().catch(() => null);
  if (res.status === 401) handleUnauthorized();

  // ok:false 也可能配 200（防守性）：只认响应体，不认状态码
  const failed = !res.ok || (payload as { ok?: unknown } | null)?.ok === false;
  if (failed) throw toApiError(payload, res.status);

  return payload as T;
}

export interface UploadOptions {
  /** 0..1；fetch 拿不到上传进度，所以这条路走 XHR */
  onProgress?: (ratio: number) => void;
  signal?: AbortSignal;
}

export function apiUpload<T>(
  path: string,
  form: FormData,
  { onProgress, signal }: UploadOptions = {},
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API_BASE}${path}`);
    xhr.setRequestHeader('Accept', 'application/json');
    const token = readToken();
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);

    const onAbort = () => xhr.abort();
    signal?.addEventListener('abort', onAbort);
    const done = () => signal?.removeEventListener('abort', onAbort);

    if (onProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(e.loaded / e.total);
      };
    }

    xhr.onload = () => {
      done();
      let payload: unknown = null;
      try {
        payload = JSON.parse(xhr.responseText);
      } catch {
        payload = null;
      }
      if (xhr.status === 401) handleUnauthorized();
      const failed = xhr.status < 200 || xhr.status >= 300 || (payload as { ok?: unknown } | null)?.ok === false;
      if (failed) {
        reject(toApiError(payload, xhr.status));
        return;
      }
      resolve(payload as T);
    };
    xhr.onerror = () => {
      done();
      reject(new NetworkError());
    };
    xhr.onabort = () => {
      done();
      reject(new DOMException('上传已取消', 'AbortError'));
    };

    xhr.send(form);
  });
}
