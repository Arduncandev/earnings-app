
// ============================================================
// Constants & state
// ============================================================
const STORAGE_KEY = 'earningsiq_watchlist_v1';
const SUGGESTED = [
  { ticker: 'AAPL',  cik: '320193',  name: 'Apple Inc.' },
  { ticker: 'MSFT',  cik: '789019',  name: 'Microsoft' },
  { ticker: 'AMZN',  cik: '1018724', name: 'Amazon' },
  { ticker: 'GOOGL', cik: '1652044', name: 'Alphabet' },
  { ticker: 'TSLA',  cik: '1318605', name: 'Tesla' },
  { ticker: 'NVDA',  cik: '1045810', name: 'NVIDIA' },
  { ticker: 'META',  cik: '1326801', name: 'Meta Platforms' },
  { ticker: 'JPM',   cik: '19617',   name: 'JPMorgan Chase' },
];

let watchlist = [];        // [{ cik, ticker, name }]
let liveData  = {};        // ticker -> item data from /api/dashboard
let selectedAdd = null;    // currently selected company in add dropdown
let addSearchTimer = null;

// ============================================================
// Persistence
// ============================================================
function loadWatchlist() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) watchlist = JSON.parse(raw);
  } catch { watchlist = []; }
}

function saveWatchlist() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(watchlist));
}

function isWatching(ticker) {
  return watchlist.some(s => s.ticker === ticker.toUpperCase());
}

// ============================================================
// Utilities
// ============================================================
function escHtml(str) {
  if (!str && str !== 0) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

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

function pctClass(val) {
  if (val === null || val === undefined) return '';
  if (typeof val === 'string') return val.startsWith('+') ? 'pos' : val.startsWith('-') ? 'neg' : '';
  return val >= 0 ? 'pos' : 'neg';
}

function pctSign(val) {
  if (val === null || val === undefined) return '';
  return val >= 0 ? '+' : '';
}

// ============================================================
// Add-stock search
// ============================================================
const addInput    = document.getElementById('add-input');
const addDropdown = document.getElementById('add-dropdown');

addInput.addEventListener('input', () => {
  clearTimeout(addSearchTimer);
  const q = addInput.value.trim();
  selectedAdd = null;
  if (q.length < 2) { closeAddDropdown(); return; }
  addSearchTimer = setTimeout(() => fetchAddSuggestions(q), 220);
});

addInput.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeAddDropdown();
  if (e.key === 'Enter')  addSelected();
});

document.addEventListener('click', e => {
  if (!e.target.closest('.add-wrap')) closeAddDropdown();
});

async function fetchAddSuggestions(q) {
  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
    const data = await res.json();
    renderAddDropdown(data.results || []);
  } catch { closeAddDropdown(); }
}

function renderAddDropdown(results) {
  if (!results.length) { closeAddDropdown(); return; }
  addDropdown.innerHTML = '';
  for (const r of results) {
    const ticker = (r.tickers && r.tickers.length) ? r.tickers[0] : (r.ticker || '');
    const exch   = (r.exchanges && r.exchanges.length) ? r.exchanges[0] : '';
    const div = document.createElement('div');
    div.className = 'add-dropdown-item';
    div.innerHTML = `<span class="di-ticker">${escHtml(ticker || r.cik)}</span><span class="di-name">${escHtml(r.name)}<span class="di-exch">${escHtml(exch)}</span></span>`;
    div.addEventListener('click', () => selectAdd(r));
    addDropdown.appendChild(div);
  }
  addDropdown.classList.add('open');
}

function selectAdd(r) {
  const ticker = (r.tickers && r.tickers.length) ? r.tickers[0] : (r.ticker || r.cik);
  selectedAdd = { cik: r.cik, ticker, name: r.name };
  addInput.value = `${ticker} — ${r.name}`;
  closeAddDropdown();
}

function closeAddDropdown() {
  addDropdown.classList.remove('open');
}

// ============================================================
// Add / remove stocks
// ============================================================
async function addSelected() {
  let company = selectedAdd;

  // If nothing selected but there's text, try to auto-resolve
  if (!company) {
    const q = addInput.value.trim();
    if (!q) return;
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      if (data.results && data.results.length === 1) {
        const r = data.results[0];
        const ticker = (r.tickers && r.tickers.length) ? r.tickers[0] : (r.ticker || r.cik);
        company = { cik: r.cik, ticker, name: r.name };
      } else if (data.results && data.results.length > 1) {
        renderAddDropdown(data.results);
        return;
      } else {
        return;
      }
    } catch { return; }
  }

  if (!company) return;
  if (isWatching(company.ticker)) {
    addInput.value = '';
    selectedAdd = null;
    return;
  }

  watchlist.push({ cik: company.cik, ticker: company.ticker, name: company.name });
  saveWatchlist();
  addInput.value = '';
  selectedAdd = null;
  renderQuickChips();
  renderCards();
  fetchDataFor([company]);
}

function removeStock(ticker) {
  watchlist = watchlist.filter(s => s.ticker !== ticker);
  delete liveData[ticker];
  saveWatchlist();
  renderQuickChips();
  renderCards();
  renderSummaryBar();
}

function addFromChip(s) {
  if (isWatching(s.ticker)) return;
  watchlist.push(s);
  saveWatchlist();
  renderQuickChips();
  renderCards();
  fetchDataFor([s]);
}

// ============================================================
// Quick chips
// ============================================================
function renderQuickChips() {
  const container = document.getElementById('quick-chips');
  container.innerHTML = '';
  for (const s of SUGGESTED) {
    const already = isWatching(s.ticker);
    const span = document.createElement('span');
    span.className = 'chip' + (already ? ' already' : '');
    span.textContent = `${s.ticker}`;
    if (!already) span.onclick = () => addFromChip(s);
    container.appendChild(span);
  }
}

// ============================================================
// Fetch data from /api/dashboard
// ============================================================
async function fetchDataFor(stocks) {
  if (!stocks.length) return;
  // Show skeleton for new stocks
  for (const s of stocks) {
    liveData[s.ticker] = { ...s, _loading: true };
  }
  renderCards();

  try {
    const res = await fetch('/api/dashboard', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stocks }),
    });
    const data = await res.json();
    for (const item of (data.items || [])) {
      liveData[item.ticker] = item;
    }
  } catch (e) {
    for (const s of stocks) {
      liveData[s.ticker] = { ...s, error: e.message };
    }
  }

  renderCards();
  renderSummaryBar();
  updateLastUpdated();
}

async function refreshAll() {
  if (!watchlist.length) return;
  const btn = document.getElementById('refresh-btn');
  btn.disabled = true;
  btn.textContent = '⟳ Refreshing…';
  liveData = {};
  await fetchDataFor(watchlist);
  btn.disabled = false;
  btn.textContent = '⟳ Refresh';
}

function updateLastUpdated() {
  document.getElementById('last-updated').textContent =
    'Updated ' + new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

// ============================================================
// Summary bar
// ============================================================
function renderSummaryBar() {
  const bar = document.getElementById('summary-bar');
  const items = Object.values(liveData).filter(d => !d._loading && !d.error && d.price != null);
  if (items.length < 2) { bar.style.display = 'none'; return; }

  const gainers = items.filter(d => d.changePct > 0).length;
  const losers  = items.filter(d => d.changePct < 0).length;
  const avgChg  = items.reduce((sum, d) => sum + (d.changePct || 0), 0) / items.length;
  const best    = items.reduce((b, d) => (d.changePct > (b.changePct || -Infinity) ? d : b), {});
  const worst   = items.reduce((w, d) => (d.changePct < (w.changePct || Infinity) ? d : w), {});

  const avgCls = avgChg >= 0 ? 'pos' : 'neg';
  const avgSign = avgChg >= 0 ? '+' : '';

  bar.innerHTML = `
    <div class="summary-kpi">
      <div class="summary-kpi-val">${watchlist.length}</div>
      <div class="summary-kpi-label">Tracked</div>
    </div>
    <div class="summary-divider"></div>
    <div class="summary-kpi">
      <div class="summary-kpi-val ${avgCls}">${avgSign}${avgChg.toFixed(2)}%</div>
      <div class="summary-kpi-label">Avg Change</div>
    </div>
    <div class="summary-divider"></div>
    <div class="summary-kpi">
      <div class="summary-kpi-val pos">${gainers}</div>
      <div class="summary-kpi-label">Gainers</div>
    </div>
    <div class="summary-divider"></div>
    <div class="summary-kpi">
      <div class="summary-kpi-val neg">${losers}</div>
      <div class="summary-kpi-label">Losers</div>
    </div>
    ${best.ticker ? `
    <div class="summary-divider"></div>
    <div class="summary-kpi">
      <div class="summary-kpi-val pos">${escHtml(best.ticker)} ${pctSign(best.changePct)}${(best.changePct||0).toFixed(2)}%</div>
      <div class="summary-kpi-label">Best Today</div>
    </div>` : ''}
    ${worst.ticker ? `
    <div class="summary-divider"></div>
    <div class="summary-kpi">
      <div class="summary-kpi-val neg">${escHtml(worst.ticker)} ${(worst.changePct||0).toFixed(2)}%</div>
      <div class="summary-kpi-label">Worst Today</div>
    </div>` : ''}
  `;
  bar.style.display = 'flex';
}

// ============================================================
// Sparkline SVG builder
// ============================================================
function buildSparkline(values, color) {
  const pts = values.filter(v => v !== null && v !== undefined);
  if (pts.length < 2) return '<svg width="100%" height="32"></svg>';

  const W = 220, H = 32;
  const minV = Math.min(...pts);
  const maxV = Math.max(...pts);
  const rng  = maxV - minV || 1;

  const n = pts.length;
  const coords = pts.map((v, i) => {
    const x = (i / (n - 1)) * W;
    const y = H - 4 - ((v - minV) / rng) * (H - 8);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const last  = pts[pts.length - 1];
  const first = pts[0];
  const up    = last >= first;
  const lineColor = up ? '#2e7d32' : '#c62828';

  return `<svg width="100%" height="32" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
    <polyline points="${coords.join(' ')}" fill="none" stroke="${lineColor}" stroke-width="1.8"/>
    <circle cx="${((n-1)/(n-1))*W}" cy="${(H - 4 - ((last - minV) / rng) * (H - 8)).toFixed(1)}" r="3" fill="${lineColor}"/>
  </svg>`;
}

// ============================================================
// Render cards
// ============================================================
function renderCards() {
  const content = document.getElementById('dash-content');
  const emptyState = document.getElementById('empty-state');
  const subtitle   = document.getElementById('dash-subtitle');

  if (!watchlist.length) {
    content.innerHTML = '';
    content.appendChild(Object.assign(document.createElement('div'), {
      className: 'empty-state',
      innerHTML: `<div class="empty-state-icon">📋</div>
        <div class="empty-state-title">Your watchlist is empty</div>
        <div class="empty-state-text">Search for a company or ticker above and click <strong>Add</strong> to start tracking stocks. Your watchlist is saved in your browser.</div>`,
    }));
    document.getElementById('summary-bar').style.display = 'none';
    subtitle.textContent = 'Add stocks above to get started.';
    return;
  }

  const loadingCount = watchlist.filter(s => liveData[s.ticker]?._loading).length;
  subtitle.textContent = `${watchlist.length} stock${watchlist.length !== 1 ? 's' : ''} tracked${loadingCount ? ` · Loading ${loadingCount}…` : ''}`;

  const grid = document.createElement('div');
  grid.className = 'stock-grid';

  for (const s of watchlist) {
    const d = liveData[s.ticker];
    grid.appendChild(buildCard(s, d));
  }

  content.innerHTML = '';
  content.appendChild(grid);
}

function buildCard(s, d) {
  const div = document.createElement('div');

  if (!d || d._loading) {
    div.className = 'stock-card loading';
    div.innerHTML = `
      <div class="card-header">
        <div class="card-identity">
          <div class="card-ticker">${escHtml(s.ticker)}</div>
          <div class="card-name">${escHtml(s.name)}</div>
        </div>
        <button class="card-remove" onclick="removeStock('${escHtml(s.ticker)}')" title="Remove">✕</button>
      </div>
      <div style="display:flex;align-items:center;gap:8px;color:var(--muted);font-size:12px;padding:8px 0">
        <span class="spinner" style="width:16px;height:16px;border-width:2px"></span>
        Loading…
      </div>`;
    return div;
  }

  if (d.error) {
    div.className = 'stock-card error';
    div.innerHTML = `
      <div class="card-header">
        <div class="card-identity">
          <div class="card-ticker">${escHtml(s.ticker)}</div>
          <div class="card-name">${escHtml(s.name)}</div>
        </div>
        <button class="card-remove" onclick="removeStock('${escHtml(s.ticker)}')" title="Remove">✕</button>
      </div>
      <div class="card-error-msg">⚠ ${escHtml(d.error)}</div>
      <div class="card-footer">
        <span class="card-period"></span>
        <a class="card-analyse-link" href="/?ticker=${encodeURIComponent(s.ticker)}&cik=${encodeURIComponent(s.cik)}&name=${encodeURIComponent(s.name)}">Analyse →</a>
      </div>`;
    return div;
  }

  div.className = 'stock-card';

  const up    = (d.changePct || 0) >= 0;
  const cls   = up ? 'pos' : 'neg';
  const arrow = up ? '▲' : '▼';
  const sign  = up ? '+' : '';

  const stateLabel = d.marketState === 'PRE'    ? 'Pre-mkt'
                   : d.marketState === 'POST'   ? 'After-hrs'
                   : d.marketState === 'CLOSED' ? 'Closed'
                   : '';

  // Price block
  let priceHtml = '';
  if (d.price != null) {
    priceHtml = `
      <div class="card-price-row">
        <span class="card-price ${cls}">$${d.price.toFixed(2)}</span>
        <span class="card-change ${cls}">${arrow} ${sign}${(d.change||0).toFixed(2)} (${sign}${(d.changePct||0).toFixed(2)}%)</span>
        ${stateLabel ? `<span class="card-market-state">${escHtml(stateLabel)}</span>` : ''}
      </div>`;
  } else {
    priceHtml = `<div class="card-price-row"><span class="card-price" style="color:var(--muted);font-size:14px">No quote</span></div>`;
  }

  // KPI row
  const yoyStr = d.revenueYoY || null;
  const yoyCls = yoyStr ? pctClass(yoyStr) : '';
  let kpisHtml = `
    <div class="card-kpis">
      <div class="card-kpi">
        <div class="card-kpi-val">${fmt(d.latestRevenue)}</div>
        <div class="card-kpi-label">Revenue</div>
        ${yoyStr ? `<div class="card-kpi-sub ${yoyCls}">${escHtml(yoyStr)} YoY</div>` : ''}
      </div>
      <div class="card-kpi">
        <div class="card-kpi-val">${fmtEps(d.latestEPS)}</div>
        <div class="card-kpi-label">Diluted EPS</div>
      </div>
      <div class="card-kpi">
        <div class="card-kpi-val">${fmtPct(d.grossMarginPct)}</div>
        <div class="card-kpi-label">Gross Margin</div>
      </div>
    </div>`;

  // Revenue sparkline
  let sparkHtml = '';
  if (d.revenueSparkline && d.revenueSparkline.filter(v => v != null).length >= 2) {
    sparkHtml = `
      <div class="card-sparkline">
        <div class="card-sparkline-label">Revenue trend (6 qtrs)</div>
        ${buildSparkline(d.revenueSparkline, '#3b82d4')}
      </div>`;
  }

  // Analyse link — pass data in URL so index.html can auto-launch
  const analyseUrl = `/?ticker=${encodeURIComponent(d.ticker)}&cik=${encodeURIComponent(d.cik)}&name=${encodeURIComponent(d.name)}`;

  div.innerHTML = `
    <div class="card-header">
      <div class="card-identity">
        <div class="card-ticker">${escHtml(d.ticker)}</div>
        <div class="card-name" title="${escHtml(d.name)}">${escHtml(d.name)}</div>
      </div>
      <button class="card-remove" onclick="removeStock('${escHtml(d.ticker)}')" title="Remove from watchlist">✕</button>
    </div>
    ${priceHtml}
    ${kpisHtml}
    ${sparkHtml}
    <div class="card-footer">
      <span class="card-period">${d.latestPeriod ? 'Latest: ' + escHtml(d.latestPeriod) : ''}</span>
      <a class="card-analyse-link" href="${analyseUrl}">Analyse →</a>
    </div>`;

  return div;
}

// ============================================================
// Auto-launch from URL params (when coming from dashboard link)
// ============================================================
// (index.html handles this — nothing needed here)

// ============================================================
// Init
// ============================================================
loadWatchlist();
renderQuickChips();
renderCards();

if (watchlist.length > 0) {
  fetchDataFor(watchlist);
}

