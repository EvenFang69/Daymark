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


class ThemeSettingsAPI(unittest.TestCase):
    def test_theme_defaults_update_and_validate(self):
        with tempfile.TemporaryDirectory() as directory:
            db_path = Path(directory) / "journal.sqlite3"
            attachments_path = Path(directory) / "attachments"
            with patch.object(app, "DB_PATH", db_path), patch.object(app, "ATTACHMENTS_DIR", attachments_path):
                app.init_db()
                app.ensure_local_user()
                server = app.ThreadingHTTPServer(("127.0.0.1", 0), app.AppHandler)
                worker = threading.Thread(target=server.serve_forever, daemon=True)
                worker.start()
                url = f"http://127.0.0.1:{server.server_port}/api/settings"

                def patch_settings(payload):
                    request = urllib.request.Request(
                        url,
                        json.dumps(payload).encode(),
                        {"Content-Type": "application/json"},
                        method="PATCH",
                    )
                    try:
                        with urllib.request.urlopen(request, timeout=5) as response:
                            return response.status, json.load(response)
                    except urllib.error.HTTPError as error:
                        return error.code, json.load(error)

                try:
                    settings = app.fetch_settings(1)
                    self.assertEqual(settings["appearance_mode"], "auto")
                    self.assertEqual(settings["dark_mode_start"], "20:00")
                    self.assertEqual(settings["light_mode_start"], "07:00")

                    status, body = patch_settings({
                        "timezone": "Asia/Shanghai",
                        "business_day_cutoff": "04:00",
                        "display_name": "我",
                        "appearance_mode": "auto",
                        "dark_mode_start": "21:30",
                        "light_mode_start": "06:15",
                    })
                    self.assertEqual(status, 200)
                    self.assertEqual(body["settings"]["dark_mode_start"], "21:30")
                    self.assertEqual(body["settings"]["light_mode_start"], "06:15")

                    status, body = patch_settings({
                        "timezone": "Asia/Shanghai",
                        "business_day_cutoff": "04:00",
                        "display_name": "我",
                        "appearance_mode": "dark",
                    })
                    self.assertEqual(status, 200)
                    self.assertEqual(body["settings"]["appearance_mode"], "dark")
                    self.assertEqual(body["settings"]["dark_mode_start"], "21:30")
                    self.assertEqual(body["settings"]["light_mode_start"], "06:15")

                    status, _ = patch_settings({
                        "timezone": "Asia/Shanghai",
                        "business_day_cutoff": "04:00",
                        "display_name": "我",
                        "appearance_mode": "auto",
                        "dark_mode_start": "08:00",
                        "light_mode_start": "08:00",
                    })
                    self.assertEqual(status, 400)
                finally:
                    server.shutdown()
                    server.server_close()
                    worker.join()


if __name__ == "__main__":
    unittest.main()
