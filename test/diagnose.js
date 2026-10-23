// Prints the extension's diagnostics for every ini file under a directory.
//
//   ELECTRON_RUN_AS_NODE=1 "/Applications/Visual Studio Code.app/Contents/MacOS/Code" test/diagnose.js <dir>
const fs = require('fs');
const path = require('path');
const { IniIndex } = require('../src/index');
const { diagnose } = require('../src/diagnostics');

function findIni(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'out') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) findIni(p, out);
    else if (e.name.endsWith('.ini')) out.push(p);
  }
  return out;
}

const root = path.resolve(process.argv[2] || '.');
const index = new IniIndex((f) => {
  try { return fs.readFileSync(f, 'utf8'); } catch { return undefined; }
});
const files = findIni(root);
for (const f of files) index.get(f);
let n = 0;
for (const f of files) {
  for (const d of diagnose(f, index)) {
    n++;
    console.log(`${path.relative(root, f)}:${d.line + 1}:${d.start + 1}: ${d.severity}: ${d.message}`);
  }
}
console.log(`${files.length} files, ${n} diagnostics`);
