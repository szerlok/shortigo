import socket
import unittest
from unittest.mock import patch

from network_guard import _public_address


class NetworkGuardTests(unittest.TestCase):
    def test_rejects_private_addresses_at_connect(self):
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            for host in ("127.0.0.1", "10.0.0.1", "169.254.169.254", "192.168.1.2"):
                with self.subTest(host=host), self.assertRaises(OSError):
                    _public_address(sock, (host, 443))
            self.assertEqual(_public_address(sock, ("8.8.8.8", 443)), ("8.8.8.8", 443))
        finally:
            sock.close()

    def test_rejects_private_dns_result_even_after_initial_url_validation(self):
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            private = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("10.1.2.3", 443))]
            with patch.object(socket, "getaddrinfo", return_value=private), self.assertRaises(OSError):
                _public_address(sock, ("public.example", 443))
            public = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8", 443))]
            with patch.object(socket, "getaddrinfo", return_value=public):
                self.assertEqual(_public_address(sock, ("public.example", 443)), ("8.8.8.8", 443))
        finally:
            sock.close()


if __name__ == "__main__":
    unittest.main()
