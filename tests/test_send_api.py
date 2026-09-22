import concurrent.futures
import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest.mock import patch
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import app


class SendAPI(unittest.TestCase):
    def test_safe_retry_and_original_preservation(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(app, 'DB_PATH', Path(directory) / 'journal.sqlite3'):
            app.init_db()
            app.ensure_local_user()
            app.init_db()  # Existing-database migration must remain repeatable.
            server = app.ThreadingHTTPServer(('127.0.0.1', 0), app.AppHandler)
            worker = threading.Thread(target=server.serve_forever, daemon=True)
            worker.start()
            url = f'http://127.0.0.1:{server.server_port}/api/entries'

            def post(payload):
                request = urllib.request.Request(url, json.dumps(payload).encode(), {'Content-Type': 'application/json'})
                try:
                    with urllib.request.urlopen(request, timeout=5) as response:
                        return response.status, json.load(response)
                except urllib.error.HTTPError as error:
                    return error.code, json.load(error)

            try:
                payload = {'text': '今天发了两条视频。\n' * 400, 'request_id': 'a' * 32}
                # No AI worker is started; only the durable save endpoint runs.
                with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
                    responses = list(pool.map(post, [payload] * 3))
                self.assertEqual({status for status, _ in responses}, {200})
                self.assertEqual(len({body['entry']['id'] for _, body in responses}), 1)
                self.assertEqual(post({**payload, 'text': 'Different content'})[0], 409)
                self.assertEqual(post({'text': '  '})[0], 400)
                self.assertEqual(post({'text': 'x' * 20001})[0], 400)
                self.assertEqual(post({'text': 'next', 'request_id': []})[0], 400)
                with app.db() as conn:
                    self.assertEqual(conn.execute('SELECT COUNT(*) FROM entries').fetchone()[0], 1)
                    self.assertEqual(conn.execute('SELECT raw_text FROM entries').fetchone()[0], payload['text'].strip())
                    self.assertEqual(conn.execute("SELECT COUNT(*) FROM messages WHERE kind='original'").fetchone()[0], 1)
                    self.assertEqual(conn.execute('SELECT COUNT(*) FROM ai_jobs').fetchone()[0], 1)
            finally:
                server.shutdown()
                server.server_close()
                worker.join()

    def test_followup_reply_is_acknowledged_once_while_processing(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(app, 'DB_PATH', Path(directory) / 'journal.sqlite3'):
            app.init_db()
            app.ensure_local_user()
            now = app.utc_now()
            with app.db() as conn:
                entry_id = conn.execute(
                    "INSERT INTO entries(user_id,created_at,record_date,raw_text,status,updated_at,ai_state) VALUES(1,?,'2026-09-13','Original','needs_followup',?,'ready')",
                    (now, now),
                ).lastrowid
                conversation_id = conn.execute(
                    "INSERT INTO conversations(entry_id,created_at) VALUES(?,?)", (entry_id, now)
                ).lastrowid
                conn.execute(
                    "INSERT INTO messages(conversation_id,role,kind,content,created_at) VALUES(?,'assistant','followup','Continue?',?)",
                    (conversation_id, now),
                )
                conn.execute(
                    "INSERT INTO entry_analysis(entry_id,version,data_json,created_at,is_final) VALUES(?,1,?,?,0)",
                    (entry_id, json.dumps({'summary': 'Draft', 'needs_followup': True, 'followup_question': 'Continue?'}), now),
                )
            server = app.ThreadingHTTPServer(('127.0.0.1', 0), app.AppHandler)
            worker = threading.Thread(target=server.serve_forever, daemon=True)
            worker.start()
            url = f'http://127.0.0.1:{server.server_port}/api/entries/{entry_id}/reply'

            def reply():
                request = urllib.request.Request(
                    url, json.dumps({'text': 'Lower priority for now.'}).encode(),
                    {'Content-Type': 'application/json'},
                )
                with urllib.request.urlopen(request, timeout=5) as response:
                    return json.load(response)

            try:
                first = reply()
                second = reply()
                self.assertEqual(first['entry']['ai_state'], 'pending')
                self.assertEqual(second['reply_status'], 'already_received')
                with app.db() as conn:
                    self.assertEqual(conn.execute("SELECT COUNT(*) FROM messages WHERE kind='supplemental'").fetchone()[0], 1)
                    self.assertEqual(conn.execute("SELECT COUNT(*) FROM ai_jobs WHERE job_type='entry_reply'").fetchone()[0], 1)
            finally:
                server.shutdown()
                server.server_close()
                worker.join()

    def test_natural_date_command_and_reversible_delete(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(app, 'DB_PATH', Path(directory) / 'journal.sqlite3'):
            app.init_db()
            app.ensure_local_user()
            server = app.ThreadingHTTPServer(('127.0.0.1', 0), app.AppHandler)
            worker = threading.Thread(target=server.serve_forever, daemon=True)
            worker.start()
            base = f'http://127.0.0.1:{server.server_port}'

            def request(path, method='GET', payload=None):
                body = json.dumps(payload).encode() if payload is not None else None
                req = urllib.request.Request(base + path, body, {'Content-Type': 'application/json'}, method=method)
                with urllib.request.urlopen(req, timeout=5) as response:
                    return json.load(response)

            try:
                created = request('/api/entries', 'POST', {'text': 'Original record', 'request_id': 'original-request-0001'})
                entry_id = created['entry']['id']
                changed = request('/api/entries', 'POST', {
                    'text': '给我把上一条改到2026-09-15',
                    'request_id': 'command-request-0001',
                })
                self.assertEqual(changed['command']['type'], 'date_changed')
                self.assertEqual(changed['entry']['record_date'], '2026-09-15')
                corrected = request('/api/entries', 'POST', {
                    'text': '上一条不是30个，是20个，请更正',
                    'request_id': 'content-command-0001',
                })
                self.assertEqual(corrected['command']['type'], 'content_correction')
                with app.db() as conn:
                    self.assertEqual(conn.execute('SELECT COUNT(*) FROM entries').fetchone()[0], 1)
                    self.assertEqual(conn.execute("SELECT reason FROM corrections").fetchone()[0], 'natural_language')
                    self.assertEqual(conn.execute("SELECT COUNT(*) FROM messages WHERE kind='supplemental'").fetchone()[0], 1)

                request(f'/api/entries/{entry_id}', 'DELETE')
                self.assertEqual(request('/api/entries')['entries'], [])
                restored = request(f'/api/entries/{entry_id}/restore', 'POST')
                self.assertEqual(restored['entry']['id'], entry_id)
                self.assertEqual(len(request('/api/entries')['entries']), 1)
            finally:
                server.shutdown()
                server.server_close()
                worker.join()

    def test_ask_is_saved_then_answered_in_background(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(app, 'DB_PATH', Path(directory) / 'journal.sqlite3'):
            app.init_db()
            app.ensure_local_user()
            now = app.utc_now()
            with app.db() as conn:
                entry_id = conn.execute(
                    "INSERT INTO entries(user_id,created_at,record_date,raw_text,status,updated_at,ai_state) VALUES(1,?,'2026-09-15','最近最需要解决的是项目范围和时间压力。','archived',?,'ready')",
                    (now, now),
                ).lastrowid
                conversation_id = conn.execute(
                    "INSERT INTO conversations(entry_id,created_at) VALUES(?,?)", (entry_id, now)
                ).lastrowid
                conn.execute(
                    "INSERT INTO messages(conversation_id,role,kind,content,created_at) VALUES(?,'user','original','最近最需要解决的是项目范围和时间压力。',?)",
                    (conversation_id, now),
                )
                app.memory.index_entry(conn, entry_id)
            server = app.ThreadingHTTPServer(('127.0.0.1', 0), app.AppHandler)
            worker = threading.Thread(target=server.serve_forever, daemon=True)
            worker.start()
            base = f'http://127.0.0.1:{server.server_port}'

            def request(path, method='GET', payload=None):
                body = json.dumps(payload).encode() if payload is not None else None
                req = urllib.request.Request(base + path, body, {'Content-Type': 'application/json'}, method=method)
                with urllib.request.urlopen(req, timeout=5) as response:
                    return response.status, json.load(response)

            try:
                status, queued = request('/api/ask', 'POST', {
                    'question': '我现在最值得优先解决什么？',
                    'request_id': 'ask-request-00000001',
                })
                self.assertEqual(status, 202)
                self.assertEqual(queued['answer']['status'], 'queued')
                answer_id = queued['answer']['id']
                job = app.claim_job()
                structured = {
                    'answer': '优先收敛项目范围和时间压力。',
                    'evidence': [{'point': '最近的记录直接提到了项目范围和时间压力。', 'source_entry_ids': [entry_id]}],
                    'uncertainty': '',
                    'uncertainty_source_entry_ids': [],
                    'suggested_next_step': '先核对库存占用和未来七天支出。',
                    'suggested_next_step_source_entry_ids': [entry_id],
                    'source_entry_ids': [entry_id],
                }
                with patch.object(app, 'openai_json', return_value=(structured, None)):
                    app.process_answer_job(job)
                app.finish_job(job['id'])
                _, completed = request(f'/api/answers/{answer_id}')
                self.assertEqual(completed['answer']['status'], 'ready')
                self.assertEqual(completed['answer']['content']['answer'], structured['answer'])
                self.assertEqual(completed['answer']['source_entry_ids'], [entry_id])
                _, history = request('/api/answers')
                self.assertEqual(history['answers'][0]['question'], '我现在最值得优先解决什么？')
            finally:
                server.shutdown()
                server.server_close()
                worker.join()


if __name__ == '__main__':
    unittest.main()
