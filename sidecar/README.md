# sidecar —— lawer 的 Python 侧服务（FastAPI）

承担 Next.js 侧不便做的五类活：**RFC3161 可信时间戳**、**PAdES 电子签名与验签**、
**《存证证明》PDF 渲染**、**OCR / 录音转写**、**视频抽音轨与关键帧**。
仅内网监听，只由 app 调用，不对公网暴露。

脚本主体从 NBDpsy 移植（`rfc3161_timestamp.py` / `pades_sign.py` / `gen_evidence_pdf.py` /
`verify_evidence_pdf.py` / `trust_anchors/`），改名不改逻辑；每个脚本都保留原 CLI 入口，
便于人工排障与第三方离线复核。

## 目录

```
sidecar/
  main.py                  FastAPI 应用（薄：校验 → 调函数 → 返回）
  rfc3161_timestamp.py     RFC3161 时间戳客户端（request_timestamp）
  pades_sign.py            PAdES-B-LT 签名 + LTV（sign_pdf_file）
  gen_evidence_pdf.py      《存证证明》PDF 渲染（build_evidence_pdf）
  verify_evidence_pdf.py   独立 PAdES 密码学验签（verify_pdf）
  ocr.py                   DashScope Qwen-VL OCR
  asr.py                   DashScope Paraformer 转写 + 说话人分离
  video.py                 ffmpeg 抽音轨（16k 单声道 wav）与关键帧 JPEG
  trust_anchors/           离线验签信任锚（CFCA 签名根 / GlobalSign 时间戳根）
  tests/                   端点单测（全离线）
```

## 本地起服务

```bash
cd sidecar
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cp .env.example .env          # 填 DASHSCOPE_API_KEY、SIGNING_CERT_* 等
set -a && . ./.env && set +a  # 加载环境变量
.venv/bin/python main.py      # 默认 127.0.0.1:8100
```

也可用 uvicorn 直接起（改端口/开热重载）：

```bash
.venv/bin/uvicorn main:app --host 127.0.0.1 --port 8100 --reload
```

生产由 `deploy/docker-compose.yml` 起容器，容器内监听 `0.0.0.0:8100`，
**不映射宿主端口**，只在 compose 内网经服务名 `http://sidecar:8100` 可达。

## 测试

```bash
.venv/bin/python -m pytest tests -q
```

`tests/test_video.py` 会用 ffmpeg 现场合成一段 5 秒测试视频（`testsrc` 彩条 + 440Hz 正弦音，
编码器用内置的 `mpeg4`/`aac`，不依赖发行版有没有编进 libx264）跑 `/video`，
断言时长、帧数上限、wav 的 16k 单声道。**没装 ffmpeg 的机器上这些用例 skip 并说明原因**；
纯函数（抽帧时间点）与「缺 ffmpeg 应 503」两条不依赖 ffmpeg，任何机器都跑。

单测全离线（TSA 调用打桩），覆盖：`/tsa` 哈希入参校验与上游失败映射、
`/evidence-pdf` → `/verify` 回环（未签名件必须判不通过）、哈希不符检测、
未配 key/证书时的 503 降级、`/signer` 读证书主体（用例内现造自签 pfx，**不碰真实证书**）。

`/evidence-pdf` 那条断言会用 `pypdf` 把生成的 PDF 抽成文本再核对字面
（reportlab 的中文在 PDF 里是 TTF 子集的字形号，不解 ToUnicode 就搜不到）。

## 端点

| 方法 | 路径 | 入参 | 出参 |
|---|---|---|---|
| GET | `/health` | — | `{"ok":true}` |
| POST | `/tsa` | JSON `{sha256, tsa_url?, timeout?}` | `{tst_b64, gen_time, serial, tsa_url}` |
| POST | `/pades` | multipart `file`(PDF), `reason?`, `location?` | 签名后 PDF（头 `X-Source-Sha256`） |
| GET | `/signer` | — | `{signer_cn, signer_org, not_before, not_after, serial}` |
| POST | `/evidence-pdf` | JSON 存证元数据（见下） | 《存证证明》PDF（未签名） |
| POST | `/verify` | multipart `file`(PDF), `expect_hash?` | 裁决 JSON |
| POST | `/ocr` | multipart `file`(图片), `prompt?` | `{text, model, request_id}` |
| POST | `/asr` | multipart `file`(音频), `speaker_count?` | `{text, sentences[], model, task_id}` |
| POST | `/video` | multipart `file`(视频), `max_frames?`, `frame_interval_s?` | `{duration_s, audio_wav_b64, frames[], probe}` |

状态码约定：入参不合法 `400/422`；依赖未配置（无 key、无签名证书、无 ffmpeg）`503`；
上游（TSA / DashScope）报错 `502`；超体积/时长上限 `413`。

**`/verify` 例外**：验签不通过不算 HTTP 错误，一律 `200` 返回裁决，
调用方读 `overall_ok`。这是刻意设计——「没验成功」与「验了但不通过」必须可区分。

裁决里失败原因给两个字段：`error_code`（稳定错误码，机器读；码表见
`verify_evidence_pdf.py` 的「对外错误分级」）与 `error`（人读文案）。
`/verify/:no` 是匿名公开页，故 `error` 里只有静态安全原因原文或安全概述，
**不含服务器路径与异常原文**——那些只进 sidecar 日志
（logger `sidecar.verify_evidence_pdf`，`ERROR` 级，带 traceback）。
app 侧要给用户看具体原因，按 `error_code` 做白名单投影，不要正则匹配 `error` 文案。
码的**字面值**是跨进程契约（`tests/test_verify_error_sanitize.py` 里冻结成表逐个钉死）：
改文案不改码；真要增删码，改冻结表的那一下就是提醒——app 侧白名单得同步，否则前端只剩「未知原因」。

### `/evidence-pdf` payload 形状

字段对齐 spec §7 的 `attestations` / `evidence` / `files` 三张表：

**必填四项，缺任一项 400，不兜底**：`order_no`、`issuer`、`signer_cn`、`evidence.sha256`。
> `signer_cn` 是**签章主体**（签名证书的 CN），抬头印成「签章主体：<CN>（出证平台运营主体）」，
> 第五节声明④「本 PDF 由 <CN> 持有的机构实名证书施加 PAdES-B-LT 数字签名」也用它。
> 调用方应先 `GET /signer` 从证书里取，**不许写死**：读者在 Acrobat 里点开签名看到的就是证书 CN，
> 换证之后写死的那个不会报错，只会开始和签名面板对不上——而发现的人是拿着这份证去仲裁的劳动者。
> `issuer` 曾经有过一个写死的兜底品牌名（2026-08-27 移除）。它回答的是**「这张证是谁出的」**，
> 而这份 PDF 用户可能拿去仲裁庭——**兜底不是"少显示一点信息"，是替调用方编了一个答案，
> 而且编得像真的。** 唯一调用方 `lib/evidence/attest.ts` 无条件传它，
> 所以它缺失只可能意味着调用方坏了或来了条我们不知道的路径——**那正是最该报出来的时刻。**
> 守在 HTTP 层与 `build_evidence_pdf` 内部**两处**：后者是模块 docstring 里写明的公开入口（含 CLI），
> 只守 HTTP 层等于让这条保证依赖"调用方走了哪条路"。

```json
{
  "order_no": "LAWER-ATT-20260819-000042",
  "generated_at": "2026-08-19T11:45:00+08:00",
  "issuer": "lawer 土八鼠",
  "signer_cn": "<签名证书的 CN，由 GET /signer 取>",
  "verify_url": "https://<域名>/verify/LAWER-ATT-20260819-000042",
  "status": "stamped",
  "holder": {
    "real_name": "张三",
    "id_card_masked": "1101**********1234",
    "auth_status": "已实名",
    "verified_at": "2026-08-18T09:00:00+08:00"
  },
  "evidence": {
    "case_title": "张三与某某科技有限公司劳动争议",
    "name": "解除劳动合同通知书.jpg",
    "category": "公司文件",
    "prove_purpose": "证明公司于2026-08-01单方解除劳动合同",
    "original_medium": "手机拍照",
    "mime": "image/jpeg",
    "file_size": 2345678,
    "uploaded_at": "2026-08-18T10:00:00+08:00",
    "sha256": "<64位hex>"
  },
  "timestamp": {
    "gen_time": "2026-08-19T03:42:58+00:00",
    "serial": "12822790593270748442097240347230746476",
    "tsa_url": "http://aatl-timestamp.globalsign.com/tsa/...",
    "tst_b64": "<TST 的 base64，随文附录，供离线复核>"
  }
}
```

实名快照由 app 侧从 `user_realname_snapshot_enc` 解密后传入；
**sidecar 不接触密钥、不落库、不留临时文件**（临时文件在请求结束时随
`TemporaryDirectory` 删除）。

生成的是未签名 base PDF，上层应接着调 `/pades` 施加签名，再落 `files` 表。

### `/video` 抽音轨与关键帧

一段录像先在这里拆开，再分别喂给已有的两个端点：**wav → `/asr` 转写，帧 → `/ocr` 认字**。
本端点自己不调任何云服务，只 `subprocess` 调系统 `ffmpeg` / `ffprobe`
（**不装 av / moviepy / opencv**：ffmpeg 本来就是部署环境要装的系统包，
多一层 Python 绑定只是多一份要跟着 ffmpeg 版本走的编译依赖）。

入参（multipart）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `file` | 必填 | 视频文件 |
| `max_frames` | 12 | 关键帧张数**上限**（1–120） |
| `frame_interval_s` | 10 | 抽帧间隔秒数（>0，≤3600） |

出参：

```json
{
  "duration_s": 5.0,
  "size_bytes": 123456,
  "audio_wav_b64": "<16k 单声道 16bit PCM wav 的 base64；无音轨时 null>",
  "audio_sample_rate": 16000,
  "audio_channels": 1,
  "frames": [{"t_s": 0.0, "jpeg_b64": "<base64>"}],
  "probe": {"width": 320, "height": 240, "codec": "mpeg4"}
}
```

**16k 单声道是硬约束不是偏好**：DashScope Paraformer 的说话人分离只支持单声道
（见文末「`/asr` 的已知约束」），16k 是 paraformer-v2 的目标采样率。
在这里转好，上层就不必再判断「这段音是不是分不了人」。

**抽帧策略**：间隔够稀（按 `frame_interval_s` 算出的帧数不超 `max_frames`）就按间隔走；
长视频改为在**全片上均匀**采样 `max_frames` 个点——否则一小时的录像按 10 秒一帧
只会取到开头两分钟，等于把「这段视频讲了什么」误答成「这段视频开头讲了什么」。
`-ss` 放在 `-i` 之前是输入侧快速定位，落到该时刻之前最近的关键帧。
（**当前不做场景切换检测**，只按时间取点。）

**上限与错误码**：体积默认 200MB（env `VIDEO_MAX_BYTES`）、时长默认 60 分钟
（env `VIDEO_MAX_SECONDS`），超任一项 `413`；上传流是**边写临时文件边数字节**，
超限当场中止，不会先把整个文件读进内存。坏文件（ffprobe 认不出、无音视频轨、读不出时长）
一律 `400`，**不是 500**；缺 ffmpeg/ffprobe `503`，文案自述缺什么、为什么缺、怎么装。
单次 ffmpeg 调用超时默认 600 秒（env `VIDEO_FFMPEG_TIMEOUT_S`），超时 `502`。

> ⚠️ **音轨是内联 base64 回的**，60 分钟 16k 单声道 wav ≈ 115MB、转 base64 ≈ 154MB。
> 默认上限允许的最坏情况会让单次响应到这个量级。上层若要跑长录像，
> 应自己把 `VIDEO_MAX_SECONDS` 调到实际需要的量级，或另行设计临时文件交接。

## 出证 → 验证的完整链路

```
文件 SHA-256 ──/tsa──► TST(base64) + genTime + serial
                          │
        存证元数据 ──/evidence-pdf──► 未签名《存证证明》PDF
                          │
                       /pades ──► 已签 PDF（PAdES-B-LT + LTV）→ 存 files 表
                          │
   /verify/:no 公开页 ──/verify──► 裁决 JSON（intact/valid/trusted/timestamp/bottom_line）
```

任何第三方无需本平台即可离线复核：PDF 附录里带 TST 原文，用 OpenSSL 就能验；
PDF 本身的签名用 Adobe 或 `verify_evidence_pdf.py` 验。

## 依赖与外部服务

- **GlobalSign AATL TSA**（默认，`TSA_URL` 可换国内 TSA）：`/tsa` 与 `/pades` 都会打。
- **阿里云百炼 DashScope**：`/ocr` 用 `qwen-vl-ocr-2025-11-20`（图片以 base64 内联提交，
  不走「本地文件先传阿里云临时 OSS」那条路）；`/asr` 用 `paraformer-v2` 开
  `diarization_enabled`。

  **OCR 模型必须锁 dated 版本号，禁用 `-latest` 等浮动别名**：`qwen-vl-ocr-2025-11-20`
  是 0.3/0.5 元每百万 token，而更早的 2025-08-28 / 2025-04-13 / 2024-10-28 是 5/5 元，
  单价差 16 倍。浮动别名指向变更会在无人察觉的情况下把成本翻十几倍。
  换版走 env `OCR_MODEL`，并同步核对 `research/raw/C01-模型定价核定.md §二` 的费率表。
- **中文字体**：PDF 渲染需要 CJK 字体，镜像里装的是 `fonts-noto-cjk`。
  裸机缺字体会回退 Helvetica，中文渲染成方块。
- **ffmpeg / ffprobe（系统包）**：`/video` 唯一的外部依赖，`requirements.txt` 里没有对应条目。
  镜像已在 `Dockerfile` 装上；**裸 systemd 部署的机器要自己
  `apt-get install -y ffmpeg`**，否则 `/video` 恒 `503`（其余端点不受影响）。

### `/asr` 的已知约束（待裁决）

阿里云录音文件识别接口**只接受公网可访问 URL，不接受二进制流或本地文件**。
本模块因此先用 SDK 的 `OssUtils` 把音频传到 DashScope 临时文件空间（48 小时有效）
再提交任务。官方明确该临时空间**限流 100 QPS 且不扩容、不建议生产使用**。

量上来后需改为上传到自有 OSS 取公网 URL —— 这会引入「劳动者录音在阿里云 OSS
留存一份」的隐私面，属产品决策，留给主会话裁决。另：说话人分离仅支持单声道，
多声道音频需先 `ffmpeg -ac 1` 转换（当前未做，上层传多声道会退化为不分离）。
