import { matchesCidr } from './engine.js';
import { compileFrrSnapshot } from './frr.js';

function exactKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !allowed.includes(key))) throw new Error(`Invalid ${label} fields`);
}

export function validateProposal(proposal, manifest) {
  exactKeys(proposal, ['request', 'operations'], 'proposal');
  if (typeof proposal.request !== 'string' || proposal.request.length < 5 || proposal.request.length > 500) {
    throw new Error('Proposal request must be 5-500 characters');
  }
  if (!Array.isArray(proposal.operations) || proposal.operations.length < 1 || proposal.operations.length > 3) {
    throw new Error('Proposal must contain 1-3 route operations');
  }
  const seen = new Set();
  for (const operation of proposal.operations) {
    exactKeys(operation, ['type', 'node', 'prefix', 'gateway', 'distance', 'reason'], 'route operation');
    if (operation.type !== 'addStaticRoute' || !manifest.nodes.some(node => node.id === operation.node)
      || typeof operation.prefix !== 'string' || typeof operation.gateway !== 'string'
      || !Number.isInteger(operation.distance) || operation.distance < 1 || operation.distance > 255
      || typeof operation.reason !== 'string' || operation.reason.length < 5 || operation.reason.length > 300) {
      throw new Error('Invalid addStaticRoute operation');
    }
    matchesCidr(operation.gateway, operation.prefix);
    const adjacent = manifest.links.some(link =>
      (link.a.node === operation.node && link.b.ip.split('/')[0] === operation.gateway)
      || (link.b.node === operation.node && link.a.ip.split('/')[0] === operation.gateway));
    if (!adjacent) throw new Error(`${operation.node}: gateway ${operation.gateway} is not adjacent`);
    const key = `${operation.node}|${operation.prefix}|${operation.gateway}`;
    if (seen.has(key)) throw new Error(`Duplicate proposed route ${key}`);
    seen.add(key);
  }
  return proposal;
}

export function buildProposalSnapshots(manifest, baselineConfigs, proposal) {
  validateProposal(proposal, manifest);
  const baseline = compileFrrSnapshot(manifest, baselineConfigs);
  const candidateConfigs = { ...baselineConfigs };
  for (const operation of proposal.operations) {
    const config = candidateConfigs[operation.node];
    const line = `ip route ${operation.prefix} ${operation.gateway} ${operation.distance}`;
    if (config.split(/\r?\n/).some(item => item.trim() === line)) {
      throw new Error(`Route already present on ${operation.node}: ${line}`);
    }
    candidateConfigs[operation.node] = `${config.trimEnd()}\n${line}\n`;
  }
  return {
    lab: manifest, baseline, candidate: compileFrrSnapshot(manifest, candidateConfigs),
    candidateConfigs, changedConfigNodes: [...new Set(proposal.operations.map(item => item.node))]
  };
}
