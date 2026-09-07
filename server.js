#!/usr/bin/env node
/**
 * CT UPM Remote MCP Server
 *
 * A publicly-deployable MCP server providing access to the Connecticut DSS
 * Uniform Policy Manual. Uses SQLite (portable) and Streamable HTTP transport.
 *
 * Designed to be deployed on Railway, Fly.io, Render, or any Node.js host.
 * Other Claude users can add this as a remote MCP integration.
 *
 * Usage:
 *   node server.js                           # Start on port 3100
 *   PORT=8080 node server.js                 # Custom port
 *   API_KEY=secret123 node server.js         # Require API key
 *
 * Connect from Claude Desktop / Claude Code:
 *   { "url": "https://your-host.example.com/mcp" }
 */

import { createServer as createHttpServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = parseInt(process.env.PORT || '3100', 10);
const API_KEY = process.env.API_KEY || null; // Optional: set to require auth
const DB_PATH = process.env.DB_PATH || join(__dirname, 'data', 'ct-upm.db');

// Response limits
const MAX_RESULTS = 20;
const MAX_CONTENT_LENGTH = 15000;
const MAX_SNIPPET_LENGTH = 500;

// Chapter topic mappings for intelligent search
const CHAPTER_TOPICS = {
  'UPM0': ['table of contents', 'manual structure', 'index'],
  'UPM1': ['rights', 'responsibilities', 'eligibility process', 'application', 'interview', 'verification', 'appeals', 'fair hearing'],
  'UPM2': ['assistance unit', 'categorical eligibility', 'household', 'family', 'spouse', 'dependent'],
  'UPM3': ['citizenship', 'residency', 'identity', 'social security', 'procedures', 'technical eligibility'],
  'UPM4': ['assets', 'resources', 'property', 'transfer', 'penalty', 'lookback', 'exempt', 'countable', 'home', 'vehicle', 'burial', 'life insurance', 'annuity', 'trust', 'inaccessible'],
  'UPM5': ['income', 'earnings', 'disregard', 'patient liability', 'applied income', 'deductions', 'shelter', 'medical expenses'],
  'UPM6': ['benefits', 'calculation', 'payment', 'issuance', 'amount'],
  'UPM7': ['overpayment', 'recovery', 'recoupment', 'error', 'fraud'],
  'UPM8': ['saga', 'jobs first', 'state supplement', 'special programs'],
  'UPM9': ['special benefits', 'emergency']
};

function mapQueryToChapters(query) {
  const lowerQuery = query.toLowerCase();
  const matched = [];
  for (const [chapter, topics] of Object.entries(CHAPTER_TOPICS)) {
    for (const topic of topics) {
      if (lowerQuery.includes(topic) || topic.includes(lowerQuery.split(' ')[0])) {
        if (!matched.includes(chapter)) matched.push(chapter);
      }
    }
  }
  return matched.length > 0 ? matched : ['UPM4', 'UPM5'];
}

function extractSectionReferences(content) {
  if (!content) return [];
  const patterns = [
    /[Ss]ection\s+(\d{4}(?:[._]\d+)?[A-Z]?)/g,
    /[Ss]ee\s+(\d{4}(?:[._]\d+)?[A-Z]?)/g,
    /UPM\s+(\d{4}(?:[._]\d+)?[A-Z]?)/g,
    /\b(\d{4}[._]\d+[A-Z]?)\b/g
  ];
  const refs = new Set();
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      refs.add(match[1].replace('.', '_'));
    }
  }
  return Array.from(refs);
}

function truncate(text, maxLength) {
  if (!text) return '';
  return text.length <= maxLength ? text : text.substring(0, maxLength - 3) + '...';
}

// Windowed full-text read for the *_get tools. A flat 15,000-character cap silently
// dropped the DECISION section of any hearing over ~2,600 words (found by the Felix
// Law Watch agent 9/6/26). Callers page with `offset`; `max_chars` up to 60,000.
const MAX_GET_CHARS = 60000;
function windowContent(text, args = {}) {
  const full = text || '';
  const offset = Math.max(0, parseInt(args.offset || 0, 10) || 0);
  const max = Math.min(MAX_GET_CHARS, Math.max(1000, parseInt(args.max_chars || MAX_CONTENT_LENGTH, 10) || MAX_CONTENT_LENGTH));
  const slice = full.substring(offset, offset + max);
  return {
    content: slice,
    content_offset: offset,
    content_chars: slice.length,
    total_chars: full.length,
    truncated: offset + slice.length < full.length,
    next_offset: offset + slice.length < full.length ? offset + slice.length : null
  };
}

function extractSnippet(content, searchTerms, snippetLength = MAX_SNIPPET_LENGTH) {
  if (!content || !searchTerms?.length) return truncate(content, snippetLength);
  const lower = content.toLowerCase();
  let firstMatch = content.length;
  for (const term of searchTerms) {
    const pos = lower.indexOf(term.toLowerCase());
    if (pos !== -1 && pos < firstMatch) firstMatch = pos;
  }
  if (firstMatch === content.length) return truncate(content, snippetLength);
  const start = Math.max(0, firstMatch - 100);
  const end = Math.min(content.length, firstMatch + snippetLength - 100);
  let snippet = content.substring(start, end);
  if (start > 0) snippet = '...' + snippet;
  if (end < content.length) snippet += '...';
  return snippet;
}

// Open SQLite database (read-only)
const db = new Database(DB_PATH, { readonly: true });
db.pragma('journal_mode = WAL');

// Prepared statements
const stmts = {
  // Search: current sections first, superseded last
  searchFts: db.prepare(`
    SELECT s.id, s.section_number, s.title, s.word_count, c.chapter_number,
           s.superseded_by, s.effective_date, rank
    FROM sections_fts fts
    JOIN sections s ON fts.rowid = s.id
    JOIN chapters c ON s.chapter_id = c.id
    WHERE sections_fts MATCH ?
    ORDER BY (CASE WHEN s.superseded_by IS NOT NULL THEN 1 ELSE 0 END), rank
    LIMIT ?
  `),
  searchFtsChapter: db.prepare(`
    SELECT s.id, s.section_number, s.title, s.word_count, c.chapter_number,
           s.superseded_by, s.effective_date, rank
    FROM sections_fts fts
    JOIN sections s ON fts.rowid = s.id
    JOIN chapters c ON s.chapter_id = c.id
    WHERE sections_fts MATCH ? AND c.chapter_number = ?
    ORDER BY (CASE WHEN s.superseded_by IS NOT NULL THEN 1 ELSE 0 END), rank
    LIMIT ?
  `),
  getSection: db.prepare(`
    SELECT s.*, c.chapter_number, c.title as chapter_title,
           s.superseded_by, s.effective_date
    FROM sections s JOIN chapters c ON s.chapter_id = c.id
    WHERE s.section_number = ?
  `),
  getSectionContent: db.prepare('SELECT content FROM sections WHERE section_number = ?'),
  listChapters: db.prepare('SELECT chapter_number, title FROM chapters ORDER BY id'),
  listSections: db.prepare(`
    SELECT s.section_number, s.title, s.word_count
    FROM sections s JOIN chapters c ON s.chapter_id = c.id
    WHERE c.chapter_number = ? ORDER BY s.section_number
  `),
  searchTransmittalsFts: db.prepare(`
    SELECT t.transmittal_number, t.year, t.sequence, t.title
    FROM transmittals_fts fts
    JOIN transmittals t ON fts.rowid = t.id
    WHERE transmittals_fts MATCH ?
    ORDER BY rank LIMIT ?
  `),
  searchTransmittalsFtsYear: db.prepare(`
    SELECT t.transmittal_number, t.year, t.sequence, t.title
    FROM transmittals_fts fts
    JOIN transmittals t ON fts.rowid = t.id
    WHERE transmittals_fts MATCH ? AND t.year = ?
    ORDER BY rank LIMIT ?
  `),
  transmittalsByYear: db.prepare(`
    SELECT transmittal_number, year, sequence, title
    FROM transmittals WHERE year = ? ORDER BY sequence DESC LIMIT ?
  `),
  recentTransmittals: db.prepare(`
    SELECT transmittal_number, year, sequence, title
    FROM transmittals ORDER BY year DESC, sequence DESC LIMIT ?
  `),
  getTransmittal: db.prepare('SELECT * FROM transmittals WHERE transmittal_number = ?'),
  sectionCount: db.prepare('SELECT COUNT(*) as count FROM sections'),
  transmittalCount: db.prepare('SELECT COUNT(*) as count FROM transmittals'),
  chapterBreakdown: db.prepare(`
    SELECT c.chapter_number, c.title, COUNT(s.id) as section_count, SUM(s.word_count) as total_words
    FROM chapters c LEFT JOIN sections s ON c.id = s.chapter_id
    GROUP BY c.id ORDER BY c.id
  `),
  transmittalYearRange: db.prepare('SELECT MIN(year) as oldest, MAX(year) as newest, COUNT(DISTINCT year) as year_count FROM transmittals'),
  searchSectionsLike: db.prepare(`
    SELECT DISTINCT s.section_number, s.title FROM sections s
    WHERE s.content LIKE ? OR s.content LIKE ? LIMIT 10
  `),
  findTransmittalsForSection: db.prepare(`
    SELECT transmittal_number, year, title, SUBSTR(content, 1, 1000) as excerpt
    FROM transmittals
    WHERE (content LIKE ? OR content LIKE ? OR title LIKE ?) AND year >= ?
    ORDER BY year DESC, sequence DESC LIMIT 10
  `),
  // SMM (State Medicaid Manual) statements
  searchSmmFts: db.prepare(`
    SELECT s.id, s.section_number, s.section_range_end, s.title, s.chapter_id,
           s.word_count, c.chapter_number, c.title as chapter_title, rank
    FROM smm_fts fts
    JOIN smm_sections s ON fts.rowid = s.id
    JOIN smm_chapters c ON s.chapter_id = c.id
    WHERE smm_fts MATCH ?
    ORDER BY rank LIMIT ?
  `),
  searchSmmFtsChapter: db.prepare(`
    SELECT s.id, s.section_number, s.section_range_end, s.title, s.chapter_id,
           s.word_count, c.chapter_number, c.title as chapter_title, rank
    FROM smm_fts fts
    JOIN smm_sections s ON fts.rowid = s.id
    JOIN smm_chapters c ON s.chapter_id = c.id
    WHERE smm_fts MATCH ? AND c.chapter_number = ?
    ORDER BY rank LIMIT ?
  `),
  getSmmSection: db.prepare(`
    SELECT s.*, c.chapter_number, c.title as chapter_title
    FROM smm_sections s JOIN smm_chapters c ON s.chapter_id = c.id
    WHERE s.section_number = ?
  `),
  getSmmSectionContent: db.prepare('SELECT content FROM smm_sections WHERE section_number = ?'),
  listSmmChapters: db.prepare(`
    SELECT c.chapter_number, c.title, COUNT(s.id) as section_count, SUM(s.word_count) as total_words
    FROM smm_chapters c LEFT JOIN smm_sections s ON c.id = s.chapter_id
    GROUP BY c.id ORDER BY c.chapter_number
  `),
  listSmmSections: db.prepare(`
    SELECT s.section_number, s.section_range_end, s.title, s.word_count
    FROM smm_sections s JOIN smm_chapters c ON s.chapter_id = c.id
    WHERE c.chapter_number = ? ORDER BY s.section_number
  `),
  smmSectionCount: db.prepare('SELECT COUNT(*) as count FROM smm_sections'),
  smmChapterCount: db.prepare('SELECT COUNT(*) as count FROM smm_chapters'),
  // Court decision statements
  searchCourtsFts: db.prepare(`
    SELECT c.id, c.case_name, c.court, c.year, c.volume, c.page, c.pdf_filename,
           c.word_count, c.page_count, c.matched_keywords, rank
    FROM courts_fts fts
    JOIN court_decisions c ON fts.rowid = c.id
    WHERE courts_fts MATCH ?
    ORDER BY rank LIMIT ?
  `),
  searchCourtsFtsCourt: db.prepare(`
    SELECT c.id, c.case_name, c.court, c.year, c.volume, c.page, c.pdf_filename,
           c.word_count, c.page_count, c.matched_keywords, rank
    FROM courts_fts fts
    JOIN court_decisions c ON fts.rowid = c.id
    WHERE courts_fts MATCH ? AND c.court = ?
    ORDER BY rank LIMIT ?
  `),
  searchCourtsFtsYear: db.prepare(`
    SELECT c.id, c.case_name, c.court, c.year, c.volume, c.page, c.pdf_filename,
           c.word_count, c.page_count, c.matched_keywords, rank
    FROM courts_fts fts
    JOIN court_decisions c ON fts.rowid = c.id
    WHERE courts_fts MATCH ? AND c.year = ?
    ORDER BY rank LIMIT ?
  `),
  searchCourtsFtsCourtYear: db.prepare(`
    SELECT c.id, c.case_name, c.court, c.year, c.volume, c.page, c.pdf_filename,
           c.word_count, c.page_count, c.matched_keywords, rank
    FROM courts_fts fts
    JOIN court_decisions c ON fts.rowid = c.id
    WHERE courts_fts MATCH ? AND c.court = ? AND c.year = ?
    ORDER BY rank LIMIT ?
  `),
  getCourt: db.prepare('SELECT * FROM court_decisions WHERE pdf_filename = ?'),
  getCourtByCaseName: db.prepare('SELECT * FROM court_decisions WHERE case_name = ?'),
  getCourtByCaseNamePrefix: db.prepare('SELECT * FROM court_decisions WHERE case_name LIKE ? ORDER BY year DESC LIMIT 1'),
  getCourtById: db.prepare('SELECT * FROM court_decisions WHERE id = ?'),
  getCourtContent: db.prepare('SELECT content FROM court_decisions WHERE pdf_filename = ?'),
  courtCount: db.prepare('SELECT COUNT(*) as count FROM court_decisions'),
  courtBreakdown: db.prepare(`
    SELECT court, COUNT(*) as count, SUM(word_count) as total_words,
           MIN(year) as min_year, MAX(year) as max_year
    FROM court_decisions GROUP BY court ORDER BY court
  `),
  // Hearing decision statements
  searchHearingsFts: db.prepare(`
    SELECT h.id, h.decision_number, h.category, h.year, h.case_number, h.title,
           h.word_count, h.page_count, rank
    FROM hearings_fts fts
    JOIN hearing_decisions h ON fts.rowid = h.id
    WHERE hearings_fts MATCH ?
    ORDER BY rank LIMIT ?
  `),
  searchHearingsFtsCat: db.prepare(`
    SELECT h.id, h.decision_number, h.category, h.year, h.case_number, h.title,
           h.word_count, h.page_count, rank
    FROM hearings_fts fts
    JOIN hearing_decisions h ON fts.rowid = h.id
    WHERE hearings_fts MATCH ? AND h.category LIKE ?
    ORDER BY rank LIMIT ?
  `),
  searchHearingsFtsYear: db.prepare(`
    SELECT h.id, h.decision_number, h.category, h.year, h.case_number, h.title,
           h.word_count, h.page_count, rank
    FROM hearings_fts fts
    JOIN hearing_decisions h ON fts.rowid = h.id
    WHERE hearings_fts MATCH ? AND h.year = ?
    ORDER BY rank LIMIT ?
  `),
  searchHearingsFtsCatYear: db.prepare(`
    SELECT h.id, h.decision_number, h.category, h.year, h.case_number, h.title,
           h.word_count, h.page_count, rank
    FROM hearings_fts fts
    JOIN hearing_decisions h ON fts.rowid = h.id
    WHERE hearings_fts MATCH ? AND h.category LIKE ? AND h.year = ?
    ORDER BY rank LIMIT ?
  `),
  getHearing: db.prepare('SELECT * FROM hearing_decisions WHERE decision_number = ?'),
  getHearingContent: db.prepare('SELECT content FROM hearing_decisions WHERE decision_number = ?'),
  hearingCount: db.prepare('SELECT COUNT(*) as count FROM hearing_decisions'),
  hearingCategoryBreakdown: db.prepare(`
    SELECT category, COUNT(*) as count, SUM(word_count) as total_words,
           MIN(year) as min_year, MAX(year) as max_year
    FROM hearing_decisions GROUP BY category ORDER BY category
  `),
  // CT statute statements (Titles 17b, 19a, 45a)
  searchStatutesFts: db.prepare(`
    SELECT s.id, s.title_num, s.chapter_name, s.chapter_title, s.section_number, s.section_title,
           s.word_count, s.source_url, rank
    FROM statutes_fts fts
    JOIN ct_statutes s ON fts.rowid = s.id
    WHERE statutes_fts MATCH ?
    ORDER BY rank LIMIT ?
  `),
  searchStatutesFtsTitle: db.prepare(`
    SELECT s.id, s.title_num, s.chapter_name, s.chapter_title, s.section_number, s.section_title,
           s.word_count, s.source_url, rank
    FROM statutes_fts fts
    JOIN ct_statutes s ON fts.rowid = s.id
    WHERE statutes_fts MATCH ? AND s.title_num = ?
    ORDER BY rank LIMIT ?
  `),
  getStatute: db.prepare('SELECT * FROM ct_statutes WHERE section_number = ?'),
  getStatuteContent: db.prepare('SELECT content FROM ct_statutes WHERE section_number = ?'),
  statuteCount: db.prepare('SELECT COUNT(*) as count FROM ct_statutes'),
  statuteTitleBreakdown: db.prepare(`
    SELECT title_num, COUNT(*) as count, SUM(word_count) as total_words
    FROM ct_statutes GROUP BY title_num ORDER BY title_num
  `),
  // 42 CFR statements
  searchCfrFts: db.prepare(`
    SELECT c.id, c.part_num, c.part_title, c.subpart, c.subpart_title, c.section_number, c.section_title,
           c.word_count, rank
    FROM cfr_fts fts
    JOIN cfr_sections c ON fts.rowid = c.id
    WHERE cfr_fts MATCH ?
    ORDER BY rank LIMIT ?
  `),
  searchCfrFtsPart: db.prepare(`
    SELECT c.id, c.part_num, c.part_title, c.subpart, c.subpart_title, c.section_number, c.section_title,
           c.word_count, rank
    FROM cfr_fts fts
    JOIN cfr_sections c ON fts.rowid = c.id
    WHERE cfr_fts MATCH ? AND c.part_num = ?
    ORDER BY rank LIMIT ?
  `),
  getCfr: db.prepare('SELECT * FROM cfr_sections WHERE section_number = ?'),
  getCfrContent: db.prepare('SELECT content FROM cfr_sections WHERE section_number = ?'),
  cfrCount: db.prepare('SELECT COUNT(*) as count FROM cfr_sections'),
  cfrPartBreakdown: db.prepare(`
    SELECT part_num, part_title, COUNT(*) as count, SUM(word_count) as total_words
    FROM cfr_sections GROUP BY part_num, part_title ORDER BY part_num
  `),
  // CT Regulations statements
  searchRegsFts: db.prepare(`
    SELECT r.id, r.title_num, r.subtitle, r.subtitle_text, r.section_number, r.section_title,
           r.word_count, r.source_url, rank
    FROM regulations_fts fts
    JOIN ct_regulations r ON fts.rowid = r.id
    WHERE regulations_fts MATCH ?
    ORDER BY rank LIMIT ?
  `),
  searchRegsFtsTitle: db.prepare(`
    SELECT r.id, r.title_num, r.subtitle, r.subtitle_text, r.section_number, r.section_title,
           r.word_count, r.source_url, rank
    FROM regulations_fts fts
    JOIN ct_regulations r ON fts.rowid = r.id
    WHERE regulations_fts MATCH ? AND r.title_num = ?
    ORDER BY rank LIMIT ?
  `),
  getReg: db.prepare('SELECT * FROM ct_regulations WHERE section_number = ?'),
  getRegContent: db.prepare('SELECT content FROM ct_regulations WHERE section_number = ?'),
  regCount: db.prepare('SELECT COUNT(*) as count FROM ct_regulations'),
  regTitleBreakdown: db.prepare(`
    SELECT title_num, COUNT(*) as count, SUM(word_count) as total_words
    FROM ct_regulations GROUP BY title_num ORDER BY title_num
  `),
  // CMS Guidance statements
  searchGuidanceFts: db.prepare(`
    SELECT g.id, g.doc_type, g.filename, g.title, g.doc_date, g.year,
           g.word_count, g.page_count, g.source_url, rank
    FROM guidance_fts fts
    JOIN cms_guidance g ON fts.rowid = g.id
    WHERE guidance_fts MATCH ?
    ORDER BY rank LIMIT ?
  `),
  searchGuidanceFtsType: db.prepare(`
    SELECT g.id, g.doc_type, g.filename, g.title, g.doc_date, g.year,
           g.word_count, g.page_count, g.source_url, rank
    FROM guidance_fts fts
    JOIN cms_guidance g ON fts.rowid = g.id
    WHERE guidance_fts MATCH ? AND g.doc_type = ?
    ORDER BY rank LIMIT ?
  `),
  searchGuidanceFtsYear: db.prepare(`
    SELECT g.id, g.doc_type, g.filename, g.title, g.doc_date, g.year,
           g.word_count, g.page_count, g.source_url, rank
    FROM guidance_fts fts
    JOIN cms_guidance g ON fts.rowid = g.id
    WHERE guidance_fts MATCH ? AND g.year = ?
    ORDER BY rank LIMIT ?
  `),
  getGuidance: db.prepare('SELECT * FROM cms_guidance WHERE filename = ?'),
  getGuidanceContent: db.prepare('SELECT content FROM cms_guidance WHERE filename = ?'),
  guidanceCount: db.prepare('SELECT COUNT(*) as count FROM cms_guidance'),
  guidanceTypeBreakdown: db.prepare(`
    SELECT doc_type, COUNT(*) as count, SUM(word_count) as total_words,
           MIN(year) as min_year, MAX(year) as max_year
    FROM cms_guidance GROUP BY doc_type ORDER BY doc_type
  `),
  // Federal Public Law statements (OBBBA, DRA 2005, etc.)
  searchPublawsFts: db.prepare(`
    SELECT p.id, p.act_id, p.act_short_title, p.title_num, p.title_name, p.subtitle,
           p.section_number, p.section_heading, p.stat_page, p.source_url, p.word_count, rank
    FROM publaws_fts fts
    JOIN federal_public_laws p ON fts.rowid = p.id
    WHERE publaws_fts MATCH ?
    ORDER BY rank LIMIT ?
  `),
  searchPublawsFtsAct: db.prepare(`
    SELECT p.id, p.act_id, p.act_short_title, p.title_num, p.title_name, p.subtitle,
           p.section_number, p.section_heading, p.stat_page, p.source_url, p.word_count, rank
    FROM publaws_fts fts
    JOIN federal_public_laws p ON fts.rowid = p.id
    WHERE publaws_fts MATCH ? AND p.act_id = ?
    ORDER BY rank LIMIT ?
  `),
  getPublaw: db.prepare('SELECT * FROM federal_public_laws WHERE act_id = ? AND section_number = ?'),
  getPublawAnyAct: db.prepare('SELECT * FROM federal_public_laws WHERE section_number = ?'),
  getPublawContent: db.prepare('SELECT content FROM federal_public_laws WHERE id = ?'),
  publawCount: db.prepare('SELECT COUNT(*) as count FROM federal_public_laws'),
  publawActBreakdown: db.prepare(`
    SELECT act_id, act_short_title, COUNT(*) as count, SUM(word_count) as total_words
    FROM federal_public_laws GROUP BY act_id, act_short_title ORDER BY act_id
  `),
  publawTitleBreakdown: db.prepare(`
    SELECT act_id, title_num, title_name, COUNT(*) as count, SUM(word_count) as total_words
    FROM federal_public_laws GROUP BY act_id, title_num, title_name ORDER BY act_id, title_num
  `)
};

// FTS5 query sanitizer — escape special characters
function sanitizeFtsQuery(query) {
  // Remove FTS5 operators and special chars, keep words
  return query.replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim()
    .split(' ').filter(w => w.length > 1).join(' OR ');
}

/**
 * Tool definitions (identical API to local version)
 */
const TOOLS = [
  {
    name: 'upm_search',
    description: 'Search the Connecticut DSS Uniform Policy Manual for policy sections matching keywords. Returns section numbers, titles, and content snippets. Current policy is ranked above superseded versions. Results include currency warnings when a section has been replaced by a newer one (e.g., section 3028 was superseded by 3029 after the Deficit Reduction Act of 2005).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query (keywords, phrases, or section numbers like "4005" or "transfer penalty")' },
        chapter: { type: 'string', description: 'Filter by chapter (UPM0-UPM9). UPM4=Assets, UPM5=Income, UPM2=Eligibility' },
        limit: { type: 'integer', description: 'Maximum results (default 10, max 20)', default: 10 }
      },
      required: ['query']
    }
  },
  {
    name: 'upm_get_section',
    description: 'Get the full content of a specific UPM section by section number (e.g., "4005", "4030_10"). Use after searching to retrieve complete policy text.',
    inputSchema: {
      type: 'object',
      properties: {
        section_number: { type: 'string', description: 'The section number (e.g., "4005", "4030_10P")' }
      },
      required: ['section_number']
    }
  },
  {
    name: 'upm_list_chapters',
    description: 'List all UPM chapters with their titles. Useful for understanding the manual structure.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'upm_list_sections',
    description: 'List all sections within a specific chapter. Returns section numbers and titles.',
    inputSchema: {
      type: 'object',
      properties: {
        chapter: { type: 'string', description: 'Chapter to list (UPM0-UPM9)' }
      },
      required: ['chapter']
    }
  },
  {
    name: 'upm_search_transmittals',
    description: 'Search policy transmittals (policy updates and changes). Filter by year or search content.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query for transmittal content' },
        year: { type: 'integer', description: 'Filter by year (e.g., 2024, 2023)' },
        limit: { type: 'integer', description: 'Maximum results (default 10, max 20)', default: 10 }
      }
    }
  },
  {
    name: 'upm_get_transmittal',
    description: 'Get the full content of a specific policy transmittal by number (e.g., "24-01", "23-15").',
    inputSchema: {
      type: 'object',
      properties: {
        transmittal_number: { type: 'string', description: 'The transmittal number (e.g., "24-01")' }
      },
      required: ['transmittal_number']
    }
  },
  {
    name: 'upm_stats',
    description: 'Get database statistics: section count, chapter breakdown, transmittal count.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'upm_analyze',
    description: 'Comprehensive UPM analysis for a legal question. Automatically identifies relevant chapters, searches across them, retrieves full content and cross-references. Use for complex Medicaid policy questions.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The legal question to analyze' },
        depth: { type: 'string', enum: ['quick', 'standard', 'thorough'], description: 'Analysis depth. Default: standard' }
      },
      required: ['question']
    }
  },
  {
    name: 'upm_get_related',
    description: 'Find sections related to a given section — both outgoing references and sections that reference it.',
    inputSchema: {
      type: 'object',
      properties: {
        section_number: { type: 'string', description: 'The section number' }
      },
      required: ['section_number']
    }
  },
  {
    name: 'upm_check_updates',
    description: 'Check for transmittals affecting a specific section.',
    inputSchema: {
      type: 'object',
      properties: {
        section_number: { type: 'string', description: 'The section number' },
        years_back: { type: 'integer', description: 'Years to search back (default 3)', default: 3 }
      },
      required: ['section_number']
    }
  },
  {
    name: 'upm_get_limits',
    description: 'Get current Connecticut Medicaid financial limits — asset limits, income disregards, penalty divisor, spousal protections.',
    inputSchema: {
      type: 'object',
      properties: {
        category: { type: 'string', enum: ['all', 'assets', 'income', 'penalty', 'spousal'], description: 'Category. Default: all' }
      }
    }
  },
  {
    name: 'smm_search',
    description: 'Search the CMS State Medicaid Manual (Publication #45) — the FEDERAL reference manual governing how states implement Medicaid. Complements the CT UPM (state-level) by providing federal rules. 12 chapters, 62 sections covering eligibility, services, payments, program integrity.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query (e.g., "transfer of assets", "spousal impoverishment", "nursing facility services")' },
        chapter: { type: 'integer', description: 'Filter by chapter number (1-15). Ch2=Eligibility, Ch3=Financial, Ch4=Services' },
        limit: { type: 'integer', description: 'Max results (default 10, max 20)', default: 10 }
      },
      required: ['query']
    }
  },
  {
    name: 'smm_get_section',
    description: 'Get the full text of a specific SMM section by section number. Use after searching.',
    inputSchema: {
      type: 'object',
      properties: {
        section_number: { type: 'string', description: 'The section number (e.g., "3258", "2320")' }
      },
      required: ['section_number']
    }
  },
  {
    name: 'smm_list_chapters',
    description: 'List all CMS State Medicaid Manual chapters with section counts.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'smm_list_sections',
    description: 'List all sections within a specific SMM chapter.',
    inputSchema: {
      type: 'object',
      properties: {
        chapter: { type: 'integer', description: 'Chapter number (1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 13, 15)' }
      },
      required: ['chapter']
    }
  },
  {
    name: 'smm_stats',
    description: 'Get statistics on the CMS State Medicaid Manual database.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'court_search',
    description: 'Search CT Appellate and Supreme Court decisions related to Medicaid, conservatorship, elder law, and social services. 530+ decisions (2003-present, refreshed weekly) covering DSS disputes, nursing home cases, asset transfers, conservatorships, incapacity, and waiver programs.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query (e.g., "transfer penalty lookback", "conservatorship Medicaid", "nursing home discharge")' },
        court: { type: 'string', enum: ['appellate', 'supreme'], description: 'Filter by court (appellate or supreme)' },
        year: { type: 'integer', description: 'Filter by year (2003-2026)' },
        limit: { type: 'integer', description: 'Max results (default 10, max 20)', default: 10 }
      },
      required: ['query']
    }
  },
  {
    name: 'court_get',
    description: 'Get the full text of a specific CT court decision by pdf_filename (from court_search) or case_name. Long decisions: page with offset/max_chars (response carries total_chars, truncated, next_offset).',
    inputSchema: {
      type: 'object',
      properties: {
        pdf_filename: { type: 'string', description: 'The PDF filename (e.g., "AP229.72.pdf", "332CR71.pdf") as returned by court_search' },
        case_name: { type: 'string', description: 'Alternative: the case_name from court_search (e.g., "AC47951 - N.E. Construction Co., LLC v. Anton") or just its docket prefix' },
        offset: { type: 'integer', description: 'Character offset to start from (default 0); use next_offset from a previous call to read the rest' },
        max_chars: { type: 'integer', description: 'Characters to return (default 15000, max 60000)' }
      }
    }
  },
  {
    name: 'court_stats',
    description: 'Get statistics on the CT court decisions database — total count, breakdown by court type.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'hearing_search',
    description: 'Search CT DSS fair hearing decisions (administrative appeals). ~4,400 decisions covering LTSS eligibility, medical services, other Medicaid eligibility, and SNAP. Use to find how DSS has ruled on specific issues like transfer penalties, asset exemptions, income calculations, or service denials.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query (e.g., "transfer penalty home", "annuity Medicaid", "SNAP eligibility")' },
        category: { type: 'string', description: 'Filter: LTSS Eligibility, Medical Services, Other Medicaid Eligibility, SNAP Eligibility' },
        year: { type: 'integer', description: 'Filter by year (2013-2024)' },
        limit: { type: 'integer', description: 'Max results (default 10, max 20)', default: 10 }
      },
      required: ['query']
    }
  },
  {
    name: 'hearing_get',
    description: 'Get the full text of a specific fair hearing decision by decision number. Use after searching. Long decisions: page with offset/max_chars (response carries total_chars, truncated, next_offset).',
    inputSchema: {
      type: 'object',
      properties: {
        decision_number: { type: 'string', description: 'The decision number (e.g., "LTEL_2024_214656")' },
        offset: { type: 'integer', description: 'Character offset to start from (default 0); use next_offset from a previous call to read the rest' },
        max_chars: { type: 'integer', description: 'Characters to return (default 15000, max 60000)' }
      },
      required: ['decision_number']
    }
  },
  {
    name: 'hearing_stats',
    description: 'Get statistics on the fair hearing decisions database — total count, breakdown by category and year.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'statute_search',
    description: 'Search Connecticut General Statutes (full text). Covers Title 17b (Social Services / Medicaid / public assistance, 638 sections), Title 19a (Public Health / nursing homes / hospitals / home care, 1,074 sections), and Title 45a (Probate Courts / decedents estates / conservatorship / trusts, 837 sections). Source: cga.ct.gov.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query (e.g., "Medicaid asset transfer penalty", "conservator authority gift", "nursing home discharge")' },
        title: { type: 'string', enum: ['17b', '19a', '45a'], description: 'Filter by CT statute Title' },
        limit: { type: 'integer', description: 'Max results (default 10, max 20)', default: 10 }
      },
      required: ['query']
    }
  },
  {
    name: 'statute_get',
    description: 'Get the full text of a CT General Statute section by section number (e.g., "17b-261", "45a-644", "19a-535").',
    inputSchema: {
      type: 'object',
      properties: {
        section_number: { type: 'string', description: 'The section number (e.g., "17b-261")' }
      },
      required: ['section_number']
    }
  },
  {
    name: 'statute_stats',
    description: 'Get statistics on the CT General Statutes database — total sections, breakdown by Title.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'cfr_search',
    description: 'Search 42 CFR (federal Medicaid regulations). Full text of relevant 42 CFR parts governing state Medicaid programs, eligibility, coverage, payment, fair hearings, and managed care.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query (e.g., "spousal impoverishment community spouse", "estate recovery", "fair hearing procedures")' },
        part: { type: 'integer', description: 'Filter by 42 CFR Part number (e.g., 435, 440, 447)' },
        limit: { type: 'integer', description: 'Max results (default 10, max 20)', default: 10 }
      },
      required: ['query']
    }
  },
  {
    name: 'cfr_get',
    description: 'Get the full text of a 42 CFR section by section number (e.g., "435.726", "447.10").',
    inputSchema: {
      type: 'object',
      properties: {
        section_number: { type: 'string', description: 'The section number (e.g., "435.726")' }
      },
      required: ['section_number']
    }
  },
  {
    name: 'cfr_stats',
    description: 'Get statistics on the 42 CFR database — total sections, breakdown by Part.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'regulation_search',
    description: 'Search Regulations of Connecticut State Agencies (RCSA) — administrative regulations promulgated by DSS, DPH, and other CT agencies.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query (e.g., "asset eligibility limits", "spousal allowance calculation")' },
        title: { type: 'string', description: 'Filter by RCSA Title number' },
        limit: { type: 'integer', description: 'Max results (default 10, max 20)', default: 10 }
      },
      required: ['query']
    }
  },
  {
    name: 'regulation_get',
    description: 'Get the full text of a CT regulation by section number.',
    inputSchema: {
      type: 'object',
      properties: {
        section_number: { type: 'string', description: 'The RCSA section number' }
      },
      required: ['section_number']
    }
  },
  {
    name: 'regulation_stats',
    description: 'Get statistics on the CT Regulations database — total sections, breakdown by Title.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'guidance_search',
    description: 'Search CMS sub-regulatory guidance documents — State Medicaid Director letters, State Health Official letters, Informational Bulletins, and similar policy guidance.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query (e.g., "MAGI methodology", "renewal redetermination", "premium assistance")' },
        doc_type: { type: 'string', description: 'Filter by document type (e.g., "SMD", "SHO", "CIB")' },
        year: { type: 'integer', description: 'Filter by year' },
        limit: { type: 'integer', description: 'Max results (default 10, max 20)', default: 10 }
      },
      required: ['query']
    }
  },
  {
    name: 'guidance_get',
    description: 'Get the full text of a CMS guidance document by filename.',
    inputSchema: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: 'The document filename' }
      },
      required: ['filename']
    }
  },
  {
    name: 'guidance_stats',
    description: 'Get statistics on the CMS guidance database — total documents, breakdown by document type and year.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'publaw_search',
    description: 'Search the full text of federal Public Laws by keyword. Currently holds the One Big Beautiful Bill Act (PL 119-21, signed July 4, 2025, 309 sections) and the Deficit Reduction Act of 2005 (PL 109-171, signed Feb 8, 2006, 165 sections — the source of the 5-year Medicaid look-back, annuity, and home-equity rules). Returns the act, title, section number, heading, and a snippet. Especially relevant for elder law / trusts & estates: Medicaid, Medicare, Social Security Act amendments, ABLE accounts, 529 plans, retirement accounts, and disability provisions.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query (e.g., "Medicaid asset transfer look-back", "annuity disclosure", "ABLE account contribution limit", "home equity long-term care")' },
        act: { type: 'string', enum: ['PL 119-21', 'PL 109-171'], description: 'Filter by act: "PL 119-21" (One Big Beautiful Bill Act) or "PL 109-171" (Deficit Reduction Act of 2005)' },
        limit: { type: 'integer', description: 'Max results (default 10, max 20)', default: 10 }
      },
      required: ['query']
    }
  },
  {
    name: 'publaw_get',
    description: 'Get the full text of a federal Public Law section by section number (e.g., "6012" for DRA 2005 annuity rules, "70115" for the OBBBA ABLE account limit). Optionally specify the act to disambiguate.',
    inputSchema: {
      type: 'object',
      properties: {
        section_number: { type: 'string', description: 'The section number (e.g., "6014", "70413")' },
        act: { type: 'string', enum: ['PL 119-21', 'PL 109-171'], description: 'The act (optional; required only if the same section number exists in both acts)' }
      },
      required: ['section_number']
    }
  },
  {
    name: 'publaw_stats',
    description: 'Get statistics on the federal Public Laws database — acts held, total sections, and breakdown by title within each act.',
    inputSchema: { type: 'object', properties: {} }
  }
];

/**
 * Handle tool calls
 */
function handleToolCall(name, args) {
  switch (name) {
    case 'upm_search': {
      const { query, chapter, limit = 10 } = args;
      const resultLimit = Math.min(limit, MAX_RESULTS);
      const ftsQuery = sanitizeFtsQuery(query);
      if (!ftsQuery) return { error: 'Query too short or no valid search terms' };

      const results = chapter
        ? stmts.searchFtsChapter.all(ftsQuery, chapter.toUpperCase(), resultLimit)
        : stmts.searchFts.all(ftsQuery, resultLimit);

      const searchTerms = query.split(/\s+/).filter(t => t.length > 2);
      const enriched = results.map(row => {
        const content = stmts.getSectionContent.get(row.section_number);
        const result = {
          section_number: row.section_number,
          chapter: row.chapter_number,
          title: row.title,
          word_count: row.word_count,
          snippet: extractSnippet(content?.content, searchTerms)
        };
        if (row.superseded_by) {
          result.superseded_by = row.superseded_by;
          result.currency_warning = `This section has been superseded by ${row.superseded_by}. Use the newer section for current policy.`;
        }
        if (row.effective_date) result.effective_date = row.effective_date;
        return result;
      });

      return { query, results_count: enriched.length, results: enriched };
    }

    case 'upm_get_section': {
      const result = stmts.getSection.get(args.section_number);
      if (!result) return { error: `Section ${args.section_number} not found` };
      const response = {
        section_number: result.section_number,
        chapter: result.chapter_number,
        chapter_title: result.chapter_title,
        title: result.title,
        word_count: result.word_count,
        content: truncate(result.content, MAX_CONTENT_LENGTH),
        source_url: result.source_url
      };
      if (result.superseded_by) {
        response.superseded_by = result.superseded_by;
        response.currency_warning = `WARNING: This section has been superseded by ${result.superseded_by}. The current policy is in section ${result.superseded_by}. This older version may still apply to cases involving events before the newer section's effective date.`;
      }
      if (result.effective_date) response.effective_date = result.effective_date;
      return response;
    }

    case 'upm_list_chapters': {
      return { chapters: stmts.listChapters.all().map(c => ({ chapter: c.chapter_number, title: c.title })) };
    }

    case 'upm_list_sections': {
      const sections = stmts.listSections.all(args.chapter.toUpperCase());
      return {
        chapter: args.chapter,
        section_count: sections.length,
        sections: sections.map(s => ({ section_number: s.section_number, title: s.title, word_count: s.word_count }))
      };
    }

    case 'upm_search_transmittals': {
      const { query, year, limit = 10 } = args;
      const resultLimit = Math.min(limit, MAX_RESULTS);
      let results;

      if (query) {
        const ftsQuery = sanitizeFtsQuery(query);
        if (!ftsQuery) return { error: 'Query too short' };
        results = year
          ? stmts.searchTransmittalsFtsYear.all(ftsQuery, year, resultLimit)
          : stmts.searchTransmittalsFts.all(ftsQuery, resultLimit);
      } else if (year) {
        results = stmts.transmittalsByYear.all(year, resultLimit);
      } else {
        results = stmts.recentTransmittals.all(resultLimit);
      }

      return {
        query: query || null, year: year || null, results_count: results.length,
        transmittals: results.map(t => ({ number: t.transmittal_number, year: t.year, title: t.title }))
      };
    }

    case 'upm_get_transmittal': {
      const result = stmts.getTransmittal.get(args.transmittal_number);
      if (!result) return { error: `Transmittal ${args.transmittal_number} not found` };
      return {
        transmittal_number: result.transmittal_number,
        year: result.year, sequence: result.sequence,
        title: result.title,
        content: truncate(result.content, MAX_CONTENT_LENGTH),
        source_url: result.source_url
      };
    }

    case 'upm_stats': {
      const sc = stmts.sectionCount.get();
      const tc = stmts.transmittalCount.get();
      const cb = stmts.chapterBreakdown.all();
      const ty = stmts.transmittalYearRange.get();
      return {
        total_sections: sc.count, total_transmittals: tc.count,
        chapters: cb.map(c => ({ chapter: c.chapter_number, title: c.title, sections: c.section_count, words: c.total_words })),
        transmittal_coverage: { oldest_year: ty.oldest, newest_year: ty.newest, years_covered: ty.year_count }
      };
    }

    case 'upm_analyze': {
      const { question, depth = 'standard' } = args;
      const limits = {
        quick: { searchLimit: 3, crossRefDepth: 0, checkTransmittals: false },
        standard: { searchLimit: 5, crossRefDepth: 1, checkTransmittals: true },
        thorough: { searchLimit: 10, crossRefDepth: 2, checkTransmittals: true }
      };
      const config = limits[depth] || limits.standard;
      const relevantChapters = mapQueryToChapters(question);
      const ftsQuery = sanitizeFtsQuery(question);
      if (!ftsQuery) return { error: 'Query too short' };

      // Search across relevant chapters
      const allResults = [];
      for (const chapter of relevantChapters.slice(0, 3)) {
        const results = stmts.searchFtsChapter.all(ftsQuery, chapter, config.searchLimit);
        allResults.push(...results);
      }
      // Sort: current sections first, then by relevance rank
      allResults.sort((a, b) => {
        const aSuperseded = a.superseded_by ? 1 : 0;
        const bSuperseded = b.superseded_by ? 1 : 0;
        if (aSuperseded !== bSuperseded) return aSuperseded - bSuperseded;
        return a.rank - b.rank;
      });
      const topResults = allResults.slice(0, config.searchLimit);

      // Get full content and extract cross-refs
      const crossRefs = new Set();
      const primarySections = topResults.map(row => {
        const full = stmts.getSection.get(row.section_number);
        const refs = extractSectionReferences(full?.content);
        refs.forEach(ref => { if (!topResults.find(r => r.section_number === ref)) crossRefs.add(ref); });
        return {
          section_number: row.section_number, chapter: row.chapter_number,
          title: row.title,
          content: truncate(full?.content, MAX_CONTENT_LENGTH / config.searchLimit),
          references: refs
        };
      });

      // Fetch cross-refs
      const crossRefSections = [];
      if (config.crossRefDepth > 0) {
        for (const ref of Array.from(crossRefs).slice(0, 5)) {
          const refSection = stmts.getSection.get(ref);
          if (refSection) {
            crossRefSections.push({
              section_number: refSection.section_number,
              chapter: refSection.chapter_number,
              title: refSection.title,
              snippet: truncate(refSection.content, 500)
            });
          }
        }
      }

      // Check transmittals
      const transmittalUpdates = [];
      if (config.checkTransmittals) {
        const currentYear = new Date().getFullYear();
        for (const sec of topResults.slice(0, 3)) {
          const transmittals = stmts.findTransmittalsForSection.all(
            `%${sec.section_number}%`, `%${sec.section_number.replace('_', '.')}%`,
            `%${sec.section_number}%`, currentYear - 2
          );
          if (transmittals.length > 0) {
            transmittalUpdates.push({
              section: sec.section_number,
              updates: transmittals.map(t => ({ number: t.transmittal_number, year: t.year, title: t.title }))
            });
          }
        }
      }

      return {
        question, depth, chapters_searched: relevantChapters,
        primary_sections: primarySections,
        cross_references: crossRefSections,
        recent_updates: transmittalUpdates,
        analysis_note: `Found ${primarySections.length} primary sections and ${crossRefSections.length} cross-referenced sections. ${transmittalUpdates.length > 0 ? 'Recent policy updates detected.' : 'No recent transmittal updates found.'}`
      };
    }

    case 'upm_get_related': {
      const section = stmts.getSection.get(args.section_number);
      if (!section) return { error: `Section ${args.section_number} not found` };

      const outgoing = extractSectionReferences(section.content);
      const referencedSections = outgoing.slice(0, 10)
        .map(ref => stmts.getSection.get(ref))
        .filter(r => r && r.section_number !== section.section_number)
        .map(r => ({ section_number: r.section_number, title: r.title }));

      const referencingThis = stmts.searchSectionsLike.all(
        `%${args.section_number}%`, `%${args.section_number.replace('_', '.')}%`
      ).filter(r => r.section_number !== section.section_number)
        .map(r => ({ section_number: r.section_number, title: r.title }));

      return {
        section: { section_number: section.section_number, title: section.title, chapter: section.chapter_number },
        references_to: referencedSections,
        referenced_by: referencingThis
      };
    }

    case 'upm_check_updates': {
      const { section_number, years_back = 3 } = args;
      const startYear = new Date().getFullYear() - years_back;
      const transmittals = stmts.findTransmittalsForSection.all(
        `%${section_number}%`, `%${section_number.replace('_', '.')}%`,
        `%${section_number}%`, startYear
      );
      const section = stmts.getSection.get(section_number);
      return {
        section: section ? { section_number: section.section_number, title: section.title } : { section_number, note: 'Not found' },
        search_period: `${startYear} to ${new Date().getFullYear()}`,
        updates_found: transmittals.length,
        transmittals: transmittals.map(t => ({ number: t.transmittal_number, year: t.year, title: t.title, excerpt: t.excerpt }))
      };
    }

    case 'upm_get_limits': {
      const { category = 'all' } = args;
      // Figures re-verified 2026-07-22 against CT Public Acts + firm-verified
      // current values. Anything not re-verified on that date is stated as a
      // verify-live pointer rather than a number — a stale figure quoted as
      // current is worse than no figure.
      const limits = {
        assets: {
          individual_limit: 1600,
          individual_limit_note: 'MAABD/LTSS countable-asset limit (longstanding CT figure)',
          couple_limit_note: 'Not re-verified 2026-07-22 — confirm current couple figure in UPM 4005 / live DSS sources before quoting',
          home_equity_limit: 1130000,
          home_equity_note: 'Eff. 1/1/2026; adjusted annually. Federal OBBBA (PL 119-21) sec. 71108 enacted a $1M LTC home-equity cap — reconcile effective dates before advising',
          vehicle_exemption: 'One vehicle exempt regardless of value',
          burial_contract_limit: 10000,
          burial_contract_note: 'Irrevocable funeral contract, per PA 19-57',
          life_insurance_face_value_limit: 1500
        },
        income: {
          nursing_home_income_limit: 'No income limit for nursing home (income applied to cost of care)',
          personal_needs_allowance: 75,
          personal_needs_allowance_note: 'SNF PNA $75 per PA 21-3 (NOT the pre-2021 $60)',
          community_medicaid_note: 'HUSKY C community income limits change annually — not re-verified 2026-07-22; check portal.ct.gov/dss or sharinglaw.net'
        },
        penalty: {
          lookback_period_months: 60,
          penalty_divisor: 15526,
          penalty_divisor_note: 'Average monthly cost of care in CT, eff. 7/1/2025; DSS updates annually each July — verify after 7/1/2026',
        },
        spousal: {
          csra_minimum: 50000,
          csra_minimum_note: 'CONNECTICUT statutory minimum per PA 22-118 (eff. 7/1/2022) — deliberately higher than the federal floor; do not quote the federal minimum for CT',
          csra_maximum: 162660,
          csra_maximum_note: 'Eff. 1/1/2026 (federal maximum, adjusted annually each January)',
          mmmna_maximum: 4066.50,
          mmmna_maximum_note: 'Maximum MMMNA without a fair hearing, eff. 1/1/2026',
          mmmna_base_note: 'Base MMMNA and excess-shelter standard adjust each July 1 — not re-verified 2026-07-22; check current figures before use'
        }
      };
      const result = category === 'all' ? limits : { [category]: limits[category] || { error: 'Unknown category' } };
      result.source = 'Convenience reference only — ALWAYS verify against the UPM sections, current CT Public Acts, and live DSS sources (portal.ct.gov/dss, sharinglaw.net) before quoting in a client matter.';
      result.last_updated = '2026-07-22';
      return result;
    }

    case 'smm_search': {
      const { query, chapter, limit = 10 } = args;
      const resultLimit = Math.min(limit, MAX_RESULTS);
      const ftsQuery = sanitizeFtsQuery(query);
      if (!ftsQuery) return { error: 'Query too short' };

      let results;
      if (chapter) {
        results = stmts.searchSmmFtsChapter.all(ftsQuery, chapter, resultLimit);
      } else {
        results = stmts.searchSmmFts.all(ftsQuery, resultLimit);
      }

      const searchTerms = query.split(/\s+/).filter(t => t.length > 2);
      const enriched = results.map(row => {
        const content = stmts.getSmmSectionContent.get(row.section_number);
        return {
          section_number: row.section_number,
          section_range_end: row.section_range_end,
          title: row.title,
          chapter: row.chapter_number,
          chapter_title: row.chapter_title,
          word_count: row.word_count,
          snippet: extractSnippet(content?.content, searchTerms)
        };
      });

      return { query, results_count: enriched.length, results: enriched };
    }

    case 'smm_get_section': {
      const result = stmts.getSmmSection.get(args.section_number);
      if (!result) return { error: `Section ${args.section_number} not found` };
      return {
        section_number: result.section_number,
        section_range_end: result.section_range_end,
        title: result.title,
        chapter: result.chapter_number,
        chapter_title: result.chapter_title,
        word_count: result.word_count,
        content: truncate(result.content, MAX_CONTENT_LENGTH)
      };
    }

    case 'smm_list_chapters': {
      const chapters = stmts.listSmmChapters.all();
      return {
        chapters: chapters.map(c => ({
          chapter: c.chapter_number,
          title: c.title,
          sections: c.section_count,
          words: c.total_words
        }))
      };
    }

    case 'smm_list_sections': {
      const sections = stmts.listSmmSections.all(args.chapter);
      return {
        chapter: args.chapter,
        sections: sections.map(s => ({
          section_number: s.section_number,
          range_end: s.section_range_end,
          title: s.title,
          word_count: s.word_count
        }))
      };
    }

    case 'smm_stats': {
      const sc = stmts.smmSectionCount.get();
      const cc = stmts.smmChapterCount.get();
      const chapters = stmts.listSmmChapters.all();
      return {
        total_chapters: cc.count,
        total_sections: sc.count,
        chapters: chapters.map(c => ({
          chapter: c.chapter_number,
          title: c.title,
          sections: c.section_count,
          words: c.total_words
        }))
      };
    }

    case 'court_search': {
      const { query, court, year, limit = 10 } = args;
      const resultLimit = Math.min(limit, MAX_RESULTS);
      const ftsQuery = sanitizeFtsQuery(query);
      if (!ftsQuery) return { error: 'Query too short' };

      let results;
      if (court && year) {
        results = stmts.searchCourtsFtsCourtYear.all(ftsQuery, court, year, resultLimit);
      } else if (court) {
        results = stmts.searchCourtsFtsCourt.all(ftsQuery, court, resultLimit);
      } else if (year) {
        results = stmts.searchCourtsFtsYear.all(ftsQuery, year, resultLimit);
      } else {
        results = stmts.searchCourtsFts.all(ftsQuery, resultLimit);
      }

      const searchTerms = query.split(/\s+/).filter(t => t.length > 2);
      const enriched = results.map(row => {
        const content = stmts.getCourtContent.get(row.pdf_filename);
        return {
          case_name: row.case_name,
          court: row.court,
          year: row.year,
          volume: row.volume,
          page: row.page,
          pdf_filename: row.pdf_filename,
          word_count: row.word_count,
          page_count: row.page_count,
          matched_keywords: row.matched_keywords,
          snippet: extractSnippet(content?.content, searchTerms)
        };
      });

      return { query, results_count: enriched.length, results: enriched };
    }

    case 'court_get': {
      // Accept the pdf_filename (canonical) or a case_name as returned by court_search
      // (exact, then prefix match on the docket, e.g. "AC47951").
      let result = args.pdf_filename ? stmts.getCourt.get(args.pdf_filename) : null;
      if (!result && args.case_name) {
        result = stmts.getCourtByCaseName.get(args.case_name) || stmts.getCourtByCaseNamePrefix.get(args.case_name.split(' ')[0] + '%');
      }
      if (!result) return { error: `Decision ${args.pdf_filename || args.case_name || '(no pdf_filename or case_name given)'} not found` };
      return {
        case_name: result.case_name,
        court: result.court,
        year: result.year,
        volume: result.volume,
        page: result.page,
        pdf_filename: result.pdf_filename,
        word_count: result.word_count,
        page_count: result.page_count,
        matched_keywords: result.matched_keywords,
        ...windowContent(result.content, args),
        source_url: result.source_url
      };
    }

    case 'court_stats': {
      const cc = stmts.courtCount.get();
      const courts = stmts.courtBreakdown.all();
      return {
        total_decisions: cc.count,
        courts: courts.map(r => ({
          court: r.court,
          decisions: r.count,
          words: r.total_words,
          year_range: `${r.min_year}-${r.max_year}`
        }))
      };
    }

    case 'hearing_search': {
      const { query, category, year, limit = 10 } = args;
      const resultLimit = Math.min(limit, MAX_RESULTS);
      const ftsQuery = sanitizeFtsQuery(query);
      if (!ftsQuery) return { error: 'Query too short' };

      let results;
      if (category && year) {
        results = stmts.searchHearingsFtsCatYear.all(ftsQuery, `%${category}%`, year, resultLimit);
      } else if (category) {
        results = stmts.searchHearingsFtsCat.all(ftsQuery, `%${category}%`, resultLimit);
      } else if (year) {
        results = stmts.searchHearingsFtsYear.all(ftsQuery, year, resultLimit);
      } else {
        results = stmts.searchHearingsFts.all(ftsQuery, resultLimit);
      }

      const searchTerms = query.split(/\s+/).filter(t => t.length > 2);
      const enriched = results.map(row => {
        const content = stmts.getHearingContent.get(row.decision_number);
        return {
          decision_number: row.decision_number,
          category: row.category,
          year: row.year,
          case_number: row.case_number,
          title: row.title,
          word_count: row.word_count,
          page_count: row.page_count,
          snippet: extractSnippet(content?.content, searchTerms)
        };
      });

      return { query, results_count: enriched.length, results: enriched };
    }

    case 'hearing_get': {
      const result = stmts.getHearing.get(args.decision_number);
      if (!result) return { error: `Decision ${args.decision_number} not found` };
      return {
        decision_number: result.decision_number,
        category: result.category,
        year: result.year,
        case_number: result.case_number,
        title: result.title,
        word_count: result.word_count,
        page_count: result.page_count,
        ...windowContent(result.content, args),
        source_url: result.source_url
      };
    }

    case 'hearing_stats': {
      const hc = stmts.hearingCount.get();
      const cats = stmts.hearingCategoryBreakdown.all();
      return {
        total_decisions: hc.count,
        categories: cats.map(r => ({
          category: r.category,
          decisions: r.count,
          words: r.total_words,
          year_range: `${r.min_year}-${r.max_year}`
        }))
      };
    }

    case 'statute_search': {
      const { query, title, limit = 10 } = args;
      const resultLimit = Math.min(limit, MAX_RESULTS);
      const ftsQuery = sanitizeFtsQuery(query);
      if (!ftsQuery) return { error: 'Query too short' };

      const results = title
        ? stmts.searchStatutesFtsTitle.all(ftsQuery, title, resultLimit)
        : stmts.searchStatutesFts.all(ftsQuery, resultLimit);

      const searchTerms = query.split(/\s+/).filter(t => t.length > 2);
      const enriched = results.map(row => {
        const content = stmts.getStatuteContent.get(row.section_number);
        return {
          section_number: row.section_number,
          section_title: row.section_title,
          title_num: row.title_num,
          chapter_name: row.chapter_name,
          chapter_title: row.chapter_title,
          word_count: row.word_count,
          source_url: row.source_url,
          snippet: extractSnippet(content?.content, searchTerms)
        };
      });
      return { query, results_count: enriched.length, results: enriched };
    }

    case 'statute_get': {
      const result = stmts.getStatute.get(args.section_number);
      if (!result) return { error: `Statute ${args.section_number} not found` };
      return {
        section_number: result.section_number,
        section_title: result.section_title,
        title_num: result.title_num,
        chapter_name: result.chapter_name,
        chapter_title: result.chapter_title,
        word_count: result.word_count,
        content: truncate(result.content, MAX_CONTENT_LENGTH),
        source_citations: result.source_citations,
        source_url: result.source_url
      };
    }

    case 'statute_stats': {
      const sc = stmts.statuteCount.get();
      const titles = stmts.statuteTitleBreakdown.all();
      return {
        total_sections: sc.count,
        titles: titles.map(r => ({
          title: r.title_num,
          sections: r.count,
          words: r.total_words
        }))
      };
    }

    case 'cfr_search': {
      const { query, part, limit = 10 } = args;
      const resultLimit = Math.min(limit, MAX_RESULTS);
      const ftsQuery = sanitizeFtsQuery(query);
      if (!ftsQuery) return { error: 'Query too short' };

      const results = (typeof part === 'number')
        ? stmts.searchCfrFtsPart.all(ftsQuery, part, resultLimit)
        : stmts.searchCfrFts.all(ftsQuery, resultLimit);

      const searchTerms = query.split(/\s+/).filter(t => t.length > 2);
      const enriched = results.map(row => {
        const content = stmts.getCfrContent.get(row.section_number);
        return {
          section_number: row.section_number,
          section_title: row.section_title,
          part_num: row.part_num,
          part_title: row.part_title,
          subpart: row.subpart,
          subpart_title: row.subpart_title,
          word_count: row.word_count,
          snippet: extractSnippet(content?.content, searchTerms)
        };
      });
      return { query, results_count: enriched.length, results: enriched };
    }

    case 'cfr_get': {
      // CFR section numbers are stored as "§ 435.726"; accept both forms.
      const raw = args.section_number || '';
      const stripped = raw.replace(/^\s*§\s*/, '').trim();
      let result = stmts.getCfr.get(raw);
      if (!result) result = stmts.getCfr.get(`§ ${stripped}`);
      if (!result) result = stmts.getCfr.get(stripped);
      if (!result) return { error: `CFR section ${args.section_number} not found` };
      return {
        section_number: result.section_number,
        section_title: result.section_title,
        part_num: result.part_num,
        part_title: result.part_title,
        subpart: result.subpart,
        subpart_title: result.subpart_title,
        word_count: result.word_count,
        content: truncate(result.content, MAX_CONTENT_LENGTH)
      };
    }

    case 'cfr_stats': {
      const cc = stmts.cfrCount.get();
      const parts = stmts.cfrPartBreakdown.all();
      return {
        total_sections: cc.count,
        parts: parts.map(r => ({
          part: r.part_num,
          part_title: r.part_title,
          sections: r.count,
          words: r.total_words
        }))
      };
    }

    case 'regulation_search': {
      const { query, title, limit = 10 } = args;
      const resultLimit = Math.min(limit, MAX_RESULTS);
      const ftsQuery = sanitizeFtsQuery(query);
      if (!ftsQuery) return { error: 'Query too short' };

      const results = title
        ? stmts.searchRegsFtsTitle.all(ftsQuery, title, resultLimit)
        : stmts.searchRegsFts.all(ftsQuery, resultLimit);

      const searchTerms = query.split(/\s+/).filter(t => t.length > 2);
      const enriched = results.map(row => {
        const content = stmts.getRegContent.get(row.section_number);
        return {
          section_number: row.section_number,
          section_title: row.section_title,
          title_num: row.title_num,
          subtitle: row.subtitle,
          subtitle_text: row.subtitle_text,
          word_count: row.word_count,
          source_url: row.source_url,
          snippet: extractSnippet(content?.content, searchTerms)
        };
      });
      return { query, results_count: enriched.length, results: enriched };
    }

    case 'regulation_get': {
      const result = stmts.getReg.get(args.section_number);
      if (!result) return { error: `Regulation ${args.section_number} not found` };
      return {
        section_number: result.section_number,
        section_title: result.section_title,
        title_num: result.title_num,
        subtitle: result.subtitle,
        subtitle_text: result.subtitle_text,
        word_count: result.word_count,
        content: truncate(result.content, MAX_CONTENT_LENGTH),
        source_url: result.source_url
      };
    }

    case 'regulation_stats': {
      const rc = stmts.regCount.get();
      const titles = stmts.regTitleBreakdown.all();
      return {
        total_sections: rc.count,
        titles: titles.map(r => ({
          title: r.title_num,
          sections: r.count,
          words: r.total_words
        }))
      };
    }

    case 'guidance_search': {
      const { query, doc_type, year, limit = 10 } = args;
      const resultLimit = Math.min(limit, MAX_RESULTS);
      const ftsQuery = sanitizeFtsQuery(query);
      if (!ftsQuery) return { error: 'Query too short' };

      let results;
      if (doc_type) {
        results = stmts.searchGuidanceFtsType.all(ftsQuery, doc_type, resultLimit);
      } else if (year) {
        results = stmts.searchGuidanceFtsYear.all(ftsQuery, year, resultLimit);
      } else {
        results = stmts.searchGuidanceFts.all(ftsQuery, resultLimit);
      }

      const searchTerms = query.split(/\s+/).filter(t => t.length > 2);
      const enriched = results.map(row => {
        const content = stmts.getGuidanceContent.get(row.filename);
        return {
          filename: row.filename,
          title: row.title,
          doc_type: row.doc_type,
          doc_date: row.doc_date,
          year: row.year,
          word_count: row.word_count,
          page_count: row.page_count,
          source_url: row.source_url,
          snippet: extractSnippet(content?.content, searchTerms)
        };
      });
      return { query, results_count: enriched.length, results: enriched };
    }

    case 'guidance_get': {
      const result = stmts.getGuidance.get(args.filename);
      if (!result) return { error: `Guidance document ${args.filename} not found` };
      return {
        filename: result.filename,
        title: result.title,
        doc_type: result.doc_type,
        doc_date: result.doc_date,
        year: result.year,
        word_count: result.word_count,
        page_count: result.page_count,
        content: truncate(result.content, MAX_CONTENT_LENGTH),
        source_url: result.source_url
      };
    }

    case 'guidance_stats': {
      const gc = stmts.guidanceCount.get();
      const types = stmts.guidanceTypeBreakdown.all();
      return {
        total_documents: gc.count,
        types: types.map(r => ({
          doc_type: r.doc_type,
          documents: r.count,
          words: r.total_words,
          year_range: `${r.min_year}-${r.max_year}`
        }))
      };
    }

    case 'publaw_search': {
      const { query, act, limit = 10 } = args;
      const resultLimit = Math.min(limit, MAX_RESULTS);
      const ftsQuery = sanitizeFtsQuery(query);
      if (!ftsQuery) return { error: 'Query too short' };

      const results = act
        ? stmts.searchPublawsFtsAct.all(ftsQuery, act, resultLimit)
        : stmts.searchPublawsFts.all(ftsQuery, resultLimit);

      const searchTerms = query.split(/\s+/).filter(t => t.length > 2);
      const enriched = results.map(row => {
        const content = stmts.getPublawContent.get(row.id);
        return {
          act_id: row.act_id,
          act_short_title: row.act_short_title,
          section_number: row.section_number,
          section_heading: row.section_heading,
          title_num: row.title_num,
          title_name: row.title_name,
          subtitle: row.subtitle,
          stat_page: row.stat_page,
          word_count: row.word_count,
          source_url: row.source_url,
          snippet: extractSnippet(content?.content, searchTerms)
        };
      });
      return { query, results_count: enriched.length, results: enriched };
    }

    case 'publaw_get': {
      const { section_number, act } = args;
      const result = act
        ? stmts.getPublaw.get(act, section_number)
        : stmts.getPublawAnyAct.get(section_number);
      if (!result) return { error: `Public Law section ${section_number}${act ? ' in ' + act : ''} not found` };
      return {
        act_id: result.act_id,
        act_short_title: result.act_short_title,
        section_number: result.section_number,
        section_heading: result.section_heading,
        title_num: result.title_num,
        title_name: result.title_name,
        subtitle: result.subtitle,
        stat_page: result.stat_page,
        word_count: result.word_count,
        content: truncate(result.content, MAX_CONTENT_LENGTH),
        source_url: result.source_url
      };
    }

    case 'publaw_stats': {
      const pc = stmts.publawCount.get();
      const acts = stmts.publawActBreakdown.all();
      const titles = stmts.publawTitleBreakdown.all();
      return {
        total_sections: pc.count,
        acts: acts.map(a => ({
          act_id: a.act_id,
          short_title: a.act_short_title,
          sections: a.count,
          words: a.total_words,
          titles: titles
            .filter(t => t.act_id === a.act_id)
            .map(t => ({ title: t.title_num, name: t.title_name, sections: t.count, words: t.total_words }))
        }))
      };
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

/**
 * Create and configure a fresh MCP server instance
 */
function createMcpServer() {
  const server = new Server(
    { name: 'ct-upm', version: '2.3.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      const result = handleToolCall(name, args || {});
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }] };
    }
  });

  return server;
}

/**
 * HTTP request handler
 *
 * Uses stateless mode: each request creates a fresh server+transport.
 * This is required for multi-machine deployments (Fly.io, etc.) where
 * requests may hit different instances. Since the database is read-only,
 * there's no session state to preserve.
 */
async function handleRequest(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id');
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // API key check
  if (API_KEY) {
    const authHeader = req.headers['authorization'];
    if (!authHeader || authHeader !== `Bearer ${API_KEY}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  // Health check
  if (url.pathname === '/health' && req.method === 'GET') {
    const sc = stmts.sectionCount.get();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', sections: sc.count, version: '2.3.0' }));
    return;
  }

  // MCP endpoint — stateless: every POST gets a fresh server+transport
  if (url.pathname === '/mcp') {
    if (req.method === 'POST') {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // Stateless — no session tracking
      });

      const server = createMcpServer();
      await server.connect(transport);
      await transport.handleRequest(req, res);
      // Transport is discarded after response — no state to leak
      return;
    }

    if (req.method === 'GET') {
      // SSE not supported in stateless mode
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'SSE not supported. Use POST.' }));
      return;
    }

    if (req.method === 'DELETE') {
      // No sessions to delete in stateless mode
      res.writeHead(200);
      res.end();
      return;
    }

    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Bad request' }));
    return;
  }

  // Landing page
  if (url.pathname === '/' && req.method === 'GET') {
    const hc = stmts.hearingCount.get();
    const sc = stmts.sectionCount.get();
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!DOCTYPE html>
<html><head><title>CT Medicaid Policy &amp; Hearing Decisions — MCP Server</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
body{font-family:system-ui,-apple-system,sans-serif;max-width:780px;margin:40px auto;padding:0 20px;line-height:1.7;color:#333}
h1{color:#1a365d;margin-bottom:4px}
h2{color:#1a365d;margin-top:32px;border-bottom:2px solid #e2e8f0;padding-bottom:6px}
h3{color:#2d3748;margin-top:24px}
code{background:#f0f0f0;padding:2px 6px;border-radius:3px;font-size:0.9em}
pre{background:#1a202c;color:#e2e8f0;padding:16px;border-radius:8px;overflow-x:auto;font-size:0.85em}
.stat-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin:16px 0}
.stat{background:#f7fafc;padding:16px;border-radius:8px;text-align:center;border:1px solid #e2e8f0}
.stat .number{font-size:1.8em;font-weight:700;color:#2563eb;display:block}
.stat .label{font-size:0.85em;color:#718096}
.tools{display:grid;gap:8px;margin:16px 0}
.tool{background:#f8f9fa;padding:12px;border-radius:6px;border-left:3px solid #2563eb}
.tool.hearing{border-left-color:#d69e2e}
.setup-option{background:#f7fafc;padding:20px;border-radius:8px;margin:12px 0;border:1px solid #e2e8f0}
.setup-option h3{margin-top:0}
.examples{background:#fffbeb;padding:16px;border-radius:8px;border:1px solid #f6e05e;margin:16px 0}
.examples li{margin:6px 0}
a{color:#2563eb}
.footer{margin-top:40px;padding-top:16px;border-top:1px solid #e2e8f0;color:#718096;font-size:0.85em}
</style></head><body>

<h1>Connecticut Medicaid Policy &amp; Fair Hearing Decisions</h1>
<p style="color:#718096;margin-top:0">MCP Server for Claude AI — full-text search across CT DSS policy and administrative hearing decisions</p>

<div class="stat-grid">
  <div class="stat"><span class="number">${sc.count.toLocaleString()}</span><span class="label">UPM Policy Sections</span></div>
  <div class="stat"><span class="number">${hc.count.toLocaleString()}</span><span class="label">Fair Hearing Decisions</span></div>
  <div class="stat"><span class="number">10.8M+</span><span class="label">Words of Policy Text</span></div>
  <div class="stat"><span class="number">2013&ndash;2024</span><span class="label">Decision Year Range</span></div>
</div>

<h2>What's in this database?</h2>
<p><strong>Uniform Policy Manual (UPM)</strong> &mdash; The complete CT DSS policy manual governing Medicaid eligibility, asset treatment, income rules, transfer penalties, spousal protections, and other public assistance programs. All 10 chapters (UPM0&ndash;UPM9), plus 266 policy transmittals.</p>
<p><strong>Fair Hearing Decisions</strong> &mdash; ${hc.count.toLocaleString()} administrative hearing decisions from the CT DSS Office of Legal Counsel (OLCRAH), covering:</p>
<ul>
  <li><strong>LTSS Eligibility</strong> &mdash; Long-term services &amp; supports (nursing home, home care, Medicaid eligibility)</li>
  <li><strong>Medical Services</strong> &mdash; Coverage denials, service authorizations, medical necessity</li>
  <li><strong>Other Medicaid Eligibility</strong> &mdash; Asset transfers, income calculations, eligibility determinations</li>
  <li><strong>SNAP Eligibility</strong> &mdash; Food assistance program decisions</li>
</ul>

<h2>How to Connect</h2>

<div class="setup-option">
<h3>Claude.ai (Web Browser)</h3>
<ol>
  <li>Go to <a href="https://claude.ai">claude.ai</a> (requires Claude Pro, Team, or Enterprise)</li>
  <li>Click your profile icon &rarr; <strong>Settings</strong> &rarr; <strong>Integrations</strong></li>
  <li>Click <strong>Add custom integration</strong></li>
  <li>Enter the URL: <code>https://ct-upm-mcp.fly.dev/mcp</code></li>
  <li>Name it "CT Medicaid Policy" or similar</li>
</ol>
<p>That's it. Claude will automatically use the UPM and hearing search tools when you ask relevant questions.</p>
</div>

<div class="setup-option">
<h3>Claude Desktop (Mac or Windows)</h3>
<p>Edit your config file:</p>
<ul>
  <li><strong>Mac:</strong> <code>~/Library/Application Support/Claude/claude_desktop_config.json</code></li>
  <li><strong>Windows:</strong> <code>%APPDATA%\\Claude\\claude_desktop_config.json</code></li>
</ul>
<p>Add this to the file (create it if it doesn't exist):</p>
<pre>{
  "mcpServers": {
    "ct-upm": {
      "url": "https://ct-upm-mcp.fly.dev/mcp"
    }
  }
}</pre>
<p>Restart Claude Desktop after saving.</p>
</div>

<div class="setup-option">
<h3>Claude Code (CLI)</h3>
<pre>claude mcp add --transport http ct-upm https://ct-upm-mcp.fly.dev/mcp</pre>
</div>

<div class="examples">
<h3>Example Questions</h3>
<ul>
  <li>"What is the Medicaid transfer penalty lookback period in Connecticut?"</li>
  <li>"How are annuities treated for Medicaid eligibility under the UPM?"</li>
  <li>"Search hearing decisions about home exemptions for siblings"</li>
  <li>"What are the current CSRA limits for a community spouse?"</li>
  <li>"Find LTSS hearing decisions from 2023 about transfer penalties"</li>
  <li>"What does UPM section 4030 say about exempt assets?"</li>
</ul>
</div>

<h2>Available Tools</h2>
<h3>UPM Policy Tools</h3>
<div class="tools">
${TOOLS.filter(t => t.name.startsWith('upm_')).map(t => `<div class="tool"><strong>${t.name}</strong> &mdash; ${t.description.split('.')[0]}</div>`).join('\n')}
</div>

<h3>Fair Hearing Decision Tools</h3>
<div class="tools">
${TOOLS.filter(t => t.name.startsWith('hearing_')).map(t => `<div class="tool hearing"><strong>${t.name}</strong> &mdash; ${t.description.split('.')[0]}</div>`).join('\n')}
</div>

<h2>Data Sources</h2>
<ul>
  <li><a href="https://portal.ct.gov/dss/lists/uniform-policy-manual">CT DSS Uniform Policy Manual</a> &mdash; all 1,632 sections + 266 transmittals</li>
  <li><a href="https://portal.ct.gov/DSS/Lists/Administrative-Hearings-Decisions">CT DSS Administrative Hearing Decisions</a> &mdash; all ${hc.count.toLocaleString()} decisions (2013&ndash;2024)</li>
</ul>
<p>All content is public domain (Connecticut state government publications).</p>

<div class="footer">
  <p>Built by <a href="https://keogh.law">Stephen B. Keogh</a>, Keogh.Law &mdash; Elder Law, Norwalk, CT</p>
  <p><a href="/health">Health check</a> &middot; <a href="https://github.com/sbkeogh/ct-upm-mcp">Source code</a></p>
</div>
</body></html>`);
    return;
  }

  res.writeHead(404);
  res.end('Not found');
}

// Start HTTP server
const httpServer = createHttpServer(handleRequest);
httpServer.listen(PORT, () => {
  console.log(`CT UPM MCP Server running on http://localhost:${PORT}`);
  console.log(`MCP endpoint: http://localhost:${PORT}/mcp`);
  console.log(`Health check: http://localhost:${PORT}/mcp`);
  console.log(`Sections: ${stmts.sectionCount.get().count}`);
  if (API_KEY) console.log('API key authentication enabled');
});
