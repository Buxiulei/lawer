/**
 * `node-backlog-preload.js` 的测试。
 *
 * 【为什么值得测】这东西的失败形态是**完全静默**的：注入没生效，进程照常起、
 * 健康检查照常绿、日志一行不多，只有真的涌进 >511 个并发连接时才以"用户连不上"
 * 的形式暴露——而那时没人会想到是 backlog。所以**它必须自己证明自己生效**。
 *
 * 【两层判据，缺一不可】
 *   ① 拦截层：装上后底层 listen **实际收到**的实参里有 backlog（快，覆盖各种调用形态）
 *   ② 内核层：真起 socket，`ss` 读 LISTEN 态的 Send-Q（= 队列上限）**印证内核确实收到了**
 * ②不是①的重复。开发这个文件时，①全绿而②是红的：`parseInt('127.0.0.1', 10) === 127`
 * 把 host 误判成"调用方已给 backlog"，整段注入被跳过。**只有内核那层量得出来。**
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import net from 'node:net';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const requireCjs = createRequire(import.meta.url);
const PRELOAD_PATH = fileURLToPath(new URL('./node-backlog-preload.js', import.meta.url));

// 必须在 require 预载**之前**取，否则拿到的是它已经包好的那层，收尾还不回去。
const PRISTINE_LISTEN = net.Server.prototype.listen;
const preload = requireCjs(PRELOAD_PATH) as {
  install(): boolean;
  withBacklog(args: unknown[]): unknown[];
  resolveBacklog(): number;
  targetPort(): number;
  DEFAULT_BACKLOG: number;
  DEFAULT_PORT: number;
};

afterAll(() => {
  // 别把补丁漏给同一 worker 里的别的测试文件。
  net.Server.prototype.listen = PRISTINE_LISTEN;
});

const ENV_KEYS = ['PORT', 'LISTEN_BACKLOG'] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

// ═══ 地板：被打补丁的那个上游调用点，形状必须还是我们以为的那样 ═══════════

describe('地板守卫：上游调用点', () => {
  const START_SERVER = fileURLToPath(
    new URL('../app/node_modules/next/dist/server/lib/start-server.js', import.meta.url)
  );

  it('🔒 Next 的 listen 仍是「无 backlog」形态，本预载仍有存在意义', () => {
    const src = readFileSync(START_SERVER, 'utf8');
    // 这两条一旦转红，说明 Next 升级后改了调用形态或自己支持了 backlog：
    // 请重新核对 withBacklog 是否还匹配得上，或者本文件是否该整个删掉。
    expect(src, 'start-server.js 里找不到 `server.listen(port, hostname)`——上游调用形态变了').toContain(
      'server.listen(port, hostname)'
    );
    expect(
      src.includes('backlog'),
      'start-server.js 里出现了 backlog——上游可能已原生支持，本预载或已多余'
    ).toBe(false);
  });
});

// ═══ ① 拦截层 ═════════════════════════════════════════════════════════════

describe('注入：底层 listen 实际收到的实参', () => {
  const PORT = 39001;
  let seen: unknown[][];

  function installOverSpy() {
    seen = [];
    // 把间谍放在**内层**（先装间谍、再装补丁），这样它看到的是被改写后的实参。
    net.Server.prototype.listen = function spy(this: net.Server, ...args: unknown[]) {
      seen.push(args);
      return this;
    } as typeof net.Server.prototype.listen;
    expect(preload.install(), 'install() 应当报告"这次真的装上了"').toBe(true);
  }

  beforeEach(() => {
    process.env.PORT = String(PORT);
    delete process.env.LISTEN_BACKLOG;
    installOverSpy();
  });
  afterEach(() => {
    net.Server.prototype.listen = PRISTINE_LISTEN;
  });

  it('主端口 + host（Next standalone 的真实形态）→ 注入 backlog=4096', () => {
    // ⚠️ 这条就是那个真 bug 的回归测试：host 是点分四段的字符串，
    // 用 parseInt 判"调用方是否已给 backlog"会把 '127.0.0.1' 读成 127 而整段跳过注入。
    new net.Server().listen(PORT, '127.0.0.1');
    expect(seen).toHaveLength(1);
    expect(seen[0][0]).toEqual({ port: PORT, host: '127.0.0.1', backlog: 4096 });
  });

  it('主端口 + 0.0.0.0（生产实际监听地址）→ 注入', () => {
    new net.Server().listen(PORT, '0.0.0.0');
    expect(seen[0][0]).toEqual({ port: PORT, host: '0.0.0.0', backlog: 4096 });
  });

  it('回调被原样带过去，不被吞掉', () => {
    const cb = () => {};
    new net.Server().listen(PORT, '0.0.0.0', cb);
    expect(seen[0][0]).toMatchObject({ port: PORT, backlog: 4096 });
    expect(seen[0][1]).toBe(cb);
  });

  it('options 形态也注入，且不改动调用方自己的对象', () => {
    const opts = { port: PORT, host: '0.0.0.0', ipv6Only: true };
    new net.Server().listen(opts);
    expect(seen[0][0]).toEqual({ port: PORT, host: '0.0.0.0', ipv6Only: true, backlog: 4096 });
    expect(opts, '调用方传进来的对象被就地改写了').not.toHaveProperty('backlog');
  });

  it('**不碰**别的端口：同进程里其它 listen 原样放行', () => {
    new net.Server().listen(PORT + 1, '127.0.0.1');
    expect(seen[0]).toEqual([PORT + 1, '127.0.0.1']);
  });

  it('**不覆盖**调用方显式给的 backlog（位置形态与 options 形态各一）', () => {
    new net.Server().listen(PORT, '127.0.0.1', 77);
    expect(seen[0]).toEqual([PORT, '127.0.0.1', 77]);
    new net.Server().listen({ port: PORT, backlog: 88 });
    expect(seen[1]).toEqual([{ port: PORT, backlog: 88 }]);
  });

  it('unix socket / 端口 0 一律不碰（它们没有"主端口"这回事）', () => {
    new net.Server().listen('/tmp/lawer-test.sock');
    new net.Server().listen(0, '127.0.0.1');
    expect(seen[0]).toEqual(['/tmp/lawer-test.sock']);
    expect(seen[1]).toEqual([0, '127.0.0.1']);
  });

  it('幂等：重复 install 只包一层', () => {
    const afterFirst = net.Server.prototype.listen;
    expect(preload.install(), '第二次 install 应当报告"已经装过了"').toBe(false);
    expect(net.Server.prototype.listen).toBe(afterFirst);
    new net.Server().listen(PORT, '127.0.0.1');
    expect(seen, '包了两层的话 spy 会收到两次').toHaveLength(1);
  });
});

// ═══ 取值规则 ═════════════════════════════════════════════════════════════

describe('取值', () => {
  it('PORT 的解析跟 Next standalone 一致（含缺省 3000）', () => {
    delete process.env.PORT;
    expect(preload.targetPort()).toBe(3000);
    process.env.PORT = '8080';
    expect(preload.targetPort()).toBe(8080);
    // 唯一能区分 parseInt 与 Number 的输入：parseInt('8080x')===8080、Number('8080x')===NaN。
    // 不验这条，"跟 Next 一致"就只是注释里的话——把 toPort 改成 Number 上面两条照样绿，
    // 而线上会变成 Next 听 8080、我们瞄 3000，注入静默落空。
    process.env.PORT = '8080x';
    expect(preload.targetPort(), 'toPort 必须与 Next 的 parseInt 同答，不能换 Number').toBe(8080);
  });

  it('LISTEN_BACKLOG 缺省 4096、可被合法值覆盖', () => {
    delete process.env.LISTEN_BACKLOG;
    expect(preload.resolveBacklog()).toBe(4096);
    process.env.LISTEN_BACKLOG = '1024';
    expect(preload.resolveBacklog()).toBe(1024);
  });

  it('LISTEN_BACKLOG 非法时回退 4096，并且**吵**（自述三段式）', () => {
    const warned: string[] = [];
    const orig = console.warn;
    console.warn = (...a: unknown[]) => void warned.push(a.join(' '));
    try {
      for (const bad of ['0', '-1', 'abc', '4096x', '1e4']) {
        process.env.LISTEN_BACKLOG = bad;
        expect(preload.resolveBacklog(), `LISTEN_BACKLOG=${bad} 应当回退`).toBe(4096);
      }
    } finally {
      console.warn = orig;
    }
    expect(warned).toHaveLength(5);
    // 静默回退正是这个文件要消灭的故障形态，所以"有没有喊"本身是判据。
    expect(warned[0]).toContain('LISTEN_BACKLOG');
    expect(warned[0], '缺什么').toMatch(/缺少可用的/);
    expect(warned[0], '为什么缺').toMatch(/为什么要有/);
    expect(warned[0], '怎么办').toMatch(/怎么办/);
  });
});

// ═══ ② 内核层：真 socket + ss ══════════════════════════════════════════════

/** `ss -lnt` 里 LISTEN 行的 Send-Q 列 = 该监听 socket 的 accept 队列上限（即生效的 backlog）。 */
function listenBacklogFromSs(port: number): number {
  const out = execFileSync('ss', ['-lnt', `( sport = :${port} )`], { encoding: 'utf8' });
  const row = out.split('\n').find((l) => l.startsWith('LISTEN'));
  if (!row) throw new Error(`ss 没看到 :${port} 的 LISTEN 行，实际输出：\n${out}`);
  return Number(row.trim().split(/\s+/)[2]);
}

/** 借内核分一个空闲端口再还回去。必须等 'listening'——listen 是异步的，之前 address() 拿到 null。 */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

/**
 * 起一个只管 listen 的子进程，READY 后把控制权交回来；回调结束即杀掉。
 *
 * `env` 是**要额外叠加的几个变量**，不是一整份环境，所以类型只能是
 * `Record<string, string>`：本仓 `NodeJS.ProcessEnv` 被 Next 的 env 类型收窄成
 * 带必填键（NODE_ENV），传 `{ LISTEN_BACKLOG }` / `{}` 会直接 TS2345 编译不过。
 */
async function withListeningChild(
  env: Record<string, string>,
  args: string[],
  fn: (port: number) => void
): Promise<void> {
  const port = await freePort();
  const child = spawn(
    process.execPath,
    [
      ...args,
      '-e',
      `require('net').createServer().listen(${port}, '127.0.0.1', () => console.log('READY'));`,
    ],
    { env: { ...process.env, ...env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('子进程 10s 内没有 READY')), 10_000);
      child.stdout.on('data', (d: Buffer) => {
        if (d.toString().includes('READY')) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.on('error', reject);
      child.on('exit', (code) => reject(new Error(`子进程提前退出，code=${code}`)));
    });
    fn(port);
  } finally {
    child.kill('SIGKILL');
  }
}

function somaxconn(): number | null {
  try {
    return Number(readFileSync('/proc/sys/net/core/somaxconn', 'utf8').trim()) || null;
  } catch {
    return null;
  }
}

const NODE_DEFAULT_BACKLOG = 511; // Node 的 `this._handle.listen(backlog || 511)`
const SOMAXCONN = somaxconn();
const HAS_SS = (() => {
  try {
    execFileSync('ss', ['-V'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

/**
 * 探针值刻意取在 somaxconn **以下**。
 *
 * 【为什么不直接验 4096】内核实际生效的是 `min(应用给的, somaxconn)`。生产
 * somaxconn=4096，但**本机通常远小于它**（开发机实测 128），那里验 4096 会得到
 * 128，而"没生效"的 511 同样被截成 128——**两种情况读数一模一样，等于没验**。
 * 取一个低于 somaxconn 的值，注入生效与否读数就分得开，从而真正证明
 * "我们给的数确实一路走到了 listen(2)"。至于 4096 本身，由上面的拦截层负责。
 */
const PROBE_BACKLOG = SOMAXCONN ? Math.max(8, Math.floor(SOMAXCONN / 2)) : 0;
const CONTROL_BACKLOG = SOMAXCONN ? Math.min(NODE_DEFAULT_BACKLOG, SOMAXCONN) : 0;
const KERNEL_CHECK_USABLE = HAS_SS && SOMAXCONN !== null && PROBE_BACKLOG < CONTROL_BACKLOG;

describe('内核层印证（真 socket + ss 读 Send-Q）', () => {
  it.skipIf(!KERNEL_CHECK_USABLE)(
    '预载后，内核收到的 backlog 就是 LISTEN_BACKLOG（对照组是 Node 默认 511）',
    async () => {
      let injected = -1;
      let control = -1;
      await withListeningChild({ LISTEN_BACKLOG: String(PROBE_BACKLOG) }, ['--require', PRELOAD_PATH], (p) => {
        injected = listenBacklogFromSs(p);
      });
      await withListeningChild({}, [], (p) => {
        control = listenBacklogFromSs(p);
      });

      expect(control, `对照组（无预载）应为 min(511, somaxconn=${SOMAXCONN})`).toBe(CONTROL_BACKLOG);
      expect(injected, `注入组应为 LISTEN_BACKLOG=${PROBE_BACKLOG}`).toBe(PROBE_BACKLOG);
      // 地板：两组读数必须真的不同，否则这条测试无论补丁在不在都会绿。
      expect(injected).not.toBe(control);
    },
    30_000
  );

  it('跳过时要说清为什么跳过（不许无声无息地少验一层）', () => {
    if (KERNEL_CHECK_USABLE) return;
    const why = !HAS_SS
      ? '本机没有 ss（iproute2）'
      : SOMAXCONN === null
        ? '读不到 /proc/sys/net/core/somaxconn（非 Linux？）'
        : `somaxconn=${SOMAXCONN} 太小，探针值与对照值区分不开`;
    console.warn(
      `[node-backlog-preload.test] 跳过内核层印证：${why}。\n` +
        `  为什么要有：拦截层只证明实参改对了，证明不了内核真的收到——两者差过一次真 bug。\n` +
        `  怎么办：在装了 iproute2 且 net.core.somaxconn > 16 的 Linux 上重跑本文件。`
    );
    expect(why.length).toBeGreaterThan(0);
  });
});
