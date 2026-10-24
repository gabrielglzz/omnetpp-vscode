// Lightweight NED scanner: type declarations (with extends/like), their
// @statistic / @statisticTemplate / @signal properties and their submodules.
// Not a full NED parser, just enough to complete ini keys. No `vscode` dependency.
'use strict';

const path = require('path');

const TYPE_RE = /\b(simple|module|network|channel|moduleinterface|channelinterface)\s+([A-Za-z_]\w*)((?:\s+(?:extends|like)\s+[\w.]+(?:\s*,\s*[\w.]+)*)*)\s*\{/g;
const PROPERTY_RE = /@(statistic|statisticTemplate|signal)\s*\[\s*([^\]]+?)\s*\]\s*\(/g;
const SUBMODULE_RE = /(?:^|[;}\s])([A-Za-z_]\w*)\s*(\[[^\]]*\])?\s*:\s*(?:<([^>]*)>\s*like\s+([\w.]+)|([\w.]+))(?:\s+if\s+[^{;]*)?\s*[{;]/g;

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

// Splits text at top-level semicolons (outside strings and parentheses):
// [{text, offset}].
function statements(text, base) {
  const out = [];
  let depth = 0;
  let inString = false;
  let start = 0;
  for (let i = 0; i <= text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if ((ch === ';' && depth === 0) || i === text.length) {
      out.push({ text: text.slice(start, i), offset: base + start });
      start = i + 1;
    }
  }
  return out;
}

const PARAM_TYPES = 'double|int|bool|string|xml|object';
// Properties such as @unit(s) or @enum("g(erp)", "5 GHz (20 MHz)"): their
// arguments may hold strings and one level of parentheses
const PROPS = '((?:@\\w+(?:\\((?:"(?:[^"\\\\]|\\\\.)*"|\\([^()]*\\)|[^()"])*\\))?\\s*)*)';
const DECL_RE = new RegExp(`^(\\s*(?:volatile\\s+)?(${PARAM_TYPES})\\s+)([A-Za-z_]\\w*)\\s*${PROPS}(?:=\\s*([\\s\\S]*?))?\\s*$`);
const ASSIGN_RE = new RegExp(`^(\\s*)([A-Za-z_]\\w*)\\s*${PROPS}=\\s*([\\s\\S]*?)\\s*$`);

// Value of a parameter assignment: {value, isDefault, default}.
function valueInfo(raw) {
  if (raw === undefined || raw === '') return { value: null, isDefault: false, default: null };
  const value = raw.replace(/\s+/g, ' ').trim();
  const m = /^default\s*\(/.exec(value);
  if (!m) return { value, isDefault: false, default: null };
  const close = matching(value, m[0].length - 1, '(', ')');
  return { value, isDefault: true, default: value.slice(m[0].length, close < 0 ? value.length : close).trim() };
}

// Parameter declarations and assignments in a `parameters:` area.
function parseParams(clean, from, to, posOf, docOf) {
  const decls = [];
  const assigns = [];
  for (const st of statements(clean.slice(from, to), from)) {
    let text = st.text;
    let offset = st.offset;
    const kw = /^\s*parameters\s*:/.exec(text);
    if (kw) { text = text.slice(kw[0].length); offset += kw[0].length; }
    if (/^\s*$/.test(text) || /^\s*@/.test(text)) continue;
    let m;
    if ((m = DECL_RE.exec(text))) {
      const p = posOf(offset + m[1].length);
      const unit = /@unit\s*\(\s*([^)]*?)\s*\)/.exec(m[4] || '');
      decls.push({
        name: m[3], type: m[2], unit: unit ? unit[1] : null, volatile: /volatile/.test(m[1]),
        line: p.line, start: p.character, end: p.character + m[3].length, doc: docOf(p.line),
        ...valueInfo(m[5]),
      });
    } else if ((m = ASSIGN_RE.exec(text))) {
      const p = posOf(offset + m[1].length);
      assigns.push({ name: m[2], line: p.line, start: p.character, end: p.character + m[2].length, ...valueInfo(m[4]) });
    }
  }
  return { decls, assigns };
}

// End of the parameters area of a body: the first section keyword.
function paramsEnd(body) {
  const m = /\b(gates|types|submodules|connections)\b[^:;{}]*:/.exec(body);
  return m ? m.index : body.length;
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

  // Documentation of a declaration: its trailing // comment, or the comment
  // lines right above it.
  const rawLines = text.split(/\r?\n/);
  const docOf = (line) => {
    const raw = rawLines[line] || '';
    const trailing = raw.indexOf('//');
    if (trailing >= 0 && raw.slice(0, trailing).trim()) return raw.slice(trailing + 2).trim();
    const above = [];
    for (let l = line - 1; l >= 0 && /^\s*\/\//.test(rawLines[l]); l--) above.unshift(rawLines[l].replace(/^\s*\/\/+\s?/, ''));
    return above.join('\n').trim();
  };

  const pkg = /^\s*package\s+([\w.]+)\s*;/m.exec(clean);
  const types = [];
  let m;
  TYPE_RE.lastIndex = 0;
  while ((m = TYPE_RE.exec(clean))) {
    const open = m.index + m[0].length - 1;
    const close = matching(clean, open, '{', '}');
    const heritage = m[3] || '';
    const ext = /extends\s+([\w.]+(?:\s*,\s*[\w.]+)*)/.exec(heritage);
    const bases = ext ? ext[1].split(',').map((s) => s.trim().split('.').pop()) : [];
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
      extends: bases.length ? bases[0] : null,
      bases, // interfaces can extend several interfaces
      like: like ? like[1].split(',').map((s) => s.trim().split('.').pop()) : [],
      headerStart: m.index,
      bodyStart: open + 1,
      bodyEnd: close < 0 ? clean.length : close,
      stats: [],
      signals: [],
      submodules: [],
      params: [],
      assigns: [],
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

  // Body of a type with the types nested in its `types:` section blanked out
  // (same length, so offsets still match `clean`)
  const ownBody = (t) => {
    let body = clean.slice(t.bodyStart, t.bodyEnd);
    for (const n of types) {
      if (n === t || n.headerStart < t.bodyStart || n.bodyEnd > t.bodyEnd) continue;
      const from = n.headerStart - t.bodyStart;
      const to = Math.min(n.bodyEnd + 1, t.bodyEnd) - t.bodyStart;
      body = body.slice(0, from) + ' '.repeat(to - from) + body.slice(to);
    }
    return body;
  };

  for (const t of types) {
    const body = ownBody(t);
    const { decls, assigns } = parseParams(clean, t.bodyStart, t.bodyStart + paramsEnd(body), posOf, docOf);
    t.params = decls;
    t.assigns = assigns;
  }

  // Submodules: only in the `submodules:` section of each type (up to `connections:`)
  for (const t of types) {
    const body = ownBody(t);
    const sm = /\bsubmodules\s*:/.exec(body);
    if (!sm) continue;
    const from = sm.index + sm[0].length;
    const conn = /\bconnections\b[^:]*:/.exec(body.slice(from));
    const section = body.slice(from, conn ? from + conn.index : body.length);
    const sectionStart = t.bodyStart + from;
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
      // Parameters assigned in the submodule's body
      let assigns = [];
      if (m[0].endsWith('{')) {
        const open = m.index + m[0].length - 1;
        const close = matching(section, open, '{', '}');
        const sub = section.slice(open + 1, close < 0 ? section.length : close);
        assigns = parseParams(clean, sectionStart + open + 1, sectionStart + open + 1 + paramsEnd(sub), posOf, docOf).assigns;
      }
      t.submodules.push({
        assigns,
        name,
        vector: Boolean(vector),
        type: type ? type.split('.').pop() : null,
        iface: iface ? iface.split('.').pop() : null,
        defaultType: def ? def[1].split('.').pop() : null,
      });
      SUBMODULE_RE.lastIndex = m.index + m[0].length - 1; // the [{;] may start the next match
    }
  }

  for (const t of types) { delete t.headerStart; delete t.bodyStart; delete t.bodyEnd; }
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
    const qualified = new Map();    // qualified name => type
    const impls = new Map();        // interface name => Set(type name)
    const submodules = new Map();   // submodule name => Set(type name)
    for (const [file, ned] of this.files) {
      for (const t of ned.types) {
        const typed = { ...t, file };
        if (!types.has(t.name)) types.set(t.name, []);
        types.get(t.name).push(typed);
        qualified.set(t.qualified, typed);
        for (const i of t.like) {
          if (!impls.has(i)) impls.set(i, new Set());
          impls.get(i).add(t.name);
        }
      }
    }
    // Types derived (through `extends`) from an implementation also implement
    // the interface, and implementations of an interface also implement the
    // interfaces it extends (`moduleinterface IGptp extends IApp`)
    let grew = true;
    while (grew) {
      grew = false;
      for (const list of types.values()) {
        for (const t of list) {
          if (!t.extends) continue;
          if (t.kind.endsWith('interface')) {
            const own = impls.get(t.name);
            if (!own) continue;
            for (const b of t.bases) {
              if (!impls.has(b)) impls.set(b, new Set());
              const set = impls.get(b);
              for (const i of own) if (!set.has(i)) { set.add(i); grew = true; }
            }
            continue;
          }
          for (const set of impls.values()) {
            if (set.has(t.extends) && !set.has(t.name)) { set.add(t.name); grew = true; }
          }
        }
      }
    }
    this.cache = { types, qualified, impls, submodules };
    for (const list of types.values()) {
      for (const t of list) {
        for (const s of t.submodules) {
          if (!submodules.has(s.name)) submodules.set(s.name, new Set());
          for (const ty of this.typesOfSubmodule(s, t)) submodules.get(s.name).add(ty);
        }
      }
    }
    return this.cache;
  }

  // Name of the type that `name` refers to from the type `from`. When several
  // types share the simple name, NED picks the one in the same file or package:
  // its qualified name is returned then. Otherwise the simple name.
  resolveName(name, from) {
    const list = this.build().types.get(name);
    if (!list || list.length < 2 || !from) return name;
    const pkg = (t) => t.qualified.slice(0, -t.name.length);
    const best = list.find((t) => t.file === from.file) || list.find((t) => pkg(t) === pkg(from));
    return best ? best.qualified : name;
  }

  // Possible types of a submodule declaration of the type `owner`: its type, or
  // the default and every implementation of its interface (chosen with
  // `typename` in the ini).
  typesOfSubmodule(s, owner) {
    const set = new Set();
    if (s.type) set.add(this.resolveName(s.type, owner));
    if (s.defaultType) set.add(this.resolveName(s.defaultType, owner));
    if (s.iface) for (const impl of this.build().impls.get(s.iface) || []) set.add(impl);
    return [...set];
  }

  // Result of fn(), cached until the next change to the NED files. Callers
  // must not modify it.
  memo(kind, key, fn) {
    const b = this.build();
    if (!b.memo) b.memo = new Map();
    const k = `${kind} ${key}`;
    if (!b.memo.has(k)) b.memo.set(k, fn());
    return b.memo.get(k);
  }

  // Parameters of a type, including inherited ones; assignments in derived
  // types override the value. Each parameter: the declaration plus
  // {declaredIn, file, assignedIn, fixed}.
  paramsOf(typeName, seen) {
    if (!seen) return this.memo('params', typeName, () => this.paramsOf(typeName, new Set()));
    if (seen.has(typeName)) return [];
    seen.add(typeName);
    const t = this.type(typeName);
    if (!t) return [];
    const byName = new Map();
    if (t.extends) for (const p of this.paramsOf(this.resolveName(t.extends, t), seen)) byName.set(p.name, p);
    for (const d of t.params) byName.set(d.name, { ...d, declaredIn: t.name, file: t.file, assignedIn: null });
    for (const a of t.assigns) {
      const p = byName.get(a.name);
      if (p) byName.set(a.name, { ...p, value: a.value, isDefault: a.isDefault, default: a.default, assignedIn: t.name });
    }
    return [...byName.values()].map((p) => ({ ...p, fixed: p.value !== null && !p.isDefault }));
  }

  // Submodules of a type, including the ones inherited through `extends`:
  // [{name, vector, types}].
  children(typeName, seen) {
    if (!seen) return this.memo('children', typeName, () => this.children(typeName, new Set()));
    if (seen.has(typeName)) return [];
    seen.add(typeName);
    const t = this.type(typeName);
    if (!t) return [];
    const own = t.submodules.map((s) => ({ name: s.name, vector: s.vector, types: this.typesOfSubmodule(s, t), assigns: s.assigns, parent: t.name }));
    const inherited = t.extends ? this.children(this.resolveName(t.extends, t), seen).filter((c) => !own.some((o) => o.name === c.name)) : [];
    return [...own, ...inherited];
  }

  // The given types plus every type reachable from them through submodules.
  closure(typeNames) {
    return this.memo('closure', [...typeNames].sort().join(' '), () => this.closureOf(typeNames));
  }

  closureOf(typeNames) {
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

  // Type by qualified name, or the first one with this simple name.
  type(name) {
    if (name.includes('.')) return this.build().qualified.get(name);
    const list = this.build().types.get(name);
    return list ? list[0] : undefined;
  }

  networks() {
    const out = [];
    for (const list of this.build().types.values()) for (const t of list) if (t.kind === 'network') out.push(t);
    return out;
  }

  // Networks by simple or qualified name. When several networks share a simple
  // name (as in INET's examples), the ones in the folder `dir` of the ini file
  // win, as OMNeT++ looks the name up in the package of that folder first.
  findNetwork(name, dir) {
    const list = this.networks().filter((t) => t.name === name || t.qualified === name);
    const near = dir && list.length > 1 ? list.filter((t) => path.dirname(t.file) === dir) : [];
    return near.length ? near : list;
  }

  // Whether any type in the workspace declares a parameter with this name.
  declaresParam(name) {
    const b = this.build();
    if (!b.paramNames) {
      b.paramNames = new Set();
      for (const list of b.types.values()) for (const t of list) for (const p of t.params) b.paramNames.add(p.name);
    }
    return b.paramNames.has(name);
  }

  // Statistics of a type, including the ones inherited through `extends`.
  statsOf(typeName, seen) {
    if (!seen) return this.memo('stats', typeName, () => this.statsOf(typeName, new Set()));
    if (seen.has(typeName)) return [];
    seen.add(typeName);
    const t = this.type(typeName);
    if (!t) return [];
    const own = t.stats;
    const inherited = t.extends ? this.statsOf(this.resolveName(t.extends, t), seen).filter((s) => !own.some((o) => o.name === s.name)) : [];
    return [...own, ...inherited];
  }

  // Types a submodule with this name may have, anywhere in the workspace.
  submoduleTypes(name) {
    return [...(this.build().submodules.get(name) || [])];
  }

  allTypeNames() {
    return [...this.build().types.keys()];
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
