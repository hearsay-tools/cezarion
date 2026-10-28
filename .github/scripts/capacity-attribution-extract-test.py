import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('extract', Path(__file__).with_name('capacity-attribution-extract.py'))
extract = importlib.util.module_from_spec(spec)
spec.loader.exec_module(extract)


class AttributionReportTest(unittest.TestCase):
    def test_fixed_numeric_schema(self):
        counts = {name: {field: 0 for field in extract.FIELDS} for name in extract.NAMES}
        report = {'counts': counts, 'saturated': False, 'invalid': False, 'firstExhaustion': None}
        self.assertEqual(extract.validate(report), report)
        for altered in ({**report, 'path': '/private'}, {**report, 'invalid': True},
                        {**report, 'counts': {'/private': {}}}):
            with self.assertRaises(ValueError):
                extract.validate(altered)

    def test_report_framing_and_output_failure(self):
        counts = {name: {field: 0 for field in extract.FIELDS} for name in extract.NAMES}
        report = json.dumps({'counts': counts, 'saturated': False, 'invalid': False, 'firstExhaustion': None})
        with tempfile.TemporaryDirectory() as temp:
            source, output = Path(temp) / 'raw', Path(temp) / 'out'
            def run(content):
                source.write_text(json.dumps({'capacityOutput': content}) + '\n')
                with patch.object(sys, 'argv', ['extract', str(source), str(output)]):
                    extract.main()
            for content in ('', 'CAPACITY_ATTRIBUTION broken\n', ('CAPACITY_ATTRIBUTION ' + report + '\n') * 2):
                with self.assertRaises(ValueError):
                    run(content)
            run('CAPACITY_ATTRIBUTION ' + report + '\n')
            with self.assertRaises(FileExistsError):
                run('CAPACITY_ATTRIBUTION ' + report + '\n')


if __name__ == '__main__':
    unittest.main()
