#!/usr/bin/env python3
"""Regenerate data/options.json from the OMNeT++ installation.

Usage: OMNET_ROOT=/path/to/omnetpp ./gen-options.py [opp_run binary]

Parses `opp_run -h configdetails` (configuration options) and
`opp_run -h configvars` (predefined ${variables}).
"""
import json
import os
import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent


def run(binary, topic):
    out = subprocess.run([binary, '-h', topic], capture_output=True, text=True).stdout
    return out.splitlines()


def blocks(lines, header):
    """Yield (head line, [indented description lines]) after the header line."""
    start = next(i for i, l in enumerate(lines) if l.startswith(header)) + 1
    head, body = None, []
    for line in lines[start:]:
        if line and not line.startswith(' '):
            if head:
                yield head, body
            head, body = line, []
        elif head and line.strip():
            body.append(line.strip())
    if head:
        yield head, body


def join(lines):
    """Join wrapped lines into paragraphs; keep 'Usage:'/'Example' on their own line."""
    text = ''
    for line in lines:
        if text and re.match(r'(Usage|Example|Special values|Note)\b', line):
            text += '\n\n' + line
        else:
            text += (' ' if text else '') + line
    return text


def parse_options(lines):
    options = []
    for head, body in blocks(lines, 'Supported configuration options:'):
        m = re.match(r'(\*\*\.)?([^=]+)=<(\w+)>(.*)$', head)
        if not m:
            continue
        per_object, name, type_, rest = m.groups()
        unit = re.search(r'unit="([^"]*)"', rest)
        default = re.search(r'default:(.*)$', rest)
        kind = body[0] if body else ''
        if per_object:
            scope = 'per-object'
        elif kind.startswith('Global'):
            scope = 'global'
        else:
            scope = 'per-run'
        description = join(body[1:] if kind.endswith('.') and 'setting' in kind else body)
        options.append({
            'name': name,
            'type': type_,
            'unit': unit.group(1) if unit else None,
            'default': default.group(1).strip() if default else None,
            'scope': scope,
            'kind': kind.rstrip('.'),
            'description': description,
        })
    return options


def parse_variables(lines):
    return [{'name': head.strip()[2:-1], 'description': join(body)}
            for head, body in blocks(lines, 'Predefined variables')
            if head.startswith('${')]


def main():
    binary = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
        os.environ.get('OMNET_ROOT', '/opt/omnet6.1'), 'bin', 'opp_run')
    version = next((l for l in run(binary, 'config') if l.startswith('Version:')), '')
    data = {
        'generatedFrom': version.split(',')[0],
        'options': parse_options(run(binary, 'configdetails')),
        'variables': parse_variables(run(binary, 'configvars')),
    }
    out = HERE / 'data' / 'options.json'
    out.parent.mkdir(exist_ok=True)
    out.write_text(json.dumps(data, indent=1) + '\n')
    print(f"{out}: {len(data['options'])} options, {len(data['variables'])} variables ({data['generatedFrom']})")


if __name__ == '__main__':
    main()
