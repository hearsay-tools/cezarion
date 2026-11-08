import { RUNNER_IDS, type RunnerId } from '../core/agent-runner.ts';

export interface MonitoringPartition { runners: readonly RunnerId[]; modes: readonly ('fresh' | 'continuation')[]; rows: readonly string[] }
export const MONITORING_PARTITIONS = {
  "timer-fresh": {
    "runners": [
      "claude",
      "codex",
      "opencode",
      "pi",
      "cursor",
      "omp"
    ],
    "modes": [
      "fresh"
    ],
    "rows": [
      "M1"
    ]
  },
  "prose-question-fresh": {
    "runners": [
      "claude",
      "codex",
      "opencode",
      "pi",
      "cursor",
      "omp"
    ],
    "modes": [
      "fresh"
    ],
    "rows": [
      "M2"
    ]
  },
  "worker-review-fresh": {
    "runners": [
      "claude",
      "codex",
      "opencode",
      "pi",
      "cursor",
      "omp"
    ],
    "modes": [
      "fresh"
    ],
    "rows": [
      "M3",
      "M19"
    ]
  },
  "ask-precedence-question-fresh": {
    "runners": [
      "claude",
      "codex",
      "opencode",
      "pi",
      "cursor",
      "omp"
    ],
    "modes": [
      "fresh"
    ],
    "rows": [
      "M4"
    ]
  },
  "ask-precedence-done-refusal-fresh": {
    "runners": [
      "claude",
      "codex",
      "opencode",
      "pi",
      "cursor",
      "omp"
    ],
    "modes": [
      "fresh"
    ],
    "rows": [
      "M21"
    ]
  },
  "autonomous-prose-fresh": {
    "runners": [
      "claude",
      "codex",
      "opencode",
      "pi",
      "cursor",
      "omp"
    ],
    "modes": [
      "fresh"
    ],
    "rows": [
      "M13"
    ]
  },
  "timer-continuation": {
    "runners": [
      "claude",
      "codex",
      "opencode",
      "pi",
      "cursor",
      "omp"
    ],
    "modes": [
      "continuation"
    ],
    "rows": [
      "M1"
    ]
  },
  "prose-question-continuation": {
    "runners": [
      "claude",
      "codex",
      "opencode",
      "pi",
      "cursor",
      "omp"
    ],
    "modes": [
      "continuation"
    ],
    "rows": [
      "M2"
    ]
  },
  "worker-review-request-continuation": {
    "runners": [
      "claude",
      "codex",
      "opencode",
      "pi",
      "cursor",
      "omp"
    ],
    "modes": [
      "continuation"
    ],
    "rows": [
      "M3"
    ]
  },
  "worker-review-done-continuation": {
    "runners": [
      "claude",
      "codex",
      "opencode",
      "pi",
      "cursor",
      "omp"
    ],
    "modes": [
      "continuation"
    ],
    "rows": [
      "M19"
    ]
  },
  "ask-precedence-question-continuation": {
    "runners": [
      "claude",
      "codex",
      "opencode",
      "pi",
      "cursor",
      "omp"
    ],
    "modes": [
      "continuation"
    ],
    "rows": [
      "M4"
    ]
  },
  "ask-precedence-done-refusal-continuation": {
    "runners": [
      "claude",
      "codex",
      "opencode",
      "pi",
      "cursor",
      "omp"
    ],
    "modes": [
      "continuation"
    ],
    "rows": [
      "M21"
    ]
  },
  "autonomous-prose-continuation": {
    "runners": [
      "claude",
      "codex",
      "opencode",
      "pi",
      "cursor",
      "omp"
    ],
    "modes": [
      "continuation"
    ],
    "rows": [
      "M14"
    ]
  },
  "ask-idle-closure-claude-codex": {
    "runners": [
      "claude",
      "codex"
    ],
    "modes": [
      "fresh",
      "continuation"
    ],
    "rows": [
      "M7"
    ]
  },
  "ask-ack-claude-codex": {
    "runners": [
      "claude",
      "codex"
    ],
    "modes": [
      "fresh",
      "continuation"
    ],
    "rows": [
      "M18"
    ]
  },
  "ask-idle-closure-opencode-pi": {
    "runners": [
      "opencode",
      "pi"
    ],
    "modes": [
      "fresh",
      "continuation"
    ],
    "rows": [
      "M7"
    ]
  },
  "ask-ack-opencode-pi": {
    "runners": [
      "opencode",
      "pi"
    ],
    "modes": [
      "fresh",
      "continuation"
    ],
    "rows": [
      "M18"
    ]
  },
  "ask-idle-closure-cursor-omp": {
    "runners": [
      "cursor",
      "omp"
    ],
    "modes": [
      "fresh",
      "continuation"
    ],
    "rows": [
      "M7"
    ]
  },
  "ask-ack-cursor-omp": {
    "runners": [
      "cursor",
      "omp"
    ],
    "modes": [
      "fresh",
      "continuation"
    ],
    "rows": [
      "M18"
    ]
  },
  "done-fresh": {
    "runners": [
      "claude",
      "codex",
      "opencode",
      "pi",
      "cursor",
      "omp"
    ],
    "modes": [
      "fresh"
    ],
    "rows": [
      "M5"
    ]
  },
  "done-continuation": {
    "runners": [
      "claude",
      "codex",
      "opencode",
      "pi",
      "cursor",
      "omp"
    ],
    "modes": [
      "continuation"
    ],
    "rows": [
      "M5"
    ]
  },
  "close": {
    "runners": [
      "claude",
      "codex",
      "opencode",
      "pi",
      "cursor",
      "omp"
    ],
    "modes": [
      "fresh"
    ],
    "rows": [
      "M17"
    ]
  }
} as const satisfies Record<string, MonitoringPartition>;
export type MonitoringPartitionName = keyof typeof MONITORING_PARTITIONS;
export const monitoringTurnFiles = Object.keys(MONITORING_PARTITIONS).map(name => `monitoring-turn-${name}.test.ts`);
export function monitoringCells(partitions: readonly MonitoringPartition[]): string[] {
  return partitions.flatMap(partition => partition.runners.flatMap(runner => partition.modes.flatMap(mode => partition.rows.map(row => `${runner}/${mode}/${row}`))));
}
export const expectedMonitoringCells = RUNNER_IDS.flatMap(runner => [
  ...['fresh', 'continuation'].flatMap(mode => ['M1', 'M2', 'M3', 'M4', 'M5', 'M7', 'M18', 'M19', 'M21'].map(row => `${runner}/${mode}/${row}`)),
  `${runner}/fresh/M13`, `${runner}/continuation/M14`, `${runner}/fresh/M17`,
]);
