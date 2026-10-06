import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { loadSnapshots } from '../src/snapshot.js';
import { buildGateReport } from '../public/core/gate.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const labRoot = join(root, 'public/labs/frr');
const out = join(root, 'emulation/expected');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const checkOnly = process.argv[2] === '--check';
if (process.argv.length > (checkOnly ? 3 : 2)) {
  console.error('Usage: node scripts/export-emulation-reports.js [--check]');
  process.exit(1);
}

async function configFingerprints(lab, candidateDirectory) {
  const base = join(labRoot, 'baseline');
  const configSha256 = {};
  for (const node of lab.nodes) {
    let bytes;
    try { bytes = await readFile(join(candidateDirectory, `${node.id}.conf`)); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      bytes = await readFile(join(base, `${node.id}.conf`));
    }
    configSha256[node.id] = sha256(bytes);
  }
  return configSha256;
}

await mkdir(out, { recursive: true });
for (const [name, directory] of [
  ['baseline', join(labRoot, 'baseline')],
  ['route-leak', join(labRoot, 'candidates/route-leak')],
  ['safe-reroute', join(labRoot, 'candidates/safe-reroute')]
]) {
  const snapshots = await loadSnapshots(join(labRoot, 'lab.json'), join(labRoot, 'baseline'), directory);
  const report = buildGateReport(snapshots, 'human');
  const document = {
    generatedBy: 'PathPilot deterministic model',
    scenario: name,
    labSha256: sha256(await readFile(join(labRoot, 'lab.json'))),
    configSha256: await configFingerprints(snapshots.lab, directory),
    predicted: {
      decision: report.decision,
      regressions: report.regressions,
      intents: report.intents.map(({ id, expectation, baselinePass, candidatePass, candidateStatus, path, returnStatus, returnPath }) =>
        ({ id, expectation, baselinePass, candidatePass, candidateStatus, path, returnStatus, returnPath }))
    }
  };
  const path = join(out, `${name}.json`);
  const body = JSON.stringify(document, null, 2) + '\n';
  if (checkOnly) {
    if (await readFile(path, 'utf8') !== body) throw new Error(`${name}: stale model prediction; run npm run emulation:expected`);
  } else {
    await writeFile(path, body);
  }
  console.log(`${name}: ${report.decision}${checkOnly ? ' (current)' : ''}`);
}
