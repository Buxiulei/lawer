// app/src/lib/evidence/media-meta.ts
// 报价要的那个数：图片/PDF 是几页，音频/视频是几秒。
//
// 【为什么不能让调用方传】报价是收钱的依据。让 agent 自报「这段录音 1 分钟」，
// 一段两小时的录音就按 1 分钟收——而两边都不会报错。所以数量一律由服务端从**文件本身**读出来。
//
// 【ffprobe 是同步调用】工具面（lib/capabilities）的 run 是同步的，报价必须在那一步里出数。
// execFileSync 带超时，读的是本地临时文件、不外呼，正常是毫秒级。
// 机器上没有 ffprobe 时**明说没有**，不猜一个时长——猜出来的那个数会被拿去收钱。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** ffprobe 单次调用超时。读本地文件的元数据不外呼，超过这个数说明文件坏了或盘卡住了。 */
const PROBE_TIMEOUT_MS = 20_000;

export class MediaMetaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MediaMetaError';
  }
}

/**
 * PDF 页数。数的是页对象（`/Type /Page`，排除 `/Pages` 页树节点）。
 *
 * 【已知的少数不准】页对象被压进对象流（PDF 1.5 的 ObjStm）时数不到，此时回退成 1 页。
 * 方向是**少收**不是多收：宁可一份 30 页的扫描件按 1 页收钱，也不能把 1 页的收成 30 页。
 * 真出现这种文件时该做的是在这里接一个 PDF 解析库，而不是把回退值调大。
 */
export function countPdfPages(bytes: Buffer): number {
  const text = bytes.toString('latin1');
  const matches = text.match(/\/Type\s*\/Page(?![sA-Za-z])/g);
  return matches && matches.length > 0 ? matches.length : 1;
}

/** 这个 mime 是不是 PDF（上传时 mime 可能缺，故也认文件名后缀）。 */
export function isPdf(mime: string | null, name: string): boolean {
  return mime === 'application/pdf' || name.toLowerCase().endsWith('.pdf');
}

/**
 * 时长（秒）。写一份临时文件给 ffprobe 读，读完即删。
 *
 * suffix 带上原文件的后缀：ffprobe 主要靠内容探测，但有几种容器（如裸 aac / 部分 wav 变体）
 * 给了后缀才认得出来，不给会白白失败一次。
 */
export function probeDurationSeconds(bytes: Buffer, filename: string): number {
  const ext = path.extname(filename).slice(0, 8);
  const tmp = path.join(os.tmpdir(), `lawer-probe-${process.pid}-${Date.now()}${ext}`);
  fs.writeFileSync(tmp, bytes);
  try {
    const out = execFileSync(
      'ffprobe',
      ['-v', 'error', '-print_format', 'json', '-show_format', tmp],
      { timeout: PROBE_TIMEOUT_MS, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
    );
    const duration = Number((JSON.parse(out).format ?? {}).duration);
    if (!Number.isFinite(duration) || duration <= 0) {
      // 自述三段式：缺什么 / 为什么缺 / 怎么办
      throw new MediaMetaError(
        `读不出《${filename}》的时长，无法按分钟报价。` +
          '为什么：ffprobe 认得这个文件，但它的容器里没写时长（流式录制中断常见）。' +
          '怎么办：用播放器另存/转码一次再上传，转码后的文件会带上时长。',
      );
    }
    return duration;
  } catch (err) {
    if (err instanceof MediaMetaError) throw err;
    const code = (err as { code?: string }).code;
    if (code === 'ENOENT') {
      throw new MediaMetaError(
        `无法给《${filename}》报价：本机没有 ffprobe。` +
          '为什么：录音与视频按时长计价，时长只能从文件本身读出来（不接受调用方自报）。' +
          '怎么办：在运行环境安装 ffmpeg（Debian/Ubuntu: apt-get install -y ffmpeg）后重试。',
      );
    }
    throw new MediaMetaError(
      `读《${filename}》的时长失败：${(err as Error).message}。` +
        '为什么：ffprobe 没能解析这个文件，多半是文件损坏或根本不是音视频。' +
        '怎么办：先在本地播一遍确认文件完好，再重新上传。',
    );
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // 临时文件删不掉不影响本次报价，交给系统的临时目录清理
    }
  }
}
