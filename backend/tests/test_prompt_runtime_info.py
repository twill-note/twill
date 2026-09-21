import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from app.ai.engine import registry as engine_registry
from app.ai.orchestrator import ALWAYS_ALLOW_APPROVAL, prompt_runtime_info


class PromptRuntimeInfoTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        (self.root / "AGENTS.md").write_text("워크스페이스 규약 본문", encoding="utf-8")
        (self.root / "MEMORIES.md").write_text("전역 메모리 본문", encoding="utf-8")
        self.notes_dir = patch("app.ai.orchestrator.config.notes_dir", return_value=self.root)
        self.notes_dir.start()
        self.default_engine = patch.object(engine_registry, "default", return_value=None)
        self.default_engine.start()

    def tearDown(self):
        self.default_engine.stop()
        self.notes_dir.stop()
        self.temp_dir.cleanup()

    def test_returns_actual_common_prompt_sources_and_tool_policy(self):
        info = prompt_runtime_info()
        prompts = {item["id"]: item for item in info["prompts"]}

        self.assertNotIn("워크스페이스 규약 본문", info["common_instructions"])
        self.assertNotIn("전역 메모리 본문", info["common_instructions"])
        self.assertIn("시스템 AI 정체성", info["common_instructions"])
        self.assertFalse(prompts["workspace-instructions"]["included"])
        self.assertFalse(prompts["global-memories"]["included"])
        self.assertEqual(prompts["workspace-instructions"]["source"], "AGENTS.md")
        self.assertEqual(prompts["global-memories"]["stage"], "동적 도구 조회 원본")
        self.assertNotIn("plan", prompts)
        self.assertNotIn("followup-task", prompts)
        self.assertNotIn("memory-learn", prompts)
        self.assertIn("explicit-memory-extract", prompts)
        self.assertIn("명시적 기억 요청", prompts["explicit-memory-extract"]["title"])
        self.assertIn("자율 수행과 사용자 결정 정책", prompts["system-identity"]["content"])
        tools = next(item for item in info["tooling"]["items"] if item["title"] == "도구 목록")
        self.assertIn("search_memories", tools["value"])
        approval = next(item for item in info["tooling"]["items"] if item["title"] == "승인 정책")
        self.assertEqual(ALWAYS_ALLOW_APPROVAL, approval["value"])
        self.assertFalse(any(item["title"] == "도구 호출 한도" for item in info["tooling"]["items"]))


if __name__ == "__main__":
    unittest.main()
