'use strict';

(() => {
  const shell = document.getElementById('rhine-shell');
  const backdrop = document.getElementById('rhine-backdrop');
  const slot = document.getElementById('rhine-motif-slot');
  const dailyChrome = shell.querySelectorAll(
    ':scope > :is(.hud-tl, .hud-tr, .left-rail, .archive-inline, .hud-bl, .hud-br, .specimen-panel)'
  );
  const pages = {
    mobius: document.getElementById('ui-daily'),
    turbine: document.getElementById('ui-timed'),
    dna: document.getElementById('ui-ledger'),
  };
  const motif = window.RhineMotif;
  const fadeOutMs = 300;
  const revealDelayMs = 1220;
  let activeForm = 'mobius';
  shell.dataset.form = activeForm;
  let outgoingForm = activeForm;
  let revealAt = 0;
  let revealTimer;
  let fadeOutTimer;

  function setDailyVisible(visible) {
    shell.toggleAttribute('data-daily-off', !visible);
    for (const element of dailyChrome) element.inert = !visible;
  }

  function setDailyDormant(dormant) {
    pages.mobius.toggleAttribute('data-dormant', dormant);
    shell.toggleAttribute('data-daily-dormant', dormant);
  }

  const formVoiceByForm = {
    turbine: 'morphTimed',
    dna: 'morphLedger',
    mobius: 'morphDaily',
  };

  function syncPage() {
    const form = motif?.form() ?? 'mobius';
    if (activeForm === form) return;
    if (performance.now() < revealAt) return;
    // A cancelled morph can finish without changing form. On a running morph,
    // wait for the renderer to report the new form before revealing anything.
    if (slot.hasAttribute('data-rhine-rotating') && form === outgoingForm) return;

    const changed = activeForm !== form;
    setDailyVisible(form === 'mobius');
    if (form === 'mobius') setDailyDormant(false);
    backdrop.toggleAttribute('data-dark', form !== 'mobius');
    shell.dataset.form = form;
    pages[form].inert = false;
    pages[form].setAttribute('data-visible', '');
    activeForm = form;
    if (changed && formVoiceByForm[form]) {
      window.RhineAudio?.voice?.(formVoiceByForm[form], 0.14);
    }
  }

  function onRotation() {
    if (!slot.hasAttribute('data-rhine-rotating')) {
      backdrop.toggleAttribute('data-dark', motif?.form() !== 'mobius');
      syncPage();
      window.RhineAudio?.sfx?.('morphLock', 1.5);
      return;
    }
    clearTimeout(revealTimer);
    clearTimeout(fadeOutTimer);
    if (activeForm) {
      outgoingForm = activeForm;
      pages[activeForm].inert = true;
      pages[activeForm].removeAttribute('data-visible');
    }
    // The next route is the same cycle used by the shared ring renderer.
    backdrop.toggleAttribute('data-dark', outgoingForm !== 'dna');
    shell.dataset.form = 'morph';
    activeForm = null;
    setDailyVisible(false);
    revealAt = performance.now() + revealDelayMs;
    fadeOutTimer = setTimeout(() => setDailyDormant(true), fadeOutMs);
    revealTimer = setTimeout(syncPage, revealDelayMs + 1);
  }

  // The attribute marks the start. The event can arrive earlier or later than
  // the reveal window depending on when the renderer crosses the midpoint.
  new MutationObserver(onRotation).observe(slot, {
    attributes: true,
    attributeFilter: ['data-rhine-rotating'],
  });
  slot.addEventListener('rhine-form-change', syncPage);
})();

// The timed page reads the same hosted playtime snapshot as telemetry.
(() => {
  const timed = document.getElementById('ui-timed');
  const byId = (id) => timed.querySelector(`#tel-${id}`);
  const TRACK_LIMIT = 7;
  const LOG_LIMIT = 30;
  const DIAL_PALETTE = ['#ff7b00', '#b81c1c', '#e7e5e1', '#58caae', '#4878c9'];
  const DIAL_EXTENDED_PALETTE = [...DIAL_PALETTE, '#a8a29e'];
  const DIAL_RADIUS = 82;
  const DIAL_CIRCUMFERENCE = 2 * Math.PI * DIAL_RADIUS;
  const TRACK_KEY = 'rhine.timed.tracked.v1';
  const trackedIds = new Set();
  // 手动追踪的游戏落 localStorage（WebView2 用户数据目录内），重进不再回落到 top5
  try {
    const saved = JSON.parse(localStorage.getItem(TRACK_KEY) || '[]');
    if (Array.isArray(saved)) for (const id of saved) if (typeof id === 'string') trackedIds.add(id);
  } catch (error) { /* 坏数据忽略 */ }
  function persistTracking() {
    try { localStorage.setItem(TRACK_KEY, JSON.stringify([...trackedIds])); } catch (error) {}
  }
  const trackCategoryOf = (id) => id.split(':')[0];
  const countTrackedIn = (category) =>
    [...trackedIds].filter((id) => trackCategoryOf(id) === category).length;
  let games = [];
  const ringGames = { outer: [], inner: [] };
  const motif = window.RhineMotif;
  let logs = [];
  let denialCount = 0;
  let playtimeSignature = null;
  let syncInFlight = false;

  async function syncPlaytime(manual = false) {
    if (syncInFlight) return;
    syncInFlight = true;
    const syncButton = byId('syncDataBtn');
    syncButton.disabled = true;
    try {
      const response = await fetch(`data/playtime.json?_=${Date.now()}`, { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      const solo = data.steam?.solo ?? data['3A_SOLO'];
      const live = data.tracked ?? data.steam?.live;
      if (!Array.isArray(solo) && !Array.isArray(live)) throw new Error('Missing playtime records');
      games = [
        ['3A', solo, 'STEAM_RECORD'],
        ['LIVE', live, data.tracked ? 'LOCAL_TRACK' : 'STEAM_RECORD'],
      ].flatMap(([category, records, source]) => (Array.isArray(records) ? records : [])
        .filter(record => record && (record.name || record.game) &&
          Number.isFinite(record.hours) && record.hours >= 0)
        .map(record => ({
          ...record,
          id: `${category}:${record.appid ?? record.name ?? record.game}`,
          title: record.name ?? record.game,
          titleEn: record.nameEn ?? '',
          category,
          source,
        })));
      for (const id of [...trackedIds]) {
        if (!games.some(game => game.id === id)) trackedIds.delete(id);
      }
      persistTracking();
      // 扇区按「手动追踪优先」的 visible 取，不再固定取时长前五
      ringGames.outer = getSectorPartition('3A').visible.slice(0, 5);
      ringGames.inner = getSectorPartition('LIVE').visible.slice(0, 5);
      const scales = entries => entries.map((_, rank) =>
        entries.length === 1 ? 1 : 1.15 - 0.30 * rank / (entries.length - 1));
      motif?.setTurbineScales(scales(ringGames.outer), scales(ringGames.inner));
      byId('playtimeStatus').textContent = `PLAYTIME: ${games.length} RECORDS · SYNC ${getTimestamp()}`;
      renderAll();
      if (manual) window.RhineAudio?.voice?.('timedSync', 0.1);
      // 外部 watcher 每分钟回报一次：数据变动时记审计日志；手动点 SYNC 无论是否变化都给明确回执
      const signature = games.map(game => `${game.id}:${game.hours}`).join('|');
      if (signature !== playtimeSignature) {
        const first = playtimeSignature === null;
        playtimeSignature = signature;
        writeAuditLogs([{
          time: getTimestamp(),
          text: first ? `遥测同步完成 · ${games.length} 条记录` : `时长回报更新 · ${games.length} 条记录`,
          code: first ? '[SYNC OK]' : '[REPORT]',
        }]);
      } else if (manual) {
        writeAuditLogs([{
          time: getTimestamp(),
          text: `手动同步完成 · ${games.length} 条记录（无新变化）`,
          code: '[SYNC OK]',
        }]);
      }
    } catch {
      byId('playtimeStatus').textContent = games.length ? 'PLAYTIME: REFRESH FAILED' : 'PLAYTIME: UNAVAILABLE';
      writeAuditLogs([{ time: getTimestamp(), text: '遥测快照读取失败', code: '[SYNC FAIL]', crit: true }]);
    } finally {
      syncButton.disabled = false;
      syncInFlight = false;
    }
  }

  function highlightGame(id) {
    const role = id?.startsWith('3A:') ? 'outer' : 'inner';
    const entries = ringGames[role];
    const index = entries.findIndex(game => game.id === id);
    motif?.highlightTurbineSector(index >= 0 ? role : null, index, entries.length);
  }

  function hoverGame(target) {
    return target instanceof Element
      ? target.closest('[data-slice-id], [data-game-id]')
      : null;
  }

  timed.addEventListener('pointerover', event => {
    const item = hoverGame(event.target);
    if (item && item !== hoverGame(event.relatedTarget)) {
      highlightGame(item.dataset.sliceId ?? item.dataset.gameId);
    }
  });
  timed.addEventListener('pointerout', event => {
    const item = hoverGame(event.target);
    if (item && item !== hoverGame(event.relatedTarget)) highlightGame(null);
  });
  document.getElementById('rhine-motif-slot').addEventListener('rhine-form-change', () => highlightGame(null));

  let selectedGameId = null;
  const hoveredSlice = { '3A': null, LIVE: null };

  byId('rhine-return').addEventListener('click', () => {
    window.location.replace('index.html?noboot=1');
  });

  function getTimestamp(d = new Date()) {
    if (!Number.isFinite(d.getTime())) return '—';
    return [d.getHours(), d.getMinutes(), d.getSeconds()]
      .map((n) => String(n).padStart(2, '0'))
      .join(':');
  }

  let lastFaultVoiceAt = 0;
  function triggerFaultEffect(msg, code = '[ERR: 0x4F_REJECT]', crit = true) {
    window.RhineAudio?.sfx?.('uiAlert', 1.7);
    const now = performance.now();
    if (now - lastFaultVoiceAt > 1500) {
      lastFaultVoiceAt = now;
      window.RhineAudio?.voice?.('timedFault', 0.18);
    }
    denialCount += 1;
    byId('denialCounterBadge').textContent = `DENIALS: ${String(denialCount).padStart(2, '0')}`;

    const plaque = byId('warningPlaque');
    plaque.classList.remove('fault-shake');
    void plaque.offsetWidth; // Force reflow to restart damped shake
    plaque.classList.add('fault-shake');

    if (msg) writeAuditLogs([{ time: getTimestamp(), text: msg, code, crit }]);
  }

  function writeAuditLogs(entries) {
    logs = [...entries, ...logs].slice(0, LOG_LIMIT);
    renderLogs();
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"]/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'
    })[char]);
  }

  /* ======================================================================
     2. LIVE DIGITAL CLOCK
     ====================================================================== */
  function updateClock() {
    const now = new Date();
    byId('clockHM').textContent =
      `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    byId('clockSec').textContent = String(now.getSeconds()).padStart(2, '0');
  }
  updateClock();
  setInterval(updateClock, 1000);

  /* ======================================================================
     3. SECTOR PARTITION HELPER
     ====================================================================== */
  function getSectorPartition(category, source = games) {
    const allInCat = source
      .filter((g) => g.category === category)
      .sort((a, b) => b.hours - a.hours);

    const tracked = allInCat.filter((g) => trackedIds.has(g.id));
    const visible = tracked.length ? tracked : allInCat.slice(0, 5);
    const folded = allInCat.filter((g) => !visible.includes(g));
    const totalHours = allInCat.reduce((sum, g) => sum + g.hours, 0);
    const denominator = visible.reduce((sum, g) => sum + g.hours, 0);
    const foldedHours = Math.max(0, totalHours - denominator);
    const unitCount = allInCat.length;

    return {
      all: allInCat,
      visible,
      trackedCount: tracked.length,
      folded,
      totalHours,
      denominator,
      foldedHours,
      unitCount
    };
  }

  /* ======================================================================
     4. RENDER OUTER LEDGER TABLES (FAR LEFT 3A & FAR RIGHT LIVE_OPS)
     ====================================================================== */
  function renderSectorLedger(category, listElId, totalHeaderId, countLabelId, foldedStripId, foldedCountId) {
    const partition = getSectorPartition(category);
    const listEl = byId(listElId);

    byId(totalHeaderId).textContent = `${partition.totalHours.toFixed(1)} HRS`;
    byId(countLabelId).textContent = partition.trackedCount
      ? `TRACKED ${partition.trackedCount} / ${TRACK_LIMIT}`
      : `TOP-5 BY HOURS / ${String(partition.unitCount).padStart(2, '0')} UNITS`;

    const foldedStrip = byId(foldedStripId);
    if (partition.folded.length > 0) {
      foldedStrip.style.display = 'flex';
      byId(foldedCountId).textContent =
        `+${String(partition.folded.length).padStart(2, '0')} UNITS (${partition.foldedHours.toFixed(1)}H)`;
    } else {
      foldedStrip.style.display = 'none';
    }

    if (partition.visible.length === 0) {
      listEl.innerHTML = `<div style="padding: 24px 12px; text-align: center;" class="micro">NO RECORDS IN ${category}</div>`;
      return;
    }

    listEl.innerHTML = partition.visible
      .map((g, idx) => {
        const secCode = `SEC-0${idx + 1}`;
        const isSelected = g.id === selectedGameId;
        const share = partition.totalHours > 0 ? (g.hours / partition.totalHours) * 100 : 0;
        const isSteam = g.source === 'STEAM_RECORD';
        const lastText = g.last ? String(g.last).slice(0, 16).replace('T', ' ') : '—';
        const sessionText = Number.isFinite(g.sessions) ? `${g.sessions} SESS` : 'CUMULATIVE';
        const rankNo = partition.all.indexOf(g) + 1;
        const rankTotal = partition.all.length;
        const rankWidth = rankTotal > 1 ? ((rankTotal - rankNo + 1) / rankTotal) * 100 : 100;

        return `
          <article class="ledger-item ${isSelected ? 'active' : ''}" data-game-id="${escapeHtml(g.id)}">
            <div class="ledger-item-head">
              <div class="ledger-item-title-block">
                <div class="ledger-kicker-row">
                  <span class="kicker">${secCode}</span>
                  <span class="micro" style="color: ${isSteam ? 'var(--orange)' : '#e7e5e1'};">
                    ${g.source}
                  </span>
                </div>
                <div class="ledger-game-title" title="${escapeHtml(g.title + (g.titleEn ? ' // ' + g.titleEn : '') + (lastText !== '—' ? ' // LAST ' + lastText : ''))}">${escapeHtml(g.title)}</div>
              </div>
              <div class="ledger-hours-big">${g.hours.toFixed(1)}<span>H</span></div>
            </div>

            <!-- 3 条真实遥测：扇区占比 / 最近同步 / 数据来源 -->
            <div class="quota-bars">
              <div class="q-bar-group">
                <div class="q-bar-meta">
                  <span>SECTOR_SHARE</span>
                  <span>${share.toFixed(1)}%</span>
                </div>
                <div class="q-bar-track">
                  <div class="q-bar-seg orange" style="width: ${Math.min(100, share).toFixed(1)}%;"></div>
                </div>
              </div>

              <div class="q-bar-group">
                <div class="q-bar-meta">
                  <span>SECTOR_RANK</span>
                  <span>#${String(rankNo).padStart(2, '0')} / ${String(rankTotal).padStart(2, '0')}</span>
                </div>
                <div class="q-bar-track">
                  <div class="q-bar-seg white" style="width: ${rankWidth.toFixed(1)}%;"></div>
                </div>
              </div>

              <div class="q-bar-group">
                <div class="q-bar-meta">
                  <span>${isSteam ? 'LOCAL_SESSION_LOG' : 'SESSION_LOG'}</span>
                  <span>${isSteam ? 'CUMULATIVE ONLY' : sessionText}</span>
                </div>
                <div class="q-bar-track">
                  <div class="q-bar-seg ${isSteam ? 'orange' : 'crimson'}" style="width: 100%;"></div>
                </div>
              </div>
            </div>

          </article>
        `;
      })
      .join('');

    // Bind row click & quick action buttons
    listEl.querySelectorAll('.ledger-item').forEach((el) => {
      el.addEventListener('click', () => {
        const id = el.getAttribute('data-game-id');
        selectedGameId = id;
        renderAll();
        openDetail(id);
      });
    });

  }

  function buildDialVernierTicks(groupId, accentColor) {
    const group = byId(groupId);
    const cx = 118, cy = 118;
    let svg = '';
    for (let i = 0; i < 72; i++) {
      const deg = i * 5 - 90;
      const rad = (deg * Math.PI) / 180;
      const isMajor = i % 6 === 0;
      const r1 = isMajor ? 101 : 104;
      const r2 = 108;
      const x1 = (cx + r1 * Math.cos(rad)).toFixed(2);
      const y1 = (cy + r1 * Math.sin(rad)).toFixed(2);
      const x2 = (cx + r2 * Math.cos(rad)).toFixed(2);
      const y2 = (cy + r2 * Math.sin(rad)).toFixed(2);
      svg += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${isMajor ? accentColor : '#8b8882'}" stroke-width="${isMajor ? '1.1' : '0.7'}" opacity="${isMajor ? '0.85' : '0.42'}" />`;
    }
    group.innerHTML = svg;
  }

  function arcFor(ratio, sliceCount) {
    const rawLen = ratio * DIAL_CIRCUMFERENCE;
    const gap = sliceCount > 1 ? Math.min(5.2, rawLen * 0.35) : 0;
    return { rawLen, gap, drawLen: rawLen - gap };
  }


  function dialColorFor(id, colorUses, palette) {
    let hash = 2166136261;
    for (let i = 0; i < id.length; i += 1) {
      hash = Math.imul(hash ^ id.charCodeAt(i), 16777619);
    }
    const base = (hash >>> 0) % DIAL_PALETTE.length;
    let chosen = base;
    for (let step = 1; colorUses[chosen] > 0 && step < palette.length; step += 1) {
      const candidate = (base + step) % palette.length;
      if (colorUses[candidate] < colorUses[chosen]) chosen = candidate;
    }
    colorUses[chosen] += 1;
    return palette[chosen];
  }

  function renderDialRanking(rankingId, gamesByHours) {
    const top = gamesByHours.slice(0, 5);
    byId(rankingId).innerHTML = top.map((game, index) => {
      const name = escapeHtml(game.title);
      return `
        <div class="dial-stat-line dial-rank-row" data-game-id="${escapeHtml(game.id)}">
          <span>${String(index + 1).padStart(2, '0')}</span>
          <span class="dial-rank-name" title="${name}">${name}</span>
          <span>${game.hours}H</span>
        </div>
      `;
    }).join('');
  }

  function renderSectorDial(category, arcsGroupId, legendId, rankingId, centerTagId, centerHoursId, centerBadgeId, globalShareId, breachesId, sectorTotalId, displayedId) {
    const partition = getSectorPartition(category, games);
    const globalTotal = games.reduce((s, g) => s + g.hours, 0);
    const globalSharePct = globalTotal > 0 ? ((partition.totalHours / globalTotal) * 100).toFixed(1) : '0.0';
    const ledgerUnitCount = partition.all.filter((g) => g.hours > 0).length;

    byId(globalShareId).textContent = `${globalSharePct}%`;
    byId(breachesId).textContent = `${String(ledgerUnitCount).padStart(2, '0')} UNITS`;
    byId(sectorTotalId).textContent = `${partition.totalHours.toFixed(1)}H`;

    byId(displayedId).textContent = `${String(partition.visible.length).padStart(2, '0')} UNITS`;

    const colorUses = DIAL_EXTENDED_PALETTE.map(() => 0);
    const slices = partition.visible.map((g, idx) => ({
      id: g.id,
      label: g.title,
      shortTag: `SEC-0${idx + 1}`,
      hours: g.hours,
      ratio: partition.denominator > 0 ? g.hours / partition.denominator : 0,
      color: dialColorFor(g.id, colorUses, idx < DIAL_PALETTE.length ? DIAL_PALETTE : DIAL_EXTENDED_PALETTE)
    }));
    renderDialRanking(rankingId, partition.all);

    const arcsGroup = byId(arcsGroupId);
    const legendEl = byId(legendId);
    const cx = 118, cy = 118;
    const positiveCount = slices.filter((slice) => slice.ratio > 0).length;
    let accLen = 0;
    let arcsHtml = '';
    let legendHtml = '';

    slices.forEach((sl) => {
      const { rawLen, gap, drawLen } = arcFor(sl.ratio, positiveCount);

      // Center the witness tick in the gap after this arc.
      const leadAngleRad = (accLen + drawLen + gap / 2) / DIAL_RADIUS - Math.PI / 2;
      const wx1 = (cx + 71 * Math.cos(leadAngleRad)).toFixed(1);
      const wy1 = (cy + 71 * Math.sin(leadAngleRad)).toFixed(1);
      const wx2 = (cx + 93 * Math.cos(leadAngleRad)).toFixed(1);
      const wy2 = (cy + 93 * Math.sin(leadAngleRad)).toFixed(1);

      const pointAt = length => {
        const angle = length / DIAL_RADIUS - Math.PI / 2;
        return `${cx + DIAL_RADIUS * Math.cos(angle)} ${cy + DIAL_RADIUS * Math.sin(angle)}`;
      };
      const geometry = drawLen === DIAL_CIRCUMFERENCE
        ? `circle cx="${cx}" cy="${cy}" r="${DIAL_RADIUS}"`
        : `path d="M ${pointAt(accLen)} A ${DIAL_RADIUS} ${DIAL_RADIUS} 0 ${Number(drawLen > DIAL_CIRCUMFERENCE / 2)} 1 ${pointAt(accLen + drawLen)}"`;

      if (drawLen > 0) arcsHtml += `
        <${geometry} class="dial-arc" data-slice-id="${escapeHtml(sl.id)}"
          fill="none" stroke="${sl.color}" stroke-width="18" />
        ${gap > 1.6 ? `<line x1="${wx1}" y1="${wy1}" x2="${wx2}" y2="${wy2}" stroke="#060607" stroke-width="1.6" pointer-events="none" />` : ''}
      `;

      legendHtml += `
        <div class="dial-legend-row" data-slice-id="${escapeHtml(sl.id)}">
          <span class="legend-swatch" style="background-color: ${sl.color};"></span>
          <span class="legend-name" title="${escapeHtml(sl.label)}">${escapeHtml(sl.label)}</span>
          <span class="legend-metrics">${sl.hours.toFixed(1)}H<span title="IN_DIAL SHARE">${(sl.ratio * 100).toFixed(1)}%</span></span>
        </div>
      `;

      accLen += rawLen;
    });

    arcsGroup.innerHTML = arcsHtml;
    legendEl.innerHTML = legendHtml;

    const tagEl = byId(centerTagId);
    const hoursEl = byId(centerHoursId);
    const badgeEl = byId(centerBadgeId);
    const arcs = Array.from(arcsGroup.querySelectorAll('[data-slice-id]'));
    const rows = Array.from(legendEl.querySelectorAll('[data-slice-id]'));

    const updateFocus = () => {
      const focusedSlice = slices.find((s) => s.id === hoveredSlice[category]) ||
        slices.find((s) => s.id === selectedGameId);
      for (const arc of arcs) {
        const active = focusedSlice?.id === arc.dataset.sliceId;
        arc.setAttribute('stroke-width', active ? '23' : '18');
        arc.setAttribute('opacity', focusedSlice && !active ? '0.32' : '1');
      }
      for (const row of rows) {
        row.classList.toggle('active', focusedSlice?.id === row.dataset.sliceId);
      }

      if (focusedSlice) {
        const pct = (focusedSlice.ratio * 100).toFixed(1);
        tagEl.textContent = `${focusedSlice.shortTag} · ${focusedSlice.label}`;
        hoursEl.innerHTML = `${focusedSlice.hours.toFixed(1)}<small>H</small>`;
        badgeEl.textContent = `${pct}% IN_DIAL SHARE`;
      } else {
        const sector = category === '3A' ? '3A_SINGLE' : 'LIVE_OPS';
        const mode = !slices.length ? 'NO RECORDS' : partition.trackedCount ? 'TRACKED' : 'TOP-5 BY HOURS';
        tagEl.textContent = `${sector} · ${mode}`;
        hoursEl.innerHTML = `${partition.denominator.toFixed(1)}<small>H</small>`;
        badgeEl.textContent = !slices.length ? 'EMPTY SECTOR' : partition.trackedCount
          ? `TRACKED ${partition.trackedCount} / ${TRACK_LIMIT}`
          : 'TOP-5 FALLBACK';
      }
    };

    for (const el of [...arcs, ...rows]) {
      const id = el.dataset.sliceId;
      el.addEventListener('mouseenter', () => {
        hoveredSlice[category] = id;
        updateFocus();
      });
      el.addEventListener('mouseleave', () => {
        hoveredSlice[category] = null;
        updateFocus();
      });
      el.addEventListener('click', () => {
        hoveredSlice[category] = null;
        selectedGameId = selectedGameId === id ? null : id;
        renderAll();
        openDetail(id);
      });
    }
    updateFocus();
  }

  /* ======================================================================
     6. BOTTOM CENTER: REJECTION AUDIT LOGS
     ====================================================================== */
  function renderLogs() {
    const container = byId('logEntries');
    const visibleLogs = logs.length ? logs : [{ time: '--:--:--', text: '等待审计事件', code: '[STANDBY]' }];
    byId('logCountReadout').textContent = `${String(logs.length).padStart(2, '0')} EVENTS`;

    container.innerHTML = visibleLogs
      .map(
        (l) => `
        <div class="log-row">
          <span class="log-time">[${escapeHtml(l.time)}]</span>
          <span class="log-msg zh" title="${escapeHtml(l.text)}">${escapeHtml(l.text)}</span>
          <span class="log-tag ${l.crit ? 'crit' : ''}">${escapeHtml(l.code)}</span>
        </div>
      `
      )
      .join('');
    container.scrollTop = 0;
  }

  /* ======================================================================
     7. CENTER STAGE CONTROLS & MODAL HANDLERS
     ====================================================================== */
  byId('triggerFaultBtn').addEventListener('click', () => {
    triggerFaultEffect(
      'MANUAL_FAULT_INJECTION // 莫比乌斯拓扑校验断口强制触发 (0x4F)',
      '[ERR: MANUAL_FAULT]',
      true
    );
  });

  (function bindDetailModal() {
    const detailModal = detailEl();
    if (!detailModal) return;
    ['closeDetailBtn', 'closeDetailBtn2'].forEach((id) => {
      const btn = byId(id);
      if (btn) btn.addEventListener('click', closeDetail);
    });
    detailModal.addEventListener('click', (e) => {
      if (e.target === detailModal) closeDetail();
    });
    const focusBtn = byId('focusDetailBtn');
    if (focusBtn) focusBtn.addEventListener('click', () => {
      selectedGameId = detailGameId;
      closeDetail();
      renderAll();
    });
    document.addEventListener('keydown', (e) => {
      if (!timed.inert && e.key === 'Escape') {
        const modal = detailEl();
        if (modal && modal.classList.contains('open')) closeDetail();
      }
    });
  })();

  byId('syncDataBtn').addEventListener('click', () => syncPlaytime(true));

  const trackingModal = byId('trackingModal');
  const trackingSearch = byId('trackingSearch');
  const trackingList = byId('trackingList');
  const trackingCount = byId('trackingCount');
  const detailTrackNotice = byId('detailTrackNotice');
  const trackDetailBtn = byId('trackDetailBtn');
  let trackingOpener;

  function renderTracking(focusId) {
    highlightGame(null);
    const query = trackingSearch.value.trim().toLowerCase();
    const matches = games
      .filter((g) => g.title.toLowerCase().includes(query) || g.titleEn.toLowerCase().includes(query))
      .sort((a, b) => Number(trackedIds.has(b.id)) - Number(trackedIds.has(a.id)) || b.hours - a.hours);

    trackingCount.textContent =
      `3A ${countTrackedIn('3A')} / ${TRACK_LIMIT} · LIVE ${countTrackedIn('LIVE')} / ${TRACK_LIMIT}`;
    trackingList.innerHTML = matches.map((g) => `
      <label class="tracking-row">
        <input type="checkbox" value="${escapeHtml(g.id)}" ${trackedIds.has(g.id) ? 'checked' : ''}>
        <span class="micro">${g.category}</span>
        <span class="zh tracking-title" data-game-id="${escapeHtml(g.id)}" title="${escapeHtml(g.titleEn)}">${escapeHtml(g.title)}</span>
        <span class="micro">${g.hours.toFixed(1)}H</span>
      </label>
    `).join('') || '<div class="micro">NO MATCHING RECORDS</div>';
    if (focusId) {
      const checkbox = Array.from(trackingList.querySelectorAll('input')).find((input) => input.value === focusId);
      if (checkbox) checkbox.focus({ preventScroll: true });
    }
  }

  function refreshTracking(focusId) {
    renderAll();
    if (trackingModal.classList.contains('open')) renderTracking(focusId);
  }

  function setTracking(id, checked) {
    if (!id) return false;
    if (checked && !trackedIds.has(id) && countTrackedIn(trackCategoryOf(id)) >= TRACK_LIMIT) {
      triggerFaultEffect();
      return false;
    }
    if (checked) trackedIds.add(id);
    else trackedIds.delete(id);
    persistTracking();
    refreshTracking(id);
    return true;
  }

  function closeTracking() {
    trackingModal.classList.remove('open');
    highlightGame(null);
    trackingOpener?.focus();
  }

  ['track3ABtn', 'trackLiveBtn'].forEach((id) => {
    byId(id).addEventListener('click', (event) => {
      trackingOpener = event.currentTarget;
      trackingSearch.value = '';
      trackingList.scrollTop = 0;
      renderTracking();
      trackingModal.classList.add('open');
      trackingSearch.focus();
    });
  });
  ['closeTrackingBtn', 'doneTrackingBtn'].forEach((id) => {
    byId(id).addEventListener('click', closeTracking);
  });
  trackingModal.addEventListener('click', (event) => {
    if (event.target === trackingModal) closeTracking();
  });
  document.addEventListener('keydown', (event) => {
    if (!timed.inert && event.key === 'Escape' && trackingModal.classList.contains('open')) closeTracking();
  });
  trackingSearch.addEventListener('input', () => {
    trackingList.scrollTop = 0;
    renderTracking();
  });
  trackingList.addEventListener('change', (event) => {
    const checkbox = event.target;
    if (!setTracking(checkbox.value, checkbox.checked)) {
      checkbox.checked = trackedIds.has(checkbox.value);
      trackingCount.textContent =
        `3A ${countTrackedIn('3A')} / ${TRACK_LIMIT} · LIVE ${countTrackedIn('LIVE')} / ${TRACK_LIMIT} · 该扇区已满`;
    }
  });
  byId('clearTrackingBtn').addEventListener('click', () => {
    trackedIds.clear();
    persistTracking();
    refreshTracking();
    trackingList.scrollTop = 0;
  });
  trackDetailBtn.addEventListener('click', () => {
    detailTrackNotice.textContent = setTracking(detailGameId, !trackedIds.has(detailGameId))
      ? '' : `该扇区已满 / ${TRACK_LIMIT}`;
    trackDetailBtn.textContent = trackedIds.has(detailGameId) ? '移出追踪' : '加入追踪';
  });

  function detailEl() { return byId('detailModal'); }
  let detailGameId = null;

  function openDetail(gameId) {
    const game = games.find((g) => g.id === gameId);
    const modal = detailEl();
    if (!game || !modal) return;
    const peers = games.filter((g) => g.category === game.category)
      .sort((a, b) => b.hours - a.hours);
    const total = peers.reduce((sum, g) => sum + g.hours, 0);
    const rank = peers.findIndex((g) => g.id === game.id) + 1;
    const share = total > 0 ? (game.hours / total) * 100 : 0;
    const set = (id, text) => {
      const el = byId(id);
      if (el) el.textContent = text;
    };
    set('detailSector', game.category === '3A' ? '3A_SINGLE' : 'LIVE_OPS');
    set('detailName', game.title);
    byId('detailName').dataset.gameId = game.id;
    set('detailNameEn', game.titleEn ? `EN // ${game.titleEn}` : '');
    set('detailHours', `${game.hours.toFixed(1)} H`);
    set('detailRank', `#${String(rank).padStart(2, '0')} / ${String(peers.length).padStart(2, '0')}`);
    set('detailShare', `${share.toFixed(1)}%`);
    set('detailSource', game.source === 'STEAM_RECORD'
      ? 'STEAM_RECORD // Steam 累计' : 'LOCAL_TRACK // 本地进程计时');
    set('detailSessions', Number.isFinite(game.sessions) ? `${game.sessions} 场` : '无逐场记录');
    set('detailLast', game.last ? String(game.last).slice(0, 16).replace('T', ' ') : '—');
    set('detailAppid', game.appid ? `APP ${game.appid}` : '—');
    detailGameId = game.id;
    detailTrackNotice.textContent = '';
    trackDetailBtn.textContent = trackedIds.has(game.id) ? '移出追踪' : '加入追踪';
    modal.classList.add('open');
  }

  function closeDetail() {
    const modal = detailEl();
    if (modal) modal.classList.remove('open');
    highlightGame(null);
  }

  function renderAll() {
    highlightGame(null);
    const globalTotal = games.reduce((s, g) => s + g.hours, 0);
    byId('headerTotalHours').textContent = `${globalTotal.toFixed(1)}H`;

    const selectedObj = games.find((g) => g.id === selectedGameId);
    byId('activeFocusReadout').textContent = selectedObj
      ? `FOCUS: ${selectedObj.title} [${selectedObj.category} · ${selectedObj.hours.toFixed(1)}H]`
      : 'FOCUS: NONE';

    // Far Left: 3A_SINGLE Ledger
    renderSectorLedger('3A', 'ledger3AList', 'total3AHeader', 'count3ALabel', 'folded3AStrip', 'folded3ACount');
    // Inner Left: DIAL-A 3A_SINGLE Polar Dial
    renderSectorDial('3A', 'dial3AArcs', 'dial3ALegend', 'dial3ARanking', 'dial3ACenterTag', 'dial3ACenterHours', 'dial3ACenterBadge', 'dial3AGlobalShare', 'dial3ABreaches', 'dial3ASectorTotal', 'dial3ADisplayed');

    // Inner Right: DIAL-B LIVE_OPS Polar Dial
    renderSectorDial('LIVE', 'dialLiveArcs', 'dialLiveLegend', 'dialLiveRanking', 'dialLiveCenterTag', 'dialLiveCenterHours', 'dialLiveCenterBadge', 'dialLiveGlobalShare', 'dialLiveBreaches', 'dialLiveSectorTotal', 'dialLiveDisplayed');
    // Far Right: LIVE_OPS Ledger
    renderSectorLedger('LIVE', 'ledgerLiveList', 'totalLiveHeader', 'countLiveLabel', 'foldedLiveStrip', 'foldedLiveCount');
  }

  byId('denialCounterBadge').textContent = `DENIALS: ${String(denialCount).padStart(2, '0')}`;
  buildDialVernierTicks('dial3ATicks', 'rgba(242, 240, 235, 0.34)');
  buildDialVernierTicks('dialLiveTicks', 'rgba(242, 240, 235, 0.34)');
  renderAll();
  const bootTime = getTimestamp();
  writeAuditLogs([
    { time: bootTime, text: '遥测快照开始读取', code: '[SYNC START]' },
    { time: bootTime, text: '时长面板与仪表初始化完成', code: '[PANEL READY]' },
    { time: bootTime, text: '本地审计终端就绪', code: '[AUDIT READY]' },
  ]);
  // 首屏只装好界面，真正的数据抓取等第一次切到时长页再做，避免和日常页抢线程
  let timedHydrated = false;
  function hydrateTimed() {
    if (timedHydrated) return;
    timedHydrated = true;
    syncPlaytime();
    // 外部 watcher 写 web/data/playtime.json；与原版 telemetry.html 一致，每 60 秒拉一次
    setInterval(() => { if (!document.hidden) syncPlaytime(); }, 60000);
  }
  if (document.getElementById('ui-timed').hasAttribute('data-visible')) hydrateTimed();
  new MutationObserver(() => {
    if (document.getElementById('ui-timed').hasAttribute('data-visible')) hydrateTimed();
  }).observe(document.getElementById('ui-timed'), { attributes: true, attributeFilter: ['data-visible'] });
})();

// The ledger uses the source demo's in-memory records.
(() => {
  const ledger = document.getElementById('ui-ledger');
  const byId = id => ledger.querySelector('#led-' + id);

  function escapeHtml(value) {
    return value.replace(/[&<>"]/g, char => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
    })[char]);
  }

  /* ==========================================================================
     WEB AUDIO MECHANICAL RELAY CLICK FEEDBACK
     ========================================================================== */
  // 旧版账本振荡器音效已由全局 RhineAudio (uiClick/uiToggle/uiConfirm) 接管，静默防叠音
  const RelayAudio = {
    setEnabled() {},
    isEnabled() { return false; },
    click() {},
    confirm() {}
  };

  /* ==========================================================================
     INITIAL DATASET (ANCHORED AROUND 2026-11-25)
     ========================================================================== */
  const INITIAL_TRANSACTIONS = [
    { id: 't-01', date: '2026-11-25', game: '绝区零', category: 'gacha', subType: '氪金', tag: '648单 · 限定代理人十连', amount: 648 },
    { id: 't-02', date: '2026-11-18', game: '绝区零', category: 'gacha', subType: '大小月卡/通行证', tag: '大小月卡 · 丽都城募', amount: 68 },
    { id: 't-03', date: '2026-11-14', game: '鸣潮', category: 'gacha', subType: '氪金', tag: '328单 · 角色限定池补星声', amount: 328 },
    { id: 't-04', date: '2026-11-08', game: '艾尔登法环', category: 'buyout', subType: 'DLC/扩展包', tag: 'DLC扩展 · 黄金树幽影', amount: 198 },
    { id: 't-05', date: '2026-11-02', game: '明日方舟', category: 'gacha', subType: '氪金', tag: '每月寻访组合包', amount: 168 },
    { id: 't-06', date: '2026-10-24', game: '崩坏：星穹铁道', category: 'gacha', subType: '氪金', tag: '328单 · 版本双倍古老梦华', amount: 328 },
    { id: 't-07', date: '2026-08-20', game: '黑神话：悟空', category: 'buyout', subType: '本体买断', tag: '本体买断 · Steam 标准版', amount: 268 },
    { id: 't-08', date: '2026-04-10', game: '艾尔登法环', category: 'buyout', subType: '本体买断', tag: '本体买断 · Steam 豪华版', amount: 298 },
    { id: 't-09', date: '2026-03-01', game: '明日方舟', category: 'gacha', subType: '大小月卡/通行证', tag: '大小月卡 · 常规补给 ×2', amount: 60 },
    { id: 't-10', date: '2025-12-12', game: '鸣潮', category: 'gacha', subType: '大小月卡/通行证', tag: '大小月卡 · 先约电台', amount: 98 }
  ];

  const SUB_TYPE_CONFIG = [
    { key: '氪金', color: '#ff7b00' },
    { key: '本体买断', color: '#f2f0eb' },
    { key: '大小月卡/通行证', color: '#b81c1c' },
    { key: 'DLC/扩展包', color: '#8b8882' }
  ];

  const LEDGER_API = '/api/ledger';

  // 账本落盘在 %LOCALAPPDATA%\PersonalGRhineTerminal\ledger.json（宿主 /api/ledger）
  // 旧宿主没有这条路由时静默保留演示数据，不弹错
  async function loadLedger() {
    try {
      const response = await fetch(LEDGER_API, { cache: 'no-store' });
      if (!response.ok) return false;
      const payload = await response.json();
      const list = payload?.ledger?.transactions;
      if (Array.isArray(list) && list.length) {
        // 旧存档里的类型名迁移到新名字
        transactions = list.map(tx => (tx.subType === '抽卡/十连充值' ? { ...tx, subType: '氪金' } : tx));
        return true;
      }
    } catch (error) { /* 旧宿主：忽略 */ }
    return false;
  }

  function deleteTransaction(txId) {
    const target = transactions.find(tx => tx.id === txId);
    if (!target) return false;
    transactions = transactions.filter(tx => tx.id !== txId);
    RelayAudio.click(760);
    persistLedger();
    renderAll();
    showToast(`DELETED // [${target.game}] ¥${target.amount} 已从账本移除`);
    return true;
  }

  function bindDeleteButtons(scope) {
    scope.querySelectorAll('[data-txid]').forEach(button => {
      button.addEventListener('click', event => {
        event.stopPropagation();
        event.preventDefault();
        deleteTransaction(button.dataset.txid);
      });
    });
  }

  function persistLedger() {
    fetch(LEDGER_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transactions, savedAt: new Date().toISOString() }),
    }).then(response => {
      if (!response.ok) throw new Error('HTTP ' + response.status);
    }).catch(() => showToast('账本保存失败 // LEDGER_SAVE_FAILED'));
  }

  let transactions = [...INITIAL_TRANSACTIONS];
  let activePeriod = 'month';   // 'month' | 'quarter' | 'year' | 'all'

  // 统计口径按真实日历算，不再写死月份
  const pad2 = value => String(value).padStart(2, '0');
  function currentMonthPrefix(now = new Date()) {
    return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}`;
  }
  function currentYearPrefix(now = new Date()) {
    return `${now.getFullYear()}-`;
  }
  // 近三个月：从两个月前那个月的 1 号开始，含本月
  function threeMonthStart(now = new Date()) {
    const start = new Date(now.getFullYear(), now.getMonth() - 2, 1);
    return `${start.getFullYear()}-${pad2(start.getMonth() + 1)}-01`;
  }
  function todayStamp(now = new Date()) {
    return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
  }
  let activeCat = 'all';      // 'all' | 'buyout' | 'gacha'
  let selectedGameName = '绝区零';
  const HELIX_RUNG_COUNT = 30;
  let userSelectedGame = false;   // 首屏默认高亮不算「选中」，否则螺旋一动不动

  // 交易按日期倒序落在 30 组横档上；同一游戏命中哪几组，就高亮哪几根
  function focusItemsFor(gameName) {
    const sorted = [...transactions].sort((a, b) => (a.date < b.date ? 1 : -1));
    const items = [];
    sorted.forEach((tx, index) => {
      if (tx.game !== gameName) return;
      items.push({
        side: tx.category === 'buyout' ? 'A' : 'B',
        group: Math.min(HELIX_RUNG_COUNT - 1,
          Math.floor(index * HELIX_RUNG_COUNT / Math.max(1, sorted.length))),
      });
    });
    return items;
  }

  // 全部账单 → 30 组横档：同一组里多笔金额累加，渲染器按相对大小加粗横档
  function rungDataForAll() {
    const sorted = [...transactions].sort((a, b) => (a.date < b.date ? 1 : -1));
    const bucket = new Map();
    sorted.forEach((tx, index) => {
      const side = tx.category === 'buyout' ? 'A' : 'B';
      const group = Math.min(HELIX_RUNG_COUNT - 1,
        Math.floor(index * HELIX_RUNG_COUNT / Math.max(1, sorted.length)));
      const key = `${side}:${group}`;
      bucket.set(key, (bucket.get(key) || 0) + tx.amount);
    });
    return [...bucket.entries()].map(([key, amount]) => {
      const [side, group] = key.split(':');
      return { side, group: Number(group), amount };
    });
  }

  function pushRungData() {
    window.RhineMotif?.setLedgerRungs?.(rungDataForAll());
  }

  function focusGameOnHelix(gameName) {
    window.RhineMotif?.setLedgerFocus?.(focusItemsFor(gameName));
  }

  // 取消聚焦：点列表项以外的地方，或按 Esc
  function clearGameFocus() {
    if (!userSelectedGame) return;
    userSelectedGame = false;
    window.RhineMotif?.setLedgerFocus?.([]);
  }
  document.addEventListener('click', event => {
    if (event.target.closest('.game-item')) return;
    clearGameFocus();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') clearGameFocus();
  });
  let latestNewTxId = null;
  let toastTimer = null;

  function showToast(msg) {
    const el = byId('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
  }

  function getFilteredTransactions() {
    return transactions.filter(tx => {
      if (activePeriod === 'month') return tx.date.startsWith(currentMonthPrefix());
      if (activePeriod === 'quarter') return tx.date >= threeMonthStart();   // 近三个月（含本月）
      if (activePeriod === 'year') return tx.date.startsWith(currentYearPrefix());
      return true;
    });
  }

  /* ==========================================================================
     AGGREGATE & RENDER ALL PANELS
     ========================================================================== */
  function renderAll() {
    const periodTxs = getFilteredTransactions();

    // 1. Strand A (Buyout) vs Strand B (Gacha) totals
    const buyoutTotal = periodTxs.filter(t => t.category === 'buyout').reduce((s, t) => s + t.amount, 0);
    const gachaTotal = periodTxs.filter(t => t.category === 'gacha').reduce((s, t) => s + t.amount, 0);
    const grandTotal = buyoutTotal + gachaTotal;

    const shareA = grandTotal > 0 ? buyoutTotal / grandTotal : 0.5;
    const pctA = Math.round(shareA * 100);
    const pctB = grandTotal > 0 ? (100 - pctA) : 50;

    byId('pillShareA').textContent = `${pctA}%`;
    byId('pillShareB').textContent = `${pctB}%`;
    const headerTotal = byId('headerTotal');
    if (headerTotal) headerTotal.textContent = `¥${grandTotal.toLocaleString()}`;
    const headerBarA = byId('headerBarA');
    const headerBarB = byId('headerBarB');
    if (headerBarA) headerBarA.style.width = `${pctA}%`;
    if (headerBarB) headerBarB.style.width = `${pctB}%`;
    const headerPctA = byId('headerPctA');
    const headerPctB = byId('headerPctB');
    if (headerPctA) headerPctA.textContent = `${pctA}%`;
    if (headerPctB) headerPctB.textContent = `${pctB}%`;

    // 把两条链的占比交给渲染器：买断链 A 荧光绿、抽卡链 B 信号橙，包络随占比伸缩
    window.RhineMotif?.setLedgerShare?.(buyoutTotal, gachaTotal);
    window.RhineMotif?.setLedgerRungs?.(rungDataForAll());
    window.RhineMotif?.setLedgerFocus?.(userSelectedGame ? focusItemsFor(selectedGameName) : []);

    // 2. Group by Game for Left Rail
    const gameMap = new Map();
    periodTxs.forEach(tx => {
      if (!gameMap.has(tx.game)) {
        gameMap.set(tx.game, {
          name: tx.game,
          category: tx.category,
          total: 0,
          txs: []
        });
      }
      const entry = gameMap.get(tx.game);
      entry.total += tx.amount;
      entry.txs.push(tx);
    });

    const allGames = Array.from(gameMap.values()).sort((a, b) => b.total - a.total);
    const listGames = allGames.filter(g => activeCat === 'all' || g.category === activeCat);

    const listSum = listGames.reduce((s, g) => s + g.total, 0);
    byId('leftTotalReadout').textContent = `¥${listSum.toLocaleString()} JPY`;

    if (!listGames.some(g => g.name === selectedGameName) && listGames.length > 0) {
      // 只是视觉上高亮第一项，不算「选中」，否则一进页面 DNA 就染色 + 慢速旋转
      selectedGameName = listGames[0].name;
      window.RhineMotif?.setLedgerFocus?.(userSelectedGame ? focusItemsFor(selectedGameName) : []);
    }

    const maxGameSpend = Math.max(...listGames.map(g => g.total), 1);
    const listContainer = byId('gameListContainer');

    listContainer.innerHTML = listGames.map(g => {
      const isSelected = g.name === selectedGameName;
      const strand = g.category === 'buyout' ? 'A' : 'B';
      const badgeText = g.category === 'buyout' ? 'BUYOUT' : 'GACHA';
      const widthPct = Math.max(4, Math.round((g.total / maxGameSpend) * 100));

      return `
        <div class="game-item ${isSelected ? 'is-selected' : ''}" data-game="${escapeHtml(g.name)}" data-strand="${strand}">
          <div class="gi-top">
            <div class="gi-left">
              <span class="gi-tag ${strand === 'A' ? 'strand-a' : 'strand-b'}">${badgeText}</span>
              <span class="gi-name">${escapeHtml(g.name)}</span>
            </div>
            <span class="gi-amount">¥${g.total.toLocaleString()}</span>
          </div>
          <div class="gi-bar-track">
            <div class="gi-bar-fill ${strand === 'A' ? 'fill-a' : 'fill-b'}" style="width: ${widthPct}%;"></div>
          </div>
        </div>
      `;
    }).join('');

    listContainer.querySelectorAll('.game-item').forEach(row => {
      row.addEventListener('click', () => {
        RelayAudio.click(980);
        const already = userSelectedGame && selectedGameName === row.dataset.game;
        selectedGameName = row.dataset.game;
        userSelectedGame = !already;          // 再点一次同一款 → 退出聚焦
        window.RhineMotif?.setLedgerFocus?.(userSelectedGame ? focusItemsFor(selectedGameName) : []);
        renderAll();
      });
    });

    byId('knownGamesList').innerHTML =
      Array.from(new Set(transactions.map(t => t.game)))
        .map(name => `<option value="${escapeHtml(name)}"></option>`)
        .join('');

    // 3. Render Right Top Card: 4-Type Spend Composition
    const compBody = byId('spendCompositionBody');
    compBody.innerHTML = SUB_TYPE_CONFIG.map(cfg => {
      const sum = periodTxs.filter(t => t.subType === cfg.key).reduce((s, t) => s + t.amount, 0);
      const pct = grandTotal > 0 ? Math.round((sum / grandTotal) * 100) : 0;
      return `
        <div class="comp-row">
          <div class="comp-row-top">
            <span class="comp-name">${cfg.key}</span>
            <span class="comp-val"><strong>¥${sum.toLocaleString()}</strong>(${pct}%)</span>
          </div>
          <div class="comp-track">
            <div class="comp-fill" style="width: ${pct}%; background: ${cfg.color};"></div>
          </div>
        </div>
      `;
    }).join('');

    // 3b. 消费类型构成饼图：氪金+月卡 = 抽卡侧，买断+DLC = 买断侧，用各类型本色
    const donutBox = byId('spendDonut');
    if (donutBox) {
      const RADIUS = 52, STROKE = 16;
      const CIRC = 2 * Math.PI * RADIUS;
      const segments = SUB_TYPE_CONFIG.map(cfg => ({
        ...cfg,
        sum: periodTxs.filter(t => t.subType === cfg.key).reduce((acc, t) => acc + t.amount, 0),
        group: (cfg.key === '氪金' || cfg.key === '大小月卡/通行证') ? 'gacha' : 'buyout',
      })).filter(seg => seg.sum > 0);
      const totalSum = segments.reduce((acc, seg) => acc + seg.sum, 0);
      const total = totalSum || 1;   // 仅用于避免除零，显示用 totalSum
      let offset = 0;
      const arcs = segments.map(seg => {
        const arc = (seg.sum / total) * CIRC;
        const dash = `<circle class="donut-arc" cx="70" cy="70" r="${RADIUS}" fill="none"
            stroke="${seg.color}" stroke-width="${STROKE}"
            stroke-dasharray="${arc.toFixed(2)} ${(CIRC - arc).toFixed(2)}"
            stroke-dashoffset="${(-offset).toFixed(2)}"
            transform="rotate(-90 70 70)"><title>${seg.key} ¥${seg.sum.toLocaleString()}</title></circle>`;
        offset += arc;
        return dash;
      }).join('');
      const gachaSum = segments.filter(s => s.group === 'gacha').reduce((a, s) => a + s.sum, 0);
      const buyoutSum = segments.filter(s => s.group === 'buyout').reduce((a, s) => a + s.sum, 0);
      const pctOf = value => Math.round((value / total) * 100);
      donutBox.innerHTML = `
        <svg viewBox="0 0 140 140" role="img" aria-label="消费类型构成饼图">
          <circle cx="70" cy="70" r="${RADIUS}" fill="none" stroke="rgba(242,240,235,0.08)" stroke-width="${STROKE}"></circle>
          ${arcs}
          <text x="70" y="66" text-anchor="middle" class="donut-total">¥${totalSum.toLocaleString()}</text>
          <text x="70" y="84" text-anchor="middle" class="donut-cap">TOTAL · JPY</text>
        </svg>
        <div class="donut-legend">
          <span class="donut-key"><i style="background:#ff7b00"></i>氪金 ${pctOf(segments.filter(s => s.key === '氪金').reduce((a, s) => a + s.sum, 0))}%</span>
          <span class="donut-key"><i style="background:#b81c1c"></i>月卡 ${pctOf(segments.filter(s => s.key === '大小月卡/通行证').reduce((a, s) => a + s.sum, 0))}%</span>
          <span class="donut-key"><i style="background:#f2f0eb"></i>买断 ${pctOf(segments.filter(s => s.key === '本体买断').reduce((a, s) => a + s.sum, 0))}%</span>
          <span class="donut-key"><i style="background:#8b8882"></i>DLC ${pctOf(segments.filter(s => s.key === 'DLC/扩展包').reduce((a, s) => a + s.sum, 0))}%</span>
        </div>
        <div class="donut-split">
          <span>抽卡侧 ¥${gachaSum.toLocaleString()} · ${pctOf(gachaSum)}%</span>
          <span>买断侧 ¥${buyoutSum.toLocaleString()} · ${pctOf(buyoutSum)}%</span>
        </div>
      `;
    }

    // 4. Render Right Bottom Card: Specimen Archive
    const activeGame = allGames.find(g => g.name === selectedGameName) || listGames[0];
    const specBody = byId('specimenBody');

    if (!activeGame) {
      specBody.innerHTML = `<div class="rh-label" style="padding: 20px; text-align: center;">// NO SPECIMEN IN PERIOD</div>`;
    } else {
      const avg = Math.round(activeGame.total / activeGame.txs.length);
      const strandLabel = activeGame.category === 'buyout' ? 'STRAND_A · BUYOUT' : 'STRAND_B · GACHA';
      specBody.innerHTML = `
        <div class="specimen-summary">
          <div class="ss-title-row">
            <h3 class="ss-name">${escapeHtml(activeGame.name)}</h3>
            <span class="rh-label" style="color: ${activeGame.category === 'buyout' ? 'var(--ink)' : 'var(--orange)'};">${strandLabel}</span>
          </div>
          <div class="ss-grid">
            <div class="ss-cell">
              <span class="rh-label">累计支出</span>
              <span class="ss-val">¥${activeGame.total.toLocaleString()}</span>
            </div>
            <div class="ss-cell">
              <span class="rh-label">记录笔数</span>
              <span class="ss-val">${activeGame.txs.length} 笔</span>
            </div>
            <div class="ss-cell">
              <span class="rh-label">单笔均值</span>
              <span class="ss-val">¥${avg.toLocaleString()}</span>
            </div>
          </div>
        </div>

        <div class="rh-label">ARCHIVE RECORDS // 历史明细</div>

        <div class="specimen-tx-list">
          ${activeGame.txs.map(tx => `
            <div class="stx-card">
              <div class="stx-left">
                <span class="stx-note">${escapeHtml(tx.tag)}</span>
                <span class="stx-meta">${tx.date} · ${escapeHtml(tx.subType)}</span>
              </div>
              <span class="stx-amt">¥${tx.amount.toLocaleString()}</span>
              <button type="button" class="stx-del" data-txid="${escapeHtml(tx.id)}"
                title="删除这笔支出" aria-label="删除这笔支出">×</button>
            </div>
          `).join('')}
        </div>
      `;
    }

    // 5. Render Bottom Center Stream (Latest 4 rows)
    const latest8 = periodTxs.slice(0, 8);
    const auditContainer = byId('auditRowsContainer');
    auditContainer.innerHTML = latest8.map(tx => {
      const isNew = tx.id === latestNewTxId;
      const isBuyout = tx.category === 'buyout';
      return `
        <div class="audit-row ${isNew ? 'is-new' : ''}" data-game="${escapeHtml(tx.game)}" data-txid="${escapeHtml(tx.id)}">
          <span>[${tx.date}]</span>
          <span class="ar-cat ${isBuyout ? 'is-buyout' : ''}">[${isBuyout ? '单机买断' : '长线抽卡'}]</span>
          <span class="ar-detail">${escapeHtml(tx.game)} · ${escapeHtml(tx.tag)}</span>
          <span class="ar-amt">— ¥${tx.amount.toLocaleString()}</span>
        </div>
      `;
    }).join('');

    bindDeleteButtons(byId('specimenBody'));

    auditContainer.querySelectorAll('.audit-row').forEach(r => {
      r.addEventListener('mouseenter', () => {
        const id = r.dataset.txid;
        const tx = transactions.find(item => item.id === id);
        if (!tx) return;
        const sorted = [...transactions].sort((a, b) => (a.date < b.date ? 1 : -1));
        const index = sorted.findIndex(item => item.id === tx.id);
        const side = tx.category === 'buyout' ? 'A' : 'B';
        const group = Math.min(HELIX_RUNG_COUNT - 1,
          Math.floor(index * HELIX_RUNG_COUNT / Math.max(1, sorted.length)));
        window.RhineMotif?.setLedgerFocus?.([{ side, group }]);
      });
      r.addEventListener('mouseleave', () => {
        window.RhineMotif?.setLedgerFocus?.(userSelectedGame ? focusItemsFor(selectedGameName) : []);
      });
      r.addEventListener('click', () => {
        RelayAudio.click(980);
        selectedGameName = r.dataset.game;
      userSelectedGame = true;
      focusGameOnHelix(selectedGameName);
        renderAll();
      });
    });
  }

  /* ==========================================================================
     EVENT BINDINGS & SLIDE-OVER DRAWER SUBMISSION
     ========================================================================== */
  function init() {
    // Live Clock
    function tickClock() {
      const now = new Date();
      byId('clockHm').textContent =
        `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      byId('clockSec').textContent = String(now.getSeconds()).padStart(2, '0');
      byId('clockDate').textContent =
        `${now.getFullYear()}.${String(now.getMonth() + 1).padStart(2, '0')}.${String(now.getDate()).padStart(2, '0')}`;
    }
    tickClock();
    setInterval(tickClock, 1000);

    // Audio Switch
    const audioBtn = byId('audioSwitchBtn');
    audioBtn?.addEventListener('click', () => {
      const next = !RelayAudio.isEnabled();
      RelayAudio.setEnabled(next);
      audioBtn.classList.toggle('is-on', next);
      audioBtn.setAttribute('aria-pressed', String(next));
      (byId('audioStateLabel') || {}).textContent = next ? 'ON' : 'OFF';
      if (next) RelayAudio.click(1240);
    });

    // Top Period Tabs
    ledger.querySelectorAll('.period-pills button').forEach(btn => {
      btn.addEventListener('click', () => {
        RelayAudio.click(960);
        ledger.querySelectorAll('.period-pills button').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        activePeriod = btn.dataset.period;
        renderAll();
        showToast(`PERIOD_FILTER // 切换统计周期: ${btn.textContent}`);
      });
    });

    // Left Rail Category Tabs
    ledger.querySelectorAll('.cat-tabs button').forEach(btn => {
      btn.addEventListener('click', () => {
        RelayAudio.click(960);
        ledger.querySelectorAll('.cat-tabs button').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        activeCat = btn.dataset.cat;
        renderAll();
      });
    });

    // Slide-over Drawer Controls
    const backdrop = byId('drawerBackdrop');
    const openDrawer = (prefillGame = null) => {
      RelayAudio.click(1120);
      backdrop.classList.remove('is-hidden');
      if (prefillGame) {
        byId('inputGameName').value = prefillGame.name;
        byId('inputCategory').value = prefillGame.category;
        byId('inputSubType').value =
          prefillGame.category === 'buyout' ? 'DLC/扩展包' : '氪金';
        byId('inputAmount').focus();
      } else {
        byId('inputGameName').focus();
      }
    };
    const closeDrawer = () => {
      RelayAudio.click(780);
      backdrop.classList.add('is-hidden');
    };

    byId('openDrawerBtn')?.addEventListener('click', () => openDrawer());   // 顶部按钮已移除，保留空引用保护
    byId('quickAddSpecimenBtn').addEventListener('click', () => {
      const current = transactions.find(t => t.game === selectedGameName);
      openDrawer(current ? { name: current.game, category: current.category } : null);
    });
    byId('closeDrawerBtn').addEventListener('click', closeDrawer);
    byId('cancelDrawerBtn').addEventListener('click', closeDrawer);
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) closeDrawer();
    });

    // Sub-tag quick chips in drawer
    ledger.querySelectorAll('#led-subtagChips button').forEach(chip => {
      chip.addEventListener('click', () => {
        RelayAudio.click(1080);
        byId('inputItemTag').value = chip.dataset.tag;
        byId('inputSubType').value = chip.dataset.sub;
        byId('inputCategory').value = chip.dataset.cat;
        // 金额由主人自己填，chip 不再预设数字
      });
    });

    // Submit Entry Form
    byId('entryForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const game = byId('inputGameName').value.trim();
      const category = byId('inputCategory').value;
      const subType = byId('inputSubType').value;
      const rawTag = byId('inputItemTag').value.trim();
      const amount = parseFloat(byId('inputAmount').value);

      if (!game || !rawTag || isNaN(amount) || amount <= 0) return;

      const newId = 't-' + Date.now().toString().slice(-5);
      transactions.unshift({
        id: newId,
        date: todayStamp(),
        game,
        category,
        subType,
        tag: rawTag,
        amount: Math.round(amount * 100) / 100
      });

      latestNewTxId = newId;
      selectedGameName = game;
      userSelectedGame = true;
      focusGameOnHelix(selectedGameName);
      if (activeCat !== 'all' && activeCat !== category) {
        activeCat = 'all';
        ledger.querySelectorAll('.cat-tabs button').forEach(b => {
          b.classList.toggle('active', b.dataset.cat === 'all');
        });
      }

      RelayAudio.confirm();
      window.RhineAudio?.voice?.('ledgerRecord', 0.14);
      byId('entryForm').reset();
      backdrop.classList.add('is-hidden');
      renderAll();
      persistLedger();
      showToast(`IMPULSE_LOGGED // [${game}] ¥${amount} -> STRAND_${category === 'buyout' ? 'A' : 'B'}`);
    });

    // Initial Boot：界面先就位，账本数据等第一次切到账本页再读盘渲染
    let ledgerHydrated = false;
    function hydrateLedger() {
      if (ledgerHydrated) return;
      ledgerHydrated = true;
      loadLedger().then(() => renderAll());
    }
    if (ledger.hasAttribute('data-visible')) hydrateLedger();
    new MutationObserver(() => {
      if (ledger.hasAttribute('data-visible')) hydrateLedger();
    }).observe(ledger, { attributes: true, attributeFilter: ['data-visible'] });
  }

  init();
})();
