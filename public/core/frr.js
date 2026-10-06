import { matchesCidr, validateTopology } from './engine.js';

function assertIPv4(ip) {
  matchesCidr(ip, '0.0.0.0/0');
}

// A deliberately narrow FRRouting frr.conf importer. Unknown forwarding
// features fail closed rather than producing an incomplete safety verdict.
export function parseFrrConfig(text, filename = 'frr.conf') {
  if (typeof text !== 'string' || text.length > 256_000) throw new Error(`${filename}: invalid or oversized config`);
  const interfaces = new Map();
  const routes = [];
  let currentInterface = null;
  const lines = text.replaceAll('\r\n', '\n').split('\n');
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    if (!line || line === '!') { if (line === '!') currentInterface = null; continue; }
    if (/^(frr version|frr defaults|hostname|service integrated-vtysh-config|log stdout|line vty)(\s|$)/.test(line)) {
      currentInterface = null;
      continue;
    }
    if (line === 'exit') { currentInterface = null; continue; }
    const interfaceMatch = /^interface ([a-zA-Z][a-zA-Z0-9_.-]*)$/.exec(line);
    if (interfaceMatch) {
      currentInterface = interfaceMatch[1];
      if (interfaces.has(currentInterface)) throw new Error(`${filename}:${index + 1}: duplicate interface ${currentInterface}`);
      interfaces.set(currentInterface, []);
      continue;
    }
    const addressMatch = /^ip address (\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2})$/.exec(line);
    if (addressMatch && currentInterface) {
      const [ip] = addressMatch[1].split('/');
      assertIPv4(ip);
      matchesCidr(ip, addressMatch[1]);
      interfaces.get(currentInterface).push(addressMatch[1]);
      continue;
    }
    const routeMatch = /^ip route (\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2}) (\d{1,3}(?:\.\d{1,3}){3})(?: (\d{1,3}))?$/.exec(line);
    if (routeMatch && !currentInterface) {
      const [, prefix, gateway, rawDistance] = routeMatch;
      matchesCidr(gateway, prefix);
      const distance = rawDistance === undefined ? 1 : Number(rawDistance);
      if (distance < 1 || distance > 255) throw new Error(`${filename}:${index + 1}: invalid route distance`);
      routes.push({ prefix, gateway, metric: distance });
      continue;
    }
    throw new Error(`${filename}:${index + 1}: unsupported command '${line}'`);
  }
  return { interfaces, routes };
}

function endpointFor(link, nodeId) {
  if (link.a.node === nodeId) return { local: link.a, remote: link.b };
  if (link.b.node === nodeId) return { local: link.b, remote: link.a };
  return null;
}

export function compileFrrSnapshot(manifest, configs) {
  if (!manifest || !Array.isArray(manifest.nodes) || !Array.isArray(manifest.links)) throw new Error('Invalid lab manifest');
  const nodeIds = new Set(manifest.nodes.map(node => node.id));
  if (nodeIds.size !== manifest.nodes.length) throw new Error('Duplicate lab node');
  const links = manifest.links.map(link => {
    if (!link.a?.node || !link.b?.node || !link.a?.iface || !link.b?.iface || !link.a?.ip || !link.b?.ip
      || !nodeIds.has(link.a.node) || !nodeIds.has(link.b.node)) throw new Error(`Invalid lab link ${link.id}`);
    return { id: link.id, a: link.a.node, b: link.b.node, latencyMs: link.latencyMs, capacityMbps: link.capacityMbps, up: link.up };
  });
  const nodes = manifest.nodes.map(node => {
    const config = configs[node.id];
    if (typeof config !== 'string') throw new Error(`Missing FRR config for ${node.id}`);
    const parsed = parseFrrConfig(config, `${node.id}.conf`);
    if (!parsed.interfaces.get('lo')?.includes(`${node.ip}/32`)) throw new Error(`${node.id}: loopback ${node.ip}/32 missing from config`);
    const adjacent = manifest.links.map(link => endpointFor(link, node.id)).filter(Boolean);
    const expectedInterfaces = new Map([['lo', [`${node.ip}/32`]]]);
    for (const pair of adjacent) {
      if (expectedInterfaces.has(pair.local.iface)) throw new Error(`${node.id}: reused interface ${pair.local.iface}`);
      expectedInterfaces.set(pair.local.iface, [pair.local.ip]);
    }
    for (const [iface, addresses] of parsed.interfaces) {
      const expected = expectedInterfaces.get(iface);
      if (!expected || addresses.length !== expected.length || addresses.some(address => !expected.includes(address))) {
        throw new Error(`${node.id}: undeclared interface or address on ${iface}`);
      }
    }
    for (const iface of expectedInterfaces.keys()) {
      if (!parsed.interfaces.has(iface)) throw new Error(`${node.id}: missing interface ${iface}`);
    }
    for (const pair of adjacent) {
      if (!parsed.interfaces.get(pair.local.iface)?.includes(pair.local.ip)) {
        throw new Error(`${node.id}: ${pair.local.iface} must have ${pair.local.ip}`);
      }
      const [localIp, localLength] = pair.local.ip.split('/');
      const [remoteIp, remoteLength] = pair.remote.ip.split('/');
      if (localLength !== remoteLength || !matchesCidr(remoteIp, pair.local.ip) || localIp === remoteIp) {
        throw new Error(`${node.id}: mismatched link subnet on ${pair.local.iface}`);
      }
    }
    const routes = parsed.routes.map(route => {
      const pair = adjacent.find(item => item.remote.ip.split('/')[0] === route.gateway);
      if (!pair) throw new Error(`${node.id}: next hop ${route.gateway} is not an adjacent interface`);
      return { prefix: route.prefix, via: pair.remote.node, metric: route.metric };
    });
    const keys = new Set();
    const prefixDistances = new Set();
    for (const route of routes) {
      const key = `${route.prefix}|${route.via}`;
      const prefixDistance = `${route.prefix}|${route.metric}`;
      if (keys.has(key)) throw new Error(`${node.id}: duplicate route ${key}`);
      if (prefixDistances.has(prefixDistance)) throw new Error(`${node.id}: ECMP route ${prefixDistance} is unsupported`);
      keys.add(key);
      prefixDistances.add(prefixDistance);
    }
    return { id: node.id, label: node.label ?? node.id, role: node.role ?? 'Router', zone: node.zone ?? 'Lab', ip: node.ip,
      x: node.x ?? 0, y: node.y ?? 0, routes, acls: node.acls ?? [] };
  });
  const model = { name: manifest.name ?? 'FRRouting snapshot', nodes, links };
  validateTopology(model);
  return model;
}
