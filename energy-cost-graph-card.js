// energy-cost-graph-card.js
// Custom Home Assistant card: Energy cost bar chart
// Shows energy spend (£/$/€) over time using the same data as the built-in Energy Dashboard.
// When placed on the Energy Dashboard, it automatically syncs with the dashboard date picker.
// When placed elsewhere, it has its own period selector and date navigation.

(function () {
  'use strict';

  const VERSION = '1.0.0';

  // Colours matching the HA Energy Dashboard palette
  const SERIES_COLORS = [
    '#F44336', // red   – primary grid import
    '#FF9800', // orange – secondary tariff
    '#9C27B0', // purple – tertiary
    '#2196F3', // blue   – quaternary
  ];

  // Map chart period → statistical resolution
  const PERIOD_META = {
    day:   { label: 'Day',   chartPeriod: 'hour',  navStep: 'day',   navDelta: 1 },
    week:  { label: 'Week',  chartPeriod: 'day',   navStep: 'day',   navDelta: 7 },
    month: { label: 'Month', chartPeriod: 'day',   navStep: 'month', navDelta: 1 },
    year:  { label: 'Year',  chartPeriod: 'month', navStep: 'year',  navDelta: 1 },
  };

  // ---------------------------------------------------------------------------
  // Styles
  // ---------------------------------------------------------------------------
  const CARD_CSS = `
    :host { display: block; }

    ha-card {
      height: 100%;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      box-sizing: border-box;
    }

    /* ---- Header ---- */
    .card-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 16px 16px 0;
      gap: 8px;
      flex-wrap: wrap;
    }
    .card-title {
      font-size: 1.1em;
      font-weight: 500;
      color: var(--primary-text-color);
    }
    .period-buttons {
      display: flex;
      gap: 4px;
    }
    .period-btn {
      padding: 3px 10px;
      border: 1px solid var(--divider-color, #e0e0e0);
      border-radius: 14px;
      background: transparent;
      color: var(--secondary-text-color);
      cursor: pointer;
      font-size: 0.78em;
      line-height: 1.6;
      transition: background 0.15s, color 0.15s;
    }
    .period-btn.active {
      background: var(--primary-color, #03a9f4);
      color: #fff;
      border-color: var(--primary-color, #03a9f4);
    }
    .period-btn:hover:not(.active) {
      background: var(--secondary-background-color, #f0f0f0);
    }

    /* ---- Date navigation ---- */
    .date-nav {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
      padding: 6px 16px 2px;
    }
    .nav-btn {
      width: 30px;
      height: 30px;
      border: none;
      background: transparent;
      cursor: pointer;
      color: var(--primary-text-color);
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 50%;
      padding: 0;
      flex-shrink: 0;
    }
    .nav-btn:hover { background: var(--secondary-background-color, #f0f0f0); }
    .nav-btn:disabled { color: var(--disabled-text-color, #bbb); cursor: default; }
    .nav-btn:disabled:hover { background: transparent; }
    .date-label {
      font-size: 0.88em;
      color: var(--primary-text-color);
      min-width: 150px;
      text-align: center;
      user-select: none;
    }

    /* ---- Summary strip ---- */
    .summary {
      display: flex;
      gap: 24px;
      padding: 8px 16px 4px;
      flex-wrap: wrap;
    }
    .summary-item { display: flex; flex-direction: column; }
    .summary-label {
      font-size: 0.72em;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--secondary-text-color);
    }
    .summary-value {
      font-size: 1.25em;
      font-weight: 500;
      color: var(--primary-text-color);
    }

    /* ---- Legend ---- */
    .legend {
      display: flex;
      gap: 12px;
      padding: 0 16px 4px;
      flex-wrap: wrap;
    }
    .legend-item {
      display: flex;
      align-items: center;
      gap: 5px;
      font-size: 0.78em;
      color: var(--secondary-text-color);
    }
    .legend-swatch {
      width: 10px;
      height: 10px;
      border-radius: 2px;
      flex-shrink: 0;
    }

    /* ---- Chart ---- */
    .chart-wrap {
      position: relative;
      padding: 4px 16px 12px;
      flex: 1;
    }
    svg.chart {
      width: 100%;
      display: block;
    }
    .bar { cursor: default; }
    .bar:hover { opacity: 0.75; }

    /* ---- Tooltip ---- */
    .tooltip {
      position: absolute;
      background: var(--card-background-color, #fff);
      border: 1px solid var(--divider-color, #ddd);
      border-radius: 8px;
      padding: 8px 12px;
      font-size: 0.82em;
      color: var(--primary-text-color);
      pointer-events: none;
      box-shadow: 0 2px 8px rgba(0,0,0,0.18);
      white-space: nowrap;
      z-index: 99;
      display: none;
    }
    .tooltip-title { font-weight: 600; margin-bottom: 3px; }
    .tooltip-row { display: flex; gap: 6px; align-items: center; }
    .tooltip-dot { width: 8px; height: 8px; border-radius: 1px; flex-shrink: 0; }

    /* ---- States ---- */
    .state-box {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 160px;
      padding: 16px;
      text-align: center;
      color: var(--secondary-text-color);
      gap: 6px;
      font-size: 0.92em;
      line-height: 1.5;
    }
    .state-box b { color: var(--primary-text-color); }
    .state-box.error { color: var(--error-color, #F44336); }
  `;

  // ---------------------------------------------------------------------------
  // Card class
  // ---------------------------------------------------------------------------
  class EnergyCostGraphCard extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: 'open' });

      this._hass = null;
      this._config = {};
      this._prefs = null;
      this._costSeries = [];   // [{id, label, color}]
      this._stats = {};
      this._loading = false;
      this._error = null;
      this._initialized = false;

      // Energy dashboard collection integration
      this._unsubEnergy = null;
      this._collectionActive = false;

      // Date/period state (defaults to "current month")
      this._period = 'month';
      this._anchorDate = this._today();
      this._start = null;
      this._end = null;
      this._chartPeriod = 'day';
      this._recomputeRange();
    }

    // -------------------------------------------------------------------------
    // HA lifecycle hooks
    // -------------------------------------------------------------------------

    setConfig(config) {
      this._config = { title: 'Energy Cost', period: 'month', ...config };
      if (PERIOD_META[config.period]) {
        this._period = config.period;
        this._anchorDate = this._today();
        this._recomputeRange();
      }
      if (this._initialized) {
        this._loadAndRender();
      }
    }

    set hass(hass) {
      const wasNull = !this._hass;
      this._hass = hass;

      if (!this._initialized) {
        this._initialized = true;
        this._boot();
        return;
      }

      // After first load, try to hook into energy collection on every hass update
      // until we succeed (energy dashboard may initialise after our card).
      if (!this._collectionActive) {
        this._tryBindCollection();
      }
    }

    connectedCallback() {
      // Re-attempt collection binding when card is re-inserted into DOM
      if (this._hass && !this._collectionActive) {
        this._tryBindCollection();
      }
    }

    disconnectedCallback() {
      this._releaseCollection();
    }

    // -------------------------------------------------------------------------
    // Date range computation
    // -------------------------------------------------------------------------

    _today() {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      return d;
    }

    _recomputeRange() {
      const d = new Date(this._anchorDate);
      d.setHours(0, 0, 0, 0);

      switch (this._period) {
        case 'day':
          this._start = new Date(d);
          this._end = new Date(d);
          this._end.setDate(this._end.getDate() + 1);
          this._chartPeriod = 'hour';
          break;

        case 'week': {
          // ISO week: starts Monday
          const dow = d.getDay(); // 0=Sun
          const diff = dow === 0 ? -6 : 1 - dow;
          this._start = new Date(d);
          this._start.setDate(d.getDate() + diff);
          this._start.setHours(0, 0, 0, 0);
          this._end = new Date(this._start);
          this._end.setDate(this._end.getDate() + 7);
          this._chartPeriod = 'day';
          break;
        }

        case 'month':
          this._start = new Date(d.getFullYear(), d.getMonth(), 1);
          this._end   = new Date(d.getFullYear(), d.getMonth() + 1, 1);
          this._chartPeriod = 'day';
          break;

        case 'year':
          this._start = new Date(d.getFullYear(), 0, 1);
          this._end   = new Date(d.getFullYear() + 1, 0, 1);
          this._chartPeriod = 'month';
          break;
      }
    }

    _navigate(direction) {
      const d = new Date(this._anchorDate);
      const meta = PERIOD_META[this._period];
      if (meta.navStep === 'day')   d.setDate(d.getDate() + direction * meta.navDelta);
      if (meta.navStep === 'month') d.setMonth(d.getMonth() + direction * meta.navDelta);
      if (meta.navStep === 'year')  d.setFullYear(d.getFullYear() + direction * meta.navDelta);
      this._anchorDate = d;
      this._recomputeRange();
      this._loadAndRender();
    }

    _changePeriod(period) {
      this._period = period;
      this._anchorDate = this._today();
      this._recomputeRange();
      this._loadAndRender();
    }

    // -------------------------------------------------------------------------
    // Energy Dashboard collection integration
    // -------------------------------------------------------------------------

    _tryBindCollection() {
      if (!this._hass?.connection) return;

      // HA stores the energy collection on the connection object under
      // the key "energy_<collection_key>" (defaults to "energy_default").
      const collectionKey = this._config.collection_key || 'default';
      const key = `energy_${collectionKey}`;
      const collection = this._hass.connection[key];

      if (!collection || typeof collection.subscribe !== 'function') return;

      this._collectionActive = true;

      // subscribe() returns an unsubscribe fn; collection calls us immediately
      // with the current state and again on every date/data change.
      this._unsubEnergy = collection.subscribe((data) => {
        if (!data) return;

        // Sync our date window to whatever the energy dashboard has selected
        if (data.start) {
          this._start = data.start instanceof Date ? data.start : new Date(data.start);
        }
        if (data.end) {
          this._end = data.end instanceof Date ? data.end : new Date(data.end);
        } else {
          // If end is undefined the collection uses "now" as implicit end
          this._end = new Date();
        }

        // Infer period label from date range for the UI
        const diffMs   = this._end - this._start;
        const diffDays = diffMs / 86_400_000;
        if      (diffDays <= 2)  { this._period = 'day';   this._chartPeriod = 'hour'; }
        else if (diffDays <= 8)  { this._period = 'week';  this._chartPeriod = 'day'; }
        else if (diffDays <= 32) { this._period = 'month'; this._chartPeriod = 'day'; }
        else                     { this._period = 'year';  this._chartPeriod = 'month'; }

        // Extract preferences and cost series
        if (data.prefs) {
          this._prefs = data.prefs;
          this._costSeries = this._extractCostSeries(data.prefs);
        }

        // Use the stats the collection already fetched (avoids duplicate requests)
        if (data.stats) {
          this._stats = data.stats;
          this._loading = false;
          this._error = null;
          this._render();
        }
      });
    }

    _releaseCollection() {
      if (this._unsubEnergy) {
        this._unsubEnergy();
        this._unsubEnergy = null;
      }
      this._collectionActive = false;
    }

    // -------------------------------------------------------------------------
    // Data loading (standalone mode)
    // -------------------------------------------------------------------------

    async _boot() {
      this._renderPlaceholder();
      this._tryBindCollection(); // attempt early bind
      if (!this._collectionActive) {
        // Standalone: fetch everything ourselves
        await this._loadPrefs();
        await this._fetchStats();
      }
      this._render();
    }

    async _loadAndRender() {
      if (this._collectionActive) return; // driven by collection subscription
      this._loading = true;
      this._render();
      try {
        await this._fetchStats();
      } catch (err) {
        this._error = String(err.message || err);
      }
      this._loading = false;
      this._render();
    }

    async _loadPrefs() {
      try {
        this._prefs = await this._hass.callWS({ type: 'energy/get_prefs' });
        this._costSeries = this._extractCostSeries(this._prefs);
        console.debug('[energy-cost-graph-card] prefs', this._prefs);
        console.debug('[energy-cost-graph-card] cost series', this._costSeries);
      } catch (_) {
        // Energy component might not be installed / configured
        this._prefs = null;
        this._costSeries = [];
      }
    }

    _extractCostSeries(prefs) {
      const series = [];
      if (!prefs?.energy_sources) return series;

      let colorIdx = 0;
      for (const source of prefs.energy_sources) {
        if (source.type !== 'grid') continue;
        for (const flow of source.flow_from || []) {
          if (!flow.stat_cost) continue;
          // Attempt a friendly label from the entity name
          const entityId = flow.entity_energy_from;
          const friendlyName = entityId && this._hass?.states?.[entityId]
            ?.attributes?.friendly_name;
          series.push({
            id: flow.stat_cost,
            label: friendlyName || (series.length === 0 ? 'Electricity' : `Tariff ${series.length + 1}`),
            color: SERIES_COLORS[colorIdx++ % SERIES_COLORS.length],
          });
        }
      }
      return series;
    }

    async _fetchStats() {
      if (!this._prefs || this._costSeries.length === 0) {
        console.debug('[energy-cost-graph-card] skipping fetch — no prefs or cost series');
        return;
      }

      const statIds = this._costSeries.map(s => s.id);
      console.debug('[energy-cost-graph-card] fetching stats', {
        statIds, start: this._start, end: this._end, period: this._chartPeriod,
      });
      try {
        // recorder/statistics_during_period (added HA 2021.12, types param ≥ 2022.12)
        this._stats = await this._hass.callWS({
          type: 'recorder/statistics_during_period',
          start_time: this._start.toISOString(),
          end_time:   this._end.toISOString(),
          statistic_ids: statIds,
          period: this._chartPeriod,
          types: ['change', 'sum'],
          units: {},
        });
        console.debug('[energy-cost-graph-card] stats response', this._stats);
      } catch (err) {
        console.error('[energy-cost-graph-card] stats fetch failed', err);
        this._stats = {};
        throw err;
      }
    }

    // -------------------------------------------------------------------------
    // Chart data assembly
    // -------------------------------------------------------------------------

    _buildChartData() {
      if (!this._costSeries.length || !this._stats) return [];

      // Collect all timestamps that appear in any series
      const slotMap = new Map(); // ts(ms) → {ts, values:{seriesId→value}}

      for (const series of this._costSeries) {
        const rows = this._stats[series.id];
        if (!rows?.length) continue;

        // HA may return 'change' directly; fall back to computing delta from 'sum'.
        let prevSum = null;

        for (const row of rows) {
          // Timestamps may be ms or seconds – normalise
          const ts = row.start > 1e12 ? row.start : row.start * 1000;

          let value = row.change;
          if (value == null) {
            // Older HA or types not supported: derive from consecutive sums
            value = (row.sum != null && prevSum != null) ? row.sum - prevSum : 0;
          }
          prevSum = row.sum ?? prevSum;

          // Cost deltas should never be negative in a bar chart
          value = Math.max(0, value || 0);

          if (!slotMap.has(ts)) slotMap.set(ts, { ts, values: {} });
          slotMap.get(ts).values[series.id] = value;
        }
      }

      return Array.from(slotMap.values())
        .sort((a, b) => a.ts - b.ts)
        .map(slot => ({
          ...slot,
          label: this._timeLabel(new Date(slot.ts)),
          total: this._costSeries.reduce((s, sr) => s + (slot.values[sr.id] || 0), 0),
        }));
    }

    _timeLabel(date) {
      switch (this._chartPeriod) {
        case 'hour':  return `${String(date.getHours()).padStart(2, '0')}:00`;
        case 'day':   return String(date.getDate());
        case 'month': return date.toLocaleString(undefined, { month: 'short' });
        default:      return date.toLocaleDateString();
      }
    }

    _formatRange() {
      if (!this._start) return '';
      switch (this._period) {
        case 'day':
          return this._start.toLocaleDateString(undefined, {
            weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
          });
        case 'week': {
          const endDay = new Date(this._end);
          endDay.setDate(endDay.getDate() - 1);
          return `${this._start.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}` +
                 ` – ${endDay.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`;
        }
        case 'month':
          return this._start.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
        case 'year':
          return String(this._start.getFullYear());
        default:
          return '';
      }
    }

    // -------------------------------------------------------------------------
    // Currency formatting
    // -------------------------------------------------------------------------

    _formatCost(value, compact = false) {
      const currency = this._hass?.config?.currency || 'GBP';
      try {
        const decimals = compact && value >= 10 ? 0 : 2;
        return new Intl.NumberFormat(undefined, {
          style: 'currency',
          currency,
          minimumFractionDigits: decimals,
          maximumFractionDigits: decimals,
        }).format(value);
      } catch (_) {
        return `${currency} ${value.toFixed(2)}`;
      }
    }

    // -------------------------------------------------------------------------
    // Rendering
    // -------------------------------------------------------------------------

    _renderPlaceholder() {
      this.shadowRoot.innerHTML = `
        <style>${CARD_CSS}</style>
        <ha-card><div class="state-box">Loading…</div></ha-card>
      `;
    }

    _render() {
      const title    = this._config.title || 'Energy Cost';
      const now      = new Date();
      const isFuture = this._end > now;

      // Determine whether the period selector and nav are shown
      // (hidden when driven by the energy dashboard collection)
      const showControls = !this._collectionActive;

      let body;

      if (this._error) {
        body = `<div class="state-box error">⚠ ${this._error}</div>`;

      } else if (!this._prefs) {
        body = `<div class="state-box">
          <b>Energy not configured</b>
          Go to <b>Settings → Energy</b> to add your energy sources.
        </div>`;

      } else if (this._costSeries.length === 0) {
        body = `<div class="state-box">
          <b>No cost data found</b>
          In <b>Settings → Energy</b>, edit each grid source and set a cost entity
          or a fixed price per kWh. Home Assistant will then track costs automatically.
        </div>`;

      } else if (this._loading) {
        body = `<div class="state-box">Loading…</div>`;

      } else {
        const data = this._buildChartData();

        if (!data.length) {
          body = `<div class="state-box">No data for this period.</div>`;
        } else {
          const total   = data.reduce((s, d) => s + d.total, 0);
          const peak    = Math.max(...data.map(d => d.total));
          const nonZero = data.filter(d => d.total > 0);
          const avg     = nonZero.length ? nonZero.reduce((s, d) => s + d.total, 0) / nonZero.length : 0;

          const summary = `
            <div class="summary">
              <div class="summary-item">
                <span class="summary-label">Total</span>
                <span class="summary-value">${this._formatCost(total)}</span>
              </div>
              <div class="summary-item">
                <span class="summary-label">Peak ${this._chartPeriod}</span>
                <span class="summary-value">${this._formatCost(peak)}</span>
              </div>
              <div class="summary-item">
                <span class="summary-label">Avg ${this._chartPeriod}</span>
                <span class="summary-value">${this._formatCost(avg)}</span>
              </div>
            </div>`;

          const legend = this._costSeries.length > 1 ? `
            <div class="legend">
              ${this._costSeries.map(s => `
                <div class="legend-item">
                  <div class="legend-swatch" style="background:${s.color}"></div>
                  <span>${s.label}</span>
                </div>`).join('')}
            </div>` : '';

          body = `
            ${summary}
            ${legend}
            <div class="chart-wrap" id="chart-wrap">
              ${this._renderChart(data)}
              <div class="tooltip" id="tooltip"></div>
            </div>`;
        }
      }

      const periodButtons = showControls ? `
        <div class="period-buttons">
          ${Object.entries(PERIOD_META).map(([key, m]) => `
            <button class="period-btn${this._period === key ? ' active' : ''}" data-period="${key}">
              ${m.label}
            </button>`).join('')}
        </div>` : '';

      const dateNav = showControls ? `
        <div class="date-nav">
          <button class="nav-btn" id="prev" title="Previous">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
              <path d="M15.41 16.59L10.83 12l4.58-4.59L14 6l-6 6 6 6z"/>
            </svg>
          </button>
          <span class="date-label">${this._formatRange()}</span>
          <button class="nav-btn" id="next"${isFuture ? ' disabled' : ''} title="Next">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
              <path d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6z"/>
            </svg>
          </button>
        </div>` : `
        <div class="date-nav">
          <span class="date-label">${this._formatRange()}</span>
        </div>`;

      this.shadowRoot.innerHTML = `
        <style>${CARD_CSS}</style>
        <ha-card>
          <div class="card-header">
            <span class="card-title">${title}</span>
            ${periodButtons}
          </div>
          ${dateNav}
          ${body}
        </ha-card>`;

      this._attachEvents();
    }

    // -------------------------------------------------------------------------
    // SVG bar chart
    // -------------------------------------------------------------------------

    _renderChart(data) {
      // Fixed coordinate space; CSS makes it responsive
      const W  = 520;
      const H  = 240;
      const ml = 58, mr = 10, mt = 8, mb = 36;
      const cw = W - ml - mr;
      const ch = H - mt - mb;

      const maxVal = data.reduce((m, d) => Math.max(m, d.total), 0) || 1;
      const yMax   = this._niceMax(maxVal * 1.08);
      const yTicks = this._niceTickCount(yMax);
      const tickStep = yMax / yTicks;

      const toY = v => ch - (v / yMax) * ch;

      // X layout
      const slotW = cw / data.length;
      const barPad = Math.max(1, Math.min(4, slotW * 0.12));
      const barW   = Math.max(2, slotW - barPad * 2);

      // How many x-axis labels fit without overlapping (≥ 20px each)
      const maxXLabels = Math.max(1, Math.floor(cw / 28));
      const xLabelStep = Math.ceil(data.length / maxXLabels);

      // Y-axis gridlines & labels
      const yLines = Array.from({ length: yTicks + 1 }, (_, i) => {
        const v = i * tickStep;
        const y = toY(v);
        return `
          <line x1="0" y1="${y.toFixed(1)}" x2="${cw}" y2="${y.toFixed(1)}"
                stroke="var(--divider-color,#e0e0e0)" stroke-width="1" stroke-dasharray="3 3"/>
          <text x="-4" y="${(y + 4).toFixed(1)}"
                text-anchor="end" font-size="10" fill="var(--secondary-text-color,#888)">
            ${this._formatCost(v, true)}
          </text>`;
      }).join('');

      // Bars (stacked per series)
      const bars = data.map((slot, i) => {
        const x0 = i * slotW + barPad;
        let stackTop = ch; // pixels from top within chart area, starts at bottom
        const rects = this._costSeries.map(series => {
          const v = slot.values[series.id] || 0;
          if (v <= 0) return '';
          const bh = (v / yMax) * ch;
          stackTop -= bh;
          return `<rect class="bar"
            x="${x0.toFixed(1)}" y="${stackTop.toFixed(1)}"
            width="${barW.toFixed(1)}" height="${bh.toFixed(1)}"
            fill="${series.color}" rx="2"
            data-idx="${i}" data-val="${slot.total.toFixed(4)}" data-label="${slot.label}"/>`;
        }).join('');

        // Ghost bar for zero-value slots (gives hover area for all bars)
        const ghost = `<rect class="bar"
          x="${x0.toFixed(1)}" y="0"
          width="${barW.toFixed(1)}" height="${ch}"
          fill="transparent"
          data-idx="${i}" data-val="${slot.total.toFixed(4)}" data-label="${slot.label}"/>`;

        return rects + ghost;
      }).join('');

      // X-axis labels
      const xLabels = data.map((slot, i) => {
        if (i % xLabelStep !== 0) return '';
        const x = (i * slotW + slotW / 2).toFixed(1);
        return `<text x="${x}" y="${(ch + 18).toFixed(1)}"
                  text-anchor="middle" font-size="10"
                  fill="var(--secondary-text-color,#888)">${slot.label}</text>`;
      }).join('');

      // Axes
      const axes = `
        <line x1="0" y1="0" x2="0" y2="${ch}" stroke="var(--divider-color,#ddd)" stroke-width="1"/>
        <line x1="0" y1="${ch}" x2="${cw}" y2="${ch}" stroke="var(--divider-color,#ddd)" stroke-width="1"/>`;

      return `
        <svg class="chart" viewBox="0 0 ${W} ${H}" aria-label="Energy cost chart">
          <g transform="translate(${ml},${mt})">
            ${yLines}
            ${axes}
            ${bars}
            ${xLabels}
          </g>
        </svg>`;
    }

    // Y-axis helpers
    _niceMax(raw) {
      if (raw <= 0) return 1;
      const mag  = Math.pow(10, Math.floor(Math.log10(raw)));
      const norm = raw / mag;
      const nice = norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10;
      return nice * mag;
    }

    _niceTickCount(max) {
      // Aim for 4–5 ticks that land on round values
      for (const n of [5, 4, 10, 2]) {
        if (Number.isInteger(+(max / n).toFixed(6))) return n;
      }
      return 5;
    }

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    _attachEvents() {
      const root = this.shadowRoot;

      // Period buttons
      root.querySelectorAll('.period-btn').forEach(btn => {
        btn.addEventListener('click', () => this._changePeriod(btn.dataset.period));
      });

      // Nav arrows
      root.getElementById('prev')?.addEventListener('click', () => this._navigate(-1));
      root.getElementById('next')?.addEventListener('click', () => this._navigate(1));

      // Tooltip
      const tooltip = root.getElementById('tooltip');
      const wrap    = root.getElementById('chart-wrap');
      if (!tooltip || !wrap) return;

      root.querySelectorAll('.bar').forEach(bar => {
        bar.addEventListener('mouseenter', (e) => {
          const idx   = +bar.dataset.idx;
          const val   = +bar.dataset.val;
          const label = bar.dataset.label;
          if (val === 0 && this._costSeries.length > 0) return; // ghost bar with no data

          let rows = '';
          // Find slot by index from rebuilt data
          const data  = this._buildChartData();
          const slot  = data[idx];
          if (slot) {
            rows = this._costSeries
              .filter(s => (slot.values[s.id] || 0) > 0)
              .map(s => `<div class="tooltip-row">
                <div class="tooltip-dot" style="background:${s.color}"></div>
                <span>${s.label}: ${this._formatCost(slot.values[s.id] || 0)}</span>
              </div>`)
              .join('');
            if (this._costSeries.length > 1) {
              rows += `<div style="border-top:1px solid var(--divider-color,#ddd);margin-top:4px;padding-top:4px;">
                Total: <b>${this._formatCost(val)}</b></div>`;
            }
          }

          tooltip.innerHTML = `<div class="tooltip-title">${label}</div>
            ${rows || `<div>${this._formatCost(val)}</div>`}`;
          tooltip.style.display = 'block';
        });

        bar.addEventListener('mousemove', (e) => {
          const rect = wrap.getBoundingClientRect();
          const x = e.clientX - rect.left;
          const y = e.clientY - rect.top;
          const tw = tooltip.offsetWidth || 120;
          // Keep tooltip inside card
          const left = Math.min(Math.max(tw / 2, x), rect.width - tw / 2);
          tooltip.style.left = `${left}px`;
          tooltip.style.top  = `${Math.max(8, y - 70)}px`;
          tooltip.style.transform = 'translateX(-50%)';
        });

        bar.addEventListener('mouseleave', () => {
          tooltip.style.display = 'none';
        });
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Register
  // ---------------------------------------------------------------------------
  customElements.define('energy-cost-graph-card', EnergyCostGraphCard);

  // Announce to custom card picker (e.g. HACS UI)
  window.customCards = window.customCards || [];
  window.customCards.push({
    type: 'energy-cost-graph-card',
    name: 'Energy Cost Graph',
    description: 'Bar chart of energy costs (£/$/€) – integrates with the Energy Dashboard date picker.',
    preview: false,
  });

  console.info(
    '%c ENERGY-COST-GRAPH-CARD %c v' + VERSION + ' ',
    'color:#fff;background:#F44336;font-weight:700;padding:2px 4px;border-radius:3px 0 0 3px',
    'color:#F44336;background:#fff;font-weight:700;padding:2px 4px;border-radius:0 3px 3px 0',
  );
})();
