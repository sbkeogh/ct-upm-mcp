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
  searchFts: db.prepare(`
    SELECT s.id, s.section_number, s.title, s.word_count, c.chapter_number,
           rank
    FROM sections_fts fts
    JOIN sections s ON fts.rowid = s.id
    JOIN chapters c ON s.chapter_id = c.id
    WHERE sections_fts MATCH ?
    ORDER BY rank
    LIMIT ?
  `),
  searchFtsChapter: db.prepare(`
    SELECT s.id, s.section_number, s.title, s.word_count, c.chapter_number,
           rank
    FROM sections_fts fts
    JOIN sections s ON fts.rowid = s.id
    JOIN chapters c ON s.chapter_id = c.id
    WHERE sections_fts MATCH ? AND c.chapter_number = ?
    ORDER BY rank
    LIMIT ?
  `),
  getSection: db.prepare(`
    SELECT s.*, c.chapter_number, c.title as chapter_title
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
    description: 'Search the Connecticut DSS Uniform Policy Manual for policy sections matching keywords. Returns section numbers, titles, and content snippets. Use this to find policies about Medicaid eligibility, assets, income, transfer penalties, and other welfare program rules.',
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
        return {
          section_number: row.section_number,
          chapter: row.chapter_number,
          title: row.title,
          word_count: row.word_count,
          snippet: extractSnippet(content?.content, searchTerms)
        };
      });

      return { query, results_count: enriched.length, results: enriched };
    }

    case 'upm_get_section': {
      const result = stmts.getSection.get(args.section_number);
      if (!result) return { error: `Section ${args.section_number} not found` };
      return {
        section_number: result.section_number,
        chapter: result.chapter_number,
        chapter_title: result.chapter_title,
        title: result.title,
        word_count: result.word_count,
        content: truncate(result.content, MAX_CONTENT_LENGTH),
        source_url: result.source_url
      };
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
      allResults.sort((a, b) => a.rank - b.rank); // FTS5 rank: lower is better
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
      const limits = {
        assets: {
          individual_limit: 1600, couple_limit: 3200, home_equity_limit: 1071000,
          vehicle_exemption: 'One vehicle exempt regardless of value',
          burial_fund_limit: 1500, life_insurance_face_value_limit: 1500,
          note: 'Asset limits as of 2024. Home equity limit adjusted annually.'
        },
        income: {
          nursing_home_income_limit: 'No income limit for nursing home (income applied to cost of care)',
          community_medicaid_individual: 1732, community_medicaid_couple: 2351,
          personal_needs_allowance: 60,
          note: 'Income figures as of 2024. Subject to annual adjustments.'
        },
        penalty: {
          lookback_period_months: 60, penalty_divisor: 13584,
          penalty_divisor_note: 'Average monthly cost of nursing home care in CT (2024)',
          note: 'Penalty divisor updated annually by DSS.'
        },
        spousal: {
          csra_minimum: 29724, csra_maximum: 148620,
          mmmna_base: 2555, mmmna_maximum: 3853.50, excess_shelter_standard: 766.50,
          note: 'CSRA and MMMNA. 2024 values.'
        }
      };
      const result = category === 'all' ? limits : { [category]: limits[category] || { error: 'Unknown category' } };
      result.source = 'Values from UPM sections 4000-4999 (assets), 5000-5999 (income). Verify in applicable sections.';
      result.last_updated = '2024';
      return result;
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// Track active transports for session management
const transports = {};

/**
 * Create and configure the MCP server for a session
 */
function createMcpServer() {
  const server = new Server(
    { name: 'ct-upm', version: '2.0.0' },
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
    res.end(JSON.stringify({ status: 'ok', sections: sc.count, version: '2.0.0' }));
    return;
  }

  // MCP endpoint
  if (url.pathname === '/mcp') {
    // Check for existing session
    const sessionId = req.headers['mcp-session-id'];

    if (req.method === 'GET' || req.method === 'POST') {
      // For GET (SSE) or POST with existing session
      if (sessionId && transports[sessionId]) {
        const transport = transports[sessionId];
        await transport.handleRequest(req, res);
        return;
      }

      // New session (POST without session ID, or initial request)
      if (req.method === 'POST') {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            transports[sid] = transport;
          }
        });

        // Clean up on close
        transport.onclose = () => {
          const sid = Object.keys(transports).find(k => transports[k] === transport);
          if (sid) delete transports[sid];
        };

        const server = createMcpServer();
        await server.connect(transport);
        await transport.handleRequest(req, res);
        return;
      }
    }

    if (req.method === 'DELETE' && sessionId && transports[sessionId]) {
      const transport = transports[sessionId];
      await transport.handleRequest(req, res);
      delete transports[sessionId];
      return;
    }

    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Bad request' }));
    return;
  }

  // Landing page
  if (url.pathname === '/' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!DOCTYPE html>
<html><head><title>CT UPM MCP Server</title><style>
body{font-family:system-ui;max-width:720px;margin:40px auto;padding:0 20px;line-height:1.6;color:#333}
h1{color:#1a365d}code{background:#f0f0f0;padding:2px 6px;border-radius:3px;font-size:0.9em}
pre{background:#f0f0f0;padding:16px;border-radius:8px;overflow-x:auto}
.tools{display:grid;gap:8px;margin:16px 0}
.tool{background:#f8f9fa;padding:12px;border-radius:6px;border-left:3px solid #2563eb}
</style></head><body>
<h1>Connecticut Uniform Policy Manual</h1>
<p>MCP server providing full-text search and analysis of the <a href="https://portal.ct.gov/dss/lists/uniform-policy-manual">CT DSS Uniform Policy Manual</a> — 1,632 policy sections covering Medicaid eligibility, assets, income, transfer penalties, and more.</p>

<h2>Connect with Claude</h2>
<p>Add this server as a remote MCP integration in Claude Desktop or Claude Code:</p>
<pre>{
  "mcpServers": {
    "ct-upm": {
      "url": "${req.headers.host ? `http://${req.headers.host}` : 'https://your-host.example.com'}/mcp"
    }
  }
}</pre>

<h2>Available Tools</h2>
<div class="tools">
${TOOLS.map(t => `<div class="tool"><strong>${t.name}</strong> — ${t.description.split('.')[0]}</div>`).join('\n')}
</div>

<h2>Source</h2>
<p>Data scraped from <a href="https://portal.ct.gov/dss/lists/uniform-policy-manual">portal.ct.gov/dss</a>. All content is public domain (CT state government).</p>
<p><a href="/health">Health check</a></p>
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
