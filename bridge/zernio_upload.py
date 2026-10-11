"""Stream an authorized clip from stdin to a signed HTTPS PUT URL from FD 3.

No file paths or API keys cross this boundary. DNS is pinned by the parent;
TLS still checks the original hostname. stdout contains only a bounded result.
"""
import errno
import http.client
import ipaddress
import json
import os
import socket
import ssl
import sys
from urllib.parse import urlsplit

CHUNK_BYTES = 64 * 1024
MAX_CONFIG_BYTES = 32768
DARWIN_TCP_NOOPT = 0x08  # netinet/tcp.h: disable TCP extensions on this socket.


def public_address(value):
    address = ipaddress.ip_address(value)
    return address.is_global and not address.is_multicast


def validate_config(config):
    url = config.get("url", "")
    if not isinstance(url, str) or any(ord(c) < 32 or ord(c) == 127 for c in url):
        raise ValueError("invalid_url")
    parsed = urlsplit(url)
    if (parsed.scheme != "https" or not parsed.hostname or parsed.port not in (None, 443)
            or parsed.username or parsed.password or parsed.fragment):
        raise ValueError("invalid_url")
    content_type = config.get("contentType")
    if content_type not in ("video/mp4", "video/quicktime", "video/x-m4v", "video/webm"):
        raise ValueError("invalid_type")
    size = config.get("size")
    if type(size) is not int or size <= 0 or size > 5 * 1024 ** 3:
        raise ValueError("invalid_size")
    addresses = config.get("addresses")
    if not isinstance(addresses, list) or not 1 <= len(addresses) <= 32:
        raise ValueError("invalid_addresses")
    if not all(isinstance(value, str) and public_address(value) for value in addresses):
        raise ValueError("invalid_addresses")
    return parsed


def error_code(error):
    if isinstance(error, ssl.SSLCertVerificationError):
        return "CERTIFICATE_VERIFY_FAILED"
    if isinstance(error, ssl.SSLError):
        reason = error.reason or ""
        if "ALERT_BAD_RECORD_MAC" in reason:
            return "ERR_SSL_SSLV3_ALERT_BAD_RECORD_MAC"
        if "BAD_RECORD_MAC" in reason:
            return "ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC"
        return "PYTHON_TLS_ERROR"
    if isinstance(error, (TimeoutError, socket.timeout)):
        return "ETIMEDOUT"
    if isinstance(error, http.client.RemoteDisconnected):
        return "ECONNRESET"
    return {
        errno.EPIPE: "EPIPE", errno.ECONNRESET: "ECONNRESET",
        errno.ECONNREFUSED: "ECONNREFUSED", errno.ETIMEDOUT: "ETIMEDOUT",
        errno.ENETUNREACH: "ENETUNREACH", errno.EHOSTUNREACH: "EHOSTUNREACH",
    }.get(getattr(error, "errno", None), "PYTHON_UPLOAD_FAILED")


def connect_pinned(addresses, timeout):
    last_error = None
    for address in addresses:
        family = socket.AF_INET6 if ":" in address else socket.AF_INET
        sock = socket.socket(family, socket.SOCK_STREAM)
        sock.settimeout(timeout)
        try:
            if sys.platform == "darwin":
                sock.setsockopt(socket.IPPROTO_TCP, DARWIN_TCP_NOOPT, 1)
            sock.connect((address, 443))
            return sock
        except OSError as error:
            sock.close()
            last_error = error
    raise last_error or OSError(errno.EHOSTUNREACH, "unreachable")


def upload(config, source):
    parsed = validate_config(config)
    try:
        import certifi
    except ImportError:
        return {"status": 0, "bytes": 0, "code": "python_upload_unavailable"}
    # Explicit roots avoid inherited SSL_CERT_FILE / proxy overrides. The
    # virtualenv already ships certifi with the clipping engine.
    context = ssl.create_default_context(cafile=certifi.where())
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    connection = http.client.HTTPSConnection(parsed.hostname, timeout=30, context=context)

    def pinned_connection(_address, timeout=30, source_address=None):
        return connect_pinned(config["addresses"], timeout)

    connection._create_connection = pinned_connection
    sent = 0
    network = {}
    headers_sent = False
    try:
        connection.connect()
        network["tls"] = connection.sock.version()
        network["tcpCompatibility"] = sys.platform == "darwin"
        if sys.platform == "darwin":
            # Per-socket compatibility for problematic home-network paths;
            # no changes to the Mac's network settings or router are needed.
            try:
                before = connection.sock.getsockopt(socket.IPPROTO_TCP, socket.TCP_MAXSEG)
                connection.sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_MAXSEG, min(1024, before))
                network.update(mssBefore=before, mssAfter=connection.sock.getsockopt(socket.IPPROTO_TCP, socket.TCP_MAXSEG))
            except OSError:
                pass  # Blocking Python TLS writes remain usable without this option.
        connection.sock.settimeout(60)
        target = (parsed.path or "/") + ("?" + parsed.query if parsed.query else "")
        connection.putrequest("PUT", target, skip_accept_encoding=True)
        connection.putheader("Content-Type", config["contentType"])
        connection.putheader("Content-Length", str(config["size"]))
        connection.endheaders()
        headers_sent = True
        while sent < config["size"]:
            block = source.read(min(CHUNK_BYTES, config["size"] - sent))
            if not block:
                return {"status": 0, "bytes": sent, "code": "upload_incomplete", **network}
            connection.send(block)
            sent += len(block)
        connection.sock.settimeout(120)
        response = connection.getresponse()
        response.read(65536)
        return {"status": response.status, "bytes": sent, **network}
    except Exception as error:
        # An early HTTP refusal can close the writing side. Preserve its HTTP
        # status when available instead of reducing every rejection to EPIPE.
        if headers_sent and isinstance(error, (BrokenPipeError, ConnectionResetError)):
            try:
                if connection.sock is not None:
                    connection.sock.settimeout(5)
                response = connection.getresponse()
                if response.status >= 300:
                    return {"status": response.status, "bytes": sent, **network}
            except ssl.SSLError as response_error:
                # TLS alerts may already be waiting on the reading side when
                # writing reports EPIPE. Keep the actual TLS reason, not its
                # exception text (which could contain private request data).
                return {"status": 0, "bytes": sent, "code": error_code(response_error),
                        "writeCode": error_code(error), **network}
            except Exception:
                pass  # A missing response must not replace the write error.
        return {"status": 0, "bytes": sent, "code": error_code(error), **network}
    finally:
        connection.close()


def main():
    try:
        with os.fdopen(3, "rb") as configuration:
            raw = configuration.read(MAX_CONFIG_BYTES + 1)
        if len(raw) > MAX_CONFIG_BYTES:
            raise ValueError("config_too_large")
        result = upload(json.loads(raw), sys.stdin.buffer)
    except Exception:
        # Never print exceptions: HTTP errors can include the signed URL.
        result = {"status": 0, "bytes": 0, "code": "PYTHON_UPLOAD_FAILED"}
    print(json.dumps(result), flush=True)
    return 0 if 200 <= result["status"] < 300 and not result.get("code") else 1


if __name__ == "__main__":
    raise SystemExit(main())
