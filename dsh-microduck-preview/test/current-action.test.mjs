import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PreviewStore } from '../lib/tasks.js';

test('a new successful action replaces only this session’s managed action; a failure preserves it', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'duck-current-'));
  const store = new PreviewStore({ pluginDir: root, config: { dataDir: root, engine: 'demo' }, logger: () => {} }).init();
  store.runDemo = async (record) => { if (record.params.fail) throw new Error('fixture failure'); };
  try {
    const first = store.create({ pattern: 'line' }, { sessionId: 'chat-a' });
    await store.waitFor(first, 1000);
    const other = store.create({ pattern: 'line' }, { sessionId: 'chat-b' });
    await store.waitFor(other, 1000);
    const failed = store.create({ pattern: 'line', fail: true }, { sessionId: 'chat-a' });
    await store.waitFor(failed, 1000);
    assert.equal(failed.status, 'error');
    assert.ok(store.get(first.id));
    const next = store.create({ pattern: 'hover' }, { sessionId: 'chat-a' });
    await store.waitFor(next, 1000);
    assert.equal(next.status, 'done');
    assert.equal(store.get(first.id), undefined);
    assert.equal(store.get(failed.id), undefined);
    assert.ok(store.get(other.id));
    assert.deepEqual(store.listForSession('chat-a').map((item) => item.id), [next.id]);
  } finally { store.dispose(); fs.rmSync(root, { recursive: true, force: true }); }
});
