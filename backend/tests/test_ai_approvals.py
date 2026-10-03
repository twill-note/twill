import asyncio
import json
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock
from app.plugins.codex_assistant.app_server import AppServerClient
from app.ai.orchestrator import RunRequest
from app.routers.workspace import CodexDefaults

class ApprovalTests(unittest.IsolatedAsyncioTestCase):
    def client(self):
        client = AppServerClient()
        payloads = []
        client._proc = SimpleNamespace(stdin=SimpleNamespace(
            write=lambda data: payloads.append(json.loads(data)), drain=AsyncMock()))
        return client, payloads

    async def test_requires_explicit_answer_and_scopes_to_thread(self):
        client, payloads = self.client()
        client.set_approval_policy('thread', 'on-request')
        task = asyncio.create_task(client._respond_to_server_request(1, 'item/commandExecution/requestApproval', {'threadId': 'thread', 'command': 'git status'}))
        await asyncio.sleep(0)
        self.assertFalse(task.done())
        self.assertEqual([], payloads)
        request = client.pending_approvals()[0]
        self.assertEqual('thread', request['thread_id'])
        self.assertTrue(client.resolve_approval(request['id'], 'accept'))
        self.assertFalse(client.resolve_approval(request['id'], 'accept'))
        await task
        self.assertEqual({'decision': 'accept'}, payloads[0]['result'])
        self.assertEqual([], client.pending_approvals())

    async def test_cancel_clears_only_that_thread(self):
        client, payloads = self.client()
        client.set_approval_policy('thread', 'on-request')
        task = asyncio.create_task(client._respond_to_server_request(2, 'item/fileChange/requestApproval', {'threadId': 'thread'}))
        await asyncio.sleep(0)
        client.clear_approvals('different')
        self.assertFalse(task.done())
        client.clear_approvals('thread')
        await task
        self.assertEqual({'decision': 'cancel'}, payloads[0]['result'])

    async def test_never_does_not_auto_escalate(self):
        client, payloads = self.client()
        client.set_approval_policy('thread', 'never')
        await client._respond_to_server_request(3, 'item/commandExecution/requestApproval', {'threadId': 'thread'})
        self.assertEqual({'decision': 'decline'}, payloads[0]['result'])
        self.assertEqual([], client.pending_approvals())

    def test_task_mode_and_chat_default_are_resolved_consistently(self):
        from app.ai.orchestrator import resolve_approval_mode
        self.assertEqual('never', resolve_approval_mode(None, None, 'on-request', is_task=True))
        self.assertEqual('on-request', resolve_approval_mode(None, 'on-request', 'never', is_task=True))
        self.assertEqual('on-request', resolve_approval_mode(None, None, 'on-request', is_task=False))
        self.assertEqual('never', resolve_approval_mode('never', 'on-request', 'on-request', is_task=True))
        self.assertEqual('never', resolve_approval_mode(None, 'legacy', None, is_task=True))

    def test_default_and_invalid_mode(self):
        self.assertEqual('never', CodexDefaults().default_approval)
        with self.assertRaises(ValueError):
            RunRequest(approval='danger-full-access')
