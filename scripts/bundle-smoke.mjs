import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const transport = new StdioClientTransport({ command: process.execPath, args: [join(root, 'dist/index.mjs')], env: { ...process.env, MZMALL_ENABLE_PURCHASES: '0', MZMALL_DATA_DIR: mkdtempSync(join(tmpdir(), 'mzmall-bundle-smoke-')) }, stderr: 'pipe' });
const client = new Client({ name: 'bundle-review', version: '1' });
try {
  await client.connect(transport);
  const tools = await client.listTools();
  if (tools.tools.length !== 10) throw new Error('Unexpected tool inventory');
  const r = await client.callTool({ name: 'search_esim_plans', arguments: { country_code: 'TH', page: 1 } });
  if (r.isError || !(r.structuredContent?.products?.length > 0)) throw new Error('Bundled live catalog query failed');
  const disabled = await client.callTool({ name: 'prepare_esim_purchase', arguments: { product_id: 2177, quantity: 1, email: 'not-sent@example.test', max_total_mmk: 2340, request_id: 'disabled-smoke-0001' } });
  if (!disabled.isError || !disabled.content[0].text.includes('not enabled')) throw new Error('Purchase gate failed');
  console.log(JSON.stringify({ bundled_runtime: true, tools: tools.tools.map(t => t.name), live_products_on_page: r.structuredContent.products.length, purchase_gate_verified: true, created_orders: 0, payments: 0 }));
} finally { await client.close(); }
