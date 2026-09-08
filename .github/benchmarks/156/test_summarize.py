import json
from pathlib import Path
import tempfile
import unittest

import summarize


def step(name, wall, user=1, system=0.5, rss=100, exit_code=0):
    return {'name': name, 'wallSeconds': wall, 'userSeconds': user,
            'systemSeconds': system, 'maxChildRssKiB': rss, 'exitCode': exit_code}


class SummarizeTest(unittest.TestCase):
    def write_artifact(self, root, variant, repetition, steps, phase='verify'):
        path = root / f'benchmark-{variant}-{repetition}'
        path.mkdir()
        (path / 'metadata.json').write_text(json.dumps({
            'variant': variant, 'repetition': str(repetition), 'phase': phase,
            'node': 'v24.20.0', 'runId': '77',
        }))
        (path / 'summary.json').write_text(json.dumps({'steps': steps}))

    def test_aggregates_three_samples_and_keeps_raw_job_timing(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            jobs = []
            for repetition, total in enumerate((10, 20, 30), 1):
                self.write_artifact(root, 'baseline', repetition, [
                    step('install', repetition, rss=50),
                    step('typecheck', total - 4, user=repetition, system=1, rss=100 + repetition),
                    step('vitest', 4, user=2, system=1, rss=200 + repetition),
                ])
                jobs.append({
                    'name': f'measure (baseline, {repetition})', 'conclusion': 'success',
                    'started_at': f'2026-09-08T10:00:0{repetition}Z',
                    'completed_at': f'2026-09-08T10:01:0{repetition}Z',
                    'id': repetition,
                })
            (root / 'jobs.json').write_text(json.dumps({'jobs': jobs}))

            report = summarize.summarize(root)
            aggregate = report['variants']['baseline']
            self.assertEqual((aggregate['successes'], aggregate['failures'], aggregate['missing']), (3, 0, 0))
            self.assertEqual(aggregate['metrics']['verificationSeconds'], {'median': 20, 'min': 10, 'max': 30})
            self.assertEqual(aggregate['metrics']['installSeconds'], {'median': 2, 'min': 1, 'max': 3})
            self.assertEqual(aggregate['metrics']['vitestSeconds'], {'median': 4, 'min': 4, 'max': 4})
            self.assertEqual(aggregate['metrics']['jobRunnerSeconds'], {'median': 60, 'min': 60, 'max': 60})
            self.assertEqual(aggregate['metrics']['peakMaxChildRssKiB'], {'median': 202, 'min': 201, 'max': 203})
            self.assertEqual(len(report['jobs']), 3)
            self.assertEqual(report['jobs'][0]['raw']['id'], 1)

    def test_failure_and_missing_summary_are_never_successes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.write_artifact(root, 'setup', 1, [step('install', 3), step('vitest', 8)])
            self.write_artifact(root, 'setup', 2, [step('install', 3), step('vitest', 5, exit_code=7)])
            missing = root / 'benchmark-setup-3'
            missing.mkdir()
            (missing / 'metadata.json').write_text(json.dumps({
                'variant': 'setup', 'repetition': '3', 'phase': 'verify',
            }))
            jobs = [{
                'name': f'measure (setup, {repetition})', 'conclusion': 'success' if repetition != 2 else 'failure',
                'started_at': '2026-09-08T10:00:00Z', 'completed_at': '2026-09-08T10:01:00Z',
            } for repetition in (1, 2, 3)]
            (root / 'jobs.json').write_text(json.dumps({'jobs': jobs}))

            aggregate = summarize.summarize(root)['variants']['setup']
            self.assertEqual((aggregate['successes'], aggregate['failures'], aggregate['missing']), (1, 1, 1))
            self.assertEqual(aggregate['metrics']['vitestSeconds'], {'median': 8, 'min': 8, 'max': 8})
            self.assertEqual(aggregate['allMeasuredVitestSeconds'], {'median': 6.5, 'min': 5, 'max': 8})
            self.assertEqual([(sample['repetition'], sample['failedSteps']) for sample in aggregate['failureSamples']], [(2, ['vitest'])])
            self.assertEqual([sample['status'] for sample in aggregate['samples']], ['success', 'failure', 'missing'])

    def test_empty_or_malformed_steps_are_missing_instead_of_successful(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            invalid_steps = [[], ['not an object'], [{
                'name': 'vitest', 'wallSeconds': 1, 'userSeconds': 1,
                'systemSeconds': 0, 'maxChildRssKiB': 100,
            }]]
            jobs = []
            for repetition, steps in enumerate(invalid_steps, 1):
                self.write_artifact(root, 'broken', repetition, steps)
                jobs.append({
                    'name': f'measure (broken, {repetition})', 'conclusion': 'success',
                    'started_at': '2026-09-08T10:00:00Z',
                    'completed_at': '2026-09-08T10:01:00Z',
                })
            (root / 'jobs.json').write_text(json.dumps({'jobs': jobs}))

            aggregate = summarize.summarize(root)['variants']['broken']
            self.assertEqual((aggregate['successes'], aggregate['failures'], aggregate['missing']), (0, 0, 3))
            self.assertTrue(all(sample['status'] == 'missing' for sample in aggregate['samples']))
            self.assertIsNone(aggregate['allMeasuredVitestSeconds'])

    def test_job_without_an_artifact_is_reported_missing_and_snapshot_name_matches(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'jobs.json').write_text(json.dumps({'jobs': [{
                'name': 'snapshot (snapshot-fresh, 1)', 'conclusion': 'success',
                'started_at': '2026-09-08T10:00:00Z', 'completed_at': '2026-09-08T10:02:00Z',
            }]}))
            report = summarize.summarize(root)
            sample = report['variants']['snapshot-fresh']['samples'][0]
            self.assertEqual(sample['status'], 'missing')
            self.assertEqual(sample['phase'], 'snapshot')
            self.assertEqual(sample['jobRunnerSeconds'], 120)


if __name__ == '__main__':
    unittest.main()
