# serve.py - local web server for this folder (this PC only). Same as "python -m http.server",
# but tells the browser NOT to cache files, so the page never mixes old and new files.
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8784
    ThreadingHTTPServer(("127.0.0.1", port), NoCacheHandler).serve_forever()
