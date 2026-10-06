import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { parseFrrConfig, compileFrrSnapshot } from '../public/core/frr.js';
import { loadSnapshots } from '../src/snapshot.js';
import { buildGateReport } from '../src/gate.js';

const root = 'public/labs/frr';

test('FRRouting importer compiles the baseline and resolves gateway addresses to adjacent nodes', async () => {
  const snapshots = await loadSnapshots(`${root}/lab.json`, `${root}/baseline`, `${root}/baseline`);
  const edge = snapshots.baseline.nodes.find(node => node.id === 'edge');
  assert.deepEqual(edge.routes.find(route => route.prefix === '10.20.0.0/24'), { prefix: '10.20.0.0/24', via: 'core', metric: 10 });
  assert.equal(snapshots.baseline.nodes.length, 6);
  assert.deepEqual(snapshots.changedConfigNodes, []);
});

test('AI-originated route leak is blocked with a reproducible route diff', async () => {
  const snapshots = await loadSnapshots(`${root}/lab.json`, `${root}/baseline`, `${root}/candidates/route-leak`);
  const report = buildGateReport(snapshots, 'ai');
  assert.equal(report.decision, 'BLOCK');
  assert.equal(report.humanApprovalRequired, true);
  assert.deepEqual(report.regressions, ['LAB-01', 'LAB-03']);
  assert.deepEqual(report.changedConfigNodes, ['edge']);
  assert.match(report.routeDiff[0].added.join(' '), /10\.20\.0\.0\/24 via internet distance 5/);
  assert.equal(report.intents[0].candidateStatus, 'LOOP');
});

test('safe route is reviewable, with no automatic deployment approval', async () => {
  const snapshots = await loadSnapshots(`${root}/lab.json`, `${root}/baseline`, `${root}/candidates/safe-reroute`);
  const report = buildGateReport(snapshots, 'ai');
  assert.equal(report.verdict, 'PASS');
  assert.equal(report.decision, 'REVIEW');
  assert.equal(report.humanApprovalRequired, true);
  assert.deepEqual(report.regressions, []);
  assert.deepEqual(report.intents[0].path, ['branch', 'edge', 'app']);
  assert.deepEqual(report.singleLinkFailureImpact.find(item => item.linkId === 'edge-app-backup').lostIntents, []);
});

test('bidirectional intent blocks a route change that loses only the return path', async () => {
  const manifest = JSON.parse(await readFile(`${root}/lab.json`, 'utf8'));
  const configs = Object.fromEntries(await Promise.all(manifest.nodes.map(async node => [node.id, await readFile(`${root}/baseline/${node.id}.conf`, 'utf8')])));
  const candidateConfigs = { ...configs, edge: configs.edge.replace('ip route 10.10.1.0/24 172.16.0.1 10\n', '') };
  const report = buildGateReport({ lab: manifest, baseline: compileFrrSnapshot(manifest, configs),
    candidate: compileFrrSnapshot(manifest, candidateConfigs), changedConfigNodes: ['edge'] }, 'human');
  assert.equal(report.decision, 'BLOCK');
  assert.equal(report.intents.find(item => item.id === 'LAB-01').candidateStatus, 'DELIVERED');
  assert.equal(report.intents.find(item => item.id === 'LAB-01').returnStatus, 'LOOP');
  assert.match(report.intents.find(item => item.id === 'LAB-01').finding, /Return path failed/);
});

test('unsupported routing features fail closed instead of disappearing from the model', async () => {
  const text = await readFile(`${root}/baseline/edge.conf`, 'utf8');
  assert.throws(() => parseFrrConfig(`${text}\nrouter bgp 65000\n`, 'edge.conf'), /unsupported command/);
  assert.throws(() => parseFrrConfig(`${text}\nipv6 route 2001:db8::\/32 2001:db8::1\n`, 'edge.conf'), /unsupported command/);
  assert.throws(() => parseFrrConfig(`${text}\nip route 10.99.0.0\/16 blackhole\n`, 'edge.conf'), /unsupported command/);
});

test('unknown next hop, duplicate ECMP, and inconsistent interface addressing fail closed', async () => {
  const manifest = JSON.parse(await readFile(`${root}/lab.json`, 'utf8'));
  const configs = Object.fromEntries(await Promise.all(manifest.nodes.map(async node => [node.id, await readFile(`${root}/baseline/${node.id}.conf`, 'utf8')])));
  const unknownGateway = { ...configs, edge: configs.edge.replace('172.16.0.6 10', '172.16.0.99 10') };
  assert.throws(() => compileFrrSnapshot(manifest, unknownGateway), /not an adjacent interface/);
  const ecmp = { ...configs, edge: configs.edge.replace('ip route 10.20.0.0/24 172.16.0.6 10', 'ip route 10.20.0.0/24 172.16.0.6 10\nip route 10.20.0.0/24 172.16.0.22 10') };
  assert.throws(() => compileFrrSnapshot(manifest, ecmp), /ECMP route/);
  const badLink = { ...configs, edge: configs.edge.replace('ip address 172.16.0.5/30', 'ip address 172.16.0.50/30') };
  assert.throws(() => compileFrrSnapshot(manifest, badLink), /undeclared interface or address/);
  const extraAddress = { ...configs, edge: configs.edge.replace('ip address 172.16.0.5/30', 'ip address 172.16.0.5/30\n ip address 172.16.9.1/24') };
  assert.throws(() => compileFrrSnapshot(manifest, extraAddress), /undeclared interface or address/);
  const extraInterface = { ...configs, edge: `${configs.edge}\ninterface eth9\n ip address 10.99.0.1/24\n!\n` };
  assert.throws(() => compileFrrSnapshot(manifest, extraInterface), /undeclared interface or address/);
});

test('CLI exit codes distinguish blocked changes from input errors and reviewable changes', () => {
  const common = ['cli.js', 'verify', '--lab', `${root}/lab.json`, '--baseline', `${root}/baseline`, '--candidate'];
  const blocked = spawnSync(process.execPath, [...common, `${root}/candidates/route-leak`, '--json'], { encoding: 'utf8' });
  assert.equal(blocked.status, 2);
  assert.equal(JSON.parse(blocked.stdout).decision, 'BLOCK');
  const safe = spawnSync(process.execPath, [...common, `${root}/candidates/safe-reroute`, '--json'], { encoding: 'utf8' });
  assert.equal(safe.status, 0);
  assert.equal(JSON.parse(safe.stdout).decision, 'REVIEW');
  const invalid = spawnSync(process.execPath, ['cli.js', 'verify', '--lab', 'missing.json', '--baseline', '.', '--candidate', '.'], { encoding: 'utf8' });
  assert.equal(invalid.status, 1);
});
