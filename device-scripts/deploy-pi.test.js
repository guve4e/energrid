const { execFileSync, spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');

const root = join(__dirname, '..');
const scripts = [
  'deploy-pi.sh',
  'deploy-pi-activate.sh',
  'bootstrap-pi-deploy.sh',
  'bootstrap-pi-deploy-root.sh',
  'rollback-pi.sh',
];
const source = Object.fromEntries(scripts.map((name) => [name, readFileSync(join(__dirname, name), 'utf8')]));

test('Pi deployment scripts have valid Bash syntax', () => {
  for (const file of scripts) {
    execFileSync('bash', ['-n', join(__dirname, file)]);
  }
});

test('normal deployment packages committed main and uses strict noninteractive SSH', () => {
  const deploy = source['deploy-pi.sh'];
  assertIncludes(deploy, '[[ "$branch" == main ]]');
  assertIncludes(deploy, 'git -C "$repo_root" archive --format=tar HEAD');
  assertIncludes(deploy, 'StrictHostKeyChecking=yes');
  assertIncludes(deploy, 'BatchMode=yes');
  assertIncludes(deploy, 'sha256sum -c -');
  assertIncludes(deploy, 'sudo -n /usr/local/sbin/energrid-deploy-activate');
  assertIncludes(deploy, 'release-manifest.txt');
});

test('privileged permission is one fixed, no-argument root-owned helper', () => {
  const bootstrap = source['bootstrap-pi-deploy-root.sh'];
  const helper = source['deploy-pi-activate.sh'];
  assertIncludes(bootstrap, 'NOPASSWD: /usr/local/sbin/energrid-deploy-activate ""');
  assertIncludes(bootstrap, 'install -o root -g root -m 0755');
  assertIncludes(helper, 'This helper accepts no arguments.');
  assert.doesNotMatch(bootstrap, /NOPASSWD:\s*ALL/);
  assert.doesNotMatch(helper, /mosquitto\s+(restart|reload|stop)/);
  assert.doesNotMatch(helper, /systemctl\s+(restart|reload|stop)\s+mosquitto/);
});

test('activation verifies the running release and rolls back failed health checks', () => {
  const helper = source['deploy-pi-activate.sh'];
  assertIncludes(helper, 'api_process_matches');
  assertIncludes(helper, 'core_process_matches');
  assertIncludes(helper, 'ENERGRID_RELEASE_ID=$target_release_id');
  assertIncludes(helper, 'ENERGRID_COMMIT=$target_commit');
  assertIncludes(helper, 'release_version_matches');
  assertIncludes(helper, 'ln -s "$target_release" "$root/current.deploy-$$"');
  assertIncludes(helper, 'Release verification failed; restoring the previous release');
  assertIncludes(helper, 'systemctl restart energrid-core energrid-api');
  assert.doesNotMatch(helper, /systemctl\s+(restart|reload|stop)\s+mosquitto/);
});

test('one-time bootstrap clearly discloses its controlled service restart', () => {
  const bootstrap = source['bootstrap-pi-deploy.sh'];
  assertIncludes(bootstrap, 'restart the existing API and Core once');
  assertIncludes(bootstrap, 'reload Nginx once');
  const rootBootstrap = source['bootstrap-pi-deploy-root.sh'];
  assertIncludes(rootBootstrap, 'release-env-was-absent');
  assertIncludes(rootBootstrap, 'API is not running the current release identity.');
  assertIncludes(rootBootstrap, 'rm -f "$helper_dest" "$helper_dest.new" "$api_tmp" "$core_tmp" "$nginx_tmp"');
  assert.ok(rootBootstrap.indexOf('install -d -o root -g root -m 0755 "$(dirname "$core_dropin")"') <
    rootBootstrap.indexOf('core_tmp="$(mktemp "${core_dropin}.bootstrap.XXXXXX")"'));
});

test('bootstrap rejects an invalid target before changing anything', () => {
  const result = spawnSync('bash', [join(__dirname, 'bootstrap-pi-deploy.sh'), 'bad target'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Usage:/);
});

test('deployment help and unknown options are local-only', () => {
  const help = spawnSync('bash', [join(__dirname, 'deploy-pi.sh'), '--help'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /npm run deploy:pi/);

  const invalid = spawnSync('bash', [join(__dirname, 'deploy-pi.sh'), '--not-a-deploy-option'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /Unknown option/);
});

test('package scripts expose bootstrap, deploy and rollback commands', () => {
  const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(packageJson.scripts['bootstrap:pi-deploy'], 'bash device-scripts/bootstrap-pi-deploy.sh');
  assert.equal(packageJson.scripts['deploy:pi'], 'bash device-scripts/deploy-pi.sh');
  assert.equal(packageJson.scripts['rollback:pi'], 'bash device-scripts/rollback-pi.sh');
  assert.equal(packageJson.scripts['deploy:pi:test'], 'node --test device-scripts/deploy-pi.test.js');
});

function assertIncludes(value, expected) {
  assert.ok(value.includes(expected), `Expected source to include: ${expected}`);
}
