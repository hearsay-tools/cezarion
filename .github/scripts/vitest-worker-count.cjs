// Peak worker RSS: 414432 KiB in the four unit projects (2026-11-03); twice that rounds up to 1 GiB.
// Use half of free bytes for workers: max(1, min(available CPUs, floor(free bytes / (2 * 1 GiB)))).
const WORKER_MEMORY_BYTES = 1024 ** 3;

function defaultMaxWorkers(freeMemoryBytes, cpuCount) {
  return Math.max(1, Math.min(cpuCount, Math.floor(freeMemoryBytes / (2 * WORKER_MEMORY_BYTES))));
}

module.exports = { defaultMaxWorkers, WORKER_MEMORY_BYTES };
