#!/usr/bin/env python3
"""Root-owned deployment controller. Python 3.6+; no third-party packages.

Only start/status are exposed over the forced SSH command. Workers are systemd
services, not children of the SSH connection. Configuration is root-only.
"""
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request

TERMINAL = {'succeeded', 'failed', 'needs_attention'}
VERSION = re.compile(r'^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$')
COMMIT = re.compile(r'^[0-9a-f]{40}$')
DIGEST = re.compile(r'^sha256:[0-9a-f]{64}$')
JOB = re.compile(r'^[0-9a-f]{24}$')

def require(ok, message):
    if not ok:
        raise RuntimeError(message)

def version_tuple(value):
    match = VERSION.fullmatch(value)
    require(match is not None, 'Stable semantic version required')
    return tuple(int(x) for x in match.groups())

def request(version, commit, digest):
    version_tuple(version)
    require(COMMIT.fullmatch(commit) is not None, 'Invalid commit')
    require(DIGEST.fullmatch(digest) is not None, 'Invalid digest')
    ident = hashlib.sha256((version + commit + digest).encode()).hexdigest()[:24]
    return {'id': ident, 'version': version, 'commit': commit, 'digest': digest}

def read_json(path):
    return json.loads(Path(path).read_text())

def save_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temp = path.with_name(path.name + '.next')
    with temp.open('w') as output:
        os.chmod(str(temp), 0o600)
        json.dump(value, output, sort_keys=True, indent=2)
        output.flush()
        os.fsync(output.fileno())
    os.replace(str(temp), str(path))
    directory = os.open(str(path.parent), os.O_RDONLY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)

@contextlib.contextmanager
def lock(path, blocking=True):
    with open(str(path), 'a') as handle:
        fcntl.flock(handle, fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB))
        yield

def command(args, stdin=None, stdout=None, timeout=600):
    stream = {'stdin': stdin} if hasattr(stdin, 'read') else {'input': stdin}
    result = subprocess.run(args, stdout=stdout or subprocess.PIPE,
                            stderr=subprocess.PIPE, timeout=timeout, **stream)
    # Do not put environment values, SQL errors or credentials in public status.
    require(result.returncode == 0, '{} failed (exit {})'.format(args[0], result.returncode))
    return result.stdout.decode() if result.stdout else ''

class DockerBackend:
    def __init__(self, config):
        self.config = config
        self.compose = ['docker', 'compose', '--env-file', config['env_file'], '-f', config['compose_file']]

    def database(self, sql):
        return command(['docker', 'exec', '-i', self.config['database_container'],
                        'psql', '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1',
                        '-U', 'acornary_migrator', '-d', 'acornary'], stdin=sql.encode())

    def applied(self):
        return json.loads(self.database("SELECT coalesce(json_agg(t ORDER BY name),'[]'::json) FROM migrations t"))

    def space(self, backup=False):
        required = 1024 ** 3
        if backup:
            required += 2 * int(self.database("SELECT pg_database_size(current_database())").strip())
        require(shutil.disk_usage(self.config['state_dir']).free >= required, 'Insufficient free space')

    def prepare(self, image, job):
        self.space()
        command(['docker', 'pull', image])
        inspection = json.loads(command(['docker', 'image', 'inspect', image]))[0]
        require(inspection['Os'] == 'linux' and inspection['Architecture'] == 'amd64', 'Wrong image platform')
        labels = inspection.get('Config', {}).get('Labels', {}) or {}
        require(labels.get('org.opencontainers.image.revision') == job['commit'], 'Image commit mismatch')
        require(labels.get('org.opencontainers.image.version') == job['version'], 'Image version mismatch')
        container = command(['docker', 'create', image]).strip()
        path = Path(self.config['state_dir']) / ('metadata-' + job['id'] + '.json')
        try:
            command(['docker', 'cp', container + ':/app/release.json', str(path)])
            value = read_json(path)
        finally:
            command(['docker', 'rm', container])
            if path.exists(): path.unlink()
        require(value.get('version') == job['version'] and value.get('commit') == job['commit'], 'Release metadata mismatch')
        migrations = value.get('migrations')
        require(isinstance(migrations, dict) and len(migrations) > 0, 'Missing migration manifest')
        for name, digest in migrations.items():
            require(re.fullmatch(r'[0-9]{3,}_[a-z0-9_]+\.sql', name) is not None and
                    re.fullmatch(r'[0-9a-f]{64}', digest) is not None, 'Invalid migration manifest')
        return value

    def stop(self):
        command(self.compose + ['stop', '-t', '45', 'app'], timeout=90)

    def set_image(self, image):
        path = Path(self.config['env_file'])
        lines = path.read_text().splitlines()
        require(sum(line.startswith('ACORNARY_IMAGE=') for line in lines) == 1, 'Invalid deployment environment')
        data = '\n'.join('ACORNARY_IMAGE=' + image if line.startswith('ACORNARY_IMAGE=') else line for line in lines) + '\n'
        tmp = path.with_name(path.name + '.next')
        with tmp.open('w') as output:
            os.chmod(str(tmp), 0o600)
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        os.replace(str(tmp), str(path))

    def backup(self, job):
        self.space(backup=True)
        directory = Path(self.config['backup_dir']) / job['id']
        directory.mkdir(parents=True, mode=0o700, exist_ok=False)
        partial = directory / 'database.dump.partial'
        with partial.open('xb') as output:
            os.chmod(str(partial), 0o600)
            command(['docker', 'exec', self.config['database_container'], 'pg_dump',
                     '-U', 'acornary_migrator', '-Fc', '--no-owner', '--no-privileges', 'acornary'], stdout=output)
            output.flush()
            os.fsync(output.fileno())
        hasher = hashlib.sha256()
        with partial.open('rb') as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b''): hasher.update(chunk)
        digest = hasher.hexdigest()
        final = directory / 'database.dump'
        partial.rename(final)
        # A successful dump with a valid archive directory, not a renamed empty file.
        with final.open('rb') as source:
            command(['docker', 'exec', '-i', self.config['database_container'], 'pg_restore', '--list'], stdin=source)
        save_json(directory / 'manifest.json', {'sha256': digest, 'release': job['version'], 'commit': job['commit']})
        return str(final)

    def migrate(self):
        command(self.compose + ['run', '--rm', '-T', '--no-deps', 'admin',
                               'node', 'dist/apps/server/src/migrate.js', '--grants'])

    def start(self):
        # The database and shared ingress are never recreated by an app release.
        command(self.compose + ['up', '-d', '--no-deps', '--wait', '--wait-timeout', '120', 'app'], timeout=180)

    def remove_image(self, image):
        subprocess.run(['docker', 'image', 'rm', image], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def check(self, release):
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        origin = self.config['origin']
        def get(path, expected):
            try: response = opener.open(origin + path, timeout=15)
            except urllib.error.HTTPError as e: response = e
            require(response.status == expected, 'Public endpoint check failed: ' + path)
            return response.read()
        health = json.loads(get('/health', 200))
        require(health.get('status') == 'ok', 'Health status mismatch')
        if release.get('version') is not None:  # Bootstrap image predates versioned health.
            require(health.get('version') == release['version'] and health.get('commit') == release['commit'], 'Running version mismatch')
        get('/login', 200)
        get('/api/context', 401)
        get('/mcp', 401)
        resource = json.loads(get('/.well-known/oauth-protected-resource/mcp', 200))
        require(resource.get('resource') == origin + '/mcp', 'Resource mismatch')
        auth = json.loads(get('/.well-known/oauth-authorization-server/api/auth', 200))
        require(auth.get('issuer') == origin + '/api/auth', 'Issuer mismatch')

class Controller:
    def __init__(self, config, backend=None):
        self.config = config
        self.root = Path(config['state_dir'])
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        (self.root / 'jobs').mkdir(exist_ok=True, mode=0o700)
        self.backend = backend or DockerBackend(config)

    def path(self, ident):
        require(JOB.fullmatch(ident) is not None, 'Invalid job ID')
        return self.root / 'jobs' / (ident + '.json')

    def jobs(self):
        return [read_json(path) for path in (self.root / 'jobs').glob('*.json')]

    def update(self, job, phase, **values):
        job.update(values)
        job.update(phase=phase, updated_at=time.time())
        save_json(self.path(job['id']), job)

    def enqueue(self, version, commit, digest):
        job = request(version, commit, digest)
        with lock(self.root / 'submit.lock'):
            if self.path(job['id']).exists(): return read_json(self.path(job['id']))
            for prior in self.jobs():
                require(prior['version'] != version, 'Version already bound to a different commit or digest')
                require(prior['phase'] in TERMINAL and prior['phase'] != 'needs_attention', 'An earlier deployment is active or needs attention')
            current = read_json(self.root / 'current.json')
            require(current.get('version') is None or version_tuple(version) > version_tuple(current['version']), 'Version downgrade rejected')
            job.update(created_at=time.time(), image=self.config['image_repository'] + '@' + digest)
            self.update(job, 'queued')
            return job

    def perform(self, ident):
        with lock(self.root / 'deploy.lock', blocking=False):
            job = read_json(self.path(ident))
            if job['phase'] in TERMINAL: return job
            require(job['phase'] == 'queued', 'Interrupted job needs operator recovery')
            previous = read_json(self.root / 'current.json')
            stopped = False
            migration_started = False
            committed = False
            before = None
            try:
                require(previous.get('version') is None or version_tuple(job['version']) > version_tuple(previous['version']), 'Version downgrade rejected')
                self.update(job, 'preparing', previous=previous)
                metadata = self.backend.prepare(job['image'], job)
                before = self.backend.applied()
                known = read_json(self.root / 'schema.json')
                target = metadata['migrations']
                for row in before:
                    name = row['name']
                    require(name in target and known.get(name) == target[name], 'Applied migration missing or changed: ' + name)
                pending = sorted(set(target) - {row['name'] for row in before})
                # Record hashes before running SQL; even a failed candidate may have committed.
                self.update(job, 'validated', migrations=target, pending=pending, before=before)
                self.update(job, 'stopping')
                stopped = True  # A failed stop is also a potentially stopped application.
                self.backend.stop()
                if pending:
                    self.update(job, 'backing_up')
                    backup = self.backend.backup(job)
                    self.update(job, 'backed_up', backup=backup)
                self.backend.set_image(job['image'])
                if pending:
                    save_json(self.root / 'schema.json', dict(known, **target))
                    self.update(job, 'migrating')
                    migration_started = True
                    self.backend.migrate()
                    committed = True
                    actual = self.backend.applied()
                    require({r['name'] for r in actual} == set(target), 'Migration result mismatch')
                self.update(job, 'starting', migration_committed=committed)
                self.backend.start()
                self.backend.check(job)
                save_json(self.root / 'current.json', {
                    'id': job['id'], 'version': job['version'], 'commit': job['commit'],
                    'image': job['image'], 'digest': job['digest'], 'migrations': target,
                })
                self.update(job, 'succeeded')
            except Exception as error:
                safe = not committed
                if migration_started and not committed:
                    try: safe = self.backend.applied() == before
                    except Exception: safe = False
                if stopped and safe:
                    try:
                        self.update(job, 'restoring', error=str(error))
                        self.backend.set_image(previous['image'])
                        self.backend.start()
                        self.backend.check(previous)
                        save_json(self.root / 'current.json', previous)
                        self.update(job, 'failed', error=str(error), recovered=True)
                    except Exception:
                        try: self.backend.stop()
                        except Exception: pass
                        self.update(job, 'needs_attention', error='Previous application recovery failed', recovered=False)
                elif stopped:
                    try: self.backend.stop()
                    except Exception: pass
                    self.update(job, 'needs_attention', error='Migration committed or outcome uncertain; database was not restored', recovered=False)
                else:
                    self.update(job, 'failed', error=str(error), recovered=True)
            if job['phase'] == 'succeeded':
                try: self.cleanup()
                except Exception: self.update(job, 'succeeded', cleanup_warning=True)
            return job

    def cleanup(self):
        jobs = self.jobs()
        successful = sorted([j for j in jobs if j['phase'] == 'succeeded'], key=lambda j: j['updated_at'], reverse=True)
        protected = {j['image'] for j in jobs if j['phase'] != 'succeeded'}
        protected.update(j['image'] for j in successful[:3])
        for job in successful[3:]:
            if job['image'] not in protected:
                # Only this project's exact pulled references, never global Docker pruning.
                self.backend.remove_image(job['image'])
        backed_up = [j for j in successful if j.get('backup')]
        for job in backed_up[3:]:
            directory = Path(self.config['backup_dir']) / job['id']
            if directory.exists(): shutil.rmtree(str(directory))

def public(job):
    return {key: job[key] for key in ('id', 'version', 'commit', 'digest', 'phase', 'error', 'recovered', 'cleanup_warning') if key in job}

def main():
    require(os.geteuid() == 0, 'Deployment controller requires root')
    os.umask(0o077)
    config = read_json('/etc/acornary/release.json')
    controller = Controller(config)
    args = sys.argv[1:]
    require(len(args) > 0, 'Missing command')
    if args[0] == 'start' and len(args) == 4:
        with lock(controller.root / 'launch.lock'):
            job = controller.enqueue(*args[1:])
            if job['phase'] == 'queued':
                unit = 'acornary-release-' + job['id']
                active = subprocess.run(['systemctl', 'is-active', '--quiet', unit]).returncode == 0
                if not active:
                    try:
                        command(['systemd-run', '--unit=' + unit, '--collect', '--property=Type=simple',
                                 '/usr/local/sbin/acornary-release', 'worker', job['id']])
                    except Exception:
                        controller.update(job, 'needs_attention', error='Could not confirm worker submission')
        print(json.dumps(public(job)))
    elif args[0] == 'status' and len(args) == 2:
        job = read_json(controller.path(args[1]))
        if job['phase'] not in TERMINAL and time.time() - job['updated_at'] > 30:
            active = subprocess.run(['systemctl', 'is-active', '--quiet', 'acornary-release-' + job['id']]).returncode == 0
            if not active:
                # Never guess whether SQL committed after power loss or a killed worker.
                try:
                    with lock(controller.root / 'deploy.lock', blocking=False):
                        # The worker may have completed since the first read.
                        job = read_json(controller.path(args[1]))
                        if job['phase'] not in TERMINAL and time.time() - job['updated_at'] > 30:
                            controller.update(job, 'needs_attention', error='Worker interrupted; inspect server journal')
                except BlockingIOError:
                    job = read_json(controller.path(args[1]))
        print(json.dumps(public(job)))
    elif args[0] == 'worker' and len(args) == 2:
        print(json.dumps(public(controller.perform(args[1]))))
    else:
        raise RuntimeError('Unsupported command')

if __name__ == '__main__':
    try: main()
    except Exception as error:
        print(json.dumps({'phase': 'rejected', 'error': str(error)}))
        sys.exit(1)
