import asyncio
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException

from app.ai import git_metadata_access
from app.routers import ai as ai_router


class GitMetadataAccessRuleTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.codex_home = Path(self.temp_dir.name) / "codex-home"

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_rule_is_disabled_until_user_enables_it_then_is_removed(self):
        self.assertEqual(
            git_metadata_access.status(self.codex_home),
            {"enabled": False, "managed": True},
        )

        enabled = git_metadata_access.set_enabled(True, self.codex_home)
        path = git_metadata_access.rules_path(self.codex_home)

        self.assertEqual(enabled, {"enabled": True, "managed": True})
        self.assertTrue(path.is_file())
        content = path.read_text(encoding="utf-8")
        self.assertIn(git_metadata_access.MANAGED_RULE_MARKER, content)
        self.assertIn('"git push origin main"', content)
        self.assertIn('"git reset --hard HEAD"', content)

        disabled = git_metadata_access.set_enabled(False, self.codex_home)

        self.assertEqual(disabled, {"enabled": False, "managed": True})
        self.assertFalse(path.exists())

    def test_unmanaged_same_name_rule_is_never_replaced_or_deleted(self):
        path = git_metadata_access.rules_path(self.codex_home)
        path.parent.mkdir(parents=True)
        original = 'prefix_rule(pattern = ["git", "commit"], decision = "allow")\n'
        path.write_text(original, encoding="utf-8")

        with self.assertRaises(git_metadata_access.GitMetadataAccessConflictError):
            git_metadata_access.set_enabled(True, self.codex_home)
        with self.assertRaises(git_metadata_access.GitMetadataAccessConflictError):
            git_metadata_access.set_enabled(False, self.codex_home)

        self.assertEqual(path.read_text(encoding="utf-8"), original)

    def test_legacy_byeori_rules_are_migrated_to_managed_rule(self):
        path = git_metadata_access.rules_path(self.codex_home)
        path.parent.mkdir(parents=True)

        for marker in git_metadata_access._LEGACY_MANAGED_RULE_MARKERS:
            with self.subTest(marker=marker):
                path.write_text(f"{marker}\nprefix_rule(...)\n", encoding="utf-8")

                git_metadata_access.set_enabled(True, self.codex_home)

                content = path.read_text(encoding="utf-8")
                self.assertIn(git_metadata_access.MANAGED_RULE_MARKER, content)
                self.assertNotIn("prefix_rule(...)", content)


class GitMetadataAccessEndpointTests(unittest.TestCase):
    def test_enable_restarts_idle_app_server(self):
        stop = AsyncMock()
        with (
            patch.object(ai_router.orchestrator, "has_active_runs", return_value=False),
            patch.object(
                ai_router.git_metadata_access,
                "set_enabled",
                return_value={"enabled": True, "managed": True},
            ),
            patch.object(ai_router.codex_app_server, "stop", new=stop),
        ):
            result = asyncio.run(
                ai_router.put_git_metadata_access(ai_router.GitMetadataAccessRequest(enabled=True))
            )

        self.assertEqual(result, {"enabled": True, "managed": True, "server_restarted": True})
        stop.assert_awaited_once()

    def test_change_is_rejected_while_byeori_is_running(self):
        with patch.object(ai_router.orchestrator, "has_active_runs", return_value=True):
            with self.assertRaises(HTTPException) as raised:
                asyncio.run(ai_router.put_git_metadata_access(ai_router.GitMetadataAccessRequest(enabled=False)))

        self.assertEqual(raised.exception.status_code, 409)


if __name__ == "__main__":
    unittest.main()
