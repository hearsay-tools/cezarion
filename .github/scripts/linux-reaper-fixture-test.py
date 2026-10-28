"""Pure protocol checks; this file starts no processes and reads no proc files."""
import json
import pathlib
import runpy
import unittest
from unittest.mock import patch

fixture = runpy.run_path(str(pathlib.Path(__file__).with_name('linux_reaper_fixture.py')), run_name='cez_fixture_test')
invoke = fixture['invoke']


class ProtocolTest(unittest.TestCase):
    def setUp(self):
        self.row = {'version': 1, 'case': 'private-bind-closed-fd', 'resourceKind': 'worktree'}
        self.target = {'pid': 10, 'outer': 100}
        self.sibling = {'pid': 11, 'outer': 101}

    @staticmethod
    def fake_identity(pid, outer, uid):
        return {'pid': pid, 'outerPid': outer, 'startToken': 'boot:123', 'uid': uid}

    def response(self):
        return {'version': 1, 'status': 'passed', 'case': self.row['case'], 'action': 'stop',
                'resourceKind': 'worktree', 'code': 'ok', 'allowDelete': True, 'checkpointRetained': False, 'elapsedMs': 1,
                'target': self.fake_identity(10, 100, 0),
                'sibling': self.fake_identity(11, 101, 0)}

    def call(self, output):
        with patch.dict(invoke.__globals__, {'identity': self.fake_identity, 'bounded_output': lambda *_: output}):
            return invoke('/node', self.row, 'stop', self.target, self.sibling, 0, 0)

    def test_accepts_exact_one_line_and_identity(self):
        response = self.response()
        self.assertEqual(self.call((0, (json.dumps(response) + '\n').encode(), b'')), response)

    def test_refuses_multiple_lines_and_changed_identity(self):
        response = self.response()
        with self.assertRaisesRegex(RuntimeError, 'framing'):
            self.call((0, (json.dumps(response) + '\n{}\n').encode(), b''))
        response['sibling']['startToken'] = 'other:1'
        with self.assertRaisesRegex(RuntimeError, 'different process identity'):
            self.call((0, (json.dumps(response) + '\n').encode(), b''))


if __name__ == '__main__':
    unittest.main()
