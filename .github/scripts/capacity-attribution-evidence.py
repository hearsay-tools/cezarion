"""Bound the already captured raw supervisor output; this is not the numeric ledger."""
import json
import importlib.util
import sys
from pathlib import Path

LIMIT = 4 * 1024 * 1024
EDGE = 64 * 1024
spec = importlib.util.spec_from_file_location('capacity_extract', Path(__file__).with_name('capacity-attribution-extract.py'))
extract = importlib.util.module_from_spec(spec)
spec.loader.exec_module(extract)


def summarize(source, diagnostic_status, extraction_status):
    source.seek(0, 2)
    size = source.tell()
    source.seek(0)
    truncated = size > LIMIT
    data = source.read(LIMIT)
    errors = rows = capacity = markers = valid = 0
    invalid = workload = result = complete = False
    child_exits = []
    for line in data.splitlines():
        try:
            record = json.loads(line)
        except (ValueError, UnicodeDecodeError):
            errors += 1
            continue
        if not isinstance(record, dict):
            errors += 1
            continue
        rows += int('productionRow' in record)
        complete |= record.get('productionComplete') is True
        if 'capacityOutput' not in record:
            continue
        capacity += 1
        output = record['capacityOutput']
        exit_code = record.get('exit')
        if not isinstance(output, str) or type(exit_code) is not int or not 0 <= exit_code <= 255:
            errors += 1
            continue
        child_exits.append(exit_code)
        workload |= 'capacity workload:' in output
        result |= 'capacity result:' in output
        for item in output.splitlines():
            if not item.startswith('CAPACITY_ATTRIBUTION '):
                continue
            markers += 1
            try:
                extract.validate(json.loads(item[len('CAPACITY_ATTRIBUTION '):]))
                valid += 1
            except (ValueError, TypeError):
                invalid = True
    if truncated or errors:
        boundary = 'malformed-input'
    elif capacity == 0:
        boundary = 'no-capacity-record'
    elif capacity != 1 or markers > 1:
        boundary = 'multiple-reports'
    elif markers == 0:
        boundary = 'capacity-without-marker'
    elif invalid:
        boundary = 'invalid-report'
    elif valid == 1:
        boundary = 'valid-report'
    else:
        boundary = 'unknown'
    child_exit = child_exits[0] if capacity == 1 and len(child_exits) == 1 and not truncated and not errors and markers <= 1 else None
    return {'schemaVersion': 1, 'supervisorExit': diagnostic_status, 'extractorExit': extraction_status,
            'rawBytes': size, 'inputTruncated': truncated, 'parseErrorCount': errors,
            'productionRowRecordCount': rows, 'capacityRecordCount': capacity, 'attributionMarkerCount': markers,
            'validReportCount': valid, 'invalidMarkerSeen': invalid, 'workloadMarkerSeen': workload,
            'resultMarkerSeen': result, 'productionCompleteSeen': complete, 'capacityChildExit': child_exit,
            'observedBoundary': boundary}


def retain(source, output):
    source.seek(0, 2)
    size = source.tell()
    source.seek(0)
    truncated = size > LIMIT
    if truncated:
        first = source.read(EDGE)
        source.seek(-EDGE, 2)
        data = first + source.read(EDGE)
    else:
        data = source.read()
    expected = 2 * EDGE if truncated else size
    if len(data) != expected:
        raise OSError('incomplete evidence read')
    if output.write(data) != len(data):
        raise OSError('incomplete evidence write')
    return {'originalBytes': size, 'retainedBytes': len(data), 'omittedBytes': size - len(data),
            'truncated': truncated}


def main(args):
    if len(args) != 5:
        raise ValueError('expected input, output, metadata and two exit codes')
    source, output, metadata, supervisor, extractor = args
    statuses = [int(supervisor), int(extractor)]
    if any(status < 0 or status > 255 for status in statuses):
        raise ValueError('invalid exit status')
    with open(source, 'rb') as reader:
        result = summarize(reader, *statuses)
        result['rawSnapshot'] = None
        if statuses[1] != 0:
            with open(output, 'xb') as writer:
                result['rawSnapshot'] = retain(reader, writer)
    with open(metadata, 'x', encoding='utf8') as writer:
        json.dump(result, writer, sort_keys=True)
        writer.write('\n')


if __name__ == '__main__':
    main(sys.argv[1:])
