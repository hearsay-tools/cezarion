import { RUNNER_IDS } from '../core/agent-runner.ts';
import { runsOn } from '../core/parity-classes.testkit.ts';

/** A file's monitoring cells: its modes and rows, on each runner its rows' class names
 *  (`core/parity-classes.testkit.ts`, hearsay-tools/cezarion#2991). */
export interface MonitoringPartition { modes: readonly ('fresh' | 'continuation')[]; rows: readonly string[] }
export const MONITORING_PARTITIONS = {
  "timer-fresh": {
    "modes": [
      "fresh"
    ],
    "rows": [
      "M1"
    ]
  },
  "prose-question-fresh": {
    "modes": [
      "fresh"
    ],
    "rows": [
      "M2"
    ]
  },
  "worker-review-fresh": {
    "modes": [
      "fresh"
    ],
    "rows": [
      "M3",
      "M19"
    ]
  },
  "ask-precedence-question-fresh": {
    "modes": [
      "fresh"
    ],
    "rows": [
      "M4"
    ]
  },
  "ask-precedence-done-refusal-fresh": {
    "modes": [
      "fresh"
    ],
    "rows": [
      "M21"
    ]
  },
  "autonomous-prose-fresh": {
    "modes": [
      "fresh"
    ],
    "rows": [
      "M13"
    ]
  },
  "timer-continuation": {
    "modes": [
      "continuation"
    ],
    "rows": [
      "M1"
    ]
  },
  "prose-question-continuation": {
    "modes": [
      "continuation"
    ],
    "rows": [
      "M2"
    ]
  },
  "worker-review-request-continuation": {
    "modes": [
      "continuation"
    ],
    "rows": [
      "M3"
    ]
  },
  "worker-review-done-continuation": {
    "modes": [
      "continuation"
    ],
    "rows": [
      "M19"
    ]
  },
  "ask-precedence-question-continuation": {
    "modes": [
      "continuation"
    ],
    "rows": [
      "M4"
    ]
  },
  "ask-precedence-done-refusal-continuation": {
    "modes": [
      "continuation"
    ],
    "rows": [
      "M21"
    ]
  },
  "autonomous-prose-continuation": {
    "modes": [
      "continuation"
    ],
    "rows": [
      "M14"
    ]
  },
  "ask-idle-closure": {
    "modes": [
      "fresh",
      "continuation"
    ],
    "rows": [
      "M7"
    ]
  },
  "ask-ack": {
    "modes": [
      "fresh",
      "continuation"
    ],
    "rows": [
      "M18"
    ]
  },
  "done-fresh": {
    "modes": [
      "fresh"
    ],
    "rows": [
      "M5"
    ]
  },
  "done-continuation": {
    "modes": [
      "continuation"
    ],
    "rows": [
      "M5"
    ]
  },
  "close": {
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
  return partitions.flatMap(partition => RUNNER_IDS.flatMap(runner => partition.modes.flatMap(mode => partition.rows
    .filter(row => runsOn('monitoring-turn', row, runner)).map(row => `${runner}/${mode}/${row}`))));
}
export const expectedMonitoringCells = RUNNER_IDS.flatMap(runner => [
  ...['fresh', 'continuation'].flatMap(mode => ['M1', 'M2', 'M3', 'M4', 'M5', 'M7', 'M18', 'M19', 'M21'].map(row => `${runner}/${mode}/${row}`)),
  `${runner}/fresh/M13`, `${runner}/continuation/M14`, `${runner}/fresh/M17`,
].filter(cell => runsOn('monitoring-turn', cell.split('/')[2], runner)));
