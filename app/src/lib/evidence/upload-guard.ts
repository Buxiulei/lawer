// app/src/lib/evidence/upload-guard.ts
// 上传路径的两道进程级闸门：单次体积上限（按 mime 分档）+ 并发内存预算。
//
// 【谁在用】三条：POST /api/v1/evidence（证据 multipart）、PUT /api/v1/evidence/upload/{token}
// （一次性地址上传，mime 在签发 token 时就定了）与 POST /api/v1/realname/passport（护照实名，
// 一次两份材料）。它们**共用**这里的常量和这一个信号量，不各开一个池——三条路把字节复制进的
// 是同一块进程内存，各算各的预算等于把 1280M 当 3840M 花，同时占满就直接 OOM。
//
// 【为什么需要】上传一份文件，字节在内存里被复制 4~6 份：
//   req.formData() 缓冲整个请求体 → file.arrayBuffer() → Buffer.from(...) →
//   encryptBuffer() 的密文 → fs.writeFileSync 的写缓冲。
// 应用跑在 cgroup MemoryMax=1280M 里，两个并发的 100MB 上传就足以把进程顶爆被 OOM kill
// ——挂掉的不只是这两个上传，是整站所有人的会话。所以体积和并发都得在路由入口卡住。

/** 一份文件在上传链路里同时存在的内存副本数（见上方链路）。预算算式的乘数。 */
export const UPLOAD_MEMORY_COPIES = 6;

/**
 * 图片 / PDF / 其它类型的单次上传体积上限（字节）。**这一档没变过**。
 *
 * 取 25 MiB 的算式：25 × 6（内存放大倍数）× 4（并发上限）≈ 600 MB 峰值，
 * 加上 Node + Next.js 常驻的约 300~400 MB，仍留出 1280 MB 的三成余量。
 * 合同/工资条/聊天截图的实际分布都在个位数 MB，这一档绰绰有余。
 *
 * 注意 multipart 入口处量的是 Content-Length，它含 multipart 边界与字段头（通常几百字节），
 * 所以有效的文件上限比 25 MiB 略小；formData 之后的后备闸量的才是文件本身。
 */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/**
 * 录音档：100 MiB。取证场景里的录音是「一次谈话」，不是一整天的连续录制——
 * 常见的 64kbps 单声道 mp3 约 0.5 MB/分钟，100 MiB 够放三个多小时。
 */
export const MAX_AUDIO_UPLOAD_BYTES = 100 * 1024 * 1024;

/**
 * 视频档：100 MiB。手机拍的一段谈话录像（1080p 约 10 MB/分钟）大致对应十分钟。
 *
 * ⚠️ **这一档正好占满整份并发预算**：100 × 6 = 600 MB，恰等于下方
 * UPLOAD_MEMORY_BUDGET_BYTES（25 × 6 × 4）。所以并发预算（tryAcquireUploadSlot）对它
 * 仍是「独占」语义——一个视频在传的时候别的上传一律排不进来。
 *
 * 原本这一档是 200 MiB（200 × 6 ≈ 1.2 GB，贴着 cgroup MemoryMax=1280M 的上限跑）；
 * manager 裁决收到 100 MiB，把峰值从「贴上限」降到「预算之内」。真要重新抬回 200 MiB，
 * 得先把上传链路改成边收边写盘（不缓冲整份）——那是另开的单。
 */
export const MAX_VIDEO_UPLOAD_BYTES = 100 * 1024 * 1024;

/** 所有档里最大的那个。mime 未知时（multipart 读到 file 之前）只能按它预判。 */
export const MAX_UPLOAD_BYTES_ANY = MAX_VIDEO_UPLOAD_BYTES;

/**
 * 按 mime 取本次允许的体积上限。
 *
 * **按大类前缀分档，不按具体子类型列白名单**：白名单的形态是「用户传了个 audio/x-m4a，
 * 名单里只有 audio/mpeg，于是一段两小时的录音被当成普通文件卡在 25 MB」——
 * 报错文案还会理直气壮地说「请压缩到 25MB 以内」，而这个文件本来就该走 100 MB 那档。
 *
 * 认不出来的 mime（含空值）走最严的一档：误差方向必须偏向「拦住」，
 * 放宽一档的代价是内存，收紧一档的代价只是用户换个格式重传。
 */
export function maxUploadBytesFor(mime: string | null | undefined): number {
  // `audio/mp4; codecs=...` 这种带参数的头要先切掉分号后面
  const main = (mime ?? '').trim().toLowerCase().split(';')[0].trim();
  if (main.startsWith('video/')) return MAX_VIDEO_UPLOAD_BYTES;
  if (main.startsWith('audio/')) return MAX_AUDIO_UPLOAD_BYTES;
  return MAX_UPLOAD_BYTES;
}

/**
 * 进程同时受理的上传数上限。
 *
 * 4 × MAX_UPLOAD_BYTES × 6 份副本 ≈ 600 MB，是上面那个算式的另一半。
 * 占满时**不排队**：排队等于把待处理的请求体继续攒在内存里，正是这道闸要防的事，
 * 所以直接回 429 让客户端稍后重试。
 */
export const MAX_CONCURRENT_UPLOADS = 4;

/**
 * 并发上传合计可占的内存预算（字节）。就是上面那句话的算式本身。
 *
 * 【为什么光有「最多 4 个」不够了】原来每个上传最大 25 MiB，个数上限等价于内存上限。
 * 加了 audio/video 两档之后不再等价：四个 200 MiB 视频同时进来仍然只算「4 个」，
 * 内存却是 4.8 GB。所以闸门从「数个数」改成「数个数 + 数字节」，两个都不许超。
 */
export const UPLOAD_MEMORY_BUDGET_BYTES =
  MAX_UPLOAD_BYTES * UPLOAD_MEMORY_COPIES * MAX_CONCURRENT_UPLOADS;

let activeUploads = 0;
let reservedBytes = 0;

/**
 * 取一个上传槽位。取到返回释放函数，占满返回 null。
 *
 * `expectedBytes` 是这次上传声明的字节数（Content-Length 或 token 里登记的 size）。
 * 不传按最小档算，于是老调用方（multipart 两条）行为逐字不变。
 *
 * 【超预算的大文件不是永远拒，是独占】一个 200 MiB 视频要 1.2 GB 副本，怎么算都超预算，
 * 按「超了就拒」写的话这一档等于没开。所以规则是：**队列空着时谁都放行，队列非空时
 * 必须装得进剩下的预算**。于是大文件只会自己一个人跑，永远不会和别人叠加。
 *
 * 「查了再加」中间没有 await，Node 单线程跑完这几句不会被别的请求插进来，
 * 所以不需要锁。释放函数自带幂等，重复调用不会把计数放成负数
 * （路由里 finally 释放一次，将来若有人在成功分支再补一次也不会算错）。
 */
export function tryAcquireUploadSlot(expectedBytes: number = MAX_UPLOAD_BYTES): (() => void) | null {
  if (activeUploads >= MAX_CONCURRENT_UPLOADS) return null;
  const want =
    Number.isFinite(expectedBytes) && expectedBytes > 0
      ? expectedBytes * UPLOAD_MEMORY_COPIES
      : MAX_UPLOAD_BYTES * UPLOAD_MEMORY_COPIES;
  if (activeUploads > 0 && reservedBytes + want > UPLOAD_MEMORY_BUDGET_BYTES) return null;
  activeUploads += 1;
  reservedBytes += want;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeUploads -= 1;
    reservedBytes -= want;
  };
}

/** 当前占用的槽位数（给测试与将来的健康检查看，不参与业务判断） */
export function activeUploadCount(): number {
  return activeUploads;
}

/** 当前预留的字节数（同上，只给测试与健康检查） */
export function reservedUploadBytes(): number {
  return reservedBytes;
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
