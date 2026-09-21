import asyncio
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException
from app.plugins.codex_assistant import updates, cli
from app.plugins.codex_assistant.app_server import AppServerClient, AppServerError
from app.plugins.codex_assistant.codex_engine import CodexEngine
from app.routers import ai


class MaintenanceTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.client = AppServerClient()
        self.client.stop = AsyncMock()
        self.patches = [patch.object(ai, 'codex_app_server', self.client),
                        patch.object(ai.orchestrator, 'has_active_runs', return_value=False)]
        for item in self.patches:
            item.start()
        self.addCleanup(lambda: [item.stop() for item in reversed(self.patches)])

    async def test_logout_stops_old_server_and_clears_gate(self):
        with patch.object(ai, 'codex_command', return_value=['codex', 'logout']), patch.object(updates, 'run_command', new=AsyncMock()) as run:
            await ai.logout()
        self.client.stop.assert_awaited_once()
        run.assert_awaited_once_with(['codex', 'logout'])
        self.assertIsNone(self.client.maintenance_reason)

    async def test_active_run_rejects_logout_update_and_restart(self):
        with patch.object(ai.orchestrator, 'has_active_runs', return_value=True):
            for action in [ai.logout, ai.update_codex, ai.restart_engine]:
                with self.assertRaises(HTTPException) as error:
                    await action()
                self.assertEqual(error.exception.status_code, 409)
        self.client.stop.assert_not_awaited()

    async def test_failed_update_releases_gate(self):
        with patch.object(updates, 'install_update', new=AsyncMock(side_effect=RuntimeError('network down'))):
            with self.assertRaises(HTTPException):
                await ai.update_codex()
        self.assertIsNone(self.client.maintenance_reason)

    async def test_duplicate_maintenance_and_rpc_blocked(self):
        async with ai.engine_maintenance('updating'):
            with self.assertRaises(AppServerError):
                await self.client.ensure_started()
            with self.assertRaises(HTTPException):
                await ai.restart_engine()

    async def test_login_holds_gate_until_completion(self):
        ws = SimpleNamespace(accept=AsyncMock(), close=AsyncMock(), send_json=AsyncMock())
        async def login(_ws):
            self.assertEqual(self.client.maintenance_reason, 'AI 엔진 로그인 중입니다.')
        with patch.object(ai, '_login', side_effect=login):
            await ai.login_ws(ws)
        self.client.stop.assert_awaited_once()
        self.assertIsNone(self.client.maintenance_reason)

    async def test_login_success_is_sent_after_auth_gate_is_released(self):
        messages = []
        async def send(message):
            messages.append(message)
            if message['type'] == 'success':
                self.assertIsNone(self.client.maintenance_reason)
        async def receive():
            await asyncio.Future()
        ws = SimpleNamespace(accept=AsyncMock(), close=AsyncMock(), send_json=send, receive_text=receive)
        proc = SimpleNamespace(stdout=SimpleNamespace(readline=AsyncMock(return_value=b'')),
                               wait=AsyncMock(return_value=0), returncode=0)
        with patch.object(ai, 'codex_command', return_value=['codex', 'login']), patch.object(ai.asyncio, 'create_subprocess_exec', AsyncMock(return_value=proc)):
            await ai.login_ws(ws)
        self.assertEqual(messages, [{'type': 'success', 'restart_recommended': True}])

    async def test_models_read_all_pages_and_surface_errors(self):
        rpc = AsyncMock(side_effect=[{'data': [{'id': 'old'}], 'nextCursor': 'page2'}, {'data': [{'id': 'new'}]}])
        with patch('app.plugins.codex_assistant.codex_engine.app_server.request', rpc):
            models = await CodexEngine().list_models()
        self.assertEqual([m['id'] for m in models], ['old', 'new'])
        self.assertEqual(rpc.await_args_list[1].args[1]['cursor'], 'page2')
        with patch('app.plugins.codex_assistant.codex_engine.app_server.request', AsyncMock(side_effect=AppServerError('offline'))):
            with self.assertRaises(AppServerError):
                await CodexEngine().list_models()


class UpdateTests(unittest.IsolatedAsyncioTestCase):
    async def test_version_comparison_and_cached_checks(self):
        self.assertGreater(updates.version_key('0.154.0'), updates.version_key('0.99.0'))
        self.assertGreater(updates.version_key('0.154.0'), updates.version_key('0.154.0-beta.1'))
        with patch.object(updates, '_cache', None), patch.object(updates.shutil, 'which', return_value='/bin/codex'), patch.object(updates, 'installed_version', AsyncMock(return_value='0.99.0')), patch.object(updates, 'latest_release', return_value='0.154.0') as latest:
            results = await asyncio.gather(updates.check_update(), updates.check_update())
            self.assertTrue(all(r['update_available'] for r in results))
            latest.assert_called_once()

    async def test_no_downgrade_and_wrong_installation_rejected(self):
        with patch.object(updates, 'check_update', AsyncMock(return_value={'installed': True, 'update_available': False})), patch.object(updates, 'run_command', AsyncMock()) as run:
            await updates.install_update()
            run.assert_not_awaited()
        with patch.object(updates, 'check_update', AsyncMock(return_value={'installed': True, 'update_available': True, 'latest_version': '0.154.0'})), patch.object(updates.shutil, 'which', return_value='/bin/codex'), patch.object(updates, 'run_command', AsyncMock()), patch.object(updates, 'installed_version', AsyncMock(return_value='0.99.0')):
            with self.assertRaisesRegex(RuntimeError, '이전 Codex'):
                await updates.install_update()

    def test_homebrew_npm_and_standalone(self):
        with patch.object(updates.shutil, 'which', side_effect=lambda name: '/tools/' + name):
            self.assertEqual(updates.update_command('/opt/homebrew/Caskroom/codex/1/codex'), ['/tools/brew', 'upgrade', '--cask', 'codex'])
            self.assertEqual(updates.update_command('/opt/lib/node_modules/@openai/codex/bin/codex.js'), ['/tools/npm', 'install', '--global', '@openai/codex@latest'])
            self.assertEqual(updates.update_command('/Users/test/.local/bin/codex'), ['/Users/test/.local/bin/codex', 'update'])

    async def test_windows_npm_paths_with_spaces_use_node_and_separate_args(self):
        with TemporaryDirectory(prefix='Twill Windows ') as folder:
            root = Path(folder)
            js = root / 'node_modules/npm/bin/npm-cli.js'
            js.parent.mkdir(parents=True)
            js.touch()
            (root / 'node.exe').touch()
            proc = SimpleNamespace(communicate=AsyncMock(return_value=(b'ok', None)), returncode=0)
            with patch.object(updates, 'os', SimpleNamespace(name='nt')), patch.object(updates.asyncio, 'create_subprocess_exec', AsyncMock(return_value=proc)) as spawn:
                await updates.run_command([str(root / 'npm.cmd'), 'install', '--global', '@openai/codex@latest'])
            self.assertEqual(spawn.await_args.args[:3], (str(root / 'node.exe'), str(js), 'install'))
            self.assertEqual(spawn.await_args.kwargs['creationflags'], 0x08000000)

    async def test_windows_logout_stops_node_and_codex_children(self):
        proc = SimpleNamespace(pid=42, returncode=None, wait=AsyncMock(return_value=0))
        killer = SimpleNamespace(wait=AsyncMock(return_value=0), returncode=0)
        with patch.object(cli, 'os', SimpleNamespace(name='nt')), patch('asyncio.create_subprocess_exec', AsyncMock(return_value=killer)) as spawn:
            await cli.stop_codex_process(proc)
        self.assertEqual(spawn.await_args.args, ('taskkill.exe', '/PID', '42', '/T', '/F'))
        proc.wait.assert_awaited_once()

    def test_windows_codex_login_and_server_use_node(self):
        with TemporaryDirectory(prefix='Twill Windows ') as folder:
            root = Path(folder)
            js = root / 'node_modules/@openai/codex/bin/codex.js'
            js.parent.mkdir(parents=True)
            js.touch()
            (root / 'node.exe').touch()
            with patch.object(cli, 'os', SimpleNamespace(name='nt')), patch.object(cli.shutil, 'which', return_value=str(root / 'codex.cmd')):
                self.assertEqual(cli.codex_command('login'), [str(root / 'node.exe'), str(js), 'login'])
                self.assertEqual(cli.codex_command('app-server')[-1], 'app-server')
