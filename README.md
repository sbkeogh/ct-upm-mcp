# Connecticut Uniform Policy Manual — MCP Server

A remote [Model Context Protocol](https://modelcontextprotocol.io) server providing full-text search and analysis of the **Connecticut Department of Social Services Uniform Policy Manual (UPM)**.

The UPM governs Medicaid eligibility, asset treatment, income rules, transfer penalties, and other public assistance programs in Connecticut. This server makes all 1,632 policy sections searchable through Claude or any MCP-compatible client.

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
- "How are annuities treated for Medicaid eligibility?"
- "What are the current CSRA limits for a community spouse?"

## Available Tools

| Tool | Description |
|------|-------------|
| `upm_search` | Full-text search across all policy sections |
| `upm_get_section` | Get complete text of a specific section (e.g., "4030_10") |
| `upm_list_chapters` | List all 10 UPM chapters |
| `upm_list_sections` | List all sections within a chapter |
| `upm_analyze` | Comprehensive analysis — searches multiple chapters, follows cross-references, checks for policy updates |
| `upm_get_related` | Find sections that reference or are referenced by a given section |
| `upm_search_transmittals` | Search policy transmittals (updates/changes) |
| `upm_get_transmittal` | Get full text of a specific transmittal |
| `upm_check_updates` | Check for recent transmittals affecting a section |
| `upm_get_limits` | Current CT Medicaid financial limits (assets, income, penalty divisor, spousal protections) |
| `upm_stats` | Database statistics |

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

## Data Source

All content is scraped from the [CT DSS Uniform Policy Manual](https://portal.ct.gov/dss/lists/uniform-policy-manual) — public domain state government data. The database includes 433,000+ words of policy text and 266 policy transmittals.

## Self-Hosting

To run your own instance:

```bash
git clone https://github.com/sbkeogh/ct-upm-mcp.git
cd ct-upm-mcp
npm install
node server.js
```

The SQLite database (`data/ct-upm.db`) is included in the repo. No external database server needed.

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

The UPM content is public domain (CT state government). The server code is MIT licensed.

## Author

Built by [Stephen B. Keogh](https://keogh.law) — elder law attorney, Norwalk, CT.
