#!/usr/bin/env node
/**
 * Parse a govinfo PLAW <pre>-format HTML file (e.g. PLAW-119publ21.htm) into
 * an array of section records suitable for the federal_public_laws table.
 *
 * Usage: node parse-publaw.js <raw.htm> <ACT_ID> "<SHORT TITLE>" <source_url> [out.json]
 *
 * Strategy:
 *  - Decode the <pre> body to plain text (keep <<NOTE: ...>> as literal text).
 *  - Walk lines, tracking the current TITLE and Subtitle headers (column 0).
 *  - Split sections on column-0 "SECTION N." / "SEC. N." headers. Amendatory
 *    text that quotes "SEC." appears indented, so it does not false-match.
 *  - Lowercase "Sec." table-of-contents entries are ignored (uppercase anchor).
 *  - Track the most recent [[Page NNN STAT. MMM]] marker for a citation.
 */

const fs = require('fs');

const [, , rawPath, actId, shortTitle, sourceUrl, outPath] = process.argv;
if (!rawPath || !actId || !shortTitle || !sourceUrl) {
  console.error('Usage: node parse-publaw.js <raw.htm> <ACT_ID> "<SHORT TITLE>" <source_url> [out.json]');
  process.exit(1);
}

function decodeEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&'); // last, so &amp;lt; etc. resolve correctly
}

// Remove <<NOTE: ...>> annotations (may be useful, but they clutter headings).
function stripNotes(s) {
  return s.replace(/<<[^>]*?>>/g, ' ').replace(/\s+/g, ' ').trim();
}

const html = fs.readFileSync(rawPath, 'utf8');
const preMatch = html.match(/<pre>([\s\S]*?)<\/pre>/i);
const body = decodeEntities(preMatch ? preMatch[1] : html);
const lines = body.split('\n');

// TITLE/Subtitle headers are indented, may carry an interrupting <<NOTE: ...>>
// (placed before OR after the numeral) and may wrap across lines. Detect the
// start word, gather continuation lines, strip notes, then parse numeral + name.
const TITLE_START = /^\s*TITLE\b/;
const SUBTITLE_START = /^\s*Subtitle\b/;
const TITLE_PARSE = /^TITLE\s+([IVXLC]+)\s*--\s*(.+)$/;
const SUBTITLE_PARSE = /^Subtitle\s+([A-Z])\s*--\s*(.+)$/;
const SEC_RE = /^(SECTION|SEC\.)\s+([0-9A-Za-z][-0-9A-Za-z.]*?)\.\s*(.*)$/;
const STAT_RE = /\[\[Page\s+(\d+)\s+STAT\.\s+(\d+)\]\]/;
const PAGE_RE = /^\[\[Page[^\]]*\]\]\s*$/;

let currentTitleNum = null;
let currentTitleName = null;
let currentSubtitle = null;
let statPage = null;

const sections = [];
let cur = null; // active section being accumulated

function flush() {
  if (!cur) return;
  // Heading = first line plus continuation lines up to the first blank line.
  let headingLines = [];
  let bodyStart = 0;
  for (let i = 0; i < cur.rawLines.length; i++) {
    if (cur.rawLines[i].trim() === '') { bodyStart = i + 1; break; }
    headingLines.push(cur.rawLines[i]);
    bodyStart = i + 1;
  }
  const heading = stripNotes(headingLines.join(' '));
  const content = cur.rawLines
    .slice(bodyStart)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+$/gm, '')
    .trim();
  const fullText = (heading + '\n\n' + content).trim();
  sections.push({
    act_id: actId,
    act_short_title: shortTitle,
    title_num: cur.title_num,
    title_name: cur.title_name,
    subtitle: cur.subtitle,
    section_number: cur.section_number,
    section_heading: heading,
    content,
    stat_page: cur.stat_page,
    source_url: sourceUrl,
    word_count: fullText.split(/\s+/).filter(Boolean).length
  });
  cur = null;
}

// Gather a header that begins at startIdx, joining continuation lines until the
// notes are balanced and a "--" separator is present (or we hit a blank/SEC line).
// Returns the note-stripped text and the index of the last consumed line.
function gatherHeader(startIdx) {
  let text = lines[startIdx];
  let j = startIdx;
  // A header block runs until the next blank line or SECTION header. This pulls
  // in both wrapped <<NOTE: ...>> annotations and wrapped name continuations.
  while (j + 1 < lines.length && j - startIdx < 6) {
    const nxt = lines[j + 1];
    if (nxt.trim() === '' || SEC_RE.test(nxt) || PAGE_RE.test(nxt)) break;
    j++;
    text += ' ' + nxt;
  }
  return { text: stripNotes(text), end: j };
}

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];

  const stat = line.match(STAT_RE);
  if (stat) { statPage = `${stat[1]} Stat. ${stat[2]}`; continue; }
  if (PAGE_RE.test(line)) continue; // bare [[Page N]] markers

  if (TITLE_START.test(line)) {
    const { text, end } = gatherHeader(i);
    const m = text.match(TITLE_PARSE);
    if (m) {
      currentTitleNum = m[1];
      currentTitleName = m[2].trim();
      currentSubtitle = null;
      i = end;
      continue;
    }
  }

  if (SUBTITLE_START.test(line)) {
    const { text, end } = gatherHeader(i);
    const m = text.match(SUBTITLE_PARSE);
    if (m) {
      currentSubtitle = `Subtitle ${m[1]}--${m[2].trim()}`;
      i = end;
      continue;
    }
  }

  const secM = line.match(SEC_RE);
  if (secM) {
    flush();
    cur = {
      section_number: secM[2],
      title_num: currentTitleNum,
      title_name: currentTitleName,
      subtitle: currentSubtitle,
      stat_page: statPage,
      rawLines: [secM[3]] // text after "SEC. N." on the header line
    };
    continue;
  }

  if (cur) cur.rawLines.push(line);
}
flush();

// Dedupe by section_number, keeping the record with the most content (real body
// over any stray table entry). Front-matter sections (TABLE OF CONTENTS) kept.
const byNum = new Map();
for (const s of sections) {
  const prev = byNum.get(s.section_number);
  if (!prev || s.content.length > prev.content.length) byNum.set(s.section_number, s);
}
const deduped = [...byNum.values()];

const out = outPath || rawPath.replace(/\.htm$/, '.json');
fs.writeFileSync(out, JSON.stringify(deduped, null, 2));

const titles = [...new Set(deduped.map(s => s.title_num).filter(Boolean))];
console.log(`Parsed ${sections.length} raw -> ${deduped.length} unique sections`);
console.log(`Titles: ${titles.join(', ')}`);
console.log(`Total words: ${deduped.reduce((a, s) => a + s.word_count, 0).toLocaleString()}`);
console.log(`Wrote ${out}`);
