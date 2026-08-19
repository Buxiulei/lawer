#!/usr/bin/env python3
"""
RFC 3161 可信时间戳（pyHanko 版，复用 pades_sign.py 同款 HTTPTimeStamper）

把「盖 PDF」降为「盖任意 SHA-256 哈希」—— HTTPTimeStamper 底层就是通用 RFC3161 客户端。
对证据文件的 SHA-256 申请权威第三方 TSA 时间戳，锁定「该哈希在某 UTC 时刻已存在、
且此后未被改动」（TSA 私钥不在我方，不可抵赖）。

供 sidecar 内 import 调用：request_timestamp(hex_hash) -> dict
亦保留 CLI（便于人工排障 / 离线复算）:
  python3 rfc3161_timestamp.py --hash <64位hex> [--tsa <url>] [--timeout 15]
  输出（单行；用 '|' 分隔，各字段本身不含 '|'）:
    OK|<base64(TST_ContentInfo_DER)>|<genTime_iso8601>|<serialNumber_十进制>|<tsa_url>
    ERR:<message>   （失败，exit 1）
"""

import argparse
import asyncio
import base64
import os
import sys
import traceback

from pyhanko.sign import timestamps
from asn1crypto import tsp

# 与 pades_sign.py 同源默认 TSA（GlobalSign AATL）。若改用国内 TSA（如联合信任 UniTrust）
# 仅需换 env TSA_URL 或传参，架构不变。
DEFAULT_TSA = os.environ.get(
    "TSA_URL",
    "http://aatl-timestamp.globalsign.com/tsa/aohfewat2389535fnasgnlg5m23",
)


class TimestampError(Exception):
    """时间戳申请失败（入参非法或 TSA 不可用）。"""


def request_timestamp(hex_hash: str, tsa_url: str = None, timeout: int = 15) -> dict:
    """对一个 SHA-256 摘要申请 RFC3161 时间戳，返回 TST 与其元数据。

    hex_hash: 64 位小写 hex（32 字节 SHA-256 摘要）
    返回: {tst_b64, gen_time(iso8601), serial(str 十进制), tsa_url}
    失败抛 TimestampError。
    """
    tsa_url = tsa_url or DEFAULT_TSA
    hex_hash = (hex_hash or "").strip().lower()
    if len(hex_hash) != 64:
        raise TimestampError(f"hash 长度非 64（得到 {len(hex_hash)}）")
    try:
        message_digest = bytes.fromhex(hex_hash)  # 32 字节 SHA-256 摘要
    except ValueError:
        raise TimestampError("hash 非合法 hex")

    try:
        # HTTPTimeStamper.async_timestamp 是协程，返回 asn1crypto.cms.ContentInfo
        tsa = timestamps.HTTPTimeStamper(tsa_url, timeout=timeout)
        token = asyncio.run(tsa.async_timestamp(message_digest, "sha256"))
    except Exception as e:
        raise TimestampError(f"TSA 请求失败({tsa_url}): {type(e).__name__}: {e}")

    # 完整 TimeStampToken（ContentInfo DER）供离线验真
    token_der = token.dump()
    token_b64 = base64.b64encode(token_der).decode("ascii")

    # 从 TST 抽 genTime 与 serialNumber
    signed_data = token["content"]
    econtent = signed_data["encap_content_info"]["content"]
    # econtent 为 ParsableOctetString，content_type=tst_info → .parsed 即 TSTInfo
    tst_info = econtent.parsed
    if not isinstance(tst_info, tsp.TSTInfo):
        tst_info = tsp.TSTInfo.load(econtent.dump() if hasattr(econtent, "dump") else bytes(econtent))
    gen_time = tst_info["gen_time"].native  # tz-aware datetime（UTC）
    serial = tst_info["serial_number"].native  # int

    return {
        "tst_b64": token_b64,
        "gen_time": gen_time.isoformat(),
        # serial 可能超出 JS Number 安全范围，故以十进制字符串返回
        "serial": str(serial),
        "tsa_url": tsa_url,
    }


def main():
    parser = argparse.ArgumentParser(description="RFC3161 可信时间戳（pyHanko）")
    parser.add_argument("--hash", required=True, help="待盖章的 SHA-256 哈希（64 位小写 hex）")
    parser.add_argument("--tsa", default=DEFAULT_TSA, help="RFC3161 TSA URL")
    parser.add_argument("--timeout", type=int, default=15, help="TSA 请求超时（秒）")
    args = parser.parse_args()

    try:
        r = request_timestamp(args.hash, args.tsa, args.timeout)
        print(f"OK|{r['tst_b64']}|{r['gen_time']}|{r['serial']}|{r['tsa_url']}")
    except Exception as e:
        print(f"ERR:{e}\n{traceback.format_exc()}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
