// VS Code entry point: completion, hover, go to definition, references,
// outline, folding and diagnostics for OMNeT++ ini files.
'use strict';

const fs = require('fs');
const path = require('path');
const vscode = require('vscode');
const { IniIndex } = require('./index');
const { parse, sectionAtLine, itemAt } = require('./parser');
const { diagnose } = require('./diagnostics');
const options = require('./options');
const { NedIndex, keyName } = require('./ned');

const LANG = 'omnetpp-ini';
const SELECTOR = { language: LANG };
const EXCLUDE = '{**/node_modules/**,**/out/**,**/.git/**}';

function readFile(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

const index = new IniIndex(readFile);
const ned = new NedIndex();

// ---------------------------------------------------------------- helpers

const rangeOf = (p) => new vscode.Range(p.line, p.start, p.line, p.end);
const locationOf = (file, p) => new vscode.Location(vscode.Uri.file(file), rangeOf(p));

function relative(file) {
  return vscode.workspace.asRelativePath(file);
}

function link(file, line) {
  const uri = vscode.Uri.file(file).with({ fragment: `L${line + 1}` });
  return `[${relative(file)}:${line + 1}](${uri})`;
}

function docOf(document) {
  const e = document.uri.scheme === 'file' && index.get(document.fileName);
  return e ? e.doc : parse(document.getText());
}

function md(text) {
  const m = new vscode.MarkdownString(text);
  m.isTrusted = false;
  return m;
}

// Configuration option of a key: the key itself, or its last segment for per-object options.
function optionOfKey(key) {
  if (!key.includes('.')) return options.lookup(key);
  const o = options.lookup(key.slice(key.lastIndexOf('.') + 1));
  return o && o.scope === 'per-object' ? o : undefined;
}

// ---------------------------------------------------------------- NED

function indexNed(file) {
  const text = readFile(file);
  if (text === undefined) ned.delete(file);
  else ned.set(file, text);
}

// Splits an ini key into dot-separated segments, ignoring the dots inside
// [..] and {..} (e.g. port[0..3]): [{text, start}].
function keySegments(key) {
  const segs = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i <= key.length; i++) {
    const c = key[i];
    if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') depth--;
    else if ((c === '.' && depth === 0) || i === key.length) {
      segs.push({ text: key.slice(start, i), start });
      start = i + 1;
    }
  }
  return segs;
}

// Module name of a key segment (`port[*]` -> `port`), or null for wildcards.
function moduleName(seg) {
  const m = /^([A-Za-z_]\w*)(\[[^\]]*\])?$/.exec(seg);
  return m ? m[1] : null;
}

// Types of the networks the file is run with (the `network` of the
// top-level ini files that load it).
function networkTypes(file) {
  const names = new Set();
  for (const root of index.roots(file)) {
    for (const f of index.descendants(root)) {
      const e = index.get(f);
      if (!e) continue;
      for (const en of e.doc.entries) {
        if (en.key === 'network' && (en.section === null || en.section === 'General')) {
          for (const n of ned.findNetwork(en.value)) names.add(n.name);
        }
      }
    }
  }
  return [...names];
}

const ROOT = 'root'; // before the first segment: the only child is the network

// Resolves key segments to the module types they may match, starting from the
// network: `**` matches any depth, `SW[*]` the submodules called SW of the
// current types. Returns an array of type names, ROOT, or null when unknown.
function resolvePath(segs, file) {
  let cur = ROOT;
  const nets = () => {
    const n = networkTypes(file);
    return n.length ? n : null;
  };
  for (const { text } of segs) {
    const name = moduleName(text);
    if (text === '**') {
      const from = cur === ROOT ? nets() : cur;
      cur = from ? ned.closure(from) : null;
    } else if (name) {
      if (cur === ROOT) {
        const n = ned.findNetwork(name);
        cur = n.length ? n.map((t) => t.name) : null;
        continue;
      }
      let types = cur ? cur.flatMap((t) => ned.children(t)).filter((c) => c.name === name).flatMap((c) => c.types) : [];
      if (!types.length) types = ned.submoduleTypes(name); // not found from the path: search by name
      cur = types.length ? [...new Set(types)] : null;
    } else if (cur === ROOT) {
      cur = nets(); // `*` or another pattern matching the network name
    } else if (cur) {
      const kids = [...new Set(cur.flatMap((t) => ned.children(t)).flatMap((c) => c.types))];
      cur = text.includes('**') ? ned.closure(kids) : kids;
    }
  }
  return cur === ROOT ? null : cur;
}

// Submodules that can follow the key segments: Map(name => {vector, types}).
function submodulesForPath(segs, file) {
  const types = resolvePath(segs, file);
  const list = types ? types.flatMap((t) => ned.children(t)) : ned.allChildren();
  const byName = new Map();
  for (const c of list) {
    if (!byName.has(c.name)) byName.set(c.name, { vector: false, types: new Set() });
    const e = byName.get(c.name);
    e.vector = e.vector || c.vector;
    c.types.forEach((t) => e.types.add(t));
  }
  return { byName, resolved: Boolean(types) };
}

// Statistics that can follow the key segments: Map(keyName => [stat]).
function statsForPath(segs, file) {
  const types = resolvePath(segs, file);
  const byName = new Map();
  for (const st of types ? types.flatMap((t) => ned.statsOf(t)) : ned.allStats()) {
    const k = keyName(st, ned);
    if (!byName.has(k)) byName.set(k, []);
    if (!byName.get(k).includes(st)) byName.get(k).push(st);
  }
  return { byName, resolved: Boolean(types) };
}

// Statistics called `name` that follow the given key segments: resolved
// through the module path when possible, otherwise searched by name.
function statsNamed(name, before, file) {
  const { byName, resolved } = statsForPath(before, file);
  if (resolved && byName.has(name)) return byName.get(name);
  return ned.findStats(name);
}

// Parameters that can follow the key segments: Map(name => [param]). The
// assignments in the body of the submodule matched by the last segment
// (e.g. `host[..]: Host { numApps = 2; }`) fix those parameters.
function paramsForPath(segs, file) {
  const types = resolvePath(segs, file);
  const byName = new Map();
  const add = (p) => {
    if (!byName.has(p.name)) byName.set(p.name, []);
    byName.get(p.name).push(p);
  };
  const last = segs.length ? moduleName(segs[segs.length - 1].text) : null;
  const decls = last ? submodulesDecls(segs.slice(0, -1), last, file) : [];
  for (const t of types || ned.allTypeNames()) {
    for (const p of ned.paramsOf(t)) {
      const decl = decls.find((d) => d.types.includes(t));
      const a = decl && decl.assigns.find((x) => x.name === p.name);
      add(a ? { ...p, value: a.value, isDefault: a.isDefault, default: a.default, assignedIn: `${decl.parent}.${decl.name}`, fixed: !a.isDefault } : p);
    }
  }
  return { byName, resolved: Boolean(types) };
}

// Declarations of the submodule `name` that can follow the key segments.
function submodulesDecls(segs, name, file) {
  const types = resolvePath(segs, file);
  return types ? types.flatMap((t) => ned.children(t)).filter((c) => c.name === name) : [];
}

function paramSignature(p) {
  let sig = `${p.volatile ? 'volatile ' : ''}${p.type} ${p.name}`;
  if (p.unit) sig += ` @unit(${p.unit})`;
  if (p.value !== null) sig += ` = ${p.value}`;
  return sig;
}

function paramMarkdown(list) {
  const p = list[0];
  let text = '```ned\n' + [...new Set(list.map(paramSignature))].join('\n') + '\n```';
  if (list.some((x) => x.fixed)) {
    const where = [...new Set(list.filter((x) => x.fixed).map((x) => x.assignedIn || x.declaredIn))].join(', ');
    text += `\n\n**Set in NED** (${where}) without \`default()\`: an ini value is ignored.`;
  }
  const doc = list.map((x) => x.doc).find(Boolean);
  if (doc) text += `\n\n${doc}`;
  const seen = new Set();
  text += '\n\nDeclared in: ' + list.filter((x) => !seen.has(x.declaredIn) && seen.add(x.declaredIn))
    .map((x) => `\`${x.declaredIn}\` (${link(x.file, x.line)})`).join(', ');
  return text;
}

function typeLinks(types) {
  return types.map((t) => {
    const ty = ned.type(t);
    return ty ? `[\`${t}\`](${vscode.Uri.file(ty.file).with({ fragment: `L${ty.line + 1}` })})` : `\`${t}\``;
  }).join(', ');
}

// Segment of an entry's key under the cursor: {seg, idx, segs, range}, or null.
function keySegmentAt(entry, character) {
  const rel = character - entry.keyStart;
  const segs = keySegments(entry.key);
  const idx = segs.findIndex((g) => rel >= g.start && rel <= g.start + g.text.length);
  if (idx < 0) return null;
  const seg = segs[idx];
  const range = new vscode.Range(entry.line, entry.keyStart + seg.start, entry.line, entry.keyStart + seg.start + seg.text.length);
  return { seg, idx, segs, range };
}

function statMarkdown(list) {
  const st = list[0];
  const k = keyName(st, ned);
  let text = `**${k}** — \`@${st.template ? 'statisticTemplate' : 'statistic'}[${st.name}]\``;
  if (st.keys.title && st.keys.title !== st.name) text += `\n\n${st.keys.title}`;
  const facts = [];
  if (st.keys.source) facts.push(`source: \`${st.keys.source}\``);
  if (st.keys.unit) facts.push(`unit: \`${st.keys.unit}\``);
  if (st.record.length) facts.push(`record: \`${st.record.join(', ')}\``);
  if (facts.length) text += '\n\n' + facts.join('  \n');
  const optional = st.record.filter((r) => r.endsWith('?'));
  if (optional.length) {
    text += `\n\nModes ending in \`?\` are off by default: enable them with \`result-recording-modes = default,+${optional[0].slice(0, -1)}\` (or \`all\`).`;
  }
  const seen = new Set();
  const types = list.filter((s) => !seen.has(s.type) && seen.add(s.type));
  text += '\n\nDeclared in: ' + types.map((s) => {
    const t = ned.type(s.type);
    return t ? `\`${s.type}\` (${link(t.file, s.line)})` : `\`${s.type}\``;
  }).join(', ');
  return text;
}

// ---------------------------------------------------------------- diagnostics

// Diagnostics that need the NED files: parameters that do not exist in the
// modules a key matches, or that NED sets without default() (so the ini value
// is ignored). Only for keys whose module path resolves from the network.
// Parameters of OMNeT++'s built-in NED types (channels, ned.IdealChannel...),
// which are not in the workspace NED files.
const BUILTIN_PARAMS = new Set(['delay', 'datarate', 'ber', 'per', 'disabled']);

function nedDiagnostics(file, doc, checkUnknown = true) {
  const out = [];
  for (const e of doc.entries) {
    if (!e.key.includes('.')) continue;
    const segs = keySegments(e.key);
    const last = segs[segs.length - 1];
    if (!/^[A-Za-z_]\w*$/.test(last.text) || last.text === 'typename' || options.lookup(last.text)) continue;
    const before = segs.slice(0, -1);
    const { byName, resolved } = paramsForPath(before, file);
    if (!resolved) continue;
    const pos = { line: e.line, start: e.keyStart + last.start, end: e.keyStart + last.start + last.text.length };
    const list = byName.get(last.text);
    if (!list) {
      if (checkUnknown && !BUILTIN_PARAMS.has(last.text) && !statsForPath(before, file).byName.has(last.text)) {
        out.push({ ...pos, severity: 'warning', message: `No parameter '${last.text}' in the modules matched by '${before.map((g) => g.text).join('.')}'` });
      }
    } else if (list.every((p) => p.fixed)) {
      const where = [...new Set(list.map((p) => p.assignedIn || p.declaredIn))].join(', ');
      out.push({ ...pos, severity: 'warning', message: `Parameter '${last.text}' is set in NED (${where}) without default(): this value is ignored` });
    }
  }
  return out;
}

const collection = vscode.languages.createDiagnosticCollection(LANG);

function refreshDiagnostics(document) {
  if (document.languageId !== LANG || document.uri.scheme !== 'file') return;
  const doc = docOf(document);
  const list = [...diagnose(document.fileName, index), ...nedDiagnostics(document.fileName, doc,
    vscode.workspace.getConfiguration('omnetppIni').get('diagnostics.unknownParameters', true))].map((d) => {
    const diag = new vscode.Diagnostic(
      new vscode.Range(d.line, d.start, d.line, d.end), d.message,
      d.severity === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning);
    diag.source = 'OMNeT++';
    return diag;
  });
  collection.set(document.uri, list);
}

let refreshTimer;
function refreshAll() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => vscode.workspace.textDocuments.forEach(refreshDiagnostics), 250);
}

// ---------------------------------------------------------------- completion

function item(label, kind, detail, doc) {
  const i = new vscode.CompletionItem(label, kind);
  if (detail) i.detail = detail;
  if (doc) i.documentation = md(doc);
  return i;
}

function wordRange(position, prefix, re) {
  const m = re.exec(prefix);
  return new vscode.Range(position.line, position.character - (m ? m[0].length : 0), position.line, position.character);
}

function complete(document, position) {
  const file = document.fileName;
  const doc = docOf(document);
  const prefix = document.lineAt(position.line).text.slice(0, position.character);
  const section = sectionAtLine(doc, position.line) || (index.isRoot(file) ? 'General' : null);
  let m;

  // ${...: predefined and iteration variables
  if ((m = /\$\{\s*(\w*)$/.exec(prefix))) {
    const range = wordRange(position, prefix, /\w*$/);
    const items = [];
    for (const v of options.variables.values()) {
      const i = item(v.name, vscode.CompletionItemKind.Constant, 'predefined variable', v.description);
      i.range = range;
      items.push(i);
    }
    for (const [name, text] of index.varNames(file)) {
      const i = item(name, vscode.CompletionItemKind.Variable, text);
      i.range = range;
      items.push(i);
    }
    return items;
  }

  // include <path>
  if ((m = /^include\s+(.*)$/.exec(prefix))) {
    const typed = m[1];
    const dir = path.resolve(path.dirname(file), typed.slice(0, typed.lastIndexOf('/') + 1));
    const range = wordRange(position, prefix, /[^/\s]*$/);
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return undefined;
    }
    return entries
      .filter((e) => !e.name.startsWith('.') && (e.isDirectory() || e.name.endsWith('.ini')))
      .map((e) => {
        const dirent = e.isDirectory();
        const i = item(dirent ? `${e.name}/` : e.name, dirent ? vscode.CompletionItemKind.Folder : vscode.CompletionItemKind.File);
        i.range = range;
        if (dirent) i.command = { command: 'editor.action.triggerSuggest', title: '' };
        return i;
      });
  }

  if (prefix.trimStart().startsWith('[') || prefix.trimStart().startsWith('#')) return undefined;
  const eq = prefix.indexOf('=');

  // Key position
  if (eq < 0) {
    if (/^\s/.test(prefix)) return undefined; // indented: continuation line
    const key = prefix;
    if (key.includes('.')) {
      // After a dot: submodules, statistics of the module, then per-object options
      const segs = keySegments(key);
      const before = segs.slice(0, -1);
      const range = wordRange(position, prefix, /[\w*-]*$/);
      const prev = before.length ? before[before.length - 1].text : '';
      const afterStat = before.length > 0 && statsNamed(prev, before.slice(0, -1), file).length > 0 &&
        !submodulesForPath(before.slice(0, -1), file).byName.has(moduleName(prev));
      const items = [];
      if (!afterStat) {
        const subs = submodulesForPath(before, file);
        for (const [name, { vector, types }] of subs.byName) {
          const label = vector ? `${name}[*]` : name;
          const i = item(label, vscode.CompletionItemKind.Module, [...types].join(', '), `Submodule **${label}**: ${typeLinks([...types])}`);
          i.range = range;
          i.filterText = name;
          i.sortText = (subs.resolved ? '0' : '3') + name;
          i.insertText = `${label}.`;
          i.command = { command: 'editor.action.triggerSuggest', title: '' };
          items.push(i);
        }
        const params = paramsForPath(before, file);
        for (const [name, list] of params.byName) {
          const fixed = list.every((x) => x.fixed);
          const i = item(name, vscode.CompletionItemKind.Field, paramSignature(list[0]), paramMarkdown(list));
          i.range = range;
          i.sortText = (fixed ? '5' : params.resolved ? '1' : '4') + name;
          if (fixed) i.tags = [vscode.CompletionItemTag.Deprecated];
          i.insertText = `${name} = `;
          items.push(i);
        }
        const { byName, resolved } = statsForPath(before, file);
        for (const [k, list] of byName) {
          const types = [...new Set(list.map((s) => s.type))].join(', ');
          const i = item(k, vscode.CompletionItemKind.Event, `statistic of ${types}`, statMarkdown(list));
          i.range = range;
          i.sortText = (resolved ? '2' : '4') + k;
          i.insertText = `${k}.`;
          i.command = { command: 'editor.action.triggerSuggest', title: '' };
          items.push(i);
        }
      }
      const forStats = /statistic|scalar|vector/;
      for (const o of options.options.filter((x) => x.scope === 'per-object')) {
        const i = item(o.name.replace('%', '0'), vscode.CompletionItemKind.Property, `<${o.type}> per-object option`, options.optionMarkdown(o));
        i.range = range;
        i.sortText = (afterStat && forStats.test(o.kind) ? '0' : '3') + o.name;
        i.insertText = new vscode.SnippetString(`${o.name.replace('%', '${1:0}')} = `);
        items.push(i);
      }
      return items;
    }
    if (!/^[\w-]*$/.test(key)) return undefined;
    const range = wordRange(position, prefix, /[\w-]*$/);
    const items = options.options
      .filter((o) => o.scope !== 'per-object' && (o.scope !== 'global' || section === 'General' || section === null))
      .filter((o) => !(o.name === 'extends' && section === 'General'))
      .map((o) => {
        const i = item(o.name, vscode.CompletionItemKind.Property, `<${o.type}> ${o.scope} option`, options.optionMarkdown(o));
        i.range = range;
        i.insertText = new vscode.SnippetString(`${o.name.replace(/%/g, '${1:0}')} = `);
        return i;
      });
    const inc = item('include', vscode.CompletionItemKind.Keyword, 'include another ini file');
    inc.range = range;
    inc.insertText = 'include ';
    inc.command = { command: 'editor.action.triggerSuggest', title: '' };
    items.push(inc);
    return items;
  }

  // Value position
  const key = prefix.slice(0, eq).trim();
  const range = wordRange(position, prefix, /[^,\s=]*$/);
  if (key === 'extends') {
    return [...index.configNames(file)].filter((n) => n !== section && n !== 'General').map((n) => {
      const i = item(n, vscode.CompletionItemKind.Class, 'config');
      i.range = range;
      return i;
    });
  }
  if (key === 'network') {
    return ned.networks().map((t) => {
      const i = item(t.name, vscode.CompletionItemKind.Module, t.qualified, relative(t.file));
      i.range = range;
      return i;
    });
  }
  const o = optionOfKey(key);
  const segs = keySegments(key);
  if (o && o.name === 'typename' && segs.length > 1) {
    const before = segs.slice(0, -1);
    const last = moduleName(before[before.length - 1].text);
    const decls = last ? submodulesDecls(before.slice(0, -1), last, file) : [];
    const types = decls.length ? [...new Set(decls.flatMap((d) => d.types))] : resolvePath(before, file) || [];
    const r = wordRange(position, prefix, /"?[\w.]*"?$/);
    return types.map((t) => {
      const ty = ned.type(t);
      const def = decls.some((d) => d.types[0] === t);
      const i = item(`"${t}"`, vscode.CompletionItemKind.Class, ty ? ty.qualified : undefined, ty ? `${ty.kind} **${t}** — ${link(ty.file, ty.line)}` : undefined);
      i.range = r;
      i.sortText = (def ? '0' : '1') + t;
      return i;
    });
  }
  if (!o && segs.length > 1) {
    const { byName } = paramsForPath(segs.slice(0, -1), file);
    const list = byName.get(segs[segs.length - 1].text);
    if (list) {
      const items = [];
      if (list.some((p) => p.type === 'bool')) items.push('true', 'false');
      for (const p of list) if (p.isDefault && p.default && !items.includes(p.default)) items.push(p.default);
      return items.map((v) => {
        const i = item(v, vscode.CompletionItemKind.Value, list.some((p) => p.default === v) ? 'default value' : undefined);
        i.range = range;
        return i;
      });
    }
  }
  if (o && o.type === 'bool') {
    return ['true', 'false'].map((v) => {
      const i = item(v, vscode.CompletionItemKind.Value);
      i.range = range;
      return i;
    });
  }
  if (o && o.name === 'result-recording-modes') {
    const r = wordRange(position, prefix, /[+-]?\w*$/);
    const stats = segs.length > 1 ? statsNamed(segs[segs.length - 2].text, segs.slice(0, -2), file) : [];
    const items = [];
    const seen = new Set();
    for (const st of stats) {
      for (const mode of st.record) {
        const optional = mode.endsWith('?');
        const name = optional ? mode.slice(0, -1) : mode;
        const label = optional ? `+${name}` : `-${name}`;
        if (seen.has(label)) continue;
        seen.add(label);
        const i = item(label, vscode.CompletionItemKind.EnumMember,
          optional ? `enable ${name} (optional in ${st.type})` : `disable ${name} (recorded by default in ${st.type})`);
        i.range = r;
        i.sortText = '0' + name;
        items.push(i);
      }
    }
    const modes = [{ name: 'default', description: 'The modes in the `record` key of `@statistic`, except the optional ones (ending in `?`)' },
      { name: 'all', description: 'All the modes in the `record` key of `@statistic`' }, ...options.recorders];
    for (const { name: v, description } of modes) {
      const i = item(v, vscode.CompletionItemKind.EnumMember, undefined, description);
      i.range = r;
      i.sortText = '1' + v;
      items.push(i);
    }
    return items;
  }
  return undefined;
}

// ---------------------------------------------------------------- hover

function configHover(name, file) {
  const sections = index.findSections(name, file);
  let text = `**[Config ${name}]**`;
  // The chain may differ between the omnetpp.ini files that load this one
  const byChain = new Map();
  for (const { root, chain, cycle } of index.chains(name, file)) {
    const key = chain.join(' → ') + (cycle ? ' *(cycle!)*' : '');
    if (!byChain.has(key)) byChain.set(key, []);
    byChain.get(key).push(root);
  }
  if (byChain.size === 1) {
    text += `\n\nFallback chain: ${[...byChain.keys()][0]}`;
  } else {
    text += '\n\nFallback chain:\n' + [...byChain].map(([c, roots]) =>
      `- ${c} — in ${roots.map(relative).join(', ')}`).join('\n');
  }
  for (const { file: f } of sections) {
    const entries = index.get(f).doc.entries.filter((e) => e.section === name);
    const description = entries.find((e) => e.key === 'description');
    if (description) text += `\n\n${description.value}`;
  }
  if (sections.length) text += '\n\n' + sections.map(({ file: f, item: s }) => link(f, s.line)).join('  \n');
  else text += '\n\n*Not found*';
  return text;
}

function hover(document, position) {
  const file = document.fileName;
  const at = itemAt(docOf(document), position.line, position.character);
  if (!at) return undefined;
  const { kind, item: it } = at;
  let text;
  switch (kind) {
    case 'key': {
      const at = keySegmentAt(it, position.character);
      if (!at) break;
      const { seg, idx, segs, range } = at;
      const o = idx === segs.length - 1 ? optionOfKey(it.key) : undefined;
      const name = moduleName(seg.text);
      const sub = name && submodulesForPath(segs.slice(0, idx), file).byName.get(name);
      const stats = sub ? [] : statsNamed(seg.text, segs.slice(0, idx), file);
      if (o) {
        text = options.optionMarkdown(o);
      } else if (sub) {
        text = `Submodule **${name}${sub.vector ? '[]' : ''}**: ${typeLinks([...sub.types])}`;
      } else if (stats.length) {
        text = statMarkdown(stats);
      } else if (idx === segs.length - 1) {
        const list = paramsForPath(segs.slice(0, -1), file).byName.get(seg.text);
        if (list) text = paramMarkdown(list);
      }
      if (text && !o) return new vscode.Hover(md(text), range);
      break;
    }
    case 'varRef':
    case 'varDef': {
      const v = options.variables.get(it.name);
      if (v && kind === 'varRef') {
        text = `**\${${v.name}}** *(predefined)*\n\n${v.description}`;
      } else {
        const defs = index.findVarDefs(it.name, file);
        text = `**\${${it.name}}** *(iteration variable)*\n\n` +
          (defs.length
            ? defs.map(({ file: f, item: d }) => `\`${d.text}\` in [${d.section || 'General'}] — ${link(f, d.line)}`).join('  \n')
            : '*No definition found*');
      }
      break;
    }
    case 'extends':
    case 'section':
      text = configHover(it.name, file);
      break;
    case 'include': {
      const target = path.resolve(path.dirname(file), it.path);
      text = index.exists(target) ? link(target, 0) : `*Not found:* \`${target}\``;
      break;
    }
    case 'network': {
      const list = ned.findNetwork(it.name);
      text = list.length
        ? list.map((n) => `**network ${n.qualified}** — ${link(n.file, n.line)}`).join('  \n')
        : '*Network not found in the workspace NED files*';
      break;
    }
  }
  return text ? new vscode.Hover(md(text), rangeOf(it)) : undefined;
}

// ---------------------------------------------------------------- definition / references

function definition(document, position) {
  const file = document.fileName;
  const at = itemAt(docOf(document), position.line, position.character);
  if (!at) return undefined;
  const { kind, item: it } = at;
  switch (kind) {
    case 'include': {
      const target = path.resolve(path.dirname(file), it.path);
      return index.exists(target) ? new vscode.Location(vscode.Uri.file(target), new vscode.Position(0, 0)) : undefined;
    }
    case 'extends':
    case 'section':
      return index.findSections(it.name, file).map(({ file: f, item: s }) => locationOf(f, s));
    case 'varRef':
    case 'varDef':
      return index.findVarDefs(it.name, file).map(({ file: f, item: d }) => locationOf(f, d));
    case 'network':
      return ned.findNetwork(it.name).map((n) => locationOf(n.file, n));
    case 'key': {
      const at = keySegmentAt(it, position.character);
      if (!at) return undefined;
      const name = moduleName(at.seg.text);
      const sub = name && submodulesForPath(at.segs.slice(0, at.idx), file).byName.get(name);
      if (sub) return [...sub.types].map((t) => ned.type(t)).filter(Boolean).map((t) => locationOf(t.file, t));
      const stats = statsNamed(at.seg.text, at.segs.slice(0, at.idx), file);
      if (stats.length) return stats.map((st) => locationOf(ned.type(st.type).file, st));
      const list = paramsForPath(at.segs.slice(0, at.idx), file).byName.get(at.seg.text) || [];
      const seen = new Set();
      return list.filter((p) => !seen.has(`${p.file}:${p.line}`) && seen.add(`${p.file}:${p.line}`)).map((p) => locationOf(p.file, p));
    }
  }
  return undefined;
}

function references(document, position, context) {
  const file = document.fileName;
  const at = itemAt(docOf(document), position.line, position.character);
  if (!at) return undefined;
  const { kind, item: it } = at;
  const decl = context.includeDeclaration;
  if (kind === 'extends' || kind === 'section') {
    const refs = index.findExtendsRefs(it.name, file).map(({ file: f, item: r }) => locationOf(f, r));
    if (decl) refs.push(...index.findSections(it.name, file).map(({ file: f, item: s }) => locationOf(f, s)));
    return refs;
  }
  if (kind === 'varRef' || kind === 'varDef') {
    const refs = index.findVarRefs(it.name, file).map(({ file: f, item: r }) => locationOf(f, r));
    if (decl) refs.push(...index.findVarDefs(it.name, file).map(({ file: f, item: d }) => locationOf(f, d)));
    return refs;
  }
  return undefined;
}

// ---------------------------------------------------------------- outline / folding

// Last line of a section, skipping trailing blank lines.
function sectionEnd(document, s) {
  let end = s.endLine;
  while (end > s.line && document.lineAt(end).isEmptyOrWhitespace) end--;
  return end;
}

function symbols(document) {
  const doc = docOf(document);
  const top = [];
  const bySection = new Map();
  for (const s of doc.sections) {
    const range = new vscode.Range(s.line, 0, sectionEnd(document, s), document.lineAt(sectionEnd(document, s)).text.length);
    const sym = new vscode.DocumentSymbol(s.name === 'General' ? '[General]' : `[Config ${s.name}]`,
      '', s.name === 'General' ? vscode.SymbolKind.Namespace : vscode.SymbolKind.Class, range, rangeOf(s));
    const ext = doc.extendsRefs.filter((r) => r.section === s.name).map((r) => r.name);
    if (ext.length) sym.detail = `extends ${ext.join(', ')}`;
    bySection.set(s.name, sym);
    top.push(sym);
  }
  const add = (section, sym) => (section !== null && bySection.has(section) ? bySection.get(section).children : top).push(sym);
  for (const inc of doc.includes) {
    add(inc.section, new vscode.DocumentSymbol(inc.path, 'include', vscode.SymbolKind.File, rangeOf(inc), rangeOf(inc)));
  }
  for (const d of doc.varDefs) {
    add(d.section, new vscode.DocumentSymbol(`\${${d.name}}`, d.text, vscode.SymbolKind.Variable, rangeOf(d), rangeOf(d)));
  }
  return top;
}

function folding(document) {
  return docOf(document).sections
    .map((s) => new vscode.FoldingRange(s.line, sectionEnd(document, s), vscode.FoldingRangeKind.Region))
    .filter((r) => r.end > r.start);
}

// ---------------------------------------------------------------- activation

async function buildIndex() {
  const [inis, neds] = await Promise.all([
    vscode.workspace.findFiles('**/*.ini', EXCLUDE),
    vscode.workspace.findFiles('**/*.ned', EXCLUDE),
  ]);
  for (const uri of inis) index.get(uri.fsPath);
  for (const uri of neds) indexNed(uri.fsPath);
  // Unsaved editor contents win over the files on disk
  for (const d of vscode.workspace.textDocuments) {
    if (d.languageId === LANG && d.uri.scheme === 'file') index.set(d.fileName, d.getText());
  }
  refreshAll();
}

function activate(context) {
  const sub = (d) => context.subscriptions.push(d);
  sub(collection);

  sub(vscode.workspace.onDidOpenTextDocument((d) => {
    if (d.languageId === LANG && d.uri.scheme === 'file') {
      index.set(d.fileName, d.getText());
      refreshAll();
    }
  }));
  sub(vscode.workspace.onDidChangeTextDocument((e) => {
    const d = e.document;
    if (d.languageId === LANG && d.uri.scheme === 'file') {
      index.set(d.fileName, d.getText());
      refreshAll();
    }
  }));
  sub(vscode.workspace.onDidCloseTextDocument((d) => {
    if (d.languageId !== LANG || d.uri.scheme !== 'file') return;
    collection.delete(d.uri);
    const text = readFile(d.fileName); // drop unsaved changes
    if (text === undefined) index.delete(d.fileName);
    else index.set(d.fileName, text);
    refreshAll();
  }));

  const iniWatcher = vscode.workspace.createFileSystemWatcher('**/*.ini');
  const onIniDisk = (uri) => {
    const open = vscode.workspace.textDocuments.find((d) => d.fileName === uri.fsPath);
    if (open && open.isDirty) return;
    const text = readFile(uri.fsPath);
    if (text === undefined) index.delete(uri.fsPath);
    else index.set(uri.fsPath, text);
    refreshAll();
  };
  iniWatcher.onDidCreate(onIniDisk);
  iniWatcher.onDidChange(onIniDisk);
  iniWatcher.onDidDelete(onIniDisk);
  sub(iniWatcher);

  const nedWatcher = vscode.workspace.createFileSystemWatcher('**/*.ned');
  nedWatcher.onDidCreate((u) => indexNed(u.fsPath));
  nedWatcher.onDidChange((u) => indexNed(u.fsPath));
  nedWatcher.onDidDelete((u) => indexNed(u.fsPath));
  sub(nedWatcher);

  sub(vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('omnetppIni')) refreshAll();
  }));

  sub(vscode.languages.registerCompletionItemProvider(SELECTOR, { provideCompletionItems: complete },
    '.', '{', '/', '=', ',', ' '));
  sub(vscode.languages.registerHoverProvider(SELECTOR, { provideHover: hover }));
  sub(vscode.languages.registerDefinitionProvider(SELECTOR, { provideDefinition: definition }));
  sub(vscode.languages.registerReferenceProvider(SELECTOR, { provideReferences: references }));
  sub(vscode.languages.registerDocumentSymbolProvider(SELECTOR, { provideDocumentSymbols: symbols }));
  sub(vscode.languages.registerFoldingRangeProvider(SELECTOR, { provideFoldingRanges: folding }));

  buildIndex();
}

function deactivate() {}

module.exports = { activate, deactivate, nedDiagnostics, docOf: (f) => index.get(f).doc };
