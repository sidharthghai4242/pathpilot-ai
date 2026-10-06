export const topology = {
  name: 'Meridian Commerce - synthetic enterprise network',
  nodes: [
    { id: 'branch', label: 'Branch office', role: 'Client subnet', zone: 'Branch', ip: '10.10.1.10', x: 85, y: 165,
      routes: [{ prefix: '0.0.0.0/0', via: 'edge', metric: 10 }] },
    { id: 'edge', label: 'WAN edge', role: 'Border router', zone: 'DMZ', ip: '10.10.1.1', x: 280, y: 165,
      routes: [
        { prefix: '10.20.0.0/24', via: 'core', metric: 10 },
        { prefix: '10.30.0.0/24', via: 'core', metric: 10 },
        { prefix: '0.0.0.0/0', via: 'internet', metric: 100 }
      ],
      acls: [{ id: 'deny-external-db', source: '203.0.113.0/24', destination: '10.30.0.0/24', protocol: 'tcp', port: 5432, action: 'deny', enabled: true }] },
    { id: 'core', label: 'Core router', role: 'Internal transit', zone: 'Core', ip: '10.0.0.1', x: 490, y: 165,
      routes: [
        { prefix: '10.20.0.0/24', via: 'app', metric: 10 },
        { prefix: '10.30.0.0/24', via: 'db', metric: 10 },
        { prefix: '10.10.1.0/24', via: 'edge', metric: 10 },
        { prefix: '0.0.0.0/0', via: 'edge', metric: 100 }
      ],
      acls: [{ id: 'deny-branch-db', source: '10.10.1.0/24', destination: '10.30.0.0/24', protocol: 'tcp', port: 5432, action: 'deny', enabled: true }] },
    { id: 'app', label: 'Application', role: 'HTTPS service', zone: 'Application', ip: '10.20.0.10', x: 700, y: 75,
      routes: [{ prefix: '10.30.0.0/24', via: 'core', metric: 10 }, { prefix: '0.0.0.0/0', via: 'core', metric: 100 }] },
    { id: 'db', label: 'Database', role: 'PostgreSQL', zone: 'Data', ip: '10.30.0.10', x: 700, y: 255,
      routes: [{ prefix: '0.0.0.0/0', via: 'core', metric: 100 }] },
    { id: 'internet', label: 'Internet transit', role: 'External network', zone: 'External', ip: '203.0.113.1', x: 280, y: 335,
      routes: [
        { prefix: '10.20.0.0/24', via: 'edge', metric: 10 },
        { prefix: '10.30.0.0/24', via: 'edge', metric: 10 },
        { prefix: '10.10.1.0/24', via: 'edge', metric: 10 },
        { prefix: '198.51.100.0/24', via: 'partner', metric: 10 }
      ] },
    { id: 'partner', label: 'Partner', role: 'Third-party client', zone: 'External', ip: '198.51.100.20', x: 85, y: 335,
      routes: [{ prefix: '0.0.0.0/0', via: 'internet', metric: 10 }] }
  ],
  links: [
    { id: 'branch-edge', a: 'branch', b: 'edge', latencyMs: 5, capacityMbps: 100, up: true },
    { id: 'edge-core', a: 'edge', b: 'core', latencyMs: 3, capacityMbps: 1000, up: true },
    { id: 'core-app', a: 'core', b: 'app', latencyMs: 4, capacityMbps: 1000, up: true },
    { id: 'core-db', a: 'core', b: 'db', latencyMs: 2, capacityMbps: 1000, up: true },
    { id: 'partner-internet', a: 'partner', b: 'internet', latencyMs: 25, capacityMbps: 100, up: true },
    { id: 'internet-edge', a: 'internet', b: 'edge', latencyMs: 20, capacityMbps: 500, up: true },
    { id: 'edge-app-backup', a: 'edge', b: 'app', latencyMs: 9, capacityMbps: 200, up: false }
  ]
};

export const intents = [
  { id: 'INT-01', name: 'Branch can use checkout API', source: 'branch', destination: 'app', protocol: 'tcp', port: 443, expectation: 'allow', maxLatencyMs: 15, tier: 'critical' },
  { id: 'INT-02', name: 'Application can query database', source: 'app', destination: 'db', protocol: 'tcp', port: 5432, expectation: 'allow', maxLatencyMs: 10, tier: 'critical' },
  { id: 'INT-03', name: 'Partner can use checkout API', source: 'partner', destination: 'app', protocol: 'tcp', port: 443, expectation: 'allow', maxLatencyMs: 70, tier: 'standard' },
  { id: 'INT-04', name: 'Internet cannot reach database', source: 'internet', destination: 'db', protocol: 'tcp', port: 5432, expectation: 'deny', tier: 'critical' },
  { id: 'INT-05', name: 'Branch cannot query database directly', source: 'branch', destination: 'db', protocol: 'tcp', port: 5432, expectation: 'deny', tier: 'standard' }
];

export const scenarios = [
  { id: 'route-leak', name: 'Wrong next hop', category: 'Routing regression', summary: 'A more preferred route sends checkout traffic toward Internet transit.', changes: [
    { type: 'upsertRoute', node: 'edge', prefix: '10.20.0.0/24', via: 'internet', metric: 5 }
  ] },
  { id: 'policy-drift', name: 'Database ACL removed', category: 'Security regression', summary: 'A border ACL is disabled during a maintenance change.', changes: [
    { type: 'setAclEnabled', node: 'edge', acl: 'deny-external-db', enabled: false }
  ] },
  { id: 'link-outage', name: 'Application uplink fails', category: 'Resilience regression', summary: 'The core-to-application link goes down with no active alternate route.', changes: [
    { type: 'setLinkState', link: 'core-app', up: false }
  ] },
  { id: 'safe-reroute', name: 'Activate backup path', category: 'Safe change', summary: 'A tested backup link takes checkout traffic within the latency budget.', changes: [
    { type: 'setLinkState', link: 'edge-app-backup', up: true },
    { type: 'upsertRoute', node: 'edge', prefix: '10.20.0.0/24', via: 'app', metric: 5 }
  ] }
];
