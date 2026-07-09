# HA Energy Cost Cards

Two custom Lovelace cards for Home Assistant that display **energy cost (£/$/€)** rather than kWh.

## Prerequisites

- Home Assistant **2022.12** or later
- Energy configured in **Settings → Energy** with at least one grid tariff that generates `stat_cost` statistics
- The [Energy Cost Compare integration](https://github.com/mr-miles/ha-energy-cost-comparison) installed (required for the compare card only)

---

## Cards

### Energy Cost Graph Card

A bar chart of energy cost per period — a drop-in replacement for the built-in "Energy usage" tile with money on the Y-axis instead of kWh. When placed on the Energy Dashboard it syncs automatically with the dashboard's native date picker.

```yaml
type: custom:energy-cost-graph-card
title: Energy Cost   # optional
period: day          # day | week | month | year  (default: day)
```

### Energy Cost Compare Card

A line chart comparing today's cumulative cost from midnight against the historical average for the same weekday over the last N weeks. Includes a standard-deviation band and a live "now" marker.

> Requires the [Energy Cost Compare](https://github.com/mr-miles/ha-energy-cost-comparison) integration.

```yaml
type: custom:energy-cost-compare-card
title: Cost vs Average   # optional
weeks: 5                 # weeks of history to average, 1–12  (default: 5)
```

---

## Installation

### Via HACS

1. HACS → ⋮ → **Custom repositories**
2. URL: `https://github.com/mr-miles/ha-energy-cost-comparison-frontend` · Category: **Dashboard** → Add
3. Find **Energy Cost Cards** → **Download**

HACS installs `energy-cost-cards.js`, which registers both cards in one resource.

### Manually

1. Download `energy-cost-cards.js` from the [latest release](https://github.com/mr-miles/ha-energy-cost-comparison-frontend/releases/latest)
2. Copy it to `/config/www/`
3. **Settings → Dashboards → ⋮ → Resources → Add resource**
   - URL: `/local/energy-cost-cards.js` · Type: JavaScript module
