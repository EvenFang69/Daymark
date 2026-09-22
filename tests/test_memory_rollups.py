import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import app
import journal_memory as memory


class MemoryRollups(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db_patch = patch.object(app, "DB_PATH", Path(self.tmp.name) / "journal.sqlite3")
        self.attachments_patch = patch.object(
            app, "ATTACHMENTS_DIR", Path(self.tmp.name) / "attachments"
        )
        self.db_patch.start()
        self.attachments_patch.start()
        app.init_db()
        app.ensure_local_user()

    def tearDown(self):
        self.attachments_patch.stop()
        self.db_patch.stop()
        self.tmp.cleanup()

    def test_many_repeated_proposals_become_three_focuses_without_losing_detail(self):
        with app.db() as conn:
            for index in range(48):
                if index % 3 == 0:
                    text = f"项目验证建议 {index}"
                elif index % 3 == 1:
                    text = f"内容发布流程验证建议 {index}"
                else:
                    text = f"学习复盘数据核验建议 {index}"
                memory.propose(conn, 1, "action", text, "来自复盘", [{"entry_id": index + 1}])

            compact = memory.dashboard(conn, 1)
            detail = memory.dashboard(conn, 1, detail=True)

        self.assertLessEqual(len(compact["rollups"]), 3)
        self.assertEqual(compact["proposals"], [])
        self.assertEqual(compact["proposal_count"], 48)
        self.assertEqual(len(detail["proposals"]), 48)
        assigned = {
            proposal_id
            for rollup in compact["rollups"]
            for proposal_id in rollup["proposal_ids"]
        }
        self.assertEqual(assigned, set(range(1, 49)))

    def test_dashboard_rebuilds_derived_view_after_status_change(self):
        with app.db() as conn:
            memory.propose(conn, 1, "action", "整理内容发布流程", "复盘", [{"entry_id": 1}])
            before = memory.dashboard(conn, 1)
            proposal_id = before["rollups"][0]["proposal_ids"][0]
            memory.transition(conn, 1, proposal_id, "dismissed")
            after = memory.dashboard(conn, 1)

        self.assertEqual(after["active_proposal_count"], 0)
        self.assertEqual(after["rollups"], [])
        self.assertEqual(after["proposal_count"], 1)

    def test_daily_report_next_actions_stay_inside_report(self):
        timestamp = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
        with app.db() as conn:
            entry_id = conn.execute(
                """
                INSERT INTO entries(
                    user_id,created_at,record_date,raw_text,status,updated_at,
                    ai_state,ai_error,ai_updated_at,request_id
                ) VALUES(?,?,?,?,?,?,?,?,?,?)
                """,
                (
                    1,
                    timestamp,
                    "2026-09-13",
                    "今天完成了一项工作。",
                    "recorded",
                    timestamp,
                    "ready",
                    "",
                    timestamp,
                    "daily-report-test",
                ),
            ).lastrowid
            conversation_id = conn.execute(
                "INSERT INTO conversations(entry_id,created_at) VALUES(?,?)",
                (entry_id, timestamp),
            ).lastrowid
            conn.execute(
                """
                INSERT INTO messages(conversation_id,role,kind,content,created_at)
                VALUES(?,'user','original',?,?)
                """,
                (conversation_id, "今天完成了一项工作。", timestamp),
            )

        content = {
            "title": "每日复盘",
            "period_label": "2026-09-13",
            "sections": [
                {
                    "key": "next_actions",
                    "label": "下一步",
                    "items": [
                        {
                            "text": "明天继续验证这个方向",
                            "source_entry_ids": [entry_id],
                        }
                    ],
                }
            ],
            "observation": "",
            "themes": [],
            "action_candidates": [],
        }
        with patch.object(app, "generate_report", return_value=(content, "test")):
            with patch.object(app, "schedule_memory_digest") as schedule_digest:
                app.persist_report(1, "daily", "2026-09-13", "2026-09-13")
                schedule_digest.assert_not_called()

        with app.db() as conn:
            self.assertEqual(
                conn.execute(
                    "SELECT COUNT(*) FROM proposals WHERE user_id=? AND kind='action'",
                    (1,),
                ).fetchone()[0],
                0,
            )
            report = conn.execute(
                "SELECT content_json FROM daily_reports WHERE user_id=? AND report_type='daily'",
                (1,),
            ).fetchone()
            self.assertIn("明天继续验证这个方向", report["content_json"])

    def test_long_term_actions_need_cross_date_evidence_or_a_blocker(self):
        timestamp = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
        with app.db() as conn:
            first = conn.execute(
                """
                INSERT INTO entries(
                    user_id,created_at,record_date,raw_text,status,updated_at,
                    ai_state,ai_error,ai_updated_at,request_id
                ) VALUES(?,?,?,?,?,?,?,?,?,?)
                """,
                (
                    1,
                    timestamp,
                    "2026-09-12",
                    "记录一",
                    "recorded",
                    timestamp,
                    "ready",
                    "",
                    timestamp,
                    "qualifier-test-1",
                ),
            ).lastrowid
            second = conn.execute(
                """
                INSERT INTO entries(
                    user_id,created_at,record_date,raw_text,status,updated_at,
                    ai_state,ai_error,ai_updated_at,request_id
                ) VALUES(?,?,?,?,?,?,?,?,?,?)
                """,
                (
                    1,
                    timestamp,
                    "2026-09-13",
                    "记录二",
                    "recorded",
                    timestamp,
                    "ready",
                    "",
                    timestamp,
                    "qualifier-test-2",
                ),
            ).lastrowid
            self.assertFalse(
                app.qualifies_long_term_action(
                    conn,
                    1,
                    {"text": "明天继续整理素材", "sources": [{"entry_id": first}]},
                )
            )
            self.assertTrue(
                app.qualifies_long_term_action(
                    conn,
                    1,
                    {"text": "继续排查 API 超时，流程尚未跑通", "sources": [{"entry_id": first}]},
                )
            )
            self.assertTrue(
                app.qualifies_long_term_action(
                    conn,
                    1,
                    {"text": "继续整理素材", "sources": [{"entry_id": first}, {"entry_id": second}]},
                )
            )


if __name__ == "__main__":
    unittest.main()
