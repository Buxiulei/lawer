'use client';

/**
 * 登录态（JWT）的唯一存放处。
 *
 * 全站只有这一份取 token 的实现——_stream/httpTransport 也从这里取，
 * 否则「哪儿算已登录」会随文件不同而漂移。
 *
 * 存 localStorage 而不是 cookie：本站没有服务端渲染的鉴权页，
 * 所有带 token 的请求都由浏览器端发起（含 SSE 与 multipart 上传）。
 */

import { useSyncExternalStore } from 'react';
import { TOKEN_STORAGE_KEY } from './bootstrap';

export { TOKEN_STORAGE_KEY };

const listeners = new Set<() => void>();

/** useSyncExternalStore 要求同一份快照对象/值稳定，故缓存，写入时置脏 */
let cached: string | null = null;
let cacheValid = false;

/** 直接读一次；隐私模式下 localStorage 不可读，按未登录处理 */
export function readToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

function snapshot(): string | null {
  if (!cacheValid) {
    cached = readToken();
    cacheValid = true;
  }
  return cached;
}

function emit(): void {
  cacheValid = false;
  for (const listener of listeners) listener();
}

export function writeToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_STORAGE_KEY, token);
  } catch {
    // 存不下也不阻断本次会话：内存里的 fetch 仍能用刚拿到的 token
  }
  emit();
}

export function clearToken(): void {
  try {
    localStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    // 同上
  }
  emit();
}

function onStorage(e: StorageEvent): void {
  if (e.key === null || e.key === TOKEN_STORAGE_KEY) emit();
}

function subscribe(callback: () => void): () => void {
  if (listeners.size === 0) window.addEventListener('storage', onStorage);
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
    if (listeners.size === 0) window.removeEventListener('storage', onStorage);
  };
}

/** 当前 token；服务端渲染阶段恒为 null（首帧按未登录渲染，水合后纠正） */
export function useAuthToken(): string | null {
  return useSyncExternalStore(subscribe, snapshot, () => null);
}

/** 登录态。注意首帧为 false，别拿它做「不可逆」的跳转判断。 */
export function useSignedIn(): boolean {
  return useAuthToken() !== null;
}
