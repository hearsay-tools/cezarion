import importlib.util
from pathlib import Path
import unittest

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


if __name__ == '__main__':
    unittest.main()
