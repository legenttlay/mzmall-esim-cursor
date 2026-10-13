import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const mode = process.argv[2] ?? 'concurrent';
const entry = mode === 'installed' ? join(homedir(), '.cursor/plugins/local/mzmall-esim/dist/index.mjs') : join(root, 'server/main.mjs');
const data = mode === 'installed' ? join(homedir(), '.mzmall-esim') : mkdtempSync(join(tmpdir(), 'mzmall-startup-probe-'));
const results = await Promise.all(Array.from({ length: mode === 'installed' ? 1 : 12 }, async (_, index) => {
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry], env: { ...process.env, MZMALL_ENABLE_PURCHASES: '0', MZMALL_DATA_DIR: data }, stderr: 'pipe' });
  const client = new Client({ name: 'startup-probe', version: '1' });
  let stderr = '';
  try {
    const connecting = client.connect(transport);
    transport.stderr?.on('data', chunk => { stderr += chunk.toString(); });
    await connecting;
    const tools = await client.listTools();
    return { index, connected: true, tools: tools.tools.length };
  } catch (e) { return { index, connected: false, error: e.message, diagnostic: stderr.trim() }; }
  finally { await client.close(); }
}));
console.log(JSON.stringify({ mode, results, startup_failures: results.filter(r => !r.connected).length, created_orders: 0, payments: 0 }, null, 2));
if (results.some(r => !r.connected)) process.exitCode = 1;
