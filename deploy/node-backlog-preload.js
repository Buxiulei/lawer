'use strict';
/**
 * listen backlog 注入器 —— 用 `node --require` 预载，给**主监听端口**补上 backlog。
 *
 * 【病在哪】Next standalone 的 `server.js` 最终走到
 *   `next/dist/server/lib/start-server.js:431`： `server.listen(port, hostname)`
 * 两个位置参数，**没有第三个 backlog**。Node 此时走
 *   `this._handle.listen(backlog || 511)` ⇒ **backlog 恒为 511**。
 * 生产 `net.core.somaxconn` 已调到 4096，但内核取的是 `min(应用给的, somaxconn)` ——
 * **应用侧不给，somaxconn 调多高都没用**，accept 队列仍是 511 深。
 * 千人级突发（活动/推送/热搜）一次涌入 >511 个未 accept 的连接，内核直接丢 SYN，
 * 客户端表现为"连不上/转圈"，而服务端日志**一行都不会有**（连接没进应用层）。
 *
 * 【为什么不用上游开关】Next 16.2.9 的 `dist/server`、`dist/cli`、`dist/bin` 里
 * （排除 `dist/compiled` 第三方打包）grep `backlog` **零命中** —— 上游既没有 env 也没有参数。
 * 已核实的调用链：
 *   standalone server.js: `parseInt(process.env.PORT,10) || 3000` → `startServer({port})`
 *   → start-server.js:431 `server.listen(port, hostname)`
 *
 * 【为什么是 preload 而不是改 node_modules】改 `node_modules` 或 patch-package：
 * 一次 `npm ci` 就没了，且**丢了不会报错**——回到 511 而无人知晓。预载文件在仓里、
 * 由 systemd 显式引用，缺了会 `MODULE_NOT_FOUND` **硬失败**，不会静默退化。
 *
 * 【为什么只认主端口】进程里不止一个 listen（调试端口、测试用的临时 server、
 * 将来可能的内部探针）。无差别注入 4096 会给一堆根本没有并发压力的 socket
 * 分配内核内存，也让"这个 socket 的 backlog 是谁给的"变得不可追。
 * 只匹配 `PORT`（与 standalone server.js 同一套解析），其余原样放行。
 *
 * 【用法】见同目录 systemd/lawer-app-backlog.conf
 *   NODE_OPTIONS=--require /绝对路径/deploy/node-backlog-preload.js
 * 幂等：重复预载 / 重复 install() 只包一层。
 *
 * 【怎么验】起进程后 `ss -lnt '( sport = :3000 )'`，**Send-Q 列就是生效的 backlog**
 * （LISTEN 态下 Recv-Q=当前排队数、Send-Q=队列上限）。没生效是 511，生效是
 * `min(LISTEN_BACKLOG, net.core.somaxconn)`。
 */

// ── 常量 ──────────────────────────────────────────────────────────────────
/**
 * 缺省 backlog。取 4096 的理由：与生产 `net.core.somaxconn=4096` 对齐。
 * 内核实际用 `min(应用值, somaxconn)`，所以应用值**取到 somaxconn 就够**，
 * 再大只是被截断（不报错、也无收益）；取小则应用侧自己成为新瓶颈。
 */
const DEFAULT_BACKLOG = 4096;

/**
 * PORT 缺省值。**必须与 Next standalone server.js 的 `|| 3000` 一致**——
 * 两边对"主端口是谁"的答案一旦不同，就会出现"注入了，但注在没人听的端口上"，
 * 而这种失败是完全静默的。
 */
const DEFAULT_PORT = 3000;

/**
 * 幂等标记。用 `Symbol.for` 而不是模块级布尔：`--require` 可能以不同路径解析到
 * 两个模块实例（软链、相对/绝对路径混用），模块级变量各记各的 ⇒ 会包两层。
 * 全局符号表是**跨实例**的，标记打在被替换的函数上，谁都看得见。
 */
const INSTALLED = Symbol.for('lawer.listenBacklog.installed');

const net = require('node:net');

// ── 解析 ──────────────────────────────────────────────────────────────────

/**
 * 端口解析。刻意用 `parseInt` 而非 `Number`：**照抄 Next standalone server.js
 * 的 `parseInt(process.env.PORT, 10) || 3000`**。两边解析规则必须字面一致，
 * 否则形如 `PORT=8080x` 时 Next 听 8080、我们瞄 3000，注入静默落空。
 */
function toPort(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const n = parseInt(value, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function targetPort() {
  return toPort(process.env.PORT) ?? DEFAULT_PORT;
}

/**
 * 位置形态下调用方是否**自己给了** backlog（`listen(port[, host[, backlog]][, cb])`
 * 里 host 可省，backlog 因此可能落在第 2 或第 3 位）。逐字照抄 Node net.js 的
 * `backlogFromArgs` / `toNumber`。
 *
 * ⚠️ **这里必须用 `Number` 不能用上面的 `parseInt`**：`parseInt('127.0.0.1', 10) === 127`，
 * 会把 host 当成"调用方已给 backlog"从而整段跳过注入。实测踩到过——
 * 单测看不出来（拦截到的实参本来就没 backlog），是 `ss` 查 Send-Q 才发现没生效。
 */
function callerSuppliedBacklog(args) {
  const toNumber = (x) => ((x = Number(x)) >= 0 ? x : false);
  return Boolean(
    (args.length > 1 && toNumber(args[1])) || (args.length > 2 && toNumber(args[2])) || false
  );
}

/**
 * backlog 解析。这里**故意比端口严格**（只认纯数字串）：端口要跟 Next 对齐所以宽松，
 * 而 LISTEN_BACKLOG 是我们自己的旋钮，`4096x` 这种值宽松吃下去等于把配置错误藏起来。
 */
function resolveBacklog() {
  const raw = process.env.LISTEN_BACKLOG;
  if (raw === undefined || raw === '') return DEFAULT_BACKLOG;
  if (/^\d+$/.test(raw) && Number(raw) > 0) return Number(raw);
  // 不硬失败：这是个调优旋钮，为它拒绝启动会把"连接队列浅一点"升级成"整站不可用"。
  // 但必须吵——静默回退正是本文件要消灭的那种故障。
  console.warn(
    `[lawer/listen-backlog] 缺少可用的 LISTEN_BACKLOG：拿到 ${JSON.stringify(raw)}。\n` +
      `  为什么要有：这个值直接当 listen(2) 的 backlog 用，必须是正整数；` +
      `非法值若被吃下去，accept 队列会悄悄退回 Node 默认 511，突发连接被内核丢 SYN 且不留日志。\n` +
      `  怎么办：把 LISTEN_BACKLOG 设成正整数（建议等于 net.core.somaxconn），` +
      `或直接删掉这个变量用缺省 ${DEFAULT_BACKLOG}。本次已按 ${DEFAULT_BACKLOG} 继续启动。`
  );
  return DEFAULT_BACKLOG;
}

// ── 注入 ──────────────────────────────────────────────────────────────────

/**
 * 把一次 listen 调用的实参改写成带 backlog 的形态；不该动的原样返回**同一个数组**。
 *
 * 位置参数一律转成 options 形态（`listen({port, host, backlog})`）——这正是 Node
 * 内部 `normalizeArgs` 对 `listen(port, host)` 做的事，语义等价，且省掉"backlog 该插第几位"
 * 这种会随可选参数组合出错的算术。`exclusive`/`ipv6Only`/`signal` 只能走 options 形态传，
 * 位置形态本来就带不了，转换不丢东西。
 */
function withBacklog(args) {
  const first = args[0];
  const isOptions = first !== null && typeof first === 'object';
  const port = toPort(isOptions ? first.port : first);

  // 非主端口、以及 unix socket / handle / 端口 0（临时端口）一律不碰。
  if (port === null || port !== targetPort()) return args;

  if (isOptions) {
    // 调用方自己给了 backlog 就尊重它——我们是补缺省，不是抢方向盘。
    if (first.backlog !== undefined && first.backlog !== null) return args;
    return [{ ...first, backlog: resolveBacklog() }, ...args.slice(1)];
  }

  // 同样是"给了就不覆盖"，判定规则见 callerSuppliedBacklog。
  if (callerSuppliedBacklog(args)) return args;

  const options = { port, backlog: resolveBacklog() };
  // 与 Node 一致：位置形态下只有 string 才算 host。
  if (typeof args[1] === 'string') options.host = args[1];
  const last = args[args.length - 1];
  return typeof last === 'function' ? [options, last] : [options];
}

/**
 * 包 `net.Server.prototype.listen`。返回是否真的装上了（已装过则 false）。
 * 只包 net.Server 一处：`tls.Server` 与 `https.Server` 都继承它，一处覆盖全部。
 */
function install() {
  const original = net.Server.prototype.listen;
  if (original[INSTALLED]) return false;

  function listen(...args) {
    return original.apply(this, withBacklog(args));
  }
  listen[INSTALLED] = true;

  net.Server.prototype.listen = listen;
  return true;
}

install();

module.exports = { install, withBacklog, resolveBacklog, targetPort, DEFAULT_BACKLOG, DEFAULT_PORT };
