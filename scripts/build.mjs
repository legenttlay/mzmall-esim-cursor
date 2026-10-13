import { build } from 'esbuild';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
await mkdir(join(root, 'dist'), { recursive: true });
const built = await build({ entryPoints: [join(root, 'server/main.mjs')], outfile: join(root, 'dist/index.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node24', metafile: true, banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } });
const packages = new Set();
for (const input of Object.keys(built.metafile.inputs)) {
  const parts = input.replaceAll('\\', '/').split('/'), i = parts.lastIndexOf('node_modules');
  if (i >= 0) packages.add(parts[i + 1].startsWith('@') ? parts.slice(i + 1, i + 3).join('/') : parts[i + 1]);
}
let notices = '# Bundled third-party licenses\n\n';
for (const name of [...packages].sort()) {
  const directory = join(root, 'node_modules', name), pkg = JSON.parse(await readFile(join(directory, 'package.json')));
  notices += `## ${name} ${pkg.version} (${pkg.license ?? 'see upstream license'})\n\n`;
  for (const file of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license', 'license.md']) {
    try { notices += (await readFile(join(directory, file), 'utf8')) + '\n\n'; break; } catch {}
  }
}
await writeFile(join(root, 'THIRD-PARTY-NOTICES.md'), notices);
const publicRoot = join(root, 'artifacts/public-repository');
await mkdir(publicRoot, { recursive: true });
const paths = ['.cursor-plugin', 'mcp.json', 'assets', 'skills', 'dist', 'server', 'tests', 'scripts', 'package.json', 'package-lock.json', '.gitignore', 'README.md', 'LICENSE', 'THIRD-PARTY-NOTICES.md', 'REVIEW.md', 'NEXT-STEPS.zh-CN.md'];
for (const p of paths) await cp(join(root, p), join(publicRoot, p), { recursive: true });
const manifest = JSON.parse(await readFile(join(publicRoot, '.cursor-plugin/plugin.json')));
await writeFile(join(root, 'artifacts/build-receipt.json'), JSON.stringify({ version: manifest.version, source: root, public_repository: publicRoot, purchases_enabled: false, hosted_endpoint: null, marketplace_submitted: false, built_at: new Date().toISOString() }, null, 2));
console.log(JSON.stringify({ public_repository: publicRoot, version: manifest.version, purchases_enabled: false }));
