"""Actual managed Node processes verify namespace identity and archive rollover."""
import asyncio
import json
from pathlib import Path
import shutil
import tempfile
import unittest

from orchvia import Orchestrator, OrchestrationError
from orchvia.types import to_wire
from orchvia.identity import request_digest

ROOT = Path(__file__).resolve().parents[2]
CLI = ROOT / 'packages/cli/src/main.ts'

class StoreNamespaceTests(unittest.IsolatedAsyncioTestCase):
    async def test_original_receipts_survive_rollover_and_cross_host_retry(self):
        with tempfile.TemporaryDirectory(prefix='orch-py-stores-', dir=str(Path('/tmp').resolve())) as temp:
            root = Path(temp).resolve()
            for name in ['work', 'state', 'second', 'control', 'stores', 'archives']:
                (root / name).mkdir(mode=0o700)
            config = {'workspace': str(root / 'work'), 'stateDir': str(root / 'state'),
                      'providers': {'fake': {'model': 'test'}},
                      'storage': {'emergencyBytes': 4096, 'minFreeBytes': 0},
                      'stores': {'controlDir': str(root / 'control'), 'storesRoot': str(root / 'stores'), 'archiveRoot': str(root / 'archives')}}
            first_path = root / 'first.json'; first_path.write_text(json.dumps(config))
            other_config = {**config, 'stateDir': str(root / 'second')}; other_config.pop('stores')
            second_path = root / 'second.json'; second_path.write_text(json.dumps(other_config))
            def client(path):
                return Orchestrator.local(engine_command=[shutil.which('node'), str(CLI), 'host', '--stdio', '--config', str(path)])
            async with client(first_path) as first, client(second_path) as second:
                spec = {'goal': 'Unicode 回执', 'runtime': {'provider': 'fake', 'model': 'test'}, 'acceptance': {'mode': 'human', 'criteria': ['review']}}
                receipt = await first.tasks.create(spec, idempotency_key='K')
                identity = to_wire(receipt.retry_identity)
                self.assertEqual(identity['requestDigest'], request_digest('tasks.create', {'spec': spec}))
                with self.assertRaises(OrchestrationError) as rejected:
                    await second.retry(identity, {'spec': spec})
                self.assertEqual(rejected.exception.code, 'STORE_NAMESPACE_MISMATCH')
                self.assertEqual(rejected.exception.retry_identity, identity)
                self.assertEqual((await first.retry(identity, {'spec': spec})).id, receipt.id)
                await receipt.cancel(idempotency_key='cancel')
                # The cancelled turn ends once its files are written (SPEC-0057); wait for its lease.
                async with asyncio.timeout(5):
                    while (await first.scheduler.get()).execution_occupied:
                        await asyncio.sleep(0.005)
                original_store = first.info.store_id
                switched = await first.stores.rollover(idempotency_key='roll')
                self.assertNotEqual(first.info.store_id, original_store)
                self.assertEqual((await first.stores.rollover(idempotency_key='roll')).rollover_id, switched.rollover_id)
                with self.assertRaises(OrchestrationError) as old:
                    await first.retry(identity, {'spec': spec})
                self.assertEqual(old.exception.code, 'STORE_NAMESPACE_MISMATCH')
                archived = await first.archives.lookup(store_id=original_store, method='tasks.create', scope='local', idempotency_key='K', request_digest=identity['requestDigest'])
                self.assertEqual(archived.target_id, receipt.id)
                snapshot = await first.state.snapshot(limit=1)
                self.assertEqual(snapshot["items"], [])
