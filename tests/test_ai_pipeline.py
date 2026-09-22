import io
import json
import os
import socket
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import patch
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import app
import ai_client as ai


SCHEMA = {"type": "object", "properties": {"summary": {"type": "string"}},
          "required": ["summary"], "additionalProperties": False}
BODY = {"choices": [{"finish_reason": "stop", "message": {"content": '{"summary":"Saved"}'}}]}


class AITransport(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, {"OPENAI_API_KEY": "test-secret", "OPENAI_API_MODE": "chat_completions", "OPENAI_CHAT_TIMEOUT_SECONDS": "150"})
        self.env.start()
        ai._cooldown_until = 0

    def tearDown(self):
        self.env.stop()
        ai._cooldown_until = 0

    def call(self):
        return ai.openai_json("test", SCHEMA, "Return JSON", "private original", "test-model")

    def test_timeout_does_not_trigger_second_format_request(self):
        with patch.object(ai, "request_json", return_value=(None, ai.ErrorCode("api_timeout"))) as request:
            result, error = self.call()
        self.assertIsNone(result)
        self.assertEqual(error, "api_timeout")
        self.assertEqual(request.call_count, 1)
        self.assertEqual(request.call_args.args[-1], "150")

    def test_rate_limit_does_not_retry_and_cooldown_blocks_other_calls(self):
        body = json.dumps({"error": {"code": "rate_limit_exceeded", "message": "secret private original"}}).encode()
        failure = urllib.error.HTTPError("https://example.test", 429, "limited", {"Retry-After": "90"}, io.BytesIO(body))
        with patch.object(ai.urllib.request, "urlopen", side_effect=failure) as request, patch("sys.stdout", new_callable=io.StringIO) as logs:
            _, error = self.call()
            _, waiting = self.call()
        self.assertEqual(error, "rate_limit_exceeded")
        self.assertEqual(error.retry_after, 90)
        self.assertEqual(waiting, "rate_limit_exceeded")
        self.assertEqual(request.call_count, 1)
        self.assertNotIn("private original", logs.getvalue())
        self.assertNotIn("test-secret", logs.getvalue())

    def test_socket_timeout_has_specific_safe_error(self):
        with patch.object(ai.urllib.request, "urlopen", side_effect=socket.timeout()):
            _, error = self.call()
        self.assertEqual(error, "api_timeout")

    def test_format_rejection_falls_back_with_schema_in_prompt(self):
        with patch.object(ai, "request_json", side_effect=[(None, ai.ErrorCode("unsupported_format")), (BODY, None)]) as request:
            result, error = self.call()
        self.assertIsNone(error)
        self.assertEqual(result["summary"], "Saved")
        payload = request.call_args.args[3]
        self.assertIn('"required": ["summary"]', payload["messages"][0]["content"])
        self.assertEqual(payload["response_format"]["type"], "json_object")
        self.assertFalse(payload["store"])

    def test_truncated_json_refusal_and_missing_fields_cannot_archive(self):
        cases = [
            ({"choices": [{"finish_reason": "length", "message": {"content": '{"summary":"almost"}'}}]}, "output_truncated"),
            ({"choices": [{"message": {"refusal": "no"}}]}, "model_refusal"),
            ({"choices": [{"message": {"content": "not json"}}]}, "invalid_json_output"),
            ({"choices": [{"message": {"content": "{}"}}]}, "invalid_schema_output"),
            ({"choices": []}, "empty_output"),
        ]
        for body, expected in cases:
            with self.subTest(expected=expected):
                self.assertEqual(ai.parse_output(body, SCHEMA, "chat_completions")[1], expected)

    def test_responses_success_and_incomplete(self):
        with patch.dict(os.environ, {"OPENAI_API_MODE": "responses"}), patch.object(ai, "request_json", return_value=({"status": "completed", "output_text": '{"summary":"Saved"}'}, None)):
            self.assertEqual(self.call()[0]["summary"], "Saved")
        self.assertEqual(ai.parse_output({"status": "incomplete"}, SCHEMA, "responses")[1], "output_truncated")

    def test_http_strings_and_quota_are_safe_and_distinct(self):
        self.assertEqual(ai.http_error(401, {"error": "private token"}, {}), "authentication_failed")
        self.assertEqual(ai.http_error(429, {"error": {"code": "insufficient_quota"}}, {}), "insufficient_quota")
        self.assertEqual(ai.http_error(500, {}, {}), "upstream_unavailable")


class AIJobs(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.db_patch = patch.object(app, "DB_PATH", root / "journal.sqlite3")
        self.files_patch = patch.object(app, "ATTACHMENTS_DIR", root / "attachments")
        self.db_patch.start()
        self.files_patch.start()
        app.init_db()
        app.ensure_local_user()
        with app.db() as conn:
            now = app.utc_now()
            self.entry = conn.execute("INSERT INTO entries(user_id,created_at,record_date,raw_text,status,updated_at,ai_state) VALUES(1,?,'2026-09-09','Original evidence','recorded',?,'pending')", (now, now)).lastrowid
            conn.execute("INSERT INTO conversations(entry_id,created_at) VALUES(?,?)", (self.entry, now))
        self.job_id = app.enqueue_job(1, "entry_analysis", entry_id=self.entry)

    def tearDown(self):
        self.files_patch.stop()
        self.db_patch.stop()
        self.tmp.cleanup()

    def state(self):
        with app.db() as conn:
            return app.serialize_entry(conn, conn.execute("SELECT * FROM entries WHERE id=?", (self.entry,)).fetchone())

    def test_retry_state_is_not_failure_and_original_survives_then_recovers(self):
        job = app.claim_job()
        with patch.object(app, "analyze_entry", return_value=(None, ai.ErrorCode("api_timeout"))):
            with self.assertRaises(ai.AIJobError) as error:
                app.process_entry_job(job)
        app.finish_job(job["id"], error.exception.error)
        entry = self.state()
        self.assertEqual(entry["raw_text"], "Original evidence")
        self.assertEqual(entry["ai_state"], "retrying")
        self.assertEqual(entry["ai_error"], "api_timeout")
        self.assertEqual(entry["ai_job"]["status"], "queued")
        self.assertIsNone(entry["analysis"])
        with app.db() as conn:
            conn.execute("UPDATE ai_jobs SET available_at=?", (app.utc_now(),))
        job = app.claim_job()
        analysis = {"summary": "Real structured understanding", "needs_followup": False}
        with patch.object(app, "analyze_entry", return_value=(analysis, "openai")), patch.object(app, "schedule_period_reports"):
            app.process_entry_job(job)
        app.finish_job(job["id"])
        entry = self.state()
        self.assertEqual(entry["ai_state"], "ready")
        self.assertEqual(entry["raw_text"], "Original evidence")
        self.assertEqual(entry["analysis"]["summary"], analysis["summary"])

    def test_terminal_error_stops_and_unexpected_error_is_visible(self):
        job = app.claim_job()
        app.finish_job(job["id"], ai.ErrorCode("authentication_failed"))
        self.assertEqual(self.state()["ai_job"]["status"], "failed")
        self.assertEqual(self.state()["ai_state"], "failed")
        self.assertIsNone(app.claim_job())

    def test_model_cannot_move_the_server_resolved_record_date(self):
        job = app.claim_job()
        analysis = {
            "summary": "Understood",
            "needs_followup": False,
            "detected_record_date": "2026-09-08",
        }
        with patch.object(app, "analyze_entry", return_value=(analysis, "openai")), patch.object(app, "schedule_period_reports"):
            app.process_entry_job(job)
        entry = self.state()
        self.assertEqual(entry["record_date"], "2026-09-09")
        self.assertEqual(entry["analysis"]["detected_record_date"], "2026-09-09")
        with app.db() as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM corrections WHERE reason='ai_date_detection'").fetchone()[0], 0)

    def test_rate_limit_cooldown_survives_restart_and_covers_new_jobs(self):
        job = app.claim_job()
        app.finish_job(job["id"], ai.ErrorCode("rate_limit_exceeded", 180))
        app.enqueue_job(1, "report", report_type="daily", start_date="2026-09-09", end_date="2026-09-09")
        self.assertIsNone(app.claim_job())
        app.recover_background_state()
        self.assertIsNone(app.claim_job())
        self.assertEqual(self.state()["ai_state"], "retrying")

    def test_retry_limit_is_finite(self):
        with app.db() as conn:
            conn.execute("UPDATE ai_jobs SET attempts=3,status='running' WHERE id=?", (self.job_id,))
        app.finish_job(self.job_id, ai.ErrorCode("api_timeout"))
        self.assertEqual(self.state()["ai_job"]["status"], "failed")
        self.assertEqual(self.state()["ai_state"], "failed")

    def test_supplement_context_stays_structured_and_retains_attachments(self):
        with app.db() as conn:
            conversation = conn.execute("SELECT id FROM conversations WHERE entry_id=?", (self.entry,)).fetchone()[0]
            conn.execute("INSERT INTO messages(conversation_id,role,kind,content,created_at) VALUES(?,'user','supplemental','More evidence',?)", (conversation, app.utc_now()))
            conn.execute("INSERT INTO messages(conversation_id,role,kind,content,created_at) VALUES(?,'user','supplemental','More evidence',?)", (conversation, app.utc_now()))
        with patch.object(app, "analyze_entry", return_value=({"summary": "Understood"}, "openai")) as analyze, patch.object(app, "schedule_period_reports"):
            app.process_reply_job(app.claim_job())
        context = json.loads(analyze.call_args.kwargs["context_text"])
        self.assertEqual(context["supplements"], ["More evidence"])
        self.assertIn("attachments", context)


if __name__ == "__main__":
    unittest.main()
