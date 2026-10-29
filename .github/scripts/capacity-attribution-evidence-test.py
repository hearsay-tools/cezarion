import importlib.util
import io
import json
import subprocess
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('evidence', Path(__file__).with_name('capacity-attribution-evidence.py'))
evidence = importlib.util.module_from_spec(spec)
spec.loader.exec_module(evidence)


class EvidenceTest(unittest.TestCase):
    def test_observation_does_not_change_ledger_boundary(self):
        counts = {name: {field: 0 for field in evidence.extract.FIELDS} for name in evidence.extract.NAMES}
        report = json.dumps({'version': 3, 'counts': counts, 'saturated': False, 'invalid': False, 'sitesSaturated': False, 'literalMappedSites': {name: {field: 0 for field in evidence.extract.FIELDS + ('attemptedCalls',)} for name in evidence.extract.SITES}, 'firstExhaustion': None})
        output = 'capacity workload: 1\ncapacity result: {}, 2 reaper calls, 1 ms\nCAPACITY_ATTRIBUTION ' + report + '\n'
        def summary(value):
            return evidence.summarize(io.BytesIO((json.dumps({'capacityOutput': value, 'exit': 1}) + '\n').encode()), 1, 0, 0)
        before = summary(output)
        after = summary(output + 'capacity reapers: total=2 outcomes=fulfilled,budget-rejected omitted=no\n')
        self.assertGreater(after.pop('rawBytes'), before.pop('rawBytes'))
        self.assertEqual(before, after)

    def test_boundaries_and_raw_failure_shapes(self):
        for data in (b'', b'stderr only\n', b'no capacity row\n', b'CAPACITY_ATTRIBUTION malformed\n',
                     b'CAPACITY_ATTRIBUTION valid\nCAPACITY_ATTRIBUTION duplicate\n',
                     b'x' * evidence.LIMIT, b'a' * evidence.EDGE + b'b' * evidence.LIMIT + b'c' * evidence.EDGE):
            with self.subTest(size=len(data)):
                output = io.BytesIO()
                meta = evidence.retain(io.BytesIO(data), output)
                truncated = len(data) > evidence.LIMIT
                expected = data[:evidence.EDGE] + data[-evidence.EDGE:] if truncated else data
                self.assertEqual(output.getvalue(), expected)
                self.assertEqual(meta, {'originalBytes': len(data), 'retainedBytes': len(expected),
                    'omittedBytes': len(data) - len(expected), 'truncated': truncated})

    def test_write_failure_and_existing_metadata_fail(self):
        class BadWriter:
            def write(self, data):
                raise OSError('write failed')
        with self.assertRaises(OSError):
            evidence.retain(io.BytesIO(b'failure'), BadWriter())
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / 'raw').write_bytes(b'report')
            (root / 'metadata').write_text('existing')
            with self.assertRaises(FileExistsError):
                evidence.main([str(root / 'raw'), str(root / 'bounded'), str(root / 'metadata'), '0', '0', '1'])

    def test_observed_boundaries_and_all_markers(self):
        counts = {name: {field: 0 for field in evidence.extract.FIELDS} for name in evidence.extract.NAMES}
        report = json.dumps({'version': 3, 'counts': counts, 'saturated': False, 'invalid': False, 'sitesSaturated': False, 'literalMappedSites': {name: {field: 0 for field in evidence.extract.FIELDS + ('attemptedCalls',)} for name in evidence.extract.SITES}, 'firstExhaustion': None})
        def row(output):
            return (json.dumps({'capacityOutput': output, 'exit': 1}) + '\n').encode()
        for raw, boundary, marker_count, valid in (
            (b'{"productionRow":"x"}\n', 'no-capacity-record', 0, 0),
            (row('capacity workload: 1\n'), 'capacity-without-marker', 0, 0),
            (row('CAPACITY_ATTRIBUTION broken\n'), 'invalid-report', 1, 0),
            (row('CAPACITY_ATTRIBUTION ' + report + '\n'), 'valid-report', 1, 1),
            (row('CAPACITY_ATTRIBUTION_INVALID\n'), 'invalid-report', 1, 0),
            (row('CAPACITY_ATTRIBUTION ' + report + '\nCAPACITY_ATTRIBUTION_INVALID\n'), 'multiple-reports', 2, 1),
            (row('CAPACITY_ATTRIBUTION_INVALID\n' * 2), 'multiple-reports', 2, 0),
            (row(('CAPACITY_ATTRIBUTION ' + report + '\n') * 2), 'multiple-reports', 2, 2),
            (b'stderr startup failure\n', 'malformed-input', 0, 0)):
            with self.subTest(boundary=boundary):
                summary = evidence.summarize(io.BytesIO(raw), 7, 2, 1)
                self.assertEqual(summary['observedBoundary'], boundary)
                self.assertEqual(summary['attributionMarkerCount'], marker_count)
                self.assertEqual(summary['validReportCount'], valid)
                self.assertEqual(summary['supervisorExit'], 7)
                self.assertEqual(summary['outputSinkExit'], 2)
                if b'CAPACITY_ATTRIBUTION_INVALID' in raw:
                    self.assertTrue(summary['invalidMarkerSeen'])
                if boundary in ('multiple-reports', 'malformed-input'):
                    self.assertIsNone(summary['capacityChildExit'])
        self.assertTrue(evidence.summarize(io.BytesIO(b'x' * (evidence.LIMIT + 1)), 1, 0, 1)['inputTruncated'])

    def test_snapshot_only_on_extraction_failure(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / 'raw').write_bytes(b'{}\n')
            evidence.main([str(root / 'raw'), str(root / 'bounded'), str(root / 'metadata'), '7', '0', '0'])
            self.assertFalse((root / 'bounded').exists())
            self.assertIsNone(json.loads((root / 'metadata').read_text())['rawSnapshot'])

    def test_workflow_preserves_exit_precedence(self):
        workflow = (Path(__file__).parents[1] / 'workflows/worker-destroy-linux-namespace.yml').read_text()
        supervisor = workflow.index('if (( diagnostic_status != 0 )); then exit "$diagnostic_status"; fi')
        sink = workflow.index('if (( sink_status != 0 )); then exit "$sink_status"; fi')
        extractor = workflow.index('if (( extraction_status != 0 )); then exit "$extraction_status"; fi')
        evidence_exit = workflow.index('exit "$evidence_status"')
        self.assertLess(supervisor, sink)
        self.assertLess(sink, extractor)
        self.assertLess(extractor, evidence_exit)

    def test_real_pipeline_status_capture(self):
        workflow = (Path(__file__).parents[1] / 'workflows/worker-destroy-linux-namespace.yml').read_text()
        capture = workflow.split('pipeline_status=("${PIPESTATUS[@]}")', 1)[1].split('          python3 ', 1)[0]
        assertions = workflow.split('if (( diagnostic_status != 0 ));', 1)[1].split('          exit "$evidence_status"', 1)[0]
        for producer, sink in ((0, 0), (7, 0), (0, 1), (7, 1)):
            script = ('set -o pipefail\nset +e\n'
                      'bash -c "exit $1" | bash -c "exit $2"\n'
                      'pipeline_status=("${PIPESTATUS[@]}")\n' + capture +
                      'printf "%s %s\\n" "$diagnostic_status" "$sink_status"\n'
                      'extraction_status=0\nevidence_status=0\n'
                      'if (( diagnostic_status != 0 ));' + assertions + 'exit "$evidence_status"\n')
            result = subprocess.run(['bash', '-c', script, '--', str(producer), str(sink)], capture_output=True, text=True, check=False)
            self.assertEqual(result.stdout.strip(), f'{producer} {sink}', result.stderr)
            self.assertEqual(result.returncode, producer or sink, result.stderr)


if __name__ == '__main__':
    unittest.main()
