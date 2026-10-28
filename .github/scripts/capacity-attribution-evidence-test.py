import importlib.util
import io
import json
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('evidence', Path(__file__).with_name('capacity-attribution-evidence.py'))
evidence = importlib.util.module_from_spec(spec)
spec.loader.exec_module(evidence)


class EvidenceTest(unittest.TestCase):
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
                evidence.main([str(root / 'raw'), str(root / 'bounded'), str(root / 'metadata'), '0', '1'])

    def test_observed_boundaries_and_all_markers(self):
        counts = {name: {field: 0 for field in evidence.extract.FIELDS} for name in evidence.extract.NAMES}
        report = json.dumps({'counts': counts, 'saturated': False, 'invalid': False, 'firstExhaustion': None})
        def row(output):
            return (json.dumps({'capacityOutput': output, 'exit': 1}) + '\n').encode()
        for raw, boundary, marker_count, valid in (
            (b'{"productionRow":"x"}\n', 'no-capacity-record', 0, 0),
            (row('capacity workload: 1\n'), 'capacity-without-marker', 0, 0),
            (row('CAPACITY_ATTRIBUTION broken\n'), 'invalid-report', 1, 0),
            (row('CAPACITY_ATTRIBUTION ' + report + '\n'), 'valid-report', 1, 1),
            (row(('CAPACITY_ATTRIBUTION ' + report + '\n') * 2), 'multiple-reports', 2, 2),
            (b'stderr startup failure\n', 'malformed-input', 0, 0)):
            with self.subTest(boundary=boundary):
                summary = evidence.summarize(io.BytesIO(raw), 7, 1)
                self.assertEqual(summary['observedBoundary'], boundary)
                self.assertEqual(summary['attributionMarkerCount'], marker_count)
                self.assertEqual(summary['validReportCount'], valid)
                self.assertEqual(summary['supervisorExit'], 7)
                if boundary in ('multiple-reports', 'malformed-input'):
                    self.assertIsNone(summary['capacityChildExit'])
        self.assertTrue(evidence.summarize(io.BytesIO(b'x' * (evidence.LIMIT + 1)), 1, 1)['inputTruncated'])

    def test_snapshot_only_on_extraction_failure(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / 'raw').write_bytes(b'{}\n')
            evidence.main([str(root / 'raw'), str(root / 'bounded'), str(root / 'metadata'), '7', '0'])
            self.assertFalse((root / 'bounded').exists())
            self.assertIsNone(json.loads((root / 'metadata').read_text())['rawSnapshot'])

    def test_workflow_preserves_exit_precedence(self):
        workflow = (Path(__file__).parents[1] / 'workflows/worker-destroy-linux-namespace.yml').read_text()
        supervisor = workflow.index('if (( diagnostic_status != 0 )); then exit "$diagnostic_status"; fi')
        extractor = workflow.index('if (( extraction_status != 0 )); then exit "$extraction_status"; fi')
        evidence_exit = workflow.index('exit "$evidence_status"')
        self.assertLess(supervisor, extractor)
        self.assertLess(extractor, evidence_exit)


if __name__ == '__main__':
    unittest.main()
