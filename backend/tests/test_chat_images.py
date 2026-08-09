import base64
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from app.ai import sessions
from app.ai.orchestrator import _persist_generated_image


PNG_BYTES = b"\x89PNG\r\n\x1a\n" + b"test-image-payload"


class ChatImageTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.assets = self.root / "assets"
        self.assets_patch = patch("app.ai.orchestrator.config.assets_dir", return_value=self.assets)
        self.notes_patch = patch("app.ai.sessions.config.notes_dir", return_value=self.root)
        self.assets_patch.start()
        self.notes_patch.start()

    def tearDown(self):
        self.notes_patch.stop()
        self.assets_patch.stop()
        self.temp_dir.cleanup()

    def test_generated_data_url_is_written_to_assets(self):
        encoded = base64.b64encode(PNG_BYTES).decode("ascii")

        image = _persist_generated_image(
            {"status": "completed", "result": f"data:image/png;base64,{encoded}"}
        )

        self.assertIsNotNone(image)
        self.assertTrue(image["url"].startswith("/assets/generated-"))
        self.assertNotIn("base64", image["url"])
        saved = self.assets / Path(image["url"]).name
        self.assertEqual(PNG_BYTES, saved.read_bytes())

    def test_saved_path_is_copied_and_session_keeps_only_metadata(self):
        source = self.root / "codex-output.png"
        source.write_bytes(PNG_BYTES)
        image = _persist_generated_image(
            {"status": "completed", "savedPath": str(source), "result": "unused"}
        )

        session = sessions.create_session(kind="chat", title="이미지 답변")
        sessions.append_message(session["id"], "assistant", "", images=[image])
        saved = sessions.get_session(session["id"])

        self.assertEqual("", saved["messages"][0]["content"])
        self.assertEqual(image, saved["messages"][0]["images"][0])
        self.assertLess(len(saved["messages"][0]["images"][0]["url"]), 100)

    def test_failed_generation_is_not_persisted(self):
        encoded = base64.b64encode(PNG_BYTES).decode("ascii")
        image = _persist_generated_image({"status": "failed", "result": encoded})
        self.assertIsNone(image)


if __name__ == "__main__":
    unittest.main()
