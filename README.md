# Connecticut Medicaid & Elder Law Research — MCP Server

A remote [Model Context Protocol](https://modelcontextprotocol.io) server providing full-text search and analysis of the legal sources that govern Connecticut Medicaid, probate, and elder law practice.

The server began as a search interface for the **Connecticut DSS Uniform Policy Manual (UPM)** — and keeps that name — but now serves **nine distinct source collections**: roughly 11,500 documents and 16.5 million words of statutes, regulations, policy manuals, court decisions, administrative hearing decisions, and federal guidance, all searchable through Claude or any MCP-compatible client.

## Connect with Claude

Add this server as a remote MCP integration in Claude Desktop or Claude Code settings:

```json
{
  "mcpServers": {
    "ct-upm": {
      "url": "https://ct-upm-mcp.fly.dev/mcp"
    }
  }
}
```

Then ask Claude questions like:
- "What is the Medicaid transfer penalty lookback period in Connecticut?"
- "How has DSS ruled on annuities in fair hearings?"
- "What does 42 CFR say about spousal impoverishment?"
- "Find CT Supreme Court decisions on conservatorship authority."

## What's in the database

Counts as of July 2026.

| Collection | Tool prefix | Contents | Coverage |
|---|---|---|---|
| **CT DSS Uniform Policy Manual** | `upm_*` | 1,632 policy sections across all 10 chapters, plus 266 policy transmittals | Transmittals 2000–2019 |
| **CT General Statutes** | `statute_*` | 2,549 sections — Title 17b (Social Services, 638), Title 19a (Public Health, 1,074), Title 45a (Probate Courts, 837) | Current revision at scrape time |
| **Regulations of CT State Agencies (RCSA)** | `regulation_*` | 751 sections — Title 17b (DSS regulations) | Current at scrape time |
| **42 CFR — federal Medicaid regulations** | `cfr_*` | 1,094 sections, Parts 430–456 (eligibility, FFP, managed care, payments, program integrity, utilization control) | Current at scrape time |
| **CT court decisions** | `court_*` | 536 decisions — Supreme Court (206) and Appellate Court (330) — curated for Medicaid, conservatorship, elder law, and social-services subject matter | 2003–present, refreshed weekly |
| **CT DSS fair hearing decisions** | `hearing_*` | 4,384 administrative hearing decisions in four categories: LTSS Eligibility (1,028), Medical Services (1,325), Other Medicaid Eligibility (956), SNAP Eligibility (1,075) | Refreshed weekly; corpus currently extends through 2024 (DSS posting lag) |
| **CMS sub-regulatory guidance** | `guidance_*` | 71 documents — State Medicaid Director Letters (61) and State Health Official letters (10) | 2000–2011 |
| **CMS State Medicaid Manual** (Publication #45) | `smm_*` | 62 sections across 12 chapters — the federal reference manual for state Medicaid implementation | — |
| **Federal Public Laws** | `publaw_*` | 474 sections from 2 acts: **Deficit Reduction Act of 2005** (PL 109-171 — source of the 5-year look-back, annuity, and home-equity rules) and **One Big Beautiful Bill Act** (PL 119-21, signed July 4, 2025) | — |

## Available Tools

Every collection has a `*_search` (full-text, with filters), a `*_get` (retrieve one document in full), and a `*_stats` tool. The UPM and SMM collections add structure/browse tools, and the UPM adds analysis tools — 37 tools in total.

### UPM (`upm_*`)

| Tool | Description |
|------|-------------|
| `upm_search` | Full-text search across all policy sections; current policy ranked above superseded versions, with currency warnings |
| `upm_get_section` | Full text of a section (e.g., `"4030_10"`) |
| `upm_list_chapters` / `upm_list_sections` | Browse the manual's structure |
| `upm_search_transmittals` / `upm_get_transmittal` | Search and retrieve policy transmittals (updates/changes) |
| `upm_check_updates` | Find transmittals affecting a specific section |
| `upm_get_related` | Sections that reference, or are referenced by, a given section |
| `upm_analyze` | Multi-chapter analysis for a legal question — searches, follows cross-references, checks currency |
| `upm_get_limits` | Current CT Medicaid financial limits (assets, income, penalty divisor, spousal protections) |
| `upm_stats` | Database statistics |

### Other collections

| Tools | Collection | Notable filters |
|------|-------------|---|
| `statute_search` / `statute_get` / `statute_stats` | CT General Statutes | `title` (17b, 19a, 45a); get by section number (e.g., `"17b-261"`) |
| `regulation_search` / `regulation_get` / `regulation_stats` | RCSA | `title`; get by RCSA section number |
| `cfr_search` / `cfr_get` / `cfr_stats` | 42 CFR | `part` (430–456); get by section number (e.g., `"435.726"`) |
| `court_search` / `court_get` / `court_stats` | CT appellate courts | `court` (appellate/supreme), `year`; get by PDF filename |
| `hearing_search` / `hearing_get` / `hearing_stats` | DSS fair hearings | `category`, `year`; get by decision number (e.g., `"LTEL_2024_214656"`) |
| `guidance_search` / `guidance_get` / `guidance_stats` | CMS guidance | `doc_type`, `year`; get by filename |
| `smm_search` / `smm_get_section` / `smm_list_chapters` / `smm_list_sections` / `smm_stats` | CMS State Medicaid Manual | `chapter` |
| `publaw_search` / `publaw_get` / `publaw_stats` | Federal Public Laws | `act` (`"PL 109-171"` or `"PL 119-21"`); get by section number (e.g., `"6012"`) |

## UPM Chapter Reference

| Chapter | Title | Sections |
|---------|-------|----------|
| UPM0 | Table of Contents | 26 |
| UPM1 | Rights and Responsibilities, Eligibility Process | 178 |
| UPM2 | Assistance Unit Composition, Categorical Eligibility | 165 |
| UPM3 | Technical and Procedural Eligibility Requirements | 229 |
| **UPM4** | **Treatment of Assets, Standards of Assistance** | **216** |
| **UPM5** | **Treatment of Income, Income Eligibility** | **186** |
| UPM6 | Calculation of Benefits, Benefit Issuance | 106 |
| UPM7 | Benefit Error, Recovery | 122 |
| UPM8 | Special Programs (SAGA, Jobs First) | 336 |
| UPM9 | Special Benefits | 68 |

Chapters 4 and 5 (bolded) are the most relevant for Medicaid eligibility and elder law practice.

## Currency & Scope Caveats

This is a research aid, not a substitute for checking the live source. Know the edges:

- **UPM transmittal coverage ends in 2019.** The policy text reflects the manual as of the last scrape; verify post-2019 changes (and current dollar figures — use `upm_get_limits`) against [the live UPM](https://portal.ct.gov/dss/lists/uniform-policy-manual).
- **CMS guidance ends in 2011.** Post-ACA SMDLs and recent SHO letters are not included.
- **Fair hearing decisions include SNAP.** About a quarter of the hearing corpus is SNAP eligibility, not Medicaid — check the category before treating a decision as Medicaid authority. Fair hearing decisions are persuasive, never binding.
- **Statutes and regulations are deliberately narrow.** Three CGS titles and one RCSA title, curated for elder law practice — this is not a general Connecticut law database.
- **Court decisions are a curated subset.** Supreme and Appellate decisions touching Medicaid, conservatorship, elder law, and social services — not the full body of CT case law, and no Superior Court decisions.
- Statute, regulation, and CFR text reflects the source as of the scrape date; always confirm currency before citing.

## Refresh Cadence

Court decisions and fair hearing decisions are re-scraped weekly (Sundays, incremental), and the deployed snapshot at ct-upm-mcp.fly.dev is re-exported and redeployed weekly (Mondays, with row-count sanity gates). The other collections are point-in-time scrapes refreshed manually.

## Data Sources

All content is public-domain government data, scraped from official sources:

| Collection | Source |
|---|---|
| UPM + transmittals | [portal.ct.gov — DSS Uniform Policy Manual](https://portal.ct.gov/dss/lists/uniform-policy-manual) |
| CT General Statutes | [cga.ct.gov](https://www.cga.ct.gov/current/pub/) |
| RCSA | [eregulations.ct.gov](https://eregulations.ct.gov/eRegsPortal/Browse/RCSA) |
| 42 CFR | [govinfo.gov eCFR bulk data](https://www.govinfo.gov/bulkdata/ECFR/title-42/ECFR-title42.xml) |
| CT court decisions | [jud.ct.gov published opinions](https://www.jud.ct.gov/external/supapp/) |
| Fair hearing decisions | [portal.ct.gov — DSS Administrative Hearings Decisions](https://portal.ct.gov/dss/lists/administrative-hearings-decisions/) |
| CMS guidance | [medicaid.gov federal policy guidance](https://www.medicaid.gov/federal-policy-guidance) + CMS archived downloads |
| CMS State Medicaid Manual | CMS Publication #45 |
| Federal Public Laws | U.S. Government Publishing Office (govinfo.gov) |

## Self-Hosting

```bash
git clone https://github.com/sbkeogh/ct-upm-mcp.git
cd ct-upm-mcp
npm install
node server.js
```

**Note:** the SQLite database (`data/ct-upm.db`, ~184 MB) is **not** included in the repo — it is built from the public sources above and baked into the deployed Docker image at build time. To self-host you will need to supply your own database file at `DB_PATH`; open an issue on the repo if you want a copy.

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3100` | HTTP port |
| `API_KEY` | *(none)* | Optional Bearer token for access control |
| `DB_PATH` | `./data/ct-upm.db` | Path to SQLite database |

### Docker

```bash
docker build -t ct-upm-mcp .
docker run -p 3100:3100 ct-upm-mcp
```

## License

The underlying content is public-domain government data (Connecticut state and U.S. federal government works). The server code is MIT licensed.

## Author

Built by [Stephen B. Keogh](https://keogh.law) — elder law attorney, Norwalk, CT.
