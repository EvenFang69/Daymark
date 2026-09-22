"""Isolated, deliberately slow UI fixture. No personal database or AI calls."""
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import app


class SlowHandler(app.AppHandler):
    def do_GET(self):
        if self.path == '/__tests__/dom':
            return self.send_file(Path(__file__).with_name('dom.test.html'))
        if self.path.startswith(('/api/timeline', '/api/calendar', '/api/entries/')):
            time.sleep(0.6 if '09-08' in self.path else 0.2)
        super().do_GET()

    def log_message(self, *args):
        pass


def main():
    with tempfile.TemporaryDirectory(prefix='journal-ui-') as directory:
        app.DB_PATH = Path(directory) / 'journal.sqlite3'
        app.init_db()
        user = app.ensure_local_user()
        day = app.business_date(app.fetch_settings(user['id']))
        now = app.utc_now()
        with app.db() as conn:
            for index in range(3):
                text = f'交互测试记录 {index + 1}。今天完成视频剪辑，产品判断还需要验证。\n' * 8
                entry_id = conn.execute(
                    'INSERT INTO entries(user_id, created_at, record_date, raw_text, status, updated_at, ai_state) VALUES(?,?,?,?,?,?,?)',
                    (user['id'], now, day, text, 'archived', now, 'ready'),
                ).lastrowid
                conversation_id = conn.execute('INSERT INTO conversations(entry_id, created_at) VALUES(?,?)', (entry_id, now)).lastrowid
                conn.execute('INSERT INTO messages(conversation_id, role, kind, content, created_at) VALUES(?,?,?,?,?)', (conversation_id, 'user', 'original', text, now))
                analysis = {'summary': f'测试日志 {index + 1}：完成视频剪辑，继续验证产品判断。', 'progress': ['完成两条视频'], 'problems': ['产品需求尚未验证'], 'next_actions': ['对照历史推广记录'], 'record_type': ['工作'], 'tags': ['测试']}
                conn.execute('INSERT INTO entry_analysis(entry_id, version, data_json, created_at, is_final) VALUES(?,?,?,?,1)', (entry_id, 1, app.json_dumps(analysis), now))
        server = app.ThreadingHTTPServer(('127.0.0.1', 8766), SlowHandler)
        print('Isolated UI fixture: http://127.0.0.1:8766/', flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            server.server_close()


if __name__ == '__main__':
    main()
