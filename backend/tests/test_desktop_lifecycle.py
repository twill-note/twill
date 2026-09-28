import asyncio
import os
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from fastapi import HTTPException
from app.desktop_lifecycle import shutdown
from app.plugins.codex_assistant.cli import codex_process_options


class DesktopShutdownTests(unittest.IsolatedAsyncioTestCase):
    async def test_shutdown_requires_the_desktop_token_and_managed_server(self):
        request = SimpleNamespace(headers={}, app=SimpleNamespace(state=SimpleNamespace()))
        with patch.dict(os.environ, {"TWILL_DESKTOP_SHUTDOWN_TOKEN": "test-secret"}):
            with self.assertRaises(HTTPException) as error:
                await shutdown(request)
            self.assertEqual(error.exception.status_code, 403)
            request.headers["authorization"] = "Bearer test-secret"
            with self.assertRaises(HTTPException) as error:
                await shutdown(request)
            self.assertEqual(error.exception.status_code, 409)
            called = asyncio.Event()
            request.app.state.request_shutdown = called.set
            self.assertEqual(await shutdown(request), {"ok": True})
            self.assertFalse(called.is_set())
            await asyncio.wait_for(called.wait(), timeout=1)

    async def test_shutdown_token_is_not_inherited_by_ai_commands(self):
        with patch.dict(os.environ, {"TWILL_DESKTOP_SHUTDOWN_TOKEN": "test-secret"}):
            self.assertNotIn("TWILL_DESKTOP_SHUTDOWN_TOKEN", codex_process_options()["env"])

    @unittest.skipUnless(os.name == "nt", "Windows job ownership needs Windows")
    async def test_windows_job_releases_descendants_after_backend_exit(self):
        import ctypes
        from ctypes import wintypes
        script = (
            "from app.desktop_lifecycle import own_windows_process_tree; "
            "import subprocess,sys,time,os; job=own_windows_process_tree(); "
            "p=subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)'], "
            "stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); "
            "print(p.pid,flush=True); time.sleep(.2); os._exit(0)"
        )
        proc = await asyncio.create_subprocess_exec(
            sys.executable, "-c", script, cwd=Path(__file__).resolve().parents[1],
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        out, err = await asyncio.wait_for(proc.communicate(), timeout=10)
        self.assertEqual(proc.returncode, 0, err.decode())
        child_pid = int(out.decode().strip())
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        for _ in range(50):
            handle = kernel.OpenProcess(0x1000, False, child_pid)
            if not handle:
                return
            code = wintypes.DWORD()
            kernel.GetExitCodeProcess(handle, ctypes.byref(code))
            kernel.CloseHandle(handle)
            if code.value != 259:  # STILL_ACTIVE
                return
            await asyncio.sleep(.1)
        self.fail(f"Windows job left child process {child_pid} running")
