#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { loadSnapshots, loadBaseline } from './src/snapshot.js';
import { buildGateReport } from './src/gate.js';
import { buildProposalSnapshots } from './public/core/proposal.js';

function usage() {
  return 'Usage: node cli.js verify --lab LAB.json --baseline DIR (--candidate DIR | --proposal FILE.json) [--provenance ai|human|unknown] [--json] [--out FILE]';
}

function parseArgs(args) {
  if (args[0] !== 'verify') throw new Error(usage());
  const options = { provenance: 'unknown', json: false };
  for (let i = 1; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--json') { options.json = true; continue; }
    if (!['--lab', '--baseline', '--candidate', '--proposal', '--provenance', '--out'].includes(flag) || !args[i + 1]) throw new Error(usage());
    options[flag.slice(2)] = args[++i];
  }
  if (!options.lab || !options.baseline || Boolean(options.candidate) === Boolean(options.proposal)) throw new Error(usage());
  return options;
}

export async function run(args, output = process.stdout, errors = process.stderr) {
  try {
    const options = parseArgs(args);
    let snapshots;
    if (options.proposal) {
      const { lab, configs } = await loadBaseline(options.lab, options.baseline);
      const proposal = JSON.parse(await readFile(options.proposal, 'utf8'));
      snapshots = buildProposalSnapshots(lab, configs, proposal);
    } else snapshots = await loadSnapshots(options.lab, options.baseline, options.candidate);
    if (!snapshots.changedConfigNodes.length) throw new Error('Candidate contains no changed FRRouting configs');
    const report = buildGateReport(snapshots, options.provenance);
    const json = JSON.stringify(report, null, 2) + '\n';
    if (options.out) await writeFile(options.out, json, 'utf8');
    if (options.json) output.write(json);
    else output.write(`${report.decision}: ${report.summary}\nChanged configs: ${report.changedConfigNodes.join(', ') || 'none'}\nHuman approval required: yes\n`);
    return report.verdict === 'BLOCK' ? 2 : 0;
  } catch (error) {
    errors.write(`${error.message}\n`);
    return 1;
  }
}

if (process.argv[1] && process.argv[1].replaceAll('\\', '/').endsWith('/cli.js')) {
  process.exitCode = await run(process.argv.slice(2));
}
