(() => {
  'use strict';

  const HIGHLIGHT_LABELS = {
    views: 'Summit / Views',
    waterfalls: 'Waterfalls',
    animals: 'Animals / Wildlife',
    wildflowers: 'Wildflowers',
    water: 'Lake / River',
    forest: 'Forest',
    challenge: 'The Challenge',
    company: 'Good Company',
    other: 'Other',
  };

  const US_NAMES = new Set(['united states', 'united states of america', 'usa', 'us', 'u.s.', 'u.s.a.']);

  let allHikes = [];
  let currentPhotos = []; // [{id, dataUrl}] for the form in progress
  let editingId = null;
  let map, markerLayer;
  let lastMapPoints = [];

  // ---------- utilities ----------
  function $(sel) { return document.querySelector(sel); }
  function $all(sel) { return Array.from(document.querySelectorAll(sel)); }

  function toast(msg, ms = 2600) {
    const el = $('#toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { el.hidden = true; }, ms);
  }

  function starString(n) {
    n = Math.round(n) || 0;
    return '★★★★★'.slice(0, n) + '☆☆☆☆☆'.slice(0, 5 - n);
  }

  function isUS(country) {
    return US_NAMES.has((country || '').trim().toLowerCase());
  }

  function fmtDate(d) {
    if (!d) return '';
    const [y, m, day] = d.split('-');
    if (!y) return d;
    return `${m}/${day}/${y}`;
  }

  // ---------- date select (Month/Day/Year) ----------
  const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function populateDateSelects() {
    const monthSel = $('#f-date-month');
    MONTH_NAMES.forEach((name, i) => {
      const opt = document.createElement('option');
      opt.value = String(i + 1).padStart(2, '0');
      opt.textContent = name;
      monthSel.appendChild(opt);
    });

    const daySel = $('#f-date-day');
    for (let d = 1; d <= 31; d++) {
      const opt = document.createElement('option');
      opt.value = String(d).padStart(2, '0');
      opt.textContent = String(d);
      daySel.appendChild(opt);
    }

    const yearSel = $('#f-date-year');
    const currentYear = new Date().getFullYear();
    for (let y = currentYear + 1; y >= currentYear - 80; y--) {
      const opt = document.createElement('option');
      opt.value = String(y);
      opt.textContent = String(y);
      yearSel.appendChild(opt);
    }
  }

  function getDateFromSelects() {
    const m = $('#f-date-month').value, d = $('#f-date-day').value, y = $('#f-date-year').value;
    return (m && d && y) ? `${y}-${m}-${d}` : '';
  }

  function setDateSelects(dateHiked) {
    const [y, m, d] = (dateHiked || '').split('-');
    $('#f-date-month').value = m || '';
    $('#f-date-day').value = d || '';
    $('#f-date-year').value = y || '';
  }

  // ---------- tabs ----------
  function showView(viewId) {
    $all('.view').forEach(v => v.classList.toggle('active', v.id === viewId));
    $all('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.view === viewId));
    if (viewId === 'view-map') {
      setTimeout(() => {
        if (!map) return;
        map.invalidateSize();
        if (lastMapPoints.length) map.fitBounds(lastMapPoints, { padding: [30, 30], maxZoom: 8 });
      }, 50);
    }
    if (viewId === 'view-stats') renderStats();
    if (viewId === 'view-list') renderList();
  }

  $all('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => showView(btn.dataset.view));
  });

  // ---------- photo handling ----------
  function resizeImage(file, maxDim = 1280, quality = 0.72) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error);
      reader.onload = (e) => {
        const img = new Image();
        img.onerror = reject;
        img.onload = () => {
          let { width, height } = img;
          if (width > maxDim || height > maxDim) {
            if (width > height) { height = Math.round(height * (maxDim / width)); width = maxDim; }
            else { width = Math.round(width * (maxDim / height)); height = maxDim; }
          }
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          canvas.getContext('2d').drawImage(img, 0, 0, width, height);
          resolve(canvas.toDataURL('image/jpeg', quality));
        };
        img.src = e.target.result;
      };
      reader.readAsDataURL(file);
    });
  }

  function renderPhotoPreview() {
    const box = $('#photo-preview');
    box.innerHTML = '';
    currentPhotos.forEach(p => {
      const div = document.createElement('div');
      div.className = 'thumb';
      div.innerHTML = `<img src="${p.dataUrl}" alt=""><button type="button" class="remove" data-id="${p.id}">✕</button>`;
      box.appendChild(div);
    });
  }

  $('#f-photos').addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []);
    for (const file of files) {
      try {
        const dataUrl = await resizeImage(file);
        currentPhotos.push({ id: TrailDB.uuid(), dataUrl });
      } catch (err) {
        console.warn('photo failed', err);
      }
    }
    e.target.value = '';
    renderPhotoPreview();
  });

  $('#photo-preview').addEventListener('click', (e) => {
    const btn = e.target.closest('.remove');
    if (!btn) return;
    currentPhotos = currentPhotos.filter(p => p.id !== btn.dataset.id);
    renderPhotoPreview();
  });

  // ---------- star picker ----------
  const starPicker = $('#f-stars');
  starPicker.addEventListener('click', (e) => {
    const btn = e.target.closest('.star');
    if (!btn) return;
    setStars(Number(btn.dataset.star));
  });
  function setStars(n) {
    starPicker.dataset.value = n;
    $all('.star', starPicker).forEach(s => s.classList.toggle('filled', Number(s.dataset.star) <= n));
  }

  // ---------- geocoding ----------
  async function geocode(city, state, country) {
    const q = [city, state, country].filter(Boolean).join(', ');
    if (!q) return null;
    try {
      const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`;
      const res = await fetch(url, { headers: { 'Accept-Language': 'en' } });
      if (!res.ok) return null;
      const data = await res.json();
      if (data && data[0]) return { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon) };
    } catch (err) {
      console.warn('geocode failed', err);
    }
    return null;
  }

  // ---------- form ----------
  const form = $('#hike-form');

  function resetForm() {
    form.reset();
    $('#f-country').value = 'United States';
    currentPhotos = [];
    editingId = null;
    setStars(0);
    renderPhotoPreview();
    $('#save-btn').textContent = 'Save Hike';
    $('#cancel-edit').hidden = true;
    $('#header-title').textContent = 'Trail Log';
    $('#form-status').textContent = '';
  }

  function populateForm(hike) {
    editingId = hike.id;
    $('#f-trail').value = hike.trailName || '';
    $('#f-city').value = hike.city || '';
    $('#f-state').value = hike.state || '';
    $('#f-country').value = hike.country || '';
    setDateSelects(hike.dateHiked);
    $('#f-miles').value = hike.miles ?? '';
    setStars(hike.rating || 0);
    $('#f-highlight').value = hike.highlight || '';
    currentPhotos = (hike.photos || []).map(p => ({ id: p.id, dataUrl: p.dataUrl, path: p.path }));
    renderPhotoPreview();
    $('#save-btn').textContent = 'Update Hike';
    $('#cancel-edit').hidden = false;
    showView('view-add');
  }

  $('#cancel-edit').addEventListener('click', resetForm);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const trailName = $('#f-trail').value.trim();
    if (!trailName) { toast('Please enter a trail name'); return; }

    const city = $('#f-city').value.trim();
    const state = $('#f-state').value.trim();
    const country = $('#f-country').value.trim();

    const saveBtn = $('#save-btn');
    saveBtn.disabled = true;
    $('#form-status').textContent = 'Saving…';

    let lat = null, lon = null;
    const existing = editingId ? allHikes.find(h => h.id === editingId) : null;
    if (existing && existing.city === city && existing.state === state && existing.country === country) {
      lat = existing.lat; lon = existing.lon;
    } else {
      const loc = await geocode(city, state, country);
      if (loc) { lat = loc.lat; lon = loc.lon; }
    }

    const previousPhotoPaths = existing ? (existing.photos || []).map(p => p.path).filter(Boolean) : null;

    const hike = {
      id: editingId || TrailDB.uuid(),
      trailName,
      city, state, country,
      dateHiked: getDateFromSelects(),
      miles: parseFloat($('#f-miles').value) || 0,
      rating: Number(starPicker.dataset.value) || 0,
      highlight: $('#f-highlight').value,
      photos: currentPhotos,
      lat, lon,
      createdAt: existing ? existing.createdAt : Date.now(),
    };

    let saved = hike;
    let syncFailed = false;
    if (GitHubSync.isConfigured()) {
      try {
        const committed = await GitHubSync.commitHike(hike, previousPhotoPaths);
        saved = committed;
      } catch (err) {
        console.warn('GitHub commit failed, saved locally instead', err);
        saved = { ...hike, _pendingSync: true, _pendingPhotoPathsBefore: previousPhotoPaths };
        syncFailed = true;
      }
    }

    await TrailDB.put(saved);
    await loadHikes();
    saveBtn.disabled = false;

    if (syncFailed) {
      toast('Saved on this device — will sync to GitHub once you’re back online.');
    } else if (!lat && (city || state || country)) {
      toast('Hike saved — couldn’t find that location for the map, but everything else is saved.');
    } else {
      toast(editingId ? 'Hike updated' : 'Hike saved!');
    }
    resetForm();
    showView('view-list');
  });

  // ---------- list ----------
  function populateFilterOptions() {
    const states = new Set(), countries = new Set();
    allHikes.forEach(h => {
      if (h.state) states.add(h.state);
      if (h.country) countries.add(h.country);
    });
    fillSelect($('#filter-state'), states, 'All States');
    fillSelect($('#filter-country'), countries, 'All Countries');
  }

  function fillSelect(select, values, allLabel) {
    const current = select.value;
    select.innerHTML = `<option value="">${allLabel}</option>`;
    Array.from(values).sort().forEach(v => {
      const opt = document.createElement('option');
      opt.value = v; opt.textContent = v;
      select.appendChild(opt);
    });
    if (Array.from(values).includes(current)) select.value = current;
  }

  function getFilters() {
    return {
      search: $('#filter-search').value.trim().toLowerCase(),
      state: $('#filter-state').value,
      country: $('#filter-country').value,
      highlight: $('#filter-highlight').value,
      rating: Number($('#filter-rating').value) || 0,
    };
  }

  function applyFilters(hikes) {
    const f = getFilters();
    return hikes.filter(h => {
      if (f.search) {
        const hay = `${h.trailName} ${h.city} ${h.state} ${h.country}`.toLowerCase();
        if (!hay.includes(f.search)) return false;
      }
      if (f.state && h.state !== f.state) return false;
      if (f.country && h.country !== f.country) return false;
      if (f.highlight && h.highlight !== f.highlight) return false;
      if (f.rating && (h.rating || 0) < f.rating) return false;
      return true;
    });
  }

  function renderList() {
    populateFilterOptions();
    const hikes = applyFilters(allHikes);
    const list = $('#hike-list');
    list.innerHTML = '';
    $('#list-empty').hidden = allHikes.length > 0;

    hikes.forEach(h => {
      const card = document.createElement('div');
      card.className = 'hike-card';
      card.dataset.id = h.id;
      const locBits = [h.city, h.state, h.country].filter(Boolean).join(', ');
      const metaBits = [locBits, fmtDate(h.dateHiked), h.miles ? `${h.miles} mi` : ''].filter(Boolean).join(' · ');
      card.innerHTML = `
        <h3>${escapeHtml(h.trailName)}</h3>
        <div class="meta">${escapeHtml(metaBits)}</div>
        <div class="stars">${starString(h.rating)}</div>
        ${h.photos && h.photos.length ? `<div class="thumbs">${h.photos.map(p => `<img src="${p.dataUrl}" alt="">`).join('')}</div>` : ''}
      `;
      card.addEventListener('click', () => openDetail(h.id));
      list.appendChild(card);
    });
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  ['#filter-search', '#filter-state', '#filter-country', '#filter-highlight', '#filter-rating']
    .forEach(sel => $(sel).addEventListener('input', renderList));

  // ---------- detail modal ----------
  let activeDetailId = null;

  function openDetail(id) {
    const h = allHikes.find(x => x.id === id);
    if (!h) return;
    activeDetailId = id;
    const locBits = [h.city, h.state, h.country].filter(Boolean).join(', ');
    $('#modal-body').innerHTML = `
      <h2>${escapeHtml(h.trailName)}</h2>
      <div class="meta-line">${escapeHtml(locBits)}</div>
      <div class="meta-line">${[fmtDate(h.dateHiked), h.miles ? `${h.miles} miles` : ''].filter(Boolean).join(' · ')}</div>
      <div class="stars">${starString(h.rating)}</div>
      ${h.highlight ? `<div class="meta-line">Coolest part: ${HIGHLIGHT_LABELS[h.highlight] || h.highlight}</div>` : ''}
      ${h.photos && h.photos.length ? `<div class="photos">${h.photos.map(p => `<img src="${p.dataUrl}" alt="">`).join('')}</div>` : ''}
    `;
    $('#detail-modal').hidden = false;
  }

  function closeDetail() {
    $('#detail-modal').hidden = true;
    activeDetailId = null;
  }

  $('#modal-close').addEventListener('click', closeDetail);
  $('.modal-backdrop').addEventListener('click', closeDetail);

  $('#modal-edit').addEventListener('click', () => {
    const h = allHikes.find(x => x.id === activeDetailId);
    if (!h) return;
    closeDetail();
    populateForm(h);
  });

  $('#modal-delete').addEventListener('click', async () => {
    if (!activeDetailId) return;
    if (!confirm('Delete this hike? This cannot be undone.')) return;
    const id = activeDetailId; // closeDetail() below clears activeDetailId — capture it first
    const h = allHikes.find(x => x.id === id);
    closeDetail();

    if (GitHubSync.isConfigured() && h) {
      try {
        await GitHubSync.commitDeleteHike(h);
        await TrailDB.remove(id);
        toast('Hike deleted');
      } catch (err) {
        console.warn('GitHub delete failed, queued for later', err);
        await TrailDB.put({ ...h, _pendingDelete: true });
        toast('Will delete once you’re back online');
      }
    } else {
      await TrailDB.remove(id);
      toast('Hike deleted');
    }
    await loadHikes();
  });

  // ---------- map ----------
  const pushpinIcon = L.divIcon({
    className: 'pushpin-marker',
    html: `<svg width="26" height="36" viewBox="0 0 26 36" xmlns="http://www.w3.org/2000/svg">
      <ellipse cx="13" cy="33" rx="4" ry="1.5" fill="rgba(0,0,0,0.28)"/>
      <polygon points="10.5,18 15.5,18 13,32" fill="#9a9a9a"/>
      <line x1="12.1" y1="19" x2="12.6" y2="28.5" stroke="#e2e2e2" stroke-width="0.7" stroke-linecap="round"/>
      <circle cx="13" cy="10" r="9" fill="url(#pinGrad)" stroke="#8a1410" stroke-width="0.6"/>
      <ellipse cx="9.5" cy="6.8" rx="3" ry="2" fill="rgba(255,255,255,0.55)"/>
      <defs>
        <radialGradient id="pinGrad" cx="35%" cy="30%" r="75%">
          <stop offset="0%" stop-color="#ff6b5e"/>
          <stop offset="55%" stop-color="#e5352a"/>
          <stop offset="100%" stop-color="#b31f17"/>
        </radialGradient>
      </defs>
    </svg>`,
    iconSize: [26, 36],
    iconAnchor: [13, 32],
    popupAnchor: [0, -33],
  });

  function initMap() {
    map = L.map('map', { worldCopyJump: true }).setView([30, 0], 2);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18,
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(map);
    markerLayer = L.layerGroup().addTo(map);
  }

  function renderMap() {
    if (!map) return;
    markerLayer.clearLayers();
    const pts = [];
    allHikes.forEach(h => {
      if (h.lat == null || h.lon == null) return;
      const marker = L.marker([h.lat, h.lon], { icon: pushpinIcon });
      const locBits = [h.city, h.state, h.country].filter(Boolean).join(', ');
      const popupDiv = document.createElement('div');
      popupDiv.innerHTML = `
        <h3>${escapeHtml(h.trailName)}</h3>
        <div class="meta">${escapeHtml(locBits)}</div>
        <div class="meta">${starString(h.rating)}</div>
        <button type="button">View Details</button>
      `;
      popupDiv.querySelector('button').addEventListener('click', () => openDetail(h.id));
      marker.bindPopup(popupDiv);
      marker.addTo(markerLayer);
      pts.push([h.lat, h.lon]);
    });
    lastMapPoints = pts;
    // Only fit bounds if the map is currently visible — fitBounds against a
    // hidden (zero-size) container computes a bogus zoom that never self-corrects.
    if (pts.length && document.getElementById('view-map').classList.contains('active')) {
      map.fitBounds(pts, { padding: [30, 30], maxZoom: 8 });
    }
  }

  // ---------- stats ----------
  function renderStats() {
    const total = allHikes.length;
    const totalMiles = allHikes.reduce((s, h) => s + (h.miles || 0), 0);
    const countries = new Set(allHikes.map(h => h.country).filter(Boolean));
    const usStates = new Set(allHikes.filter(h => isUS(h.country) && h.state).map(h => h.state));

    $('#stats-grid').innerHTML = `
      <div class="stat-card"><div class="value">${total}</div><div class="label">Hikes Logged</div></div>
      <div class="stat-card"><div class="value">${totalMiles.toFixed(1)}</div><div class="label">Total Miles</div></div>
      <div class="stat-card"><div class="value">${countries.size}</div><div class="label">Countries Visited</div></div>
      <div class="stat-card"><div class="value">${usStates.size}</div><div class="label">US States Visited</div></div>
    `;

    const ratingCounts = [0, 0, 0, 0, 0, 0];
    allHikes.forEach(h => { if (h.rating >= 1 && h.rating <= 5) ratingCounts[h.rating]++; });
    const maxCount = Math.max(1, ...ratingCounts.slice(1));
    const rb = $('#rating-breakdown');
    rb.innerHTML = '';
    for (let n = 5; n >= 1; n--) {
      const row = document.createElement('div');
      row.className = 'rating-row';
      row.innerHTML = `
        <span class="stars">${starString(n)}</span>
        <span class="bar-track"><span class="bar-fill" style="width:${(ratingCounts[n] / maxCount) * 100}%"></span></span>
        <span class="count">${ratingCounts[n]}</span>
      `;
      rb.appendChild(row);
    }

    const highlightCounts = {};
    allHikes.forEach(h => {
      if (!h.highlight) return;
      highlightCounts[h.highlight] = (highlightCounts[h.highlight] || 0) + 1;
    });
    const hb = $('#highlight-breakdown');
    const entries = Object.entries(highlightCounts).sort((a, b) => b[1] - a[1]);
    hb.innerHTML = entries.length
      ? entries.map(([k, v]) => `<span class="highlight-chip">${HIGHLIGHT_LABELS[k] || k} · ${v}</span>`).join('')
      : '<span class="hint">Add hikes to see this breakdown.</span>';
  }

  // ---------- data loading ----------
  async function loadHikes() {
    const raw = await TrailDB.getAll();
    allHikes = raw.filter(h => !h._pendingDelete);
    renderList();
    renderMap();
    renderStats();
  }

  // ---------- GitHub sync ----------
  function setSyncStatus(text, isError) {
    const el = $('#sync-status');
    el.textContent = text;
    el.classList.toggle('error', !!isError);
  }

  function refreshSyncUI() {
    const cfg = GitHubSync.getConfig();
    const connected = GitHubSync.isConfigured();
    $('#sync-connect-form').hidden = connected;
    $('#sync-connected-actions').hidden = !connected;
    if (connected) {
      $('#gh-owner').value = cfg.owner;
      $('#gh-repo').value = cfg.repo;
      setSyncStatus(`Connected — ${cfg.owner}/${cfg.repo}`);
    } else {
      setSyncStatus('Not connected');
    }
  }

  async function flushPending() {
    const raw = await TrailDB.getAll();
    for (const h of raw) {
      if (h._pendingDelete) {
        try {
          await GitHubSync.commitDeleteHike(h);
          await TrailDB.remove(h.id);
        } catch (err) {
          console.warn('retry delete failed', err);
        }
      } else if (!h._remoteSha) {
        // Covers hikes that failed to push, or were added before GitHub was
        // connected — anything without a remote commit yet needs one.
        try {
          const committed = await GitHubSync.commitHike(h, h._pendingPhotoPathsBefore || null);
          await TrailDB.put(committed);
        } catch (err) {
          console.warn('retry sync failed', err);
        }
      }
    }
  }

  let syncInFlight = false;

  async function syncNow(showToasts) {
    if (!GitHubSync.isConfigured()) return;
    if (syncInFlight) return; // avoid overlapping pulls/pushes from online + visibility + manual triggers
    syncInFlight = true;
    setSyncStatus('Syncing…');
    try {
      await flushPending();
      await GitHubSync.pull();
      await loadHikes();
      refreshSyncUI();
      if (showToasts) toast('Synced with GitHub');
    } catch (err) {
      console.warn('sync failed', err);
      setSyncStatus('Sync failed — will retry', true);
      if (showToasts) toast('Sync failed: ' + err.message);
    } finally {
      syncInFlight = false;
    }
  }

  $('#gh-connect-btn').addEventListener('click', async () => {
    const owner = $('#gh-owner').value.trim();
    const repo = $('#gh-repo').value.trim();
    const token = $('#gh-token').value.trim();
    if (!owner || !repo || !token) { toast('Fill in owner, repo, and token'); return; }
    setSyncStatus('Connecting…');
    try {
      await GitHubSync.testConnection({ owner, repo, token });
      $('#gh-token').value = '';
      refreshSyncUI();
      toast('Connected! Syncing your hikes…');
      await syncNow(true);
    } catch (err) {
      console.warn('connect failed', err);
      setSyncStatus('Not connected', true);
      toast('Could not connect — check the owner, repo, and token');
    }
  });

  $('#gh-sync-now-btn').addEventListener('click', () => syncNow(true));

  $('#gh-disconnect-btn').addEventListener('click', () => {
    GitHubSync.clearConfig();
    refreshSyncUI();
    toast('Disconnected from GitHub. Your hikes are still saved on this device.');
  });

  window.addEventListener('online', () => syncNow(false));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') syncNow(false);
  });

  // ---------- service worker ----------
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('service-worker.js').catch(() => {});
    });
  }

  // ---------- init ----------
  initMap();
  populateDateSelects();
  resetForm();
  refreshSyncUI();
  showView('view-add');
  loadHikes().then(() => syncNow(false));
})();
