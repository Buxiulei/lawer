#!/usr/bin/env python3
"""
《存证证明》PDF —— 独立 PAdES 密码学验签（单一验证真源，仲裁/法庭可复现）

核心范式：绝不把「未校验 / 信任锚缺失」当作「已通过」。
本工具对一份磁盘上的已签 PDF 做真正的密码学验签，而非只查库比哈希。

对一份已签 PDF：
  1) 打开 PDF，定位其嵌入的 PAdES 签名（EmbeddedPdfSignature）；
  2) 用 pyHanko validate_pdf_signature 做密码学验签：
       - intact    : 签名覆盖的字节自签署以来未被改动（任何篡改必现 intact=False）；
       - valid     : CMS 签名密码学有效（签名与签名者公钥匹配）；
       - coverage  : 覆盖整份文档修订（>= ENTIRE_REVISION）；
       - trusted   : 签名证书链锚定到内置【CFCA Identity CA 根】（PIN，
                     不信任 PDF 自带链里可能被伪造的根——只有真 CFCA 根的公钥能验通）；
       - bottom_line: pyHanko 综合裁决（含差异分析 docmdp_ok/modification_level）——
                     签署后对文档的任何修改（哪怕是不碰原签名字节的「增量更新篡改」，
                     coverage 仍为 ENTIRE_REVISION）都会被判 False，是区分「合法 LTV 增量」
                     与「恶意增量篡改」的唯一信号；
       - timestamp : RFC3161 可信时间戳链锚定到内置【GlobalSign AATL 时间戳 CA】；
  3) 可选 --expect-hash <sha256_hex>：重算整份 PDF 的 SHA-256 与库存 attestations.sha256
     比对（防「换掉磁盘文件、但库里哈希未变」——即 /verify/:no 验证页脱钩场景）。

信任锚（PIN，离线）：sidecar/trust_anchors/
  - CFCA Identity CA 根（subject O = China Financial Certification Authority）→ 签名链锚
  - GlobalSign AATL 时间戳 CA                                              → 时间戳链锚
签名链与时间戳链分别锚定到各自类别，杜绝「拿时间戳 CA 冒充签名 CA」之类跨用。

任一关键项不过 → overall_ok=False，退出码非零。缺少校验依赖（pyHanko/asn1crypto）或
缺失对应信任锚时，相关项一律判「未通过」，绝不静默放行（法庭工具的核心安全属性）。

出错时裁决里给两个字段：error_code（稳定错误码，见「对外错误分级」码表，机器读）与
error（人读文案）。error 只会是静态安全原因原文或安全概述，不含服务器路径/异常原文——
后者只进 sidecar 日志（logger "sidecar.verify_evidence_pdf"，ERROR 级，带 traceback）。

供 sidecar 内 import 调用：verify_pdf(pdf_bytes, expect_hash) -> dict
亦保留 CLI（便于人工/第三方离线复核）:
  python3 verify_evidence_pdf.py <signed.pdf>
  python3 verify_evidence_pdf.py <signed.pdf> --expect-hash <sha256_hex>
输出: 裁决 JSON（stdout）；overall_ok=False 时退出码 1
"""

import argparse
import hashlib
import json
import logging
import os
import sys


# 内置信任锚目录（PEM 随镜像分发，离线可用）
_TRUST_ANCHOR_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "trust_anchors")

# CFCA 机构（签名链锚的判据）——按证书 subject 的 Organization 识别，稳健于文件名
_CFCA_ORG = "China Financial Certification Authority"

_LOG = logging.getLogger("sidecar.verify_evidence_pdf")


# ---------------- 对外错误分级 ----------------
#
# 裁决 dict 的 error 字段会被 app 侧一路带到公开复核页（app/src/lib/evidence/recheck.ts），
# 即「对外出口」。裸 {e} / {type(e).__name__}: {e} 写进去，会把服务器绝对路径、
# site-packages 布局、内部异常类型一并送到匿名访客眼前。
#
# 分两级：
#   静态安全原因（文案里没有任何运行期插值，如「PDF 无嵌入数字签名」）——原文保留，另附稳定码；
#   异常兜底（文案含 {e} / 含内部路径）——出口只出「稳定码 + 安全概述」，原始异常完整进日志。
#
# 码是稳定契约：app 侧按码做白名单投影，改文案不改码。
E_VERIFIER_UNAVAILABLE = "E_VERIFIER_UNAVAILABLE"          # 异常兜底：pyHanko 等验签依赖不可用
E_TRUST_ANCHOR_UNAVAILABLE = "E_TRUST_ANCHOR_UNAVAILABLE"  # 异常兜底：信任锚目录/PEM 读取解析失败
E_MISSING_CFCA_ANCHOR = "E_MISSING_CFCA_ANCHOR"            # 静态：无 CFCA 签名信任锚
E_MISSING_TSA_ANCHOR = "E_MISSING_TSA_ANCHOR"              # 静态：无时间戳信任锚
E_PDF_UNPARSABLE = "E_PDF_UNPARSABLE"                      # 异常兜底：PDF/签名结构解析失败
E_NO_SIGNATURE = "E_NO_SIGNATURE"                          # 静态：PDF 无嵌入数字签名
E_SIGNATURE_VERIFY_FAILED = "E_SIGNATURE_VERIFY_FAILED"    # 异常兜底：单个签名验签过程抛异常
E_PDF_READ_FAILED = "E_PDF_READ_FAILED"                    # 异常兜底：CLI 读盘失败

# 异常兜底类的对外概述。**唯一出口**：新增兜底分支必须在此登记一条，
# 否则 _safe_error 直接 KeyError（宁可炸也不要静默回一段裸异常）。
_SAFE_SUMMARY = {
    E_VERIFIER_UNAVAILABLE: "验签组件不可用，PDF 未做密码学验签（不得据此认定有效）",
    E_TRUST_ANCHOR_UNAVAILABLE: "内置信任锚不可用，签名链无法锚定，拒绝判通过",
    E_PDF_UNPARSABLE: "无法解析该 PDF 或其数字签名结构（文件损坏、非 PDF，或格式不受支持）",
    E_SIGNATURE_VERIFY_FAILED: "验签过程异常，未能完成该签名的校验（不得据此认定有效）",
    E_PDF_READ_FAILED: "读取 PDF 失败",
}


def _safe_error(code: str, detail) -> tuple:
    """异常兜底的**唯一**出口：原始明细进 sidecar 日志，只把 (稳定码, 安全概述) 交给调用方。

    detail 是异常对象时连带 traceback 一起记；是字符串时（如内部路径明细）原样记。
    """
    _LOG.error("verify_evidence_pdf %s: %s", code, detail,
               exc_info=isinstance(detail, BaseException))
    return code, _SAFE_SUMMARY[code]


def sha256_hex(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def _load_and_classify_anchors():
    """加载 trust_anchors/*.pem 并按 subject O 分类：
    返回 (signer_roots, ts_roots, err)。
    signer_roots = CFCA 根（O == CFCA）；ts_roots = 其余（GlobalSign 等时间戳 CA）。
    任一类别为空不在此处报错——由调用方按「该类校验不可完成」处理。"""
    try:
        from asn1crypto import pem, x509
    except Exception as e:  # noqa
        return [], [], f"asn1crypto 不可用: {e}"
    if not os.path.isdir(_TRUST_ANCHOR_DIR):
        return [], [], f"信任锚目录不存在: {_TRUST_ANCHOR_DIR}"
    signer_roots, ts_roots = [], []
    try:
        for name in sorted(os.listdir(_TRUST_ANCHOR_DIR)):
            if not name.lower().endswith((".pem", ".crt", ".cer")):
                continue
            raw = open(os.path.join(_TRUST_ANCHOR_DIR, name), "rb").read()
            der = pem.unarmor(raw)[2] if pem.detect(raw) else raw
            cert = x509.Certificate.load(der)
            org = ""
            try:
                org = cert.subject.native.get("organization_name", "") or ""
            except Exception:  # noqa
                org = ""
            if _CFCA_ORG in org or org == _CFCA_ORG:
                signer_roots.append(cert)
            else:
                ts_roots.append(cert)
    except Exception as e:  # noqa
        return signer_roots, ts_roots, f"读取信任锚失败: {e}"
    return signer_roots, ts_roots, None


def _coverage_ok(cov) -> bool:
    """覆盖级别 >= ENTIRE_REVISION 才算覆盖整份文档修订。"""
    try:
        from pyhanko.sign.validation import SignatureCoverageLevel
        return cov is not None and cov.value >= SignatureCoverageLevel.ENTIRE_REVISION.value
    except Exception:  # noqa
        return False


def verify_pdf(pdf_bytes: bytes, expect_hash: str = None) -> dict:
    """对单份已签 PDF 做完整密码学验签，返回裁决 dict。"""
    result = {
        "file_sha256": sha256_hex(pdf_bytes),
        "expect_hash": (expect_hash or None),
        "hash_match": None,          # None=未提供 expect-hash；True/False=比对结果
        "num_signatures": 0,
        "signatures": [],
        "overall_ok": False,
        "error": None,
        "error_code": None,          # 稳定错误码（见上方码表）；无错误时为 None
    }

    # 1) 哈希对账（防换文件）
    if expect_hash:
        result["hash_match"] = (result["file_sha256"].lower() == expect_hash.strip().lower())

    # 2) 依赖 & 信任锚
    try:
        from pyhanko.pdf_utils.reader import PdfFileReader
        from pyhanko.sign.validation import validate_pdf_signature
        from pyhanko_certvalidator import ValidationContext
    except Exception as e:  # noqa
        result["error_code"], result["error"] = _safe_error(E_VERIFIER_UNAVAILABLE, e)
        return result

    signer_roots, ts_roots, aerr = _load_and_classify_anchors()
    if aerr:
        # aerr 含服务器绝对路径 / 底层异常原文 —— 只进日志
        result["error_code"], result["error"] = _safe_error(E_TRUST_ANCHOR_UNAVAILABLE, aerr)
        return result
    if not signer_roots:
        result["error_code"] = E_MISSING_CFCA_ANCHOR
        result["error"] = "缺失 CFCA 签名信任锚（sidecar/trust_anchors/ 无 CFCA Identity CA 根）——签名链无法锚定，拒绝判通过"
        return result
    if not ts_roots:
        result["error_code"] = E_MISSING_TSA_ANCHOR
        result["error"] = "缺失时间戳信任锚（GlobalSign AATL 时间戳 CA）——时间戳链无法锚定，拒绝判通过"
        return result

    # 真 CFCA 根的 SHA-256 指纹集合（PIN 判据的地面真值）——只认这些字节，不认「叫 CFCA 的名字」。
    # 伪造一张 subject 逐字冒充「CFCA Identity CA」的自签根，其公钥不同 → DER 指纹不同 → 不匹配。
    genuine_signer_fps = {hashlib.sha256(c.dump()).hexdigest() for c in signer_roots}

    # 分别锚定：签名链只信任 CFCA 根；时间戳链只信任 GlobalSign。allow_fetching=False → 离线，
    # 仅用 PDF 内嵌 LTV(DSS) 的吊销信息，不发起网络请求。
    sig_vc = ValidationContext(trust_roots=signer_roots, allow_fetching=False,
                               revocation_mode="soft-fail")
    ts_vc = ValidationContext(trust_roots=ts_roots, allow_fetching=False,
                              revocation_mode="soft-fail")

    try:
        import io
        reader = PdfFileReader(io.BytesIO(pdf_bytes))
        embedded = list(reader.embedded_signatures)
    except Exception as e:  # noqa
        result["error_code"], result["error"] = _safe_error(E_PDF_UNPARSABLE, e)
        return result

    result["num_signatures"] = len(embedded)
    if not embedded:
        result["error_code"] = E_NO_SIGNATURE
        result["error"] = "PDF 无嵌入数字签名（未签名文件，拒绝判通过）"
        return result

    all_sig_ok = True
    for emb in embedded:
        row = {
            "field_name": getattr(emb, "field_name", None),
            "intact": None, "valid": None, "trusted": None,
            "coverage": None, "coverage_ok": None,
            "signer_cn": None, "signer_org": None, "signer_serial": None,
            "signer_anchored_to_cfca": None,
            "timestamp_present": False, "timestamp_intact": None,
            "timestamp_trusted": None, "timestamp_time": None,
            # 差异分析（区分善恶增量更新的唯一信号）——PAdES-B-LT 合法件签名后会以增量更新追加
            # LTV(DSS)，coverage 恒为 ENTIRE_REVISION，无法凭 coverage 区分「合法 LTV 增量」与
            # 「攻击者追加批注/改金额的恶意增量」；pyHanko 的 docmdp/差异分析才能区分。
            "docmdp_ok": None, "mod_level": None, "bottom_line": None,
            "signature_ok": False, "error": None, "error_code": None,
        }
        try:
            status = validate_pdf_signature(
                emb, signer_validation_context=sig_vc, ts_validation_context=ts_vc,
            )
            row["intact"] = bool(status.intact)
            row["valid"] = bool(status.valid)
            row["trusted"] = bool(status.trusted)
            row["coverage"] = str(status.coverage)
            row["coverage_ok"] = _coverage_ok(status.coverage)
            # 签名者证书信息 + 显式确认锚定到 CFCA 根
            sc = status.signing_cert
            if sc is not None:
                subj = sc.subject.native
                row["signer_cn"] = subj.get("common_name")
                row["signer_org"] = subj.get("organization_name")
                row["signer_serial"] = format(sc.serial_number, "X")
            # 锚定判据：必须 trusted（链已密码学验通到 sig_vc 的信任根，而 sig_vc 只放真 CFCA 根），
            # 且路径中确有一张证书的 DER 指纹命中真 CFCA 根指纹集。二者缺一即 False——
            # 伪造「CFCA」自签根名匹配但指纹不符、且 trusted=False，双重拦截。
            anchored = False
            if status.trusted:
                try:
                    vp = list(status.validation_path) if status.validation_path is not None else []
                    anchored = any(
                        hashlib.sha256(c.dump()).hexdigest() in genuine_signer_fps for c in vp
                    )
                except Exception:  # noqa
                    anchored = False
            row["signer_anchored_to_cfca"] = anchored
            # 时间戳
            tsv = status.timestamp_validity
            if tsv is not None:
                row["timestamp_present"] = True
                row["timestamp_intact"] = bool(tsv.intact)
                row["timestamp_trusted"] = bool(tsv.trusted)
                try:
                    row["timestamp_time"] = tsv.timestamp.isoformat() if tsv.timestamp else None
                except Exception:  # noqa
                    row["timestamp_time"] = None

            # 差异分析裁决：签署后对文档的任何修改，pyHanko 会判 docmdp_ok=False /
            # modification_level=OTHER；bottom_line 是 pyHanko 的综合裁决，已内含
            # intact ∧ valid ∧ trusted ∧ timestamp_ok ∧ (docmdp_ok ∨ modification_level is None)。
            # 缺了它，「签署后增量更新篡改」（原签名字节未动、coverage 仍 ENTIRE_REVISION、
            # intact/valid/trusted 全 True）会被放行——这是法律证据核心的伪造漏洞。
            row["docmdp_ok"] = getattr(status, "docmdp_ok", None)
            row["mod_level"] = str(getattr(status, "modification_level", None))
            row["bottom_line"] = bool(getattr(status, "bottom_line", False))

            row["signature_ok"] = bool(
                row["intact"] and row["valid"] and row["trusted"]
                and row["coverage_ok"] and row["signer_anchored_to_cfca"]
                and row["timestamp_present"] and row["timestamp_intact"]
                and row["timestamp_trusted"]
                and row["bottom_line"]      # ← 关键：pyHanko 判「非法修改」则整体拒绝
            )
        except Exception as e:  # noqa
            row["error_code"], row["error"] = _safe_error(E_SIGNATURE_VERIFY_FAILED, e)
            row["signature_ok"] = False

        if not row["signature_ok"]:
            all_sig_ok = False
        result["signatures"].append(row)

    hash_ok = (result["hash_match"] is not False)  # None(未提供)或 True 都放行；False 才拦
    result["overall_ok"] = bool(all_sig_ok and hash_ok)
    return result


def main():
    ap = argparse.ArgumentParser(description="《存证证明》PDF 独立 PAdES 密码学验签")
    ap.add_argument("pdf", help="已签 PDF 路径")
    ap.add_argument("--expect-hash", default=None,
                    help="期望的整份 PDF SHA-256（库存 attestations 哈希）；不符 → 换文件/篡改")
    args = ap.parse_args()

    # CLI 用：stdout 只留可解析的裁决 JSON，异常原文走 logging → stderr
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")

    try:
        pdf_bytes = open(args.pdf, "rb").read()
    except Exception as e:  # noqa
        code, msg = _safe_error(E_PDF_READ_FAILED, e)
        print(json.dumps({"overall_ok": False, "error": msg, "error_code": code},
                         ensure_ascii=False, indent=2))
        sys.exit(1)

    verdict = verify_pdf(pdf_bytes, args.expect_hash)
    print(json.dumps(verdict, ensure_ascii=False, indent=2))
    sys.exit(0 if verdict["overall_ok"] else 1)


if __name__ == "__main__":
    main()
