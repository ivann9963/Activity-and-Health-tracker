// === CHARTS ===
// Inline SVG, no library. Every chart here plots one series, so none of them carry a
// legend — the heading above says what is being shown, and a box with a single swatch
// would only restate it.
//
// Shared conventions: marks are thin and capped, the data-end is rounded while the
// baseline stays square, touching bars are separated by a gap in the surface colour
// rather than a stroke, gridlines are hairline and solid, and no text ever wears the
// data colour.

const CHART = {
  barMax: 24,      // a bar never fills its slot; the leftover is deliberate air
  barGap: 2,       // separation is a gap in the surface, never a border
  radius: 4,       // rounded data-end only
  gridColor: 'var(--border)',
  axisText: 'var(--text-dim)'
};

function svgEl(tag, attrs) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, v);
  return node;
}

// A bar with a rounded top and a square base, drawn as a path so the two ends can
// differ. Rounding both ends would detach the mark from its baseline.
function barPath(x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h);
  if (h <= 0.5) return '';
  return `M${x},${y + h}`
       + `V${y + radius}`
       + `Q${x},${y} ${x + radius},${y}`
       + `H${x + w - radius}`
       + `Q${x + w},${y} ${x + w},${y + radius}`
       + `V${y + h}Z`;
}

// Columns over time — months of a year, days of a month. `data` is
// [{ label, value, title }]; `format` renders a value for the axis and tooltips.
function columnChart(data, opts) {
  const o = opts || {};
  const width = o.width || 640;
  const height = o.height || 180;
  const padBottom = 22;
  const padTop = 10;
  const format = o.format || (v => String(Math.round(v)));

  const max = Math.max(...data.map(d => d.value || 0), 0);
  const scaleMax = niceCeiling(max);

  // Three gridlines is enough to read a value against; more is chrome competing with
  // the data.
  const tickValues = [0, 0.5, 1].map(f => f * scaleMax);

  // The left gutter is measured from the widest tick label rather than fixed, so
  // "20k" and "1,250 km" both fit instead of being clipped at the edge.
  const widestTick = Math.max(...tickValues.map(v => String(format(v, true)).length));
  const leftPad = o.padLeft != null ? o.padLeft : Math.max(28, widestTick * 6.5 + 12);

  const plotW = width - leftPad - 8;
  const plotH = height - padBottom - padTop;

  const svg = svgEl('svg', {
    viewBox: `0 0 ${width} ${height}`,
    class: 'chart',
    role: 'img',
    'aria-label': o.ariaLabel || 'Column chart'
  });

  // Solid and hairline — dashing reads as noise.
  for (const tick of tickValues) {
    const y = padTop + plotH - (scaleMax ? (tick / scaleMax) * plotH : 0);
    svg.appendChild(svgEl('line', {
      x1: leftPad, x2: width - 8, y1: y, y2: y,
      stroke: CHART.gridColor, 'stroke-width': 1
    }));
    const label = svgEl('text', {
      x: leftPad - 8, y: y + 4, 'text-anchor': 'end',
      class: 'chart-tick', fill: CHART.axisText
    });
    label.textContent = format(tick, true);
    svg.appendChild(label);
  }

  const slot = plotW / data.length;
  const barW = Math.min(CHART.barMax, Math.max(2, slot - CHART.barGap));

  data.forEach((d, i) => {
    const value = d.value || 0;
    const h = scaleMax ? (value / scaleMax) * plotH : 0;
    const x = leftPad + i * slot + (slot - barW) / 2;
    const y = padTop + plotH - h;

    if (h > 0.5) {
      const bar = svgEl('path', {
        d: barPath(x, y, barW, h, CHART.radius),
        fill: 'var(--accent)',
        class: 'chart-bar'
      });
      const title = svgEl('title');
      title.textContent = d.title || `${d.label}: ${format(value)}`;
      bar.appendChild(title);
      svg.appendChild(bar);
    } else {
      // An empty slot still gets a hit target, so hovering a gap explains itself
      // rather than doing nothing.
      const hit = svgEl('rect', {
        x, y: padTop, width: barW, height: plotH, fill: 'transparent'
      });
      const title = svgEl('title');
      title.textContent = d.title || `${d.label}: nothing recorded`;
      hit.appendChild(title);
      svg.appendChild(hit);
    }

    // Label every other column when they would otherwise collide.
    const stride = slot < 26 ? 2 : 1;
    if (i % stride === 0) {
      const label = svgEl('text', {
        x: leftPad + i * slot + slot / 2, y: height - 6,
        'text-anchor': 'middle', class: 'chart-tick', fill: CHART.axisText
      });
      label.textContent = d.label;
      svg.appendChild(label);
    }
  });

  return svg;
}

// Round an axis maximum up to something readable, so ticks are 0 / 250 / 500 rather
// than 0 / 237.5 / 475.
function niceCeiling(value) {
  if (!value || !isFinite(value) || value <= 0) return 0;
  const magnitude = Math.pow(10, Math.floor(Math.log10(value)));
  const normalised = value / magnitude;
  const step = normalised <= 1 ? 1 : normalised <= 2 ? 2 : normalised <= 5 ? 5 : 10;
  return step * magnitude;
}

// A year of days as a grid, one column per week. Magnitude is carried by a single
// hue getting darker (lighter, on a dark surface) — never a rainbow, and never a
// second hue.
function calendarHeatmap(byDay, year, opts) {
  const o = opts || {};
  const cell = o.cell || 11;
  const gap = 2;
  const firstDay = o.firstDayOfWeek || 'monday';
  const format = o.format || (v => String(Math.round(v)));

  const from = `${year}-01-01`;
  const to = `${year}-12-31`;
  const start = startOfWeek(from, firstDay);
  const end = endOfWeek(to, firstDay);
  const days = dateRange(start, end);
  const weeks = Math.ceil(days.length / 7);

  // Scale against a high percentile rather than the maximum: one exceptional day
  // would otherwise flatten the entire rest of the year into the palest step.
  const values = Object.entries(byDay)
    .filter(([d, v]) => d >= from && d <= to && v > 0)
    .map(([, v]) => v)
    .sort((a, b) => a - b);
  const ceiling = values.length ? values[Math.floor(values.length * 0.9)] : 0;

  const width = weeks * (cell + gap);
  const height = 7 * (cell + gap) + 16;
  const svg = svgEl('svg', {
    viewBox: `0 0 ${width} ${height}`,
    class: 'chart heatmap',
    role: 'img',
    'aria-label': o.ariaLabel || `Daily activity through ${year}`
  });

  let lastMonth = null;
  days.forEach((day, i) => {
    const week = Math.floor(i / 7);
    const dow = i % 7;
    const inYear = day >= from && day <= to;
    const value = inYear ? (byDay[day] || 0) : null;

    // Five steps: past about seven, adjacent classes stop being distinguishable.
    let level = 0;
    if (value > 0 && ceiling > 0) level = Math.min(4, Math.ceil((value / ceiling) * 4));
    else if (value > 0) level = 4;

    const rect = svgEl('rect', {
      x: week * (cell + gap), y: dow * (cell + gap) + 14,
      width: cell, height: cell, rx: 2,
      fill: inYear ? `var(--heat-${level})` : 'transparent',
      class: 'heat-cell'
    });
    if (inYear) {
      const title = svgEl('title');
      title.textContent = value > 0 ? `${day}: ${format(value)}` : `${day}: nothing recorded`;
      rect.appendChild(title);
    }
    svg.appendChild(rect);

    // One month label at the week where each month starts.
    const month = day.slice(0, 7);
    if (inYear && month !== lastMonth && dow === 0) {
      lastMonth = month;
      const label = svgEl('text', {
        x: week * (cell + gap), y: 9, class: 'chart-tick', fill: CHART.axisText
      });
      label.textContent = new Date(dateKeyToMs(day))
        .toLocaleDateString(undefined, { month: 'short', timeZone: 'UTC' });
      svg.appendChild(label);
    }
  });

  return svg;
}

// The heatmap's scale, shown as steps rather than a continuous bar so each level in
// the grid has a visible counterpart.
function heatmapLegend() {
  const wrap = document.createElement('div');
  wrap.className = 'heat-legend';
  wrap.innerHTML = `<span class="subtle">Less</span>` +
    [1, 2, 3, 4].map(l => `<i class="heat-swatch" style="background:var(--heat-${l})"></i>`).join('') +
    `<span class="subtle">More</span>`;
  return wrap;
}

if (typeof module !== 'undefined') {
  module.exports = { niceCeiling, barPath };
}
