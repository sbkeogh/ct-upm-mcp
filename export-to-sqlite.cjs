#!/usr/bin/env node
/**
 * Export CT UPM data from MariaDB to SQLite for portable deployment.
 *
 * Usage: node export-to-sqlite.js [output-path]
 * Default output: ./data/ct-upm.db
 */

const mariadb = require('mariadb');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const OUTPUT_PATH = process.argv[2] || path.join(__dirname, 'data', 'ct-upm.db');

async function exportToSqlite() {
  // Ensure output directory exists
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });

  // Remove existing file
  if (fs.existsSync(OUTPUT_PATH)) {
    fs.unlinkSync(OUTPUT_PATH);
    console.log(`Removed existing ${OUTPUT_PATH}`);
  }

  // Connect to MariaDB
  const pool = mariadb.createPool({
    host: 'localhost',
    port: 3306,
    user: 'mailsteward',
    password: 'mailsteward',
    database: 'ct_upm',
    connectionLimit: 1
  });

  const conn = await pool.getConnection();

  // Create SQLite database
  const db = new Database(OUTPUT_PATH);

  // Enable WAL mode for better read performance
  db.pragma('journal_mode = WAL');

  console.log('Creating SQLite schema...');

  db.exec(`
    CREATE TABLE chapters (
      id INTEGER PRIMARY KEY,
      chapter_number TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      url TEXT
    );

    CREATE TABLE sections (
      id INTEGER PRIMARY KEY,
      chapter_id INTEGER NOT NULL REFERENCES chapters(id),
      section_number TEXT NOT NULL,
      title TEXT,
      content TEXT,
      source_url TEXT,
      file_type TEXT,
      word_count INTEGER,
      effective_date TEXT,
      superseded_by TEXT,
      UNIQUE(chapter_id, section_number)
    );

    CREATE TABLE transmittals (
      id INTEGER PRIMARY KEY,
      transmittal_number TEXT NOT NULL UNIQUE,
      year INTEGER,
      sequence INTEGER,
      title TEXT,
      content TEXT,
      source_url TEXT
    );

    CREATE TABLE hearing_decisions (
      id INTEGER PRIMARY KEY,
      decision_number TEXT NOT NULL UNIQUE,
      category TEXT NOT NULL,
      year INTEGER,
      case_number TEXT,
      title TEXT,
      content TEXT,
      source_url TEXT,
      word_count INTEGER DEFAULT 0,
      page_count INTEGER DEFAULT 0
    );
  `);

  // Export chapters
  console.log('Exporting chapters...');
  const chapters = await conn.query('SELECT id, chapter_number, title, url FROM chapters ORDER BY id');
  const insertChapter = db.prepare('INSERT INTO chapters (id, chapter_number, title, url) VALUES (?, ?, ?, ?)');

  const insertChapters = db.transaction((rows) => {
    for (const row of rows) {
      insertChapter.run(row.id, row.chapter_number, row.title, row.url);
    }
  });
  insertChapters(chapters);
  console.log(`  ${chapters.length} chapters`);

  // Export sections
  console.log('Exporting sections...');
  const sections = await conn.query(
    'SELECT id, chapter_id, section_number, title, content, source_url, file_type, word_count, effective_date, superseded_by FROM sections ORDER BY id'
  );
  const insertSection = db.prepare(
    'INSERT INTO sections (id, chapter_id, section_number, title, content, source_url, file_type, word_count, effective_date, superseded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );

  const insertSections = db.transaction((rows) => {
    for (const row of rows) {
      const effDate = row.effective_date ? row.effective_date.toISOString().split('T')[0] : null;
      insertSection.run(row.id, row.chapter_id, row.section_number, row.title, row.content, row.source_url, row.file_type, row.word_count, effDate, row.superseded_by);
    }
  });
  insertSections(sections);
  console.log(`  ${sections.length} sections`);

  // Export transmittals
  console.log('Exporting transmittals...');
  const transmittals = await conn.query(
    'SELECT id, transmittal_number, year, sequence, title, content, source_url FROM transmittals ORDER BY id'
  );
  const insertTransmittal = db.prepare(
    'INSERT INTO transmittals (id, transmittal_number, year, sequence, title, content, source_url) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );

  const insertTransmittals = db.transaction((rows) => {
    for (const row of rows) {
      insertTransmittal.run(row.id, row.transmittal_number, row.year, row.sequence, row.title, row.content, row.source_url);
    }
  });
  insertTransmittals(transmittals);
  console.log(`  ${transmittals.length} transmittals`);

  // Export hearing decisions
  console.log('Exporting hearing decisions...');
  const hearings = await conn.query(
    'SELECT id, decision_number, category, year, case_number, title, content, source_url, word_count, page_count FROM hearing_decisions ORDER BY id'
  );
  const insertHearing = db.prepare(
    'INSERT INTO hearing_decisions (id, decision_number, category, year, case_number, title, content, source_url, word_count, page_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const insertHearings = db.transaction((rows) => {
    for (const row of rows) {
      insertHearing.run(row.id, row.decision_number, row.category, row.year, row.case_number, row.title, row.content, row.source_url, row.word_count, row.page_count);
    }
  });
  insertHearings(hearings);
  console.log(`  ${hearings.length} hearing decisions`);

  // Create FTS5 virtual tables for full-text search
  console.log('Creating full-text search indexes...');

  db.exec(`
    CREATE VIRTUAL TABLE sections_fts USING fts5(
      section_number,
      title,
      content,
      content=sections,
      content_rowid=id
    );

    INSERT INTO sections_fts(rowid, section_number, title, content)
    SELECT id, section_number, title, content FROM sections;

    CREATE VIRTUAL TABLE transmittals_fts USING fts5(
      transmittal_number,
      title,
      content,
      content=transmittals,
      content_rowid=id
    );

    INSERT INTO transmittals_fts(rowid, transmittal_number, title, content)
    SELECT id, transmittal_number, title, content FROM transmittals;

    CREATE VIRTUAL TABLE hearings_fts USING fts5(
      decision_number,
      title,
      content,
      content=hearing_decisions,
      content_rowid=id
    );

    INSERT INTO hearings_fts(rowid, decision_number, title, content)
    SELECT id, decision_number, title, content FROM hearing_decisions;
  `);

  // Create regular indexes
  db.exec(`
    CREATE INDEX idx_sections_chapter ON sections(chapter_id);
    CREATE INDEX idx_sections_number ON sections(section_number);
    CREATE INDEX idx_transmittals_year ON transmittals(year);
    CREATE INDEX idx_hearings_category ON hearing_decisions(category);
    CREATE INDEX idx_hearings_year ON hearing_decisions(year);
    CREATE INDEX idx_hearings_number ON hearing_decisions(decision_number);
  `);

  // Verify
  const sectionCount = db.prepare('SELECT COUNT(*) as count FROM sections').get();
  const transmittalCount = db.prepare('SELECT COUNT(*) as count FROM transmittals').get();
  const withContent = db.prepare('SELECT COUNT(*) as count FROM sections WHERE word_count > 0').get();

  const hearingCount = db.prepare('SELECT COUNT(*) as count FROM hearing_decisions').get();

  console.log('\n=== Export Complete ===');
  console.log(`Sections: ${sectionCount.count} (${withContent.count} with content)`);
  console.log(`Transmittals: ${transmittalCount.count}`);
  console.log(`Hearing decisions: ${hearingCount.count}`);
  console.log(`Database: ${OUTPUT_PATH}`);

  const stats = fs.statSync(OUTPUT_PATH);
  console.log(`Size: ${(stats.size / 1024 / 1024).toFixed(1)} MB`);

  // Cleanup
  db.close();
  conn.release();
  await pool.end();
}

exportToSqlite()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('Export failed:', err);
    process.exit(1);
  });
