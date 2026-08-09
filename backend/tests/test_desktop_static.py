import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from app.main import frontend_dist_dir, lifespan, mount_frontend


class DesktopStaticTests(unittest.TestCase):
    def test_frontend_dist_env_override_is_resolved(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            with patch.dict(os.environ, {"NOTE_APP_FRONTEND_DIST": temp_dir}):
                self.assertEqual(frontend_dist_dir(), Path(temp_dir).resolve())

    def test_mounts_built_frontend_only_when_index_exists(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            application = FastAPI()
            with patch.dict(os.environ, {"NOTE_APP_FRONTEND_DIST": temp_dir}):
                self.assertFalse(mount_frontend(application))
                (root / "index.html").write_text("<!doctype html><title>Note</title>", encoding="utf-8")
                self.assertTrue(mount_frontend(application))

            mounted = application.routes[-1]
            self.assertIsInstance(mounted.app, StaticFiles)


class DesktopLifecycleTests(unittest.IsolatedAsyncioTestCase):
    async def test_backend_shutdown_stops_codex_child_process(self):
        stop = AsyncMock()
        watch_loop = AsyncMock()
        with (
            patch("app.main.config.ensure_dirs"),
            patch("app.main.ai_sessions.reconcile_stale_active_runs"),
            patch("app.main.indexer.full_scan"),
            patch("app.main.engine_registry.register"),
            patch("app.main.plugin_registry.bind"),
            patch("app.main.plugin_registry.discover"),
            patch("app.main.plugin_registry.apply_state"),
            patch("app.main.watcher.watch_loop", watch_loop),
            patch("app.main.codex_app_server.stop", stop),
        ):
            async with lifespan(FastAPI()):
                pass

        stop.assert_awaited_once_with()


if __name__ == "__main__":
    unittest.main()
