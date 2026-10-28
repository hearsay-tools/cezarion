import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('eligible', Path(__file__).with_name('capacity-attribution-eligible.py'))
eligible = importlib.util.module_from_spec(spec)
spec.loader.exec_module(eligible)


def record(state='incomplete', remaining=None, status=1, idle=20, error='generic'):
    result = {'state': state, 'remaining': ['worktree', 'branch'] if remaining is None else remaining, 'error': error}
    output = 'capacity result: ' + json.dumps(result) + ', 2 reaper calls, 1210 ms\n'
    return {'capacityOutput': output, 'exit': status, 'idleChildren': idle}


def encode(*rows):
    return b''.join((json.dumps(row) + '\n').encode() for row in rows)


class EligibilityTest(unittest.TestCase):
    def test_incomplete_independent_of_error_and_process(self):
        for row in (record(), record(error='alias scan work exceeds bounds'), record(remaining=['process', 'branch'])):
            self.assertEqual(eligible.select(encode({'productionRow': 'x'}, row)), 'eligible')

    def test_complete_and_missing(self):
        self.assertEqual(eligible.select(encode(record('complete', [], 0), {'failure': True})), 'complete')
        self.assertEqual(eligible.select(encode({'failure': True})), 'missing-capacity')
        self.assertEqual(eligible.select(encode({'capacityOutput': 'startup failure', 'exit': 1, 'idleChildren': 20})), 'missing-result')
        with tempfile.TemporaryDirectory() as temp:
            self.assertEqual(eligible.main(Path(temp) / 'missing'), 'missing-log')

    def test_invalid_inputs(self):
        row = record()
        bad = [encode(row, row), b'{broken\n', encode(row)[:-1], b'x' * (eligible.LIMIT + 1),
               encode(record('other')), encode(record(remaining=[])), encode(record(remaining=['other'])),
               encode(record(remaining=['branch', 'branch'])), encode(record(status=0)),
               encode(record(status=True)), encode(record(status=256)), encode(record(idle=19)),
               encode(record(idle=20.0)), encode({**row, 'capacityOutput': row['capacityOutput'] * 2}),
               encode({**row, 'capacityOutput': 'capacity result: {broken\n'}),
               encode(record('complete', ['branch'])),
               b'{"capacityOutput":"x","capacityOutput":"y","exit":1,"idleChildren":20}\n',
               encode({**row, 'capacityOutput': 'capacity result: {"state":"complete","state":"incomplete","remaining":["branch"]}, 1 reaper calls, 2 ms\n'})]
        for value in bad:
            with self.subTest(value=value[:100]):
                self.assertEqual(eligible.select(value), 'invalid')


if __name__ == '__main__':
    unittest.main()
