import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from app.ai.orchestrator import (
    LEGACY_TASK_REPORT_HEADINGS,
    SYSTEM_AI_NAME,
    TASK_REPORT_HEADING,
    _assemble_developer_instructions,
    _system_identity_preamble,
    _task_report_location,
    _toolset_migration_context,
)


class SystemIdentityPromptTests(unittest.TestCase):
    def test_identity_is_named_but_general_responses_do_not_self_reference(self):
        prompt = _system_identity_preamble()

        self.assertIn("정확히 ‘Twill AI’라고 밝히세요", prompt)
        self.assertIn("일반 질문 답변, 작업 진행 안내, 완료·오류 보고에서는 이름을 주어로 반복하지 마세요", prompt)
        self.assertIn("첫 문장을 ‘Twill AI가 …’처럼 시작하지 마세요", prompt)
        self.assertIn("list_skillbook", prompt)
        self.assertIn("검색어 없이 전체 목록", prompt)
        self.assertIn("read_skillbook", prompt)
        self.assertNotIn("erd-designer.md", prompt)
        self.assertIn("필수 문서 저장 정책", prompt)
        self.assertIn("노트 산출물의 기본 저장소", prompt)
        self.assertIn("자율 수행과 사용자 결정 정책", prompt)
        self.assertIn("스스로 판단해 구현·검증까지 마무리", prompt)
        self.assertIn("결정 없이는 안전하고 올바르게 진행할 수 없을 때만 현재 대화에서 질문", prompt)
        self.assertIn("태스크 카드는 사용자가 명시적으로 등록을 요청한 경우에만", prompt)
        self.assertIn("일반 대화나 태스크 실행 결과에서 장기 메모리를 자동으로 추출하거나 저장하지 마세요", prompt)
        self.assertIn("`MEMORIES.md`를 도구로 직접 수정하지 말고", prompt)
        self.assertEqual(SYSTEM_AI_NAME, "Twill AI")

    def test_legacy_task_report_heading_is_still_recognized(self):
        for legacy_heading in LEGACY_TASK_REPORT_HEADINGS:
            body = f"작업 설명\n\n{legacy_heading}\n\n이전 보고"
            self.assertEqual(_task_report_location(body), (body.index(legacy_heading), legacy_heading))
        current_body = f"작업 설명\n\n{TASK_REPORT_HEADING}"
        self.assertEqual(_task_report_location(current_body), (current_body.index(TASK_REPORT_HEADING), TASK_REPORT_HEADING))

    def test_current_session_id_is_injected_for_explicit_task_registration(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "AGENTS.md").write_text("상시 주입되면 안 되는 규약", encoding="utf-8")
            (root / "MEMORIES.md").write_text("상시 주입되면 안 되는 메모리", encoding="utf-8")
            with patch("app.ai.orchestrator.config.notes_dir", return_value=root):
                prompt = _assemble_developer_instructions({}, [], session_id="session-from-chat")

        self.assertIn("byeori_session_id: session-from-chat", prompt)
        self.assertIn("`source_session: session-from-chat`", prompt)
        self.assertNotIn("상시 주입되면 안 되는 규약", prompt)
        self.assertNotIn("상시 주입되면 안 되는 메모리", prompt)

    def test_toolset_migration_context_is_bounded_and_keeps_recent_messages(self):
        session = {
            "messages": [
                {"role": "user", "content": "오래된 내용" * 2000},
                {"role": "assistant", "content": "최근 답변"},
                {"role": "user", "content": "현재 요청"},
            ]
        }

        context = _toolset_migration_context(session, max_chars=200)

        self.assertLessEqual(len(context), 280)
        self.assertIn("최근 답변", context)
        self.assertIn("현재 요청", context)


if __name__ == "__main__":
    unittest.main()
