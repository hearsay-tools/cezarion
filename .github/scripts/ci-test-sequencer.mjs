import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { BaseSequencer } from 'vitest/node';

const durationManifest = JSON.parse(
  readFileSync(new URL('../test-durations.json', import.meta.url), 'utf8'),
);
const durations = durationManifest.durationsMs;

function positiveDuration(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function fallbackDuration(measured) {
  const values = Object.values(measured).filter(positiveDuration).sort((a, b) => a - b);
  if (values.length === 0) return 1;
  const middle = Math.floor(values.length / 2);
  return values.length % 2 === 1
    ? values[middle]
    : (values[middle - 1] + values[middle]) / 2;
}

/** Deterministically assign every discovered file using longest-processing-time bins. */
export function assignShards(filePaths, measuredDurations, count) {
  if (!Number.isInteger(count) || count <= 0) {
    throw new TypeError('shard count must be a positive integer');
  }

  const unique = new Set(filePaths);
  if (unique.size !== filePaths.length) {
    throw new TypeError('test file paths must be unique');
  }

  const fallback = fallbackDuration(measuredDurations);
  const weighted = [...filePaths]
    .map((file) => ({
      file,
      duration: positiveDuration(measuredDurations[file]) ? measuredDurations[file] : fallback,
    }))
    .sort((a, b) => b.duration - a.duration || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  const bins = Array.from({ length: count }, () => ({ total: 0, files: [] }));

  for (const entry of weighted) {
    let target = 0;
    for (let index = 1; index < bins.length; index += 1) {
      if (bins[index].total < bins[target].total) target = index;
    }
    bins[target].files.push(entry.file);
    bins[target].total += entry.duration;
  }

  return bins.map((bin) => bin.files);
}

function repoRelative(root, moduleId) {
  return relative(root, moduleId).replaceAll('\\', '/');
}

export default class CiTestSequencer extends BaseSequencer {
  async shard(specifications) {
    const { index, count } = this.ctx.config.shard;
    if (!Number.isInteger(index) || index < 1 || index > count) {
      throw new TypeError('shard index must be between 1 and shard count');
    }
    const byKey = new Map();
    const keyedDurations = {};
    specifications.forEach((specification) => {
      const file = repoRelative(this.ctx.config.root, specification.moduleId);
      const project = specification.project.name ?? '';
      const baseKey = `${project}\0${file}`;
      let key = baseKey;
      let duplicate = 1;
      while (byKey.has(key)) key = `${baseKey}\0${duplicate++}`;
      byKey.set(key, specification);
      keyedDurations[key] = durations[file];
    });
    const assigned = assignShards([...byKey.keys()], keyedDurations, count);
    return assigned[index - 1].map((key) => byKey.get(key));
  }
}
