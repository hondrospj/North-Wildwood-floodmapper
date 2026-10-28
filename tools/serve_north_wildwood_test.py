#!/usr/bin/env python3
"""Serve a fixed CI checkout without request-log pipes or tiny listen queues."""

import argparse
import functools
import http.server
import posixpath
import sys
import threading
from pathlib import Path
from urllib.parse import unquote, urlsplit


class SnapshotRequestHandler(http.server.SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".css": "text/css",
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".png": "image/png",
        ".webp": "image/webp",
        ".geojson": "application/geo+json",
    }

    def send_response(self, code, message=None):
        self._response_status = code
        super().send_response(code, message)

    def end_headers(self):
        resource_path = posixpath.normpath(unquote(urlsplit(self.path).path))
        is_asset = resource_path.startswith("/assets/")
        successful = getattr(self, "_response_status", 0) in (200, 304)
        self.send_header(
            "Cache-Control",
            "public, max-age=3600" if is_asset and successful else "no-cache",
        )
        # The base handler supplies Content-Length, Last-Modified, HEAD and
        # conditional-GET behavior for the actual files, including empty errors
        # and redirects. A 304 correctly has no response body.
        super().end_headers()

    def log_message(self, message, *arguments):
        line = message % arguments
        line = line.replace("\r", "\\r").replace("\n", "\\n")
        self.server.write_access(
            '{} - - [{}] {}\n'.format(
                self.client_address[0], self.log_date_time_string(), line
            )
        )


class NorthWildwoodTestServer(http.server.ThreadingHTTPServer):
    request_queue_size = 128
    daemon_threads = True
    block_on_close = False
    allow_reuse_address = True

    def __init__(self, address, handler, access_log):
        self.access_log = access_log
        self.access_log_lock = threading.Lock()
        super().__init__(address, handler)

    def write_access(self, line):
        # Write directly to the file, not through a managed stdout/stderr pipe.
        # One lock keeps entries from concurrent request threads intact.
        with self.access_log_lock:
            if not self.access_log.closed:
                self.access_log.write(line)
                self.access_log.flush()

    def handle_error(self, request, client_address):
        error = sys.exc_info()[1]
        message = "{}: {}".format(type(error).__name__, error)
        self.write_access("{} transport error {}\n".format(client_address[0], message))
        # Browser cancellation commonly closes a socket during a file copy.
        # Preserve that evidence in the access log without stderr trace floods.
        if not isinstance(error, (BrokenPipeError, ConnectionResetError, ConnectionAbortedError)):
            print("Preview request error: " + message, file=sys.stderr, flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("port", nargs="?", type=int, default=8765)
    parser.add_argument("--bind", default="127.0.0.1")
    parser.add_argument("--directory", type=Path, default=Path.cwd())
    parser.add_argument("--access-log", type=Path, default=Path("preview-access.log"))
    options = parser.parse_args()
    if not 0 <= options.port <= 65535:
        parser.error("port must be between 0 and 65535")
    directory = options.directory.resolve()
    if not directory.is_dir():
        parser.error("directory does not exist: " + str(directory))
    options.access_log.parent.mkdir(parents=True, exist_ok=True)
    with options.access_log.open("a", encoding="utf-8", buffering=1) as access_log:
        handler = functools.partial(SnapshotRequestHandler, directory=str(directory))
        with NorthWildwoodTestServer((options.bind, options.port), handler, access_log) as server:
            address, port = server.server_address[:2]
            print(
                "Serving {} at http://{}:{}/ (HTTP/1.1, queue 128; log {})".format(
                    directory, address, port, options.access_log
                ),
                file=sys.stderr,
                flush=True,
            )
            try:
                server.serve_forever(poll_interval=0.2)
            except KeyboardInterrupt:
                pass


if __name__ == "__main__":
    main()
