// Line continuations, strings and comments. The expected keys, values and
// errors are what `opp_run -q runconfig` of OMNeT++ 6.4 reports for each text.
'use strict';

const assert = require('assert');
const { test } = require('./lib');
const { parse } = require('../src/parser');

const ini = (...lines) => `[General]\n${lines.join('\n')}\n`;
const entries = (doc) => doc.entries.map((e) => [e.key, e.value.replace(/\s+/g, ' ')]);
const errors = (doc) => doc.errors.map((e) => [e.line + 1, e.message]);

test('parser: a string goes on after a backslash continuation', () => {
  const doc = parse(ini('**.a = xml("<config> \\', '    <x/> \\', '  </config>")', '**.b = 2'));
  assert.deepStrictEqual(entries(doc), [['**.a', 'xml("<config> <x/> </config>")'], ['**.b', '2']]);
  assert.deepStrictEqual(errors(doc), []);
});

test('parser: a string cannot go on in an indented continuation line', () => {
  const doc = parse(ini('**.a = "abc', '    def"', '**.b = 2'));
  assert.deepStrictEqual(errors(doc), [[2, 'Unterminated string constant'], [3, 'Unterminated string constant']]);
});

test('parser: a comment hides the lines joined to it with a backslash', () => {
  const doc = parse(ini('**.a = 1 # comment \\', '**.b = 2', '**.c = 3'));
  assert.deepStrictEqual(entries(doc), [['**.a', '1'], ['**.c', '3']]);
});

test('parser: the key may go on in a continuation line', () => {
  const doc = parse(ini('**.a.\\', 'b = 1', '**.c \\', '  = 2', '**.d', '  = 3', '**.e = \\', '  4'));
  assert.deepStrictEqual(entries(doc), [['**.a.b', '1'], ['**.c', '2'], ['**.d', '3'], ['**.e', '4']]);
  assert.deepStrictEqual(errors(doc), []);
  assert.deepStrictEqual(doc.entries[1].valueSegs.map((s) => [s.line + 1, s.start]), [[5, 3]]);
});

test('parser: spaces after a backslash stay in the key, as in OMNeT++', () => {
  // From INET's doc/src/users-guide/lib/Snippets.ini
  const doc = parse(ini('**.energyConsumer. \\', '   transmitterPower = 100mW # continue'));
  assert.deepStrictEqual(entries(doc), [['**.energyConsumer.    transmitterPower', '100mW']]);
});

test('parser: a line without = is an error', () => {
  const doc = parse(ini('**.a \\', '  b'));
  assert.deepStrictEqual(errors(doc), [[2, 'Line must be in the form key=value']]);
});
