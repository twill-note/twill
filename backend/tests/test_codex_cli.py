import io
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException

from app.plugins.codex_assistant import codex_cli
from app.routers import ai


class CodexCliSelectionTests(unittest.TestCase):
    def test_platform_target_covers_windows_and_macos_architectures(self) -> None:
        self.assertEqual(
            codex_cli._platform_target("Windows", "AMD64"),
            "x86_64-pc-windows-msvc",
        )
        self.assertEqual(
            codex_cli._platform_target("Darwin", "arm64"),
            "aarch64-apple-darwin",
        )

    def test_newest_executable_wins_over_stale_path_order(self) -> None:
        old = Path("C:/npm/codex.exe")
        bundled = Path("C:/Twill/codex.exe")
        versions = {old: "0.92.0", bundled: "0.147.0"}

        with patch.object(codex_cli, "_read_version", side_effect=lambda path: versions.get(path)):
            selected = codex_cli.resolve_codex_installation(
                [(old, "path"), (bundled, "bundled")]
            )

        self.assertIsNotNone(selected)
        assert selected is not None
        self.assertEqual(selected.binary, str(bundled.resolve()))
        self.assertEqual(selected.version, "0.147.0")
        self.assertEqual(selected.source, "bundled")

    def test_managed_runtime_wins_a_same_version_tie(self) -> None:
        managed = Path("C:/Twill/user/codex.exe")
        bundled = Path("C:/Twill/app/codex.exe")

        with patch.object(codex_cli, "_read_version", return_value="0.147.0"):
            selected = codex_cli.resolve_codex_installation(
                [(bundled, "bundled"), (managed, "managed")]
            )

        self.assertIsNotNone(selected)
        assert selected is not None
        self.assertEqual(selected.source, "managed")

    def test_archive_cannot_escape_runtime_directory(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            archive_path = Path(temporary) / "unsafe.tar.gz"
            with tarfile.open(archive_path, "w:gz") as archive:
                member = tarfile.TarInfo("../escape.txt")
                payload = b"unsafe"
                member.size = len(payload)
                archive.addfile(member, io.BytesIO(payload))
            with tarfile.open(archive_path, "r:gz") as archive:
                with self.assertRaisesRegex(RuntimeError, "안전하지 않은 경로"):
                    codex_cli._safe_extract(archive, Path(temporary) / "runtime")


class CodexCliUpdateEndpointTests(unittest.IsolatedAsyncioTestCase):
    async def test_update_stops_app_server_and_requests_restart(self) -> None:
        installation = codex_cli.CodexInstallation(
            binary="C:/Twill/codex.exe",
            version="0.147.0",
            source="managed",
        )
        stop = AsyncMock()
        with (
            patch.object(ai.orchestrator, "has_active_runs", return_value=False),
            patch.object(ai.codex_app_server, "stop", stop),
            patch.object(ai, "managed_runtime_dir", return_value=Path("C:/Twill/runtime")),
            patch.object(ai, "download_latest_codex_runtime", return_value=installation),
        ):
            result = await ai.update_codex_cli()

        stop.assert_awaited_once()
        self.assertEqual(result["version"], "0.147.0")
        self.assertTrue(result["restart_required"])

    async def test_update_is_rejected_while_ai_is_running(self) -> None:
        with patch.object(ai.orchestrator, "has_active_runs", return_value=True):
            with self.assertRaises(HTTPException) as raised:
                await ai.update_codex_cli()

        self.assertEqual(raised.exception.status_code, 409)


if __name__ == "__main__":
    unittest.main()
