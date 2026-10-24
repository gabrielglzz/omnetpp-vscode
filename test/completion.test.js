// Completion of module paths in test/fixtures/project: a line is added to an
// ini file (in memory) and completion is asked at its end.
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, document, loadExtension } = require('./lib');

const PROJECT = path.join(__dirname, 'fixtures', 'project');

// Labels offered after `prefix`, written right after the heading of `section` in `rel`.
async function complete(rel, section, prefix) {
  const { iniIndex, providers, vscode } = await loadExtension(PROJECT);
  const lines = fs.readFileSync(path.join(PROJECT, rel), 'utf8').split('\n');
  const line = lines.findIndex((l) => l === `[${section}]` || l === `[Config ${section}]`) + 1;
  lines.splice(line, 0, prefix);
  const file = path.join(PROJECT, path.dirname(rel), 'completion.ini'); // not on disk
  const text = lines.join('\n');
  iniIndex.set(file, text);
  try {
    const result = await providers.completion.provideCompletionItems(document(file, text),
      new vscode.Position(line, prefix.length), {}, { triggerCharacter: prefix.slice(-1) });
    const items = Array.isArray(result) ? result : (result && result.items) || [];
    return new Set(items.map((i) => (typeof i.label === 'string' ? i.label : i.label.label)));
  } finally {
    iniIndex.delete(file);
  }
}

function check(labels, has, hasNot = []) {
  const missing = has.filter((l) => !labels.has(l));
  const extra = hasNot.filter((l) => labels.has(l));
  assert.ok(!missing.length && !extra.length,
    `${missing.length ? `missing ${missing.join(', ')}` : ''}${extra.length ? ` unexpected ${extra.join(', ')}` : ''}\n` +
    `offered: ${[...labels].join(', ')}`);
}

test('completion: submodules of the network in the folder of the ini file', async () => {
  check(await complete('beta/omnetpp.ini', 'General', '*.'), ['area', 'host'], ['inner', 'other']);
  check(await complete('alpha/omnetpp.ini', 'General', '*.'), ['other'], ['area', 'host']);
});

test('completion: a type nested in the network, not the one with the same name elsewhere', async () => {
  check(await complete('beta/omnetpp.ini', 'General', '*.area.'), ['numAreas', 'inner'], ['unrelated']);
});

test('completion: parameters declared with @enum("g(erp)")', async () => {
  check(await complete('beta/omnetpp.ini', 'General', '*.host.radio.'), ['opMode', 'bandName']);
});

test('completion: implementations of an interface that extends the one of the submodule', async () => {
  check(await complete('beta/omnetpp.ini', 'General', '*.host.gptp.'), ['numDomains', 'localPort']);
  check(await complete('beta/omnetpp.ini', 'General', '*.host.'), ['app[*]', 'gptp', 'radio', 'queue', 'numApps']);
});

test('completion: the network of the section and of the sections it extends', async () => {
  check(await complete('beta/omnetpp.ini', 'UsesOther', '*.'), ['srv'], ['area', 'host']);
  check(await complete('beta/omnetpp.ini', 'Child', '*.'), ['srv'], ['area', 'host']);
});
