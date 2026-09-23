"""Isolated real image/PostgreSQL deployment checks. Never touches production.
Run after building acornary-release-fixture:base with VERSION=v9.0.0.
Transport pull and public TLS checks are tested separately; here images are local
and requests simulate the trusted proxy from inside the application container.
"""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time

spec = importlib.util.spec_from_file_location('release', Path(__file__).resolve().parents[2] / 'deploy/release.py')
r = importlib.util.module_from_spec(spec); spec.loader.exec_module(r)
SHA = 'a' * 40
base = 'acornary-release-fixture:base'
name = 'acornary-release-ci-' + str(int(time.time()))
root = Path(tempfile.mkdtemp(prefix=name))
os.chmod(str(root), 0o700)
compose_file = root / 'compose.json'
env_file = root / 'deploy.env'
env_file.write_text('ACORNARY_IMAGE=' + base + '\n')
url = 'postgres://acornary_migrator:isolated-release-ci@postgres:5432/acornary'
image_map = {}

def run(args, stdin=None):
    return r.command(args, stdin=stdin)

compose = ['docker', 'compose', '--env-file', str(env_file), '-f', str(compose_file)]
compose_file.write_text(json.dumps({'name': name, 'services': {
    'postgres': {'image': 'postgres:18-bookworm', 'environment': {
        'POSTGRES_USER': 'acornary_migrator', 'POSTGRES_PASSWORD': 'isolated-release-ci', 'POSTGRES_DB': 'acornary'},
        'healthcheck': {'test': ['CMD-SHELL', 'pg_isready -U acornary_migrator'], 'interval': '1s', 'retries': 60}},
    'app': {'image': '${ACORNARY_IMAGE}', 'environment': {
        'DATABASE_URL': 'postgres://acornary_app:isolated-app-ci@postgres:5432/acornary',
        'ACORNARY_MODE': 'cloud', 'ACORNARY_ORIGIN': 'https://release.example.test',
        'ACORNARY_TRUSTED_PROXY': '127.0.0.1', 'BETTER_AUTH_SECRET': 'isolated-release-test-secret-32-characters'},
        'healthcheck': {'test': ['CMD', 'node', '-e', "fetch('http://127.0.0.1:3210/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"],
                        'interval': '1s', 'timeout': '3s', 'retries': 10}},
    'admin': {'image': '${ACORNARY_IMAGE}', 'environment': {'DATABASE_URL': url}, 'profiles': ['ops']}
}}))

class LocalBackend(r.DockerBackend):
    def prepare(self, image, job):
        target = image_map[image]
        return json.loads(run(['docker', 'run', '--rm', '--network', 'none', '--entrypoint', 'cat', target, '/app/release.json']))

    def set_image(self, image):
        super().set_image(image_map.get(image, image))

    def check(self, release):
        # Same application and DB checks, without a production DNS dependency.
        data = json.loads(run(compose + ['exec', '-T', 'app', 'node', '-e',
             "fetch('http://127.0.0.1:3210/health').then(async r=>{if(!r.ok)process.exit(1);console.log(await r.text())})"]))
        assert data['version'] == release['version'] and data['commit'] == release['commit']

    def remove_image(self, image): pass

def fixture(version, migrations, broken=False):
    directory = root / version; directory.mkdir()
    extra = ''
    for filename, text in migrations.items():
        (directory / filename).write_text(text)
        extra += 'COPY ' + filename + ' /app/migrations/' + filename + '\n'
    js = "const fs=require('fs'),crypto=require('crypto');let m=JSON.parse(fs.readFileSync('/app/release.json'));m.version=" + json.dumps(version) + ";for(const n of fs.readdirSync('/app/migrations'))m.migrations[n]=crypto.createHash('sha256').update(fs.readFileSync('/app/migrations/'+n)).digest('hex');fs.writeFileSync('/app/release.json',JSON.stringify(m));"
    dockerfile = 'FROM ' + base + '\n' + extra + 'RUN node -e ' + "'" + js.replace("'", "'\"'\"'") + "'\n"
    if broken: dockerfile += 'CMD ["node", "-e", "process.exit(1)"]\n'
    (directory / 'Dockerfile').write_text(dockerfile)
    target = 'acornary-release-fixture:' + version
    run(['docker', 'build', '-q', '-t', target, str(directory)])
    digest = 'sha256:' + __import__('hashlib').sha256(version.encode()).hexdigest()
    image_map['ghcr.io/tang617/acornary@' + digest] = target
    return digest

def app_fetch(path, cookie='', body=None):
    js = """const headers={host:'release.example.test','x-forwarded-proto':'https',origin:'https://release.example.test'};
    const body=JSON.parse(process.env.TEST_REQUEST);if(body.cookie)headers.cookie=body.cookie;
    if(body.payload)headers['content-type']='application/json';
    const req=require('node:http').request({hostname:'127.0.0.1',port:3210,path:body.path,method:body.payload?'POST':'GET',headers},r=>{
      let text='';r.on('data',c=>text+=c);r.on('end',()=>console.log(JSON.stringify({status:r.statusCode,data:JSON.parse(text),cookies:(r.headers['set-cookie']||[]).map(x=>x.split(';')[0]).join('; ')})));
    });req.on('error',()=>process.exit(1));req.end(body.payload?JSON.stringify(body.payload):undefined);"""
    env = dict(os.environ, TEST_REQUEST=json.dumps({'path': path, 'cookie': cookie, 'payload': body}))
    output = subprocess.check_output(compose + ['exec', '-T', '-e', 'TEST_REQUEST', 'app', 'node', '-e', js], env=env)
    return json.loads(output)

try:
    run(compose + ['up', '-d', '--wait', 'postgres'])
    database_container = run(compose + ['ps', '-q', 'postgres']).strip()
    config = {'state_dir': str(root / 'state'), 'backup_dir': str(root / 'backups'),
              'image_repository': 'ghcr.io/tang617/acornary', 'env_file': str(env_file),
              'compose_file': str(compose_file), 'database_container': database_container,
              'origin': 'https://release.example.test'}
    backend = LocalBackend(config)
    run(compose + ['run', '--rm', '-T', 'admin', 'node', 'dist/apps/server/src/initialize.js'])
    backend.database("CREATE ROLE acornary_app LOGIN PASSWORD 'isolated-app-ci'")
    run(compose + ['run', '--rm', '-T', 'admin', 'node', 'dist/apps/server/src/migrate.js', '--grants'])
    setup = """import {manageOwner} from './dist/apps/server/src/owner.js';
    import {pool} from './dist/apps/server/src/db.js';
    import {initialize} from './dist/apps/server/src/initialize.js';
    import {execute} from './dist/apps/server/src/service.js';
    await manageOwner('create','release@example.test','Release-fixture-password-123!');
    const c={...await initialize(),source:'TEST'};
    const result=await execute(c,'create_items',{catalog_node_id:c.container_catalog_id,count:1,idempotency_key:'fixture-create',expected_revisions:{}});
    await execute(c,'add_note',{item_id:result.affected_objects[0].id,body:'Persist across releases',idempotency_key:'fixture-note',expected_revisions:{[result.affected_objects[0].id]:1}});
    await pool.end();"""
    run(compose + ['run', '--rm', '-T', 'admin', 'node', '--input-type=module'], stdin=setup.encode())
    backend.start()
    auth = app_fetch('/api/auth/sign-in/email', body={'email': 'release@example.test', 'password': 'Release-fixture-password-123!'})
    assert auth['status'] == 200, {'status': auth['status'], 'data': auth['data']}
    cookie = auth['cookies']
    identity = app_fetch('/api/context', cookie)
    assert identity['status'] == 200
    metadata = json.loads(run(['docker', 'run', '--rm', '--entrypoint', 'cat', base, '/app/release.json']))
    controller = r.Controller(config, backend)
    r.save_json(controller.root / 'current.json', dict(metadata, image=base))
    r.save_json(controller.root / 'schema.json', metadata['migrations'])
    rows_before = backend.database("SELECT jsonb_agg(to_jsonb(i) ORDER BY id)::text FROM items i")
    events_before = backend.database("SELECT jsonb_agg(to_jsonb(e) ORDER BY id)::text FROM events e")
    notes_before = backend.database("SELECT jsonb_agg(to_jsonb(n) ORDER BY id)::text FROM notes n")
    operations_before = backend.database("SELECT jsonb_agg(to_jsonb(o) ORDER BY idempotency_key)::text FROM operations o")
    catalog_before = backend.database("SELECT jsonb_agg(to_jsonb(c) ORDER BY id)::text FROM catalog_nodes c")
    def deploy(version, migrations={}, broken=False):
        digest = fixture(version, migrations, broken)
        job = controller.enqueue(version, SHA, digest)
        return controller.perform(job['id'])
    plain = deploy('v9.0.1')
    assert plain['phase'] == 'succeeded' and not plain.get('backup'), plain
    assert app_fetch('/api/context', cookie)['data'] == identity['data']
    replay = """import {pool} from './dist/apps/server/src/db.js';
    import {initialize} from './dist/apps/server/src/initialize.js';
    import {execute} from './dist/apps/server/src/service.js';
    const c={...await initialize(),source:'TEST'};
    await execute(c,'create_items',{catalog_node_id:c.container_catalog_id,count:1,idempotency_key:'fixture-create',expected_revisions:{}});
    await pool.end();"""
    run(compose + ['run', '--rm', '-T', 'admin', 'node', '--input-type=module'], stdin=replay.encode())
    added = {'005_release_probe.sql': 'CREATE TABLE release_probe(id integer PRIMARY KEY);'}
    upgraded = deploy('v9.0.2', added)
    assert upgraded['phase'] == 'succeeded' and upgraded.get('backup'), upgraded
    assert app_fetch('/api/context', cookie)['data'] == identity['data']
    assert backend.database("SELECT jsonb_agg(to_jsonb(i) ORDER BY id)::text FROM items i") == rows_before
    assert backend.database("SELECT jsonb_agg(to_jsonb(e) ORDER BY id)::text FROM events e") == events_before
    assert backend.database("SELECT jsonb_agg(to_jsonb(n) ORDER BY id)::text FROM notes n") == notes_before
    assert backend.database("SELECT jsonb_agg(to_jsonb(o) ORDER BY idempotency_key)::text FROM operations o") == operations_before
    assert backend.database("SELECT jsonb_agg(to_jsonb(c) ORDER BY id)::text FROM catalog_nodes c") == catalog_before
    run(['docker', 'exec', database_container, 'createdb', '-U', 'acornary_migrator', 'acornary_restore_release'])
    with open(upgraded['backup'], 'rb') as stream:
        run(['docker', 'exec', '-i', database_container, 'pg_restore', '-U', 'acornary_migrator', '-d', 'acornary_restore_release', '--no-owner', '--no-privileges'], stdin=stream)
    restored = run(['docker', 'exec', database_container, 'psql', '-X', '-t', '-A', '-U', 'acornary_migrator', '-d', 'acornary_restore_release', '-c', 'SELECT count(*) FROM migrations']).strip()
    assert restored == '4'  # Snapshot precedes 005; never overwrote the upgraded database.
    rolled_back = deploy('v9.0.3', dict(added, **{'006_bad.sql': 'CREATE TABLE should_rollback(id int); SELECT 1/0;'}))
    assert rolled_back['phase'] == 'failed' and rolled_back['recovered'], rolled_back
    assert backend.database("SELECT to_regclass('public.should_rollback')").strip() == ''
    failed_start = deploy('v9.0.4', added, broken=True)
    assert failed_start['phase'] == 'failed' and failed_start['recovered'], failed_start
    committed = deploy('v9.0.5', dict(added, **{'006_committed.sql': 'CREATE TABLE committed_probe(id int);'}), broken=True)
    assert committed['phase'] == 'needs_attention', committed
    assert backend.database("SELECT to_regclass('public.committed_probe')").strip() == 'committed_probe'
    assert not run(compose + ['ps', '--status', 'running', '-q', 'app']).strip()
    print('PASS: real image upgrades, persistent session/identity/items/notes/events, conditional backup + independent restore, SQL rollback, app recovery, committed-schema fail-closed.')
finally:
    subprocess.run(compose + ['down', '-v', '--remove-orphans'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    # Fixture images and non-secret logs can remain for diagnosis; no production resource is referenced.
