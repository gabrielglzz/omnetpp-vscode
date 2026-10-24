// Diagnostics for an ini file. Errors reproduce the checks OMNeT++ makes when it
// loads an ini file (src/envir/inifilereader.cc, sectionbasedconfig.cc), so they
// show up while editing instead of when the simulation starts.
'use strict';

const path = require('path');
const options = require('./options');

const WILDCARDS = /[?*{}[\]]/;

// Returns [{line, start, end, message, severity: 'error' | 'warning'}].
function diagnose(file, index) {
  const entry = index.get(file);
  if (!entry) return [];
  const { doc, includes } = entry;
  const out = doc.errors.map((e) => ({ ...e, severity: 'error' }));
  const error = (pos, start, end, message) => out.push({ line: pos.line, start, end, message, severity: 'error' });
  const warning = (pos, start, end, message) => out.push({ line: pos.line, start, end, message, severity: 'warning' });

  // Entries before the first heading belong to [General] in a top-level file,
  // and to the includer's current section in an included one (unknown here).
  const root = index.isRoot(file);
  const sectionOf = (s) => (s === null && root ? 'General' : s);
  // A fragment that no ini file includes (and that defines no network) may be
  // meant for any omnetpp.ini, so its extends and ${variables} are not checked.
  const orphan = root && !doc.entries.some((e) => e.key === 'network');

  doc.includes.forEach((inc, i) => {
    const target = includes[i];
    if (!index.exists(target)) {
      error(inc, inc.start, inc.end, `Cannot open ini file '${inc.path}'`);
    } else if (target === file || index.includePathTo(target, file)) {
      error(inc, inc.start, inc.end, `Ini file '${path.basename(file)}' includes itself, directly or indirectly`);
    }
  });

  for (const e of doc.entries) {
    const section = sectionOf(e.section);
    const key = e.key;
    if (!key.includes('.') && !WILDCARDS.test(key)) {
      const o = options.lookup(key);
      if (!o) {
        // Simulation libraries can register their own options from C++ (INET's
        // unshare-namespaces...), which opp_run does not list: only a warning
        warning(e, e.keyStart, e.keyEnd, `Unknown configuration option: ${key} (unless a simulation library registers it)`);
      } else if (o.scope === 'per-object') {
        error(e, e.keyStart, e.keyEnd, `Configuration option ${key} should be specified per object, try **.${key}=`);
      } else if (o.scope === 'global' && section !== null && section !== 'General') {
        error(e, e.keyStart, e.keyEnd, `Configuration option ${key} may only occur in the [General] section`);
      } else if (key === 'extends' && section === 'General') {
        error(e, e.keyStart, e.keyEnd, 'The [General] section cannot extend other sections');
      }
    } else {
      const dot = key.lastIndexOf('.');
      const suffix = key.slice(dot + 1);
      if (dot >= 0 && suffix.includes('-')) {
        const o = options.lookup(suffix);
        if (!o) {
          warning(e, e.keyStart + dot + 1, e.keyEnd, `Unknown per-object configuration option '${suffix}' in ${key} (unless a simulation library registers it)`);
        } else if (o.scope !== 'per-object') {
          error(e, e.keyStart + dot + 1, e.keyEnd, `Unknown per-object configuration option '${suffix}' in ${key}`);
        }
      }
    }
  }

  if (orphan) return out;

  const roots = index.roots(file).map((root) => ({ root, configs: index.configNamesIn(root) }));
  for (const r of doc.extendsRefs) {
    if (r.name === 'General') continue;
    const missing = roots.filter((x) => !x.configs.has(r.name)).map((x) => path.basename(path.dirname(x.root)) + '/' + path.basename(x.root));
    if (missing.length === roots.length) {
      error(r, r.start, r.end, `No such config: ${r.name}`);
    } else if (missing.length) {
      error(r, r.start, r.end, `No such config: ${r.name} (when loaded from ${missing.join(', ')})`);
    }
  }

  for (const s of doc.sections) {
    if (index.chains(s.name, file).some((c) => c.cycle)) {
      error(s, s.start, s.end, `Cycle detected in section fallback chain at [${s.name}]`);
    }
  }

  const defined = index.varNames(file);
  for (const r of doc.varRefs) {
    if (!options.variables.has(r.name) && !defined.has(r.name)) {
      warning(r, r.start, r.end, `Undefined iteration variable: ${r.name}`);
    }
  }

  return out;
}

module.exports = { diagnose };
