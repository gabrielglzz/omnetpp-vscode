// OMNeT++ projects: references, targets, build commands and changes, on
// projects written to a temporary folder.
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('./lib');
const project = require('../src/project');

const ext = process.platform === 'darwin' ? '.dylib' : '.so';

// Writes {relative path: content} under a new temporary folder.
function tree(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnetpp-vscode-'));
  for (const [f, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), content);
  }
  return dir;
}

const dotProject = (name, refs = []) => `<?xml version="1.0" encoding="UTF-8"?>
<projectDescription>
	<name>${name}</name>
	<projects>
${refs.map((r) => `		<project>${r}</project>`).join('\n')}
	</projects>
	<buildSpec><buildCommand><name>org.omnetpp.cdt.MakefileBuilder</name></buildCommand></buildSpec>
</projectDescription>
`;
const buildSpec = (...dirs) => `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<buildspec version="4.0">
${dirs.join('\n')}
</buildspec>
`;

// base (library in src/, a custom Makefile at the top, as INET), lib (library,
// uses base by project name) and app (executable, uses lib by folder name).
const ws = tree({
  'base-1.0/.project': dotProject('base'),
  'base-1.0/.oppbuildspec': buildSpec('<dir path="." type="custom"/>',
    '<dir makemake-options="--make-so --deep -o BASE -O out --meta:export-library" path="src" type="makemake"/>'),
  'base-1.0/Makefile': 'all:\n',
  'base-1.0/.nedfolders': 'src\nexamples\n',
  'base-1.0/src/Base.cc': '',
  'lib/.project': dotProject('myLib-2', ['base']),
  'lib/.oppbuildspec': buildSpec('<dir makemake-options="--make-so -I. --meta:export-include-path" path="." type="makemake"/>'),
  'lib/Lib.cc': '',
  'app/.project': dotProject('app', ['lib-1.0', 'lib']),
  'app/.oppbuildspec': buildSpec('<dir makemake-options="--deep -O out --meta:recurse --meta:use-exported-libs" path="." type="makemake"/>'),
  'app/App.cc': '',
  'app/App.ned': '',
  'app/out/clang-release/App.o': '',
});
const dir = (d) => path.join(ws, d);
const candidates = fs.readdirSync(ws).map(dir);

test('project: the projects a project uses, by name or folder name, before the ones that use them', () => {
  assert.deepStrictEqual(project.references(dir('app'), candidates), [dir('base-1.0'), dir('lib')]);
  assert.deepStrictEqual(project.references(dir('base-1.0'), candidates), []);
});

test('project: <NAME>_ROOT variables come from the project names', () => {
  assert.deepStrictEqual([dir('base-1.0'), dir('lib'), dir('app')].map(project.rootVariable), ['BASE_ROOT', 'MYLIB_2_ROOT', 'APP_ROOT']);
});

test('project: the target is the executable or shared library of the .oppbuildspec', () => {
  assert.deepStrictEqual(project.target(dir('app'), false, 'opp_run'), { command: [dir('app/app')], output: dir('app/app') });
  assert.deepStrictEqual(project.target(dir('app'), true, 'opp_run_dbg'), { command: [dir('app/app_dbg')], output: dir('app/app_dbg') });
  assert.deepStrictEqual(project.target(dir('base-1.0'), false, 'opp_run'),
    { command: ['opp_run', '-l', dir('base-1.0/src/BASE')], output: dir(`base-1.0/src/libBASE${ext}`) });
  assert.deepStrictEqual(project.target(dir('lib'), true, 'opp_run_dbg'),
    { command: ['opp_run_dbg', '-l', dir('lib/lib')], output: dir(`lib/liblib_dbg${ext}`) });
});

test('project: builds with the Makefile, or with opp_makemake and the options of the .oppbuildspec', () => {
  assert.strictEqual(project.buildCommand(dir('base-1.0'), false, 4), 'make -j4 MODE=release');
  assert.strictEqual(project.buildCommand(dir('lib'), true, 2),
    `(cd ${dir('lib')} && (test -f Makefile || opp_makemake -f --make-so -I.) && make -j2 MODE=debug)`);
  assert.deepStrictEqual(project.makemakeArgs(['--deep', '-O', 'out', '--meta:recurse']), ['-f', '--deep', '-O', 'out']);
});

test('project: sources and build files are changes, NED files and build output are not', () => {
  const at = (f, t) => fs.utimesSync(dir(f), t / 1000, t / 1000);
  const t0 = Date.now() + 10000;
  for (const f of ['app/App.cc', 'app/App.ned', 'app/out/clang-release/App.o', 'app/.oppbuildspec', 'base-1.0/src/Base.cc']) at(f, t0 - 5000);
  assert.strictEqual(project.changedSince(dir('app'), t0), false);
  at('app/App.ned', t0 + 1000);
  at('app/out/clang-release/App.o', t0 + 1000);
  assert.strictEqual(project.changedSince(dir('app'), t0), false);
  at('app/App.cc', t0 + 1000);
  assert.strictEqual(project.changedSince(dir('app'), t0), true);
  // In a project with a custom Makefile at the top, its makemake folders count
  at('base-1.0/src/Base.cc', t0 + 1000);
  assert.strictEqual(project.changedSince(dir('base-1.0'), t0), true);
});

test('project: libraries are changes only where asked for', () => {
  const t0 = Date.now() + 20000;
  fs.writeFileSync(dir(`base-1.0/src/libBASE${ext}`), '');
  fs.utimesSync(dir('base-1.0/src/Base.cc'), (t0 - 5000) / 1000, (t0 - 5000) / 1000);
  fs.utimesSync(dir(`base-1.0/src/libBASE${ext}`), (t0 + 1000) / 1000, (t0 + 1000) / 1000);
  assert.strictEqual(project.changedSince(dir('base-1.0'), t0), false);
  assert.strictEqual(project.changedSince(dir('base-1.0'), t0, project.LINKED), true);
});

test('project: .nedfolders and other lists skip comments and blank lines', () => {
  assert.deepStrictEqual(project.readList(dir('base-1.0'), '.nedfolders'), ['src', 'examples']);
  assert.deepStrictEqual(project.readList(dir('app'), '.nedexclusions'), []);
});
