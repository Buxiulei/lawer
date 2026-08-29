// app/src/lib/evidence/__tests__/sidecar-timeout.test.ts
// sidecar 客户端的四个端点都必须带超时。
//
// 钉死两件事：
//   1. 每个端点报给 AbortSignal.timeout 的毫秒数就是常量表里那个数——
//      值被谁调小了（把正在成功的请求砍掉）或调大了（等于没设）都会红；
//      /pades 还额外钉「必须容得下 sidecar 内部最坏 70 秒」这条依据本身。
//   2. 超时抛出来的是自述三段式（缺什么 / 为什么 / 怎么办），
//      出证链路那三个还要明说重发安全——否则用户看到的是一句「The operation was aborted」，
//      既不知道该不该重试，也不知道重试会不会重复申请时间戳。
//
// 真实等待被压到 5ms：用例只验「要了多少毫秒」与「超时后抛什么」，不需要真等 90 秒。
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  renderEvidencePdf,
  requestTimestamp,
  SidecarError,
  SidecarTimeoutError,
  signPdf,
  verifyPdf,
} from '@/lib/evidence/sidecar-client';

const REAL_ABORT_TIMEOUT = AbortSignal.timeout.bind(AbortSignal);

/** 被请求过的超时毫秒数，按调用顺序 */
let requestedMs: number[] = [];

/** 拦下 AbortSignal.timeout：记下它被要了多少毫秒，实际只等 5ms */
function stubAbortTimeout(): void {
  requestedMs = [];
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
    requestedMs.push(ms);
    return REAL_ABORT_TIMEOUT(5);
  });
}

/** 假 sidecar：永远不回响应，只在被 abort 时按 undici 的行为抛 signal.reason */
function stubFetchHangs(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          // signal 没传（比如有人把它删了）→ 这个 Promise 永远不 settle，用例超时转红
          signal?.addEventListener('abort', () => reject(signal.reason));
        }),
    ),
  );
}

interface EndpointCase {
  endpoint: string;
  expectedMs: number;
  missing: string;
  /** 出证链路（幂等可重发） vs 公开复核（只读） */
  chain: 'attest' | 'recheck';
  call: () => Promise<unknown>;
}

const CASES: EndpointCase[] = [
  {
    endpoint: '/tsa',
    expectedMs: 30_000,
    missing: '缺可信时间戳',
    chain: 'attest',
    call: () => requestTimestamp('a'.repeat(64)),
  },
  {
    endpoint: '/evidence-pdf',
    expectedMs: 60_000,
    missing: '缺《存证证明》PDF',
    chain: 'attest',
    call: () => renderEvidencePdf({ order_no: 'LAWER-ATT-20260829-0123456789abcdef' }),
  },
  {
    endpoint: '/pades',
    expectedMs: 90_000,
    missing: '缺《存证证明》上的数字签名',
    chain: 'attest',
    call: () => signPdf(Buffer.from('%PDF-1.4 unsigned')),
  },
  {
    endpoint: '/verify',
    expectedMs: 30_000,
    missing: '缺验签裁决',
    chain: 'recheck',
    call: () => verifyPdf(Buffer.from('%PDF-1.4 signed')),
  },
];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('sidecar 客户端超时', () => {
  for (const c of CASES) {
    it(`${c.endpoint} 慢响应 → 按 ${c.expectedMs / 1000} 秒超时，抛自述三段式`, async () => {
      stubAbortTimeout();
      stubFetchHangs();

      const err = await c.call().then(
        () => {
          throw new Error(`${c.endpoint} 居然返回了：慢响应必须超时`);
        },
        (e: unknown) => e,
      );

      expect(err).toBeInstanceOf(SidecarTimeoutError);
      const timeout = err as SidecarTimeoutError;
      expect(timeout.endpoint).toBe(c.endpoint);
      expect(timeout.timeoutMs).toBe(c.expectedMs);
      // 阈值就是常量表那个数，逐端点各不相同，不许悄悄改
      expect(requestedMs).toEqual([c.expectedMs]);

      // 自述三段式：缺什么 / 为什么 / 怎么办
      expect(timeout.message).toContain(c.missing);
      expect(timeout.message).toContain(`等了 ${c.expectedMs / 1000} 秒`);
      expect(timeout.message).toContain('为什么：');
      expect(timeout.message).toContain('怎么办：');
      // 不许套用 SidecarError 的「(HTTP xxx)」格式——sidecar 根本没回过状态码
      expect(timeout.message).not.toContain('HTTP');

      if (c.chain === 'attest') {
        // 明说重发安全，且说清为什么安全（已落库的 TSA 不会重申请）
        expect(timeout.message).toContain('幂等');
        expect(timeout.message).toContain('已落库的时间戳不会被第二次申请');
      } else {
        expect(timeout.message).toContain('只读');
      }
    });
  }

  it('/pades 的阈值必须容得下 sidecar 内部最坏 70 秒串行外呼', async () => {
    // 依据：TSA 2×15s（pades_sign.py 的 HTTPTimeStamper）+ 证书链 CRL/OCSP 各 2×10s。
    // 定成 70 秒以下等于在 sidecar 即将成功时把它砍掉——时间戳白申请一次。
    stubAbortTimeout();
    stubFetchHangs();

    await expect(signPdf(Buffer.from('%PDF-1.4 unsigned'))).rejects.toThrow(SidecarTimeoutError);
    expect(requestedMs[0]).toBeGreaterThan(70_000);
  });

  it('正常路径不受影响：四个端点照常返回，且每次都带了 signal', async () => {
    const seenSignals: (AbortSignal | null | undefined)[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        seenSignals.push(init?.signal);
        const u = String(url);
        if (u.endsWith('/tsa')) {
          return new Response(
            JSON.stringify({
              tst_b64: 'MIILAQYJKoZIhvcNAQcC',
              gen_time: '2026-08-19T03:42:58+00:00',
              serial: '12822790593270748442097240347230746476',
              tsa_url: 'http://aatl-timestamp.globalsign.com/tsa/x',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (u.endsWith('/verify')) {
          return new Response(
            JSON.stringify({
              file_sha256: 'b'.repeat(64),
              expect_hash: null,
              hash_match: null,
              num_signatures: 1,
              signatures: [{ signature_ok: true }],
              overall_ok: true,
              error: null,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response(new Uint8Array(Buffer.from('%PDF-1.4 ok')), { status: 200 });
      }),
    );

    const ts = await requestTimestamp('a'.repeat(64));
    expect(ts.serial).toBe('12822790593270748442097240347230746476');
    expect(ts.tsaUrl).toContain('globalsign');

    expect((await renderEvidencePdf({ order_no: 'X' })).toString()).toBe('%PDF-1.4 ok');
    expect((await signPdf(Buffer.from('%PDF'))).toString()).toBe('%PDF-1.4 ok');

    const verdict = await verifyPdf(Buffer.from('%PDF'));
    expect(verdict.passed).toBe(true);

    expect(seenSignals).toHaveLength(4);
    for (const s of seenSignals) expect(s).toBeInstanceOf(AbortSignal);
  });

  it('非 2xx 照旧是 SidecarError，不是超时错（两类失败别混）', async () => {
    stubAbortTimeout();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ detail: '签名证书未配置' }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' },
          }),
      ),
    );

    const err = await signPdf(Buffer.from('%PDF')).then(
      () => {
        throw new Error('503 居然没抛错');
      },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SidecarError);
    expect(err).not.toBeInstanceOf(SidecarTimeoutError);
    expect((err as SidecarError).status).toBe(503);
    expect((err as SidecarError).message).toContain('签名证书未配置');
  });
});
