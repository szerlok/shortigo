import errno
import io
import os
import socket
import ssl
import subprocess
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import Mock, patch

import certifi
import zernio_upload as upload


class UploadTests(unittest.TestCase):
    def test_broken_pipe_preserves_a_pending_tls_alert(self):
        request = {"url": "https://storage.example/clip?signature=private", "contentType": "video/mp4",
                   "size": 4, "addresses": ["8.8.8.8"]}
        cases = [
            ("SSLV3_ALERT_BAD_RECORD_MAC", "ERR_SSL_SSLV3_ALERT_BAD_RECORD_MAC"),
            ("DECRYPTION_FAILED_OR_BAD_RECORD_MAC", "ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC"),
            (None, "EPIPE"),
        ]
        for reason, expected in cases:
            connection = Mock()
            connection.sock.version.return_value = "TLSv1.3"
            connection.send.side_effect = BrokenPipeError(errno.EPIPE, "broken pipe")
            response_error = TimeoutError() if reason is None else ssl.SSLError()
            if reason is not None:
                response_error.reason = reason
            connection.getresponse.side_effect = response_error
            with self.subTest(reason=reason), patch.object(upload.sys, "platform", "linux"), \
                    patch.object(upload.http.client, "HTTPSConnection", return_value=connection):
                result = upload.upload(request, io.BytesIO(b"clip"))
            self.assertEqual(result["code"], expected)
            self.assertEqual(result["bytes"], 0)
            self.assertEqual(result["status"], 0)
            self.assertEqual(result.get("writeCode"), "EPIPE" if reason is not None else None)
            self.assertNotIn("private", str(result))
            connection.sock.settimeout.assert_called_with(5)
            connection.close.assert_called_once()

    def test_tls_receives_original_bytes_and_preserves_http_and_certificate_errors(self):
        with tempfile.TemporaryDirectory() as directory:
            key = os.path.join(directory, "key.pem")
            cert = os.path.join(directory, "cert.pem")
            config = os.path.join(directory, "openssl.cnf")
            with open(config, "w") as output:
                output.write("[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n"
                             "[dn]\nCN=storage.example\n[ext]\nsubjectAltName=DNS:storage.example\n")
            subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
                            "-keyout", key, "-out", cert, "-config", config],
                           check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            received = []
            status = [200]

            class Handler(BaseHTTPRequestHandler):
                def do_PUT(self):
                    data = self.rfile.read(int(self.headers["Content-Length"]))
                    received.append((self.path, self.headers, data))
                    self.send_response(status[0])
                    self.send_header("Content-Length", "0")
                    self.end_headers()

                def log_message(self, *_args):
                    pass

            server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
            server.daemon_threads = True
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            context.load_cert_chain(cert, key)
            server.socket = context.wrap_socket(server.socket, server_side=True)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            payload = os.urandom(1024 * 1024 + 31)
            request = {"url": "https://storage.example/clip?signature=test-only", "contentType": "video/mp4",
                       "size": len(payload), "addresses": ["8.8.8.8"]}

            def route(addresses, timeout):
                self.assertEqual(addresses, ["8.8.8.8"])
                return socket.create_connection(server.server_address, timeout)

            try:
                with patch.object(upload, "connect_pinned", side_effect=route), patch.object(certifi, "where", return_value=cert):
                    result = upload.upload(request, io.BytesIO(payload))
                    self.assertEqual(result["status"], 200)
                    self.assertEqual(result["bytes"], len(payload))
                    target, headers, actual = received[0]
                    self.assertEqual(target, "/clip?signature=test-only")
                    self.assertEqual(actual, payload)
                    self.assertEqual(headers["Content-Type"], "video/mp4")
                    self.assertIsNone(headers["Authorization"])
                    self.assertIsNone(headers["Transfer-Encoding"])
                    status[0] = 403
                    self.assertEqual(upload.upload(request, io.BytesIO(payload))["status"], 403)
                    status[0] = 307
                    self.assertEqual(upload.upload(request, io.BytesIO(payload))["status"], 307)
                    result = upload.upload({**request, "url": "https://wrong.example/clip"}, io.BytesIO(payload))
                    self.assertEqual(result["code"], "CERTIFICATE_VERIFY_FAILED")
                    self.assertEqual(len(received), 3)
                    self.assertEqual(result["bytes"], 0)
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=2)

    def test_private_destinations_are_rejected_before_connection(self):
        request = {"url": "https://storage.example/clip", "contentType": "video/mp4", "size": 4}
        for address in ("127.0.0.1", "192.168.1.1", "::1", "169.254.169.254", "224.0.0.1"):
            with self.subTest(address=address), patch.object(upload, "connect_pinned") as connect:
                with self.assertRaises(ValueError):
                    upload.upload({**request, "addresses": [address]}, io.BytesIO(b"clip"))
                connect.assert_not_called()


if __name__ == "__main__":
    unittest.main()
