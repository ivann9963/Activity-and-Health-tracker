// === MOTION ===
// The app had none. Everything appeared fully formed and every number was just
// suddenly there, which is the main reason it read as generated rather than built.
//
// Three rules, so this stays a system rather than a pile of effects:
//
//   1. Motion explains a change. A view rises as it replaces the last one; tiles
//      arrive in reading order; a bar grows from its baseline because that is the
//      direction it is measured in. Nothing moves for decoration.
//   2. Fast, and faster the smaller it is. 160ms for a control, 260ms for a view.
//      An app opened between sets cannot make you wait for a flourish.
//   3. It is all cancellable. Every animation runs on the compositor (transform and
//      opacity only), and `prefers-reduced-motion` turns the lot off in CSS — this
//      file also checks it so the JS-driven counters do not run either.

function motionOff() {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (err) { return false; }
}

// Stagger: each element gets its own delay through a custom property, so the CSS
// keeps ownership of the animation and this only says "you are the nth".
// Capped, because the 30th tile arriving a second late is a bug, not a flourish.
function stagger(nodes, step, max) {
  const s = step == null ? 26 : step;
  const cap = max == null ? 10 : max;
  [...nodes].forEach((node, i) => {
    node.style.setProperty('--enter-delay', Math.min(i, cap) * s + 'ms');
  });
}

// Count a number up to its final value.
//
// The target is read out of the element's own rendered text, not passed in. The
// first version took the record's stored value and counted that into the formatted
// string — which meant counting 5200 (metres) inside the template "5.20 km" and
// showing 3376.66 km on the way. Storage units and display units are different
// things, and nothing here should have to know the difference. `data-count` is a
// flag with no value for the same reason: one source of truth for what it says.
function countUp(node) {
  if (motionOff()) return;
  // Counting rewrites textContent, which would delete any child elements. A caller
  // that marks a wrapper containing markup gets left alone rather than silently
  // stripped — that already cost a bolded figure its <strong>.
  if (node.firstElementChild) return;
  const finalText = node.textContent;
  const match = finalText.match(/[\d][\d,]*(\.\d+)?/);
  if (!match) return;

  const to = Number(match[0].replace(/,/g, ''));
  if (!isFinite(to) || to === 0) return;
  const decimals = (match[0].split('.')[1] || '').length;
  const grouped = match[0].includes(',');

  const render = (n) => {
    const fixed = n.toFixed(decimals);
    // Keep the separator style of the value being replaced: "12,000" counts through
    // "3,400", and "5.20" counts through "3.38".
    return grouped ? Number(fixed).toLocaleString(undefined,
      { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) : fixed;
  };

  const DURATION = 620;
  const start = performance.now();
  // A counting number is not yet the number. Anything reading the DOM — a test, a
  // screenshot, an assistive tool re-reading a live region — needs to know that,
  // and polling for "has it stopped changing" is the alternative nobody should
  // have to write.
  node.dataset.counting = '1';

  const paint = (now) => {
    const t = Math.min(1, (now - start) / DURATION);
    // Ease-out cubic: fast first, settling at the end, which is how a number being
    // tallied feels rather than a linear sweep.
    const eased = 1 - Math.pow(1 - t, 3);
    if (t < 1) {
      node.textContent = finalText.replace(match[0], render(to * eased));
      requestAnimationFrame(paint);
      return;
    }
    node.textContent = finalText;
    delete node.dataset.counting;
  };
  node.textContent = finalText.replace(match[0], render(0));
  requestAnimationFrame(paint);
}

// Run after a view renders. Idempotent: re-running on the same DOM re-triggers the
// entrance, which is what makes switching period feel like the data moved rather
// than like the page blinked.
function animateView(host) {
  if (!host) return;
  if (motionOff()) return;

  stagger(host.querySelectorAll('.metric-grid > .metric-tile'));
  stagger(host.querySelectorAll('.stat-row > .stat-tile'), 22);
  stagger(host.querySelectorAll('.share-row'), 40, 8);
  stagger(host.querySelectorAll('.effort-row'), 34, 8);
  stagger(host.querySelectorAll('.list-row'), 20, 12);

  host.querySelectorAll('[data-count]').forEach(countUp);

  // Bars and meters carry their final width in a custom property and start at zero,
  // so the growth is a transition rather than a keyframe with a hardcoded target.
  requestAnimationFrame(() => {
    host.querySelectorAll('.share-fill, .meter-fill, .progress-fill').forEach(node => {
      const to = node.style.width;
      if (!to) return;
      node.style.width = '0%';
      // Two frames: one to commit the zero, one to transition away from it.
      requestAnimationFrame(() => requestAnimationFrame(() => { node.style.width = to; }));
    });
  });
}

if (typeof module !== 'undefined') {
  module.exports = { stagger, countUp, animateView, motionOff };
}
