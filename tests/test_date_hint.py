import unittest
from datetime import datetime
from zoneinfo import ZoneInfo

import app


class DateHintTests(unittest.TestCase):
    def setUp(self):
        self.settings = {
            "timezone": "Asia/Shanghai",
            "business_day_cutoff": "04:00",
        }
        self.now = datetime(2026, 9, 9, 20, 0, tzinfo=ZoneInfo("Asia/Shanghai"))

    def test_leading_today_wins_over_historical_yesterday_context(self):
        text = "今天，包子捏捏乐到了。昨天的 ADS 投流效果不好。"
        self.assertEqual(app.parse_date_hint(text, self.settings, self.now), "2026-09-09")

    def test_leading_supplement_yesterday_still_uses_yesterday(self):
        self.assertEqual(
            app.parse_date_hint("补一下昨天的记录，昨天上架了一个商品。", self.settings, self.now),
            "2026-09-08",
        )

    def test_plain_historical_reference_does_not_move_current_entry(self):
        self.assertEqual(
            app.parse_date_hint("今天复盘昨天的投放效果。", self.settings, self.now),
            "2026-09-09",
        )

    def test_evening_after_five_am_cutoff_stays_on_current_date(self):
        settings = {**self.settings, "business_day_cutoff": "05:00"}
        now = datetime(2026, 9, 16, 21, 27, tzinfo=ZoneInfo("Asia/Shanghai"))
        self.assertEqual(app.business_date(settings, now), "2026-09-16")
        self.assertEqual(app.parse_date_hint("今天处理了新的工作。", settings, now), "2026-09-16")

    def test_before_five_am_cutoff_uses_previous_business_date(self):
        settings = {**self.settings, "business_day_cutoff": "05:00"}
        now = datetime(2026, 9, 16, 4, 16, tzinfo=ZoneInfo("Asia/Shanghai"))
        self.assertEqual(app.business_date(settings, now), "2026-09-15")


if __name__ == "__main__":
    unittest.main()
