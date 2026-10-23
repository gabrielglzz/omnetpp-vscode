// Workspace index of ini files: parsed documents and the include graph.
// No `vscode` dependency; file access is injected so it can be tested with Node.
//
// Configs are looked up in the files "related" to a given file: the files that
// include it (transitively) plus everything those include. A fragment such as
// fragments/traffic.ini thus sees the configs of every
// omnetpp.ini that includes it, and of their other fragments.
'use strict';

const path = require('path');
const { parse } = require('./parser');

class IniIndex {
  constructor(readFile) {
    this.readFile = readFile; // (absPath) => string | undefined
    this.files = new Map();   // absPath => {doc, includes: [absPath]}
    this.reverse = null;      // absPath => Set(absPath), built lazily
  }

  set(file, text) {
    const doc = parse(text);
    const dir = path.dirname(file);
    const includes = doc.includes.map((i) => path.resolve(dir, i.path));
    this.files.set(file, { doc, includes });
    this.reverse = null;
    return doc;
  }

  delete(file) {
    this.files.delete(file);
    this.reverse = null;
  }

  // Parsed entry of a file, reading it from disk if it is not indexed yet.
  get(file) {
    if (!this.files.has(file)) {
      const text = this.readFile(file);
      if (text === undefined) return undefined;
      this.set(file, text);
    }
    return this.files.get(file);
  }

  exists(file) {
    return this.get(file) !== undefined;
  }

  includers(file) {
    if (!this.reverse) {
      this.reverse = new Map();
      for (const [from, { includes }] of this.files) {
        for (const to of includes) {
          if (!this.reverse.has(to)) this.reverse.set(to, new Set());
          this.reverse.get(to).add(from);
        }
      }
    }
    return this.reverse.get(file) || new Set();
  }

  isRoot(file) {
    return this.includers(file).size === 0;
  }

  // Files reachable from `starts` following `next` (starts included).
  walk(starts, next) {
    const seen = new Set();
    const todo = [...starts];
    while (todo.length) {
      const f = todo.pop();
      if (seen.has(f)) continue;
      seen.add(f);
      for (const n of next(f)) todo.push(n);
    }
    return seen;
  }

  descendants(file) {
    return this.walk([file], (f) => {
      const e = this.get(f);
      return e ? e.includes : [];
    });
  }

  related(file) {
    const ancestors = this.walk([file], (f) => this.includers(f));
    return this.walk(ancestors, (f) => {
      const e = this.get(f);
      return e ? e.includes : [];
    });
  }

  // Does following the includes of `file` lead back to `target`?
  includePathTo(file, target) {
    return this.descendants(file).has(target);
  }

  // Yields [file, doc] for the related files of `file`, or all files if `all`.
  *docs(file, all = false) {
    const files = all ? this.files.keys() : this.related(file);
    for (const f of files) {
      const e = this.get(f);
      if (e) yield [f, e.doc];
    }
  }

  // Looks items up in the related files first, then in the whole workspace.
  lookup(file, collect) {
    const found = [];
    for (const [f, doc] of this.docs(file)) collect(f, doc, found);
    if (!found.length) for (const [f, doc] of this.docs(file, true)) collect(f, doc, found);
    return found;
  }

  findSections(name, file) {
    return this.lookup(file, (f, doc, out) => {
      for (const s of doc.sections) if (s.name === name) out.push({ file: f, item: s });
    });
  }

  findVarDefs(name, file) {
    return this.lookup(file, (f, doc, out) => {
      for (const d of doc.varDefs) if (d.name === name) out.push({ file: f, item: d });
    });
  }

  findVarRefs(name, file) {
    const out = [];
    for (const [f, doc] of this.docs(file)) {
      for (const r of doc.varRefs) if (r.name === name) out.push({ file: f, item: r });
    }
    return out;
  }

  findExtendsRefs(name, file) {
    const out = [];
    for (const [f, doc] of this.docs(file)) {
      for (const r of doc.extendsRefs) if (r.name === name) out.push({ file: f, item: r });
    }
    return out;
  }

  configNames(file) {
    const names = new Set();
    for (const [, doc] of this.docs(file)) for (const s of doc.sections) names.add(s.name);
    return names;
  }

  // Section names in the files loaded from `root`.
  configNamesIn(root) {
    const names = new Set();
    for (const f of this.descendants(root)) {
      const e = this.get(f);
      if (e) for (const s of e.doc.sections) names.add(s.name);
    }
    return names;
  }

  varNames(file) {
    const names = new Map(); // name => first definition text
    for (const [, doc] of this.docs(file)) {
      for (const d of doc.varDefs) if (!names.has(d.name)) names.set(d.name, d.text);
    }
    return names;
  }

  // Top-level files that include `file` (transitively), or `file` itself.
  roots(file) {
    return [...this.walk([file], (f) => this.includers(f))].filter((f) => this.isRoot(f));
  }

  // Section name => [parent names] in the files loaded from `root`. OMNeT++
  // merges sections with the same name coming from different files.
  extendsGraph(root) {
    const graph = new Map();
    for (const f of this.descendants(root)) {
      const e = this.get(f);
      if (!e) continue;
      for (const r of e.doc.extendsRefs) {
        if (r.section === null) continue;
        if (!graph.has(r.section)) graph.set(r.section, []);
        graph.get(r.section).push(r.name);
      }
    }
    return graph;
  }

  // Fallback chain of a config as seen from each root that loads `file`
  // (depth-first, without duplicates, ending in General): [{root, chain, cycle}].
  chains(name, file) {
    return this.roots(file).map((root) => {
      const graph = this.extendsGraph(root);
      const chain = [];
      let cycle = false;
      const visit = (n, stack) => {
        if (stack.includes(n)) { cycle = true; return; }
        if (!chain.includes(n)) chain.push(n);
        for (const p of graph.get(n) || []) visit(p, [...stack, n]);
      };
      visit(name, []);
      if (!chain.includes('General')) chain.push('General');
      return { root, chain, cycle };
    });
  }
}

module.exports = { IniIndex };
