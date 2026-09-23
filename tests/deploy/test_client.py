"""Exercise lost SSH responses without a network or production credential."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

class ClientTests(unittest.TestCase):
    def test_lost_submission_response_retries_same_identity_then_polls(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            script = root / 'ssh'
            script.write_text('''#!/usr/bin/env python3
import json,os,sys
from pathlib import Path
assert sys.argv[sys.argv.index('-F')+1]=='/dev/null'
assert 'IdentityAgent=none' in sys.argv and 'StrictHostKeyChecking=yes' in sys.argv
p=Path(os.environ['FAKE_REQUESTS'])
requests=json.loads(p.read_text()) if p.exists() else []
requests.append(sys.argv[-1]);p.write_text(json.dumps(requests))
# The server accepted the first request, but its SSH response was lost.
if len(requests)==1: sys.exit(255)
print(json.dumps({'id':'a'*24,'phase':'starting' if len(requests)==2 else 'succeeded'}))
''')
            script.chmod(0o700)
            env = dict(os.environ, PATH=str(root) + os.pathsep + os.environ['PATH'],
                       FAKE_REQUESTS=str(root / 'requests.json'), GITHUB_STEP_SUMMARY=str(root / 'summary'),
                       DEPLOY_HOST='example.test', DEPLOY_USER='acornary-deploy',
                       DEPLOY_KEY_FILE=str(root / 'unused-key'), DEPLOY_HOST_KEYS_FILE=str(root / 'unused-hosts'),
                       VERSION='v1.2.3', COMMIT='a'*40, DIGEST='sha256:'+'b'*64)
            subprocess.run(['node', str(Path(__file__).resolve().parents[2] / 'scripts/deploy-client.mjs')], env=env,
                           check=True, timeout=25, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            requests = json.loads((root / 'requests.json').read_text())
            self.assertEqual(requests[0], requests[1])
            self.assertTrue(requests[0].startswith('start v1.2.3 '))
            self.assertEqual(requests[2], 'status ' + 'a'*24)
