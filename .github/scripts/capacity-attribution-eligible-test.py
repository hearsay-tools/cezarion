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


TRACE = (b'Traceback (most recent call last):\n'
         b'  File "/home/runner/.github/scripts/linux-mount-alias-probe.py", line 409, in <module>\n'
         b'    main()\n'
         b'  File "/home/runner/.github/scripts/linux-mount-alias-probe.py", line 400, in main\n'
         b"    run_probe(fixture, notify_fd, release_fd, observer, production_node, proof, gated_production and sys.argv[5] == 'capacity')\n"
         b'  File "/home/runner/.github/scripts/linux-mount-alias-probe.py", line 351, in run_probe\n'
         b"    raise RuntimeError('namespace capability unavailable' if unavailable else 'namespace probe failed')\n"
         b'RuntimeError: namespace probe failed\n')


class EligibilityTest(unittest.TestCase):
    def test_observation_keeps_full_stream_eligible(self):
        row = record()
        row['capacityOutput'] += 'capacity reapers: total=2 outcomes=fulfilled,budget-rejected omitted=no\n'
        self.assertEqual(eligible.select(encode({'productionRow': 'x'}, row) + TRACE), 'eligible')

    def test_incomplete_independent_of_error_and_process(self):
        for row in (record(), record(error='alias scan work exceeds bounds'), record(remaining=['process', 'branch'])):
            self.assertEqual(eligible.select(encode({'productionRow': 'x'}, row)), 'eligible')

    def test_complete_and_missing(self):
        self.assertEqual(eligible.select(encode(record('complete', [], 0), {'failure': True})), 'complete')
        self.assertEqual(eligible.select(encode({'failure': True})), 'missing-capacity')
        self.assertEqual(eligible.select(encode({'capacityOutput': 'startup failure', 'exit': 1, 'idleChildren': 20})), 'missing-result')
        with tempfile.TemporaryDirectory() as temp:
            self.assertEqual(eligible.main(Path(temp) / 'missing'), 'missing-log')

    def test_reviewed_terminal_traceback(self):
        for row in (record(), record(error='alias scan work exceeds bounds')):
            self.assertEqual(eligible.select(encode({'fixture': 'x'}, row) + TRACE), 'eligible')
        self.assertEqual(eligible.select(encode(record('complete', [], 0)) + TRACE), 'complete')
        invalid = [TRACE, TRACE + encode(record()), encode({'fixture': 'x'}) + TRACE,
                   encode({'capacityOutput': 'not ready', 'exit': 1, 'idleChildren': 20}) + TRACE,
                   encode(record(), record()) + TRACE, b'{bad\n' + encode(record()) + TRACE,
                   encode({**record(), 'capacityOutput': record()['capacityOutput'] * 2}) + TRACE,
                   encode({**record(), 'capacityOutput': 'capacity result: {broken\n'}) + TRACE,
                   encode(record()) + TRACE.replace(b'    main()\n', encode(record())),
                   encode(record()) + TRACE.replace(b'    main()\n', b'capacity result: {}\n'),
                   encode(record()) + TRACE[:100], b'x' * eligible.LIMIT + TRACE,
                   encode(record()) + TRACE[:-1], encode(record()) + TRACE + b'\n',
                   encode(record()) + TRACE + encode({'capacityOutput': 'x'}),
                   encode(record()) + TRACE + TRACE,
                   encode(record()) + TRACE.replace(b'RuntimeError: namespace probe failed\n', b'RuntimeError: other\n'),
                   encode(record()) + TRACE.replace(b'line 400', b'line 401'),
                   encode(record()) + TRACE.replace(b'    main()', b'    changed()'),
                   encode(record()) + TRACE.replace(b'/home/runner/', b'/other/', 1),
                   encode(record()) + TRACE.replace(b'/home/runner/', b'/home/capacityOutput/'),
                   encode(record()) + TRACE.replace(b'/home/runner/', b'/home/capacity result:/'),
                   encode(record()) + TRACE.replace(b'    main()', b'  {"other": 1}'),
                   encode(record()) + TRACE.replace(b'    main()\n', b'    main()\n    ^\n'),
                   encode(record()) + TRACE.replace(b'    main()\n', b'    main()\n\n'),
                   encode(record()) + TRACE.replace(b'RuntimeError: namespace probe failed', b'ValueError: namespace probe failed'),
                   encode(record()) + TRACE + b'During handling of the above exception\n',
                   encode(record()) + TRACE.replace(b'  File ', b'  File "bad"\n  File ', 1),
                   encode(record()) + TRACE.replace(b'/home/runner/', b'/home/runner/\x00', 1),
                   encode(record()) + TRACE.replace(b'    main()', b'    \xff'),
                   encode(record()) + TRACE.replace(b'    main()', b' capacity result: {}'),
                   b'{"capacityOutput":"x","capacityOutput":"y"}\n' + encode(record()) + TRACE]
        for value in invalid:
            with self.subTest(value=value[:100]):
                self.assertEqual(eligible.select(value), 'invalid')

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
