#!/usr/bin/env python3
"""Run once as root after copying this deploy directory to a trusted server path.
No database writes, app restart, or production version tag are performed.
"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

assert os.geteuid() == 0
os.umask(0o077)
source = Path(__file__).resolve().parent
config_path = Path('/etc/acornary/release.json')
assert not config_path.exists(), 'Already bootstrapped; inspect current configuration before changing it'
root = Path('/var/lib/acornary/releases')
root.mkdir(mode=0o700, parents=True, exist_ok=True)
state = json.loads(subprocess.check_output(['docker', 'inspect', 'acornary-production-app-1']).decode())[0]
image_id = state['Image']
assert state['State']['Running'], 'Current production app must be running'
existing = Path('/opt/acornary/current/manifest.json')
manifest = json.loads(existing.read_text())
assert manifest['image_id'] == image_id, 'Bootstrap image differs from recorded deployment'
hashes = {}
for name, digest in manifest['files'].items():
    if name.startswith('migrations/') and name.endswith('.sql'):
        # Read the actual running image, not a possibly edited server checkout.
        content = subprocess.check_output(['docker', 'exec', 'acornary-production-app-1', 'cat', '/app/' + name])
        assert hashlib.sha256(content).hexdigest() == digest
        hashes[Path(name).name] = digest
assert hashes
baseline = {'id': 'bootstrap', 'version': None, 'commit': manifest['git_head'], 'image': image_id, 'migrations': hashes}
def save(path, value):
    with path.open('x') as output:
        os.chmod(str(path), 0o600)
        json.dump(value, output, indent=2)
save(root / 'current.json', baseline)
save(root / 'schema.json', hashes)
shutil.copy2(str(source.parent / 'compose.cloud.yaml'), '/etc/acornary/compose.cloud.yaml')
os.chmod('/etc/acornary/compose.cloud.yaml', 0o600)
for filename, target in [('release.py', 'acornary-release'), ('release-ssh.py', 'acornary-release-ssh'), ('acornary.sh', 'acornary')]:
    shutil.copyfile(str(source / filename), '/usr/local/sbin/' + target)
    os.chmod('/usr/local/sbin/' + target, 0o755)
save(config_path, {
    'state_dir': str(root), 'backup_dir': '/var/lib/acornary/backups/releases',
    'image_repository': 'ghcr.io/tang617/acornary',
    'compose_file': '/etc/acornary/compose.cloud.yaml',
    'env_file': '/etc/acornary/production/deploy.env',
    'database_container': 'acornary-production-postgres-1',
    'origin': 'https://acornary.protium.top',
})
subprocess.check_call(['useradd', '--create-home', '--shell', '/bin/bash', 'acornary-deploy'])
home = Path('/home/acornary-deploy')
# The user cannot replace its forced command or append an unrestricted key.
os.chown(str(home), 0, 0); home.chmod(0o755)
(home / '.ssh').mkdir(mode=0o755)
(home / '.ssh').chmod(0o755)  # Root umask must not prevent sshd's user-context read.
public_key = Path(sys.argv[1]).read_text().strip()
assert public_key.startswith('ssh-ed25519 ') and '\n' not in public_key
auth = home / '.ssh/authorized_keys'
auth.write_text('restrict,command="/usr/local/sbin/acornary-release-ssh" ' + public_key + '\n')
auth.chmod(0o644)
sudoers = Path('/etc/sudoers.d/acornary-release')
sudoers.write_text('acornary-deploy ALL=(root) NOPASSWD: /usr/local/sbin/acornary-release\n')
sudoers.chmod(0o440)
subprocess.check_call(['visudo', '-cf', str(sudoers)])
print('Release controller installed; current image registered without restarting production.')
