// app/src/lib/lifecycle/zip.ts
// 最小 zip 打包器（只做「存储」不做压缩，method=0）。整案导出用它把档案 JSON、文书与
// 证据原件装成一个文件。
//
// 【为什么自己写，不引一个库】仓里没有任何 zip 依赖，而这份包要装的是用户的证据原件——
// 为一段一百行的确定性字节拼装引一个新依赖，等于把这条路上的信任面扩大一整个包。
// zip 的「存储」形态是 1989 年定死的三段结构，不会变。
//
// 【为什么不压缩】包里绝大多数字节是照片、录音、PDF——它们本来就是压过的，再压一遍
// 省不下什么，却要把每一份原件在内存里再过一遍 deflate。JSON 那几十 KB 不值得为它引入
// 一条会失败、会占 CPU 的路径。
//
// 【UTF-8 文件名】通用位标记第 11 位必须置 1，否则解压方按 CP437 解，中文文件名在 Windows
// 上会解成乱码——而包本身照常打得开，没有任何一处会报错。
import { Buffer } from 'node:buffer';

/** 包里的一个条目。name 用 `/` 分隔目录，不要以 `/` 开头。 */
export interface ZipEntry {
  name: string;
  data: Buffer;
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

/** CRC-32（zip 规范用的那个多项式，与 gzip 同）。 */
export function crc32(buf: Buffer): number {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** JS Date → MS-DOS 的日期/时间两个 16 位字段（zip 头里就这一种时间格式，秒精度取偶数秒）。 */
function dosDateTime(d: Date): { date: number; time: number } {
  // 1980 之前的年份在这个格式里表示不出来；导出包的时间戳恒是「现在」，不会撞上。
  const year = Math.max(1980, d.getFullYear());
  return {
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
  };
}

/**
 * 打一个 zip 包。
 *
 * 【为什么一次性在内存里拼】导出走的是「渲染 → 落 files 表 → 签一次性下载地址」这条既有路，
 * 而 storeBytes 收的本来就是一个完整 Buffer。流式打包要连带把落库那一步改成流式，
 * 收益是一份包不必整份进内存——而那份包的上限由调用方的字节预算管着（见 case-export）。
 */
export function buildZip(entries: readonly ZipEntry[], now: Date = new Date()): Buffer {
  const { date, time } = dosDateTime(now);
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf-8');
    const crc = crc32(entry.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // 本地文件头签名
    local.writeUInt16LE(20, 4); // 解压所需最低版本 2.0
    local.writeUInt16LE(0x0800, 6); // 通用位标记：第 11 位 = 文件名是 UTF-8
    local.writeUInt16LE(0, 8); // 压缩方法 0 = 存储
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.data.length, 18); // 压缩后大小
    local.writeUInt32LE(entry.data.length, 22); // 原始大小（存储法两者相等）
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // 无扩展字段
    locals.push(local, name, entry.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // 中央目录头签名
    central.writeUInt16LE(20, 4); // 打包方版本
    central.writeUInt16LE(20, 6); // 解压所需最低版本
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // 扩展字段长度
    central.writeUInt16LE(0, 32); // 注释长度
    central.writeUInt16LE(0, 34); // 所在分卷
    central.writeUInt16LE(0, 36); // 内部属性
    central.writeUInt32LE(0, 38); // 外部属性
    central.writeUInt32LE(offset, 42); // 本地文件头的偏移
    centrals.push(central, name);

    offset += local.length + name.length + entry.data.length;
  }

  const centralBytes = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // 中央目录结束记录
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // 无注释

  return Buffer.concat([...locals, centralBytes, end]);
}

/** 包里有哪些条目（判据与运维核对用；只读中央目录，不解内容）。 */
export function listZipEntries(zip: Buffer): { name: string; size: number }[] {
  const out: { name: string; size: number }[] = [];
  // 从尾部找中央目录结束记录：注释长度恒为 0，所以它就在最后 22 字节。
  const endOffset = zip.length - 22;
  if (endOffset < 0 || zip.readUInt32LE(endOffset) !== 0x06054b50) {
    throw new Error(
      '这不是一个本模块打出来的 zip：末尾 22 字节不是中央目录结束记录。' +
        '为什么：listZipEntries 只认 buildZip 的产物（无注释、无分卷）。' +
        '怎么办：要读任意 zip 请用解压工具，不要扩张本函数。',
    );
  }
  let p = zip.readUInt32LE(endOffset + 16);
  const count = zip.readUInt16LE(endOffset + 10);
  for (let i = 0; i < count; i += 1) {
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    out.push({
      name: zip.subarray(p + 46, p + 46 + nameLen).toString('utf-8'),
      size: zip.readUInt32LE(p + 24),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
