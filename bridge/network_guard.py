"""Block local and private TCP destinations for the desktop clipping process.

The guard checks the address passed to connect, after DNS resolution. This
also catches redirects and DNS changes made after the UI's initial URL check.
It is installed only in BridgeClip's local worker process.
"""

import ipaddress
import socket

_original_connect = socket.socket.connect
_original_connect_ex = socket.socket.connect_ex
_installed = False


def _public_address(sock: socket.socket, address):
    if sock.family not in (socket.AF_INET, socket.AF_INET6):
        return address
    if not isinstance(address, tuple) or len(address) < 2:
        raise OSError("Network destination is invalid")
    host, port = address[:2]
    try:
        ip = ipaddress.ip_address(host)
        if not ip.is_global:
            raise OSError("Local network destinations are not allowed")
        return address
    except ValueError:
        pass

    results = socket.getaddrinfo(host, port, sock.family, sock.type, sock.proto)
    if not results:
        raise OSError("Network destination could not be resolved")
    if any(not ipaddress.ip_address(result[4][0]).is_global for result in results):
        raise OSError("Local network destinations are not allowed")
    return results[0][4]


def install() -> None:
    global _installed
    if _installed:
        return

    def guarded_connect(sock, address):
        return _original_connect(sock, _public_address(sock, address))

    def guarded_connect_ex(sock, address):
        return _original_connect_ex(sock, _public_address(sock, address))

    socket.socket.connect = guarded_connect
    socket.socket.connect_ex = guarded_connect_ex
    _installed = True
