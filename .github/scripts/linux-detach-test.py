"""Pure checks: no mount, process, proc or signal operations."""
import os
import ast
import pathlib
import unittest
from linux_detach import check_mappings, detach_alias


class DetachTest(unittest.TestCase):
    def test_both_fixtures_use_checked_detachment(self):
        directory = pathlib.Path(__file__).parent
        for name, function in (('linux-mount-alias-probe.py', 'child'), ('linux_reaper_fixture.py', 'row_case')):
            tree = ast.parse((directory / name).read_text())
            owner = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == function)
            calls = [node for node in ast.walk(owner) if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == 'detach_alias']
            self.assertEqual(len(calls), 1, name)

    def test_lazy_detach_requires_absent_mount_and_verification(self):
        calls = []
        detach_alias('/fixture/alias', lambda *args: calls.append(args),
                     lambda: '1 0 8:1 / / rw - ext4 dev rw\n', lambda: calls.append('verified'))
        self.assertEqual(calls, [('umount', '-l', '/fixture/alias'), 'verified'])

    def test_attached_mount_and_submount_refuse_before_verification(self):
        for point in ('/fixture/alias', '/fixture/alias/nested'):
            calls = []
            with self.assertRaisesRegex(RuntimeError, 'remains attached'):
                detach_alias('/fixture/alias', lambda *args: calls.append(args),
                             lambda: f'1 0 8:1 / {point} rw - ext4 dev rw\n', lambda: calls.append('verified'))
            self.assertEqual(calls, [('umount', '-l', '/fixture/alias')])

    def test_failure_or_missing_mapping_refuses(self):
        dev = os.makedev(8, 1)
        check_mappings('1-2 r--p 0 08:01 42 /alias/mapped\n', [(dev, 42)])
        with self.assertRaisesRegex(RuntimeError, 'missing'):
            check_mappings('1-2 r--p 0 08:01 43 /alias/mapped\n', [(dev, 42)])
        with self.assertRaisesRegex(RuntimeError, 'detach failed'):
            detach_alias('/fixture/alias', lambda *_: (_ for _ in ()).throw(RuntimeError('detach failed')),
                         lambda: '', lambda: None)
        with self.assertRaisesRegex(RuntimeError, 'identity changed'):
            detach_alias('/fixture/alias', lambda *_: None, lambda: '1 0 8:1 / / rw - ext4 dev rw\n',
                         lambda: (_ for _ in ()).throw(RuntimeError('identity changed')))


if __name__ == '__main__': unittest.main()
