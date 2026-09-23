#!/usr/bin/env python3
"""Install an additive persistent ingress override; preserve the existing publisher.

Run as root under /run/lock/runbuoy-deploy.lock. Never runs a Runbuoy build.
"""
from pathlib import Path
import shutil
import subprocess

path = Path('/usr/local/sbin/deploy-runbuoy')
original = path.read_text()
marker = '# Acornary persistent shared ingress'
if marker in original:
    print('Publisher already includes Acornary ingress.')
    raise SystemExit(0)
compose_line = '  -f "$RELEASE/infra/docker-compose.prod.yml"\n'
if original.count(compose_line) != 1 or original.count('"${compose[@]}" config -q') != 1:
    raise SystemExit('Publisher differs from inspected version; review before patching.')
updated = original.replace(compose_line, compose_line + '  -f /etc/runbuoy/acornary-ingress.override.yaml\n')
updated = updated.replace('"${compose[@]}" config -q', marker + '\nACORNARY_INGRESS_LOCK_HELD=1 /usr/local/sbin/acornary-ingress check "$RELEASE/infra/Caddyfile"\n"${compose[@]}" config -q')
updated = updated.replace('"${compose[@]}" up \\\n', 'ACORNARY_INGRESS_LOCK_HELD=1 /usr/local/sbin/acornary-ingress prepare "$RELEASE/infra/Caddyfile"\n"${compose[@]}" up \\\n')
updated = updated.replace('curl --fail --silent --show-error \\\n', 'ACORNARY_INGRESS_LOCK_HELD=1 /usr/local/sbin/acornary-ingress reload\n\ncurl --fail --silent --show-error \\\n')
backup = Path('/etc/runbuoy/deploy-runbuoy.before-acornary')
if backup.exists():
    raise SystemExit('Original publisher backup already exists; inspect it first.')
candidate = path.with_suffix('.acornary-candidate')
candidate.write_text(updated)
subprocess.run(['bash', '-n', str(candidate)], check=True)
shutil.copy2(path, backup)
shutil.copymode(path, candidate)
candidate.replace(path)
print('Publisher patched; existing lock, networks, certificate volumes and services preserved.')
