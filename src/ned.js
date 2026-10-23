// Lightweight NED scanner: type declarations (with extends/like), their
// @statistic / @statisticTemplate / @signal properties and their submodules.
// Not a full NED parser, just enough to complete ini keys. No `vscode` dependency.
'use strict';

const TYPE_RE = /\b(simple|module|network|channel|moduleinterface|channelinterface)\s+([A-Za-z_]\w*)((?:\s+(?:extends|like)\s+[\w.]+(?:\s*,\s*[\w.]+)*)*)\s*\{/g;
const PROPERTY_RE = /@(statistic|statisticTemplate|signal)\s*\[\s*([^\]]+?)\s*\]\s*\(/g;
const SUBMODULE_RE = /(?:^|[;}\s])([A-Za-z_]\w*)\s*(\[[^\]]*\])?\s*:\s*(?:<([^>]*)>\s*like\s+([\w.]+)|([\w.]+))\s*[{;]/g;

// Replaces comments with spaces, keeping offsets (and string contents) intact.
function stripComments(text) {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') { out += c + (text[i + 1] || ''); i++; continue; }
      if (c === '"') inString = false;
      out += c;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') { out += ' '; i++; }
      if (i < text.length) out += '\n';
    } else {
      out += c;
    }
  }
  return out;
}

// Index of the character that closes the bracket opened at `open`, or -1.
function matching(text, open, o, c) {
  let depth = 0;
  let inString = false;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === o) depth++;
    else if (ch === c && --depth === 0) return i;
  }
  return -1;
}

// Splits `key=value; key=value` at top-level semicolons.
function propertyKeys(body) {
  const keys = {};
  let depth = 0;
  let inString = false;
  let start = 0;
  const flush = (end) => {
    const part = body.slice(start, end);
    const eq = part.indexOf('=');
    if (eq > 0) keys[part.slice(0, eq).trim()] = part.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1');
    start = end + 1;
  };
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ';' && depth === 0) flush(i);
  }
  flush(body.length);
  return keys;
}

function parseNed(text) {
  const clean = stripComments(text);
  const lineStarts = [0];
  for (let i = 0; i < clean.length; i++) if (clean[i] === '\n') lineStarts.push(i + 1);
  const posOf = (offset) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= offset) lo = mid; else hi = mid - 1;
    }
    return { line: lo, character: offset - lineStarts[lo] };
  };

  const pkg = /^\s*package\s+([\w.]+)\s*;/m.exec(clean);
  const types = [];
  let m;
  TYPE_RE.lastIndex = 0;
  while ((m = TYPE_RE.exec(clean))) {
    const open = m.index + m[0].length - 1;
    const close = matching(clean, open, '{', '}');
    const heritage = m[3] || '';
    const ext = /extends\s+([\w.]+)/.exec(heritage);
    const like = /like\s+([\w.]+(?:\s*,\s*[\w.]+)*)/.exec(heritage);
    const nameOffset = m.index + m[0].indexOf(m[2], m[1].length);
    const p = posOf(nameOffset);
    types.push({
      kind: m[1],
      name: m[2],
      qualified: pkg ? `${pkg[1]}.${m[2]}` : m[2],
      line: p.line,
      start: p.character,
      end: p.character + m[2].length,
      extends: ext ? ext[1].split('.').pop() : null,
      like: like ? like[1].split(',').map((s) => s.trim().split('.').pop()) : [],
      bodyStart: open + 1,
      bodyEnd: close < 0 ? clean.length : close,
      stats: [],
      signals: [],
      submodules: [],
    });
  }

  // Innermost type containing an offset (types can be nested in `types:` sections)
  const ownerOf = (offset) => {
    let owner = null;
    for (const t of types) {
      if (offset > t.bodyStart && offset < t.bodyEnd && (!owner || t.bodyStart > owner.bodyStart)) owner = t;
    }
    return owner;
  };

  PROPERTY_RE.lastIndex = 0;
  while ((m = PROPERTY_RE.exec(clean))) {
    const owner = ownerOf(m.index);
    if (!owner) continue;
    const open = m.index + m[0].length - 1;
    const close = matching(clean, open, '(', ')');
    const keys = propertyKeys(clean.slice(open + 1, close < 0 ? clean.length : close));
    const p = posOf(m.index + m[0].indexOf(m[2]));
    const item = { name: m[2], line: p.line, start: p.character, end: p.character + m[2].length, keys, type: owner.name };
    if (m[1] === 'signal') {
      owner.signals.push(item);
    } else {
      item.template = m[1] === 'statisticTemplate';
      item.record = (keys.record || '').split(',').map((s) => s.trim()).filter(Boolean);
      owner.stats.push(item);
    }
  }

  // Submodules: only in the `submodules:` section of each type (up to `connections:`)
  for (const t of types) {
    const body = clean.slice(t.bodyStart, t.bodyEnd);
    const sm = /\bsubmodules\s*:/.exec(body);
    if (!sm) continue;
    const from = sm.index + sm[0].length;
    const conn = /\bconnections\b[^:]*:/.exec(body.slice(from));
    const section = body.slice(from, conn ? from + conn.index : body.length);
    // Skip the bodies of the submodules themselves
    let flat = '';
    let depth = 0;
    for (const ch of section) {
      if (ch === '{') { depth++; flat += depth === 1 ? '{' : ' '; } else if (ch === '}') { depth--; flat += depth === 0 ? '}' : ' '; } else flat += depth ? ' ' : ch;
    }
    SUBMODULE_RE.lastIndex = 0;
    while ((m = SUBMODULE_RE.exec(flat))) {
      const [, name, vector, typename, iface, type] = m;
      const def = typename && /default\s*\(\s*"([\w.]+)"\s*\)/.exec(typename);
      t.submodules.push({
        name,
        vector: Boolean(vector),
        type: type ? type.split('.').pop() : null,
        iface: iface ? iface.split('.').pop() : null,
        defaultType: def ? def[1].split('.').pop() : null,
      });
      SUBMODULE_RE.lastIndex = m.index + m[0].length - 1; // the [{;] may start the next match
    }
  }

  for (const t of types) { delete t.bodyStart; delete t.bodyEnd; }
  return { package: pkg ? pkg[1] : null, types };
}

class NedIndex {
  constructor() {
    this.files = new Map(); // file => parsed
    this.cache = null;
  }

  set(file, text) {
    this.files.set(file, parseNed(text));
    this.cache = null;
  }

  delete(file) {
    this.files.delete(file);
    this.cache = null;
  }

  build() {
    if (this.cache) return this.cache;
    const types = new Map();        // simple name => [type (with file)]
    const impls = new Map();        // interface name => Set(type name)
    const submodules = new Map();   // submodule name => Set(type name)
    for (const [file, ned] of this.files) {
      for (const t of ned.types) {
        const typed = { ...t, file };
        if (!types.has(t.name)) types.set(t.name, []);
        types.get(t.name).push(typed);
        for (const i of t.like) {
          if (!impls.has(i)) impls.set(i, new Set());
          impls.get(i).add(t.name);
        }
      }
    }
    // Types derived (through `extends`) from an implementation also implement the interface
    let grew = true;
    while (grew) {
      grew = false;
      for (const list of types.values()) {
        for (const t of list) {
          if (!t.extends) continue;
          for (const set of impls.values()) {
            if (set.has(t.extends) && !set.has(t.name)) { set.add(t.name); grew = true; }
          }
        }
      }
    }
    this.cache = { types, impls, submodules };
    for (const list of types.values()) {
      for (const t of list) {
        for (const s of t.submodules) {
          if (!submodules.has(s.name)) submodules.set(s.name, new Set());
          for (const ty of this.typesOfSubmodule(s)) submodules.get(s.name).add(ty);
        }
      }
    }
    return this.cache;
  }

  // Possible types of a submodule declaration: its type, or the default and
  // every implementation of its interface (chosen with `typename` in the ini).
  typesOfSubmodule(s) {
    const set = new Set();
    if (s.type) set.add(s.type);
    if (s.defaultType) set.add(s.defaultType);
    if (s.iface) for (const impl of this.build().impls.get(s.iface) || []) set.add(impl);
    return [...set];
  }

  // Submodules of a type, including the ones inherited through `extends`:
  // [{name, vector, types}].
  children(typeName, seen = new Set()) {
    if (seen.has(typeName)) return [];
    seen.add(typeName);
    const t = this.type(typeName);
    if (!t) return [];
    const own = t.submodules.map((s) => ({ name: s.name, vector: s.vector, types: this.typesOfSubmodule(s) }));
    const inherited = t.extends ? this.children(t.extends, seen).filter((c) => !own.some((o) => o.name === c.name)) : [];
    return [...own, ...inherited];
  }

  // The given types plus every type reachable from them through submodules.
  closure(typeNames) {
    const seen = new Set();
    const todo = [...typeNames];
    while (todo.length) {
      const t = todo.pop();
      if (seen.has(t)) continue;
      seen.add(t);
      for (const c of this.children(t)) todo.push(...c.types);
    }
    return [...seen];
  }

  // Every submodule declaration in the workspace: [{name, vector, types}].
  allChildren() {
    const out = [];
    for (const list of this.build().types.values()) for (const t of list) out.push(...this.children(t.name));
    return out;
  }

  type(name) {
    const list = this.build().types.get(name);
    return list ? list[0] : undefined;
  }

  networks() {
    const out = [];
    for (const list of this.build().types.values()) for (const t of list) if (t.kind === 'network') out.push(t);
    return out;
  }

  // Networks by simple or qualified name.
  findNetwork(name) {
    return this.networks().filter((t) => t.name === name || t.qualified === name);
  }

  // Statistics of a type, including the ones inherited through `extends`.
  statsOf(typeName, seen = new Set()) {
    if (seen.has(typeName)) return [];
    seen.add(typeName);
    const t = this.type(typeName);
    if (!t) return [];
    const own = t.stats;
    const inherited = t.extends ? this.statsOf(t.extends, seen).filter((s) => !own.some((o) => o.name === s.name)) : [];
    return [...own, ...inherited];
  }

  // Types a submodule with this name may have, anywhere in the workspace.
  submoduleTypes(name) {
    return [...(this.build().submodules.get(name) || [])];
  }

  allStats() {
    const out = [];
    for (const list of this.build().types.values()) for (const t of list) out.push(...t.stats);
    return out;
  }

  // Statistics with this name (as written in an ini key), in any type.
  findStats(name) {
    return this.allStats().filter((s) => keyName(s, this) === name || s.name === name);
  }
}

// Name to use in ini keys. A @statisticTemplate is instantiated from C++ with
// names that follow its @signal pattern (e.g. template app-throughput, signal
// app*-throughput), so the signal pattern is used when there is one.
function keyName(stat, nedIndex) {
  if (!stat.template) return stat.name;
  const t = nedIndex.type(stat.type);
  const sig = t && t.signals.find((s) => s.name.includes('*') && s.name.replace(/\*/g, '') === stat.name);
  return sig ? sig.name : stat.name;
}

module.exports = { parseNed, NedIndex, keyName };
