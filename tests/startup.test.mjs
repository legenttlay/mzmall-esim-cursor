import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../server/store.mjs';

test('multiple first-run MCP instances share one complete vault key and all initialize', async () => {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const data = mkdtempSync(join(tmpdir(), 'mzmall-concurrent-start-'));
  const results = await Promise.all(Array.from({ length: 12 }, async () => {
    const transport = new StdioClientTransport({ command: process.execPath, args: [join(root, 'server/main.mjs')], env: { ...process.env, MZMALL_ENABLE_PURCHASES: '0', MZMALL_DATA_DIR: data }, stderr: 'pipe' });
    const client = new Client({ name: 'cold-start-regression', version: '1' });
    try { await client.connect(transport); return (await client.listTools()).tools.length; }
    finally { await client.close(); }
  }));
  assert.deepEqual(results, Array(12).fill(11));
  assert.equal(readFileSync(join(data, 'vault.key')).length, 32);
  const existingKey = readFileSync(join(data, 'vault.key'));
  const a = new Store(data); a.put('test', 'shared-record', { value: 'synthetic-only' });
  const b = new Store(data);
  assert.deepEqual(b.get('test', 'shared-record'), { value: 'synthetic-only' });
  assert.deepEqual(readFileSync(join(data, 'vault.key')), existingKey);
  a.close(); b.close();
});
