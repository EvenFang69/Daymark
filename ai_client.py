"""Bounded AI transport. Never persist provider messages or private request bodies."""

import json
import os
import socket
import ssl
import time
import threading
import urllib.error
import urllib.request
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime


SAFE_ERRORS = {
    "missing_api_key", "authentication_failed", "permission_denied", "insufficient_quota",
    "rate_limit_exceeded", "api_timeout", "connection_failed", "tls_error", "upstream_unavailable",
    "unsupported_endpoint", "unsupported_format", "unsupported_image", "invalid_request",
    "invalid_response", "invalid_json_output", "invalid_schema_output", "output_truncated",
    "model_refusal", "empty_output", "internal_error", "report_sources_changed", "api_error",
}
RETRYABLE = {"rate_limit_exceeded", "api_timeout", "connection_failed", "upstream_unavailable", "empty_output", "report_sources_changed"}
_request_lock = threading.Lock()
_cooldown_until = 0


class ErrorCode(str):
    def __new__(cls, code, retry_after=0):
        result = super().__new__(cls, code if code in SAFE_ERRORS else "internal_error")
        result.retry_after = max(0, int(retry_after))
        return result


class AIJobError(RuntimeError):
    def __init__(self, error):
        self.error = ErrorCode(str(error), getattr(error, "retry_after", 0))
        super().__init__(self.error)


def retry_seconds(value):
    try:
        return max(0, int(float(value)))
    except (ValueError, TypeError):
        try:
            return max(0, int((parsedate_to_datetime(value) - datetime.now(timezone.utc)).total_seconds()))
        except (ValueError, TypeError, OverflowError):
            return 0


def http_error(status, body, headers):
    error = body.get("error", {}) if isinstance(body, dict) else {}
    error = error if isinstance(error, dict) else {}
    # Inspect, but do not log/store, arbitrary provider text (it may echo input).
    description = " ".join(str(error.get(key, "")) for key in ("code", "type", "param", "message")).lower()
    if any(value in description for value in ("insufficient_quota", "quota_exceeded", "insufficient balance", "余额不足")):
        code = "insufficient_quota"
    elif status == 401:
        code = "authentication_failed"
    elif status == 403:
        code = "permission_denied"
    elif status == 429:
        code = "rate_limit_exceeded"
    elif status in (408, 504):
        code = "api_timeout"
    elif status >= 500:
        code = "upstream_unavailable"
    elif status in (404, 405, 501):
        code = "unsupported_endpoint"
    elif status in (400, 422) and any(term in description for term in ("image_url", "input_image", "vision", "image format")):
        code = "unsupported_image"
    elif status in (400, 422) and any(term in description for term in ("response_format", "json_schema", "text.format", "structured output")):
        code = "unsupported_format"
    else:
        code = "invalid_request"
    return ErrorCode(code, retry_seconds(headers.get("Retry-After")))


def request_json(base_url, path, api_key, payload, timeout_seconds):
    global _cooldown_until
    with _request_lock:
        remaining = _cooldown_until - time.monotonic()
        if remaining > 0:
            return None, ErrorCode("rate_limit_exceeded", int(remaining) + 1)
        started = time.monotonic()
        request = urllib.request.Request(
            base_url + path, data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers={"Authorization": "Bearer " + api_key, "Content-Type": "application/json",
                     "Accept": "application/json", "User-Agent": os.getenv("OPENAI_USER_AGENT", "PrivateJournal/0.1")},
            method="POST",
        )
        result, error = None, None
        try:
            with urllib.request.urlopen(request, timeout=float(timeout_seconds)) as response:
                result = json.loads(response.read().decode("utf-8"))
            if not isinstance(result, dict):
                result, error = None, ErrorCode("invalid_response")
            elif result.get("error"):
                error = http_error(400, result, {})
                result = None
        except urllib.error.HTTPError as exc:
            try:
                body = json.loads(exc.read().decode("utf-8"))
            except (UnicodeError, ValueError):
                body = {}
            error = http_error(exc.code, body, exc.headers)
        except (socket.timeout, TimeoutError):
            error = ErrorCode("api_timeout")
        except urllib.error.URLError as exc:
            reason = exc.reason
            error = ErrorCode("api_timeout" if isinstance(reason, (socket.timeout, TimeoutError)) else
                              "tls_error" if isinstance(reason, ssl.SSLError) else "connection_failed")
        except (UnicodeError, ValueError):
            error = ErrorCode("invalid_response")
        except OSError:
            error = ErrorCode("connection_failed")
        if error == "rate_limit_exceeded":
            _cooldown_until = time.monotonic() + max(60, error.retry_after)
        print(f"[ai] endpoint={path} duration={time.monotonic()-started:.1f}s result={error or 'received'}")
        return result, error


def schema_matches(value, schema):
    """Validate the JSON Schema subset used by this application's two schemas."""
    expected = schema.get("type")
    types = expected if isinstance(expected, list) else [expected]
    checks = {"object": isinstance(value, dict), "array": isinstance(value, list),
              "string": isinstance(value, str), "boolean": isinstance(value, bool),
              "integer": isinstance(value, int) and not isinstance(value, bool),
              "number": isinstance(value, (int, float)) and not isinstance(value, bool), "null": value is None}
    if expected and not any(checks.get(kind, False) for kind in types):
        return False
    if "enum" in schema and value not in schema["enum"]:
        return False
    if isinstance(value, dict):
        properties = schema.get("properties", {})
        if not all(key in value for key in schema.get("required", [])):
            return False
        if schema.get("additionalProperties") is False and any(key not in properties for key in value):
            return False
        return all(schema_matches(item, properties[key]) for key, item in value.items() if key in properties)
    if isinstance(value, list) and "items" in schema:
        return all(schema_matches(item, schema["items"]) for item in value)
    return True


def parse_output(body, schema, mode):
    if not isinstance(body, dict):
        return None, ErrorCode("invalid_response")
    if mode == "responses":
        if body.get("status") == "incomplete":
            return None, ErrorCode("output_truncated")
        content = [part for item in body.get("output", []) if isinstance(item, dict)
                   for part in item.get("content", []) if isinstance(part, dict)]
        if any(part.get("type") == "refusal" for part in content):
            return None, ErrorCode("model_refusal")
        text = body.get("output_text") or "".join(part.get("text", "") for part in content if part.get("type") in ("output_text", "text"))
    else:
        choice = (body.get("choices") or [{}])[0]
        if choice.get("finish_reason") == "length":
            return None, ErrorCode("output_truncated")
        message = choice.get("message") or {}
        if message.get("refusal") or choice.get("finish_reason") == "content_filter":
            return None, ErrorCode("model_refusal")
        text = message.get("content") or ""
        if isinstance(text, list):
            text = "".join(part.get("text", "") for part in text if isinstance(part, dict))
    if not isinstance(text, str) or not text.strip():
        return None, ErrorCode("empty_output")
    try:
        data = json.loads(text)
    except ValueError:
        return None, ErrorCode("invalid_json_output")
    if not schema_matches(data, schema):
        return None, ErrorCode("invalid_schema_output")
    return data, None


def openai_json(schema_name, schema, system_text, user_text, model, image_data_urls=None):
    key = os.getenv("OPENAI_API_KEY", "").strip()
    if not key:
        return None, ErrorCode("missing_api_key")
    base = os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1").rstrip("/")
    mode = os.getenv("OPENAI_API_MODE", "auto")
    images = [url for url in (image_data_urls or []) if isinstance(url, str) and url.startswith("data:image/")][:4]
    budget = int(os.getenv("OPENAI_MAX_OUTPUT_TOKENS", "6000"))
    common = {"model": model, "store": False}
    if mode in ("auto", "responses"):
        payload = {**common, "max_output_tokens": budget,
                   "input": [{"role": "system", "content": system_text}, {"role": "user", "content":
                      [{"type": "input_text", "text": user_text}] + [{"type": "input_image", "image_url": url} for url in images]}],
                   "text": {"format": {"type": "json_schema", "name": schema_name, "strict": True, "schema": schema}}}
        body, error = request_json(base, "/responses", key, payload, os.getenv("OPENAI_RESPONSES_TIMEOUT_SECONDS", "120"))
        if not error:
            return parse_output(body, schema, "responses")
        if mode == "responses" or error not in ("unsupported_endpoint", "unsupported_format"):
            return None, error
    payload = {**common, "max_tokens": budget,
               "messages": [{"role": "system", "content": system_text}, {"role": "user", "content":
                 [{"type": "text", "text": user_text}] + [{"type": "image_url", "image_url": {"url": url}} for url in images] if images else user_text}],
               "response_format": {"type": "json_schema", "json_schema": {"name": schema_name, "strict": True, "schema": schema}}}
    effort = os.getenv("OPENAI_REASONING_EFFORT", "")
    if effort:
        payload["reasoning_effort"] = effort
    timeout = os.getenv("OPENAI_CHAT_TIMEOUT_SECONDS", "120")
    body, error = request_json(base, "/chat/completions", key, payload, timeout)
    # Compatibility is not a retry policy: never resend an ambiguous timeout/429.
    if error == "unsupported_format":
        payload["response_format"] = {"type": "json_object"}
        payload["messages"][0]["content"] += "\nReturn JSON matching this schema: " + json.dumps(schema)
        body, error = request_json(base, "/chat/completions", key, payload, timeout)
    if error:
        return None, error
    return parse_output(body, schema, "chat_completions")
