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

  // Connect to MariaDB — ct_upm database
  const pool = mariadb.createPool({
    host: 'localhost',
    port: 3306,
    user: 'mailsteward',
    password: 'mailsteward',
    database: 'ct_upm',
    connectionLimit: 1
  });

  // Connect to MariaDB — cms_smm database (federal policy)
  const smmPool = mariadb.createPool({
    host: 'localhost',
    port: 3306,
    user: 'mailsteward',
    password: 'mailsteward',
    database: 'cms_smm',
    connectionLimit: 1
  });

  const conn = await pool.getConnection();
  const smmConn = await smmPool.getConnection();

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

    CREATE TABLE court_decisions (
      id INTEGER PRIMARY KEY,
      case_name TEXT,
      court TEXT NOT NULL,
      year INTEGER,
      volume TEXT,
      page TEXT,
      content TEXT,
      source_url TEXT,
      pdf_filename TEXT UNIQUE,
      word_count INTEGER DEFAULT 0,
      page_count INTEGER DEFAULT 0,
      matched_keywords TEXT
    );

    CREATE TABLE ct_statutes (
      id INTEGER PRIMARY KEY,
      title_num TEXT NOT NULL,
      chapter_name TEXT,
      chapter_title TEXT,
      section_number TEXT NOT NULL UNIQUE,
      section_title TEXT,
      content TEXT,
      source_citations TEXT,
      source_url TEXT,
      word_count INTEGER DEFAULT 0
    );

    CREATE TABLE cfr_sections (
      id INTEGER PRIMARY KEY,
      part_num INTEGER NOT NULL,
      part_title TEXT,
      subpart TEXT,
      subpart_title TEXT,
      section_number TEXT NOT NULL UNIQUE,
      section_title TEXT,
      content TEXT,
      word_count INTEGER DEFAULT 0
    );

    CREATE TABLE ct_regulations (
      id INTEGER PRIMARY KEY,
      title_num TEXT NOT NULL,
      subtitle TEXT,
      subtitle_text TEXT,
      section_number TEXT NOT NULL UNIQUE,
      section_title TEXT,
      content TEXT,
      source_url TEXT,
      word_count INTEGER DEFAULT 0
    );

    CREATE TABLE cms_guidance (
      id INTEGER PRIMARY KEY,
      doc_type TEXT NOT NULL,
      filename TEXT NOT NULL UNIQUE,
      title TEXT,
      doc_date TEXT,
      year INTEGER,
      content TEXT,
      source_url TEXT,
      word_count INTEGER DEFAULT 0,
      page_count INTEGER DEFAULT 0
    );

    CREATE TABLE federal_public_laws (
      id INTEGER PRIMARY KEY,
      act_id TEXT NOT NULL,
      act_short_title TEXT,
      title_num TEXT,
      title_name TEXT,
      subtitle TEXT,
      section_number TEXT NOT NULL,
      section_heading TEXT,
      content TEXT,
      stat_page TEXT,
      source_url TEXT,
      word_count INTEGER DEFAULT 0,
      UNIQUE(act_id, section_number)
    );

    CREATE TABLE smm_chapters (
      id INTEGER PRIMARY KEY,
      chapter_number INTEGER NOT NULL UNIQUE,
      title TEXT NOT NULL,
      source_url TEXT
    );

    CREATE TABLE smm_sections (
      id INTEGER PRIMARY KEY,
      chapter_id INTEGER NOT NULL REFERENCES smm_chapters(id),
      section_number TEXT NOT NULL,
      section_range_end TEXT,
      title TEXT,
      content TEXT,
      filename TEXT,
      word_count INTEGER,
      UNIQUE(chapter_id, section_number)
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

  // Export court decisions
  console.log('Exporting court decisions...');
  const courts = await conn.query(
    'SELECT id, case_name, court, year, volume, page, content, source_url, pdf_filename, word_count, page_count, matched_keywords FROM court_decisions ORDER BY id'
  );
  const insertCourt = db.prepare(
    'INSERT INTO court_decisions (id, case_name, court, year, volume, page, content, source_url, pdf_filename, word_count, page_count, matched_keywords) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const insertCourts = db.transaction((rows) => {
    for (const row of rows) {
      insertCourt.run(row.id, row.case_name, row.court, row.year, row.volume, row.page, row.content, row.source_url, row.pdf_filename, row.word_count, row.page_count, row.matched_keywords);
    }
  });
  insertCourts(courts);
  console.log(`  ${courts.length} court decisions`);

  // Export CT Statutes
  console.log('Exporting CT Statutes...');
  const statutes = await conn.query(
    'SELECT id, title_num, chapter_name, chapter_title, section_number, section_title, content, source_citations, source_url, word_count FROM ct_statutes ORDER BY id'
  );
  const insertStatute = db.prepare(
    'INSERT INTO ct_statutes (id, title_num, chapter_name, chapter_title, section_number, section_title, content, source_citations, source_url, word_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const insertStatutes = db.transaction((rows) => {
    for (const row of rows) {
      insertStatute.run(row.id, row.title_num, row.chapter_name, row.chapter_title, row.section_number, row.section_title, row.content, row.source_citations, row.source_url, row.word_count);
    }
  });
  insertStatutes(statutes);
  console.log(`  ${statutes.length} CT statutes`);

  // Export 42 CFR sections
  console.log('Exporting 42 CFR sections...');
  const cfrSections = await conn.query(
    'SELECT id, part_num, part_title, subpart, subpart_title, section_number, section_title, content, word_count FROM cfr_sections ORDER BY id'
  );
  const insertCfr = db.prepare(
    'INSERT INTO cfr_sections (id, part_num, part_title, subpart, subpart_title, section_number, section_title, content, word_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const insertCfrs = db.transaction((rows) => {
    for (const row of rows) {
      insertCfr.run(row.id, row.part_num, row.part_title, row.subpart, row.subpart_title, row.section_number, row.section_title, row.content, row.word_count);
    }
  });
  insertCfrs(cfrSections);
  console.log(`  ${cfrSections.length} CFR sections`);

  // Export CT Regulations (RCSA)
  console.log('Exporting CT Regulations...');
  const regulations = await conn.query(
    'SELECT id, title_num, subtitle, subtitle_text, section_number, section_title, content, source_url, word_count FROM ct_regulations ORDER BY id'
  );
  const insertReg = db.prepare(
    'INSERT INTO ct_regulations (id, title_num, subtitle, subtitle_text, section_number, section_title, content, source_url, word_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const insertRegs = db.transaction((rows) => {
    for (const row of rows) {
      insertReg.run(row.id, row.title_num, row.subtitle, row.subtitle_text, row.section_number, row.section_title, row.content, row.source_url, row.word_count);
    }
  });
  insertRegs(regulations);
  console.log(`  ${regulations.length} CT regulations`);

  // Export CMS Guidance (SMDL/CIB/SHO)
  console.log('Exporting CMS Guidance...');
  const guidance = await conn.query(
    'SELECT id, doc_type, filename, title, doc_date, year, content, source_url, word_count, page_count FROM cms_guidance ORDER BY id'
  );
  const insertGuidance = db.prepare(
    'INSERT INTO cms_guidance (id, doc_type, filename, title, doc_date, year, content, source_url, word_count, page_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const insertGuidances = db.transaction((rows) => {
    for (const row of rows) {
      insertGuidance.run(row.id, row.doc_type, row.filename, row.title, row.doc_date, row.year, row.content, row.source_url, row.word_count, row.page_count);
    }
  });
  insertGuidances(guidance);
  console.log(`  ${guidance.length} CMS guidance documents`);

  // Export Federal Public Laws (OBBBA, DRA 2005, etc.)
  console.log('Exporting Federal Public Laws...');
  const publaws = await conn.query(
    'SELECT id, act_id, act_short_title, title_num, title_name, subtitle, section_number, section_heading, content, stat_page, source_url, word_count FROM federal_public_laws ORDER BY id'
  );
  const insertPublaw = db.prepare(
    'INSERT INTO federal_public_laws (id, act_id, act_short_title, title_num, title_name, subtitle, section_number, section_heading, content, stat_page, source_url, word_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const insertPublaws = db.transaction((rows) => {
    for (const row of rows) {
      insertPublaw.run(row.id, row.act_id, row.act_short_title, row.title_num, row.title_name, row.subtitle, row.section_number, row.section_heading, row.content, row.stat_page, row.source_url, row.word_count);
    }
  });
  insertPublaws(publaws);
  console.log(`  ${publaws.length} federal public law sections`);

  // Export SMM chapters (from cms_smm database)
  console.log('Exporting SMM chapters...');
  const smmChapters = await smmConn.query('SELECT id, chapter_number, title, source_url FROM chapters ORDER BY id');
  const insertSmmChapter = db.prepare('INSERT INTO smm_chapters (id, chapter_number, title, source_url) VALUES (?, ?, ?, ?)');
  const insertSmmChapters = db.transaction((rows) => {
    for (const row of rows) {
      insertSmmChapter.run(row.id, row.chapter_number, row.title, row.source_url);
    }
  });
  insertSmmChapters(smmChapters);
  console.log(`  ${smmChapters.length} SMM chapters`);

  // Export SMM sections
  console.log('Exporting SMM sections...');
  const smmSections = await smmConn.query(
    'SELECT id, chapter_id, section_number, section_range_end, title, content, filename, word_count FROM sections ORDER BY id'
  );
  const insertSmmSection = db.prepare(
    'INSERT INTO smm_sections (id, chapter_id, section_number, section_range_end, title, content, filename, word_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const insertSmmSections = db.transaction((rows) => {
    for (const row of rows) {
      insertSmmSection.run(row.id, row.chapter_id, row.section_number, row.section_range_end, row.title, row.content, row.filename, row.word_count);
    }
  });
  insertSmmSections(smmSections);
  console.log(`  ${smmSections.length} SMM sections`);

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

    CREATE VIRTUAL TABLE courts_fts USING fts5(
      case_name,
      content,
      content=court_decisions,
      content_rowid=id
    );

    INSERT INTO courts_fts(rowid, case_name, content)
    SELECT id, case_name, content FROM court_decisions;

    CREATE VIRTUAL TABLE smm_fts USING fts5(
      section_number,
      title,
      content,
      content=smm_sections,
      content_rowid=id
    );

    INSERT INTO smm_fts(rowid, section_number, title, content)
    SELECT id, section_number, title, content FROM smm_sections;

    CREATE VIRTUAL TABLE statutes_fts USING fts5(
      section_number, section_title, content,
      content=ct_statutes, content_rowid=id
    );
    INSERT INTO statutes_fts(rowid, section_number, section_title, content)
    SELECT id, section_number, section_title, content FROM ct_statutes;

    CREATE VIRTUAL TABLE cfr_fts USING fts5(
      section_number, section_title, content,
      content=cfr_sections, content_rowid=id
    );
    INSERT INTO cfr_fts(rowid, section_number, section_title, content)
    SELECT id, section_number, section_title, content FROM cfr_sections;

    CREATE VIRTUAL TABLE regulations_fts USING fts5(
      section_number, section_title, content,
      content=ct_regulations, content_rowid=id
    );
    INSERT INTO regulations_fts(rowid, section_number, section_title, content)
    SELECT id, section_number, section_title, content FROM ct_regulations;

    CREATE VIRTUAL TABLE guidance_fts USING fts5(
      filename, title, content,
      content=cms_guidance, content_rowid=id
    );
    INSERT INTO guidance_fts(rowid, filename, title, content)
    SELECT id, filename, title, content FROM cms_guidance;

    CREATE VIRTUAL TABLE publaws_fts USING fts5(
      section_number, section_heading, content,
      content=federal_public_laws, content_rowid=id
    );
    INSERT INTO publaws_fts(rowid, section_number, section_heading, content)
    SELECT id, section_number, section_heading, content FROM federal_public_laws;
  `);

  // Create regular indexes
  db.exec(`
    CREATE INDEX idx_sections_chapter ON sections(chapter_id);
    CREATE INDEX idx_sections_number ON sections(section_number);
    CREATE INDEX idx_transmittals_year ON transmittals(year);
    CREATE INDEX idx_hearings_category ON hearing_decisions(category);
    CREATE INDEX idx_hearings_year ON hearing_decisions(year);
    CREATE INDEX idx_hearings_number ON hearing_decisions(decision_number);
    CREATE INDEX idx_courts_court ON court_decisions(court);
    CREATE INDEX idx_courts_year ON court_decisions(year);
    CREATE INDEX idx_courts_filename ON court_decisions(pdf_filename);
    CREATE INDEX idx_smm_chapter ON smm_sections(chapter_id);
    CREATE INDEX idx_smm_number ON smm_sections(section_number);
    CREATE INDEX idx_statutes_title ON ct_statutes(title_num);
    CREATE INDEX idx_statutes_number ON ct_statutes(section_number);
    CREATE INDEX idx_cfr_part ON cfr_sections(part_num);
    CREATE INDEX idx_cfr_number ON cfr_sections(section_number);
    CREATE INDEX idx_regs_title ON ct_regulations(title_num);
    CREATE INDEX idx_regs_number ON ct_regulations(section_number);
    CREATE INDEX idx_guidance_type ON cms_guidance(doc_type);
    CREATE INDEX idx_guidance_year ON cms_guidance(year);
    CREATE INDEX idx_guidance_filename ON cms_guidance(filename);
    CREATE INDEX idx_publaw_act ON federal_public_laws(act_id);
    CREATE INDEX idx_publaw_section ON federal_public_laws(section_number);
    CREATE INDEX idx_publaw_title ON federal_public_laws(act_id, title_num);
  `);

  // Verify
  const sectionCount = db.prepare('SELECT COUNT(*) as count FROM sections').get();
  const transmittalCount = db.prepare('SELECT COUNT(*) as count FROM transmittals').get();
  const withContent = db.prepare('SELECT COUNT(*) as count FROM sections WHERE word_count > 0').get();

  const hearingCount = db.prepare('SELECT COUNT(*) as count FROM hearing_decisions').get();
  const courtCount = db.prepare('SELECT COUNT(*) as count FROM court_decisions').get();
  const smmSectionCount = db.prepare('SELECT COUNT(*) as count FROM smm_sections').get();
  const statuteCount = db.prepare('SELECT COUNT(*) as count FROM ct_statutes').get();
  const cfrCount = db.prepare('SELECT COUNT(*) as count FROM cfr_sections').get();
  const regCount = db.prepare('SELECT COUNT(*) as count FROM ct_regulations').get();
  const guidanceCount = db.prepare('SELECT COUNT(*) as count FROM cms_guidance').get();
  const publawCount = db.prepare('SELECT COUNT(*) as count FROM federal_public_laws').get();

  console.log('\n=== Export Complete ===');
  console.log(`UPM Sections: ${sectionCount.count} (${withContent.count} with content)`);
  console.log(`UPM Transmittals: ${transmittalCount.count}`);
  console.log(`Fair Hearing decisions: ${hearingCount.count}`);
  console.log(`Court decisions: ${courtCount.count}`);
  console.log(`SMM Sections: ${smmSectionCount.count}`);
  console.log(`CT Statutes: ${statuteCount.count}`);
  console.log(`42 CFR Sections: ${cfrCount.count}`);
  console.log(`CT Regulations: ${regCount.count}`);
  console.log(`CMS Guidance: ${guidanceCount.count}`);
  console.log(`Federal Public Laws: ${publawCount.count}`);
  console.log(`Database: ${OUTPUT_PATH}`);

  const stats = fs.statSync(OUTPUT_PATH);
  console.log(`Size: ${(stats.size / 1024 / 1024).toFixed(1)} MB`);

  // Cleanup
  db.close();
  conn.release();
  smmConn.release();
  await pool.end();
  await smmPool.end();
}

exportToSqlite()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('Export failed:', err);
    process.exit(1);
  });
