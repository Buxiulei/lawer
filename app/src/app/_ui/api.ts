'use client';

/**
 * REST 客户端：同源 /api/v1，自动带 Bearer，把后端的错误包翻成可展示的人话。
 *
 * 后端的非流错误形状只有一种（lib/auth/http.ts）：
 *   { ok: false, error_code, message, retry_after? } + 对应 HTTP status
 * 前端按 error_code 分支，不按 status 分支——同一个 error_code 换过 status 也不该改前端。
 */

import { clearToken, readToken } from './auth';
import { markSessionExpired } from './session';

export const API_BASE = '/api/v1';

export class ApiError extends Error {
  constructor(
    readonly errorCode: string,
    message: string,
    readonly status: number,
    readonly retryAfter?: number,
    /**
     * 401 时本机原本有没有 token。构造时就要定下来——handleUnauthorized 会把
     * token 清掉，等到显示文案的时候再去读就永远读成"没登录"了。
     */
    readonly hadToken = false,
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
  FORBIDDEN_SCOPE: () => '当前凭据没有这个权限',
  ATTEST_UNAVAILABLE: () => '存证服务还没就绪，稍后再固化',
  ATTEST_UPSTREAM_FAILED: () => '时间戳服务这次没响应，过一会儿再点一次，已完成的步骤不会重来',
};

/** 任意异常 → 可以直接显示给用户的一句话 */
export function humanError(err: unknown): string {
  if (err instanceof ApiError) {
    // 「从没登录过」和「登录过期了」是两件事，后者才需要解释为什么要重来一遍
    if (err.errorCode === 'UNAUTHORIZED') {
      return err.hadToken ? '登录状态已失效，请重新验证' : '请先登录';
    }
    const custom = COPY[err.errorCode];
    if (custom) return custom(err.retryAfter);
    return err.message || '这一步没成功，稍后再试一次。';
  }
  if (err instanceof NetworkError) return err.message;
  return '这一步没成功，稍后再试一次。';
}

/**
 * 401：token 已经不作数了，就地清掉，登录态 hook 会跟着翻成未登录。
 * 回传清掉之前有没有 token——文案要靠它区分「没登录」和「登录过期」。
 *
 * 【本机原本有 token 时还要立一面旗（F-202）】清掉 token 只让登录态翻成"未登录"，
 * 页面这一刻手里拿着的是一个 catch 到的异常，各自画各自的「重试」——
 * 而重试拿的是同一个坏 token，点不完。旗子由 _ui/session 收着，
 * 案件路由的闸门认它，整块换成「去登录」。它是全站唯一一处置这面旗的地方。
 */
function handleUnauthorized(): boolean {
  const hadToken = readToken() !== null;
  clearToken();
  if (hadToken) markSessionExpired();
  return hadToken;
}

/** 一个响应在登录态上算什么。'ok' 不是 401；其余两支见 classifyAuthStatus。 */
export type AuthVerdict = 'ok' | 'expired' | 'signed-out';

/**
 * **不走 apiFetch 的那条通道也从这道口过**。
 *
 * 【为什么要有它（F-202 复核 MF-1）】「问它」的流式对话收的是 text/event-stream，
 * 用不了 apiFetch，于是它自己写了一句 `if (res.status === 401)`——既不清 token
 * 也不立失效旗，反倒把这一轮回落成演示数据：老用户会话过期之后发一句话，
 * 屏幕上端出来的是**演示案件的案情**当作他的答案。比死循环重试更糟。
 * 现在那句 401 分支改成调这里，清 token 与立旗都只发生在 handleUnauthorized 这一处。
 *
 * 【为什么连状态码判定也收进来】判据（session-single-entry 环④）扫的是
 * case/[id] 子树里还有没有按状态码写的第二处 401 分支。判定收进来之后，
 * 调用方连 401 这个数字都不必写——"下一处自己写"就无处可写了。
 *
 * 返回：'expired' 登录态失效（本机原本有 token）→ 出路归案件路由 layout 上那道闸门；
 *       'signed-out' 本机压根没登录 → 该说「请先登录」/回落演示数据的那一支；
 *       'ok' 不是 401。
 */
export function classifyAuthStatus(status: number): AuthVerdict {
  if (status !== 401) return 'ok';
  return handleUnauthorized() ? 'expired' : 'signed-out';
}

function toApiError(body: unknown, status: number, hadToken = false): ApiError {
  const payload = (body ?? {}) as Record<string, unknown>;
  const code = typeof payload.error_code === 'string' ? payload.error_code : `HTTP_${status}`;
  const message =
    typeof payload.message === 'string' && payload.message
      ? payload.message
      : '这一步没成功，稍后再试一次。';
  const retryAfter = typeof payload.retry_after === 'number' ? payload.retry_after : undefined;
  return new ApiError(code, message, status, retryAfter, hadToken);
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
  const hadToken = classifyAuthStatus(res.status) === 'expired';

  // ok:false 也可能配 200（防守性）：只认响应体，不认状态码
  const failed = !res.ok || (payload as { ok?: unknown } | null)?.ok === false;
  if (failed) throw toApiError(payload, res.status, hadToken);

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
      const hadToken = classifyAuthStatus(xhr.status) === 'expired';
      const failed = xhr.status < 200 || xhr.status >= 300 || (payload as { ok?: unknown } | null)?.ok === false;
      if (failed) {
        reject(toApiError(payload, xhr.status, hadToken));
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
