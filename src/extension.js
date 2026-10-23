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

const LANG = 'omnetpp-ini';
const SELECTOR = { language: LANG };
const EXCLUDE = '{**/node_modules/**,**/out/**,**/.git/**}';
const RECORDING_MODES = ['default', 'all', 'vector', 'count', 'last', 'sum', 'mean', 'min', 'max',
  'timeavg', 'stats', 'histogram'];

function readFile(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

const index = new IniIndex(readFile);
const networks = new Map(); // NED network name => [{file, line, qualified}]

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

// ---------------------------------------------------------------- NED networks

function indexNed(file) {
  for (const [name, list] of networks) {
    const rest = list.filter((n) => n.file !== file);
    if (rest.length) networks.set(name, rest);
    else networks.delete(name);
  }
  const text = readFile(file);
  if (text === undefined) return;
  const pkg = /^\s*package\s+([\w.]+)\s*;/m.exec(text);
  const lines = text.split(/\r?\n/);
  lines.forEach((l, line) => {
    const m = /^\s*network\s+([A-Za-z_]\w*)/.exec(l);
    if (!m) return;
    const qualified = pkg ? `${pkg[1]}.${m[1]}` : m[1];
    for (const name of new Set([m[1], qualified])) {
      if (!networks.has(name)) networks.set(name, []);
      networks.get(name).push({ file, line, start: m.index + m[0].length - m[1].length, end: m.index + m[0].length, qualified });
    }
  });
}

// ---------------------------------------------------------------- diagnostics

const collection = vscode.languages.createDiagnosticCollection(LANG);

function refreshDiagnostics(document) {
  if (document.languageId !== LANG || document.uri.scheme !== 'file') return;
  const list = diagnose(document.fileName, index).map((d) => {
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
      // per-object options after the last dot
      const range = wordRange(position, prefix, /[\w-]*$/);
      return options.options.filter((o) => o.scope === 'per-object').map((o) => {
        const i = item(o.name.replace('%', '0'), vscode.CompletionItemKind.Property, `<${o.type}> per-object option`, options.optionMarkdown(o));
        i.range = range;
        i.insertText = new vscode.SnippetString(`${o.name.replace('%', '${1:0}')} = `);
        return i;
      });
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
    return [...networks.entries()].filter(([name]) => !name.includes('.')).map(([name, list]) => {
      const i = item(name, vscode.CompletionItemKind.Module, list[0].qualified, relative(list[0].file));
      i.range = range;
      return i;
    });
  }
  const o = optionOfKey(key);
  if (o && o.type === 'bool') {
    return ['true', 'false'].map((v) => {
      const i = item(v, vscode.CompletionItemKind.Value);
      i.range = range;
      return i;
    });
  }
  if (o && o.name === 'result-recording-modes') {
    const r = wordRange(position, prefix, /[\w]*$/);
    return RECORDING_MODES.map((v) => {
      const i = item(v, vscode.CompletionItemKind.EnumMember);
      i.range = r;
      return i;
    });
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
      const o = optionOfKey(it.key);
      if (o) text = options.optionMarkdown(o);
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
      const list = networks.get(it.name) || [];
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
      return (networks.get(it.name) || []).map((n) => locationOf(n.file, n));
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

module.exports = { activate, deactivate };
