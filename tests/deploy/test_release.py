import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('release', Path(__file__).resolve().parents[2] / 'deploy/release.py')
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)
SHA = 'a' * 40
DIGEST = 'sha256:' + 'b' * 64
MIGRATION = {'001_initial.sql': '1' * 64}

class FakeBackend:
    def __init__(self):
        self.rows = [{'name': '001_initial.sql', 'applied_at': '2026-01-01'}]
        self.target = dict(MIGRATION)
        self.calls = []
        self.fail = None
        self.image = 'old'
        self.started = True

    def prepare(self, image, job):
        self.calls.append('prepare')
        if self.fail == 'prepare': raise RuntimeError('pull failed')
        return {'version': job['version'], 'commit': job['commit'], 'migrations': self.target}

    def applied(self):
        if self.fail == 'unknown' and 'migrate' in self.calls: raise RuntimeError('unreachable')
        return list(self.rows)

    def stop(self): self.calls.append('stop'); self.started = False
    def set_image(self, image): self.calls.append('image'); self.image = image
    def backup(self, job):
        self.calls.append('backup')
        if self.fail == 'backup': raise RuntimeError('disk full')
        return '/private/' + job['id'] + '/database.dump'

    def migrate(self):
        self.calls.append('migrate')
        if self.fail == 'rollback': raise RuntimeError('transaction rolled back')
        self.rows = [{'name': n, 'applied_at': '2026-01-01'} for n in sorted(self.target)]
        if self.fail in ('committed', 'unknown'): raise RuntimeError('connection lost after commit')

    def start(self):
        self.calls.append('start')
        if self.fail in ('start', 'after_migrate') and self.image != 'old': raise RuntimeError('startup failed')
        if self.fail == 'recovery': raise RuntimeError('both images failed')
        self.started = True

    def check(self, release): self.calls.append('check')
    def remove_image(self, image): self.calls.append(('remove', image))

class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.backend = FakeBackend()
        self.config = {'state_dir': str(self.root), 'backup_dir': str(self.root / 'backups'), 'image_repository': 'ghcr.io/tang617/acornary'}
        self.controller = r.Controller(self.config, self.backend)
        r.save_json(self.root / 'current.json', {'version': None, 'commit': SHA, 'image': 'old', 'migrations': MIGRATION})
        r.save_json(self.root / 'schema.json', MIGRATION)

    def run_release(self, version='v0.1.0', digest=DIGEST):
        return self.controller.perform(self.controller.enqueue(version, SHA, digest)['id'])

    def migration(self): self.backend.target['002_added.sql'] = '2' * 64

    def test_no_migration_and_idempotent_replay(self):
        job = self.run_release()
        self.assertEqual(job['phase'], 'succeeded')
        self.assertNotIn('backup', self.backend.calls)
        before = list(self.backend.calls)
        self.assertEqual(self.run_release(), job)
        self.assertEqual(self.backend.calls, before)

    def test_migration_orders_backup_before_sql(self):
        self.migration()
        job = self.run_release()
        self.assertEqual(job['phase'], 'succeeded')
        self.assertLess(self.backend.calls.index('backup'), self.backend.calls.index('migrate'))
        self.assertEqual(r.read_json(self.root / 'schema.json'), self.backend.target)

    def test_backup_failure_never_runs_migration(self):
        self.migration(); self.backend.fail = 'backup'
        job = self.run_release()
        self.assertEqual(job['phase'], 'failed'); self.assertTrue(job['recovered'])
        self.assertNotIn('migrate', self.backend.calls); self.assertEqual(self.backend.image, 'old')

    def test_preflight_failure_does_not_stop_app(self):
        self.backend.fail = 'prepare'
        self.assertEqual(self.run_release()['phase'], 'failed')
        self.assertNotIn('stop', self.backend.calls)

    def test_applied_checksum_change_rejected_before_stop(self):
        self.backend.target['001_initial.sql'] = '3' * 64
        self.assertEqual(self.run_release()['phase'], 'failed')
        self.assertNotIn('stop', self.backend.calls)

    def test_transaction_rollback_restores_previous(self):
        self.migration(); self.backend.fail = 'rollback'
        job = self.run_release()
        self.assertEqual(job['phase'], 'failed'); self.assertTrue(job['recovered'])
        self.assertEqual(self.backend.image, 'old')

    def test_committed_or_uncertain_sql_never_rolls_back_app(self):
        for failure in ('committed', 'unknown', 'after_migrate'):
            with self.subTest(failure=failure):
                self.setUp(); self.migration(); self.backend.fail = failure
                job = self.run_release()
                self.assertEqual(job['phase'], 'needs_attention')
                self.assertNotEqual(self.backend.image, 'old'); self.assertFalse(self.backend.started)
                with self.assertRaises(RuntimeError): self.controller.enqueue('v0.2.0', SHA, DIGEST)

    def test_start_failure_without_migration_recovers(self):
        self.backend.fail = 'start'
        job = self.run_release()
        self.assertEqual(job['phase'], 'failed'); self.assertTrue(job['recovered'])
        self.assertEqual(self.backend.image, 'old'); self.assertTrue(self.backend.started)

    def test_journal_failure_restores_current_record_with_app(self):
        save = r.save_json
        failed = []
        def fail_once(path, value):
            if value.get('phase') == 'succeeded' and not failed:
                failed.append(True)
                raise OSError('simulated journal write failure')
            save(path, value)
        with patch.object(r, 'save_json', side_effect=fail_once):
            job = self.run_release()
        self.assertEqual(job['phase'], 'failed')
        self.assertTrue(job['recovered'])
        self.assertEqual(r.read_json(self.root / 'current.json')['image'], 'old')

    def test_failed_recovery_needs_attention(self):
        self.backend.fail = 'recovery'
        self.assertEqual(self.run_release()['phase'], 'needs_attention')

    def test_concurrency_downgrades_and_retags(self):
        first = self.controller.enqueue('v1.0.0', SHA, DIGEST)
        with self.assertRaises(RuntimeError): self.controller.enqueue('v1.0.1', SHA, DIGEST)
        self.controller.perform(first['id'])
        with self.assertRaises(RuntimeError): self.controller.enqueue('v0.9.9', SHA, DIGEST)
        with self.assertRaises(RuntimeError): self.controller.enqueue('v1.0.0', SHA, 'sha256:' + 'c' * 64)

    def test_interrupted_worker_cannot_be_implicitly_restarted(self):
        job = self.controller.enqueue('v0.1.0', SHA, DIGEST)
        self.controller.update(job, 'migrating')
        # A reconnect returns the existing job; it cannot execute SQL a second time.
        self.assertEqual(self.controller.enqueue('v0.1.0', SHA, DIGEST)['phase'], 'migrating')
        with self.assertRaises(RuntimeError): self.controller.perform(job['id'])
        self.assertEqual(self.backend.calls, [])

    def test_bad_command_values(self):
        for version in ('v1.0.0;id', 'v01.0.0', 'v1.0.0-rc.1', '../v1.0.0'):
            with self.assertRaises(RuntimeError): r.request(version, SHA, DIGEST)
        with self.assertRaises(RuntimeError): self.controller.path('../current')

    def test_retention_preserves_failed_backups(self):
        def backup(job):
            directory = self.root / 'backups' / job['id']
            directory.mkdir(parents=True)
            result = directory / 'database.dump'
            result.write_bytes(b'fixture')
            return str(result)
        self.backend.backup = backup
        self.migration(); self.backend.fail = 'rollback'
        failed = self.run_release('v1.0.0', 'sha256:' + '0' * 64)
        self.backend.fail = None
        successful = []
        for n in range(1, 6):
            self.backend.target['%03d_added.sql' % (n + 1)] = str(n) * 64
            successful.append(self.run_release('v1.0.%d' % n, 'sha256:' + str(n) * 64))
        self.assertTrue(Path(failed['backup']).exists())
        self.assertFalse(Path(successful[0]['backup']).exists())
        self.assertTrue(Path(successful[-3]['backup']).exists())
        removed = [c[1] for c in self.backend.calls if isinstance(c, tuple)]
        self.assertIn('ghcr.io/tang617/acornary@sha256:' + '1' * 64, removed)
        self.assertNotIn('ghcr.io/tang617/acornary@sha256:' + '5' * 64, removed)

if __name__ == '__main__': unittest.main()
