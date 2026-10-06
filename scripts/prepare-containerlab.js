import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const labRoot = join(root, 'public/labs/frr');
const runtimeRoot = join(root, 'emulation/containerlab/runtime');
const choices = new Set(['baseline', 'route-leak', 'safe-reroute']);
const scenario = process.argv[2] || 'baseline';
if (!choices.has(scenario) || process.argv.length > 3) {
  console.error('Usage: npm run emulation:prepare -- baseline|route-leak|safe-reroute');
  process.exit(1);
}

const manifestBytes = await readFile(join(labRoot, 'lab.json'));
const lab = JSON.parse(manifestBytes);
const output = join(runtimeRoot, scenario);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const quote = value => JSON.stringify(value);
const configs = {};
await mkdir(output, { recursive: true });

for (const node of lab.nodes) {
  const candidate = join(labRoot, 'candidates', scenario, `${node.id}.conf`);
  let bytes;
  try { bytes = await readFile(candidate); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    bytes = await readFile(join(labRoot, 'baseline', `${node.id}.conf`));
  }
  configs[node.id] = sha256(bytes);
  const nodeDir = join(output, node.id);
  await mkdir(nodeDir, { recursive: true });
  await writeFile(join(nodeDir, 'frr.conf'), bytes);
  await writeFile(join(nodeDir, 'daemons'), 'zebra=yes\nstaticd=yes\n');
}

const lines = [
  `name: pathpilot-${scenario}`,
  'topology:',
  '  defaults:',
  '    kind: linux',
  '    image: quay.io/frrouting/frr:10.0.1',
  '    network-mode: none',
  '    sysctls:',
  '      net.ipv4.ip_forward: 1',
  '      net.ipv4.conf.all.rp_filter: 0',
  '      net.ipv4.conf.default.rp_filter: 0',
  '  nodes:'
];
for (const node of lab.nodes) {
  lines.push(
    `    ${node.id}:`,
    '      binds:',
    `        - ${quote(`${node.id}/frr.conf:/etc/frr/frr.conf:ro`)}`,
    `        - ${quote(`${node.id}/daemons:/etc/frr/daemons:ro`)}`
  );
}
lines.push('  links:');
for (const link of lab.links) {
  lines.push(`    - endpoints: [${quote(`${link.a.node}:${link.a.iface}`)}, ${quote(`${link.b.node}:${link.b.iface}`)}]`);
}
await writeFile(join(output, 'pathpilot.clab.yml'), lines.join('\n') + '\n');
await writeFile(join(output, 'source.json'), JSON.stringify({
  scenario,
  labSha256: sha256(manifestBytes),
  configSha256: configs,
  image: 'quay.io/frrouting/frr:10.0.1'
}, null, 2) + '\n');
console.log(`Prepared ${lab.nodes.length} FRRouting nodes and ${lab.links.length} links: ${output}`);
