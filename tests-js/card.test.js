'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  rowTs,
  extractCostSeries,
  deltaRows,
  computeCostValues,
  extractCostSources,
} = require('./card-functions.js');

// ── Fixtures ─────────────────────────────────────────────────────────────────

// Unix timestamps in SECONDS as HA recorder actually returns them
const T0 = 1705017600; // 2024-01-12 00:00:00 UTC
const T1 = 1705021200; // 2024-01-12 01:00:00 UTC
const T2 = 1705024800; // 2024-01-12 02:00:00 UTC

const ENERGY_ID = 'sensor.octopus_cosy_cheap';
const PRICE_ID  = 'sensor.octopus_energy_electricity_rate';
const COST_ID   = 'sensor.energy_cost';

// Octopus Energy / dynamic-rate prefs (stat_cost is null)
const OCTOPUS_PREFS = {
  energy_sources: [{
    type: 'grid',
    flow_from: [{
      stat_cost:           null,
      stat_energy_from:    ENERGY_ID,
      number_energy_price: null,
      entity_energy_price: PRICE_ID,
    }],
  }],
};

// Fixed-rate prefs
const FIXED_PREFS = {
  energy_sources: [{
    type: 'grid',
    flow_from: [{ stat_cost: null, stat_energy_from: ENERGY_ID, number_energy_price: 0.28, entity_energy_price: null }],
  }],
};

// Stat-based prefs (pre-recorded cost)
const STAT_PREFS = {
  energy_sources: [{
    type: 'grid',
    flow_from: [{ stat_cost: COST_ID, stat_energy_from: ENERGY_ID, number_energy_price: null, entity_energy_price: null }],
  }],
};

// ── rowTs ─────────────────────────────────────────────────────────────────────

describe('rowTs', () => {
  it('converts seconds to milliseconds', () => {
    assert.equal(rowTs({ start: T0 }), T0 * 1000);
  });

  it('leaves milliseconds alone', () => {
    const ms = T0 * 1000;
    assert.equal(rowTs({ start: ms }), ms);
  });
});

// ── extractCostSeries (graph card) ───────────────────────────────────────────

describe('extractCostSeries', () => {
  it('returns dynamic series for Octopus-style prefs (stat_cost null)', () => {
    const series = extractCostSeries(OCTOPUS_PREFS);
    assert.equal(series.length, 1);
    assert.equal(series[0].mode, 'dynamic');
    assert.equal(series[0].energyStatId, ENERGY_ID);
    assert.equal(series[0].priceStatId, PRICE_ID);
    assert.equal(series[0].key, ENERGY_ID);
  });

  it('returns fixed series for fixed-rate prefs', () => {
    const series = extractCostSeries(FIXED_PREFS);
    assert.equal(series.length, 1);
    assert.equal(series[0].mode, 'fixed');
    assert.equal(series[0].price, 0.28);
  });

  it('returns stat series for pre-recorded cost prefs', () => {
    const series = extractCostSeries(STAT_PREFS);
    assert.equal(series.length, 1);
    assert.equal(series[0].mode, 'stat');
    assert.equal(series[0].statId, COST_ID);
    assert.equal(series[0].key, COST_ID);
  });

  it('skips non-grid sources', () => {
    const prefs = {
      energy_sources: [
        { type: 'solar', flow_from: [{ stat_cost: 'sensor.solar_cost' }] },
        OCTOPUS_PREFS.energy_sources[0],
      ],
    };
    const series = extractCostSeries(prefs);
    assert.equal(series.length, 1);
    assert.equal(series[0].mode, 'dynamic');
  });

  it('returns empty for null prefs', () => {
    assert.deepEqual(extractCostSeries(null), []);
  });

  it('handles flat source structure (fields directly on source, no flow_from array)', () => {
    // Some HA versions / configs place the fields directly on the source object
    // rather than inside a nested flow_from array. This was the root cause of
    // _costSeries being empty for Octopus Energy users.
    const prefs = {
      energy_sources: [{
        type: 'grid',
        stat_cost: null,
        stat_energy_from: ENERGY_ID,
        number_energy_price: null,
        entity_energy_price: PRICE_ID,
      }],
    };
    const series = extractCostSeries(prefs);
    assert.equal(series.length, 1);
    assert.equal(series[0].mode, 'dynamic');
    assert.equal(series[0].energyStatId, ENERGY_ID);
    assert.equal(series[0].priceStatId, PRICE_ID);
  });

  it('skips flow with no cost info', () => {
    const prefs = {
      energy_sources: [{
        type: 'grid',
        flow_from: [{ stat_cost: null, stat_energy_from: null, number_energy_price: null, entity_energy_price: null }],
      }],
    };
    assert.deepEqual(extractCostSeries(prefs), []);
  });
});

// ── deltaRows ─────────────────────────────────────────────────────────────────

describe('deltaRows', () => {
  it('uses change field when present', () => {
    const rows = [
      { start: T0, change: 2.5, sum: 10.0 },
      { start: T1, change: 1.5, sum: 11.5 },
    ];
    const deltas = deltaRows(rows);
    assert.equal(deltas[0].value, 2.5);
    assert.equal(deltas[1].value, 1.5);
  });

  it('falls back to sum delta when change absent', () => {
    const rows = [
      { start: T0, sum: 10.0 },
      { start: T1, sum: 12.0 },
      { start: T2, sum: 13.5 },
    ];
    const deltas = deltaRows(rows);
    assert.equal(deltas[0].value, 0);     // no previous sum, delta = 0
    assert.equal(deltas[1].value, 2.0);
    assert.equal(deltas[2].value, 1.5);
  });

  it('converts start seconds to ms timestamps', () => {
    const rows = [{ start: T0, change: 1 }];
    assert.equal(deltaRows(rows)[0].ts, T0 * 1000);
  });

  it('handles empty input', () => {
    assert.deepEqual(deltaRows([]), []);
  });
});

// ── computeCostValues ─────────────────────────────────────────────────────────

describe('computeCostValues — stat mode', () => {
  it('returns cost deltas directly from costData', () => {
    const series = { mode: 'stat', statId: COST_ID };
    const costData = { [COST_ID]: [{ start: T0, change: 3.5 }] };
    const vals = computeCostValues(series, costData, {}, {});
    assert.equal(vals[0].value, 3.5);
    assert.equal(vals[0].ts, T0 * 1000);
  });
});

describe('computeCostValues — fixed mode', () => {
  it('multiplies energy by fixed price', () => {
    const series = { mode: 'fixed', energyStatId: ENERGY_ID, price: 0.30 };
    const energyData = { [ENERGY_ID]: [{ start: T0, change: 4.0 }] }; // 4 kWh
    const vals = computeCostValues(series, {}, energyData, {});
    assert.ok(Math.abs(vals[0].value - 1.20) < 1e-9, `expected 1.20, got ${vals[0].value}`);
  });
});

describe('computeCostValues — dynamic mode', () => {
  it('multiplies energy by mean rate using matching timestamps', () => {
    const series = { mode: 'dynamic', energyStatId: ENERGY_ID, priceStatId: PRICE_ID };
    const energyData = { [ENERGY_ID]: [{ start: T0, change: 4.0 }, { start: T1, change: 2.0 }] };
    const priceData  = { [PRICE_ID]:  [{ start: T0, mean: 0.25  }, { start: T1, mean: 0.30  }] };
    const vals = computeCostValues(series, {}, energyData, priceData);
    assert.ok(Math.abs(vals[0].value - 1.00) < 1e-9, `h0: expected 1.00, got ${vals[0].value}`);
    assert.ok(Math.abs(vals[1].value - 0.60) < 1e-9, `h1: expected 0.60, got ${vals[1].value}`);
  });

  it('gives zero cost when price stat is missing for that hour', () => {
    const series = { mode: 'dynamic', energyStatId: ENERGY_ID, priceStatId: PRICE_ID };
    const energyData = { [ENERGY_ID]: [{ start: T0, change: 4.0 }] };
    const priceData  = { [PRICE_ID]:  [] };   // no data
    const vals = computeCostValues(series, {}, energyData, priceData);
    assert.equal(vals[0].value, 0);
  });

  it('gives zero cost when priceData dict is missing the stat entirely', () => {
    const series = { mode: 'dynamic', energyStatId: ENERGY_ID, priceStatId: PRICE_ID };
    const energyData = { [ENERGY_ID]: [{ start: T0, change: 4.0 }] };
    const vals = computeCostValues(series, {}, energyData, {});
    assert.equal(vals[0].value, 0);
  });

  it('handles energy rows with sum fallback alongside price rows with mean', () => {
    const series = { mode: 'dynamic', energyStatId: ENERGY_ID, priceStatId: PRICE_ID };
    const energyData = { [ENERGY_ID]: [
      { start: T0, sum: 100.0 },   // no change; delta will be 0 (no prev)
      { start: T1, sum: 102.0 },   // delta = 2 kWh
    ]};
    const priceData = { [PRICE_ID]: [
      { start: T0, mean: 0.25 },
      { start: T1, mean: 0.25 },
    ]};
    const vals = computeCostValues(series, {}, energyData, priceData);
    assert.equal(vals[0].value, 0);      // first row: delta = 0
    assert.ok(Math.abs(vals[1].value - 0.50) < 1e-9);  // 2 kWh × £0.25
  });
});

// ── extractCostSources (compare card) ────────────────────────────────────────

describe('extractCostSources', () => {
  it('handles flat source structure (no flow_from nesting)', () => {
    const prefs = {
      energy_sources: [{
        type: 'grid',
        stat_cost: null,
        stat_energy_from: ENERGY_ID,
        number_energy_price: null,
        entity_energy_price: PRICE_ID,
      }],
    };
    const [s] = extractCostSources(prefs);
    assert.equal(s.mode, 'dynamic');
    assert.equal(s.energyStatId, ENERGY_ID);
  });

  it('returns dynamic source for Octopus prefs', () => {
    const sources = extractCostSources(OCTOPUS_PREFS);
    assert.equal(sources.length, 1);
    assert.equal(sources[0].mode, 'dynamic');
    assert.equal(sources[0].energyStatId, ENERGY_ID);
    assert.equal(sources[0].priceStatId, PRICE_ID);
  });

  it('returns fixed source', () => {
    const [s] = extractCostSources(FIXED_PREFS);
    assert.equal(s.mode, 'fixed');
    assert.equal(s.price, 0.28);
  });

  it('returns stat source', () => {
    const [s] = extractCostSources(STAT_PREFS);
    assert.equal(s.mode, 'stat');
    assert.equal(s.statId, COST_ID);
  });
});
