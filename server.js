import { createServer as createHttpServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeScenario, evidenceForAI } from './public/core/engine.js';
import { scenarios } from './public/core/topology.js';
import { loadBaseline } from './src/snapshot.js';
import { buildProposalSnapshots } from './public/core/proposal.js';
import { buildGateReport } from './src/gate.js';
import { proposeWithModel } from './src/ai-proposal.js';
import { compileFrrSnapshot } from './public/core/frr.js';

const publicRoot = resolve(dirname(fileURLToPath(import.meta.url)), 'public');
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.conf': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
const limits = new Map();
let totalAiCalls = 0;

function json(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}

async function readJson(request, maxBytes = 2048) {
  let text = '';
  for await (const chunk of request) {
    text += chunk.toString('utf8');
    if (Buffer.byteLength(text) > maxBytes) throw new Error('Request body too large');
  }
  try { return JSON.parse(text); } catch { throw new Error('Malformed JSON'); }
}

function canCallAI(address) {
  const now = Date.now();
  const recent = (limits.get(address) ?? []).filter(time => now - time < 60_000);
  if (recent.length >= 3 || totalAiCalls >= 100) return false;
  recent.push(now);
  limits.set(address, recent);
  totalAiCalls++;
  return true;
}

export async function explainWithModel(analysis, { key = process.env.OPENAI_API_KEY, model = process.env.OPENAI_MODEL || 'gpt-5-mini', fetchImpl = fetch } = {}) {
  if (!key) throw new Error('AI provider is not configured');
  const evidence = evidenceForAI(analysis);
  const response = await fetchImpl('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(25_000),
    body: JSON.stringify({
      model,
      store: false,
      max_output_tokens: 450,
      instructions: 'You are a network change reviewer. Use only the supplied deterministic simulation evidence. In at most 150 words, explain the verdict, cite exact INT IDs, identify the observed hop or ACL that matters, and suggest one human-reviewed next step. Do not invent device commands, packet captures, production facts, or claim this simulation proves live-network safety.',
      input: JSON.stringify(evidence)
    })
  });
  if (!response.ok) throw new Error(`AI provider returned HTTP ${response.status}`);
  const result = await response.json();
  const output = (result.output ?? []).flatMap(item => item.content ?? []).filter(item => item.type === 'output_text').map(item => item.text).join('\n').trim();
  if (!output) throw new Error('AI provider returned no text');
  return { text: output, model, evidenceIds: analysis.after.map(item => item.id) };
}

export function createServer() {
  return createHttpServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    let url;
    try { url = new URL(request.url, 'http://localhost'); } catch { return json(response, 400, { error: 'Invalid URL' }); }
    if (request.method === 'GET' && url.pathname === '/healthz') return json(response, 200, { status: 'ok' });
    if (request.method === 'GET' && url.pathname === '/api/capabilities') return json(response, 200, { ai: Boolean(process.env.OPENAI_API_KEY), mode: 'server' });
    if (request.method === 'GET' && url.pathname === '/api/scenarios') return json(response, 200, scenarios.map(({ id, name, category, summary }) => ({ id, name, category, summary })));
    if (request.method === 'POST' && url.pathname === '/api/ai/propose') {
      if (!process.env.OPENAI_API_KEY) return json(response, 503, { error: 'AI provider is not configured' });
      const origin = request.headers.origin;
      if (origin) {
        try { if (new URL(origin).host !== request.headers.host) return json(response, 403, { error: 'Cross-origin request refused' }); }
        catch { return json(response, 403, { error: 'Cross-origin request refused' }); }
      }
      try {
        const input = await readJson(request);
        if (!input || typeof input.request !== 'string' || input.request.length < 5 || input.request.length > 500) {
          return json(response, 400, { error: 'Request must be 5-500 characters' });
        }
        if (!canCallAI(request.socket.remoteAddress ?? 'unknown')) return json(response, 429, { error: 'AI demo rate limit reached' });
        const { lab, configs } = await loadBaseline(join(publicRoot, 'labs/frr/lab.json'), join(publicRoot, 'labs/frr/baseline'));
        const baseline = compileFrrSnapshot(lab, configs);
        const { proposal, model } = await proposeWithModel(input.request, lab, baseline);
        const snapshots = buildProposalSnapshots(lab, configs, proposal);
        return json(response, 200, { model, proposal, report: buildGateReport(snapshots, 'ai') });
      } catch (error) {
        const badInput = ['Request body too large', 'Malformed JSON'].includes(error.message);
        return json(response, badInput ? 400 : 502,
          { error: badInput ? error.message : 'AI proposal unavailable or outside the supported model' });
      }
    }
    if (request.method === 'POST' && url.pathname === '/api/ai/explain') {
      if (!process.env.OPENAI_API_KEY) return json(response, 503, { error: 'AI provider is not configured' });
      const origin = request.headers.origin;
      const host = request.headers.host;
      if (origin) {
        try { if (new URL(origin).host !== host) return json(response, 403, { error: 'Cross-origin request refused' }); }
        catch { return json(response, 403, { error: 'Cross-origin request refused' }); }
      }
      try {
        const input = await readJson(request);
        if (!input || typeof input.scenarioId !== 'string' || !scenarios.some(item => item.id === input.scenarioId)) {
          return json(response, 400, { error: 'Select a known scenario' });
        }
        if (!canCallAI(request.socket.remoteAddress ?? 'unknown')) return json(response, 429, { error: 'AI demo rate limit reached' });
        const result = await explainWithModel(analyzeScenario(input.scenarioId));
        return json(response, 200, result);
      } catch (error) {
        const badInput = ['Request body too large', 'Malformed JSON'].includes(error.message);
        return json(response, badInput ? 400 : 502, { error: badInput ? error.message : 'AI explanation unavailable' });
      }
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') return json(response, 405, { error: 'Method not allowed' });
    let pathname;
    try { pathname = decodeURIComponent(url.pathname); } catch { return json(response, 400, { error: 'Invalid path' }); }
    if (pathname.includes('\0')) return json(response, 400, { error: 'Invalid path' });
    const target = resolve(publicRoot, `.${pathname === '/' ? '/index.html' : pathname}`);
    if (target !== publicRoot && !target.startsWith(publicRoot + sep)) return json(response, 403, { error: 'Forbidden' });
    try {
      const metadata = await stat(target);
      if (!metadata.isFile()) return json(response, 404, { error: 'Not found' });
      const content = await readFile(target);
      response.writeHead(200, { 'Content-Type': types[extname(target)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
      response.end(request.method === 'HEAD' ? undefined : content);
    } catch { json(response, 404, { error: 'Not found' }); }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  createServer().listen(port, '0.0.0.0', () => console.log(`PathPilot AI on http://localhost:${port}`));
}
