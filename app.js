(function () {
  'use strict';

  var DAY_MS = 86400000;
  var STORAGE_KEY = 'diabetes-inventory-v1';
  var MIN_THRESHOLD = 2;
  var RING_R = 25;
  var RING_CIRCUMFERENCE = 2 * Math.PI * RING_R;

  var DEFAULTS = [
    { id: 'insulin', name: 'Insulin', icon: 'insulin', fullStock: 7, maxStock: 70, cycleDays: 12 },
    { id: 'sensor', name: 'Sensor', icon: 'sensor', fullStock: 10, maxStock: 70, cycleDays: 7 },
    { id: 'infusion', name: 'Infusion set', icon: 'infusion', fullStock: 20, maxStock: 70, cycleDays: 7 },
    { id: 'syringe', name: 'Sprøjter', icon: 'syringe', fullStock: 30, maxStock: 70, cycleDays: 3 }
  ];

  // Seed used only the very first time the app runs on a device (no saved
  // state yet). After that, real elapsed progress is persisted and this is
  // never applied again.
  function seedRuntime(id, now) {
    return { stock: DEFAULTS.filter(function (d) { return d.id === id; })[0].fullStock, accumulatedMs: 0, lastResumeAt: new Date(now).toISOString() };
  }

  function load() {
    var saved = null;
    try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY)); } catch (e) {}
    var now = Date.now();
    return DEFAULTS.map(function (d) {
      var s = saved && saved.filter(function (x) { return x.id === d.id; })[0];
      var runtime = s
        ? { stock: s.stock, accumulatedMs: s.accumulatedMs, lastResumeAt: s.lastResumeAt }
        : seedRuntime(d.id, now);
      return Object.assign({}, d, runtime);
    });
  }

  function persist(products) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(products)); } catch (e) {}
  }

  function computeElapsedMs(p, now) {
    if (!p.lastResumeAt) return p.accumulatedMs;
    return p.accumulatedMs + Math.max(0, now - new Date(p.lastResumeAt).getTime());
  }

  // Advances a product's stock for every full cycle that has elapsed since
  // it last resumed. Freezes at 0 (never goes negative) until stock is
  // topped back up.
  function tickProduct(p, now) {
    if (!p.lastResumeAt) return p;
    if (new Date(p.lastResumeAt).getTime() > now) return p;
    var cycleMs = p.cycleDays * DAY_MS;
    var elapsed = computeElapsedMs(p, now);
    var stock = p.stock;
    while (elapsed >= cycleMs && stock > 0) {
      stock -= 1;
      elapsed -= cycleMs;
    }
    if (stock <= 0) {
      return Object.assign({}, p, { stock: 0, accumulatedMs: 0, lastResumeAt: null });
    }
    return Object.assign({}, p, { stock: stock, accumulatedMs: elapsed, lastResumeAt: new Date(now).toISOString() });
  }

  // Resets a product's cycle timer to start over from now, without
  // touching its stock count.
  function resetProduct(p, now) {
    return Object.assign({}, p, { accumulatedMs: 0, lastResumeAt: new Date(now).toISOString() });
  }

  // Nudges a product's countdown by `delta` days (positive = more days
  // left, negative = fewer), clamped within the cycle. Stock is untouched.
  function shiftDays(p, delta) {
    var cycleMs = p.cycleDays * DAY_MS;
    var now = Date.now();
    var elapsed = computeElapsedMs(p, now);
    var next = Math.min(cycleMs - 60000, Math.max(0, elapsed - delta * DAY_MS));
    if (p.lastResumeAt) {
      return Object.assign({}, p, { accumulatedMs: 0, lastResumeAt: new Date(now - next).toISOString() });
    }
    return Object.assign({}, p, { accumulatedMs: next });
  }

  var state = { products: load().map(function (p) { return tickProduct(p, Date.now()); }), resetId: null, pendingDelta: 0 };
  persist(state.products);

  function update(id, fn) {
    var now = Date.now();
    state.products = state.products.map(function (p) {
      var ticked = tickProduct(p, now);
      return p.id === id ? tickProduct(fn(ticked, now), now) : ticked;
    });
    persist(state.products);
    render();
  }

  function increment(id) {
    update(id, function (cur) {
      var stock = Math.min(cur.maxStock, cur.stock + 1);
      if (cur.stock <= 0 && stock > 0 && !cur.lastResumeAt) {
        return Object.assign({}, cur, { stock: stock, accumulatedMs: 0, lastResumeAt: new Date().toISOString() });
      }
      return Object.assign({}, cur, { stock: stock });
    });
  }

  function decrement(id) {
    update(id, function (cur) {
      return Object.assign({}, cur, { stock: Math.max(0, cur.stock - 1) });
    });
  }

  function requestReset(id) {
    state.resetId = id;
    state.pendingDelta = 0;
    render();
  }

  function closeReset() {
    state.resetId = null;
    state.pendingDelta = 0;
    render();
  }

  function confirmReset() {
    var id = state.resetId;
    state.resetId = null;
    state.pendingDelta = 0;
    update(id, function (cur, now) { return resetProduct(cur, now); });
  }

  function adjustPlus() {
    state.pendingDelta += 1;
    render();
  }

  function adjustMinus() {
    state.pendingDelta -= 1;
    render();
  }

  function applyAdjust() {
    var id = state.resetId;
    var delta = state.pendingDelta;
    state.resetId = null;
    state.pendingDelta = 0;
    if (delta) update(id, function (cur) { return shiftDays(cur, delta); });
    else render();
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function buildView(p, now) {
    var cycleMs = p.cycleDays * DAY_MS;
    var isEmpty = p.stock <= 0;
    var isLow = !isEmpty && p.stock <= MIN_THRESHOLD;
    var notYetStarted = p.lastResumeAt && new Date(p.lastResumeAt).getTime() > now;

    var circleLabel, progress;
    if (isEmpty) {
      circleLabel = '0d';
      progress = 1;
    } else if (notYetStarted) {
      var daysUntil = Math.ceil((new Date(p.lastResumeAt).getTime() - now) / DAY_MS);
      circleLabel = String(daysUntil);
      progress = 0;
    } else {
      var elapsed = computeElapsedMs(p, now);
      var daysLeft = Math.max(0, Math.ceil((cycleMs - elapsed) / DAY_MS));
      circleLabel = String(daysLeft);
      progress = Math.min(1, elapsed / cycleMs);
    }
    var dashOffset = RING_CIRCUMFERENCE * (1 - Math.max(progress, 0.03));

    var countdownText = '';
    var endDateText = '';
    if (!isEmpty && !notYetStarted) {
      var elapsed2 = computeElapsedMs(p, now);
      var remainMs = Math.max(0, cycleMs - elapsed2);
      var totalMin = Math.ceil(remainMs / 60000);
      var d = Math.floor(totalMin / 1440);
      var h = Math.floor((totalMin % 1440) / 60);
      var m = totalMin % 60;
      var parts = [];
      if (d) parts.push(d + 'd');
      if (d || h) parts.push(h + 't');
      parts.push(m + 'm');
      countdownText = parts.join(' ');
      endDateText = new Date(now + remainMs).toLocaleDateString('da-DK', { weekday: 'short', day: 'numeric', month: 'short' });
    }

    return {
      id: p.id,
      name: p.name,
      stock: p.stock,
      isEmpty: isEmpty,
      isLow: isLow,
      countdownText: countdownText,
      endDateText: endDateText,
      cycleLabel: (p.icon === 'insulin' ? 'Tømmes hver ' : 'Skiftes hver ') + p.cycleDays + '. dag',
      circleLabel: circleLabel,
      dashOffset: dashOffset
    };
  }

  function cardHtml(v) {
    return (
      '<div class="card elev-sm" data-id="' + v.id + '">' +
        '<div class="card-top-row">' +
          '<div class="card-kicker">' +
            '<span class="live-dot"><span></span><span></span></span>' +
            '<span>' + escapeHtml(v.cycleLabel) + '</span>' +
          '</div>' +
          (v.countdownText ? '<div class="countdown-block">' +
              '<div class="countdown-text">' + escapeHtml(v.countdownText) + '</div>' +
              '<div class="countdown-date">' + escapeHtml(v.endDateText) + '</div>' +
            '</div>' : '') +
        '</div>' +
        '<div class="title-row">' +
          '<div class="title-col">' +
            '<div class="card-title">' +
              '<span class="product-name">' + escapeHtml(v.name) + '</span>' +
              (v.isEmpty ? '<span class="tag tag-accent">Tomt</span>' : '') +
              (v.isLow ? '<span class="tag tag-accent">Lav beholdning</span>' : '') +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="stock-row">' +
          '<div class="stock-number">' + v.stock + '</div>' +
        '</div>' +
        '<div class="bottom-row">' +
          '<div class="ring-wrap" data-action="reset" role="button" aria-label="Nulstil nedtælling">' +
            '<svg width="56" height="56" viewBox="0 0 56 56">' +
              '<circle cx="28" cy="28" r="25" fill="none" stroke="var(--color-divider)" stroke-width="2"></circle>' +
              '<circle cx="28" cy="28" r="25" fill="none" stroke="var(--color-accent)" stroke-width="2" stroke-linecap="round" ' +
                'transform="rotate(-90 28 28)" style="stroke-dasharray:' + RING_CIRCUMFERENCE.toFixed(2) + ';stroke-dashoffset:' + v.dashOffset.toFixed(2) + ';transition:stroke-dashoffset .4s ease"></circle>' +
            '</svg>' +
            '<div class="ring-label">' + escapeHtml(v.circleLabel) + '</div>' +
          '</div>' +
          '<div class="btn-group">' +
            '<button type="button" class="icon-btn" aria-label="Fjern en" data-action="decrement">−</button>' +
            '<button type="button" class="icon-btn" aria-label="Tilføj en" data-action="increment">+</button>' +
          '</div>' +
        '</div>' +
      '</div>'
    );
  }

  function dialogHtml() {
    if (!state.resetId) return '';
    var p = state.products.filter(function (x) { return x.id === state.resetId; })[0];
    if (!p) return '';
    var view = buildView(p, Date.now());
    var base = Number(view.circleLabel || 0);
    var shown = Math.max(0, base + state.pendingDelta);
    var deltaSuffix = state.pendingDelta ? ' (' + (state.pendingDelta > 0 ? '+' : '') + state.pendingDelta + ' dage)' : '';
    var adjustLabel = 'Dage tilbage: ' + shown + deltaSuffix;
    return (
      '<div class="dialog-backdrop" data-action="close-reset">' +
        '<div class="dialog" style="max-width:360px" data-action="stop">' +
          '<div class="dialog-title">Nulstil nedtælling</div>' +
          '<div class="dialog-body">' +
            '<div class="adjust-row">' +
              '<div>' +
                '<div class="adjust-title">Justér nedtælling</div>' +
                '<div class="adjust-label">' + escapeHtml(adjustLabel) + '</div>' +
              '</div>' +
              '<div class="adjust-btns">' +
                '<button type="button" class="icon-btn" aria-label="En dag tilbage" data-action="adjust-minus">−</button>' +
                '<button type="button" class="icon-btn" aria-label="En dag frem" data-action="adjust-plus">+</button>' +
              '</div>' +
            '</div>' +
            '<button type="button" class="btn btn-primary btn-block" style="min-height:44px;border-radius:999px;margin-top:var(--space-3)" data-action="apply-adjust">Opdater</button>' +
          '</div>' +
          '<div class="dialog-actions">' +
            '<button type="button" class="btn btn-ghost" style="min-height:44px;border-radius:999px" data-action="cancel-reset">Annuller</button>' +
            '<button type="button" class="btn btn-primary" style="min-height:44px;border-radius:999px" data-action="confirm-reset">Nulstil</button>' +
          '</div>' +
        '</div>' +
      '</div>'
    );
  }

  var cardsEl = document.getElementById('cards');
  var dialogEl = document.getElementById('dialog-root');

  function render() {
    var now = Date.now();
    cardsEl.innerHTML = state.products.map(function (p) { return cardHtml(buildView(p, now)); }).join('');
    dialogEl.innerHTML = dialogHtml();
  }

  cardsEl.addEventListener('click', function (e) {
    var resetTrigger = e.target.closest('[data-action="reset"]');
    if (resetTrigger) {
      requestReset(resetTrigger.closest('.card').getAttribute('data-id'));
      return;
    }
    var btn = e.target.closest('button[data-action]');
    if (!btn) return;
    var card = btn.closest('.card');
    var id = card.getAttribute('data-id');
    if (btn.getAttribute('data-action') === 'increment') increment(id);
    else decrement(id);
  });

  dialogEl.addEventListener('click', function (e) {
    var action = e.target.closest('[data-action]');
    if (!action) return;
    var act = action.getAttribute('data-action');
    if (act === 'close-reset' || act === 'cancel-reset') closeReset();
    else if (act === 'confirm-reset') confirmReset();
    else if (act === 'adjust-minus') adjustMinus();
    else if (act === 'adjust-plus') adjustPlus();
    else if (act === 'apply-adjust') applyAdjust();
  });

  render();
  setInterval(function () {
    var now = Date.now();
    state.products = state.products.map(function (p) { return tickProduct(p, now); });
    persist(state.products);
    render();
  }, 15000);
})();
