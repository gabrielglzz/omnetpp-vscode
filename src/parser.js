// Parser for OMNeT++ ini files. Pure JavaScript (no `vscode` dependency) so it
// can be tested with plain Node. Mirrors the rules of OMNeT++'s
// src/envir/inifilereader.cc: line continuation with a trailing backslash or
// with indentation, `#` comments, `include`, `[General]` / `[Config X]` / `[X]`.
//
// All positions are 0-based {line, start, end} (end exclusive) in the source.
'use strict';

const NAME = '[A-Za-z_]\\w*';
const VAR_RE = new RegExp(`\\$\\{\\s*(${NAME})\\s*(=|\\})`, 'g');
const PARALLEL_RE = new RegExp(`\\$\\{[^{}]*?!\\s*(${NAME})`, 'g');

function isBlank(s) {
  return /^\s*$/.test(s);
}

// Index where the content of a line ends: before a `#` comment that is not
// inside a string constant. `inString` is true when the line continues a
// string from the previous one. Returns {end, unterminated}.
function contentEnd(text, from = 0, inString = false) {
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
    } else if (c === '#') {
      return { end: i, unterminated: false };
    }
  }
  return { end: text.length, unterminated: inString };
}

// Groups physical lines into logical lines like InifileReader::forEachJoinedLine.
function joinLines(rawLines) {
  const logical = [];
  let cur = null;
  const curIsContent = () => {
    const first = cur.segs[0].text;
    return !isBlank(first) && first.trimStart()[0] !== '#';
  };
  for (let i = 0; i < rawLines.length; i++) {
    const text = rawLines[i];
    if (cur) {
      const last = cur.segs[cur.segs.length - 1];
      if (last.text.endsWith('\\') && curIsContent()) {
        last.continued = true;
        cur.segs.push({ line: i, text });
        continue;
      }
      if (curIsContent() && !isBlank(text) && /^[ \t]/.test(text)) {
        cur.segs.push({ line: i, text });
        continue;
      }
      logical.push(cur);
    }
    cur = { segs: [{ line: i, text }] };
  }
  if (cur) logical.push(cur);
  return logical;
}

// Returns the index just after the `}` matching the `${` at `start`, or -1.
function matchBrace(text, start) {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return i + 1;
  }
  return -1;
}

function validSectionName(name) {
  if (/\s/.test(name)) return 'It may not contain spaces';
  if (!/^[A-Za-z_]/.test(name)) return 'Must begin with a letter or underscore';
  const bad = name.match(/[^\w@-]/);
  if (bad) return `Contains illegal character '${bad[0]}'`;
  return null;
}

function parse(text) {
  const rawLines = text.split(/\r?\n/);
  const doc = {
    lineCount: rawLines.length,
    sections: [],
    includes: [],
    entries: [],
    extendsRefs: [],
    varDefs: [],
    varRefs: [],
    errors: [],
  };
  const error = (line, start, end, message) => doc.errors.push({ line, start, end, message });
  let section = null; // null: before the first heading (General, or the includer's section)
  const sectionsInFile = new Set();

  for (const logical of joinLines(rawLines)) {
    // Content of each physical segment, without comments and continuation backslashes.
    // OMNeT++ joins backslash-continued lines before looking for strings and
    // comments, so a string may go on in the next line and a comment hides the
    // rest of the joined line. Indented continuation lines are checked one by one.
    let inString = false;
    let commented = false;
    const segs = logical.segs.map((s, i) => {
      if (!(i > 0 && logical.segs[i - 1].continued)) inString = commented = false;
      if (commented) return { line: s.line, text: s.text, end: 0 };
      const { end, unterminated } = contentEnd(s.text, 0, inString);
      let stop = end;
      if (end < s.text.length) commented = true;
      else if (s.continued) stop--; // drop the backslash
      inString = unterminated && s.continued;
      if (unterminated && !s.continued) error(s.line, 0, s.text.length, 'Unterminated string constant');
      return { line: s.line, text: s.text, end: stop };
    });
    const first = segs[0];
    const content = first.text.slice(0, first.end);
    if (isBlank(content) && segs.length === 1) continue;
    const col = content.length - content.trimStart().length;
    const c = content[col];
    const lineLen = first.text.length;

    if (col > 0 && c !== undefined) {
      error(first.line, 0, lineLen,
        'Content must begin on column 1 because indentation is used for line continuation');
    }
    if (c === undefined) continue; // pure comment line
    if (c === ';') {
      error(first.line, col, lineLen, 'Use hash mark instead of semicolon to start comments');
      continue;
    }

    let m;
    if ((m = /^include\s+/.exec(content.slice(col)))) {
      const start = col + m[0].length;
      const path = content.slice(start).trim();
      doc.includes.push({ path, line: first.line, start, end: start + path.length, section });
      continue;
    }

    if (c === '[') {
      const trimmed = content.trimEnd();
      if (!trimmed.endsWith(']')) {
        error(first.line, col, trimmed.length, 'Syntax error in section heading');
        continue;
      }
      const inner = trimmed.slice(col + 1, -1);
      let nameStart = col + 1 + (inner.length - inner.trimStart().length);
      let name = inner.trim();
      const hasConfigPrefix = /^Config\s/.test(name);
      if (hasConfigPrefix) {
        const rest = name.slice(7);
        nameStart += 7 + (rest.length - rest.trimStart().length);
        name = rest.trim();
      }
      const nameEnd = nameStart + name.length;
      if (!name) {
        error(first.line, col, trimmed.length, 'Section name cannot be empty');
        continue;
      }
      if (name !== 'General') {
        const why = validSectionName(name);
        if (why) error(first.line, nameStart, nameEnd, `Invalid section name [${name}]: ${why}`);
      }
      if (sectionsInFile.has(name)) {
        error(first.line, nameStart, nameEnd, `Duplicate section '${name}' within file`);
      }
      sectionsInFile.add(name);
      if (doc.sections.length) doc.sections[doc.sections.length - 1].endLine = logical.segs[0].line - 1;
      section = name;
      doc.sections.push({
        name, hasConfigPrefix, line: first.line, start: nameStart, end: nameEnd,
        endLine: doc.lineCount - 1,
      });
      continue;
    }

    // key = value. OMNeT++ joins the lines first, so the key may go on in a
    // continuation line (`**.radio. \` + `power = 1mW`) and `=` may start one.
    const segText = (s, i) => s.text.slice(i ? 0 : col, s.end);
    const eqSeg = segs.findIndex((s, i) => segText(s, i).includes('='));
    const eqAt = eqSeg < 0 ? -1 : (eqSeg ? 0 : col) + segText(segs[eqSeg], eqSeg).indexOf('=');
    const keyParts = eqSeg < 0 ? [] : segs.slice(0, eqSeg + 1).map((s, i) => {
      const part = s.text.slice(i ? 0 : col, i === eqSeg ? eqAt : s.end);
      return i && !logical.segs[i - 1].continued ? '\n' + part : part; // indented lines keep the line break
    });
    const key = keyParts.join('').trim();
    if (eqSeg < 0 || !key) {
      error(first.line, col, content.trimEnd().length, 'Line must be in the form key=value');
      continue;
    }
    const keyStart = col;
    const keyEnd = col + keyParts[0].trimEnd().length;
    const eqLine = segs[eqSeg];
    const valueSegs = [{ line: eqLine.line, start: eqAt + 1, text: eqLine.text.slice(eqAt + 1, eqLine.end) }];
    for (const s of segs.slice(eqSeg + 1)) valueSegs.push({ line: s.line, start: 0, text: s.text.slice(0, s.end) });
    const value = valueSegs.map((s) => s.text).join(' ').trim();
    const entry = { key, line: first.line, keyStart, keyEnd, section, value, valueSegs };
    doc.entries.push(entry);

    for (const s of valueSegs) {
      VAR_RE.lastIndex = 0;
      while ((m = VAR_RE.exec(s.text))) {
        const nameOffset = m.index + m[0].indexOf(m[1]);
        const pos = { name: m[1], line: s.line, start: s.start + nameOffset, end: s.start + nameOffset + m[1].length, section };
        if (m[2] === '=') {
          const close = matchBrace(s.text, m.index + 1);
          pos.text = s.text.slice(m.index, close < 0 ? s.text.length : close);
          pos.entry = entry;
          doc.varDefs.push(pos);
        } else {
          doc.varRefs.push(pos);
        }
      }
      PARALLEL_RE.lastIndex = 0;
      while ((m = PARALLEL_RE.exec(s.text))) {
        const nameOffset = m.index + m[0].length - m[1].length;
        doc.varRefs.push({ name: m[1], line: s.line, start: s.start + nameOffset, end: s.start + nameOffset + m[1].length, section });
      }
    }

    if (key === 'extends') {
      for (const s of valueSegs) {
        const re = /[^,\s]+/g;
        while ((m = re.exec(s.text))) {
          doc.extendsRefs.push({ name: m[0], line: s.line, start: s.start + m.index, end: s.start + m.index + m[0].length, section, entry });
        }
      }
    }
  }
  return doc;
}

// Name of the section that contains the given line (null before the first heading).
function sectionAtLine(doc, line) {
  let name = null;
  for (const s of doc.sections) {
    if (s.line > line) break;
    name = s.name;
  }
  return name;
}

function contains(pos, line, character) {
  return pos.line === line && character >= pos.start && character <= pos.end;
}

// What is under the cursor: {kind, item}, or null.
function itemAt(doc, line, character) {
  for (const r of doc.varRefs) if (contains(r, line, character)) return { kind: 'varRef', item: r };
  for (const d of doc.varDefs) if (contains(d, line, character)) return { kind: 'varDef', item: d };
  for (const r of doc.extendsRefs) if (contains(r, line, character)) return { kind: 'extends', item: r };
  for (const i of doc.includes) if (contains(i, line, character)) return { kind: 'include', item: i };
  for (const s of doc.sections) if (contains(s, line, character)) return { kind: 'section', item: s };
  for (const e of doc.entries) {
    if (e.line === line && character >= e.keyStart && character <= e.keyEnd) return { kind: 'key', item: e };
    if (e.key === 'network' && e.valueSegs.some((s) => s.line === line && character >= s.start)) {
      const s = e.valueSegs.find((v) => v.line === line);
      const m = /[A-Za-z_][\w.]*/.exec(s.text);
      if (m) {
        const start = s.start + m.index;
        const pos = { name: m[0], line, start, end: start + m[0].length };
        if (contains(pos, line, character)) return { kind: 'network', item: pos };
      }
    }
  }
  return null;
}

module.exports = { parse, sectionAtLine, itemAt, contentEnd };
