"""Server-only isolated journal/worker smoke test. Uses FakeBackend, never Docker.
Usage: prepare STATE_DIR | worker STATE_DIR | check STATE_DIR
The caller starts worker via systemd and deliberately disconnects its SSH client.
"""
import json
from pathlib import Path
import sys
import time
from test_release import r, FakeBackend, SHA, DIGEST, MIGRATION

mode, directory = sys.argv[1:]
root = Path(directory)
assert root.is_absolute() and root.name.startswith('acornary-release-smoke-')
class SlowBackend(FakeBackend):
    def prepare(self, image, job):
        time.sleep(5)
        return super().prepare(image, job)
config = {'state_dir': str(root), 'backup_dir': str(root / 'backups'), 'image_repository': 'ghcr.io/tang617/acornary'}
c = r.Controller(config, SlowBackend())
if mode == 'prepare':
    assert not (root / 'current.json').exists()
    r.save_json(root / 'current.json', {'version': None, 'commit': SHA, 'image': 'old', 'migrations': MIGRATION})
    r.save_json(root / 'schema.json', MIGRATION)
    job = c.enqueue('v1.0.0', SHA, DIGEST)
    r.save_json(root / 'test.json', {'id': job['id']})
    print(job['id'])
elif mode == 'worker':
    print(json.dumps(c.perform(r.read_json(root / 'test.json')['id'])))
elif mode == 'check':
    ident = r.read_json(root / 'test.json')['id']
    assert r.read_json(c.path(ident))['phase'] == 'succeeded'
    # Replay after reconnect returns the same completed record.
    assert c.enqueue('v1.0.0', SHA, DIGEST)['phase'] == 'succeeded'
    print('PASS: systemd worker completed after SSH disconnect; replay returned existing result.')
else:
    raise ValueError('Unknown fixture command')
