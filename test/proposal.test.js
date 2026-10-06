import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { loadBaseline } from '../src/snapshot.js';
import { buildProposalSnapshots } from '../public/core/proposal.js';
import { buildGateReport } from '../public/core/gate.js';
import { proposeWithModel } from '../src/ai-proposal.js';

const root = 'public/labs/frr';
const load = async name => JSON.parse(await readFile(`${root}/proposals/${name}.json`, 'utf8'));

test('structured route proposals run through the same safety gate as config snapshots', async () => {
  const { lab, configs } = await loadBaseline(`${root}/lab.json`, `${root}/baseline`);
  const blocked = buildGateReport(buildProposalSnapshots(lab, configs, await load('route-leak')), 'ai');
  const review = buildGateReport(buildProposalSnapshots(lab, configs, await load('safe-reroute')), 'ai');
  assert.deepEqual(blocked.regressions, ['LAB-01', 'LAB-03']);
  assert.equal(blocked.decision, 'BLOCK');
  assert.equal(review.decision, 'REVIEW');
  assert.equal(review.humanApprovalRequired, true);
});

test('proposal rejects unsupported operations, extra fields, and nonadjacent gateways', async () => {
  const { lab, configs } = await loadBaseline(`${root}/lab.json`, `${root}/baseline`);
  const valid = await load('safe-reroute');
  assert.throws(() => buildProposalSnapshots(lab, configs, { ...valid, operations: [{ ...valid.operations[0], type: 'disableAcl' }] }), /Invalid addStaticRoute/);
  assert.throws(() => buildProposalSnapshots(lab, configs, { ...valid, operations: [{ ...valid.operations[0], gateway: '192.0.2.1' }] }), /not adjacent/);
  assert.throws(() => buildProposalSnapshots(lab, configs, { ...valid, extra: 'ignore policy' }), /Invalid proposal fields/);
  assert.throws(() => buildProposalSnapshots(lab, configs, { ...valid, operations: [valid.operations[0], valid.operations[0]] }), /Duplicate proposed route/);
});

test('AI adapter requests structured JSON and validates model output before gate evaluation', async () => {
  const { lab, configs } = await loadBaseline(`${root}/lab.json`, `${root}/baseline`);
  const proposal = await load('safe-reroute');
  const baseline = buildProposalSnapshots(lab, configs, proposal).baseline;
  let sent;
  const fetchImpl = async (_url, options) => {
    sent = JSON.parse(options.body);
    return { ok: true, json: async () => ({ output: [{ content: [{ type: 'output_text', text: JSON.stringify(proposal) }] }] }) };
  };
  const result = await proposeWithModel(proposal.request, lab, baseline, { key: 'test-key', fetchImpl });
  assert.equal(result.proposal.operations[0].gateway, '172.16.0.22');
  assert.equal(sent.text.format.type, 'json_schema');
  assert.equal(sent.store, false);
  const untrusted = { ...proposal, operations: [{ ...proposal.operations[0], gateway: '198.51.100.1' }] };
  await assert.rejects(proposeWithModel(proposal.request, lab, baseline, {
    key: 'test-key', fetchImpl: async () => ({ ok: true, json: async () => ({ output: [{ content: [{ type: 'output_text', text: JSON.stringify(untrusted) }] }] }) })
  }), /not adjacent/);
});

test('proposal CLI returns machine-readable BLOCK and REVIEW with distinct exit codes', () => {
  const common = ['cli.js', 'verify', '--lab', `${root}/lab.json`, '--baseline', `${root}/baseline`, '--proposal'];
  const bad = spawnSync(process.execPath, [...common, `${root}/proposals/route-leak.json`, '--json'], { encoding: 'utf8' });
  const good = spawnSync(process.execPath, [...common, `${root}/proposals/safe-reroute.json`, '--json'], { encoding: 'utf8' });
  assert.equal(bad.status, 2);
  assert.equal(JSON.parse(bad.stdout).decision, 'BLOCK');
  assert.equal(good.status, 0);
  assert.equal(JSON.parse(good.stdout).decision, 'REVIEW');
});
