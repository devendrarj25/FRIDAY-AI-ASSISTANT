import asyncio
import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import embedder  # noqa: E402


class _Fake(BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        vectors = []
        for text in body["input"]:
            vectors.append([1.0, 0.0] if "apple" in text else [0.0, 1.0])
        data = json.dumps({"embeddings": vectors}).encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):
        pass


def _serve():
    server = HTTPServer(("127.0.0.1", 0), _Fake)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_address[1]}"


def test_texts_closer_to_the_query_score_higher():
    embedder.reset()
    server, base = _serve()
    try:
        out = asyncio.run(embedder.rank("apple pie", ["banana bread", "apple tart"], "fake", base=base))
    finally:
        server.shutdown()
    assert out["ok"] and out["scores"][1] > out["scores"][0]


def test_a_missing_model_fails_soft_and_is_not_retried_at_once():
    embedder.reset()
    out = asyncio.run(embedder.rank("q", ["a"], "none", base="http://127.0.0.1:9"))
    assert out["ok"] is False and "did not answer" in out["reason"]
    again = asyncio.run(embedder.rank("q", ["a"], "none", base="http://127.0.0.1:9"))
    assert "a moment ago" in again["reason"]
    embedder.reset()


def test_only_a_model_on_this_pc_is_asked():
    embedder.reset()
    out = asyncio.run(embedder.rank("q", ["a"], "m", base="http://example.com"))
    assert out["ok"] is False and "this PC" in out["reason"]
