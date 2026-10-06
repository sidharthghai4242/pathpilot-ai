import { analyzeModels } from './engine.js';

function routeKey(route) { return `${route.prefix} via ${route.via} distance ${route.metric}`; }

export function buildGateReport({ lab, baseline, candidate, changedConfigNodes }, provenance = 'unknown') {
  if (!['ai', 'human', 'unknown'].includes(provenance)) throw new Error('Provenance must be ai, human, or unknown');
  const result = analyzeModels(baseline, candidate, lab.intents, {
    id: 'frr-snapshot-compare', name: 'FRRouting snapshot comparison', category: 'Pre-change verification', provenance
  });
  const routeDiff = [];
  for (const node of candidate.nodes) {
    const prior = baseline.nodes.find(item => item.id === node.id);
    const priorKeys = new Set(prior.routes.map(routeKey));
    const candidateKeys = new Set(node.routes.map(routeKey));
    const added = [...candidateKeys].filter(key => !priorKeys.has(key));
    const removed = [...priorKeys].filter(key => !candidateKeys.has(key));
    if (added.length || removed.length) routeDiff.push({ node: node.id, added, removed });
  }
  return {
    schemaVersion: 1, lab: lab.name,
    scope: 'FRRouting static IPv4 subset; declared stateless deny policies; selected allow intents check return-route reachability',
    provenance, verdict: result.verdict, decision: result.verdict === 'BLOCK' ? 'BLOCK' : 'REVIEW',
    humanApprovalRequired: true, summary: result.summary, changedConfigNodes, routeDiff,
    regressions: result.regressions, criticalViolations: result.criticalViolations,
    intents: result.after.map((after, index) => ({
      id: after.id, name: after.name, expectation: after.expectation, tier: after.tier,
      baselinePass: result.before[index].pass, candidatePass: after.pass,
      baselineStatus: result.before[index].trace.status, candidateStatus: after.trace.status,
      finding: after.finding, path: after.trace.path, hops: after.trace.hops,
      returnStatus: after.returnTrace?.status ?? null, returnPath: after.returnTrace?.path ?? null,
      latencyMs: after.trace.latencyMs
    })),
    singleLinkFailureImpact: result.failureMatrix
  };
}
