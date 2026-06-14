#!/usr/bin/env node
/**
 * Load parsed federal public-law sections into the ct_upm MariaDB database.
 * Idempotent: creates the table if needed, clears any rows for the act_ids
 * being loaded, then inserts fresh. Source of truth for export-to-sqlite.cjs.
 *
 * Usage: node load-to-mariadb.cjs raw/dra2005.json raw/obbba.json
 */

const mariadb = require('mariadb');
const fs = require('fs');

const files = process.argv.slice(2);
if (!files.length) {
  console.error('Usage: node load-to-mariadb.cjs <parsed1.json> [parsed2.json ...]');
  process.exit(1);
}

(async () => {
  const pool = mariadb.createPool({
    host: 'localhost', port: 3306, user: 'mailsteward', password: 'mailsteward',
    database: 'ct_upm', connectionLimit: 1
  });
  const conn = await pool.getConnection();

  await conn.query(`
    CREATE TABLE IF NOT EXISTS federal_public_laws (
      id INT PRIMARY KEY AUTO_INCREMENT,
      act_id VARCHAR(20) NOT NULL,
      act_short_title VARCHAR(255),
      title_num VARCHAR(10),
      title_name VARCHAR(512),
      subtitle VARCHAR(255),
      section_number VARCHAR(40) NOT NULL,
      section_heading TEXT,
      content MEDIUMTEXT,
      stat_page VARCHAR(40),
      source_url VARCHAR(512),
      word_count INT DEFAULT 0,
      UNIQUE KEY uniq_act_section (act_id, section_number),
      KEY idx_act (act_id),
      KEY idx_title (act_id, title_num)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  const insert = `INSERT INTO federal_public_laws
    (act_id, act_short_title, title_num, title_name, subtitle, section_number,
     section_heading, content, stat_page, source_url, word_count)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`;

  let grand = 0;
  for (const f of files) {
    const rows = JSON.parse(fs.readFileSync(f, 'utf8'));
    const actIds = [...new Set(rows.map(r => r.act_id))];
    for (const a of actIds) {
      const del = await conn.query('DELETE FROM federal_public_laws WHERE act_id = ?', [a]);
      console.log(`Cleared ${del.affectedRows} existing rows for ${a}`);
    }
    await conn.beginTransaction();
    for (const r of rows) {
      await conn.query(insert, [
        r.act_id, r.act_short_title, r.title_num, r.title_name, r.subtitle,
        r.section_number, r.section_heading, r.content, r.stat_page,
        r.source_url, r.word_count
      ]);
    }
    await conn.commit();
    console.log(`Inserted ${rows.length} sections from ${f}`);
    grand += rows.length;
  }

  const tot = await conn.query('SELECT act_id, COUNT(*) c, SUM(word_count) w FROM federal_public_laws GROUP BY act_id');
  console.log('\n=== federal_public_laws ===');
  tot.forEach(r => console.log(`  ${r.act_id}: ${r.c} sections, ${Number(r.w).toLocaleString()} words`));
  console.log(`  TOTAL inserted this run: ${grand}`);

  conn.release();
  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
