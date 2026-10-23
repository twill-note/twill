import tempfile
import unicodedata
import unittest
from pathlib import Path
from unittest.mock import patch

from app import config, db, indexer
from app.routers.notes import search_documents


class DocumentSearchTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        state = patch.dict(config._state, {"root": self.root})
        state.start()
        self.addCleanup(state.stop)
        self.addCleanup(self.close_db)
        for name, title, body in [
            ("UI API 설계 문서.md", "다른 표시 제목", ""),
            ("short.md", "v2 UI 설계", ""),
            ("body-only.md", "본문만 일치", "UI API 설계 문서"),
        ]:
            (self.root / name).write_text(f"---\ntitle: {title}\n---\n{body}", encoding="utf-8")
            indexer.index_file(name)

    def close_db(self):
        connection = getattr(db._local, "conn", None)
        if connection:
            connection.close()
            db._local.conn = None

    def test_filename_with_spaces_matches_independent_of_title_and_body(self):
        self.assertEqual(["UI API 설계 문서.md"], [item["path"] for item in search_documents("ui api")])
        self.assertEqual(["UI API 설계 문서.md"], [item["path"] for item in search_documents("설계   문서")])

    def test_short_words_partial_title_and_unicode_normalization(self):
        self.assertEqual(["short.md"], [item["path"] for item in search_documents("v2 UI 설")])
        self.assertEqual(2, len(search_documents(unicodedata.normalize("NFD", "UI 설계"))))

    def test_empty_and_unmatched_queries_are_valid_results(self):
        self.assertEqual(3, len(search_documents("")))
        self.assertEqual([], search_documents("존재하지 않는 제목"))
