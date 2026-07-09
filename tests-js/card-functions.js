/**
 * Pure functions extracted from the card files for unit testing.
 * These are the ones most likely to have bugs without browser deployment.
 */
'use strict';

// ── Shared ──────────────────────────────────────────────────────────────────

/**
 * Convert a statistics row's `start` field to milliseconds.
 * HA recorder returns start as a Unix timestamp in SECONDS; some older
 * versions may return milliseconds. The heuristic: > 1e12 means already ms.
 */
function rowTs(row) {
  return row.start > 1e12 ? row.start : row.start * 1000;
}

// ── From energy-cost-graph-card.js ──────────────────────────────────────────

/**
 * Extract cost series from energy prefs.
 * Returns [{key, mode, statId?, energyStatId?, priceStatId?, price?, label, color}]
 */
function extractCostSeries(prefs, hassStates = {}) {
  const COLORS = ['#F44336', '#FF9800', '#9C27B0', '#2196F3'];
  const series = [];
  if (!prefs?.energy_sources) return series;
  let colorIdx = 0;
  for (const source of prefs.energy_sources) {
    if (source.type !== 'grid') continue;
    const flows = Array.isArray(source.flow_from) && source.flow_from.length
      ? source.flow_from
      : [source];
    for (const flow of flows) {
      const entityId = flow.stat_energy_from;
      const friendlyName = entityId && hassStates?.[entityId]?.attributes?.friendly_name;
      const label = friendlyName || (series.length === 0 ? 'Electricity' : `Tariff ${series.length + 1}`);
      const color = COLORS[colorIdx++ % COLORS.length];

      if (flow.stat_cost) {
        series.push({ key: flow.stat_cost, mode: 'stat', statId: flow.stat_cost, label, color });
      } else if (flow.stat_energy_from && flow.number_energy_price != null) {
        series.push({ key: flow.stat_energy_from, mode: 'fixed', energyStatId: flow.stat_energy_from, price: flow.number_energy_price, label, color });
      } else if (flow.stat_energy_from && flow.entity_energy_price) {
        series.push({ key: flow.stat_energy_from, mode: 'dynamic', energyStatId: flow.stat_energy_from, priceStatId: flow.entity_energy_price, label, color });
      }
    }
  }
  return series;
}

/**
 * Convert a list of statistics rows to {ts, value} deltas.
 * Prefers 'change' field; falls back to sum delta.
 */
function deltaRows(rows) {
  const result = [];
  let prevSum = null;
  for (const row of rows) {
    const ts = rowTs(row);
    const value = row.change ?? ((row.sum != null && prevSum != null) ? row.sum - prevSum : 0);
    prevSum = row.sum ?? prevSum;
    result.push({ ts, value });
  }
  return result;
}

/**
 * Compute {ts, value} cost pairs for a single series.
 */
function computeCostValues(series, costData, energyData, priceData) {
  if (series.mode === 'stat') {
    return deltaRows(costData?.[series.statId] || []);
  }
  const energyDeltas = deltaRows(energyData?.[series.energyStatId] || []);
  if (series.mode === 'fixed') {
    return energyDeltas.map(({ ts, value }) => ({ ts, value: value * series.price }));
  }
  // dynamic: energy × mean rate per period
  const priceLookup = new Map(
    (priceData?.[series.priceStatId] || []).map(r => [rowTs(r), r.mean ?? 0])
  );
  return energyDeltas.map(({ ts, value }) => ({ ts, value: value * (priceLookup.get(ts) ?? 0) }));
}

// ── From energy-cost-compare-card.js ────────────────────────────────────────

/**
 * Extract cost sources from energy prefs (compare card variant).
 * Returns [{mode, statId?}, {mode, energyStatId, price?}, {mode, energyStatId, priceStatId}]
 */
function extractCostSources(prefs) {
  const sources = [];
  if (!prefs?.energy_sources) return sources;
  for (const source of prefs.energy_sources) {
    if (source.type !== 'grid') continue;
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

module.exports = {
  rowTs,
  extractCostSeries,
  deltaRows,
  computeCostValues,
  extractCostSources,
};
