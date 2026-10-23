// Prints the TextMate scopes the grammar assigns to each token of an ini file.
// Runs with the Node bundled in VS Code (no npm install needed):
//
//   APP="/Applications/Visual Studio Code.app/Contents"
//   ELECTRON_RUN_AS_NODE=1 "$APP/MacOS/Code" test/tokenize.js test/sample.ini
//
// Set VSCODE_NODE_MODULES if VS Code is installed elsewhere.
const fs = require('fs');
const path = require('path');

const modules = process.env.VSCODE_NODE_MODULES ||
  '/Applications/Visual Studio Code.app/Contents/Resources/app/node_modules.asar';
const tm = require(path.join(modules, 'vscode-textmate'));
const onig = require(path.join(modules, 'vscode-oniguruma'));

const grammarPath = path.join(__dirname, '..', 'syntaxes', 'omnetpp-ini.tmLanguage.json');
const wasm = fs.readFileSync(path.join(modules, 'vscode-oniguruma', 'release', 'onig.wasm')).buffer;

onig.loadWASM(wasm).then(async () => {
  const registry = new tm.Registry({
    onigLib: Promise.resolve({
      createOnigScanner: (patterns) => new onig.OnigScanner(patterns),
      createOnigString: (s) => new onig.OnigString(s),
    }),
    loadGrammar: async () => tm.parseRawGrammar(fs.readFileSync(grammarPath, 'utf8'), grammarPath),
  });
  const grammar = await registry.loadGrammar('source.omnetpp-ini');
  const lines = fs.readFileSync(process.argv[2], 'utf8').split(/\r?\n/);
  let state = tm.INITIAL;
  for (const line of lines) {
    const r = grammar.tokenizeLine(line, state);
    console.log(line);
    for (const t of r.tokens) {
      const text = line.substring(t.startIndex, t.endIndex);
      const scopes = t.scopes.slice(1).map((s) => s.replace(/\.omnetpp-ini$/, '')).join(' ');
      if (text.trim()) console.log(`    ${JSON.stringify(text).padEnd(28)} ${scopes}`);
    }
    state = r.ruleStack;
  }
});
