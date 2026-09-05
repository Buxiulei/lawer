// app/src/lib/capabilities/families/evidence-write.ts
// B 族的写侧与出证（设计稿 §2 B）。读侧 evidence_list 在 families/evidence.ts。
// 另起文件的理由同 actions-write.ts / deadlines-write.ts：并行窗口不动别人在跑的族文件。
//
// 【这一族的四条是一条链】
//   evidence_upload_url → （HTTP PUT 字节）→ evidence_register → evidence_attest
//   最后 attest_verify 给对方核。
// 中间那步刻意不在 MCP 里：工具入参是 JSON，一段录音塞不进去也不该塞。
import * as cases from '@/lib/cases';
import * as evidence from '@/lib/evidence';
import { EVIDENCE_CATEGORIES } from '@/lib/evidence';
import { maxUploadBytesFor } from '@/lib/evidence/upload-guard';
import {
  attachEvidence,
  findUploadToken,
  issueUploadToken,
  UPLOAD_TOKEN_TTL_MS,
} from '@/lib/evidence/upload-token';

import { caseIdProp, num, writeOnce } from '../shared';
import type { Capability } from '../registry';

const TTL_MINUTES = UPLOAD_TOKEN_TTL_MS / 60_000;

/** 一次 attest 最多几件。见 evidenceAttest 的说明。 */
export const MAX_ATTEST_PER_CALL = 10;

function fail(status: number, errorCode: string, message: string) {
  return { ok: false as const, status, errorCode, message };
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** 上传地址的路径部分。PUBLIC_BASE_URL 配了就拼成绝对地址，没配就只给路径。 */
function uploadUrlFor(token: string): string {
  const path = `/api/v1/evidence/upload/${token}`;
  const base = process.env.PUBLIC_BASE_URL?.trim();
  return base ? `${base.replace(/\/+$/, '')}${path}` : path;
}

export const evidenceUploadUrl: Capability = {
  name: 'evidence_upload_url',
  family: 'evidence',
  scope: 'case:write',
  kind: 'write',
  domains: ['*'],
  exposeTo: ['mcp'],
  precondition: ['realname'],
  title: '取一次性上传地址',
  description:
    '为一份要上传的材料签发一条一次性 PUT 地址与 upload_token。' +
    `拿到之后把**文件字节本身**作为 body PUT 到那条地址（不是表单、不是 JSON、不是 base64），` +
    `再用同一个 upload_token 调 evidence_register 填名称、分类与证明目的。` +
    `地址只收一次文件、${TTL_MINUTES} 分钟内有效，过期或用过都要重新签一条。` +
    '体积上限按 mime 分档：图片与 PDF 25 MB、音频 100 MB、视频 200 MB；' +
    'size 报得超档会在这一步就被拒，不必先把文件传一遍才知道。' +
    '需已完成实名认证。',
  inputSchema: {
    type: 'object',
    properties: {
      ...caseIdProp,
      filename: { type: 'string', description: '文件名，例如 面谈录音.m4a' },
      mime: {
        type: 'string',
        description: '文件的 mime 类型，例如 image/jpeg、application/pdf、audio/m4a、video/mp4。决定体积档位，报不准会按最严的 25 MB 那档算',
      },
      size: { type: 'integer', description: '文件字节数（据实报；服务端收到字节后还会再量一次）' },
    },
    required: ['case_id', 'filename'],
  },
  run: (db, identity, args) => {
    const caseId = num(args.case_id);
    const owned = cases.getCase(db, { caseId, userId: identity.uid, timelineLimit: 1 });
    if (!owned.ok) return owned;

    const filename = str(args.filename);
    if (!filename) return fail(400, 'INVALID_FILENAME', 'filename 不能为空。');
    const mime = str(args.mime);

    const rawSize = args.size === undefined || args.size === null ? 0 : Number(args.size);
    if (!Number.isFinite(rawSize) || rawSize < 0) {
      return fail(400, 'INVALID_SIZE', 'size 必须是非负整数（字节数）。不确定就不要传，别传个猜的数。');
    }
    const size = Math.trunc(rawSize);
    const limit = maxUploadBytesFor(mime);
    // 【超档在签发这一步就拒】等传完再拒，用户白等一次上传；而这个数是他自己报的，
    // 现在就能判。报小了也拦不住——服务端收到字节后按真实大小再量一次。
    if (size > limit) {
      return fail(
        413,
        'FILE_TOO_LARGE',
        `声明的 size 约 ${(size / 1024 / 1024).toFixed(1)} MB，超过 ${mime ?? '该类型'} 单次 ` +
          `${limit / 1024 / 1024} MB 的上限，没有签发上传地址。` +
          '上限按类型分档：图片与 PDF 25 MB、音频 100 MB、视频 200 MB。' +
          '请把文件压小（录音先剪成分段、视频降到 720p）或拆成几份分别上传——拆开传不影响后续出证。',
      );
    }

    const issued = issueUploadToken(db, {
      caseId,
      userId: identity.uid,
      filename,
      mime,
      size,
    });
    return {
      ok: true as const,
      upload_token: issued.token,
      upload_url: uploadUrlFor(issued.token),
      method: 'PUT',
      expires_at: issued.expiresAt,
      max_bytes: limit,
      note:
        `把文件字节直接作为 PUT 的 body 发到 upload_url（带上你现在这把 api key），成功后再调 ` +
        `evidence_register 并带上这个 upload_token。地址只能用一次，${TTL_MINUTES} 分钟后失效。`,
    };
  },
};

export const evidenceRegister: Capability = {
  name: 'evidence_register',
  family: 'evidence',
  scope: 'case:write',
  kind: 'write',
  domains: ['*'],
  exposeTo: ['mcp'],
  precondition: ['realname'],
  idempotency: { clientRef: true },
  title: '登记已上传的材料',
  description:
    '把已经 PUT 上去的字节登记成一条正式条目：填名称、分类、证明目的与原始载体。' +
    '必须先有 evidence_upload_url 签发的 upload_token 且字节已经传完；' +
    '同一个 upload_token 只能登记一条。' +
    `category 只能取：${EVIDENCE_CATEGORIES.join(' / ')}。` +
    'prove_purpose 写"这份材料想证明什么"，日后出证与整理都靠它——' +
    '空着的话，后面谁也说不清当初为什么留这一份。需已完成实名认证。',
  inputSchema: {
    type: 'object',
    properties: {
      ...caseIdProp,
      upload_token: { type: 'string', description: 'evidence_upload_url 给的 token，字节 PUT 完之后用它登记' },
      name: { type: 'string', description: '条目名称，一眼能认出是什么的那种' },
      category: { type: 'string', description: `分类，只能取：${EVIDENCE_CATEGORIES.join(' / ')}`, enum: [...EVIDENCE_CATEGORIES] },
      prove_purpose: { type: 'string', description: '这份材料想证明什么' },
      original_medium: { type: 'string', description: '原始载体，例如 手机拍摄 / 微信导出 / 纸质扫描' },
      client_ref: {
        type: 'string',
        description: '幂等键，一次业务操作给一个稳定值；重试用同一个 ref，服务端不会重复落库',
      },
    },
    required: ['case_id', 'upload_token', 'name'],
  },
  run: (db, identity, args) => {
    const caseId = num(args.case_id);
    const owned = cases.getCase(db, { caseId, userId: identity.uid, timelineLimit: 1 });
    if (!owned.ok) return owned;

    const rawToken = str(args.upload_token);
    if (!rawToken) return fail(400, 'INVALID_UPLOAD_TOKEN', 'upload_token 不能为空。');
    const token = findUploadToken(db, rawToken);
    // 不存在、不是自己的、不是这个案件的 —— 一律同一个错误，能分辨就成了枚举探针
    if (!token || token.user_id !== identity.uid || token.case_id !== caseId) {
      return fail(
        404,
        'UPLOAD_TOKEN_NOT_FOUND',
        '找不到这个 upload_token（也可能它属于另一个案件或另一个账号）。' +
          '请重新调用 evidence_upload_url 取一条新地址，PUT 完文件后再用新 token 登记。',
      );
    }
    if (token.file_id === null) {
      return fail(
        409,
        'UPLOAD_NOT_FINISHED',
        '这个 upload_token 还没收到文件，没有可登记的内容。' +
          '请先把文件字节 PUT 到 evidence_upload_url 给的地址（成功会回 201），再调本工具登记。',
      );
    }
    // 【「已登记过」的判定在 writeOnce 里面，不在外面】放外面的话，带同一个 client_ref 的
    // 重试会先撞上这条 409——而重试本该是幂等命中、回上次那条。两者的差别对调用方很大：
    // 一个是"你重复了，什么都没做"，另一个是"你上次就成功了，这是那一条"。
    // 放进闭包里，withClientRef 命中重放时 exec 根本不跑，这条判定也就不会误伤。
    const outcome = writeOnce(
      db,
      { caseId, tool: 'evidence_register', clientRef: args.client_ref, keyId: identity.keyId ?? null },
      () => {
        // 重新读一次：外面那次读发生在事务之前，中间可能已经被另一次调用登记掉了
        const fresh = findUploadToken(db, rawToken);
        if (fresh && fresh.evidence_id !== null) {
          return fail(
            409,
            'ALREADY_REGISTERED',
            `这个 upload_token 已经登记过了（条目 id=${fresh.evidence_id}），一份上传只登记一条。` +
              '要再建一条条目，请重新取地址并上传一次；' +
              '如果这次只是重试，请带上与上次相同的 client_ref，服务端会直接回上次那条。',
          );
        }
        const res = evidence.registerUploadedFile(db, {
          caseId,
          userId: identity.uid,
          fileId: token.file_id as number,
          name: str(args.name) ?? '',
          category: str(args.category) ?? undefined,
          provePurpose: str(args.prove_purpose),
          originalMedium: str(args.original_medium),
        });
        if (!res.ok) return res;
        attachEvidence(db, token.id, res.evidence.id);
        return res;
      },
      (res) => ({ table: 'evidence', id: res.evidence.id }),
    );
    return outcome;
  },
};

export const evidenceAttest: Capability = {
  name: 'evidence_attest',
  family: 'evidence',
  scope: 'case:write',
  kind: 'write',
  domains: ['*'],
  exposeTo: ['mcp'],
  precondition: ['realname'],
  title: '发起出证固化',
  description:
    '给已登记的条目盖可信时间戳、渲染《存证证明》PDF 并签名，回订单号。' +
    // 【不写「免费」两个字】这是一条会被 agent 原样复述给用户的说明。裸一句「免费」很容易
    // 被读成"接进来之后什么都不花钱"，而网页对话与内容提取都在扣。这里只说这一步的价，
    // 说得越窄越不会被推广到别处。
    '**这一步按 0 公道值计价**，没有报价步骤，也不消耗任何额度。' +
    '幂等：同一条反复发起只会有一个订单号，中途失败原地续跑，不会出第二份证明。' +
    `一次最多 ${MAX_ATTEST_PER_CALL} 件——每件都要走三次外部调用，给多了这次请求会挂很久。` +
    '逐件独立成败：某件失败不影响别件，回包里每件各有各的结果，请照结果逐件复述，不要笼统说"都办好了"。' +
    '需已完成实名认证（证明上要印实名快照）。',
  inputSchema: {
    type: 'object',
    properties: {
      evidence_ids: {
        type: 'array',
        description: `要出证的条目 id，1~${MAX_ATTEST_PER_CALL} 个`,
        items: { type: 'integer' },
      },
    },
    required: ['evidence_ids'],
  },
  run: async (db, identity, args) => {
    const raw = Array.isArray(args.evidence_ids) ? args.evidence_ids : [];
    if (raw.length === 0) {
      return fail(400, 'NO_EVIDENCE_IDS', 'evidence_ids 至少要有一个条目 id。');
    }
    if (raw.length > MAX_ATTEST_PER_CALL) {
      return fail(
        400,
        'TOO_MANY_EVIDENCE_IDS',
        `一次最多 ${MAX_ATTEST_PER_CALL} 件，这次给了 ${raw.length} 件，一件都没有发起。` +
          '这里不替你截断——截断的形态是你以为全都出证了，其实后面几件没有。请自己分批再调。',
      );
    }
    const ids: number[] = [];
    for (const [i, v] of raw.entries()) {
      const n = Number(v);
      if (!Number.isInteger(n) || n <= 0) {
        return fail(400, 'INVALID_EVIDENCE_ID', `第 ${i + 1} 个 evidence_id 不是正整数；本次一件都没有发起。`);
      }
      // 同一个 id 报两遍不算两件：出证本身幂等，去重只是别让回包里出现两行一模一样的结果
      if (!ids.includes(n)) ids.push(n);
    }

    const results = [];
    for (const evidenceId of ids) {
      const res = await evidence.attestEvidence(db, { evidenceId, userId: identity.uid });
      results.push(
        res.ok
          ? {
              evidence_id: evidenceId,
              ok: true as const,
              order_no: res.attestation.order_no,
              status: res.attestation.status,
              tsa_gen_time: res.attestation.tsa_gen_time,
            }
          : {
              evidence_id: evidenceId,
              ok: false as const,
              error_code: res.errorCode,
              message: res.message,
            },
      );
    }
    return {
      ok: true as const,
      results,
      succeeded: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
    };
  },
};

export const attestVerify: Capability = {
  name: 'attest_verify',
  family: 'evidence',
  scope: 'case:read',
  kind: 'read',
  domains: ['*'],
  exposeTo: ['mcp'],
  precondition: [],
  rest: { method: 'GET', path: '/api/v1/verify/{orderNo}' },
  title: '按订单号核验存证',
  description:
    '拿订单号查一份存证记录：哈希、时间戳（签发时刻、序列号、TSA 地址、原始 tst）与条目元数据。' +
    '与公开页 /verify/{订单号} 同一份数据，**不含持证人姓名与证件号**——' +
    '这个接口谁拿到订单号都能查，身份只在《存证证明》PDF 上，由持证人自己出示。' +
    '任何人的订单号都能查，不限于本账号：核验方本来就该不注册账号也能核。',
  inputSchema: {
    type: 'object',
    properties: {
      order_no: { type: 'string', description: '存证订单号，形如 LAWER-ATT-20260905-<16位hex>' },
    },
    required: ['order_no'],
  },
  run: (db, _identity, args) => {
    const orderNo = str(args.order_no);
    if (!orderNo) return fail(404, 'ORDER_NOT_FOUND', '存证订单不存在');
    return evidence.getVerification(db, orderNo);
  },
};
