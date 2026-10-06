import { topology, intents, scenarios } from './core/topology.js';
import { analyzeScenario } from './core/engine.js';

const $ = id => document.getElementById(id);
let activeScenario = scenarios[0].id;
let selectedIntent = intents[0].id;
let analysis = analyzeScenario(activeScenario);

function element(tag, className, text) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text !== undefined) item.textContent = text;
  return item;
}

function svgElement(tag, attributes) {
  const item = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attributes)) item.setAttribute(key, String(value));
  return item;
}

function renderScenarios() {
  const list = $('scenario-list');
  list.replaceChildren();
  scenarios.forEach((scenario, index) => {
    const card = element('button', `scenario-card${scenario.id === activeScenario ? ' selected' : ''}`);
    card.type = 'button';
    card.setAttribute('aria-pressed', String(scenario.id === activeScenario));
    const top = element('div', 'scenario-top');
    top.append(element('span', 'scenario-number', `0${index + 1}`), element('span', 'scenario-arrow', '↗'));
    card.append(top, element('strong', '', scenario.name), element('small', '', scenario.category));
    card.title = scenario.summary;
    card.addEventListener('click', () => {
      activeScenario = scenario.id;
      analysis = analyzeScenario(activeScenario);
      $('ai-output').textContent = 'Run a scenario, then request a grounded explanation. An API key is needed for live AI generation.';
      renderAll();
    });
    list.append(card);
  });
}

function renderMetrics() {
  const blocked = analysis.verdict === 'BLOCK';
  $('verdict-value').textContent = blocked ? 'BLOCK' : 'PASS';
  $('verdict-value').className = blocked ? 'blocked' : 'passed';
  $('verdict-note').textContent = blocked ? 'Do not deploy this change' : 'No modeled regressions';
  $('checks-value').textContent = `${analysis.after.filter(item => item.pass).length} / ${analysis.after.length}`;
  $('regressions-value').textContent = String(analysis.regressions.length);
  $('critical-value').textContent = String(analysis.criticalViolations);
}

function renderGraph(trace) {
  const svg = $('network-graph');
  svg.replaceChildren();
  const grid = svgElement('g', { class: 'graph-grid' });
  for (let x = 0; x <= 800; x += 40) grid.append(svgElement('line', { x1: x, y1: 0, x2: x, y2: 410 }));
  for (let y = 0; y <= 410; y += 40) grid.append(svgElement('line', { x1: 0, y1: y, x2: 800, y2: y }));
  svg.append(grid);
  const pathLinks = new Set(trace.hops.filter(hop => hop.link).map(hop => hop.link));
  for (const link of analysis.candidate.links) {
    const a = analysis.candidate.nodes.find(node => node.id === link.a);
    const b = analysis.candidate.nodes.find(node => node.id === link.b);
    const line = svgElement('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y,
      class: `graph-link${link.up ? '' : ' off'}${pathLinks.has(link.id) ? ' path' : ''}` });
    const title = svgElement('title', {});
    title.textContent = `${link.id}: ${link.up ? 'up' : 'down'}, ${link.latencyMs} ms, ${link.capacityMbps} Mbps`;
    line.append(title);
    svg.append(line);
  }
  const pathNodes = new Set(trace.path);
  for (const node of analysis.candidate.nodes) {
    const group = svgElement('g', { class: `graph-node ${node.zone.toLowerCase()}${pathNodes.has(node.id) ? ' path' : ''}` });
    group.append(svgElement('circle', { cx: node.x, cy: node.y, r: 25 }));
    const icon = svgElement('text', { x: node.x, y: node.y + 1, class: 'node-icon' });
    icon.textContent = node.id === 'db' ? '▤' : node.id === 'app' ? '◈' : node.zone === 'External' ? '◎' : '⌁';
    const label = svgElement('text', { x: node.x, y: node.y + 43, class: 'node-label' });
    label.textContent = node.label;
    const role = svgElement('text', { x: node.x, y: node.y + 58, class: 'node-role' });
    role.textContent = node.role;
    group.append(icon, label, role);
    svg.append(group);
  }
}

function renderTrace() {
  const result = analysis.after.find(item => item.id === selectedIntent);
  const trace = result.trace;
  $('selected-flow-label').textContent = `${result.source} → ${result.destination} · ${result.protocol}/${result.port}`;
  $('trace-title').textContent = result.name;
  $('trace-finding').textContent = result.finding;
  $('trace-status').textContent = trace.status.replaceAll('_', ' ');
  $('trace-status').className = `trace-status${result.pass ? '' : ' failed'}`;
  $('trace-latency').textContent = `${trace.latencyMs} ms`;
  $('trace-capacity').textContent = trace.bottleneckMbps === null ? '—' : `${trace.bottleneckMbps} Mbps`;
  const steps = $('trace-steps');
  steps.replaceChildren();
  trace.hops.forEach((hop, index) => {
    const node = analysis.candidate.nodes.find(item => item.id === hop.node);
    const row = element('li');
    const copy = element('div', 'hop-copy');
    copy.append(element('strong', '', node.label), element('small', '', hop.decision));
    row.append(element('span', 'hop-number', String(index + 1)), copy);
    steps.append(row);
  });
  renderGraph(trace);
}

function statusBadge(pass) {
  return element('span', `badge ${pass ? 'pass' : 'fail'}`, pass ? 'PASS' : 'FAIL');
}

function renderIntents() {
  const body = $('intent-rows');
  body.replaceChildren();
  analysis.after.forEach((result, index) => {
    const before = analysis.before[index];
    const row = element('tr', result.id === selectedIntent ? 'selected' : '');
    row.tabIndex = 0;
    row.setAttribute('aria-label', `${result.id}: ${result.name}. ${result.pass ? 'Pass' : 'Fail'}. Click to inspect trace.`);
    const identity = element('td');
    identity.append(element('strong', '', result.name), element('small', '', `${result.id} · ${result.tier.toUpperCase()}`));
    const expected = element('td');
    expected.append(element('span', `badge ${result.expectation}`, result.expectation === 'allow' ? 'REACHABLE' : 'ISOLATED'));
    const prior = element('td'); prior.append(statusBadge(before.pass));
    const after = element('td'); after.append(statusBadge(result.pass));
    const finding = element('td', 'finding', result.finding);
    finding.title = result.finding;
    row.append(identity, expected, prior, after, finding);
    const select = () => { selectedIntent = result.id; renderIntents(); renderTrace(); };
    row.addEventListener('click', select);
    row.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(); } });
    body.append(row);
  });
}

function renderFailureMatrix() {
  const list = $('failure-list');
  list.replaceChildren();
  analysis.failureMatrix.slice(0, 4).forEach(item => {
    const card = element('div', 'failure-card');
    card.append(element('strong', '', item.linkId),
      element('span', item.lostIntents.length ? 'impact' : 'clear', item.lostIntents.length ? `${item.lostIntents.length} intent${item.lostIntents.length === 1 ? '' : 's'} lost` : 'No modeled loss'),
      element('small', '', item.lostIntents.length ? `${item.lostIntents.join(', ')} · ${item.criticalLost} critical` : 'Alternate path or no dependent intent'));
    list.append(card);
  });
}

function renderAll() {
  renderScenarios();
  renderMetrics();
  renderIntents();
  renderTrace();
  renderFailureMatrix();
}

$('ai-button').addEventListener('click', async () => {
  const button = $('ai-button');
  const output = $('ai-output');
  button.disabled = true;
  output.textContent = 'Requesting a review grounded in the current packet traces…';
  try {
    const response = await fetch(new URL('./api/ai/explain', document.baseURI), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scenarioId: activeScenario })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
    output.textContent = `${data.text}\n\nAI-generated explanation · ${data.model} · Verify against the intent table above.`;
  } catch (error) {
    output.textContent = 'Live AI review needs the optional server and OPENAI_API_KEY. The verdict, routes, ACL decisions, and intent checks above run locally without a model.';
  } finally { button.disabled = false; }
});

renderAll();
