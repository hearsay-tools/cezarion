import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('summarize_ci', Path(__file__).with_name('summarize-ci.py'))
summary = importlib.util.module_from_spec(spec)
spec.loader.exec_module(summary)


def run(conclusion='success'):
    return dict(databaseId=1, headSha='a'*40, url='https://example.test/1', status='completed',
                conclusion=conclusion, createdAt='2026-09-08T00:00:00Z', updatedAt='2026-09-08T00:01:31Z',
                jobs=[dict(name='Vitest shard 1/2', status='completed', conclusion=conclusion,
                           startedAt='2026-09-08T00:00:10Z', completedAt='2026-09-08T00:01:20Z'),
                      dict(name=summary.VERIFY, status='completed', conclusion=conclusion,
                           startedAt='2026-09-08T00:01:25Z', completedAt='2026-09-08T00:01:30Z')])


class SummaryTests(unittest.TestCase):
    def test_cancelled_run_without_aggregate_remains_evidence(self):
        cancelled = run('cancelled')
        cancelled['jobs'] = []
        row = summary.summarize_run(cancelled, '')
        self.assertEqual(row['conclusion'], 'cancelled')
        self.assertIsNone(row['verificationWallSeconds'])
        self.assertIsNone(row['verificationConclusion'])
        self.assertEqual(row['workflowWallSeconds'], 91)

    def test_wall_clock_includes_queue_and_dependency_gaps(self):
        row = summary.summarize_run(run(), '')
        self.assertEqual(row['verificationWallSeconds'], 90)
        self.assertEqual(row['workflowWallSeconds'], 91)
        self.assertEqual(row['runnerSeconds'], 75)

    def test_failure_is_retained_but_not_in_successful_medians(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for rep, conclusion in [(1, 'failure'), (2, 'success')]:
                path = root/'current'/f'github-{rep}'
                path.mkdir(parents=True)
                (path/'run.json').write_text(json.dumps(run(conclusion)))
                (path/'workflow.log').write_text('')
            result = summary.summarize(root)
            self.assertEqual(len(result['rows']), 2)
            group = result['groups']['current/github']
            self.assertEqual((group['successes'], group['failures']), (1, 1))
            self.assertEqual(group['workflowWallSeconds']['median'], 91)

    def test_console_control_notation_is_removed_without_losing_failure_or_counts(self):
        log = 'Vitest shard 1/2\tstep\ttime ^[[31m FAIL ^[[0m server broken case\n'
        log += 'Vitest shard 1/2\tstep\ttime \x1b[31m Tests 1 failed | 2 passed (3)\x1b[0m\n'
        row = summary.summarize_run(run('failure'), log)
        self.assertEqual(row['testsByShard'], {'Vitest shard 1/2': 3})
        self.assertEqual(row['failures'], ['time  FAIL  server broken case'])


if __name__ == '__main__':
    unittest.main()
