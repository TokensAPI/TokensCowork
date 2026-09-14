// Stage the market backend without modifying its source tree or secrets.
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, relative, sep, basename } from 'node:path';
import { patchRegistryRoutes } from './market-routing-overlay.mjs';
import { buildProductComponents } from '../../../scripts/generate-market-catalog.mjs';
const root = resolve(import.meta.dirname, '../../..');
const output = resolve(process.argv[2] || resolve(root, '.build/market-routing-stage'));
const inside = relative(resolve(root, '.build'), output);
if (!inside || inside.startsWith('..') || resolve(root, '.build', inside) !== output) throw new Error('Output must be a new directory under .build');
await mkdir(output); // Fail rather than overwrite another staged deployment.
const source = resolve(root, 'market/server');
await cp(source, output, { recursive: true, filter: path => {
  const name = basename(path);
  if (['node_modules', '.git'].includes(name) || name.startsWith('.env') || name.endsWith('.tgz')) return false;
  if (relative(source, path).split(sep).length === 1 && name.endsWith('.sql')) return false;
  return true;
} });
const routes = resolve(output, 'private-registry/routes.js');
await writeFile(routes, patchRegistryRoutes(await readFile(routes, 'utf8')));
const product = JSON.parse(await readFile(resolve(root, 'product.json'), 'utf8'));
await writeFile(resolve(output, 'product-components.json'), JSON.stringify(buildProductComponents(product), null, 2));
console.log(`Prepared market routing deployment: ${output}`);
