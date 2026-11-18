'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const state = { lat: null, lon: null, place: '' };

  /** Create element with text only (no innerHTML → no XSS from model output). */
  function el(tag, opts = {}, children = []) {
    const node = document.createElement(tag);
    if (opts.className) node.className = opts.className;
    if (opts.text !== undefined) node.textContent = opts.text;
    if (opts.attrs) for (const [k, v] of Object.entries(opts.attrs)) node.setAttribute(k, v);
    if (opts.style) Object.assign(node.style, opts.style);
    for (const c of children) node.appendChild(c);
    return node;
  }

  async function api(url, options = {}) {
    const res = await fetch(url, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  function setLocation(lat, lon, place) {
    state.lat = lat;
    state.lon = lon;
    state.place = place;
    $('location-status').textContent = `✓ Using ${place}`;
    $('plan-btn').disabled = false;
  }

  // ---------- Location: geolocation ----------
  $('locate-btn').addEventListener('click', () => {
    if (!navigator.geolocation) {
      $('location-status').textContent = 'Geolocation is not supported. Please type your city.';
      return;
    }
    $('location-status').textContent = 'Finding your location…';
    navigator.geolocation.getCurrentPosition(
      (pos) => setLocation(pos.coords.latitude, pos.coords.longitude, 'your current location'),
      () => { $('location-status').textContent = 'Location permission denied. Please type your city.'; },
      { timeout: 10000, maximumAge: 600000 }
    );
  });

  // ---------- Location: search with debounce + keyboard support ----------
  const input = $('place');
  const list = $('place-results');
  let debounce;
  let activeIndex = -1;

  function closeList() {
    list.hidden = true;
    list.replaceChildren();
    input.setAttribute('aria-expanded', 'false');
    activeIndex = -1;
  }

  function choose(r) {
    input.value = r.name;
    setLocation(r.lat, r.lon, r.name);
    closeList();
  }

  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-controls', 'place-results');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false');

  input.addEventListener('input', () => {
    clearTimeout(debounce);
    const q = input.value.trim();
    if (q.length < 2) return closeList();
    debounce = setTimeout(async () => {
      try {
        const { results } = await api(`/api/geocode?q=${encodeURIComponent(q)}`);
        list.replaceChildren(
          ...results.map((r, i) => {
            const li = el('li', { text: r.name, attrs: { role: 'option', id: `opt-${i}`, 'aria-selected': 'false' } });
            li.addEventListener('mousedown', (e) => { e.preventDefault(); choose(r); });
            li._data = r;
            return li;
          })
        );
        list.hidden = results.length === 0;
        input.setAttribute('aria-expanded', String(results.length > 0));
      } catch {
        closeList();
      }
    }, 300);
  });

  input.addEventListener('keydown', (e) => {
    const items = [...list.children];
    if (!items.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      activeIndex = (activeIndex + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items.forEach((li, i) => li.setAttribute('aria-selected', String(i === activeIndex)));
      input.setAttribute('aria-activedescendant', items[activeIndex].id);
    } else if (e.key === 'Enter' && activeIndex >= 0) {
      e.preventDefault();
      choose(items[activeIndex]._data);
    } else if (e.key === 'Escape') {
      closeList();
    }
  });
  input.addEventListener('blur', () => setTimeout(closeList, 150));

  // ---------- Profile ----------
  function readProfile() {
    const f = $('plan-form');
    return {
      householdSize: Number(f.householdSize.value),
      sensitiveGroups: [...f.querySelectorAll('input[name=sensitiveGroups]:checked')].map((c) => c.value),
      commuteMode: f.commuteMode.value,
      commuteKm: Number(f.commuteKm.value),
      commuteMinutes: Number(f.commuteMinutes.value),
      outdoorExerciseMinutes: Number(f.outdoorExerciseMinutes.value),
      hasPurifier: f.hasPurifier.checked,
      cookingFuel: f.cookingFuel.value,
      language: f.language.value
    };
  }

  // ---------- Render ----------
  const fmt = (v, unit) => (typeof v === 'number' ? `${Math.round(v)} ${unit}` : '—');

  function aqiColor(aqi) {
    if (aqi <= 50) return '#2e7d32';
    if (aqi <= 100) return '#9e7c00';
    if (aqi <= 150) return '#c25e00';
    if (aqi <= 200) return '#c62828';
    if (aqi <= 300) return '#6a1b9a';
    return '#5d0f1d';
  }

  const hourLabel = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric' });

  function renderAirQuality(aq) {
    $('aq-section').hidden = false;
    const badge = $('aq-badge');
    badge.textContent = aq.aqi ?? '?';
    badge.style.background = aq.category.color;
    badge.setAttribute('aria-label', `US AQI ${aq.aqi}, ${aq.category.level}`);
    $('aq-level').textContent = aq.category.level;
    $('aq-advice').textContent = aq.category.advice;
    $('aq-source').textContent = `Source: ${aq.source}`;

    const p = aq.pollutants;
    const items = [['PM2.5', p.pm25, 'µg/m³'], ['PM10', p.pm10, 'µg/m³'], ['NO₂', p.no2, 'µg/m³'], ['O₃', p.o3, 'µg/m³']];
    $('pollutants').replaceChildren(...items.map(([k, v, u]) => el('div', {}, [el('dt', { text: k }), el('dd', { text: fmt(v, u) })])));

    const hours = (aq.hourly || []).filter((h) => typeof h.aqi === 'number').slice(0, 24);
    const max = Math.max(300, ...hours.map((h) => h.aqi)); // fixed scale so 160 vs 300 looks different
    $('forecast').replaceChildren(
      ...hours.map((h, i) =>
        el('div', {
          className: 'bar',
          attrs: { role: 'listitem', 'aria-label': `${hourLabel(h.time)}: AQI ${h.aqi}`, title: `${hourLabel(h.time)} — AQI ${h.aqi}` },
          style: { height: `${(h.aqi / max) * 100}%`, background: aqiColor(h.aqi) }
        }, i % 3 === 0 ? [el('span', { text: hourLabel(h.time), attrs: { 'aria-hidden': 'true' } })] : [])
      )
    );
    const w = aq.cleanestWindows || [];
    $('clean-windows').textContent = w.length
      ? `🟢 Cleanest upcoming hours: ${w.map((x) => `${hourLabel(x.time)} (AQI ${x.aqi})`).join(', ')}`
      : '';
  }

  function renderPlan(plan, impacts) {
    $('plan-section').hidden = false;
    $('plan-headline').textContent = plan.headline;
    $('plan-summary').textContent = plan.summary;
    $('health-alert').textContent = plan.healthAlert ? `⚠️ ${plan.healthAlert}` : '';

    $('routine').replaceChildren(...plan.routine.map((r) =>
      el('li', {}, [el('span', { className: 't', text: r.time }), el('span', { text: r.action }), el('div', { className: 'why', text: r.why })])
    ));

    $('impacts').replaceChildren(...impacts.map((i) => {
      const children = [
        el('strong', { text: i.title }),
        el('span', { className: 'tag', text: i.category }),
        el('div', { className: 'metric', text: i.metric })
      ];
      if (typeof i.percent === 'number') {
        children.push(el('div', {
          className: 'meter',
          attrs: { role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(i.percent), 'aria-label': `${i.percent}% reduction` }
        }, [el('i', { style: { width: `${Math.min(100, i.percent)}%` } })]));
      }
      return el('li', {}, children);
    }));

    $('indoor').replaceChildren(...plan.indoorHacks.map((h) =>
      el('li', {}, [el('span', { text: h.tip }), el('span', { className: 'tag', text: h.cost }), el('span', { className: 'impact', text: h.impact })])
    ));
    $('swaps').replaceChildren(...plan.sustainableSwaps.map((s) =>
      el('li', {}, [el('span', { text: s.swap }), el('span', { className: 'impact', text: s.impact })])
    ));
    $('generated-by').textContent = plan.generatedBy === 'gemini'
      ? 'Personalised by Gemini using live air-quality data. Impact figures computed by AirWise.'
      : 'Rule-based plan (AI unavailable). Impact figures computed by AirWise.';
    $('ask-section').hidden = false;
  }

  // ---------- Submit ----------
  $('plan-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('form-error').textContent = '';
    if (state.lat === null) {
      $('form-error').textContent = 'Please choose a location first.';
      return;
    }
    const btn = $('plan-btn');
    const results = $('results');
    btn.disabled = true;
    btn.replaceChildren(el('span', { className: 'loading', attrs: { 'aria-hidden': 'true' } }), document.createTextNode(' Building your plan…'));
    results.setAttribute('aria-busy', 'true');
    try {
      const data = await api('/api/plan', {
        method: 'POST',
        body: JSON.stringify({ lat: state.lat, lon: state.lon, place: state.place, profile: readProfile() })
      });
      renderAirQuality(data.airQuality);
      renderPlan(data.plan, data.impacts);
      $('aq-title').focus({ preventScroll: true });
      $('aq-section').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    } catch (err) {
      $('form-error').textContent = err.message;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Build my clean-air plan';
      results.setAttribute('aria-busy', 'false');
    }
  });
  $('aq-title').setAttribute('tabindex', '-1');

  // ---------- Ask ----------
  async function ask(question) {
    const out = $('answer');
    out.replaceChildren(el('span', { className: 'loading', attrs: { 'aria-hidden': 'true' } }), document.createTextNode(' Thinking…'));
    try {
      const data = await api('/api/ask', {
        method: 'POST',
        body: JSON.stringify({ lat: state.lat, lon: state.lon, place: state.place, profile: readProfile(), question })
      });
      out.textContent = data.answer;
    } catch (err) {
      out.textContent = `Sorry — ${err.message}`;
    }
  }
  $('ask-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = $('question').value.trim();
    if (q) ask(q);
  });
  document.querySelectorAll('.chip-btn').forEach((b) =>
    b.addEventListener('click', () => { $('question').value = b.textContent; ask(b.textContent); })
  );
})();
