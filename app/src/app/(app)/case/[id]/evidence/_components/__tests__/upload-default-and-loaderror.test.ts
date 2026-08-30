/**
 * 两条小的，都关乎"页面看起来正常但说的不是真话"。
 *
 * P-05：拍照入口的默认类别是「沟通记录」。演示里选的文件叫「解除通知书拍照.jpg」，
 *       Sheet 一打开就替用户把它归进了聊天记录那一类——**后果是证据被错误归类**，
 *       不是观感问题，这份目录是要提交仲裁的。
 * P-06：`/case/999/evidence` 拿到 CASE_NOT_FOUND，卡上却写着「已经上传的材料还在」。
 *       那是替一个根本不存在的案件担保有材料。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EVIDENCE_CATEGORIES,
  EVIDENCE_CHECKLIST,
  UPLOAD_DEFAULT_CATEGORY,
} from '@/app/_mock/intake-evidence';
import { ApiError, NetworkError } from '@/app/_ui/api';
import { loadFailureAdvice, toLoadFailure } from '../EvidenceLibrary';

const SRC = readFileSync(
  join(process.cwd(), 'src/app/(app)/case/[id]/evidence/_components/EvidenceLibrary.tsx'),
  'utf8',
);

describe('上传入口默认类别', () => {
  it('拍照落在「公司文件」——全站文案都把拍照绑在纸质原件上', () => {
    expect(UPLOAD_DEFAULT_CATEGORY.photo).toBe('公司文件');
  });

  it('三个入口的默认值都得是真存在的类别', () => {
    for (const [source, category] of Object.entries(UPLOAD_DEFAULT_CATEGORY)) {
      expect(EVIDENCE_CATEGORIES, source).toContain(category);
    }
  });

  /** 默认值要指到清单里真有东西的一档，否则用户点进去看不到该传什么。 */
  it('默认类别在常见证据清单里有对应条目', () => {
    const covered = new Set(EVIDENCE_CHECKLIST.map((i) => i.category));
    for (const [source, category] of Object.entries(UPLOAD_DEFAULT_CATEGORY)) {
      expect(covered, source).toContain(category);
    }
  });
});

describe('加载失败那张卡的第二句', () => {
  it('案件不存在时，一个字都不许提"材料还在"', () => {
    const advice = loadFailureAdvice('CASE_NOT_FOUND');
    expect(advice).not.toContain('还在');
    expect(advice).not.toContain('材料');
    // 得给出路：案件号抄错，或者链接不是自己账号的
    expect(advice).toMatch(/案件号/);
    expect(advice).toMatch(/登录/);
  });

  it('真的是读取失败时，那句安抚照旧', () => {
    expect(loadFailureAdvice('INTERNAL_ERROR')).toContain('已经上传的材料还在');
    expect(loadFailureAdvice('')).toContain('已经上传的材料还在');
  });
});

/**
 * 上面那组只喂"已经算好的 code"，**证明不了 code 是从异常里取出来的**：
 * 把 catch 里的 `err.errorCode` 换成常量 `''`，上面每一条照旧全绿，
 * 页面上却会退回到「已上传的材料还在」——分支写对了，线没接上。
 *
 * 这一组走的是真正的入口：喂一个后端会抛的 ApiError，一路走到卡上那句话。
 */
describe('catch 到的异常 → 卡上那句话（整条线）', () => {
  it('后端回 CASE_NOT_FOUND 时，code 得真的取出来，那句担保不许出现', () => {
    const failure = toLoadFailure(
      new ApiError('CASE_NOT_FOUND', '找不到这个案件', 404),
    );
    expect(failure.code).toBe('CASE_NOT_FOUND');
    expect(failure.message).toBe('找不到这个案件');

    // 接着往下走一步：卡上真正显示的第二句
    const advice = loadFailureAdvice(failure.code);
    expect(advice).not.toContain('还在');
    expect(advice).not.toContain('材料');
    expect(advice).toMatch(/案件号/);
  });

  it('别的 error_code 原样带下来，仍走通用那一支', () => {
    const failure = toLoadFailure(new ApiError('INTERNAL_ERROR', '服务器开小差了', 500));
    expect(failure.code).toBe('INTERNAL_ERROR');
    expect(loadFailureAdvice(failure.code)).toContain('已经上传的材料还在');
  });

  /** 网络断了没有 error_code：落回 ''，走通用那一支，文案取 NetworkError 自己的话。 */
  it('不是 ApiError 的异常落回空码', () => {
    const failure = toLoadFailure(new NetworkError());
    expect(failure.code).toBe('');
    expect(failure.message).toContain('网络');
    expect(loadFailureAdvice(failure.code)).toContain('已经上传的材料还在');
  });
});

/**
 * 下面两条断的是源码而不是渲染结果：这个组件挂了七八个 hook 和 Provider，
 * 在 node 环境里渲染不起来。写成源码断言是**明知其弱**的取舍——
 * 它挡得住"条件被改回去"，挡不住"条件写对了但渲染另有分支"。
 */
describe('加载失败时的上传入口（源码断言）', () => {
  it('三个上传入口在 loadError 时收起来', () => {
    expect(SRC).toMatch(/!needSignIn\s*&&\s*!loadError\s*&&\s*<UploadBar/);
  });

  it('案件不存在时不给「重新加载」——同一个号再读还是不存在', () => {
    expect(SRC).toMatch(/loadError\.code !== 'CASE_NOT_FOUND'/);
  });
});
