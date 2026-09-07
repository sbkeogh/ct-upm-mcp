# Connecting to the CT Elder Law Research Database in Claude

This is a custom MCP (Model Context Protocol) connector that gives Claude direct read access to a Connecticut elder-law research database. Claude can search statutes, regulations, policy manuals, court decisions, and administrative rulings, retrieve full text, and reason over what it finds.

## What you need

- A paid Claude account: **Pro, Max, Team, or Enterprise**. Custom connectors are not available on Free.
- Access via **claude.ai** in a browser (custom connectors are configured there; once added, they also appear in the Claude desktop app on the same account).

## One-time setup

1. Go to **https://claude.ai** and sign in.
2. Click your initials/avatar (bottom-left) → **Settings**.
3. In the left sidebar choose **Connectors**.
4. Scroll to the bottom and click **Add custom connector**. (If you don't see this option, your plan tier doesn't include it — verify you're on Pro or higher.)
5. Fill in:
   - **Name:** `CT Elder Law Research` (or anything you like)
   - **Remote MCP server URL:** `https://ct-upm-mcp.fly.dev/mcp`
   - Leave OAuth / authentication fields blank — the server is currently open.
6. Click **Add** / **Save**. Claude will probe the server and list the tools it exposes. You should see **34 tools** across eight prefixes: `upm_*`, `smm_*`, `court_*`, `hearing_*`, `statute_*`, `cfr_*`, `regulation_*`, `guidance_*`.

## Turning it on for a conversation

1. Start a **new chat** on claude.ai.
2. In the message composer, click the **tools/attachment icon** (paperclip or "+" depending on UI version) and enable the **CT Elder Law Research** connector for that conversation.
3. Ask your question normally. Claude will choose which tools to call.

## What's in the database

### State law and policy

- **Connecticut General Statutes** — 2,549 sections of CT statutes covering Title 17b (Social Services / Medicaid), Title 19a (Public Health / nursing homes / hospitals), and Title 45a (Probate Courts / decedents' estates / conservatorship / trusts). Source: cga.ct.gov.
- **Regulations of Connecticut State Agencies (RCSA)** — 751 sections of administrative regulations promulgated by DSS, DPH, and other CT agencies.
- **CT Uniform Policy Manual (UPM)** — 1,632 policy sections plus 266 transmittals — the DSS Medicaid policy manual.

### Federal law and policy

- **42 CFR** — 1,094 sections of federal Medicaid regulations governing state programs, eligibility, coverage, payment, fair hearings, and managed care.
- **CMS State Medicaid Manual (SMM)** — 62 sections of federal Medicaid policy from CMS Publication 45.
- **CMS sub-regulatory guidance** — 71 documents (State Medicaid Director letters, State Health Official letters, Informational Bulletins, and similar policy guidance).

### Decisions and rulings

- **CT Appellate & Supreme Court Decisions** — 529 Medicaid-relevant opinions, 2003–2026, full text.
- **CT Fair Hearing Decisions** — ~4,385 DSS administrative rulings (LTSS eligibility, medical assistance, SNAP, other Medicaid).

## Sample prompts that work well

- "What is the current asset limit for a community spouse under CT Medicaid? Cite the UPM and statute."
- "Find CT statutes governing transfer of assets and the Medicaid penalty period."
- "Pull up 42 CFR sections on estate recovery."
- "Search fair-hearing decisions where DSS denied a Medicaid application based on an undue-hardship waiver claim."
- "What does the SMM say about treatment of irrevocable trusts created with the applicant's assets?"
- "Show me CT appellate cases involving conservator authority to make gifts."
- "Find UPM transmittals issued in the last 12 months affecting Title 19."
- "What recent CMS State Medicaid Director letters address MAGI-based eligibility?"
- "Cross-reference CT statute 17b-261a, the corresponding UPM section, and any fair hearings interpreting it."

## Useful to know

- Tools return formatted excerpts with citations and source links. Ask Claude to "give me the full text of section X" if you need the entire policy or statute.
- The data is a snapshot. Statutes are current through the most recent scrape from cga.ct.gov, but the CT General Assembly refreshes that site after each legislative session — for post-session changes you'll need to re-scrape. Always cite-check anything you'll use in a brief, hearing, or filing against the official source.
- Authoritative sources behind this content: cga.ct.gov (statutes), eregulations.ct.gov (RCSA), portal.ct.gov/dss (UPM), portal.ct.gov/ohro (fair hearings), ecfr.gov (42 CFR), cms.gov (SMM and CMS guidance), jud.ct.gov (court decisions).
- The endpoint is hosted on Fly.io and is generally up; if Claude reports a connection error, try again in a minute.

## Privacy

This database contains only public legal research material — no client information, no case files, no privileged content. Anything you type into Claude is governed by your own Claude account's data settings.

## Questions / problems

Email Stephen Keogh at stephen@keogh.law.
