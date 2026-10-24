// OMNeT++ projects as the IDE describes them: the projects they use
// (.project), their build (.oppbuildspec), and their NED folders
// (.nedfolders, .nedexclusions). Does not depend on VS Code.
'use strict';

const fs = require('fs');
const path = require('path');

function readFile(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

// Non-empty lines of a project file, without # comments.
function readList(dir, file) {
  return readFile(path.join(dir, file)).split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
}

function splitArgs(s) {
  return s.trim() ? s.trim().split(/\s+/) : [];
}

// Single-quotes an argument for the shell when needed.
function quote(arg) {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${String(arg).replace(/'/g, `'\\''`)}'`;
}

// ---------------------------------------------------------------- .project

// Name of the project in its .project file, or its folder name.
function projectName(dir) {
  const m = /<projectDescription>[\s\S]*?<name>([^<]*)<\/name>/.exec(readFile(path.join(dir, '.project')));
  return m ? m[1].trim() : path.basename(dir);
}

// Names of the projects that .project says the project uses.
function referenceNames(dir) {
  const m = /<projects>([\s\S]*?)<\/projects>/.exec(readFile(path.join(dir, '.project')));
  return m ? [...m[1].matchAll(/<project>([^<]*)<\/project>/g)].map((p) => p[1].trim()) : [];
}

// Folders of the projects `dir` uses, directly or through other projects,
// each before the projects that use it. A project is looked up by its name or
// its folder name among `candidates` (folders that may hold projects: the
// workspace folders and their neighbours, as in an IDE workspace).
function references(dir, candidates) {
  const found = [];
  const seen = new Set([path.resolve(dir)]);
  const visit = (d) => {
    for (const name of referenceNames(d)) {
      const ref = candidates.find((c) => !seen.has(path.resolve(c)) && fs.existsSync(path.join(c, '.project'))
        && (path.basename(c) === name || projectName(c) === name));
      if (!ref) continue;
      seen.add(path.resolve(ref));
      visit(ref);
      found.push(ref);
    }
  };
  visit(dir);
  return found;
}

// Environment variable with the folder of a project, as projects name it in
// their makefiles and scripts: INET_ROOT for inet, SIMU5G_ROOT for simu5G.
function rootVariable(dir) {
  return `${projectName(dir).toUpperCase().replace(/[^A-Z0-9]/g, '_')}_ROOT`;
}

// ---------------------------------------------------------------- .oppbuildspec

// Folders of the .oppbuildspec (written by the OMNeT++ IDE):
// [{dir, type, options}], type being 'makemake' (Makefile generated with
// opp_makemake and `options`) or 'custom' (hand-written Makefile).
function buildSpecDirs(dir) {
  return [...readFile(path.join(dir, '.oppbuildspec')).matchAll(/<dir\b([^>]*)>/g)].map((m) => {
    const attr = (name) => (new RegExp(`\\b${name}="([^"]*)"`).exec(m[1]) || [])[1];
    return { dir: path.join(dir, attr('path') || '.'), type: attr('type'), options: splitArgs(attr('makemake-options') || '') };
  });
}

// Target of the first linked makemake folder of the .oppbuildspec:
// {dir, name, library}, or null. opp_makemake names it after its folder
// unless -o is given, and builds a shared library with --make-so (-s).
function buildSpecTarget(dir) {
  for (const { dir: d, type, options: opts } of buildSpecDirs(dir)) {
    if (type !== 'makemake' || opts.includes('--nolink') || opts.includes('-a') || opts.includes('--make-lib')) continue;
    const o = opts.findIndex((x) => x.startsWith('-o'));
    const name = o < 0 ? path.basename(d) : opts[o] === '-o' ? opts[o + 1] : opts[o].slice(2);
    return { dir: d, name, library: opts.includes('--make-so') || opts.includes('-s') };
  }
  return null;
}

// What runs the simulation of a project, in release or debug mode:
// {command, output}, `command` being the program and its first arguments and
// `output` the file the build produces (null if there is nothing to build).
// It is the target of the .oppbuildspec (an executable, or a shared library
// loaded with `oppRun` -l), or the executable opp_makemake builds in the
// project folder (named after it), or `oppRun`. Debug builds have the _dbg
// suffix.
function target(dir, debug, oppRun) {
  const d = debug ? '_dbg' : '';
  const exeSuffix = process.platform === 'win32' ? '.exe' : '';
  const t = buildSpecTarget(dir);
  if (t && t.library) {
    const lib = process.platform === 'win32' ? `${t.name}${d}.dll`
      : `lib${t.name}${d}${process.platform === 'darwin' ? '.dylib' : '.so'}`;
    return { command: [oppRun, '-l', path.join(t.dir, t.name)], output: path.join(t.dir, lib) };
  }
  if (t) {
    const exe = path.join(t.dir, t.name + d + exeSuffix);
    return { command: [exe], output: exe };
  }
  const exe = path.join(dir, path.basename(dir) + d + exeSuffix);
  if (debug || fs.existsSync(exe) || fs.existsSync(path.join(dir, 'Makefile'))) return { command: [exe], output: exe };
  return { command: [oppRun], output: null };
}

// opp_makemake arguments for the options of a makemake folder, as the IDE
// passes them: with -f, and without the --meta: options, which only the IDE
// understands.
function makemakeArgs(options) {
  const args = options.filter((o) => !o.startsWith('--meta:'));
  return args.includes('-f') || args.includes('--force') ? args : ['-f', ...args];
}

// Command that builds a project, run from its folder: `make -j<jobs>
// MODE=release|debug` if it has a Makefile, or else in each makemake folder of
// the .oppbuildspec, creating its Makefile with opp_makemake if it is missing.
// Null if there is no way to build it.
function buildCommand(dir, debug, jobs) {
  const make = `make -j${jobs} MODE=${debug ? 'debug' : 'release'}`;
  if (fs.existsSync(path.join(dir, 'Makefile'))) return make;
  // Subfolders first: the folders above may link what they build
  const dirs = buildSpecDirs(dir).filter((d) => d.type === 'makemake').sort((a, b) => b.dir.length - a.dir.length);
  if (!dirs.length) return null;
  return dirs.map((d) => `(cd ${quote(d.dir)} && (test -f Makefile || opp_makemake ${makemakeArgs(d.options).map(quote).join(' ')}) && ${make})`).join(' && ');
}

// ---------------------------------------------------------------- changes

// Files a simulation is built from, and in the projects it uses (or other
// folders it depends on) also the libraries it links.
const SOURCES = /\.(cc|cpp|cxx|c|h|hh|hpp|hxx|msg|sm)$|^(Makefile|makefrag|\.oppbuildspec|\.oppfeatures|\.oppfeaturestate)$/;
const LINKED = new RegExp(`${SOURCES.source}|\\.(so|dylib|dll|a|lib)$`);

// Does `dir` (and its subfolders if `deep`) have a file matching `pattern`
// modified after `since`? Skips the build output (out) and hidden folders.
function newerFile(dir, since, pattern, deep = true) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const e of entries) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (deep && e.name !== 'out' && !e.name.startsWith('.') && newerFile(f, since, pattern)) return true;
    } else if (pattern.test(e.name)) {
      try {
        if (fs.statSync(f).mtimeMs > since) return true;
      } catch {
        // broken symbolic link
      }
    }
  }
  return false;
}

// Did a file of a project change after `since`? The files in the project
// folder, and those of the folders of its .oppbuildspec (or of all of it),
// matching `pattern`.
function changedSince(dir, since, pattern = SOURCES) {
  if (newerFile(dir, since, pattern, false)) return true;
  const dirs = buildSpecDirs(dir);
  // A custom Makefile in the project folder: only its own files count
  const scan = dirs.length ? dirs.filter((d) => d.dir !== dir || d.type === 'makemake').map((d) => d.dir) : [dir];
  return scan.some((d) => newerFile(d, since, pattern));
}

module.exports = {
  quote, splitArgs, readList, projectName, references, rootVariable,
  buildSpecDirs, buildSpecTarget, target, makemakeArgs, buildCommand,
  newerFile, changedSince, SOURCES, LINKED,
};
