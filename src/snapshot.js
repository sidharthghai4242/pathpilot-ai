import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { compileFrrSnapshot } from '../public/core/frr.js';

async function readConfig(directory, nodeId) {
  if (!/^[A-Za-z0-9_-]+$/.test(nodeId)) throw new Error(`Unsafe node ID: ${nodeId}`);
  return readFile(join(directory, `${nodeId}.conf`), 'utf8');
}

export async function loadSnapshots(labFile, baselineDirectory, candidateDirectory) {
  const lab = JSON.parse(await readFile(resolve(labFile), 'utf8'));
  if (!Array.isArray(lab.nodes) || lab.nodes.length === 0 || lab.nodes.length > 100) throw new Error('Lab must contain 1-100 nodes');
  const baselineConfigs = {};
  const candidateConfigs = {};
  for (const node of lab.nodes) {
    baselineConfigs[node.id] = await readConfig(resolve(baselineDirectory), node.id);
    try { candidateConfigs[node.id] = await readConfig(resolve(candidateDirectory), node.id); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      candidateConfigs[node.id] = baselineConfigs[node.id];
    }
  }
  return {
    lab,
    baseline: compileFrrSnapshot(lab, baselineConfigs),
    candidate: compileFrrSnapshot(lab, candidateConfigs),
    changedConfigNodes: lab.nodes.filter(node => baselineConfigs[node.id] !== candidateConfigs[node.id]).map(node => node.id)
  };
}

export async function loadBaseline(labFile, baselineDirectory) {
  const lab = JSON.parse(await readFile(resolve(labFile), 'utf8'));
  if (!Array.isArray(lab.nodes) || lab.nodes.length === 0 || lab.nodes.length > 100) throw new Error('Lab must contain 1-100 nodes');
  const configs = {};
  for (const node of lab.nodes) configs[node.id] = await readConfig(resolve(baselineDirectory), node.id);
  compileFrrSnapshot(lab, configs);
  return { lab, configs };
}
