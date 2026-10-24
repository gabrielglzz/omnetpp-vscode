// Diagnostics of every ini file in test/fixtures/project, compared with the
// `# expect <severity>: <part of the message>` comments on each line.
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, walk, loadExtension } = require('./lib');

const PROJECT = path.join(__dirname, 'fixtures', 'project');
const EXPECT = /#\s*expect\s+(error|warning):\s*(.*?)\s*$/;

for (const file of walk(PROJECT, '.ini').sort()) {
  test(`diagnostics: ${path.relative(PROJECT, file)}`, async () => {
    const { diagnostics } = await loadExtension(PROJECT);
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    const expected = lines.map((l, i) => {
      const m = EXPECT.exec(l);
      return m && { line: i, severity: m[1], text: m[2] };
    }).filter(Boolean);
    const actual = diagnostics(file);
    const problems = [];
    for (const d of actual) {
      if (!expected.some((x) => x.line === d.line && x.severity === d.severity && d.message.includes(x.text))) {
        problems.push(`unexpected at line ${d.line + 1}: ${d.severity}: ${d.message}`);
      }
    }
    for (const x of expected) {
      if (!actual.some((d) => x.line === d.line && x.severity === d.severity && d.message.includes(x.text))) {
        problems.push(`missing at line ${x.line + 1}: ${x.severity}: ${x.text}`);
      }
    }
    assert.ok(!problems.length, problems.join('\n'));
  });
}
