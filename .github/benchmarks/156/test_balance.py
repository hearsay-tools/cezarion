import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('balance', Path(__file__).with_name('balance.py'))
balance = importlib.util.module_from_spec(spec)
spec.loader.exec_module(balance)


class BalanceTest(unittest.TestCase):
    def test_console_durations_include_failed_suites(self):
        text = " ✓  server  src/one.test.ts (2 tests) 120ms\n ❯  web  src/two.test.tsx (3 tests | 1 failed) 42ms\n"
        self.assertEqual(balance.console_durations(text), {
            'packages/cezar/src/one.test.ts': 120,
            'packages/web/src/two.test.tsx': 42,
        })

    def test_longest_first_keeps_every_file_once(self):
        bins = balance.assign({'a': 9, 'b': 8, 'c': 3, 'd': 2}, 2)
        self.assertEqual(bins, [['a', 'd'], ['b', 'c']])
        self.assertEqual(sorted(sum(bins, [])), ['a', 'b', 'c', 'd'])

    def test_rejects_missing_measurement_instead_of_dropping_test(self):
        with self.assertRaisesRegex(ValueError, 'inventory'):
            balance.validate_inventory([['a'], ['b']], ['a', 'b', 'c'])
        with self.assertRaisesRegex(ValueError, 'duplicate'):
            balance.validate_inventory([['a'], ['a', 'b']], ['a', 'b'])


if __name__ == '__main__':
    unittest.main()
