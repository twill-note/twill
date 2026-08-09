import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from app.memories import MemorySearchError, search_memories_tool


class MemorySearchToolTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        (self.root / ".workspace.json").write_text(
            json.dumps(
                {
                    "codex": {"memories_ref": "MEMORIES.md"},
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        (self.root / "MEMORIES.md").write_text(
            "# 학습된 사실들\n\n## 전역 규칙\n\n- 노트 원본은 Markdown이다.\n",
            encoding="utf-8",
        )
        self.notes_dir = patch("app.memories.config.notes_dir", return_value=self.root)
        self.notes_dir.start()

    def tearDown(self):
        self.notes_dir.stop()
        self.temp_dir.cleanup()

    def test_returns_relevant_bounded_sections_from_root_memories(self):
        payload = json.loads(
            search_memories_tool(
                {
                    "query": "Markdown",
                    "section_id": "section-note",
                    "scope_id": "scope-note",
                }
            )
        )

        self.assertEqual(len(payload["results"]), 1)
        self.assertIsNone(payload["results"][0]["section_id"])
        self.assertIn("Markdown", payload["results"][0]["content"])

    def test_can_limit_search_to_global_memory(self):
        payload = json.loads(search_memories_tool({"query": "Markdown", "source": "global"}))

        self.assertEqual(payload["results"][0]["source"], "global")
        self.assertEqual(payload["results"][0]["ref"], "MEMORIES.md")

    def test_requires_a_query(self):
        with self.assertRaises(MemorySearchError):
            search_memories_tool({})


if __name__ == "__main__":
    unittest.main()
