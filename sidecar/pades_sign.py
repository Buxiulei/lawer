#!/usr/bin/env python3
"""
PAdES 数字签名（pyHanko 版）

使用 pyHanko 对 PDF 施加 PAdES-B-LT 数字签名（含 RFC 3161 时间戳 + LTV 长期验证）。
pyHanko 底层用 cryptography（C/OpenSSL），签名速度远优于纯 Python 的 endesive。
LTV 会自动嵌入 OCSP/CRL 吊销信息和完整证书链，使签名在证书过期后仍可验证。

供 sidecar 内 import 调用：sign_pdf_file(input_pdf, output_pdf, ...) -> dict
亦保留 CLI（便于人工排障）:
  python3 pades_sign.py <input.pdf> <output.pdf> --pfx <cert.pfx> --password <pwd>
        [--reason <reason>] [--location <location>] [--contact <contact>]
        [--tsa <tsa_url>] [--no-tsa]
  输出: OK:<sha256_hash_hex>  （成功）
        ERR:<message>         （失败）

证书路径与密码走 env（见 .env.example）：SIGNING_CERT_PATH / SIGNING_CERT_PASSWORD。
"""

import argparse
import hashlib
import os
import sys
import traceback

from pyhanko.sign import signers, timestamps
from pyhanko.pdf_utils.incremental_writer import IncrementalPdfFileWriter
from pyhanko.sign.signers.pdf_signer import PdfSignatureMetadata

DEFAULT_TSA = os.environ.get(
    "TSA_URL",
    "http://aatl-timestamp.globalsign.com/tsa/aohfewat2389535fnasgnlg5m23",
)
DEFAULT_REASON = "存证证明签署"
DEFAULT_LOCATION = "Beijing, China"
DEFAULT_CONTACT = os.environ.get("SIGN_CONTACT", "")


class SignError(Exception):
    """PAdES 签名失败。"""


def sign_pdf_file(
    input_path: str,
    output_path: str,
    pfx_path: str = None,
    password: str = None,
    reason: str = DEFAULT_REASON,
    location: str = DEFAULT_LOCATION,
    contact: str = DEFAULT_CONTACT,
    tsa_url: str = None,
    no_tsa: bool = False,
) -> dict:
    """对 input_path 的 PDF 施加 PAdES-B-LT 签名，写出 output_path。

    pfx_path/password 缺省时从 env SIGNING_CERT_PATH / SIGNING_CERT_PASSWORD 读。
    返回 {source_sha256, ltv_warning}；ltv_warning 非空表示 LTV 嵌入未成功（签名本身仍有效）。
    """
    pfx_path = pfx_path or os.environ.get("SIGNING_CERT_PATH")
    password = password if password is not None else os.environ.get("SIGNING_CERT_PASSWORD")
    if not pfx_path:
        raise SignError("未配置签名证书：SIGNING_CERT_PATH 为空")
    if not os.path.isfile(pfx_path):
        raise SignError(f"签名证书不存在: {pfx_path}")
    if password is None:
        raise SignError("未配置签名证书密码：SIGNING_CERT_PASSWORD 为空")

    tsa_url = tsa_url or DEFAULT_TSA
    ltv_warning = None

    # 加载 PKCS#12 签名者
    signer = signers.SimpleSigner.load_pkcs12(
        pfx_file=pfx_path,
        passphrase=password.encode(),
    )

    # 读取原始 PDF 用于哈希计算
    with open(input_path, "rb") as f:
        datau = f.read()

    # 配置 TSA 时间戳
    tst_client = None
    if tsa_url and not no_tsa:
        # timeout=15：国内服务器到 TSA 的 TCP 连接不稳定，
        # pyHanko 要做 2 次 TSA 请求（estimation + 正式），默认 5s 不够
        tst_client = timestamps.HTTPTimeStamper(tsa_url, timeout=15)

    # 签名元数据（域名动态生成，避免与已有签名域冲突）
    import time as _time
    sig_field_name = f"Sig_{int(_time.time())}"

    sig_meta = PdfSignatureMetadata(
        field_name=sig_field_name,
        reason=reason,
        location=location,
        contact_info=contact,
        md_algorithm="sha256",
    )

    # 打开 PDF 增量写入器
    with open(input_path, "rb") as inf:
        w = IncrementalPdfFileWriter(inf)

        # 执行 PAdES 签名
        result = signers.PdfSigner(
            sig_meta,
            signer=signer,
            timestamper=tst_client,
        ).sign_pdf(w)

        signed_data = result.getbuffer()

    # LTV 长期验证：用 pyHanko 官方 API 嵌入完整验证信息（DSS + VRI）
    # add_validation_info 内部自动：验证证书链 → 收集 OCSP/CRL → 嵌入 DSS+VRI
    try:
        from pyhanko.sign.validation import add_validation_info
        from pyhanko.pdf_utils.reader import PdfFileReader
        from pyhanko_certvalidator import ValidationContext
        from cryptography.hazmat.primitives.serialization import pkcs12, Encoding
        from asn1crypto import x509 as asn1_x509
        import io

        # 从签名证书的 AIA/CRL 扩展中预获取吊销数据
        # （hand-feed 到 ValidationContext，绕过 CA OCSP 签名者的验证问题）
        import requests
        from cryptography import x509 as cx509
        from cryptography.hazmat.primitives.hashes import SHA1
        from cryptography.x509 import ocsp as cx509_ocsp
        from asn1crypto import crl as asn1_crl, ocsp as asn1_ocsp

        with open(pfx_path, "rb") as pf:
            _, sign_cert, ca_chain = pkcs12.load_key_and_certificates(pf.read(), password.encode())

        # 构建信任根（asn1crypto 格式）
        trust_roots = []
        if ca_chain:
            for ca_cert in ca_chain:
                trust_roots.append(asn1_x509.Certificate.load(ca_cert.public_bytes(Encoding.DER)))

        pre_crls = []
        pre_ocsps = []

        # 遍历签名证书 + 中间 CA，获取每个的 CRL 和 OCSP
        all_certs = [sign_cert] + (list(ca_chain) if ca_chain else [])
        cert_map = {c.subject: c for c in all_certs}  # 用于找 issuer

        for cert in all_certs:
            # 跳过自签名根
            if cert.subject == cert.issuer:
                continue
            # CRL
            try:
                crl_dp = cert.extensions.get_extension_for_oid(
                    cx509.oid.ExtensionOID.CRL_DISTRIBUTION_POINTS
                )
                for dp in crl_dp.value:
                    for name in dp.full_name:
                        url = name.value
                        if url and url.startswith("http"):
                            resp = requests.get(url, timeout=10)
                            if resp.status_code == 200:
                                pre_crls.append(asn1_crl.CertificateList.load(resp.content))
            except Exception:
                pass
            # OCSP
            try:
                aia = cert.extensions.get_extension_for_oid(
                    cx509.oid.ExtensionOID.AUTHORITY_INFORMATION_ACCESS
                )
                ocsp_url = None
                for desc in aia.value:
                    if desc.access_method == cx509.oid.AuthorityInformationAccessOID.OCSP:
                        ocsp_url = desc.access_location.value
                        break
                issuer = cert_map.get(cert.issuer)
                if ocsp_url and issuer:
                    builder = cx509_ocsp.OCSPRequestBuilder()
                    builder = builder.add_certificate(cert, issuer, SHA1())
                    ocsp_req = builder.build()
                    ocsp_resp = requests.post(
                        ocsp_url,
                        data=ocsp_req.public_bytes(Encoding.DER),
                        headers={"Content-Type": "application/ocsp-request"},
                        timeout=10,
                    )
                    if ocsp_resp.status_code == 200:
                        pre_ocsps.append(asn1_ocsp.OCSPResponse.load(ocsp_resp.content))
            except Exception:
                pass

        vc = ValidationContext(
            trust_roots=trust_roots if trust_roots else None,
            allow_fetching=False,  # 不需要再在线获取了
            revocation_mode="none",
            crls=pre_crls if pre_crls else None,
            ocsps=pre_ocsps if pre_ocsps else None,
        )

        # 读取签名后的 PDF，获取最后一个嵌入签名
        reader = PdfFileReader(io.BytesIO(bytes(signed_data)))
        sigs = list(reader.embedded_signatures)
        if sigs:
            last_sig = sigs[-1]
            # add_validation_info 自动收集 OCSP/CRL 并嵌入 DSS+VRI
            # skip_timestamp=True：TSA 证书（GlobalSign）不在我们的 trust_roots 中
            ltv_output = add_validation_info(
                embedded_sig=last_sig,
                validation_context=vc,
                skip_timestamp=True,
                add_vri_entry=True,
                force_write=True,
            )
            ltv_output.seek(0)
            signed_data = ltv_output.read()
    except Exception as ltv_err:
        ltv_warning = f"{type(ltv_err).__name__}: {ltv_err}"
        print(f"LTV-WARN:{ltv_err}", file=sys.stderr)
        # LTV 嵌入失败不影响签名本身

    # 写入输出文件
    with open(output_path, "wb") as outf:
        outf.write(signed_data)

    # 计算原始（未签）PDF 的 SHA-256（供证明页展示参考）
    return {
        "source_sha256": hashlib.sha256(datau).hexdigest(),
        "ltv_warning": ltv_warning,
    }


def main():
    parser = argparse.ArgumentParser(description="PAdES PDF 数字签名（pyHanko）")
    parser.add_argument("input", help="输入 PDF 路径")
    parser.add_argument("output", help="输出签名后 PDF 路径")
    parser.add_argument("--pfx", default=None, help="PKCS#12 证书路径 (.pfx/.p12)，缺省读 env SIGNING_CERT_PATH")
    parser.add_argument("--password", default=None, help="证书密码，缺省读 env SIGNING_CERT_PASSWORD")
    parser.add_argument("--reason", default=DEFAULT_REASON, help="签名原因")
    parser.add_argument("--location", default=DEFAULT_LOCATION, help="签署地点")
    parser.add_argument("--contact", default=DEFAULT_CONTACT, help="联系方式")
    parser.add_argument("--tsa", default=DEFAULT_TSA,
                        help="RFC 3161 时间戳服务器 URL（默认 GlobalSign AATL）")
    parser.add_argument("--no-tsa", action="store_true", help="禁用 TSA 时间戳")
    args = parser.parse_args()

    try:
        r = sign_pdf_file(
            args.input, args.output, args.pfx, args.password,
            args.reason, args.location, args.contact, args.tsa, args.no_tsa,
        )
        print(f"OK:{r['source_sha256']}")
    except Exception as e:
        print(f"ERR:{e}\n{traceback.format_exc()}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
