import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, saveConfig, DEFAULT_CONFIG } from '../src/config.js';

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'lr-launcher-config-'));
}

test('a missing settings file gives the defaults: port 8080, start at login on, test mode off', () => {
  const dir = tempDir();
  try {
    assert.deepEqual(loadConfig(join(dir, 'launcher.json')), { port: 8080, startAtLogin: true, testMode: false, address: null, ipadSeen: false });
    assert.deepEqual(DEFAULT_CONFIG, { port: 8080, startAtLogin: true, testMode: false, address: null, ipadSeen: false });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a broken settings file gives the defaults', () => {
  const dir = tempDir();
  try {
    const file = join(dir, 'launcher.json');
    for (const text of ['{ not json', '', 'null', '[1,2]', '"text"', '42']) {
      writeFileSync(file, text);
      assert.deepEqual(loadConfig(file), DEFAULT_CONFIG, `file holding ${JSON.stringify(text)}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('settings are saved and read back', () => {
  const dir = tempDir();
  try {
    const file = join(dir, 'launcher.json');
    const config = { port: 8090, startAtLogin: false, testMode: true, address: '192.168.0.195', ipadSeen: true };
    saveConfig(file, config);
    assert.deepEqual(loadConfig(file), config);
    // Nothing is left behind by the atomic write.
    assert.deepEqual(readdirSync(dir), ['launcher.json']);
    saveConfig(file, { ...config, port: 8091 });
    assert.equal(loadConfig(file).port, 8091);
    assert.deepEqual(readdirSync(dir), ['launcher.json']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('saving makes the folder when it is missing and keeps only the known settings', () => {
  const dir = tempDir();
  try {
    const file = join(dir, 'new', 'folder', 'launcher.json');
    saveConfig(file, { ...DEFAULT_CONFIG, port: 9000, extra: 'dropped' });
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { ...DEFAULT_CONFIG, port: 9000 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a setting that is wrong falls back to its default, the others are kept', () => {
  const dir = tempDir();
  try {
    const file = join(dir, 'launcher.json');
    writeFileSync(file, JSON.stringify({ port: 'eighty', startAtLogin: false, testMode: 'yes', address: 12 }));
    assert.deepEqual(loadConfig(file), { port: 8080, startAtLogin: false, testMode: false, address: null, ipadSeen: false });
    // The window takes 1024 to 65535; a file edited by hand gets no other.
    for (const port of [0, -1, 80, 1023, 65536, 80.5, null]) {
      writeFileSync(file, JSON.stringify({ port }));
      assert.equal(loadConfig(file).port, 8080, `port ${port}`);
    }
    writeFileSync(file, JSON.stringify({ port: 1024 }));
    assert.equal(loadConfig(file).port, 1024);
    writeFileSync(file, JSON.stringify({ port: 65535, address: '' }));
    assert.deepEqual(loadConfig(file), { ...DEFAULT_CONFIG, port: 65535 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a settings file saved with a byte order mark (Notepad) is read', () => {
  const dir = tempDir();
  try {
    const file = join(dir, 'launcher.json');
    writeFileSync(file, `\uFEFF${JSON.stringify({ port: 8095, startAtLogin: false, testMode: true, address: null, ipadSeen: true })}`);
    assert.deepEqual(loadConfig(file), { port: 8095, startAtLogin: false, testMode: true, address: null, ipadSeen: true });
    assert.deepEqual(readdirSync(dir), ['launcher.json']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a damaged settings file is kept as launcher.json.bad before the defaults replace it', () => {
  const dir = tempDir();
  try {
    const file = join(dir, 'launcher.json');
    writeFileSync(file, '{ "port": 80');
    assert.deepEqual(loadConfig(file), DEFAULT_CONFIG);
    assert.deepEqual(readdirSync(dir).sort(), ['launcher.json.bad']);
    assert.equal(readFileSync(join(dir, 'launcher.json.bad'), 'utf8'), '{ "port": 80');
    saveConfig(file, DEFAULT_CONFIG);
    assert.deepEqual(readdirSync(dir).sort(), ['launcher.json', 'launcher.json.bad']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('settings that cannot be saved give a plain error and leave nothing behind', () => {
  const dir = tempDir();
  try {
    // A folder where the file should be: the rename fails.
    const file = join(dir, 'launcher.json');
    mkdirSync(file);
    assert.throws(() => saveConfig(file, { ...DEFAULT_CONFIG, port: 9001 }), (err) => {
      assert.match(err.message, /^Couldn't save the Light Runner settings/);
      return true;
    });
    assert.deepEqual(readdirSync(dir), ['launcher.json']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
