"""Portable fixtures for the shell scripts' native-tool input/output boundaries."""
import os
from pathlib import Path
import plistlib
import subprocess
import tempfile
import unittest


SCRIPTS = Path(__file__).resolve().parent
IOS_PROGRAM = (SCRIPTS / 'side-by-side-ios.sh').read_text().split("<<'PY'\n", 1)[1].split('\nPY\n', 1)[0]
ANDROID_CHECK = 'check() {' + (SCRIPTS / 'side-by-side-android.sh').read_text().split('check() {', 1)[1].split('\n}', 1)[0] + '\n}'


def target(name):
    return {
        'BlueprintName': name,
        'TestBundlePath': f'__TESTROOT__/Debug-iphonesimulator/{name}.xctest',
        'TestHostPath': '__TESTROOT__/Debug-iphonesimulator/Cezarion.app',
        'EnvironmentVariables': {'existing': 'kept'},
    }


class XctestrunFixtures(unittest.TestCase):
    def assert_patched(self, run, version):
        with tempfile.TemporaryDirectory() as directory:
            products = Path(directory)
            source = products / 'Cezarion_simulator.xctestrun'
            original = plistlib.dumps(run, fmt=plistlib.FMT_XML if version == 1 else plistlib.FMT_BINARY)
            source.write_bytes(original)
            for app_id in ['fixture.legacy', 'fixture.new']:
                result = subprocess.run(['python3', '-', directory, app_id], input=IOS_PROGRAM, text=True, capture_output=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                patched = plistlib.loads(Path(result.stdout.strip()).read_bytes())
                expected = plistlib.loads(original)
                targets = [expected['CezarionTests'], expected['CezarionUITests']] if version == 1 else expected['TestConfigurations'][0]['TestTargets']
                for item in targets:
                    item.setdefault('EnvironmentVariables', {}).update({'MOBILE_SIDE_BY_SIDE': '1', 'MOBILE_SIDE_BY_SIDE_APP_ID': app_id})
                self.assertEqual(patched, expected)
                self.assertEqual(source.read_bytes(), original)
                self.assertEqual(patched['__xctestrun_metadata__'], {'FormatVersion': version})

    def test_format_1_without_test_plan(self):
        self.assert_patched({
            '__xctestrun_metadata__': {'FormatVersion': 1},
            'CezarionTests': target('CezarionTests'),
            'CezarionUITests': target('CezarionUITests'),
        }, 1)

    def test_format_2_with_test_configuration(self):
        ui_target = target('CezarionUITests')
        del ui_target['EnvironmentVariables']
        self.assert_patched({
            '__xctestrun_metadata__': {'FormatVersion': 2},
            'TestConfigurations': [{'Name': 'Default', 'TestTargets': [target('CezarionTests'), ui_target]}],
        }, 2)

    def test_unsupported_shapes_fail_clearly_without_output(self):
        malformed = [
            [], {}, {'__xctestrun_metadata__': {'FormatVersion': 3}},
            {'__xctestrun_metadata__': {'FormatVersion': 1}, 'CezarionTests': 'wrong'},
            {'__xctestrun_metadata__': {'FormatVersion': 2}, 'TestConfigurations': {}},
            {'__xctestrun_metadata__': {'FormatVersion': 2}, 'TestConfigurations': [{'TestTargets': {}}]},
            {'__xctestrun_metadata__': {'FormatVersion': 1}},
            {'__xctestrun_metadata__': {'FormatVersion': 1}, 'CezarionTests': {}},
            {'__xctestrun_metadata__': {'FormatVersion': 1}, 'CezarionTests': {**target('CezarionTests'), 'EnvironmentVariables': 'wrong'}},
        ]
        for run in malformed:
            with self.subTest(run=run), tempfile.TemporaryDirectory() as directory:
                source = Path(directory) / 'Cezarion.xctestrun'
                original = plistlib.dumps(run)
                source.write_bytes(original)
                result = subprocess.run(['python3', '-', directory, 'fixture.new'], input=IOS_PROGRAM, text=True, capture_output=True)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('Unsupported xctestrun', result.stderr)
                self.assertEqual(result.stdout, '')
                self.assertFalse((Path(directory) / 'side-by-side.xctestrun').exists())
                self.assertEqual(source.read_bytes(), original)


class AndroidResultFixtures(unittest.TestCase):
    def run_result(self, output):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'result.txt').write_bytes(output)
            adb = root / 'adb'
            adb.write_text('#!/bin/sh\ncat "$FIXTURE_RESULT"\n')
            adb.chmod(0o755)
            env = {**os.environ, 'PATH': directory + os.pathsep + os.environ['PATH'], 'FIXTURE_RESULT': str(root / 'result.txt')}
            script = 'set -euo pipefail\nreports=$1\n' + ANDROID_CHECK + '\ncheck fixture.app testMethod\n'
            return subprocess.run(['bash', '-c', script, 'fixture', directory], env=env, text=True, capture_output=True)

    def test_documented_raw_pass_with_lf_and_crlf(self):
        for ending in [b'\n', b'\r\n']:
            result = self.run_result(ending.join([b'INSTRUMENTATION_STATUS: numtests=1', b'INSTRUMENTATION_STATUS_CODE: 1', b'INSTRUMENTATION_STATUS_CODE: 0', b'OK (1 test)', b'INSTRUMENTATION_CODE: -1', b'']))
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_ignored_assumed_failed_empty_or_malformed_results_fail(self):
        for output in [
            b'INSTRUMENTATION_STATUS_CODE: -3\nOK (1 test)\n',
            b'INSTRUMENTATION_STATUS_CODE: -4\nOK (1 test)\n',
            b'INSTRUMENTATION_STATUS_CODE: -2\nFAILURES!!!\n',
            b'OK (0 tests)\n', b'',
            b'INSTRUMENTATION_STATUS_CODE: 01\nOK (1 test)\n',
            b'INSTRUMENTATION_STATUS_CODE: 0\nOK (1 test) garbage\n',
        ]:
            with self.subTest(output=output):
                self.assertNotEqual(self.run_result(output).returncode, 0)


if __name__ == '__main__':
    unittest.main()
