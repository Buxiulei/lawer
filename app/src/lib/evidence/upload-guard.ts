// app/src/lib/evidence/upload-guard.ts
// 证据上传的两道进程级闸门：单次体积上限 + 并发上传槽位。
//
// 【为什么需要】上传一份文件，字节在内存里被复制 4~6 份：
//   req.formData() 缓冲整个请求体 → file.arrayBuffer() → Buffer.from(...) →
//   encryptBuffer() 的密文 → fs.writeFileSync 的写缓冲。
// 应用跑在 cgroup MemoryMax=1280M 里，两个并发的 100MB 上传就足以把进程顶爆被 OOM kill
// ——挂掉的不只是这两个上传，是整站所有人的会话。所以体积和并发都得在路由入口卡住。

/**
 * 单次上传体积上限（字节）。
 *
 * 取 25 MiB 的算式：25 × 6（内存放大倍数）× 4（并发上限）≈ 600 MB 峰值，
 * 加上 Node + Next.js 常驻的约 300~400 MB，仍留出 1280 MB 的三成余量。
 * 证据本身的实际分布也支持这个值：合同/工资条/聊天截图都在个位数 MB，
 * 唯一可能超的是长录音，那类文件本来就该先剪段再传。
 *
 * 注意入口处量的是 Content-Length，它含 multipart 边界与字段头（通常几百字节），
 * 所以有效的文件上限比 25 MiB 略小；formData 之后的后备闸量的才是文件本身。
 */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/**
 * 进程同时受理的上传数上限。
 *
 * 4 × MAX_UPLOAD_BYTES × 6 份副本 ≈ 600 MB，是上面那个算式的另一半。
 * 占满时**不排队**：排队等于把待处理的请求体继续攒在内存里，正是这道闸要防的事，
 * 所以直接回 429 让客户端稍后重试。
 */
export const MAX_CONCURRENT_UPLOADS = 4;

let activeUploads = 0;

/**
 * 取一个上传槽位。取到返回释放函数，占满返回 null。
 *
 * 「查了再加」中间没有 await，Node 单线程跑完这两句不会被别的请求插进来，
 * 所以不需要锁。释放函数自带幂等，重复调用不会把计数放成负数
 * （路由里 finally 释放一次，将来若有人在成功分支再补一次也不会算错）。
 */
export function tryAcquireUploadSlot(): (() => void) | null {
  if (activeUploads >= MAX_CONCURRENT_UPLOADS) return null;
  activeUploads += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeUploads -= 1;
  };
}

/** 当前占用的槽位数（给测试与将来的健康检查看，不参与业务判断） */
export function activeUploadCount(): number {
  return activeUploads;
}

/**
 * 解析 Content-Length。缺失或不是十进制非负整数一律返回 null
 * ——调用方据此放行到 formData 之后的后备闸，而不是拿一个瞎猜的数去拒人。
 */
export function parseContentLength(raw: string | null): number | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isSafeInteger(n) ? n : null;
}
