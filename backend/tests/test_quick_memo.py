import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from app.quick_memo import save_quick_memo


class QuickMemoSaveTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.notes_dir = patch("app.quick_memo.notes_dir", return_value=self.root)
        self.notes_dir.start()

    def tearDown(self):
        self.notes_dir.stop()
        self.temp_dir.cleanup()

    def save(self, content="첫 메모", memo_id="memo-1"):
        return save_quick_memo(
            content=content,
            memo_id=memo_id,
            date="2026-07-12",
            captured_at="2026-07-12T14:32:14+09:00",
        )

    def test_creates_daily_note_and_escapes_multiline_plain_text(self):
        result = self.save("# 제목\n\n- 목록과 [링크](https://example.com)")

        self.assertEqual(result.status, "SAVED")
        self.assertTrue(result.created)
        body = (self.root / "daily/2026-07-12.md").read_text(encoding="utf-8")
        self.assertIn("## 오늘 할 일", body)
        self.assertIn("## 메모", body)
        self.assertIn("## 빠른 메모", body)
        self.assertIn("> [!📝] 14:32\n> \\# 제목\n> \n> \\- 목록과 \\[링크\\]\\(https://example\\.com\\)", body)
        self.assertIn("<!-- quick-memo:id=memo-1 -->", body)

    def test_inserts_before_following_level_one_or_two_heading(self):
        path = self.root / "daily/2026-07-12.md"
        path.parent.mkdir(parents=True)
        path.write_text("# 데일리\n\n## 빠른 메모\n\n기존 메모\n\n## 다음 섹션\n내용\n", encoding="utf-8")

        result = self.save()

        self.assertEqual(result.status, "SAVED")
        body = path.read_text(encoding="utf-8")
        self.assertLess(body.index("<!-- quick-memo:id=memo-1 -->"), body.index("## 다음 섹션"))
        self.assertIn("기존 메모", body)

    def test_creates_an_exact_section_without_reusing_a_similar_heading(self):
        path = self.root / "daily/2026-07-12.md"
        path.parent.mkdir(parents=True)
        path.write_text("## 빠른 메모 추가\n\n기존 내용\n", encoding="utf-8")

        result = self.save()

        self.assertEqual(result.status, "SAVED")
        body = path.read_text(encoding="utf-8")
        self.assertIn("## 빠른 메모 추가\n\n기존 내용", body)
        self.assertIn("\n## 빠른 메모\n\n> [!📝] 14:32", body)

    def test_preserves_existing_crlf_and_escapes_html_entities(self):
        path = self.root / "daily/2026-07-12.md"
        path.parent.mkdir(parents=True)
        path.write_bytes("## 빠른 메모\r\n\r\n기존 메모\r\n".encode("utf-8"))

        result = self.save("<b>&lt;안전</b>")

        self.assertEqual(result.status, "SAVED")
        body = path.read_bytes()
        self.assertNotIn(b"\n", body.replace(b"\r\n", b""))
        self.assertIn("> \\<b\\>&amp;lt;안전\\</b\\>", body.decode("utf-8"))

    def test_same_id_is_idempotent(self):
        first = self.save()
        before = (self.root / "daily/2026-07-12.md").read_bytes()
        second = self.save(content="재시도지만 추가하면 안 됨")

        self.assertEqual(first.status, "SAVED")
        self.assertEqual(second.status, "ALREADY_SAVED")
        self.assertEqual(before, (self.root / "daily/2026-07-12.md").read_bytes())

    def test_rejects_empty_or_date_mismatched_input(self):
        self.assertEqual(self.save("   ").status, "INVALID_INPUT")
        result = save_quick_memo(
            content="메모",
            memo_id="memo-2",
            date="2026-07-13",
            captured_at="2026-07-12T23:59:59+09:00",
        )
        self.assertEqual(result.status, "INVALID_INPUT")


if __name__ == "__main__":
    unittest.main()
