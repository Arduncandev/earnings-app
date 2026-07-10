# EarningsIQ — 8-Quarter Financial Analysis App

A zero-dependency Node.js web app that retrieves the last 8 (or up to 12) quarters of SEC-filed financial data for any publicly traded US company and presents it as a polished, interactive earnings report.

## Features

- **Company search** — type any company name or ticker symbol; a dropdown disambiguates partial matches
- **Quick-launch chips** — one-click access to AAPL, MSFT, AMZN, GOOGL, TSLA, NVDA, META, JPM
- **Income statement table** — Revenue, Gross Profit, Operating Income, Net Income, Diluted EPS with YoY growth colouring
- **5 interactive SVG charts** — Revenue, Gross Margin %, Operating Margin %, EPS, Operating Cash Flow
- **Cash flow & profitability table** — Operating Cash Flow, Net Income, Gross Profit over time
- **Trend commentary** — auto-generated analysis of revenue, margin, EPS and cash flow trends
- **Analyst watch-points** — synthesised narrative of what would drive analyst discussion
- **Configurable quarters** — 4 / 6 / 8 / 10 / 12 quarter look-back
- **Zero npm dependencies** — uses only Node.js built-ins (`http`, `https`, `fs`, `path`, `url`)

## Data source

All data is pulled directly from the **SEC EDGAR XBRL Company Facts API** (`data.sec.gov`). This is free, public, and requires no API key. Figures are as reported in company SEC filings (10-Q and 10-K forms).

## Requirements

- Node.js 16 or later
- Internet access to reach `data.sec.gov`

## Quick start

```bash
cd modernized/earnings-app
node server.js
```

Then open **http://localhost:3737** in your browser.

To use a different port:

```bash
PORT=8080 node server.js
```

## Usage

1. Type a company name (e.g. `Apple`, `Amazon`, `NVIDIA`) or ticker symbol (e.g. `MSFT`, `TSLA`) in the search box
2. If multiple companies match, select the correct one from the dropdown
3. Choose how many quarters to display (default: 8)
4. Click **Analyse →**
5. Use the chart tabs to switch between Revenue, Gross Margin, Operating Margin, EPS, and Cash Flow views

## Architecture

```
earnings-app/
├── server.js          # Node.js HTTP server — serves static files + API proxy
│                      #   GET /api/search?q=<query>     → company search (SEC tickers list)
│                      #   GET /api/financials?cik=<cik>&n=<quarters> → XBRL data
└── public/
    └── index.html     # Single-page app (HTML + CSS + vanilla JS, no framework)
```

The server proxies two SEC EDGAR endpoints:
- `https://data.sec.gov/files/company_tickers.json` — full company→CIK mapping (cached in memory)
- `https://data.sec.gov/api/xbrl/companyfacts/CIK{paddedCik}.json` — all XBRL financial facts for a company

All financial extraction, quarterly slicing, and chart rendering happens in pure JavaScript.

## Limitations

- Only covers **US-listed companies** with SEC EDGAR filings
- Some earlier quarters may show `—` if the company did not XBRL-tag those line items in older filings
- Operating cash flow is used as the best available XBRL proxy for free cash flow (capex is not consistently tagged in all filings)
- Segment-level breakdowns are not available from XBRL data — only consolidated figures
- Data reflects **as-reported GAAP figures**; non-GAAP / adjusted figures require the full earnings press release
