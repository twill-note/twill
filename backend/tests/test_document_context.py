import asyncio
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from app.ai import sessions
from app.ai.engine import registry as engine_registry
from app.ai.orchestrator import Orchestrator, RunRequest, _requests_current_document


class CapturingEngine:
    id = "document-context-test"
    display_name = "Document Context Test"

    def __init__(self):
        self.inputs = []

    async def start_thread(self, *, cwd, config=None):
        return "thread-1"

    async def resume_thread(self, *, thread_id, cwd, config=None):
        return thread_id

    async def run_turn(self, *, thread_id, input_text, config=None):
        self.inputs.append(input_text)
        yield {"type": "message_end", "text": "ok"}

    async def interrupt(self, *, thread_id, turn_id=None):
        return None

    async def steer(self, *, thread_id, turn_id, guidance):
        return None


class DocumentContextTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        (self.root / "doc.md").write_text("첫 문서 본문", encoding="utf-8")
        (self.root / "other.md").write_text("다른 문서 본문", encoding="utf-8")
        (self.root / "mention.md").write_text("명시적 멘션 본문", encoding="utf-8")
        self.notes_dir = patch("app.ai.orchestrator.config.notes_dir", return_value=self.root)
        self.notes_dir.start()
        self.engine = CapturingEngine()
        self.default_engine = patch.object(engine_registry, "default", return_value=self.engine)
        self.default_engine.start()
        self.session = sessions.create_session(kind="chat", title="문서 컨텍스트 테스트")
        self.orchestrator = Orchestrator()

    def tearDown(self):
        self.default_engine.stop()
        self.notes_dir.stop()
        self.temp_dir.cleanup()

    def run_turn(self, prompt, path="doc.md", mentions=None, context=None, include_document=False):
        async def collect():
            return [
                event
                async for event in self.orchestrator.run(
                    RunRequest(
                        session_id=self.session["id"],
                        prompt=prompt,
                        current_path=path,
                        mention_paths=mentions or [],
                        context_text=context,
                        include_document=include_document,
                        enable_learn=False,
                    )
                )
            ]

        events = asyncio.run(collect())
        return next(event for event in events if event.get("type") == "context_ready")

    def test_current_document_is_attached_only_for_explicit_requests(self):
        generic = self.run_turn("이 오류를 해결해줘")
        explicit_korean = self.run_turn("현재 보고 있는 문서를 검토해줘")
        explicit_english = self.run_turn("Please review the current note.")

        self.assertEqual(generic["document_context"], {"path": None, "attached": False, "reason": "not_requested"})
        self.assertEqual(explicit_korean["document_context"], {"path": "doc.md", "attached": True, "reason": "explicit_request"})
        self.assertEqual(explicit_english["document_context"], {"path": "doc.md", "attached": True, "reason": "explicit_request"})
        self.assertIsNone(generic["current_note_path"])
        self.assertIsNone(explicit_korean["current_note_path"])

        self.assertNotIn("첫 문서 본문", self.engine.inputs[0])
        self.assertNotIn("doc.md", self.engine.inputs[0])
        self.assertEqual(self.engine.inputs[1].count("첫 문서 본문"), 1)
        self.assertEqual(self.engine.inputs[2].count("첫 문서 본문"), 1)

    def test_current_document_reference_rules_cover_representative_phrases_without_false_positives(self):
        for prompt in (
            "현재 보고 있는 문서에서 오류를 고쳐줘",
            "이 문서를 기준으로 요약해줘",
            "현재 노트를 검토해줘",
            "Summarize this document.",
            "Please review the current note.",
            "Find the issue in the current document.",
        ):
            with self.subTest(prompt=prompt):
                self.assertTrue(_requests_current_document(prompt))

        for prompt in (
            "이 오류를 해결해줘",
            "현재 문서는 제목만 바꿔 두었어.",
            "The current document is named planning.md.",
            "What does current mean in this API?",
        ):
            with self.subTest(prompt=prompt):
                self.assertFalse(_requests_current_document(prompt))

    def test_selected_text_and_explicit_mentions_remain_separate_contexts(self):
        selected = self.run_turn("이 부분을 설명해줘", context="선택된 문장")
        mention = self.run_turn("@mention.md도 확인", mentions=["mention.md"])

        self.assertFalse(selected["document_context"]["attached"])
        self.assertFalse(mention["document_context"]["attached"])
        self.assertIn("[사용자가 선택한 텍스트]", self.engine.inputs[0])
        self.assertIn("선택된 문장", self.engine.inputs[0])
        self.assertIn("명시적 멘션 본문", self.engine.inputs[1])
        self.assertNotIn("첫 문서 본문", self.engine.inputs[1])

    def test_selection_action_attaches_only_the_explicitly_targeted_document(self):
        selected = self.run_turn(
            "선택한 내용을 검토하고 설명해줘.",
            context="선택한 문장",
            include_document=True,
        )
        later_generic = self.run_turn("이 오류를 해결해줘")

        self.assertEqual(
            selected["document_context"],
            {"path": "doc.md", "attached": True, "reason": "selection_action"},
        )
        self.assertEqual(later_generic["document_context"], {"path": None, "attached": False, "reason": "not_requested"})
        self.assertIn("[사용자가 선택한 텍스트]", self.engine.inputs[0])
        self.assertIn("선택한 문장", self.engine.inputs[0])
        self.assertEqual(self.engine.inputs[0].count("첫 문서 본문"), 1)
        self.assertNotIn("첫 문서 본문", self.engine.inputs[1])

    def test_explicit_request_does_not_attach_an_unavailable_or_external_path(self):
        unavailable = self.run_turn("현재 보고 있는 문서를 검토해줘", path="missing.md")
        external = self.run_turn("현재 보고 있는 문서를 검토해줘", path=str(self.root.parent / "outside.md"))

        self.assertEqual(unavailable["document_context"], {"path": None, "attached": False, "reason": "unavailable"})
        self.assertEqual(external["document_context"], {"path": None, "attached": False, "reason": "unavailable"})
        self.assertNotIn("[현재 열람 중인 문서]", self.engine.inputs[0])
        self.assertNotIn("[현재 열람 중인 문서]", self.engine.inputs[1])

    def test_legacy_document_context_is_cleared_and_never_reused(self):
        sessions.update_session(
            self.session["id"],
            document_context={"path": "doc.md", "fingerprint": "old"},
            context_path="doc.md",
            section_id="old-document-section",
            scope_id="old-document-scope",
        )
        context = self.run_turn("이 오류를 해결해줘")

        stored = sessions.get_session(self.session["id"])
        self.assertNotIn("document_context", stored)
        self.assertNotIn("context_path", stored)
        self.assertIsNone(context["section_id"])
        self.assertIsNone(context["scope"])
        self.assertIsNone(stored.get("section_id"))
        self.assertIsNone(stored.get("scope_id"))

        user_messages = [message["content"] for message in stored["messages"] if message["role"] == "user"]
        self.assertTrue(all("(문서:" not in message for message in user_messages))
        self.assertTrue(all("[참조 노트 본문 첨부]" not in message for message in user_messages))
        self.assertTrue(all("[현재 열람 중인 문서]" not in message for message in user_messages))


if __name__ == "__main__":
    unittest.main()
