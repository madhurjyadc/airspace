import test from 'node:test';
import assert from 'node:assert/strict';
import { nameReason, contentReason, parseIgnore, pathReason, sizeReason, MAX_BYTES } from '../src/secrets.js';

test('secret file names are refused', () => {
  for (const p of ['.env', '.env.local', 'app/.env.production', 'a/server.pem', 'k.key', 'x.p12', 'x.pfx',
    'id_rsa', 'id_rsa.pub', 'id_ed25519', 'creds.txt', 'my-secrets.json', 'AWS_Credentials', 'Passwords.md']) {
    assert.equal(nameReason(p), 'secret-looking file name', p);
  }
});

test('ordinary and example files are allowed', () => {
  for (const p of ['.env.example', 'cfg/.env.sample', 'src/auth.js', 'README.md', 'environment.js', 'keyboard.js']) {
    assert.equal(nameReason(p), null, p);
  }
});

test('each content rule fires', () => {
  const cases = {
    'contains a private key': '-----BEGIN RSA PRIVATE KEY-----\nabc',
    'contains an AWS key': 'id = AKIAABCDEFGHIJKLMNOP',
    'contains a GitHub token': 'ghp_' + 'a'.repeat(30),
    'contains a Slack token': 'xoxb-1234567890-abcdef',
    'contains an API key': 'sk-' + 'A1b2'.repeat(6),
    'contains a key, token or password value': 'API_KEY = "hunter2hunter2"',
  };
  for (const [reason, text] of Object.entries(cases)) {
    assert.equal(contentReason(Buffer.from(text)), reason);
  }
  assert.equal(contentReason(Buffer.from('password: "short"')), null);
  assert.equal(contentReason(Buffer.from('token: abcdefghij')), 'contains a key, token or password value');
});

test('plain code and binary files pass the content check', () => {
  assert.equal(contentReason(Buffer.from('const a = 1;\nfunction tokenize() {}\n')), null);
  assert.equal(contentReason(Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from('password=abcdefghijkl')])), null);
});

test('size limit is 1 MB', () => {
  assert.equal(sizeReason(MAX_BYTES), null);
  assert.equal(sizeReason(MAX_BYTES + 1), 'larger than 1 MB');
});

test('.airspaceignore globs', () => {
  const ig = parseIgnore('# comment\n\n*.log\n/build\ndocs/private/\n**/fixtures/*.json\nsecret?.txt\n');
  const hit = (p) => pathReason(p, ig);
  assert.equal(hit('debug.log'), 'listed in .airspaceignore');
  assert.equal(hit('a/b/debug.log'), 'listed in .airspaceignore');
  assert.equal(hit('build/out.js'), 'listed in .airspaceignore');
  assert.equal(hit('src/build/out.js'), null);
  assert.equal(hit('docs/private/x.md'), 'listed in .airspaceignore');
  assert.equal(hit('docs/public/x.md'), null);
  assert.equal(hit('t/fixtures/a.json'), 'listed in .airspaceignore');
  assert.equal(hit('fixtures/a.json'), 'listed in .airspaceignore');
  assert.equal(hit('fixtures/a.txt'), null);
  assert.equal(hit('src/index.js'), null);
});
