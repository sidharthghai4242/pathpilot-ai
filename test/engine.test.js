import test from 'node:test';
import assert from 'node:assert/strict';
import { topology, intents } from '../public/core/topology.js';
import { matchesCidr, validateTopology, traceFlow, evaluateIntent, applyChanges, analyzeScenario, analyzeFailureMatrix, evidenceForAI } from '../public/core/engine.js';

test('IPv4 longest-prefix matching and input validation', () => {
  assert.equal(matchesCidr('10.20.0.10', '10.20.0.0/24'), true);
  assert.equal(matchesCidr('10.21.0.10', '10.20.0.0/24'), false);
  assert.equal(matchesCidr('10.21.0.10', '0.0.0.0/0'), true);
  assert.throws(() => matchesCidr('10.20.0.10', '10.20.0.0/33'));
  assert.throws(() => matchesCidr('999.20.0.10', '10.20.0.0/24'));
  assert.equal(validateTopology(topology), true);
});

test('baseline preserves all reachability and isolation intents', () => {
  const results = intents.map(intent => evaluateIntent(topology, intent));
  assert.ok(results.every(result => result.pass));
  assert.deepEqual(results[0].trace.path, ['branch', 'edge', 'core', 'app']);
  assert.equal(results[0].trace.latencyMs, 12);
  assert.equal(results[3].trace.status, 'DENIED');
  assert.match(results[3].trace.reason, /deny-external-db/);
});

test('route leak produces a loop and blocks two business intents', () => {
  const analysis = analyzeScenario('route-leak');
  assert.equal(analysis.verdict, 'BLOCK');
  assert.deepEqual(analysis.regressions, ['INT-01', 'INT-03']);
  assert.equal(analysis.after[0].trace.status, 'LOOP');
  assert.equal(analysis.after[1].pass, true);
});

test('removing border ACL exposes database while other intents stay valid', () => {
  const analysis = analyzeScenario('policy-drift');
  assert.deepEqual(analysis.regressions, ['INT-04']);
  assert.deepEqual(analysis.after[3].trace.path, ['internet', 'edge', 'core', 'db']);
  assert.equal(analysis.after[3].trace.status, 'DELIVERED');
  assert.equal(analysis.criticalViolations, 1);
});

test('failed uplink blocks expected service paths', () => {
  const analysis = analyzeScenario('link-outage');
  assert.deepEqual(analysis.regressions, ['INT-01', 'INT-02', 'INT-03']);
  assert.equal(analysis.after[0].trace.status, 'LINK_DOWN');
});

test('backup route is selected only when its physical link is active', () => {
  const analysis = analyzeScenario('safe-reroute');
  assert.equal(analysis.verdict, 'PASS');
  assert.deepEqual(analysis.after[0].trace.path, ['branch', 'edge', 'app']);
  assert.equal(analysis.after[0].trace.latencyMs, 14);
  assert.equal(topology.links.find(link => link.id === 'edge-app-backup').up, false, 'baseline is immutable');
});

test('N-1 matrix exposes single points of failure and detects backup failover', () => {
  const baseline = analyzeFailureMatrix(topology);
  assert.deepEqual(baseline.find(item => item.linkId === 'core-app').lostIntents, ['INT-01', 'INT-02', 'INT-03']);
  const rerouted = analyzeScenario('safe-reroute').failureMatrix;
  assert.deepEqual(rerouted.find(item => item.linkId === 'edge-app-backup').lostIntents, []);
  assert.deepEqual(rerouted.find(item => item.linkId === 'branch-edge').lostIntents, ['INT-01']);
});

test('the most specific prefix wins even if a default route has lower metric', () => {
  const candidate = applyChanges(topology, [{ type: 'upsertRoute', node: 'edge', prefix: '0.0.0.0/0', via: 'internet', metric: 0 }]);
  assert.deepEqual(traceFlow(candidate, intents[0]).path, ['branch', 'edge', 'core', 'app']);
});

test('invalid or nonadjacent changes are rejected', () => {
  assert.throws(() => applyChanges(topology, [{ type: 'upsertRoute', node: 'branch', prefix: '10.20.0.0/24', via: 'db', metric: 1 }]), /Invalid route/);
  assert.throws(() => applyChanges(topology, [{ type: 'setLinkState', link: 'missing', up: false }]), /Invalid link change/);
  assert.throws(() => analyzeScenario('missing'), /Unknown scenario/);
});

test('AI evidence contains verdict and trace IDs, with no secret configuration', () => {
  const evidence = evidenceForAI(analyzeScenario('route-leak'));
  assert.equal(evidence.verdict, 'BLOCK');
  assert.equal(evidence.intents[0].id, 'INT-01');
  assert.equal(evidence.intents[0].trace.status, 'LOOP');
  assert.equal(JSON.stringify(evidence).includes('OPENAI_API_KEY'), false);
});
