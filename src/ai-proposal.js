import { validateProposal } from '../public/core/proposal.js';

const schema = {
  type: 'object', additionalProperties: false, required: ['request', 'operations'], properties: {
    request: { type: 'string' },
    operations: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['type', 'node', 'prefix', 'gateway', 'distance', 'reason'],
      properties: {
        type: { type: 'string', enum: ['addStaticRoute'] }, node: { type: 'string' },
        prefix: { type: 'string' }, gateway: { type: 'string' },
        distance: { type: 'integer' }, reason: { type: 'string' }
      } } }
  }
};

export async function proposeWithModel(request, manifest, baseline, {
  key = process.env.OPENAI_API_KEY, model = process.env.OPENAI_MODEL || 'gpt-5-mini', fetchImpl = fetch
} = {}) {
  if (!key) throw new Error('AI provider is not configured');
  if (typeof request !== 'string' || request.length < 5 || request.length > 500) throw new Error('Request must be 5-500 characters');
  const context = {
    request,
    scope: 'Synthetic FRRouting static IPv4 lab; propose only 1-3 static route additions. No live device access.',
    nodes: manifest.nodes.map(node => ({ id: node.id, ip: node.ip })),
    adjacentGateways: manifest.nodes.map(node => ({ node: node.id, gateways: manifest.links.flatMap(link =>
      link.a.node === node.id ? [link.b.ip.split('/')[0]] : link.b.node === node.id ? [link.a.ip.split('/')[0]] : []) })),
    existingRoutes: baseline.nodes.map(node => ({ node: node.id, routes: node.routes })),
    intents: manifest.intents
  };
  const response = await fetchImpl('https://api.openai.com/v1/responses', {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(25_000),
    body: JSON.stringify({ model, store: false, max_output_tokens: 650,
      instructions: 'You propose a small testable change to a synthetic network lab. Return only the structured JSON. Select adjacent gateways listed in the input. Set request to the user request verbatim. Do not claim the change is safe; a separate deterministic gate must evaluate it. Do not include router commands, BGP, ACL, or configuration beyond the allowed route operations.',
      input: JSON.stringify(context),
      text: { format: { type: 'json_schema', name: 'network_route_proposal', strict: true, schema } }
    })
  });
  if (!response.ok) throw new Error(`AI provider returned HTTP ${response.status}`);
  const result = await response.json();
  const output = (result.output ?? []).flatMap(item => item.content ?? [])
    .filter(item => item.type === 'output_text').map(item => item.text).join('').trim();
  if (!output) throw new Error('AI provider returned no proposal');
  const proposal = JSON.parse(output);
  if (proposal.request !== request) throw new Error('AI proposal changed the request');
  validateProposal(proposal, manifest);
  return { proposal, model };
}
