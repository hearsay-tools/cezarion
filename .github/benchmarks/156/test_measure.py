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
    def test_failure_is_persisted_and_not_reported_as_success(self):
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory)
            result = measure.run_step('failure', [sys.executable, '-c', 'print("evidence"); raise SystemExit(7)'], out, out)
            self.assertEqual(result['exitCode'], 7)
            self.assertEqual(json.loads((out / 'failure.json').read_text())['exitCode'], 7)
            self.assertIn('evidence', (out / 'failure.log').read_text())

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
