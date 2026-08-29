// app/src/lib/llm/providers/gate.ts
// 上游调用闸：按 provider 分桶的并发信号量 + 连接期重试。四家共用（openai-compat 三家 + anthropic）。
//
// 【为什么要有】千人级同时在线时，lib/llm 原本是「来多少路就往上游打多少路」。
// 撞上游账户限流后返回的是成批 429，用户侧直接看到 error 帧——而限流是可以排队等过去的，
// 不该让它变成用户可见故障。闸做两件事：把在途路数压在上游能接住的量级内（信号量），
// 把已经撞上的瞬时限流吞掉（连接期重试）。
//
// 【为什么闸在这一层】信号量要与「一条上游连接的生命周期」对齐，而不是与「一次 fetch 调用」对齐：
// SSE 流在 fetch resolve 之后还占着连接几十秒。所以闸位由 provider 的 chatStream 持有到流结束
// （见 openai-compat.ts / anthropic.ts 把 release 并进 sseData 的 onDone），不能包在 fetch 外面了事。
//
// 【重试的边界：结构性保证「流开始后绝不重试」】重试只包住连接阶段（fetch 抛错 / 非 2xx 响应），
// 一旦拿到 2xx + body 就交给解析器，之后任何断流都原样上抛。重试路径**够不到**流内错误，
// 不是靠一个「已出首字节」的布尔量守着——流中途重试会重复计费并给用户重复正文。

import type { ProviderName } from '../types';

/** 单实例、单 provider 的在途上限。
 *  取值理由：三家上游都不公开账户级并发配额（只公开 QPS/TPM），所以这个数拿不到权威依据，
 *  取 32 是保守值——一路会话平均在途约 10s，32 路即约 3 会话/秒的稳态吞吐，
 *  足以覆盖千人级日活（峰值并发远低于注册数），又远低于任何一家常见的限流线。
 *  待线上实测 429 率与排队超时率后校正：429 恒 0 且常排队 → 上调；有 429 → 下调。 */
export const MAX_CONCURRENT_PER_PROVIDER = 32;

/** 排队等闸的上限。超过就不再等——用户在前端已经空等了 30s，
 *  继续排下去只会把「慢」拖成「卡死」，不如立刻给一条可读回执让他重来。 */
export const QUEUE_WAIT_MS = 30_000;

/** 连接期重试次数上限（总请求数 = 1 + 2）。再多就是在给已经过载的上游加压。 */
export const MAX_CONNECT_RETRIES = 2;

/** 指数退避表，下标 = 已失败次数。1s / 4s：够让上游的秒级令牌桶回一格，
 *  两次加起来 5s 也还在「用户觉得这次回答有点慢」而不是「坏了」的区间内。 */
export const RETRY_BACKOFF_MS = [1_000, 4_000];

/** 可重试的 HTTP 状态：429 限流、502/503 上游临时不可用。
 *  其余一律不重试——400/401/402 重试多少次都是同一个答案，只会浪费闸位。 */
const RETRYABLE_STATUS: ReadonlySet<number> = new Set([429, 502, 503]);

/** Retry-After 的采信上限。超过它就不再等着重试，直接把 429 抛给上层：
 *  上游明说「这么久之内别来」时，占着闸位干等会连带饿死排队中的其他用户，
 *  且早已超出用户的等待耐心；此时如实报错比假装还在努力更有用。 */
const RETRY_AFTER_MAX_MS = 10_000;

/**
 * 排队超时。三段式自述：缺什么 / 为什么缺 / 怎么办。
 * status/errorCode 供上层（API 路由）映射响应码用，不在本模块消费。
 */
export class LlmGateBusyError extends Error {
  readonly status = 503;
  readonly errorCode = 'LLM_BUSY';
  /** 可直接展示给用户的一句话（错误正文含容量参数，是给运维看的，不适合直接下发） */
  readonly userMessage = '当前咨询人数较多，请稍后重试';

  constructor(provider: ProviderName) {
    super(
      `缺：${provider} 的上游调用位——等待 ${QUEUE_WAIT_MS / 1000}s 仍未排到（单实例上限 ${MAX_CONCURRENT_PER_PROVIDER} 路并发）。` +
        `原因：同时在跑的模型调用已占满本实例配额；这道闸是为了不把上游打到限流，让成批用户一起失败。` +
        `怎么办：用户侧「当前咨询人数较多，请稍后重试」；` +
        `若该错误持续出现，说明容量不足——加实例，或在确认上游账户并发配额后上调 MAX_CONCURRENT_PER_PROVIDER。`,
    );
    this.name = 'LlmGateBusyError';
  }
}

/** 计数信号量。队列 FIFO：先排的先走，否则高并发下会出现「一直排不上」的饿死。 */
class Semaphore {
  private inFlight = 0;
  private readonly queue: { grant: () => void; timer: ReturnType<typeof setTimeout> }[] = [];

  constructor(
    private readonly limit: number,
    private readonly provider: ProviderName,
  ) {}

  /** 拿一个闸位，返回释放函数（幂等：连接失败与流结束两条路径都会调，多调一次不能把计数扣穿）。
   *  排队超过 QUEUE_WAIT_MS 抛 LlmGateBusyError。 */
  acquire(): Promise<() => void> {
    const makeRelease = () => {
      let done = false;
      return () => {
        if (done) return;
        done = true;
        this.inFlight -= 1;
        this.pump();
      };
    };

    if (this.inFlight < this.limit) {
      this.inFlight += 1;
      return Promise.resolve(makeRelease());
    }

    return new Promise<() => void>((resolve, reject) => {
      const waiter = {
        grant: () => {
          clearTimeout(waiter.timer);
          this.inFlight += 1;
          resolve(makeRelease());
        },
        timer: setTimeout(() => {
          const i = this.queue.indexOf(waiter);
          if (i >= 0) this.queue.splice(i, 1);
          reject(new LlmGateBusyError(this.provider));
        }, QUEUE_WAIT_MS),
      };
      this.queue.push(waiter);
    });
  }

  private pump() {
    if (this.inFlight >= this.limit) return;
    this.queue.shift()?.grant();
  }
}

/** 每个 provider 一个闸。模块级而非实例级：createProvider 刻意不做单例缓存（见 providers/index.ts），
 *  闸挂在实例上等于没闸。 */
const GATES = new Map<ProviderName, Semaphore>();

/** 取一个 provider 的闸位。调用方**必须**在连接失败或流结束时调用返回的释放函数，否则闸位泄漏。 */
export function acquireSlot(provider: ProviderName): Promise<() => void> {
  let gate = GATES.get(provider);
  if (!gate) {
    gate = new Semaphore(MAX_CONCURRENT_PER_PROVIDER, provider);
    GATES.set(provider, gate);
  }
  return gate.acquire();
}

/** Retry-After 头 → 毫秒。两种合法形态：秒数（`120`）与 HTTP-date。解析不出就返回 null，退回固定退避。
 *  先 trim 再判空：HTTP 空白（空格/制表）会被 Headers 规范化掉，但非 HTTP 空白（NBSP、VT）原样留下，
 *  而 `Number('\u00a0'.trim())` 是 0——那会把「上游没说等多久」读成「上游说不用等」，
 *  零退避立刻重发，正好在被限流时给上游加压。 */
function parseRetryAfter(res: Response): number | null {
  const raw = res.headers.get('retry-after')?.trim();
  if (!raw) return null;
  const secs = Number(raw);
  if (Number.isFinite(secs)) return secs >= 0 ? secs * 1000 : null;
  const at = Date.parse(raw);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - Date.now());
}

/** 退避等待。中止信号一到就立刻醒来（否则超时被 4s 退避压在后面才生效）。 */
const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (ms <= 0 || signal.aborted) return resolve();
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });

/**
 * 连接阶段重试。`attempt` 每次发起一次完整请求；返回值语义与直接 fetch 完全一致——
 * **非 2xx 也照样返回 Response**（重试用尽或状态不可重试时），交给调用方原有的 httpError 分支处理，
 * 免得在这里复制一份错误格式化。
 *
 * happy path（首次即 2xx）不产生额外的 I/O 等待：首个 Response 直接返回，既不排队也不退避
 * （多出来的只有 await 本身那一跳微任务）。
 */
export async function connectWithRetry(attempt: () => Promise<Response>, signal: AbortSignal): Promise<Response> {
  for (let failed = 0; ; failed++) {
    let res: Response;
    try {
      res = await attempt();
    } catch (e) {
      // 中止不是「上游不给力」，是我方超时或调用方取消——重试它等于无视超时语义。
      // 这是本函数**唯一**一处中止判断：退避期间被中止时，下一轮 attempt() 会立刻以
      // AbortError 拒绝并在这里被拦下，不必（也不该）再补一次冗余检查——
      // 两处判断谁都能兜住谁，等于两处都可以被改坏而没有测试会红。
      if (failed >= MAX_CONNECT_RETRIES || signal.aborted) throw e;
      await sleep(RETRY_BACKOFF_MS[failed], signal);
      continue;
    }
    if (res.ok || failed >= MAX_CONNECT_RETRIES || !RETRYABLE_STATUS.has(res.status) || signal.aborted) return res;

    const after = res.status === 429 ? parseRetryAfter(res) : null;
    // 上游给的窗口比我们愿意干等的还长 → 不再重试，把这个 429 连同响应体如实交出去
    if (after !== null && after > RETRY_AFTER_MAX_MS) return res;
    // 丢弃的响应体必须显式取消，否则连接不会归还连接池
    await res.body?.cancel().catch(() => {});
    await sleep(after ?? RETRY_BACKOFF_MS[failed], signal);
    // 退避期间被中止：下一轮 attempt() 会以 AbortError 拒绝，走上面的 catch 原样抛出
  }
}
