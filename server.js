/**
 * EarningsIQ — Node.js proxy server
 * Wraps the SEC EDGAR public APIs so the browser can call them without CORS issues.
 *
 * Endpoints:
 *   GET /api/search?q=<query>              → company search (name or ticker)
 *   GET /api/financials?cik=<cik>&n=<n>   → XBRL quarterly financials
 *   GET /api/stockprice?ticker=<t>&n=<n>  → historical daily close prices
 *   GET /api/pricedrivers?ticker=&cik=&n= → significant price moves + web context
 *
 * Run: node server.js   (default port 3737)
 * Uses only Node.js built-ins — no npm packages required.
 *
 * Optional env vars for web-search grounding:
 *   BRAVE_API_KEY   — Brave Search API key  (https://brave.com/search/api/)
 *   GOOGLE_API_KEY  — Google Custom Search API key
 *   GOOGLE_CX       — Google Programmable Search Engine ID
 */

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

// ── Auto-load .env from the same directory as server.js ─────
const ENV_PATH = path.join(__dirname, '.env');
if (fs.existsSync(ENV_PATH)) {
  console.log(`  [.env] Loading from: ${ENV_PATH}`);
  for (const line of fs.readFileSync(ENV_PATH, 'utf8').split('\n')) {
    const m = line.match(/^\s*([^#][^=]*?)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2];
      console.log(`  [.env] Set: ${m[1]}`);
    }
  }
} else {
  console.log(`  [.env] Not found at: ${ENV_PATH}`);
}

const PORT = process.env.PORT || 3737;

// ── Web search API key (optional) ───────────────────────────
const SERPER_API_KEY = process.env.SERPER_API_KEY || '';
console.log(`  [search] SERPER_API_KEY: ${SERPER_API_KEY ? 'SET ✓' : 'NOT SET'}`);

// ---------- HTTPS helper ----------

function httpsGet(hostname, pathname) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname,
      path: pathname,
      headers: {
        'User-Agent': 'EarningsIQ/1.0 research-app@example.com',
        'Accept': 'application/json, text/xml, */*',
      },
    };
    https.get(opts, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, body: raw });
      });
    }).on('error', reject);
  });
}

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'public, max-age=300',
  });
  res.end(json);
}

function sendFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js':   'application/javascript',
    '.css':  'text/css',
    '.ico':  'image/x-icon',
  };
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[ext] || 'text/plain' });
    res.end(data);
  });
}

// ---------- SEC EDGAR helpers ----------

/**
 * Resolve a ticker symbol or CIK-style search using browse-edgar atom feed.
 * Works for both "CIK=AAPL" style (single result) and "company=amazon" (multi).
 */
async function edgarSearch(query) {
  const q = query.trim();
  const isTicker = /^[A-Z]{1,5}(\.[A-Z])?$/.test(q.toUpperCase());

  // Strategy 1: if it looks like a ticker, try CIK=TICKER lookup first
  if (isTicker) {
    const r = await httpsGet('www.sec.gov',
      `/cgi-bin/browse-edgar?action=getcompany&CIK=${encodeURIComponent(q.toUpperCase())}&type=10-K&dateb=&owner=include&count=1&output=atom`);
    if (r.status === 200) {
      const single = parseSingleEdgarAtom(r.body);
      if (single) {
        // Enrich with submission data to get tickers/exchange
        const sub = await resolveSubmission(single.cik).catch(() => null);
        return [sub || single];
      }
    }
  }

  // Strategy 2: company name search
  const r = await httpsGet('www.sec.gov',
    `/cgi-bin/browse-edgar?action=getcompany&company=${encodeURIComponent(q)}&type=10-K&dateb=&owner=include&count=15&output=atom`);
  if (r.status !== 200) throw new Error('SEC EDGAR search failed: ' + r.status);

  const xml = r.body;

  // Single-company response: top-level <company-info> with <conformed-name> and <cik>
  const single = parseSingleEdgarAtom(xml);
  if (single) {
    const sub = await resolveSubmission(single.cik).catch(() => null);
    return [sub || single];
  }

  // Multi-company response: <entry> blocks, each containing a <company-info> without a name.
  // We extract the CIK from the <id> tag and resolve names from submissions.
  const cikMatches = [...xml.matchAll(/<id>urn:tag:www\.sec\.gov:cik=(\d+)<\/id>/g)];
  if (!cikMatches.length) return [];

  const ciks = cikMatches.map(m => m[1]).slice(0, 12);

  // Parallel-resolve all CIKs via submissions API
  const resolved = await Promise.allSettled(
    ciks.map(cik => resolveSubmission(cik))
  );

  const results = [];
  for (const r of resolved) {
    if (r.status === 'fulfilled' && r.value) {
      const { cik, name, tickers, exchanges, sic, sicDescription } = r.value;
      // Filter to companies that have actual filings (tickers list present or major exchange)
      results.push({ cik, name, tickers, exchanges, sic, sicDescription });
    }
  }

  // Sort: companies with exchanges (active, listed) first, then those with tickers, then others
  results.sort((a, b) => {
    const aScore = (a.exchanges && a.exchanges.length > 0) ? 0 : (a.tickers && a.tickers.length > 0) ? 1 : 2;
    const bScore = (b.exchanges && b.exchanges.length > 0) ? 0 : (b.tickers && b.tickers.length > 0) ? 1 : 2;
    return aScore - bScore;
  });

  return results.slice(0, 10);
}

/**
 * Parse the single-company atom feed format (when EDGAR matches exactly one company).
 * Returns { cik, name, tickers, exchanges } or null.
 */
function parseSingleEdgarAtom(xml) {
  // Pattern: top-level <company-info> (not nested inside an <entry>)
  // The distinguishing feature is <conformed-name> present directly in top-level company-info
  const m = xml.match(/<feed[^>]*>[\s\S]*?<company-info>[\s\S]*?<cik>(\d+)<\/cik>[\s\S]*?<conformed-name>([^<]+)<\/conformed-name>/);
  if (!m) return null;
  const cik = m[1].replace(/^0+/, '');
  const name = m[2].trim();
  // Try to extract ticker from the title element: e.g. "Apple Inc.  (0000320193)"
  const titleM = xml.match(/<title>([^(]+)\s*\((\d+)\)\s*<\/title>/);
  const ticker = null; // We'll resolve via submissions if needed
  return { cik, name, tickers: [], exchanges: [] };
}

/**
 * Fetch the submissions JSON for a CIK to get name, tickers, exchange.
 */
async function resolveSubmission(cik) {
  const paddedCik = String(cik).padStart(10, '0');
  const r = await httpsGet('data.sec.gov', `/submissions/CIK${paddedCik}.json`);
  if (r.status !== 200) return null;
  try {
    const d = JSON.parse(r.body);
    return {
      cik: String(d.cik || cik).replace(/^0+/, ''),
      name: d.name || '',
      tickers: d.tickers || [],
      exchanges: d.exchanges || [],
      sic: d.sic || '',
      sicDescription: d.sicDescription || '',
    };
  } catch { return null; }
}

// ---------- Financial data extraction ----------

/**
 * Fetch the XBRL Company Facts for a CIK.
 */
async function fetchCompanyFacts(cik) {
  const paddedCik = String(cik).padStart(10, '0');
  const r = await httpsGet('data.sec.gov', `/api/xbrl/companyfacts/CIK${paddedCik}.json`);
  if (r.status !== 200) throw new Error('Company facts not found (status ' + r.status + ')');
  return JSON.parse(r.body);
}

/**
 * Extract quarterly values for a given XBRL concept.
 * Returns entries sorted oldest→newest, deduplicated by period-end date.
 */
function extractQuarterly(facts, taxonomy, concept) {
  try {
    const units = facts[taxonomy][concept].units;
    const key = Object.keys(units)[0]; // usually "USD" or "pure"
    const values = units[key];

    // Keep only values with a start date (instant values excluded)
    // and that cover roughly one quarter (60–110 days)
    const quarterly = values.filter(v => {
      if (!v.start) return false;
      const days = (new Date(v.end) - new Date(v.start)) / 86400000;
      return days >= 60 && days <= 110;
    });

    // Deduplicate: for each period-end, keep the most recently filed entry
    const byEnd = {};
    for (const v of quarterly) {
      const key = v.end;
      if (!byEnd[key] || new Date(v.filed) > new Date(byEnd[key].filed)) {
        byEnd[key] = v;
      }
    }

    return Object.values(byEnd).sort((a, b) => new Date(a.end) - new Date(b.end));
  } catch {
    return [];
  }
}

function quarterLabel(isoDate) {
  const d = new Date(isoDate);
  const y = d.getFullYear();
  const m = d.getMonth(); // 0-based
  if (m <= 2) return `Q1 ${y}`;
  if (m <= 5) return `Q2 ${y}`;
  if (m <= 8) return `Q3 ${y}`;
  return `Q4 ${y}`;
}

/**
 * Build the quarterly summary array from XBRL facts.
 */
function buildQuarterlySummary(allFacts, numQuarters = 8) {
  const usGaap = allFacts.facts['us-gaap'] || {};

  // Revenue — try multiple concept names in priority order
  const revSeries = firstNonEmpty(usGaap, [
    'RevenueFromContractWithCustomerExcludingAssessedTax',
    'Revenues',
    'SalesRevenueNet',
    'SalesRevenueGoodsNet',
    'RevenuesNetOfInterestExpense',
  ]);

  const gpSeries  = firstNonEmpty(usGaap, ['GrossProfit']);
  const opSeries  = firstNonEmpty(usGaap, ['OperatingIncomeLoss', 'IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest']);
  const niSeries  = firstNonEmpty(usGaap, ['NetIncomeLoss', 'ProfitLoss']);
  const epsSeries = firstNonEmpty(usGaap, ['EarningsPerShareDiluted', 'EarningsPerShareBasic']);
  const cfSeries  = firstNonEmpty(usGaap, ['NetCashProvidedByUsedInOperatingActivities']);

  if (!revSeries.length) return [];

  // Align all series by period-end date
  function toMap(arr) {
    const m = {};
    for (const v of arr) m[v.end] = v.val;
    return m;
  }

  const revMap = toMap(revSeries);
  const gpMap  = toMap(gpSeries);
  const opMap  = toMap(opSeries);
  const niMap  = toMap(niSeries);
  const epsMap = toMap(epsSeries);
  const cfMap  = toMap(cfSeries);

  // Use revenue dates as the spine, take last numQuarters
  const periods = revSeries.map(v => v.end).slice(-numQuarters);

  return periods.map((end, idx, arr) => {
    const rev = revMap[end] ?? null;
    const gp  = gpMap[end]  ?? null;
    const op  = opMap[end]  ?? null;
    const ni  = niMap[end]  ?? null;
    const eps = epsMap[end] ?? null;
    const cf  = cfMap[end]  ?? null;
    const gm  = (rev && gp) ? (gp / rev * 100) : null;
    const om  = (rev && op) ? (op / rev * 100) : null;

    // YoY — compare with entry 4 positions earlier (same quarter prior year)
    const priorIdx = arr.indexOf(end) - 4;
    const priorEnd = priorIdx >= 0 ? arr[priorIdx] : null;
    const priorRev = priorEnd ? revMap[priorEnd] : null;
    const revYoY = (priorRev && rev)
      ? ((rev - priorRev) / Math.abs(priorRev) * 100).toFixed(1)
      : null;

    return {
      period:           quarterLabel(end),
      fiscalDateEnd:    end,
      revenue:          rev,
      grossProfit:      gp,
      grossMarginPct:   gm,
      operatingIncome:  op,
      operatingMarginPct: om,
      netIncome:        ni,
      eps,
      operatingCashFlow: cf,
      revenueYoY:       revYoY !== null ? `${parseFloat(revYoY) >= 0 ? '+' : ''}${revYoY}%` : null,
    };
  });
}

function firstNonEmpty(usGaap, concepts) {
  for (const c of concepts) {
    const vals = extractQuarterly({ 'us-gaap': usGaap }, 'us-gaap', c);
    if (vals.length > 0) return vals;
  }
  return [];
}

// ---------- Insights: 8-K press releases + news feed ----------

/**
 * Get recent 8-K filings for a CIK from the submissions JSON.
 * Returns array of { filingDate, accessionNumber, cik } sorted newest first.
 */
async function getEightKFilings(cik, limit = 20) {
  const paddedCik = String(cik).padStart(10, '0');
  const r = await httpsGet('data.sec.gov', `/submissions/CIK${paddedCik}.json`);
  if (r.status !== 200) return [];
  const data = JSON.parse(r.body);
  const { form, filingDate, accessionNumber } = data.filings.recent;

  const filings = [];
  for (let i = 0; i < form.length; i++) {
    if (form[i] === '8-K') {
      filings.push({ filingDate: filingDate[i], accessionNumber: accessionNumber[i] });
      if (filings.length >= limit) break;
    }
  }
  return filings; // already newest-first from SEC
}

/**
 * Given an accession number and CIK, find and fetch the EX-99.1 exhibit
 * (earnings press release). Returns cleaned plain text or null.
 */
async function fetchPressRelease(cik, accessionNumber) {
  try {
    const accClean = accessionNumber.replace(/-/g, '');
    const paddedCik = String(cik).padStart(10, '0').replace(/^0+/, ''); // non-padded for URL

    // Fetch the filing index page to discover document filenames
    const indexUrl = `/Archives/edgar/data/${paddedCik}/${accClean}/${accessionNumber}-index.htm`;
    const indexR = await httpsGet('www.sec.gov', indexUrl);
    if (indexR.status !== 200) return null;

    // Find EX-99.1 document link — it's the earnings press release
    const docMatch = indexR.body.match(
      /href="(\/Archives\/edgar\/data\/[^"]+\.htm)"[^>]*>[^<]*(?:EX-99\.1|Exhibit 99\.1|Press Release)/i
    );
    // Fallback: find any EX-99.1 label and get its corresponding href
    const ex991Match = indexR.body.match(/EX-99\.1[\s\S]*?href="(\/Archives\/edgar\/data\/[^"]+\.htm)"/i)
                    || indexR.body.match(/href="(\/Archives\/edgar\/data\/[^"]+\.htm)"[\s\S]{0,200}?EX-99\.1/i);

    const docPath = (docMatch && docMatch[1]) || (ex991Match && ex991Match[1]);
    if (!docPath) return null;

    // Fetch the actual press release HTML
    const docR = await httpsGet('www.sec.gov', docPath);
    if (docR.status !== 200) return null;

    return cleanPressReleaseHtml(docR.body);
  } catch (e) {
    return null;
  }
}

/**
 * Strip HTML from a press release document and return clean plain text.
 */
function cleanPressReleaseHtml(html) {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x2019;/g, "'")
    .replace(/&#x201[cC];/g, '\u201c')  // left double quote "
    .replace(/&#x201[dD];/g, '\u201d')  // right double quote "
    .replace(/&#x2013;/g, '\u2013')     // en dash –
    .replace(/&#x2014;/g, '\u2014')     // em dash —
    .replace(/&#x[0-9a-fA-F]+;/g, ' ') // remaining hex entities → space
    .replace(/&#\d+;/g, ' ')
    .replace(/\s{3,}/g, '\n')
    .trim();
}

/**
 * Extract structured insights from a press release text:
 * - Executive quotes (CEO/CFO/President)
 * - Key financial highlights sentences
 * - Forward guidance sentences
 */
function extractInsights(text) {
  if (!text) return { quotes: [], highlights: [], guidance: [] };

  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 30);

  const quotes = [];
  const highlights = [];
  const guidance = [];

  for (const line of lines) {
    // Skip boilerplate / forward-looking disclaimer paragraphs
    if (/forward.looking|safe harbor|private securities litigation|risk factor|10-K|10-Q|form 8-K/i.test(line)) continue;
    // Skip address / contact lines
    if (/\b(street|avenue|blvd|drive|road|cupertino|redmond|seattle|austin)\b/i.test(line) && line.length < 80) continue;

    // Executive quotes: contains "said" plus a title, and is wrapped in a sentence
    if (/\bsaid\b.*?\b(CEO|CFO|President|Chief Executive|Chief Financial|chairman|officer)\b|\b(CEO|CFO|President|Chief Executive|Chief Financial|chairman|officer)\b.*?\bsaid\b/i.test(line)) {
      if (line.length >= 60 && line.length <= 800) {
        quotes.push(line.replace(/\s+/g, ' '));
      }
    }

    // Financial highlights: revenue/profit/margin/EPS movement sentences
    if (/\b(revenue|sales|profit|margin|EPS|earnings per share|net income|operating income|cash flow)\b.*\b(grew|increased|decreased|declined|rose|fell|up|down|percent|%)\b/i.test(line)) {
      if (line.length >= 50 && line.length <= 500 && !/forward.looking/i.test(line)) {
        highlights.push(line.replace(/\s+/g, ' '));
      }
    }

    // Guidance / outlook sentences
    if (/\b(guidance|outlook|expect|forecast|anticipate|project|next quarter|fiscal year|full year|second quarter|third quarter)\b/i.test(line)
        && /\b(billion|million|percent|revenue|EPS|earnings|growth|range)\b/i.test(line)) {
      if (line.length >= 50 && line.length <= 500) {
        guidance.push(line.replace(/\s+/g, ' '));
      }
    }
  }

  return {
    quotes:     [...new Set(quotes)].slice(0, 4),
    highlights: [...new Set(highlights)].slice(0, 6),
    guidance:   [...new Set(guidance)].slice(0, 3),
  };
}

/**
 * Match an 8-K filing date to a quarterly financial period.
 * 8-K earnings releases are typically filed within 1–5 days of the quarter end.
 * We find the 8-K whose filing date falls within 75 days after a quarter end.
 */
function matchFilingToQuarter(filingDate, quarters) {
  const fd = new Date(filingDate);
  for (const q of quarters) {
    const qEnd = new Date(q.fiscalDateEnd);
    const diffDays = (fd - qEnd) / 86400000;
    // The earnings press release 8-K is filed 0–60 days after quarter end
    if (diffDays >= 0 && diffDays <= 60) return q.period;
  }
  return null;
}

/**
 * Fetch Yahoo Finance RSS news for a ticker.
 * Returns array of { title, description, link, pubDate }
 */
async function fetchYahooFinanceNews(ticker, maxItems = 15) {
  try {
    const rssUrl = `/rss/2.0/headline?s=${encodeURIComponent(ticker)}&region=US&lang=en-US`;
    const r = await httpsGet('feeds.finance.yahoo.com', rssUrl);
    if (r.status !== 200) return [];

    const items = [];
    for (const m of r.body.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
      const block = m[1];
      const titleM = block.match(/<title>(?:<!\[CDATA\[)?([^\]<]+)/);
      const descM  = block.match(/<description>(?:<!\[CDATA\[)?([^\]<]+)/);
      const linkM  = block.match(/<link>([^<\s]+)/);
      const dateM  = block.match(/<pubDate>([^<]+)/);
      if (titleM) {
        items.push({
          title:       titleM[1].trim(),
          description: descM  ? descM[1].trim().replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>') : '',
          link:        linkM  ? linkM[1].trim() : '',
          pubDate:     dateM  ? dateM[1].trim() : '',
        });
      }
      if (items.length >= maxItems) break;
    }
    return items;
  } catch {
    return [];
  }
}

/**
 * Fetch current quote for a ticker: latest price, previous close, change, change%.
 * Uses Yahoo Finance v8 chart API with a 1-day/1-minute interval so we get
 * the most recent trade price and the previousClose metadata.
 */
async function fetchCurrentQuote(ticker) {
  try {
    const p = `/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1m&range=1d&includePrePost=false`;
    const r = await httpsGet('query1.finance.yahoo.com', p);
    if (r.status !== 200) return null;

    const json   = JSON.parse(r.body);
    const result = json?.chart?.result?.[0];
    if (!result) return null;

    const meta    = result.meta || {};
    const current = meta.regularMarketPrice ?? meta.chartPreviousClose ?? null;
    const prev    = meta.previousClose      ?? meta.chartPreviousClose ?? null;
    if (current === null) return null;

    const change    = prev !== null ? parseFloat((current - prev).toFixed(2)) : null;
    const changePct = prev !== null ? parseFloat(((current - prev) / prev * 100).toFixed(2)) : null;

    return {
      price:     parseFloat(current.toFixed(2)),
      prevClose: prev !== null ? parseFloat(prev.toFixed(2)) : null,
      change,
      changePct,
      currency:  meta.currency || 'USD',
      marketState: meta.marketState || '',
    };
  } catch {
    return null;
  }
}

/**
 * Fetch historical daily close prices for a ticker from Yahoo Finance v8 chart API.
 * Returns an array of { date: 'YYYY-MM-DD', close: number } sorted oldest→newest.
 * numQuarters controls how far back to fetch (each quarter ≈ 91 days).
 */
async function fetchStockPrice(ticker, numQuarters = 8) {
  try {
    const range  = numQuarters <= 4  ? '1y'
                 : numQuarters <= 8  ? '2y'
                 : numQuarters <= 12 ? '3y'
                 : '5y';
    const path = `/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=${range}&events=div`;
    const r = await httpsGet('query1.finance.yahoo.com', path);
    if (r.status !== 200) return [];

    const json = JSON.parse(r.body);
    const result = json?.chart?.result?.[0];
    if (!result) return [];

    const timestamps = result.timestamp || [];
    const closes     = result.indicators?.quote?.[0]?.close || [];

    const prices = [];
    for (let i = 0; i < timestamps.length; i++) {
      const c = closes[i];
      if (c === null || c === undefined || isNaN(c)) continue;
      const d = new Date(timestamps[i] * 1000);
      const dateStr = d.toISOString().slice(0, 10);
      prices.push({ date: dateStr, close: parseFloat(c.toFixed(2)) });
    }
    return prices;
  } catch {
    return [];
  }
}

/**
 * Search the web for context about a specific price move using Serper.dev.
 * Returns an array of { title, url, snippet, source } (up to 3 results).
 */
async function searchWebForContext(query) {
  if (!SERPER_API_KEY) return [];
  try {
    const body = JSON.stringify({ q: query, num: 3 });
    const result = await new Promise((resolve, reject) => {
      const opts = {
        hostname: 'google.serper.dev',
        path:     '/search',
        method:   'POST',
        headers:  {
          'X-API-KEY':     SERPER_API_KEY,
          'Content-Type':  'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      };
      const req = https.request(opts, res => {
        let data = '';
        res.on('data', d => { data += d; });
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      });
      req.on('error', reject);
      req.setTimeout(8000, () => { req.destroy(new Error('timeout')); });
      req.write(body);
      req.end();
    });
    if (result.status === 200) {
      const json = JSON.parse(result.body);
      const items = json?.organic || [];
      console.log(`  [search] Serper HTTP 200 — items: ${items.length}`);
      return items.slice(0, 3).map(it => ({
        title:   it.title   || '',
        url:     it.link    || '',
        snippet: it.snippet || '',
        source:  'Serper (Google)',
      }));
    } else {
      console.warn(`  [search] Serper HTTP ${result.status}: ${result.body.slice(0, 200)}`);
    }
  } catch (e) {
    console.warn('Serper search error:', e.message);
  }
  return [];
}

/**
 * Price drivers: detect significant single-day price moves (≥ threshold%) and
 * annotate each event with the nearest news headline, earnings quarter, and
 * Google web-search context.
 * Returns { ticker, searchSource, moves: [{ date, close, prevClose, changePct, label, headline, headlineLink, webResults }] }
 */
async function buildPriceDrivers(ticker, prices, news, quarters, threshold = 4) {
  if (!prices || prices.length < 2) return { ticker, moves: [], searchSource: null };

  // Build a map of date → news headline for quick lookup
  const newsMap = {};
  for (const item of (news || [])) {
    try {
      const d = new Date(item.pubDate);
      if (isNaN(d)) continue;
      const key = d.toISOString().slice(0, 10);
      if (!newsMap[key]) newsMap[key] = item;
    } catch { /* skip */ }
  }

  // Build a map of quarter fiscalDateEnd → period label
  const quarterMap = {};
  for (const q of (quarters || [])) {
    if (q.fiscalDateEnd) quarterMap[q.fiscalDateEnd] = q.period;
  }

  // Compute daily % changes and find significant moves
  const moves = [];
  for (let i = 1; i < prices.length; i++) {
    const prev  = prices[i - 1].close;
    const curr  = prices[i].close;
    if (!prev || !curr) continue;
    const changePct = parseFloat(((curr - prev) / prev * 100).toFixed(2));
    if (Math.abs(changePct) < threshold) continue;

    const date = prices[i].date;

    // Look for a Yahoo Finance news headline within ±2 days of this move
    let headline = null, headlineLink = null;
    for (let offset = 0; offset <= 2; offset++) {
      for (const delta of (offset === 0 ? [0] : [-offset, offset])) {
        const lookup = new Date(date);
        lookup.setDate(lookup.getDate() + delta);
        const key = lookup.toISOString().slice(0, 10);
        if (newsMap[key]) {
          headline     = newsMap[key].title;
          headlineLink = newsMap[key].link || null;
          break;
        }
      }
      if (headline) break;
    }

    // Check if this date is near an earnings fiscal end date (within 5 days)
    let earningsLabel = null;
    for (const [fiscalEnd, period] of Object.entries(quarterMap)) {
      const d1 = new Date(date), d2 = new Date(fiscalEnd);
      if (isNaN(d2)) continue;
      if (Math.abs(d1 - d2) <= 5 * 24 * 60 * 60 * 1000) {
        earningsLabel = `${period} earnings`;
        break;
      }
    }

    moves.push({
      date,
      close:       curr,
      prevClose:   prev,
      changePct,
      label:       earningsLabel || null,
      headline:    headline || null,
      headlineLink,
      webResults:  [],   // filled in below
    });
  }

  // Sort by absolute magnitude descending, keep top 10
  moves.sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct));
  const top = moves.slice(0, 10);

  // ── Web-search grounding (Serper) ────────────────────────
  // Only fire if key is configured; serialise to respect rate limits
  let searchSource = null;
  if (SERPER_API_KEY) {
    for (const move of top) {
      const direction = move.changePct >= 0 ? 'surge' : 'drop';
      const query = `${ticker} stock ${direction} ${move.date} why reason`;
      try {
        const results = await searchWebForContext(query);
        move.webResults = results;
        if (results.length && !searchSource) searchSource = results[0].source;
      } catch { /* non-fatal */ }
    }
  }

  return { ticker, searchSource, moves: top };
}

/**
 * Main insights orchestrator.
 * Returns { pressReleases: { [period]: { quotes, highlights, guidance, filingDate } }, news: [...] }
 */
async function buildInsights(cik, ticker, quarters) {
  // Step 1: Get 8-K filings list
  const filings = await getEightKFilings(cik, 30);

  // Step 2: Match each 8-K to a quarter, fetch press release for matched ones
  const pressReleases = {};
  const matchedFilings = [];

  for (const filing of filings) {
    const period = matchFilingToQuarter(filing.filingDate, quarters);
    if (period && !pressReleases[period]) {
      matchedFilings.push({ ...filing, period });
      pressReleases[period] = { filingDate: filing.filingDate, loading: true };
    }
  }

  // Fetch press releases in parallel (limit to avoid hammering SEC)
  const fetched = await Promise.allSettled(
    matchedFilings.map(async f => {
      const text = await fetchPressRelease(cik, f.accessionNumber);
      const insights = extractInsights(text);
      return { period: f.period, filingDate: f.filingDate, accessionNumber: f.accessionNumber, ...insights };
    })
  );

  for (const r of fetched) {
    if (r.status === 'fulfilled' && r.value) {
      const { period, ...rest } = r.value;
      pressReleases[period] = rest;
    }
  }

  // Step 3: Fetch news articles for the ticker
  const news = ticker ? await fetchYahooFinanceNews(ticker) : [];

  return { pressReleases, news };
}

// ---------- Request router ----------

const PUBLIC_DIR = path.join(__dirname, 'public');

const server = http.createServer(async (req, res) => {
  const parsed   = new URL(req.url, 'http://localhost');
  const pathname = parsed.pathname;

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  // ── API: company search ──────────────────────────────────────
  if (pathname === '/api/search') {
    const q = (parsed.searchParams.get('q') || '').trim();
    if (q.length < 1) { send(res, 400, { error: 'Missing q param' }); return; }
    try {
      const results = await edgarSearch(q);
      send(res, 200, { results });
    } catch (e) {
      console.error('Search error:', e.message);
      send(res, 500, { error: e.message });
    }
    return;
  }

  // ── API: financials ──────────────────────────────────────────
  if (pathname === '/api/financials') {
    const cik = (parsed.searchParams.get('cik') || '').trim().replace(/^0+/, '');
    const n   = Math.min(12, Math.max(4, parseInt(parsed.searchParams.get('n') || '8', 10)));
    if (!cik) { send(res, 400, { error: 'Missing cik param' }); return; }
    try {
      const facts   = await fetchCompanyFacts(cik);
      const summary = buildQuarterlySummary(facts, n);
      if (!summary.length) {
        send(res, 404, { error: 'No quarterly revenue data found for this company in SEC XBRL filings.' });
        return;
      }
      send(res, 200, {
        company:  facts.entityName || '',
        cik:      String(facts.cik || cik),
        summary,
      });
    } catch (e) {
      console.error('Financials error:', e.message);
      send(res, 500, { error: e.message });
    }
    return;
  }

  // ── API: current quote ───────────────────────────────────────
  if (pathname === '/api/quote') {
    const ticker = (parsed.searchParams.get('ticker') || '').trim().toUpperCase();
    if (!ticker) { send(res, 400, { error: 'Missing ticker param' }); return; }
    try {
      const quote = await fetchCurrentQuote(ticker);
      if (!quote) { send(res, 404, { error: 'No quote data found' }); return; }
      send(res, 200, quote);
    } catch (e) {
      console.error('Quote error:', e.message);
      send(res, 500, { error: e.message });
    }
    return;
  }

  // ── API: stock price history ─────────────────────────────────
  if (pathname === '/api/stockprice') {
    const ticker = (parsed.searchParams.get('ticker') || '').trim().toUpperCase();
    const n      = Math.min(12, Math.max(4, parseInt(parsed.searchParams.get('n') || '8', 10)));
    if (!ticker) { send(res, 400, { error: 'Missing ticker param' }); return; }
    try {
      const prices = await fetchStockPrice(ticker, n);
      send(res, 200, { ticker, prices });
    } catch (e) {
      console.error('Stock price error:', e.message);
      send(res, 500, { error: e.message });
    }
    return;
  }

  // ── API: insights (press releases + news) ────────────────────
  if (pathname === '/api/insights') {
    const cik    = (parsed.searchParams.get('cik') || '').trim().replace(/^0+/, '');
    const ticker = (parsed.searchParams.get('ticker') || '').trim().toUpperCase();
    // periods is a comma-separated list of quarter labels from the financials response
    // e.g. "Q1 2026,Q4 2025,Q3 2025"
    const periodsRaw = (parsed.searchParams.get('periods') || '').trim();
    if (!cik) { send(res, 400, { error: 'Missing cik param' }); return; }

    // We need the quarters array to match 8-K dates to periods.
    // Re-fetch the financial summary to get fiscalDateEnd values.
    try {
      const facts   = await fetchCompanyFacts(cik);
      const summary = buildQuarterlySummary(facts, 12); // fetch up to 12 to have range

      // Filter to the requested periods if provided
      const wantedPeriods = periodsRaw
        ? new Set(periodsRaw.split(',').map(s => s.trim()))
        : null;
      const quarters = wantedPeriods
        ? summary.filter(q => wantedPeriods.has(q.period))
        : summary;

      const insights = await buildInsights(cik, ticker, quarters);
      send(res, 200, insights);
    } catch (e) {
      console.error('Insights error:', e.message);
      send(res, 500, { error: e.message });
    }
    return;
  }

  // ── API: price drivers ───────────────────────────────────────
  if (pathname === '/api/pricedrivers') {
    const ticker = (parsed.searchParams.get('ticker') || '').trim().toUpperCase();
    const cik    = (parsed.searchParams.get('cik')    || '').trim().replace(/^0+/, '');
    const n      = Math.min(12, Math.max(4, parseInt(parsed.searchParams.get('n') || '8', 10)));
    if (!ticker) { send(res, 400, { error: 'Missing ticker param' }); return; }
    try {
      const [prices, news, facts] = await Promise.all([
        fetchStockPrice(ticker, n),
        fetchYahooFinanceNews(ticker, 50),   // wider net for date matching
        cik ? fetchCompanyFacts(cik) : null,
      ]);
      const quarters = facts ? buildQuarterlySummary(facts, n) : [];
      const result   = await buildPriceDrivers(ticker, prices, news, quarters);
      send(res, 200, result);
    } catch (e) {
      console.error('Price drivers error:', e.message);
      send(res, 500, { error: e.message });
    }
    return;
  }

  // ── API: resolve CIK info ────────────────────────────────────
  if (pathname === '/api/resolve') {
    const cik = (parsed.searchParams.get('cik') || '').trim();
    if (!cik) { send(res, 400, { error: 'Missing cik' }); return; }
    try {
      const info = await resolveSubmission(cik);
      send(res, 200, info || { error: 'Not found' });
    } catch (e) {
      send(res, 500, { error: e.message });
    }
    return;
  }

  // ── Static files ─────────────────────────────────────────────
  let filePath = pathname === '/' ? '/index.html' : pathname;
  filePath = path.join(PUBLIC_DIR, filePath);

  // Security: prevent path traversal
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); res.end('Forbidden');
    return;
  }

  sendFile(res, filePath);
});

server.listen(PORT, () => {
  console.log(`\n  ┌───────────────────────────────────────┐`);
  console.log(`  │  EarningsIQ running on                │`);
  console.log(`  │  http://localhost:${PORT}               │`);
  console.log(`  └───────────────────────────────────────┘\n`);
});
