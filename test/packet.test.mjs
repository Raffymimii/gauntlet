import { project } from './helpers.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const { buildPacket, resolveWorkdir } = await import('../src/packet.mjs');
const { redact, isForbiddenPath } = await import('../src/redact.mjs');

const base = { role: 'r', format: 'f', objective: 'review this module carefully' };

test('embeds project files and redacts secrets in them', () => {
  const dir = project({ 'a.js': 'const apiKey = "sk-abcdefghijklmnopqrstuv";\nexport default 1;\n' });
  const p = buildPacket({ ...base, workdir: resolveWorkdir(dir), paths: ['a.js'] });
  assert.match(p.text, /## a\.js/);
  assert.doesNotMatch(p.text, /sk-abcdefghij/);
  assert.deepEqual(p.files, ['a.js']);
});

test('refuses credential files, paths outside the project and binaries', () => {
  const dir = project({ '.env': 'X=1', 'img.bin': Buffer.from([1, 0, 2]), 'ok.txt': 'fine' });
  const p = buildPacket({ ...base, workdir: resolveWorkdir(dir), paths: ['.env', '../outside.txt', 'img.bin', 'ok.txt'] });
  assert.deepEqual(p.files, ['ok.txt']);
  assert.equal(p.skipped.length, 3);
  assert.doesNotMatch(p.text, /X=1/);
});

test('a symlink pointing outside the project is refused', (t) => {
  const outside = project({ 'secret.txt': 'top secret' });
  const dir = project({});
  try {
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(dir, 'link.txt'));
  } catch {
    t.skip('symlinks not permitted here');
    return;
  }
  const p = buildPacket({ ...base, workdir: resolveWorkdir(dir), paths: ['link.txt'] });
  assert.equal(p.files.length, 0);
  assert.doesNotMatch(p.text, /top secret/);
});

test('a symlink inside the project pointing at a credential file is refused', (t) => {
  const dir = project({ '.env': 'API=very-secret-value' });
  try {
    fs.symlinkSync(path.join(dir, '.env'), path.join(dir, 'review.txt'));
  } catch {
    t.skip('symlinks not permitted here');
    return;
  }
  const p = buildPacket({ ...base, workdir: resolveWorkdir(dir), paths: ['review.txt'] });
  assert.equal(p.files.length, 0);
  assert.doesNotMatch(p.text, /very-secret-value/);
});

test('rejects a missing objective, a root workdir and a credential workdir', () => {
  const dir = project({});
  assert.throws(() => buildPacket({ ...base, objective: 'x', workdir: dir }));
  assert.throws(() => resolveWorkdir(path.parse(dir).root));
  const cred = project({ '.ssh/known': 'x' });
  assert.throws(() => resolveWorkdir(path.join(cred, '.ssh')));
});

test('the content hash changes when a file changes', () => {
  const dir = project({ 'a.js': 'one' });
  const wd = resolveWorkdir(dir);
  const h1 = buildPacket({ ...base, workdir: wd, paths: ['a.js'] }).contentHash;
  fs.writeFileSync(path.join(dir, 'a.js'), 'two');
  const h2 = buildPacket({ ...base, workdir: wd, paths: ['a.js'] }).contentHash;
  assert.notEqual(h1, h2);
});

test('redact covers common token shapes', () => {
  for (const s of ['ghp_abcdefghijklmnopqrstuvwxyz0123', 'AKIAABCDEFGHIJKLMNOP', 'Authorization: Bearer abc.def.ghi123', 'postgres://u:pw@host/db']) {
    assert.notEqual(redact(s), s, s);
  }
  assert.doesNotMatch(redact('{"password": "hunter2"}'), /hunter2/);
  assert.doesNotMatch(redact('AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENG'), /wJalr/);
  assert.doesNotMatch(redact('password: hunter2\n'), /hunter2/);
  assert.doesNotMatch(redact('TOKEN=abc'), /abc/);
  assert.equal(redact('const token = getToken();'), 'const token = getToken();');
  assert.equal(redact('maxTokens: 4096,'), 'maxTokens: 4096,');
  assert.doesNotMatch(redact('-----BEGIN RSA PRIVATE KEY-----\nMIIEow'), /MIIEow/);
  assert.ok(isForbiddenPath('config/.env.local'));
  assert.ok(isForbiddenPath('home/.ssh/id_ed25519'));
  assert.ok(!isForbiddenPath('src/environment.ts'));
});
