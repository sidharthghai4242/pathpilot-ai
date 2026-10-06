import { topology, intents, scenarios } from './topology.js';

function ipv4Number(value) {
  const parts = value.split('.');
  if (parts.length !== 4 || parts.some(part => !/^\d{1,3}$/.test(part) || Number(part) > 255)) {
    throw new Error(`Invalid IPv4 address: ${value}`);
  }
  return parts.reduce((result, part) => ((result << 8) | Number(part)) >>> 0, 0);
}

export function matchesCidr(ip, cidr) {
  const [network, length, extra] = cidr.split('/');
  const bits = Number(length);
  if (extra !== undefined || !Number.isInteger(bits) || bits < 0 || bits > 32) {
    throw new Error(`Invalid CIDR prefix: ${cidr}`);
  }
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipv4Number(ip) & mask) === (ipv4Number(network) & mask);
}

function prefixLength(prefix) {
  return Number(prefix.split('/')[1]);
}

function adjacentLink(model, from, to) {
  return model.links.find(link => (link.a === from && link.b === to) || (link.b === from && link.a === to));
}

export function validateTopology(model) {
  if (!model || !Array.isArray(model.nodes) || !Array.isArray(model.links)) throw new Error('Invalid topology');
  const ids = new Set();
  for (const node of model.nodes) {
    if (!node.id || ids.has(node.id)) throw new Error(`Duplicate or missing node: ${node.id}`);
    ids.add(node.id);
    ipv4Number(node.ip);
  }
  const linkIds = new Set();
  for (const link of model.links) {
    if (!link.id || linkIds.has(link.id) || !ids.has(link.a) || !ids.has(link.b) || link.a === link.b) {
      throw new Error(`Invalid link: ${link.id}`);
    }
    if (!Number.isFinite(link.latencyMs) || link.latencyMs < 0 || !Number.isFinite(link.capacityMbps) || link.capacityMbps <= 0) {
      throw new Error(`Invalid link metrics: ${link.id}`);
    }
    linkIds.add(link.id);
  }
  for (const node of model.nodes) {
    for (const route of node.routes ?? []) {
      matchesCidr(node.ip, route.prefix);
      if (!ids.has(route.via) || !adjacentLink(model, node.id, route.via) || !Number.isFinite(route.metric)) {
        throw new Error(`Invalid route on ${node.id}: ${route.prefix} via ${route.via}`);
      }
    }
    for (const acl of node.acls ?? []) {
      matchesCidr(node.ip, acl.source);
      matchesCidr(node.ip, acl.destination);
      if (!['allow', 'deny'].includes(acl.action) || !['tcp', 'udp', 'any'].includes(acl.protocol)) {
        throw new Error(`Invalid ACL: ${acl.id}`);
      }
    }
  }
  return true;
}

export function applyChanges(base, changes) {
  const candidate = structuredClone(base);
  for (const change of changes) {
    if (change.type === 'setLinkState') {
      const link = candidate.links.find(item => item.id === change.link);
      if (!link || typeof change.up !== 'boolean') throw new Error('Invalid link change');
      link.up = change.up;
    } else if (change.type === 'setAclEnabled') {
      const node = candidate.nodes.find(item => item.id === change.node);
      const acl = node?.acls?.find(item => item.id === change.acl);
      if (!acl || typeof change.enabled !== 'boolean') throw new Error('Invalid ACL change');
      acl.enabled = change.enabled;
    } else if (change.type === 'upsertRoute') {
      const node = candidate.nodes.find(item => item.id === change.node);
      if (!node || typeof change.metric !== 'number') throw new Error('Invalid route change');
      const existing = node.routes.find(item => item.prefix === change.prefix && item.via === change.via);
      if (existing) existing.metric = change.metric;
      else node.routes.push({ prefix: change.prefix, via: change.via, metric: change.metric });
    } else {
      throw new Error(`Unsupported change type: ${change.type}`);
    }
  }
  validateTopology(candidate);
  return candidate;
}

export function traceFlow(model, flow, { skipAcl = false } = {}) {
  const source = model.nodes.find(node => node.id === flow.source);
  const destination = model.nodes.find(node => node.id === flow.destination);
  if (!source || !destination) throw new Error('Unknown flow endpoint');
  const path = [];
  const hops = [];
  const seen = new Set();
  let current = source;
  let latencyMs = 0;
  let bottleneckMbps = null;
  const finish = (status, reason) => ({ status, reason, path, hops, latencyMs, bottleneckMbps });

  for (let ttl = 0; ttl < 16; ttl++) {
    path.push(current.id);
    if (seen.has(current.id)) return finish('LOOP', `Forwarding loop detected at ${current.label}`);
    seen.add(current.id);
    const blockingAcl = !skipAcl && (current.acls ?? []).find(acl => acl.enabled && acl.action === 'deny'
      && matchesCidr(source.ip, acl.source) && matchesCidr(destination.ip, acl.destination)
      && (acl.protocol === 'any' || acl.protocol === flow.protocol)
      && (acl.port === 'any' || acl.port === flow.port));
    if (blockingAcl) {
      hops.push({ node: current.id, decision: `ACL ${blockingAcl.id} denied ${flow.protocol}/${flow.port}` });
      return finish('DENIED', `Blocked by ${blockingAcl.id} on ${current.label}`);
    }
    if (current.id === destination.id) {
      hops.push({ node: current.id, decision: 'Delivered to destination' });
      return finish('DELIVERED', `Delivered in ${latencyMs} ms`);
    }
    const routes = (current.routes ?? [])
      .filter(route => matchesCidr(destination.ip, route.prefix))
      .sort((a, b) => prefixLength(b.prefix) - prefixLength(a.prefix) || a.metric - b.metric || a.via.localeCompare(b.via));
    if (!routes.length) {
      hops.push({ node: current.id, decision: 'No matching route' });
      return finish('NO_ROUTE', `No route to ${destination.ip} on ${current.label}`);
    }
    // A failed physical link does not make a less-specific route eligible: forwarding
    // stays within the best prefix. An equal-prefix backup route may be selected.
    const bestLength = prefixLength(routes[0].prefix);
    const eligible = routes.filter(route => prefixLength(route.prefix) === bestLength);
    const route = eligible.find(item => adjacentLink(model, current.id, item.via)?.up);
    if (!route) {
      hops.push({ node: current.id, decision: `All next hops for /${bestLength} are down` });
      return finish('LINK_DOWN', `No active next hop from ${current.label}`);
    }
    const link = adjacentLink(model, current.id, route.via);
    latencyMs += link.latencyMs;
    bottleneckMbps = bottleneckMbps === null ? link.capacityMbps : Math.min(bottleneckMbps, link.capacityMbps);
    hops.push({ node: current.id, decision: `LPM ${route.prefix} via ${route.via}`, link: link.id });
    current = model.nodes.find(node => node.id === route.via);
  }
  return finish('TTL_EXCEEDED', 'Exceeded 16-hop simulation limit');
}

export function evaluateIntent(model, intent) {
  const trace = traceFlow(model, intent);
  const reachable = trace.status === 'DELIVERED';
  // Return-path verification is routing-only. Stateful firewall and ephemeral
  // response-port semantics are intentionally outside this model.
  const returnTrace = intent.expectation === 'allow' && intent.bidirectional
    ? traceFlow(model, { ...intent, source: intent.destination, destination: intent.source }, { skipAcl: true })
    : null;
  const returnReachable = !returnTrace || returnTrace.status === 'DELIVERED';
  const pass = intent.expectation === 'deny'
    ? !reachable
    : reachable && returnReachable && (intent.maxLatencyMs === undefined || trace.latencyMs <= intent.maxLatencyMs);
  let finding;
  if (pass && intent.expectation === 'deny') finding = `Isolation preserved: ${trace.reason}`;
  else if (pass) finding = `Reachable in ${trace.latencyMs} ms via ${trace.path.join(' → ')}`;
  else if (intent.expectation === 'deny') finding = `Forbidden path became reachable via ${trace.path.join(' → ')}`;
  else if (reachable && !returnReachable) finding = `Return path failed: ${returnTrace.reason}`;
  else if (reachable) finding = `Latency ${trace.latencyMs} ms exceeds ${intent.maxLatencyMs} ms budget`;
  else finding = trace.reason;
  return { ...intent, pass, finding, trace, returnTrace };
}

export function analyzeFailureMatrix(model, policies = intents) {
  const current = policies.map(intent => evaluateIntent(model, intent));
  return model.links.filter(link => link.up).map(link => {
    const failed = applyChanges(model, [{ type: 'setLinkState', link: link.id, up: false }]);
    const lost = policies.map((intent, index) => ({ intent, before: current[index], after: evaluateIntent(failed, intent) }))
      .filter(item => item.before.pass && !item.after.pass);
    return {
      linkId: link.id,
      endpoints: [link.a, link.b],
      lostIntents: lost.map(item => item.intent.id),
      criticalLost: lost.filter(item => item.intent.tier === 'critical').length
    };
  }).sort((a, b) => b.criticalLost - a.criticalLost || b.lostIntents.length - a.lostIntents.length || a.linkId.localeCompare(b.linkId));
}

export function analyzeScenario(scenarioId) {
  const scenario = scenarios.find(item => item.id === scenarioId);
  if (!scenario) throw new Error('Unknown scenario');
  const candidate = applyChanges(topology, scenario.changes);
  return analyzeModels(topology, candidate, intents, {
    id: scenario.id, name: scenario.name, category: scenario.category,
    summary: scenario.summary, changes: scenario.changes
  });
}

export function analyzeModels(baseline, candidate, policies, scenario = { id: 'snapshot-compare', name: 'Snapshot comparison', category: 'Change verification' }) {
  validateTopology(baseline);
  validateTopology(candidate);
  if (!Array.isArray(policies) || policies.length === 0) throw new Error('At least one intent is required');
  const intentIds = new Set();
  for (const intent of policies) {
    if (!intent.id || intentIds.has(intent.id) || !['allow', 'deny'].includes(intent.expectation)
      || !['tcp', 'udp'].includes(intent.protocol) || !Number.isInteger(intent.port) || intent.port < 1 || intent.port > 65535
      || !baseline.nodes.some(node => node.id === intent.source) || !baseline.nodes.some(node => node.id === intent.destination)
      || !candidate.nodes.some(node => node.id === intent.source) || !candidate.nodes.some(node => node.id === intent.destination)
      || (intent.bidirectional !== undefined && typeof intent.bidirectional !== 'boolean')
      || (intent.maxLatencyMs !== undefined && (!Number.isFinite(intent.maxLatencyMs) || intent.maxLatencyMs < 0))) {
      throw new Error(`Invalid intent: ${intent.id}`);
    }
    intentIds.add(intent.id);
  }
  const before = policies.map(intent => evaluateIntent(baseline, intent));
  const after = policies.map(intent => evaluateIntent(candidate, intent));
  const regressions = after.filter((result, index) => before[index].pass && !result.pass);
  const improvements = after.filter((result, index) => !before[index].pass && result.pass);
  const violations = after.filter(result => !result.pass);
  return {
    scenario,
    before, after, candidate,
    failureMatrix: analyzeFailureMatrix(candidate, policies),
    regressions: regressions.map(item => item.id),
    improvements: improvements.map(item => item.id),
    verdict: violations.length ? 'BLOCK' : 'PASS',
    criticalViolations: violations.filter(item => item.tier === 'critical').length,
    summary: violations.length
      ? `${violations.length} intent${violations.length === 1 ? '' : 's'} violated after this change. Review ${violations.map(item => item.id).join(', ')} before deployment.`
      : `All ${after.length} network intents hold after this change.`
  };
}

export function evidenceForAI(analysis) {
  return {
    change: analysis.scenario,
    verdict: analysis.verdict,
    singleLinkFailureImpact: analysis.failureMatrix,
    intents: analysis.after.map(({ id, name, expectation, pass, finding, trace, returnTrace }) => ({
      id, name, expectation, pass, finding, trace: { status: trace.status, path: trace.path, hops: trace.hops, latencyMs: trace.latencyMs },
      returnTrace: returnTrace ? { status: returnTrace.status, path: returnTrace.path } : null
    }))
  };
}
