// energy-cost-compare-card.js
// Custom Home Assistant card: cumulative energy cost today vs same-weekday average
// Two lines on a single chart — today (solid) vs N-week average (dashed).
// The fill between them turns orange when tracking above average, green when below.

(function () {
  'use strict';

  const VERSION = '1.0.0';

  const COLOR_TODAY = '#EA580C';  // accent orange — today's line
  const COLOR_AVG   = '#8896A8';  // steel blue-grey — historical average
  const COLOR_BAND  = 'rgba(136,150,168,0.10)'; // std-dev band fill
  const COLOR_AHEAD = 'rgba(234,88,12,0.11)';   // orange tint — spending more
  const COLOR_BELOW = 'rgba(5,150,105,0.11)';   // green tint — spending less

  const CARD_CSS = `
    :host { display: block; }

    ha-card {
      height: 100%;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      box-sizing: border-box;
    }

    .card-header {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      padding: 16px 16px 0;
      gap: 10px;
      flex-wrap: wrap;
    }
    .card-title {
      font-size: 1.1em;
      font-weight: 500;
      color: var(--primary-text-color);
    }
    .card-sub {
      font-size: 0.78em;
      color: var(--secondary-text-color);
      white-space: nowrap;
    }

    /* ── Summary strip ── */
    .summary {
      display: flex;
      gap: 20px;
      padding: 10px 16px 4px;
      flex-wrap: wrap;
    }
    .summary-item { display: flex; flex-direction: column; }
    .summary-label {
      font-size: 0.7em;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--secondary-text-color);
      font-weight: 600;
    }
    .summary-value {
      font-size: 1.3em;
      font-weight: 600;
      color: var(--primary-text-color);
      font-variant-numeric: tabular-nums;
      letter-spacing: -0.02em;
      line-height: 1.25;
    }
    .value-today { color: ${COLOR_TODAY}; }
    .value-ahead { color: ${COLOR_TODAY}; }
    .value-below { color: #059669; }

    /* ── Legend ── */
    .legend {
      display: flex;
      gap: 16px;
      padding: 0 16px 4px;
      flex-wrap: wrap;
    }
    .legend-item {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 0.78em;
      color: var(--secondary-text-color);
    }

    /* ── Chart ── */
    .chart-wrap {
      position: relative;
      padding: 4px 16px 12px;
      flex: 1;
    }
    canvas {
      width: 100%;
      height: 230px;
      display: block;
    }

    /* ── States ── */
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
      font-size: 0.9em;
      line-height: 1.55;
    }
    .state-box b { color: var(--primary-text-color); }
    .state-box.is-error { color: var(--error-color, #F44336); }
  `;

  // ── Utility: extract cost sources from energy prefs ──────────────────────
  // Returns [{mode, statId?}, {mode, energyStatId, price?}, {mode, energyStatId, priceStatId}]
  function extractCostSources(prefs) {
    const sources = [];
    if (!prefs?.energy_sources) return sources;
    for (const source of prefs.energy_sources) {
      if (source.type !== 'grid') continue;
      // HA nests per-tariff data in flow_from[]. Some versions/configs may
      // place the fields directly on the source object instead.
      const flows = Array.isArray(source.flow_from) && source.flow_from.length
        ? source.flow_from
        : [source];
      for (const flow of flows) {
        if (flow.stat_cost) {
          sources.push({ mode: 'stat', statId: flow.stat_cost });
        } else if (flow.stat_energy_from && flow.number_energy_price != null) {
          sources.push({ mode: 'fixed', energyStatId: flow.stat_energy_from, price: flow.number_energy_price });
        } else if (flow.stat_energy_from && flow.entity_energy_price) {
          sources.push({ mode: 'dynamic', energyStatId: flow.stat_energy_from, priceStatId: flow.entity_energy_price });
        }
      }
    }
    return sources;
  }

  // ── Utility: nice round number for y-axis ceiling ─────────────────────────
  function niceMax(raw) {
    if (raw <= 0) return 1;
    const mag  = Math.pow(10, Math.floor(Math.log10(raw)));
    const n    = raw / mag;
    const nice = n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10;
    return nice * mag;
  }

  // ─────────────────────────────────────────────────────────────────────────
  class EnergyCostCompareCard extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: 'open' });

      this._hass        = null;
      this._config      = {};
      this._prefs       = null;
      this._costSources = [];

      // Processed data
      this._todayCum    = [];   // cumulative £ per hour index, index = hour 0..currentHour
      this._avgCum      = [];   // average cumulative £ for full day [0..23]
      this._stdDevCum   = [];   // std dev of cumulative across historical days [0..23]
      this._currentHour = 0;
      this._currentMin  = 0;
      this._histDays    = 0;    // number of historical same-weekday days found
      this._weekdayName = '';

      this._loading     = false;
      this._error       = null;
      this._initialized = false;
      this._canvas      = null;
      this._ro          = null;
    }

    setConfig(config) {
      this._config = { title: 'Today vs Average', weeks: 5, ...config };
      if (this._initialized) this._reload();
    }

    set hass(hass) {
      this._hass = hass;
      if (!this._initialized) {
        this._initialized = true;
        this._boot();
      }
    }

    disconnectedCallback() {
      this._ro?.disconnect();
    }

    // ── Initialisation ────────────────────────────────────────────────────

    async _boot() {
      this._loading = true;
      this._renderShell();

      try {
        await this._loadPrefs();
        if (this._costSources.length > 0) await this._fetchAndProcess();
      } catch (err) {
        this._error = err.message || String(err);
        console.error('[energy-cost-compare-card]', err);
      }

      this._loading = false;
      this._render();
    }

    async _reload() {
      this._loading = true;
      this._render();
      try {
        if (!this._prefs) await this._loadPrefs();
        if (this._costSources.length > 0) await this._fetchAndProcess();
      } catch (err) {
        this._error = err.message || String(err);
      }
      this._loading = false;
      this._render();
    }

    async _loadPrefs() {
      try {
        this._prefs = await this._hass.callWS({ type: 'energy/get_prefs' });
        this._costSources = extractCostSources(this._prefs);
      } catch (_) {
        this._prefs = null;
        this._costSources = [];
      }
    }

    // ── Data fetching ─────────────────────────────────────────────────────

    async _fetchAndProcess() {
      const now  = new Date();
      const haTz = this._hass.config.time_zone ||
                   Intl.DateTimeFormat().resolvedOptions().timeZone;

      // Derive all time references from HA's configured timezone, not the
      // browser's local timezone. If someone accesses HA remotely from a
      // different timezone the two can diverge, causing today's recorder fetch
      // to start at the wrong UTC instant and the weekday to disagree with the
      // server's weekday computation (which uses dt_util.now()).
      const haParts = Object.fromEntries(
        new Intl.DateTimeFormat('en-US', {
          timeZone: haTz,
          hour: 'numeric', minute: 'numeric', second: 'numeric',
          hour12: false,
        }).formatToParts(now).map(({ type, value }) => [type, value])
      );

      this._currentHour = +haParts.hour % 24;  // % 24 guards the "24" edge case
      this._currentMin  = +haParts.minute;
      this._weekdayName = new Intl.DateTimeFormat(undefined, {
        timeZone: haTz, weekday: 'long',
      }).format(now);

      // UTC instant that equals midnight in HA's configured timezone
      const secsIntoDay = this._currentHour * 3600 + this._currentMin * 60 + +haParts.second;
      const todayMid    = new Date(now.getTime() - secsIntoDay * 1000);

      const weeks = Math.max(1, Math.min(12, +this._config.weeks || 5));

      // ── Determine which stat IDs to fetch for today ───────────────────
      const statSources    = this._costSources.filter(s => s.mode === 'stat');
      const energySources  = this._costSources.filter(s => s.mode !== 'stat');
      const dynamicSources = this._costSources.filter(s => s.mode === 'dynamic');

      const todayBase = {
        type: 'recorder/statistics_during_period',
        start_time: todayMid.toISOString(),
        end_time:   new Date(now.getTime() + 60_000).toISOString(),
        period: 'hour',
      };

      // ── Today's stats, energy stats, price stats and server average in parallel
      const [costRaw, energyRaw, priceRaw, histResult] = await Promise.all([
        statSources.length
          ? this._hass.callWS({ ...todayBase, statistic_ids: statSources.map(s => s.statId), types: ['change', 'sum'] })
          : {},
        energySources.length
          ? this._hass.callWS({ ...todayBase, statistic_ids: [...new Set(energySources.map(s => s.energyStatId))], types: ['change', 'sum'], units: { energy: 'kWh' } })
          : {},
        dynamicSources.length
          ? this._hass.callWS({ ...todayBase, statistic_ids: [...new Set(dynamicSources.map(s => s.priceStatId))], types: ['mean'], units: {} })
          : {},
        this._hass.callWS({ type: 'energy_cost_compare/weekday_average', weeks }),
      ]);

      // ── Build today's hourly cost totals ──────────────────────────────
      const todayHourly = new Array(24).fill(0);

      const rowTs   = r => r.start > 1e12 ? r.start : r.start * 1000;
      // Use offset from midnight so hour is in HA timezone, not browser local
      const rowHour = r => Math.floor((rowTs(r) - todayMid.getTime()) / 3_600_000);

      for (const src of this._costSources) {
        if (src.mode === 'stat') {
          const rows = (costRaw?.[src.statId] || []).sort((a, b) => a.start - b.start);
          let prevSum = null;
          for (const row of rows) {
            const h = rowHour(row);
            if (h >= 0 && h < 24) todayHourly[h] += this._rowCost(row, prevSum);
            prevSum = row.sum ?? prevSum;
          }
        } else {
          const rows = (energyRaw?.[src.energyStatId] || []).sort((a, b) => a.start - b.start);
          // Build per-hour mean price lookup for dynamic mode
          const priceLookup = src.mode === 'dynamic'
            ? new Map((priceRaw?.[src.priceStatId] || []).map(r => [rowTs(r), r.mean ?? 0]))
            : null;
          let prevSum = null;
          for (const row of rows) {
            const h = rowHour(row);
            const energyKwh = this._rowCost(row, prevSum);  // _rowCost gives delta kWh for energy rows too
            prevSum = row.sum ?? prevSum;
            if (h < 0 || h >= 24) continue;
            const rate = src.mode === 'fixed' ? src.price : (priceLookup.get(rowTs(row)) ?? 0);
            todayHourly[h] += energyKwh * rate;
          }
        }
      }

      // ── Today's cumulative ─────────────────────────────────────────────
      this._todayCum = [];
      let runTotal = 0;
      for (let h = 0; h <= this._currentHour; h++) {
        runTotal += todayHourly[h];
        this._todayCum.push(runTotal);
      }

      // ── Historical average — straight from the server response ─────────
      this._avgCum    = histResult.avg     || [];
      this._stdDevCum = histResult.std_dev || [];
      this._histDays  = histResult.day_count ?? 0;
    }

    // Cost for a single statistics row; falls back to sum delta if change absent
    _rowCost(row, prevSum) {
      let cost = row.change;
      if (cost == null) {
        cost = (prevSum != null && row.sum != null) ? row.sum - prevSum : 0;
      }
      return Math.max(0, cost || 0);
    }

    // ── Rendering ─────────────────────────────────────────────────────────

    _renderShell() {
      this.shadowRoot.innerHTML = `
        <style>${CARD_CSS}</style>
        <ha-card><div class="state-box">Loading…</div></ha-card>`;
    }

    _render() {
      const title  = this._config.title || 'Today vs Average';
      const weeks  = Math.max(1, Math.min(12, +this._config.weeks || 5));
      const avgLbl = this._histDays > 0
        ? `${this._histDays}-wk avg`
        : `${weeks}-wk avg`;

      let body;

      if (this._error) {
        body = `<div class="state-box is-error">⚠ ${this._error}</div>`;

      } else if (!this._prefs) {
        body = `<div class="state-box">
          <b>Energy not configured</b>
          Go to Settings → Energy to add your energy sources.
        </div>`;

      } else if (this._costSources.length === 0) {
        body = `<div class="state-box">
          <b>No cost data found</b>
          Add a price to your grid sources in Settings → Energy.
        </div>`;

      } else if (this._loading) {
        body = `<div class="state-box">Loading…</div>`;

      } else {
        const todayNow  = this._todayCum[this._todayCum.length - 1] ?? 0;
        const avgNow    = this._avgCum[this._currentHour] ?? 0;
        const delta     = todayNow - avgNow;
        const isAhead   = delta >= 0;
        const deltaSign = isAhead ? '+' : '−';
        const deltaAbs  = Math.abs(delta);
        const deltaClass = isAhead ? 'value-ahead' : 'value-below';

        const noHistory = this._histDays === 0;

        body = `
          <div class="summary">
            <div class="summary-item">
              <span class="summary-label">Today so far</span>
              <span class="summary-value value-today">${this._fmtCost(todayNow)}</span>
            </div>
            ${!noHistory ? `
            <div class="summary-item">
              <span class="summary-label">${avgLbl} at this time</span>
              <span class="summary-value">${this._fmtCost(avgNow)}</span>
            </div>
            <div class="summary-item">
              <span class="summary-label">Difference</span>
              <span class="summary-value ${deltaClass}">${deltaSign}${this._fmtCost(deltaAbs)}</span>
            </div>` : `
            <div class="summary-item" style="align-self:center">
              <span class="summary-label" style="font-size:0.8em">
                No ${this._weekdayName} data found in last ${weeks} weeks
              </span>
            </div>`}
          </div>

          <div class="legend">
            <div class="legend-item">
              <svg width="22" height="10" viewBox="0 0 22 10">
                <line x1="0" y1="5" x2="22" y2="5" stroke="${COLOR_TODAY}" stroke-width="2.5" stroke-linecap="round"/>
              </svg>
              <span>Today (${this._weekdayName})</span>
            </div>
            ${!noHistory ? `
            <div class="legend-item">
              <svg width="22" height="10" viewBox="0 0 22 10">
                <line x1="0" y1="5" x2="22" y2="5" stroke="${COLOR_AVG}" stroke-width="2"
                      stroke-dasharray="5 3" stroke-linecap="round"/>
              </svg>
              <span>${avgLbl} (full day)</span>
            </div>` : ''}
          </div>

          <div class="chart-wrap">
            <canvas id="cc"></canvas>
          </div>`;
      }

      this.shadowRoot.innerHTML = `
        <style>${CARD_CSS}</style>
        <ha-card>
          <div class="card-header">
            <span class="card-title">${title}</span>
            <span class="card-sub">cumulative · midnight = £0</span>
          </div>
          ${body}
        </ha-card>`;

      const canvas = this.shadowRoot.getElementById('cc');
      if (!canvas) return;

      this._canvas = canvas;
      this._ro?.disconnect();
      this._ro = new ResizeObserver(() => this._draw());
      this._ro.observe(canvas);
      this._draw();
    }

    // ── Chart drawing ─────────────────────────────────────────────────────

    _draw() {
      const canvas = this._canvas;
      if (!canvas) return;

      const dpr = window.devicePixelRatio || 1;
      const W   = canvas.offsetWidth;
      const H   = canvas.offsetHeight;
      if (W === 0 || H === 0) return;

      canvas.width  = W * dpr;
      canvas.height = H * dpr;

      const ctx = canvas.getContext('2d');
      ctx.scale(dpr, dpr);

      // Layout margins
      const ml = 58, mr = 12, mt = 12, mb = 32;
      const cw = W - ml - mr;
      const ch = H - mt - mb;

      // Y scale: cover both today and avg (+ std dev band)
      const allVals = [
        ...this._todayCum,
        ...this._avgCum,
        ...this._avgCum.map((v, h) => v + (this._stdDevCum[h] || 0)),
      ];
      const rawMax = allVals.length ? Math.max(...allVals) : 1;
      const yMax   = niceMax(rawMax * 1.12);

      // Coordinate helpers
      // X: hour 0..23 mapped across [ml .. ml+cw], fractional hours supported
      const toX = (h) => ml + (h / 24) * cw;
      const toY = (v) => mt + ch - (v / yMax) * ch;

      // ── Gridlines + Y-axis labels ───────────────────────────────────────
      const ticks = 4;
      for (let i = 0; i <= ticks; i++) {
        const v = (i / ticks) * yMax;
        const y = toY(v);

        ctx.strokeStyle = 'rgba(136,150,168,0.25)';
        ctx.lineWidth   = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(ml, y);
        ctx.lineTo(ml + cw, y);
        ctx.stroke();

        ctx.fillStyle  = '#6B7590';
        ctx.font       = '10px system-ui,-apple-system,sans-serif';
        ctx.textAlign  = 'right';
        ctx.textBaseline = 'middle';
        ctx.setLineDash([]);
        ctx.fillText(this._fmtCostShort(v), ml - 5, y);
      }

      // ── X-axis: every 3 hours ───────────────────────────────────────────
      for (let h = 0; h <= 24; h += 3) {
        const x = toX(h);

        ctx.strokeStyle = 'rgba(136,150,168,0.15)';
        ctx.lineWidth   = 1;
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(x, mt);
        ctx.lineTo(x, mt + ch);
        ctx.stroke();

        if (h < 24) {
          ctx.fillStyle    = '#6B7590';
          ctx.font         = '10px system-ui,-apple-system,sans-serif';
          ctx.textAlign    = 'center';
          ctx.textBaseline = 'top';
          ctx.fillText(`${String(h).padStart(2, '0')}:00`, x, mt + ch + 6);
        }
      }

      // ── Axes ────────────────────────────────────────────────────────────
      ctx.strokeStyle = 'rgba(136,150,168,0.3)';
      ctx.lineWidth   = 1;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(ml, mt);
      ctx.lineTo(ml, mt + ch);
      ctx.lineTo(ml + cw, mt + ch);
      ctx.stroke();

      // ── Std-dev confidence band ──────────────────────────────────────────
      if (this._avgCum.length > 0 && this._stdDevCum.length > 0) {
        ctx.beginPath();
        this._avgCum.forEach((v, h) => {
          const x = toX(h + 0.5); // centre of each hour slot
          const y = toY(v + this._stdDevCum[h]);
          h === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        });
        for (let h = 23; h >= 0; h--) {
          ctx.lineTo(toX(h + 0.5), toY(this._avgCum[h] - this._stdDevCum[h]));
        }
        ctx.closePath();
        ctx.fillStyle = COLOR_BAND;
        ctx.fill();
      }

      // ── Fill between today and avg (coloured by ahead/behind) ───────────
      if (this._todayCum.length > 0 && this._avgCum.length > 0) {
        const n        = this._todayCum.length; // hours we have for today (0..currentHour)
        const lastToday = this._todayCum[n - 1] ?? 0;
        const lastAvg   = this._avgCum[n - 1]   ?? 0;

        ctx.beginPath();
        this._todayCum.forEach((v, i) => {
          // today points are at toX(h) where h = i
          const x = toX(i + 0.5);
          i === 0 ? ctx.moveTo(x, toY(v)) : ctx.lineTo(x, toY(v));
        });
        // Close the shape back along the average line
        for (let i = n - 1; i >= 0; i--) {
          ctx.lineTo(toX(i + 0.5), toY(this._avgCum[i]));
        }
        ctx.closePath();
        ctx.fillStyle = lastToday >= lastAvg ? COLOR_AHEAD : COLOR_BELOW;
        ctx.fill();
      }

      // ── Historical average line (dashed, full day 0–23) ─────────────────
      if (this._avgCum.length > 0) {
        this._drawLine(ctx, this._avgCum.map((v, h) => ({
          x: toX(h + 0.5), y: toY(v),
        })), { color: COLOR_AVG, lineWidth: 1.5, dash: [5, 3] });
      }

      // ── Today's line (solid, 0..currentHour + minute fraction) ──────────
      if (this._todayCum.length > 0) {
        const todayPts = this._todayCum.map((v, i) => {
          // Last point gets sub-hour precision
          const fractH = i === this._currentHour
            ? i + this._currentMin / 60
            : i;
          return { x: toX(fractH + 0.5), y: toY(v) };
        });

        this._drawLine(ctx, todayPts, { color: COLOR_TODAY, lineWidth: 2.5, dash: [] });

        // Live dot at current position
        const last = todayPts[todayPts.length - 1];
        ctx.beginPath();
        ctx.arc(last.x, last.y, 4.5, 0, Math.PI * 2);
        ctx.fillStyle   = COLOR_TODAY;
        ctx.fill();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth   = 1.5;
        ctx.setLineDash([]);
        ctx.stroke();
      }

      // ── "Now" vertical marker ────────────────────────────────────────────
      {
        const nowX = toX(this._currentHour + this._currentMin / 60 + 0.5);
        ctx.strokeStyle = 'rgba(234,88,12,0.25)';
        ctx.lineWidth   = 1;
        ctx.setLineDash([3, 4]);
        ctx.beginPath();
        ctx.moveTo(nowX, mt);
        ctx.lineTo(nowX, mt + ch);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    _drawLine(ctx, points, { color, lineWidth, dash }) {
      if (points.length < 2) return;
      ctx.beginPath();
      ctx.strokeStyle = color;
      ctx.lineWidth   = lineWidth;
      ctx.lineJoin    = 'round';
      ctx.lineCap     = 'round';
      ctx.setLineDash(dash || []);
      points.forEach((pt, i) => i === 0 ? ctx.moveTo(pt.x, pt.y) : ctx.lineTo(pt.x, pt.y));
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // ── Formatting ────────────────────────────────────────────────────────

    _fmtCost(v) {
      const currency = this._hass?.config?.currency || 'GBP';
      try {
        return new Intl.NumberFormat(undefined, {
          style: 'currency', currency,
          minimumFractionDigits: 2, maximumFractionDigits: 2,
        }).format(v);
      } catch (_) {
        return `£${v.toFixed(2)}`;
      }
    }

    // Compact form for y-axis tick labels
    _fmtCostShort(v) {
      const currency = this._hass?.config?.currency || 'GBP';
      if (v === 0) return '0';
      const dec = v < 5 ? 2 : 0;
      try {
        return new Intl.NumberFormat(undefined, {
          style: 'currency', currency,
          minimumFractionDigits: dec, maximumFractionDigits: dec,
        }).format(v);
      } catch (_) {
        return `£${v.toFixed(dec)}`;
      }
    }
  }

  // ── Register ──────────────────────────────────────────────────────────────
  customElements.define('energy-cost-compare-card', EnergyCostCompareCard);

  window.customCards = window.customCards || [];
  window.customCards.push({
    type: 'energy-cost-compare-card',
    name: 'Energy Cost Compare',
    description: 'Cumulative cost today vs same-weekday average — shows whether you are tracking ahead or behind.',
    preview: false,
  });

  console.info(
    '%c ENERGY-COST-COMPARE-CARD %c v' + VERSION + ' ',
    'color:#fff;background:#EA580C;font-weight:700;padding:2px 4px;border-radius:3px 0 0 3px',
    'color:#EA580C;background:#fff;font-weight:700;padding:2px 4px;border-radius:0 3px 3px 0',
  );
})();
