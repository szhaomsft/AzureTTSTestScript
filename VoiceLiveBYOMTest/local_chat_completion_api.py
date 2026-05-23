"""Local no-auth OpenAI-compatible chat-completions API for BYOM testing."""

from __future__ import annotations

import argparse
import json
import logging
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

logger = logging.getLogger(__name__)

# Default local port for the no-auth chat-completions test endpoint.
DEFAULT_PORT = 8787
# Upper bound for request bodies accepted by the local test API.
MAX_REQUEST_BYTES = 1_000_000
# Delay between streamed chunks so Voice Live can exercise streaming code paths.
STREAM_CHUNK_DELAY_SECONDS = 0.05
# Static model name returned when the request does not include a model.
DEFAULT_MODEL = "local-no-auth-chat-completion"
# Maximum text length to include in request/response diagnostic logs.
MAX_LOG_TEXT_LENGTH = 2_000


class LocalChatCompletionHandler(BaseHTTPRequestHandler):
    """HTTP handler for OpenAI-compatible chat completion requests."""

    server_version = "VoiceLiveBYOMLocalChat/1.0"

    def do_OPTIONS(self) -> None:  # noqa: N802
        """Handle browser CORS preflight requests."""
        self._send_empty_response(HTTPStatus.NO_CONTENT)

    def do_GET(self) -> None:  # noqa: N802
        """Handle lightweight health checks."""
        if self.path.rstrip("/") in {"", "/health"}:
            self._send_json(HTTPStatus.OK, {"status": "ok"})
            return
        self._send_json(HTTPStatus.NOT_FOUND, {"error": {"message": "Not found"}})

    def do_POST(self) -> None:  # noqa: N802
        """Handle OpenAI-compatible chat-completions requests."""
        if not _is_chat_completion_path(self.path):
            self._send_json(HTTPStatus.NOT_FOUND, {"error": {"message": "Not found"}})
            return

        request = self._read_json_body()
        if request is None:
            return

        model = str(request.get("model") or DEFAULT_MODEL)
        content = _build_response_text(request)
        _log_chat_request(request=request, response_content=content)
        if bool(request.get("stream")):
            self._send_streaming_response(model=model, content=content)
            return

        self._send_json(HTTPStatus.OK, _build_completion_response(model=model, content=content))

    def log_message(self, format: str, *args: object) -> None:
        """Route default HTTP server logs through logging."""
        logger.info("HTTP %s", format % args)

    def _read_json_body(self) -> dict[str, Any] | None:
        content_length = int(self.headers.get("Content-Length", "0"))
        if content_length > MAX_REQUEST_BYTES:
            self._send_json(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, {"error": {"message": "Request body too large"}})
            return None

        raw_body = self.rfile.read(content_length)
        try:
            parsed: Any = json.loads(raw_body or b"{}")
        except json.JSONDecodeError:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": {"message": "Request body must be valid JSON"}})
            return None

        if not isinstance(parsed, dict):
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": {"message": "Request body must be a JSON object"}})
            return None
        return parsed

    def _send_streaming_response(self, *, model: str, content: str) -> None:
        self.send_response(HTTPStatus.OK)
        self._send_common_headers(content_type="text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.end_headers()

        for chunk in _split_stream_chunks(content):
            self._write_sse(_build_stream_chunk(model=model, content=chunk, finish_reason=None))
            time.sleep(STREAM_CHUNK_DELAY_SECONDS)
        self._write_sse(_build_stream_chunk(model=model, content="", finish_reason="stop"))
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()

    def _write_sse(self, payload: dict[str, Any]) -> None:
        self.wfile.write(f"data: {json.dumps(payload, ensure_ascii=False)}\n\n".encode("utf-8"))
        self.wfile.flush()

    def _send_json(self, status: HTTPStatus, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self._send_common_headers(content_type="application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_empty_response(self, status: HTTPStatus) -> None:
        self.send_response(status)
        self._send_common_headers(content_type="text/plain")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _send_common_headers(self, *, content_type: str) -> None:
        self.send_header("Content-Type", f"{content_type}; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")


def main() -> None:
    """Start the local no-auth chat-completions server."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1", help="Host interface to bind.")
    parser.add_argument("--port", default=DEFAULT_PORT, type=int, help="Port to listen on.")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="[%(asctime)s][%(levelname)s] %(message)s")
    server = ThreadingHTTPServer((args.host, args.port), LocalChatCompletionHandler)
    logger.info("Local no-auth chat-completions API listening at http://%s:%d/openai/v1", args.host, args.port)
    logger.info("Use this as BYOM endpoint in VoiceLiveBYOMTest: http://%s:%d/openai/v1", args.host, args.port)
    server.serve_forever()


def _is_chat_completion_path(path: str) -> bool:
    normalized_path = path.split("?", 1)[0].rstrip("/")
    return normalized_path in {"/chat/completions", "/v1/chat/completions", "/openai/v1/chat/completions"}


def _build_response_text(request: dict[str, Any]) -> str:
    last_user_message = _find_last_user_message(request.get("messages", []))
    if not last_user_message:
        return "Hello from the local no-auth BYOM chat completion API."
    return f"Local BYOM API received: {last_user_message}"


def _log_chat_request(*, request: dict[str, Any], response_content: str) -> None:
    """Log the received chat request and generated response without credentials."""
    messages = request.get("messages", [])
    logger.info(
        "chat.completions received model=%s stream=%s message_count=%d last_user=%r",
        request.get("model"),
        request.get("stream", False),
        len(messages) if isinstance(messages, list) else 0,
        _truncate_log_text(_find_last_user_message(messages)),
    )
    logger.info("chat.completions returning content=%r", _truncate_log_text(response_content))


def _find_last_user_message(messages: object) -> str:
    if not isinstance(messages, list):
        return ""

    for message in reversed(messages):
        if not isinstance(message, dict) or message.get("role") != "user":
            continue
        content = message.get("content")
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            return _join_text_content(content)
    return ""


def _truncate_log_text(text: str) -> str:
    if len(text) <= MAX_LOG_TEXT_LENGTH:
        return text
    return f"{text[:MAX_LOG_TEXT_LENGTH]}...<truncated>"


def _join_text_content(content_parts: list[object]) -> str:
    texts: list[str] = []
    for part in content_parts:
        if isinstance(part, dict) and isinstance(part.get("text"), str):
            texts.append(part["text"])
    return " ".join(texts)


def _build_completion_response(*, model: str, content: str) -> dict[str, Any]:
    return {
        "id": f"chatcmpl-local-{int(time.time() * 1000)}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": model,
        "choices": [{"index": 0, "message": {"role": "assistant", "content": content}, "finish_reason": "stop"}],
    }


def _build_stream_chunk(*, model: str, content: str, finish_reason: str | None) -> dict[str, Any]:
    return {
        "id": f"chatcmpl-local-{int(time.time() * 1000)}",
        "object": "chat.completion.chunk",
        "created": int(time.time()),
        "model": model,
        "choices": [{"index": 0, "delta": {"content": content}, "finish_reason": finish_reason}],
    }


def _split_stream_chunks(content: str) -> list[str]:
    words = content.split()
    if not words:
        return [""]
    return [f"{word} " for word in words]


if __name__ == "__main__":
    main()
