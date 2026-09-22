import base64
import io
import json
import tempfile
import threading
import unittest
import urllib.request
import zipfile
from pathlib import Path
from unittest.mock import patch

import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import app


def multipart(fields, files):
    boundary = "----PrivateJournalAttachmentTest"
    body = bytearray()
    for name, value in fields.items():
        body.extend(f"--{boundary}\r\n".encode())
        body.extend(f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode())
        body.extend(str(value).encode())
        body.extend(b"\r\n")
    for name, filename, mime_type, data in files:
        body.extend(f"--{boundary}\r\n".encode())
        body.extend(
            f'Content-Disposition: form-data; name="{name}"; filename="{filename}"\r\n'.encode()
        )
        body.extend(f"Content-Type: {mime_type}\r\n\r\n".encode())
        body.extend(data)
        body.extend(b"\r\n")
    body.extend(f"--{boundary}--\r\n".encode())
    return bytes(body), f"multipart/form-data; boundary={boundary}"


class AttachmentAPI(unittest.TestCase):
    def test_upload_is_retrievable_and_embedded_in_sqlite_export_data(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with patch.object(app, "DB_PATH", root / "journal.sqlite3"), patch.object(
                app, "ATTACHMENTS_DIR", root / "attachments"
            ):
                app.init_db()
                app.ensure_local_user()
                server = app.ThreadingHTTPServer(("127.0.0.1", 0), app.AppHandler)
                worker = threading.Thread(target=server.serve_forever, daemon=True)
                worker.start()
                base_url = f"http://127.0.0.1:{server.server_port}"
                raw_file = b"source material: a product assumption still needs verification"
                payload, content_type = multipart(
                    {
                        "text": "这是一条带资料的测试记录",
                        "request_id": "b" * 32,
                    },
                    [
                        (
                            "attachments",
                            "../research-note.txt",
                            "text/plain",
                            raw_file,
                        )
                    ],
                )
                try:
                    request = urllib.request.Request(
                        f"{base_url}/api/entries",
                        payload,
                        {"Content-Type": content_type},
                    )
                    with urllib.request.urlopen(request, timeout=5) as response:
                        created = json.load(response)["entry"]
                    self.assertEqual(created["attachments"][0]["original_name"], "research-note.txt")
                    self.assertTrue(created["attachments"][0]["has_extracted_text"])
                    attachment_id = created["attachments"][0]["id"]

                    with urllib.request.urlopen(
                        f"{base_url}/api/attachments/{attachment_id}", timeout=5
                    ) as response:
                        self.assertEqual(response.read(), raw_file)

                    with app.db() as conn:
                        row = conn.execute(
                            "SELECT data_blob, extracted_text FROM attachments WHERE id=?",
                            (attachment_id,),
                        ).fetchone()
                    self.assertEqual(row["data_blob"], raw_file)
                    self.assertIn("product assumption", row["extracted_text"])

                    # The SQLite copy is independently recoverable if the readable file vanishes.
                    next((root / "attachments").iterdir()).unlink()
                    with urllib.request.urlopen(
                        f"{base_url}/api/attachments/{attachment_id}", timeout=5
                    ) as response:
                        self.assertEqual(response.read(), raw_file)

                    with urllib.request.urlopen(f"{base_url}/api/export?format=json", timeout=5) as response:
                        exported = json.load(response)
                    blob = next(item for item in exported["attachment_blobs"] if item["id"] == attachment_id)
                    self.assertEqual(base64.b64decode(blob["data_base64"]), raw_file)

                    with urllib.request.urlopen(f"{base_url}/api/export?format=vault", timeout=5) as response:
                        vault = zipfile.ZipFile(io.BytesIO(response.read()))
                    self.assertEqual(vault.read("attachments/1-research-note.txt"), raw_file)
                finally:
                    server.shutdown()
                    server.server_close()
                    worker.join()


if __name__ == "__main__":
    unittest.main()
