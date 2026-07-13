
// ============================================================
// State
// ============================================================
let selectedCompany = null;   // { cik, ticker, name }
let searchTimer = null;

// ============================================================
// Utilities
// ============================================================
function fmt(val, decimals = 1) {
  if (val === null || val === undefined) return '—';
  const abs = Math.abs(val);
  if (abs >= 1e12) return '$' + (val / 1e12).toFixed(decimals) + 'T';
  if (abs >= 1e9)  return '$' + (val / 1e9).toFixed(decimals) + 'B';
  if (abs >= 1e6)  return '$' + (val / 1e6).toFixed(decimals) + 'M';
  return '$' + val.toLocaleString();
}

function fmtPct(val) {
  if (val === null || val === undefined) return '—';
  return val.toFixed(1) + '%';
}

function fmtEps(val) {
  if (val === null || val === undefined) return '—';
  return '$' + val.toFixed(2);
}

function pctClass(str) {
  if (!str) return '';
  return str.startsWith('+') ? 'pos' : str.startsWith('-') ? 'neg' : '';
}

function trend(quarters, field) {
  const vals = quarters.map(q => q[field]).filter(v => v !== null && v !== undefined);
  if (vals.length < 2) return 'insufficient data';
  const first4 = vals.slice(0, Math.floor(vals.length / 2));
  const last4  = vals.slice(Math.floor(vals.length / 2));
  const avg = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
  const delta = avg(last4) - avg(first4);
  const pct = (delta / Math.abs(avg(first4))) * 100;
  if (pct >  5) return 'growing';
  if (pct < -5) return 'declining';
  return 'stable';
}

// ============================================================
// Search
// ============================================================
const input = document.getElementById('search-input');
const dropdown = document.getElementById('dropdown');

input.addEventListener('input', () => {
  clearTimeout(searchTimer);
  const q = input.value.trim();
  if (q.length < 2) { closeDropdown(); return; }
  searchTimer = setTimeout(() => fetchSuggestions(q), 220);
});

input.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeDropdown();
  if (e.key === 'Enter') triggerSearch();
});

document.addEventListener('click', e => {
  if (!e.target.closest('.search-wrap')) closeDropdown();
});

async function fetchSuggestions(q) {
  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
    const data = await res.json();
    renderDropdown(data.results || []);
  } catch {
    closeDropdown();
  }
}

function renderDropdown(results) {
  if (!results.length) { closeDropdown(); return; }
  dropdown.innerHTML = '';
  for (const r of results) {
    const ticker = (r.tickers && r.tickers.length) ? r.tickers[0] : (r.ticker || '');
    const exch   = (r.exchanges && r.exchanges.length) ? r.exchanges[0] : '';
    const div = document.createElement('div');
    div.className = 'dropdown-item';
    div.innerHTML = `<span class="di-ticker">${escHtml(ticker || r.cik)}</span><span class="di-name">${escHtml(r.name)}<span class="di-exch">${escHtml(exch)}</span></span>`;
    div.addEventListener('click', () => selectCompany(r));
    dropdown.appendChild(div);
  }
  dropdown.classList.add('open');
}

function selectCompany(r) {
  const ticker = (r.tickers && r.tickers.length) ? r.tickers[0] : (r.ticker || r.cik);
  selectedCompany = { cik: r.cik, ticker, name: r.name };
  input.value = `${ticker} — ${r.name}`;
  closeDropdown();
}

function closeDropdown() {
  dropdown.classList.remove('open');
}

function escHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ============================================================
// Quick launch
// ============================================================
function quickLaunch(ticker, cik, name) {
  selectedCompany = { cik, ticker, name };
  input.value = `${ticker} — ${name}`;
  triggerSearch();
}

// ============================================================
// Main analysis trigger
// ============================================================
async function triggerSearch() {
  if (!selectedCompany) {
    // Try to resolve via search
    const q = input.value.trim();
    if (q.length < 1) return;
    showLoading('Searching for ' + escHtml(q) + '…');
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      if (data.results && data.results.length === 1) {
        selectedCompany = data.results[0];
      } else if (data.results && data.results.length > 1) {
        renderDropdown(data.results);
        showStatus('Multiple companies found — please select one from the dropdown.');
        return;
      } else {
        showStatus('No matching companies found. Try a ticker symbol like AAPL or MSFT.');
        return;
      }
    } catch (e) {
      showStatus('Search failed: ' + e.message);
      return;
    }
  }

  const numQ = parseInt(document.getElementById('quarters-select').value, 10);
  await loadReport(selectedCompany, numQ);
}

// ============================================================
// Load report
// ============================================================
async function loadReport(company, numQ) {
  showLoading(`Loading ${numQ}-quarter data for <strong>${escHtml(company.name)}</strong>…`);
  document.getElementById('search-btn').disabled = true;

  try {
    const res = await fetch(`/api/financials?cik=${encodeURIComponent(company.cik)}&n=${numQ}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    renderReport(company, data.summary);
  } catch (e) {
    showStatus('Failed to load data: ' + e.message + '<br><small>Make sure the server is running at localhost:3737</small>');
  } finally {
    document.getElementById('search-btn').disabled = false;
  }
}

// ============================================================
// Render report
// ============================================================
function renderReport(company, quarters) {
  if (!quarters || !quarters.length) {
    showStatus('No quarterly data available for this company.');
    return;
  }

  const latest = quarters[quarters.length - 1];
  const prev4  = quarters.slice(-5, -1);
  const latestRev = latest.revenue;
  const latestGM  = latest.grossMarginPct;
  const latestEPS = latest.eps;
  const latestCF  = latest.operatingCashFlow;

  // YoY for KPIs
  const yoyRev = latest.revenueYoY;
  const revTrend = trend(quarters, 'revenue');
  const gmTrend  = trend(quarters, 'grossMarginPct');
  const cfTrend  = trend(quarters, 'operatingCashFlow');
  const epsTrend = trend(quarters, 'eps');

  const periodRange = quarters.length >= 2
    ? `${quarters[0].period} – ${latest.period}`
    : latest.period;

  // Build header HTML
  let html = `
    <div class="company-header">
      <div class="company-header-left">
        <div class="company-name">${escHtml(company.name)}</div>
        <div class="company-ticker">${escHtml(company.ticker)}</div>
      </div>
      <div class="company-quote" id="company-quote-widget">
        <div class="quote-price" style="color:var(--muted);font-size:13px">Loading…</div>
      </div>
    </div>
    <div class="report-meta">
      ${quarters.length}-Quarter Financial Performance &nbsp;|&nbsp; ${periodRange}
      &nbsp;|&nbsp; Source: SEC EDGAR XBRL
    </div>
  `;

  // KPI grid
  html += `<div class="kpi-grid">`;
  html += kpiCard('Latest Revenue', fmt(latestRev), yoyRev);
  html += kpiCard('Gross Margin', fmtPct(latestGM), null, `Trend: ${gmTrend}`);
  html += kpiCard('Diluted EPS', fmtEps(latestEPS), null, `Trend: ${epsTrend}`);
  html += kpiCard('Oper. Cash Flow', fmt(latestCF), null, `Trend: ${cfTrend}`);
  html += `</div>`;

  // Income statement table
  html += `<div class="section-title">1 · Income Statement — ${quarters.length}-Quarter Trend</div>`;
  html += buildIncomeTable(quarters);

  // Charts
  html += `<div class="section-title">2 · Revenue & Margin Charts</div>`;
  html += `<div class="chart-tabs" id="chart-tabs">
    <button class="chart-tab active" onclick="switchChart('revenue',this)">Revenue</button>
    <button class="chart-tab" onclick="switchChart('grossMarginPct',this)">Gross Margin %</button>
    <button class="chart-tab" onclick="switchChart('operatingMarginPct',this)">Op. Margin %</button>
    <button class="chart-tab" onclick="switchChart('eps',this)">EPS</button>
    <button class="chart-tab" onclick="switchChart('operatingCashFlow',this)">Op. Cash Flow</button>
    <button class="chart-tab" id="stock-price-tab" onclick="switchChart('stockPrice',this)">Stock Price</button>
  </div>`;
  html += buildAllCharts(quarters);
  html += `<div id="chart-stockPrice" class="chart-wrap" style="display:none">
    <div class="chart-title">Stock Price (Daily Close)</div>
    <div id="stock-price-chart-inner" style="color:var(--muted);font-size:12px;padding:12px 0">Loading stock price data…</div>
  </div>`;

  // Cash flow table
  html += `<div class="section-title">3 · Cash Flow & Profitability</div>`;
  html += buildCashTable(quarters);

  // Commentary
  html += `<div class="section-title">4 · Trend Analysis & Commentary</div>`;
  html += buildCommentary(company, quarters, revTrend, gmTrend, cfTrend, epsTrend);

  // Insights placeholder — filled in asynchronously after main render
  html += `<div class="section-title" id="insights-section-title" style="display:none">5 · Company Statements & News</div>`;
  html += `<div id="insights-panel">
    <div class="insights-loading" id="insights-loading">
      <span class="insights-spinner"></span>
      Loading press releases and news articles from SEC EDGAR &amp; Yahoo Finance…
    </div>
  </div>`;

  // Price drivers placeholder — filled in asynchronously after main render
  html += `<div class="section-title" id="pricedrivers-section-title" style="display:none">6 · Significant Price Moves & Drivers</div>`;
  html += `<div id="pricedrivers-panel">
    <div class="insights-loading" id="pricedrivers-loading">
      <span class="insights-spinner"></span>
      Analysing significant price moves…
    </div>
  </div>`;

  html += `<div class="disclaimer">
    <strong>Data Sources:</strong> Financial data: SEC EDGAR XBRL Company Facts API (data.sec.gov).
    Press releases: SEC EDGAR 8-K filings (EX-99.1 exhibits). News: Yahoo Finance RSS.
    Figures may differ from press release summaries due to restatements or XBRL tagging differences.
    This analysis is for informational purposes only — not investment advice.
    Always verify against the company's official SEC filings.
  </div>
  <footer>Made with IBM Bob &nbsp;·&nbsp; EarningsIQ &nbsp;·&nbsp; Data: SEC EDGAR &amp; Yahoo Finance</footer>`;

  document.getElementById('report').innerHTML = html;
  document.getElementById('report').style.display = 'block';
  document.getElementById('status-box').style.display = 'none';

  // Show revenue chart by default
  showChart('revenue');

  // Async: load current quote into header (fires first for fast display)
  loadCurrentQuote(company);

  // Async: load stock price chart (fires independently from insights)
  loadStockPrice(company, quarters.length);

  // Async: load insights after the main report renders
  loadInsights(company, quarters);

  // Async: load price drivers after the main report renders
  loadPriceDrivers(company, quarters);
}

// ============================================================
// Current quote — async fetch + inject into header
// ============================================================
async function loadCurrentQuote(company) {
  const widget = document.getElementById('company-quote-widget');
  if (!widget || !company.ticker) return;

  try {
    const r = await fetch(`/api/quote?ticker=${encodeURIComponent(company.ticker)}`);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const q = await r.json();
    if (q.error) throw new Error(q.error);

    const up      = q.change >= 0;
    const sign    = up ? '+' : '';
    const color   = up ? 'var(--pos)' : 'var(--neg)';
    const arrow   = up ? '▲' : '▼';
    const stateLabel = q.marketState === 'PRE'  ? ' Pre-market'
                     : q.marketState === 'POST' ? ' After-hours'
                     : q.marketState === 'CLOSED' ? ' Closed'
                     : '';

    widget.innerHTML = `
      <div class="quote-price" style="color:${color}">$${q.price.toFixed(2)}</div>
      <div class="quote-change" style="color:${color}">
        ${arrow} ${sign}${q.change !== null ? q.change.toFixed(2) : '—'}
        &nbsp;(${sign}${q.changePct !== null ? q.changePct.toFixed(2) : '—'}%)
        ${stateLabel ? `<span class="quote-market-state">${escHtml(stateLabel)}</span>` : ''}
      </div>`;
  } catch {
    widget.innerHTML = '';   // silently hide if quote unavailable
  }
}

// ============================================================
// Stock price chart — async fetch + render
// ============================================================
async function loadStockPrice(company, numQ) {
  const inner = document.getElementById('stock-price-chart-inner');
  if (!inner || !company.ticker) return;

  try {
    const r = await fetch(`/api/stockprice?ticker=${encodeURIComponent(company.ticker)}&n=${numQ}`);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    if (!data.prices || !data.prices.length) {
      inner.innerHTML = '<div style="color:var(--muted);font-size:12px;padding:12px 0">No stock price data available for this ticker.</div>';
      return;
    }
    inner.innerHTML = buildStockPriceSvg(data.prices, company.ticker);
  } catch (e) {
    inner.innerHTML = `<div style="color:var(--muted);font-size:12px;padding:12px 0">Could not load stock price: ${escHtml(e.message)}</div>`;
  }
}

function buildStockPriceSvg(prices, ticker) {
  // Thin data to at most 200 points for clean rendering
  const maxPts = 200;
  let pts = prices;
  if (pts.length > maxPts) {
    const step = pts.length / maxPts;
    pts = Array.from({ length: maxPts }, (_, i) => pts[Math.round(i * step)]);
  }

  const closes = pts.map(p => p.close);
  const minVal = Math.min(...closes);
  const maxVal = Math.max(...closes);
  const range  = maxVal - minVal || 1;

  const W = 760, H = 180, PAD_L = 52, PAD_R = 12, PAD_T = 28, PAD_B = 32;
  const chartW = W - PAD_L - PAD_R;
  const chartH = H - PAD_T - PAD_B;
  const n = pts.length;

  // Y scale with headroom
  const yMin  = minVal - range * 0.06;
  const yMax  = maxVal + range * 0.06;
  const yRng  = yMax - yMin;

  function xCoord(i) { return PAD_L + (i / (n - 1)) * chartW; }
  function yCoord(v) { return PAD_T + chartH - ((v - yMin) / yRng) * chartH; }

  // Y-axis: 4 labels
  const yLabels = [];
  for (let i = 0; i <= 3; i++) {
    const v = yMin + (yRng / 3) * i;
    const y = yCoord(v);
    yLabels.push({ v, y });
  }

  let svg = '';

  // Grid lines
  for (const lbl of yLabels) {
    svg += `<line x1="${PAD_L}" y1="${lbl.y.toFixed(1)}" x2="${W - PAD_R}" y2="${lbl.y.toFixed(1)}" stroke="#e5e7eb" stroke-width="1"/>`;
    svg += `<text x="${(PAD_L - 4).toFixed(1)}" y="${(lbl.y + 4).toFixed(1)}" text-anchor="end" font-size="9" fill="#57606a">$${lbl.v.toFixed(0)}</text>`;
  }

  // Area fill (gradient via polygon)
  const polyPoints = pts.map((p, i) => `${xCoord(i).toFixed(1)},${yCoord(p.close).toFixed(1)}`).join(' ');
  const baseY = (PAD_T + chartH).toFixed(1);
  svg += `<polygon points="${xCoord(0).toFixed(1)},${baseY} ${polyPoints} ${xCoord(n-1).toFixed(1)},${baseY}" fill="#3b82d4" opacity="0.08"/>`;

  // Price line
  svg += `<polyline points="${polyPoints}" fill="none" stroke="#3b82d4" stroke-width="1.8"/>`;

  // Start / End price dots and labels
  const startPt = pts[0];
  const endPt   = pts[pts.length - 1];
  const pctChg  = ((endPt.close - startPt.close) / startPt.close) * 100;
  const pctStr  = (pctChg >= 0 ? '+' : '') + pctChg.toFixed(1) + '%';
  const pctCol  = pctChg >= 0 ? '#2e7d32' : '#c62828';

  svg += `<circle cx="${xCoord(0).toFixed(1)}" cy="${yCoord(startPt.close).toFixed(1)}" r="3.5" fill="#3b82d4"/>`;
  svg += `<circle cx="${xCoord(n-1).toFixed(1)}" cy="${yCoord(endPt.close).toFixed(1)}" r="4" fill="${pctCol}"/>`;

  // End label
  const endX = xCoord(n - 1);
  const endY = yCoord(endPt.close);
  svg += `<text x="${(endX - 5).toFixed(1)}" y="${(endY - 8).toFixed(1)}" text-anchor="end" font-size="9.5" font-weight="700" fill="${pctCol}">$${endPt.close.toFixed(2)} (${pctStr})</text>`;

  // X-axis: show ~6 evenly spaced date labels
  const xLabelCount = 6;
  for (let i = 0; i < xLabelCount; i++) {
    const idx = Math.round((i / (xLabelCount - 1)) * (n - 1));
    const x   = xCoord(idx);
    const lbl = pts[idx].date.slice(0, 7); // YYYY-MM
    svg += `<text x="${x.toFixed(1)}" y="${(H - 4)}" text-anchor="middle" font-size="9" fill="#57606a">${escHtml(lbl)}</text>`;
  }

  // Period change badge (top-right of chart)
  svg += `<text x="${(W - PAD_R - 2).toFixed(1)}" y="${PAD_T - 8}" text-anchor="end" font-size="10" font-weight="600" fill="${pctCol}">${pctStr} period</text>`;

  return `<svg class="chart" viewBox="0 0 ${W} ${H}" aria-label="Stock price chart for ${escHtml(ticker)}">${svg}</svg>
    <div style="font-size:11px;color:var(--muted);margin-top:5px">
      ${escHtml(startPt.date)} – ${escHtml(endPt.date)} &nbsp;·&nbsp; Daily closing price &nbsp;·&nbsp; Source: Yahoo Finance
    </div>`;
}

// ============================================================
// Insights: async load press releases + news
// ============================================================
async function loadInsights(company, quarters) {
  const insightsPanel = document.getElementById('insights-panel');
  const sectionTitle  = document.getElementById('insights-section-title');
  if (!insightsPanel) return;

  const periods = quarters.map(q => q.period).join(',');
  const ticker  = company.ticker || '';
  const cik     = company.cik;

  try {
    const r = await fetch(
      `/api/insights?cik=${encodeURIComponent(cik)}&ticker=${encodeURIComponent(ticker)}&periods=${encodeURIComponent(periods)}`
    );
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();

    if (sectionTitle) sectionTitle.style.display = '';
    insightsPanel.innerHTML = buildInsightsHtml(quarters, data, company.ticker);
  } catch (e) {
    insightsPanel.innerHTML = `<div class="pr-empty">Could not load insights: ${escHtml(e.message)}. Check that the server is running.</div>`;
  }
}


// ============================================================
// Price drivers — async fetch + inject
// ============================================================
async function loadPriceDrivers(company, quarters) {
  const panel       = document.getElementById('pricedrivers-panel');
  const sectionTitle = document.getElementById('pricedrivers-section-title');
  if (!panel) return;

  const ticker = company.ticker || '';
  const cik    = company.cik    || '';
  const n      = quarters.length || 8;

  try {
    const r = await fetch(
      `/api/pricedrivers?ticker=${encodeURIComponent(ticker)}&cik=${encodeURIComponent(cik)}&n=${n}`
    );
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();

    if (sectionTitle) sectionTitle.style.display = '';
    panel.innerHTML = buildPriceDriversHtml(data, company);
  } catch (e) {
    if (sectionTitle) sectionTitle.style.display = '';
    panel.innerHTML = `<div class="pr-empty">Could not load price driver analysis: ${escHtml(e.message)}.</div>`;
  }
}

function buildPriceDriversHtml(data, company) {
  const { moves = [], ticker, searchSource } = data;

  if (!moves.length) {
    return `<div class="pr-empty">No significant single-day price moves (≥ 4%) detected in the selected period for ${escHtml(ticker)}.</div>`;
  }

  // Sort chronologically for display
  const sorted = moves.slice().sort((a, b) => a.date < b.date ? -1 : 1);

  // Search source badge
  const sourceBadge = searchSource
    ? `<span class="pd-source-badge">${escHtml(searchSource)}</span>`
    : `<span class="pd-source-badge pd-source-none">No web search key configured — add SERPER_API_KEY to .env</span>`;

  let html = `<div style="font-size:13px;color:var(--muted);margin-bottom:12px">
    Showing the <strong>top ${moves.length}</strong> largest single-day price moves (by magnitude)
    detected over the analysis window for <strong>${escHtml(company.name)} (${escHtml(ticker)})</strong>.
    Yahoo Finance headlines (±2 days) and web-search context ${sourceBadge} are shown where available.
    <em>Correlation only — not causation. Verify with official filings and press releases.</em>
  </div>`;

  for (const m of sorted) {
    const isUp  = m.changePct >= 0;
    const sign  = isUp ? '+' : '';
    const cls   = isUp ? 'pos' : 'neg';
    const arrow = isUp ? '▲' : '▼';
    const moveTag = isUp
      ? `<span class="tag tag-up">${arrow} UP</span>`
      : `<span class="tag tag-dn">${arrow} DOWN</span>`;

    // ── Primary context line (earnings badge + Yahoo headline) ──
    let primaryCtx = '';
    if (m.label) {
      primaryCtx += `<span class="pd-earnings-badge">${escHtml(m.label)}</span> `;
    }
    if (m.headline) {
      primaryCtx += m.headlineLink
        ? `<a href="${escHtml(m.headlineLink)}" target="_blank" rel="noopener" class="pd-headline">${escHtml(m.headline)}</a>`
        : `<span class="pd-headline">${escHtml(m.headline)}</span>`;
    }

    // ── Web search results ──
    let webHtml = '';
    if (m.webResults && m.webResults.length) {
      webHtml += `<div class="pd-web-results">`;
      for (const w of m.webResults) {
        const domain = (() => { try { return new URL(w.url).hostname.replace(/^www\./, ''); } catch { return ''; } })();
        webHtml += `<div class="pd-web-item">
          <div class="pd-web-title">
            ${w.url
              ? `<a href="${escHtml(w.url)}" target="_blank" rel="noopener">${escHtml(w.title)}</a>`
              : escHtml(w.title)}
            ${domain ? `<span class="pd-web-domain">${escHtml(domain)}</span>` : ''}
          </div>
          ${w.snippet ? `<div class="pd-web-snippet">${escHtml(w.snippet)}</div>` : ''}
        </div>`;
      }
      webHtml += `</div>`;
    }

    html += `<div class="pd-move-card ${isUp ? 'pd-move-up' : 'pd-move-dn'}">
      <div class="pd-move-header">
        <span class="pd-move-date">${escHtml(m.date)}</span>
        <span class="pd-move-pct ${cls}">${moveTag} ${sign}${m.changePct.toFixed(2)}%</span>
        <span class="pd-move-price">$${m.close.toFixed(2)} <span class="pd-move-prev">(prev $${m.prevClose.toFixed(2)})</span></span>
      </div>
      ${primaryCtx ? `<div class="pd-primary-ctx">${primaryCtx}</div>` : ''}
      ${webHtml}
      ${!primaryCtx && !webHtml ? `<div class="pd-no-ctx">No context found for this date</div>` : ''}
    </div>`;
  }

  return html;
}


function buildInsightsHtml(quarters, data, ticker) {
  const { pressReleases = {}, news = [] } = data;
  const periodsWithData = quarters.map(q => q.period);

  let html = '';

  // ── A. Press release tabs ──
  const hasAnyPR = periodsWithData.some(p => pressReleases[p] && (
    pressReleases[p].quotes?.length || pressReleases[p].highlights?.length
  ));

  if (hasAnyPR) {
    html += `<div style="margin-bottom:24px">`;
    html += `<div style="font-size:13px;color:var(--muted);margin-bottom:10px">
      <strong>Official Company Statements</strong> — sourced from SEC EDGAR 8-K earnings press releases (EX-99.1 exhibits).
      Select a quarter to view executive quotes, financial highlights, and forward guidance as stated by the company.
    </div>`;

    // Tabs
    html += `<div class="period-tabs" id="pr-tabs">`;
    periodsWithData.forEach((period, i) => {
      const pr = pressReleases[period];
      const hasData = pr && (pr.quotes?.length || pr.highlights?.length);
      const cls = hasData ? 'has-data' : 'no-data';
      const activeCls = i === periodsWithData.length - 1 && hasData ? ' active' : '';  // default to latest
      html += `<button class="period-tab ${cls}${activeCls}" onclick="switchPrPanel('${escHtml(period)}', this)" data-period="${escHtml(period)}">${escHtml(period)}</button>`;
    });
    html += `</div>`;

    // Panels
    periodsWithData.forEach((period, i) => {
      const pr = pressReleases[period];
      const isLatestWithData = i === periodsWithData.length - 1 && pr && (pr.quotes?.length || pr.highlights?.length);
      const visibleCls = isLatestWithData ? ' visible' : '';
      html += `<div class="pr-panel${visibleCls}" id="pr-panel-${escHtml(period)}">`;

      if (!pr || (!pr.quotes?.length && !pr.highlights?.length && !pr.guidance?.length)) {
        html += `<div class="pr-empty">No press release found in SEC EDGAR for this quarter. The company may not have filed an 8-K earnings release for this period, or the EX-99.1 exhibit was not available in HTML format.</div>`;
      } else {
        const secLink = pr.accessionNumber
          ? `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${encodeURIComponent(data._cik||'')}&type=8-K&dateb=&owner=include&count=10`
          : null;

        if (pr.filingDate) {
          html += `<div class="pr-meta">8-K filed on <strong>${escHtml(pr.filingDate)}</strong> — SEC EDGAR EX-99.1 press release</div>`;
        }

        if (pr.quotes?.length) {
          html += `<div class="pr-block"><div class="pr-block-title">Executive Statements</div>`;
          for (const q of pr.quotes) {
            html += `<div class="pr-quote">${escHtml(q)}</div>`;
          }
          html += `</div>`;
        }

        if (pr.highlights?.length) {
          html += `<div class="pr-block"><div class="pr-block-title">Financial Highlights from Press Release</div>`;
          for (const h of pr.highlights) {
            html += `<div class="pr-highlight">${escHtml(h)}</div>`;
          }
          html += `</div>`;
        }

        if (pr.guidance?.length) {
          html += `<div class="pr-block"><div class="pr-block-title">Forward Guidance &amp; Outlook</div>`;
          for (const g of pr.guidance) {
            html += `<div class="pr-guidance">${escHtml(g)}</div>`;
          }
          html += `</div>`;
        }
      }

      html += `</div>`; // .pr-panel
    });

    html += `</div>`; // press release block
  } else {
    html += `<div class="pr-empty" style="margin-bottom:16px">No earnings press releases found in SEC EDGAR 8-K filings for the selected quarters. This may happen for financial companies or firms with non-standard reporting formats.</div>`;
  }

  // ── B. News feed ──
  if (news.length > 0) {
    html += `<div style="margin-bottom:16px">`;
    html += `<div style="font-size:13px;color:var(--muted);margin-bottom:10px">
      <strong>Recent News &amp; Analysis</strong> — sourced from Yahoo Finance (${escHtml(ticker)} headlines).
    </div>`;
    html += `<div class="news-grid">`;
    for (const item of news.slice(0, 10)) {
      const dateStr = item.pubDate ? new Date(item.pubDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
      html += `<div class="news-card">
        <div class="news-card-title">
          ${item.link
            ? `<a href="${escHtml(item.link)}" target="_blank" rel="noopener">${escHtml(item.title)}</a>`
            : escHtml(item.title)
          }
        </div>
        ${item.description ? `<div class="news-card-desc">${escHtml(item.description.slice(0, 140))}${item.description.length > 140 ? '…' : ''}</div>` : ''}
        ${dateStr ? `<div class="news-card-date">${dateStr}</div>` : ''}
      </div>`;
    }
    html += `</div></div>`;
  } else {
    html += `<div class="pr-empty">No recent news articles found for this ticker.</div>`;
  }

  return html;
}

function switchPrPanel(period, btn) {
  // Hide all panels
  document.querySelectorAll('.pr-panel').forEach(el => el.classList.remove('visible'));
  document.querySelectorAll('.period-tab').forEach(b => b.classList.remove('active'));
  // Show selected
  const panel = document.getElementById('pr-panel-' + period);
  if (panel) panel.classList.add('visible');
  btn.classList.add('active');
}

function kpiCard(label, val, yoy, sub) {
  let change = '';
  if (yoy) change = `<div class="kpi-change ${pctClass(yoy)}">${escHtml(yoy)} YoY</div>`;
  else if (sub) change = `<div class="kpi-change" style="color:var(--muted);font-weight:400">${escHtml(sub)}</div>`;
  return `<div class="kpi">
    <div class="kpi-val">${val}</div>
    <div class="kpi-label">${label}</div>
    ${change}
  </div>`;
}

// ============================================================
// Tables
// ============================================================
function buildIncomeTable(quarters) {
  const cols = quarters.map(q => `<th>${escHtml(q.period)}</th>`).join('');

  function row(label, field, formatter, highlight, subRow) {
    const cells = quarters.map(q => {
      const v = q[field];
      return `<td>${formatter(v)}</td>`;
    }).join('');
    const tr = highlight ? 'class="hl"' : '';
    const indent = subRow ? ' style="padding-left:18px;font-weight:400"' : '';
    return `<tr ${tr}><td class="label"${indent}>${escHtml(label)}</td>${cells}</tr>`;
  }

  function rowYoY(label) {
    const cells = quarters.map(q => {
      const v = q.revenueYoY;
      return `<td class="${v ? pctClass(v) : ''}">${v ? escHtml(v) : '—'}</td>`;
    }).join('');
    return `<tr><td class="label" style="padding-left:18px;font-weight:400">${escHtml(label)}</td>${cells}</tr>`;
  }

  return `<div class="tbl-wrap"><table>
    <thead><tr><th class="left">Metric</th>${cols}</tr></thead>
    <tbody>
      ${row('Revenue', 'revenue', fmt, true)}
      ${rowYoY('  YoY Growth')}
      ${row('Gross Profit', 'grossProfit', fmt, false)}
      ${row('Gross Margin %', 'grossMarginPct', fmtPct, true)}
      ${row('Operating Income', 'operatingIncome', fmt, false)}
      ${row('Op. Margin %', 'operatingMarginPct', fmtPct, false)}
      ${row('Net Income', 'netIncome', fmt, false)}
      ${row('Diluted EPS', 'eps', fmtEps, true)}
    </tbody>
  </table></div>`;
}

function buildCashTable(quarters) {
  const cols = quarters.map(q => `<th>${escHtml(q.period)}</th>`).join('');
  function row(label, field, formatter, highlight) {
    const cells = quarters.map(q => {
      const v = q[field];
      return `<td>${formatter(v)}</td>`;
    }).join('');
    const tr = highlight ? 'class="hl"' : '';
    return `<tr ${tr}><td class="label">${escHtml(label)}</td>${cells}</tr>`;
  }
  return `<div class="tbl-wrap"><table>
    <thead><tr><th class="left">Metric</th>${cols}</tr></thead>
    <tbody>
      ${row('Operating Cash Flow', 'operatingCashFlow', fmt, true)}
      ${row('Net Income', 'netIncome', fmt, false)}
      ${row('Gross Profit', 'grossProfit', fmt, false)}
    </tbody>
  </table></div>`;
}

// ============================================================
// SVG Charts
// ============================================================
const CHART_CONFIGS = {
  revenue:           { label: 'Revenue',          formatter: fmt,    color: '#3b82d4', bar: true },
  grossMarginPct:    { label: 'Gross Margin %',    formatter: fmtPct, color: '#7c5cd8', bar: false },
  operatingMarginPct:{ label: 'Operating Margin %',formatter: fmtPct, color: '#2e7d32', bar: false },
  eps:               { label: 'Diluted EPS',        formatter: fmtEps, color: '#c62828', bar: false },
  operatingCashFlow: { label: 'Operating Cash Flow',formatter: fmt,   color: '#856404', bar: true },
};

function buildAllCharts(quarters) {
  let html = '';
  for (const [field, cfg] of Object.entries(CHART_CONFIGS)) {
    const display = field === 'revenue' ? 'block' : 'none';
    html += `<div id="chart-${field}" class="chart-wrap" style="display:${display}">`;
    html += buildSvgChart(quarters, field, cfg);
    html += '</div>';
  }
  return html;
}

function buildSvgChart(quarters, field, cfg) {
  const vals = quarters.map(q => q[field]);
  const nonNull = vals.filter(v => v !== null && v !== undefined);
  if (!nonNull.length) return '<div style="color:var(--muted);font-size:12px;padding:12px 0">No data available for this metric.</div>';

  const minVal = Math.min(...nonNull);
  const maxVal = Math.max(...nonNull);
  const range  = maxVal - minVal || 1;

  const W = 760, H = 160, PAD_L = 10, PAD_R = 10, PAD_T = 28, PAD_B = 30;
  const chartW = W - PAD_L - PAD_R;
  const chartH = H - PAD_T - PAD_B;
  const n = quarters.length;
  const step = chartW / n;

  // Y scale: give some headroom
  const yMin = minVal - range * 0.08;
  const yMax = maxVal + range * 0.08;
  const yRange = yMax - yMin;

  function yCoord(v) {
    if (v === null || v === undefined) return null;
    return PAD_T + chartH - ((v - yMin) / yRange) * chartH;
  }

  let svgBody = '';

  // Grid lines (3)
  for (let i = 0; i <= 3; i++) {
    const y = PAD_T + (chartH / 3) * i;
    svgBody += `<line x1="${PAD_L}" y1="${y}" x2="${W - PAD_R}" y2="${y}" stroke="#e5e7eb" stroke-width="1"/>`;
  }

  if (cfg.bar) {
    // Bar chart
    const barW = step * 0.55;
    for (let i = 0; i < n; i++) {
      const v = vals[i];
      const x = PAD_L + i * step + step * 0.5 - barW / 2;
      const y = yCoord(v);
      if (y === null) continue;
      const barH = PAD_T + chartH - y;
      const opacity = 0.55 + (i / n) * 0.45;
      svgBody += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${barH.toFixed(1)}" fill="${cfg.color}" opacity="${opacity.toFixed(2)}"/>`;
      // Label above bar
      const labelY = y - 4;
      svgBody += `<text x="${(x + barW/2).toFixed(1)}" y="${labelY.toFixed(1)}" text-anchor="middle" font-size="9" fill="#57606a">${cfg.formatter(v)}</text>`;
    }
  } else {
    // Line chart
    const points = [];
    for (let i = 0; i < n; i++) {
      const v = vals[i];
      const x = PAD_L + i * step + step * 0.5;
      const y = yCoord(v);
      if (y !== null) points.push({ x, y, v, i });
    }
    if (points.length >= 2) {
      const poly = points.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
      svgBody += `<polyline points="${poly}" fill="none" stroke="${cfg.color}" stroke-width="2.5"/>`;
    }
    for (const p of points) {
      svgBody += `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="4" fill="${cfg.color}"/>`;
      svgBody += `<text x="${p.x.toFixed(1)}" y="${(p.y - 8).toFixed(1)}" text-anchor="middle" font-size="9" fill="#1f2328">${cfg.formatter(p.v)}</text>`;
    }
  }

  // X-axis labels
  for (let i = 0; i < n; i++) {
    const x = PAD_L + i * step + step * 0.5;
    const y = H - 4;
    svgBody += `<text x="${x.toFixed(1)}" y="${y}" text-anchor="middle" font-size="9" fill="#57606a">${escHtml(quarters[i].period)}</text>`;
  }

  return `<div class="chart-title">${cfg.label}</div>
<svg class="chart" viewBox="0 0 ${W} ${H}" aria-label="${cfg.label} chart">
  ${svgBody}
</svg>`;
}

function switchChart(field, btn) {
  for (const [f] of Object.entries(CHART_CONFIGS)) {
    const el = document.getElementById('chart-' + f);
    if (el) el.style.display = 'none';
  }
  const stockEl = document.getElementById('chart-stockPrice');
  if (stockEl) stockEl.style.display = 'none';
  document.querySelectorAll('.chart-tab').forEach(b => b.classList.remove('active'));
  showChart(field);
  btn.classList.add('active');
}

function showChart(field) {
  const el = document.getElementById('chart-' + field);
  if (el) el.style.display = 'block';
}

// ============================================================
// Commentary
// ============================================================
function buildCommentary(company, quarters, revTrend, gmTrend, cfTrend, epsTrend) {
  const latest = quarters[quarters.length - 1];
  const latestRev = latest.revenue;
  const latestGM  = latest.grossMarginPct;
  const yoyRev = latest.revenueYoY;
  const name = escHtml(company.name);

  // Revenue
  const revTag = revTrend === 'growing' ? '<span class="tag tag-up">↑ GROWING</span>'
               : revTrend === 'declining' ? '<span class="tag tag-dn">↓ DECLINING</span>'
               : '<span class="tag tag-neu">→ STABLE</span>';

  // Gross margin
  const gmTag = gmTrend === 'growing' ? '<span class="tag tag-up">↑ EXPANDING</span>'
              : gmTrend === 'declining' ? '<span class="tag tag-dn">↓ COMPRESSING</span>'
              : '<span class="tag tag-neu">→ STABLE</span>';

  // Avg margins
  const gm4 = quarters.slice(-4).map(q => q.grossMarginPct).filter(v => v !== null);
  const gm4prior = quarters.slice(0, Math.min(4, quarters.length)).map(q => q.grossMarginPct).filter(v => v !== null);
  const avgGm4 = gm4.length ? (gm4.reduce((a,b)=>a+b,0)/gm4.length).toFixed(1) : null;
  const avgGm4Prior = gm4prior.length ? (gm4prior.reduce((a,b)=>a+b,0)/gm4prior.length).toFixed(1) : null;

  const cfTag = cfTrend === 'growing' ? '<span class="tag tag-up">↑ GROWING</span>'
              : cfTrend === 'declining' ? '<span class="tag tag-dn">↓ DECLINING</span>'
              : '<span class="tag tag-neu">→ STABLE</span>';

  const epsTag = epsTrend === 'growing' ? '<span class="tag tag-up">↑ GROWING</span>'
               : epsTrend === 'declining' ? '<span class="tag tag-dn">↓ DECLINING</span>'
               : '<span class="tag tag-neu">→ STABLE</span>';

  let html = '';

  // Revenue
  html += `<div class="commentary-section">
    <div class="commentary-heading">Revenue Growth</div>
    <div class="commentary-box">
      ${revTag}
      ${name} reported <strong>${fmt(latestRev)}</strong> in its most recent quarter
      ${yoyRev ? `— <strong>${escHtml(yoyRev)} year-over-year growth</strong>` : ''}.
      Revenue has been <strong>${revTrend}</strong> across the ${quarters.length}-quarter window.
      ${revTrend === 'growing' ? 'Consistent top-line expansion signals healthy demand and successful go-to-market execution.' :
        revTrend === 'declining' ? 'Revenue headwinds may reflect macro pressures, market saturation, or competitive dynamics — watch guidance closely.' :
        'Flat revenue indicates a mature, steady business; growth catalysts will be key to re-rating.'}
    </div>
  </div>`;

  // Gross margin
  html += `<div class="commentary-section">
    <div class="commentary-heading">Gross Margin Analysis</div>
    <div class="commentary-box">
      ${gmTag}
      Gross margin stands at <strong>${fmtPct(latestGM)}</strong> in the latest quarter.
      ${avgGm4 && avgGm4Prior ? `Average gross margin over the most recent 4 quarters: <strong>${avgGm4}%</strong> vs. <strong>${avgGm4Prior}%</strong> in the prior period.` : ''}
      ${gmTrend === 'growing' ? 'Expanding margins indicate improving pricing power, favorable product mix shift toward higher-margin offerings, or operating leverage kicking in.' :
        gmTrend === 'declining' ? 'Margin compression may reflect rising input costs, pricing pressure, mix shift toward lower-margin products, or higher cost of revenue.' :
        'Stable margins suggest consistent business model execution without material mix shifts — a positive signal for earnings quality.'}
    </div>
  </div>`;

  // EPS
  html += `<div class="commentary-section">
    <div class="commentary-heading">Earnings Per Share (EPS)</div>
    <div class="commentary-box">
      ${epsTag}
      Diluted EPS is <strong>${fmtEps(latest.eps)}</strong> in the latest quarter.
      ${epsTrend === 'growing' ? 'EPS growth driven by a combination of revenue expansion, margin improvement, and/or share buybacks reflects strong earnings quality.' :
        epsTrend === 'declining' ? 'Declining EPS may signal earnings pressure from higher costs, investment cycles, or share issuance dilution — context from management guidance is essential.' :
        'Stable EPS reflects consistent profitability — analysts will focus on the path to re-acceleration.'}
    </div>
  </div>`;

  // Cash flow
  html += `<div class="commentary-section">
    <div class="commentary-heading">Cash Flow Generation</div>
    <div class="commentary-box">
      ${cfTag}
      Operating cash flow was <strong>${fmt(latest.operatingCashFlow)}</strong> in the latest quarter.
      ${cfTrend === 'growing' ? 'Growing operating cash flow is the gold standard of financial health — it gives management flexibility to invest in growth, return capital to shareholders, and service debt without external financing.' :
        cfTrend === 'declining' ? 'Declining cash generation warrants scrutiny: is working capital deteriorating, or is this an investment cycle that will normalize? Monitor FCF conversion relative to reported net income.' :
        'Stable cash flows support a durable business model. Analysts will look for catalysts to accelerate cash generation.'}
    </div>
  </div>`;

  // Analyst themes
  html += `<div class="commentary-section">
    <div class="commentary-heading">Key Analyst Watch Points</div>
    <div class="commentary-box">
      <span class="tag tag-neu">SYNTHESIZED</span>
      Based on the ${quarters.length}-quarter trend, the following themes would drive analyst discussion:
      <ul>
        <li><strong>Revenue quality:</strong> ${revTrend === 'growing' ? 'Positive YoY momentum supports constructive analyst views and premium multiples.' : revTrend === 'declining' ? 'Revenue headwinds likely weigh on consensus estimates — watch next-quarter guidance.' : 'Stable revenue — analysts will seek evidence of reacceleration or new growth vectors.'}</li>
        <li><strong>Margin story:</strong> ${gmTrend === 'growing' ? 'Expanding margins support earnings upgrade cycle — a key bull thesis.' : gmTrend === 'declining' ? 'Margin compression is typically a headwind to multiple expansion — monitor cost reduction initiatives.' : 'Stable margins signal execution consistency — typically rewarded with stable multiples.'}</li>
        <li><strong>Cash flow durability:</strong> ${cfTrend === 'growing' ? 'Growing cash flow strengthens the investment thesis and supports capital returns.' : 'Watch FCF conversion — cash flow quality is the ultimate arbiter of earnings reliability.'}</li>
        <li><strong>Company statements:</strong> Executive quotes, financial highlights, and forward guidance from official SEC 8-K press releases appear in section 5 below (loaded automatically). Segment data and non-GAAP adjustments are not available in XBRL-tagged data.</li>
      </ul>
    </div>
  </div>`;

  return html;
}

// ============================================================
// UI helpers
// ============================================================
function showLoading(msg) {
  document.getElementById('report').style.display = 'none';
  document.getElementById('status-box').style.display = 'block';
  document.getElementById('status-box').innerHTML = `
    <div class="spinner"></div>
    <div style="color:var(--muted);font-size:13px">${msg}</div>`;
}

function showStatus(msg) {
  document.getElementById('report').style.display = 'none';
  document.getElementById('status-box').style.display = 'block';
  document.getElementById('status-box').innerHTML = `
    <div style="font-size:28px;margin-bottom:10px">⚠️</div>
    <div style="font-size:13px;color:var(--muted)">${msg}</div>`;
}

// ── Auto-launch from dashboard "Analyse →" link ──────────────
(function () {
  const p = new URLSearchParams(location.search);
  const ticker = p.get('ticker');
  const cik    = p.get('cik');
  const name   = p.get('name');
  if (ticker && cik && name) {
    quickLaunch(ticker, cik, name);
  }
})();

