// === TARGETS AND RECORDS — SCREEN ===
// The cards that answer "how often did I actually do it" and "what is the best I
// have ever done". Both live on Insights because both cut across metrics, and both
// are read far more often than they are configured — the configuring is in Settings.

// A target is stored in whatever unit the metric is stored in; a person types hours
// and kilometres. The same scale the period goals use, so a target and a goal never
// disagree about what "1.5" means.
function targetScale(id) {
  const m = METRICS[id];
  if (!m) return 1;
  if (m.display === 'km') return 1000;
  if (m.display === 'duration') return m.unit === 'min' ? 60 : 3600;
  return 1;
}

function targetUnitLabel(id) {
  const m = METRICS[id];
  if (!m) return '';
  if (m.display === 'km') return 'km';
  if (m.display === 'duration') return 'hours';
  if (id === 'resting_hr') return 'bpm';
  if (id === 'weight') return 'kg';
  return '';
}

// "7h 00m or more", "60 bpm or less" — the bar, written the way the value is written
// everywhere else so the two are comparable at a glance.
function targetRule(id, threshold, comparison) {
  const formatted = formatMetric(id, threshold);
  return comparison === 'atMost' ? `${formatted} or less` : `${formatted} or more`;
}

function targetsCardHtml(rows) {
  if (!rows.length) {
    return `<div class="card">
      <h2>Daily targets</h2>
      <p class="subtle">A target is a standard a single day either meets or misses —
         seven hours of sleep, an hour of training. Set one and this counts the days
         that cleared it, and the longest run of them.</p>
      <div class="card-actions">
        <button class="btn btn-ghost btn-small" onclick="navigate('settings')">
          ${icon('target', 16)} Set a target</button>
      </div>
    </div>`;
  }

  return `<div class="card">
    <h2>Daily targets</h2>
    <p class="subtle">Days that cleared the bar in this period, and the longest run
       of them.</p>
    ${rows.map(r => {
      const pct = Math.max(0, Math.min(100, r.result.pct));
      return `<div class="target-row">
        <span class="target-icon">${iconOrText(METRICS[r.metricId].icon, 18)}</span>
        <span class="target-name">${escHtml(METRICS[r.metricId].label)}</span>
        <span class="target-rule">${escHtml(targetRule(r.metricId, r.threshold, r.comparison))}</span>
        <span class="target-count"><strong data-count>${r.result.met}</strong>/${r.result.total}</span>
        <div class="target-track"><div class="target-fill ${r.result.met ? '' : 'is-zero'}"
             style="width:${pct.toFixed(1)}%"></div></div>
        <span class="target-note">
          ${r.result.longest
            ? `best run ${plural(r.result.longest, 'day')}`
            : 'not met yet'}${r.result.current
            ? ` · on ${plural(r.result.current, 'day')} now` : ''}
        </span>
      </div>`;
    }).join('')}
    <details class="why"><summary>How a day is judged</summary>
      <p class="subtle">A day meets the target when its figure clears the bar. A day
         with no reading at all never counts as met — for a ceiling like resting heart
         rate, silence is not success.</p>
      <p class="subtle">Today never breaks a run: the day is not over. Targets are set
         under Settings → Daily targets.</p>
    </details>
  </div>`;
}

function recordsCardHtml(groups) {
  if (!groups.length) return '';
  return `<div class="card">
    <h2>Records</h2>
    <p class="subtle">The best single effort of each kind, all time — not the best
       day. Three short runs is a good day, not a long run.</p>
    ${groups.map(g => `
      <div class="record-group">
        <div class="record-head">
          <span class="record-icon">${iconOrText(g.icon, 18)}</span>
          <span class="record-sport">${escHtml(g.label)}</span>
        </div>
        <div class="record-list">
          ${g.list.map(rec => `
            <div class="record-item">
              <span class="record-kind">${escHtml(rec.kind.label)}</span>
              <span class="record-value">${escHtml(formatRecord(rec))}</span>
              <span class="record-when">${escHtml(rec.session.localDate)}</span>
            </div>`).join('')}
        </div>
      </div>`).join('')}
  </div>`;
}

// The streak belongs with active days: it is the same subject seen along the calendar
// rather than counted. Shown as a sentence, because "12" alone answers nothing.
function streakLineHtml(streak) {
  if (!streak.longest) return '';
  const best = streak.longestStart === streak.longestEnd
    ? streak.longestEnd
    : `${streak.longestStart} to ${streak.longestEnd}`;
  return `<p class="streak-line">
    ${icon('zap', 16)}
    ${streak.current
      ? `<strong>${plural(streak.current, 'day')}</strong> in a row right now.`
      : 'No run going right now.'}
    Longest <strong>${plural(streak.longest, 'day')}</strong>
    <span class="subtle">(${escHtml(best)})</span>
  </p>`;
}
