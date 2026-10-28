"""Extract only the fixed numeric ledger from the disposable supervisor output."""
import json
import sys

NAMES = ('procRead', 'mountParse', 'ownedRootLocate', 'mapParseAndVariants', 'literalMapped',
         'intersectionBuild', 'filter', 'ancestorLookup', 'candidateConstruct', 'sort',
         'identityPrecharge', 'evidenceRecheck', 'sweepAndLinks', 'reservation', 'unclassified')
FIELDS = ('attemptedUnits', 'successfulChargeUnits', 'refusedChargeUnits')
SITES = ('linePrecharge', 'rootRelevance', 'variantExpansion', 'finalMembership', 'caughtProbe')


def counts(value):
    if not isinstance(value, dict) or set(value) != set(NAMES):
        raise ValueError('invalid category schema')
    for row in value.values():
        if not isinstance(row, dict) or set(row) != set(FIELDS):
            raise ValueError('invalid count schema')
        if any(type(n) is not int or n < 0 or n > 2147483647 for n in row.values()):
            raise ValueError('invalid count')


def validate(value):
    if not isinstance(value, dict) or set(value) != {'version', 'counts', 'saturated', 'invalid', 'sitesSaturated', 'literalMappedSites', 'firstExhaustion'}:
        raise ValueError('invalid report schema')
    if type(value['saturated']) is not bool or type(value['invalid']) is not bool or value['invalid']:
        raise ValueError('invalid report flags')
    if type(value['version']) is not int or value['version'] != 3 or type(value['sitesSaturated']) is not bool:
        raise ValueError('invalid report version or site flag')
    counts(value['counts'])
    sites = value['literalMappedSites']
    if not isinstance(sites, dict) or set(sites) != set(SITES):
        raise ValueError('invalid site schema')
    for row in sites.values():
        if not isinstance(row, dict) or set(row) != set(FIELDS + ('attemptedCalls',)):
            raise ValueError('invalid site counts')
        if any(type(n) is not int or n < 0 or n > 2147483647 for n in row.values()):
            raise ValueError('invalid site count')
    if not value['saturated'] and not value['sitesSaturated']:
        if any(row['attemptedUnits'] != row['successfulChargeUnits'] + row['refusedChargeUnits'] for row in sites.values()):
            raise ValueError('invalid site accounting')
        if any(sum(row[field] for row in sites.values()) != value['counts']['literalMapped'][field] for field in FIELDS):
            raise ValueError('invalid site partition')
    first = value['firstExhaustion']
    if first is not None:
        if not isinstance(first, dict) or set(first) != {'category', 'amount', 'remaining', 'snapshot'}:
            raise ValueError('invalid exhaustion schema')
        if first['category'] not in NAMES or type(first['amount']) is not int or type(first['remaining']) is not int:
            raise ValueError('invalid exhaustion')
        counts(first['snapshot'])
    return value


def main():
    if len(sys.argv) != 3:
        raise ValueError('expected input and output')
    reports = []
    with open(sys.argv[1], encoding='utf8') as source:
        for line in source:
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(row, dict) or not isinstance(row.get('capacityOutput'), str):
                continue
            for item in row['capacityOutput'].splitlines():
                if item.startswith('CAPACITY_ATTRIBUTION '):
                    reports.append(validate(json.loads(item[len('CAPACITY_ATTRIBUTION '):])))
    if len(reports) != 1:
        raise ValueError('expected one capacity attribution report')
    with open(sys.argv[2], 'x', encoding='utf8') as output:
        json.dump(reports[0], output, sort_keys=True)
        output.write('\n')


if __name__ == '__main__':
    main()
