import importlib.util
import json
from pathlib import Path
import sys
import subprocess
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).parent))
spec = importlib.util.spec_from_file_location('measure', Path(__file__).with_name('measure.py'))
measure = importlib.util.module_from_spec(spec)
spec.loader.exec_module(measure)


class MeasureTest(unittest.TestCase):
    def test_release_verification_uses_the_exact_read_only_release_commands(self):
        self.assertEqual(measure.release_verification_steps(), [
            ('install', ['npm', 'ci']),
            ('typecheck', ['npm', 'run', 'typecheck']),
            ('unit', ['npm', 'run', 'test:unit']),
            ('vitest', ['npm', 'test']),
            ('build', ['npm', 'run', 'build']),
        ])

    def test_failure_is_persisted_and_not_reported_as_success(self):
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory)
            result = measure.run_step('failure', [sys.executable, '-c', 'print("evidence"); raise SystemExit(7)'], out, out)
            self.assertEqual(result['exitCode'], 7)
            self.assertEqual(json.loads((out / 'step-failure.json').read_text())['exitCode'], 7)
            self.assertIn('evidence', (out / 'failure.log').read_text())

    def test_step_metrics_do_not_overwrite_the_commands_report(self):
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory)
            measure.run_step('vitest', [sys.executable, '-c',
                'from pathlib import Path; Path("vitest.json").write_text(\'{"numTotalTests": 3}\')'], out, out)
            self.assertEqual(json.loads((out / 'vitest.json').read_text()), {'numTotalTests': 3})

    def test_snapshot_noop_is_not_a_successful_measurement(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            subprocess.run(['git', 'init', '-q', str(root)], check=True)
            subprocess.run(['git', '-c', 'user.name=test', '-c', 'user.email=test@local',
                            'commit', '--allow-empty', '-qm', 'fixture'], cwd=root, check=True)
            (root / 'package-lock.json').write_text('{}')
            (root / 'scripts').mkdir()
            (root / 'scripts/release-snapshot.mjs').write_text(
                'console.log(\'release-snapshot result: {"attempted":false}\')')
            result = subprocess.run([sys.executable, str(Path(__file__).with_name('measure.py')),
                                     '--root', str(root), '--out', str(root / 'results'),
                                     '--variant', 'snapshot-reuse', '--phase', 'snapshot'], capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('snapshot', (root / 'results/summary.json').read_text())

    def test_cli_propagates_install_failure_and_keeps_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            subprocess.run(['git', 'init', '-q', str(root)], check=True)
            subprocess.run(['git', '-c', 'user.name=test', '-c', 'user.email=test@local',
                            'commit', '--allow-empty', '-qm', 'fixture'], cwd=root, check=True)
            (root / 'package.json').write_text('{"name":"fixture","private":true}')
            (root / 'package-lock.json').write_text('invalid JSON')
            result = subprocess.run([sys.executable, str(Path(__file__).with_name('measure.py')),
                                     '--root', str(root), '--out', str(root / 'results'),
                                     '--variant', 'baseline'], capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertTrue((root / 'results/summary.json').is_file(), result.stdout + result.stderr)
            summary = json.loads((root / 'results/summary.json').read_text())
            self.assertEqual(len(summary['steps']), 1)
            self.assertEqual(summary['steps'][0]['exitCode'], result.returncode)
            self.assertTrue((root / 'results/install.log').is_file())

    def test_measures_child_work_and_preserves_literal_arguments(self):
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory)
            result = measure.run_step('child', [sys.executable, '-c',
                'import subprocess,sys; subprocess.run([sys.executable,"-c","x=bytearray(24000000); sum(i*i for i in range(1000000))"],check=True); print(sys.argv[1])',
                '$(must-not-execute)'], out, out)
            self.assertEqual(result['exitCode'], 0)
            self.assertGreater(result['userSeconds'] + result['systemSeconds'], 0)
            self.assertGreater(result['maxChildRssKiB'], 20000)
            self.assertGreater(result['wallSeconds'], 0)
            self.assertIn('$(must-not-execute)', (out / 'child.log').read_text())


if __name__ == '__main__':
    unittest.main()
