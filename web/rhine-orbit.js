/* 莱茵生命观测终端 · 外围指向型莫比乌斯环轨道引擎与原版 app.js 双向桥接器 */
(function () {
  const shell = document.getElementById('rhine-shell');
  const gamesPool = document.getElementById('games');
  const orbitNodesEl = document.getElementById('orbitNodes');
  const calloutLinesSvg = document.getElementById('orbitCalloutLines');
  const specimenPanel = document.getElementById('specimenPanel');
  const specimenBody = document.getElementById('specimenBody');
  const specimenTitle = document.getElementById('specimenTitle');
  const specimenIndex = document.getElementById('specimenIndex');
  const specimenStatusTag = document.getElementById('specimenStatusTag');
  const specimenGhost = document.getElementById('specimenGhost');
  const specimenLaunchBtn = document.getElementById('specimenLaunchBtn');
  const specimenCloseBtn = document.getElementById('specimenCloseBtn');
  const railCursor = document.getElementById('railCursor');
  const railTelemetry = document.getElementById('railTelemetry');
  const stepNodes = document.querySelectorAll('#stepNodes .node');
  const filterBadge = document.getElementById('filterBadge');
  const fakeTerminalFeed = document.getElementById('fakeTerminalFeed');
  const railMiniMatrix = document.getElementById('railMiniMatrix');

  let selectedIndex = -1;

  // 1. 入场描边生长启动
  requestAnimationFrame(() => {
    setTimeout(() => shell.classList.add('booted'), 100);
  });

  // 2. 右上精密时钟
  function updateClock() {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');
    const hmEl = document.getElementById('hudClockHM');
    const secEl = document.getElementById('hudClockSec');
    if (hmEl) hmEl.textContent = `${hh}:${mm}`;
    if (secEl) secEl.textContent = ss;
  }
  updateClock();
  setInterval(updateClock, 1000);

  // 3. 归档矩阵抽屉开关（左栏展开按钮 + 左下按钮均可切换）
  const archiveDrawer = document.getElementById('archiveDrawer');
  const toggleArchiveBtn = document.getElementById('toggleArchiveBtn');
  const toggleArchiveBtnBottom = document.getElementById('toggleArchiveBtnBottom');
  const closeArchiveBtn = document.getElementById('closeArchiveBtn');

  function toggleArchive() {
    if (!archiveDrawer) {
      // 归档矩阵已升为一级元素：入口改为高亮常驻面板
      const inline = document.querySelector('.archive-inline');
      if (!inline) return;
      inline.classList.add('is-flash');
      inline.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      setTimeout(() => inline.classList.remove('is-flash'), 900);
      return;
    }
    archiveDrawer.hidden = !archiveDrawer.hidden;
    if (!archiveDrawer.hidden && !specimenPanel.hidden) {
      closeSpecimen();
    }
  }
  if (toggleArchiveBtn) toggleArchiveBtn.addEventListener('click', toggleArchive);
  if (toggleArchiveBtnBottom) toggleArchiveBtnBottom.addEventListener('click', toggleArchive);
  if (closeArchiveBtn && archiveDrawer) {
    closeArchiveBtn.addEventListener('click', () => { archiveDrawer.hidden = true; });
  }

  document.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    if (e.key === 'Escape') {
      if (!specimenPanel.hidden) closeSpecimen();
      if (archiveDrawer && !archiveDrawer.hidden) archiveDrawer.hidden = true;
    }
  });

  // ── 锚点投影：与 3D 环体同一套几何与相机（rhine-motif.js 的 rl_curve + focal 投影）──
  // 旧实现把锚点放在 SVG 的 r=215 圆弧上，环体换成 Gerono 双纽线后引线就悬空了。
  function computeExternalOrbit(idx, total) {
    const half = Math.ceil(total / 2);
    const spread = Math.min(380, Math.max(200, (half - 1) * 145));
    const left = idx < half;
    const count = left ? half : total - half;
    const rank = left ? idx : idx - half;
    const ratio = count === 1 ? 0 : rank / (count - 1) - 0.5;
    const cardX = left ? 85 : 1115;
    const cardY = 285 + ratio * spread;
    return {
      side: left ? 'left' : 'right',
      cardX, cardY,
      cardXPct: cardX / 1200 * 100,
      cardYPct: cardY / 570 * 100,
    };
  }

  function closeSpecimen() {
    if (specimenPanel.hidden || !specimenPanel.dataset.idx) return;
    if (window.RhineAudio) {
      RhineAudio.close();
      RhineAudio.sfx('panelClose', 1.6);   // 关闭音效，比打开略轻
    }
    specimenPanel.dataset.idx = '';
    selectedIndex = -1;
    window.RhineMotif?.clearFocus?.();
    window.RhineMotif?.clearSelect?.();
    window.RhineMotif?.setMenuFrame?.(null);
    const opacity = getComputedStyle(specimenPanel).opacity;
    panelAnimation?.cancel();
    const finish = () => {
      panelAnimation = null;
      specimenPanel.hidden = true;
      shell.classList.remove('has-selection');
      renderOrbitFromNative();
    };
    if (motionReduce() || typeof specimenPanel.animate !== 'function') { finish(); return; }
    const anim = panelAnimation = specimenPanel.animate(
      [{ opacity }, { opacity: 0 }],
      { duration: 330, easing: 'ease-in', fill: 'forwards' }
    );
    const finishClosing = () => {
      clearTimeout(timeout);
      if (panelAnimation !== anim) return;
      finish();
      anim.cancel();
    };
    const timeout = setTimeout(finishClosing, 450);
    anim.addEventListener('finish', finishClosing, { once: true });
  }
  specimenCloseBtn.addEventListener('click', closeSpecimen);

  // 5. 同步左栏迷你归档矩阵（从原生 #history 读取真实记录，若无则渲染空槽位）
  function syncMiniArchive() {
    const historyEl = document.getElementById('history');
    if (!railMiniMatrix || !historyEl) return;
    const dates = Array.from(historyEl.querySelectorAll('.m-date'));
    if (dates.length === 0) {
      railMiniMatrix.innerHTML = `<div class="rh-label" style="font-size:9px;">NO ARCHIVE SNAPSHOTS</div>`;
      return;
    }
    const cols = Math.max(1, Math.floor((historyEl.children.length - dates.length) / dates.length));
    const allChildren = Array.from(historyEl.children);
    // 跳过表头行
    let startIdx = allChildren.findIndex(el => el.classList.contains('m-date'));
    if (startIdx < 0) return;

    let html = '';
    const maxRows = Math.min(5, dates.length);
    for (let r = 0; r < maxRows; r++) {
      const rowStart = startIdx + r * (cols + 1);
      const dateText = allChildren[rowStart]?.textContent || '--';
      let dotsHtml = '';
      for (let c = 1; c <= cols; c++) {
        const cell = allChildren[rowStart + c];
        const isYes = cell && cell.classList.contains('yes');
        dotsHtml += `<span class="mini-m-dot ${isYes ? 'yes' : ''}"></span>`;
      }
      html += `<div class="mini-m-row"><span class="mini-m-date">${escapeHtml(dateText)}</span><div class="mini-m-cells">${dotsHtml}</div></div>`;
    }
    railMiniMatrix.innerHTML = html;
  }

  // 6. 底部假终端遥测流（融合真实游戏进度与莱茵风格状态行）
  function updateFakeTerminal(gameCards, dDone, dTot, wDone, wTot) {
    if (!fakeTerminalFeed) return;
    // 终端内容由日志模块负责，这里只做重绘，别再清空
    renderDailyLog();
    return;
    const now = new Date();
    const stamp = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
    const pendingNames = gameCards
      .filter(c => !c.querySelector('.checks input[type="checkbox"]')?.checked)
      .map(c => c.querySelector('.name')?.textContent.trim())
      .filter(Boolean);

    const line1 = `<span><b class="c-tag">[${stamp} SYS]</b> LEMNISCATE ORBIT SYNCED · DAILY ${dDone}/${dTot} · WEEKLY ${wDone}/${wTot}</span><span>JST-05:00</span>`;
    const line2 = pendingNames.length > 0
      ? `<span><b class="c-tag">[QUEUE]</b> PENDING SECTORS: ${escapeHtml(pendingNames.join(' / '))}</span><span>ACTIVE</span>`
      : `<span><b class="c-tag">[ARCHIVE]</b> ALL DAILY OPERATIONS VERIFIED &amp; SEALED</span><span>STANDBY</span>`;

    fakeTerminalFeed.innerHTML = `<div class="console-line">${line1}</div><div class="console-line">${line2}</div>`;
  }

  // ── 遥测方块条：数字不显示，用格子填充（与归档矩阵同宽） ──
  function fillStrip(stripEl, done, total) {
    if (!stripEl) return;
    const n = Math.max(0, Math.min(48, Number(total) || 0));
    if (stripEl.children.length !== n) {
      stripEl.innerHTML = Array.from({ length: n }, () => '<i></i>').join('');
    }
    const d = Math.max(0, Number(done) || 0);
    [...stripEl.children].forEach((cell, i) => cell.classList.toggle('on', i < d));
  }

  function renderStrips() {
    const n = id => parseInt((document.getElementById(id) || {}).textContent || '0', 10) || 0;
    const games = gamesPool ? gamesPool.querySelectorAll('.game').length : 0;
    fillStrip(document.getElementById('strip-daily'), n('daily'), n('daily-total'));
    fillStrip(document.getElementById('strip-weekly'), n('weekly'), n('weekly-total'));
    fillStrip(document.getElementById('strip-monthly'), n('monthly'), games);
  }

  // ── 左栏：每款游戏 = 版本剩余 + 角色池/武器池两条抽卡进度 ──
  const VERSION_CYCLE_DAYS = 30;

  function readWish(row, pool) {
    const pullsEl = row.querySelector(`.${pool}-pulls`);
    const fixedEl = row.querySelector(`.${pool}-fixed`);
    const guarEl = row.querySelector(`.${pool}-guaranteed`);
    const pulls = pullsEl ? parseInt(pullsEl.value, 10) || 0 : 0;
    const fixed = fixedEl ? parseInt(fixedEl.value, 10) || 0 : 0;
    const locked = !!(fixedEl && fixedEl.classList.contains('locked'));
    const total = locked ? pulls + fixed : fixed;   // 锁定时输入框显示的是「还差多少」
    return { pulls, total: total > 0 ? total : 0, guaranteed: !!(guarEl && guarEl.checked) };
  }

  function renderPoolBars() {
    const list = document.getElementById('poolList');
    if (!list || !gamesPool) return;
    const rows = [...gamesPool.querySelectorAll('.game')];
    const data = rows.map((row, i) => {
      const cd = row.querySelector('.version-countdown');
      const m = (cd ? cd.textContent : '').match(/剩余\s*(\d+)\s*天/);
      return {
        idx: i + 1,
        days: m ? parseInt(m[1], 10) : null,
        character: readWish(row, 'character'),
        banner: readWish(row, 'banner'),
      };
    });

    if (list.children.length !== data.length) {
      list.innerHTML = data.map(() => `
        <div class="pool-group">
          <div class="pg-head"><span class="pid">--</span><span class="pver">VER</span><span class="pdays">—</span></div>
          <div class="pg-bar version"><i></i></div>
          <div class="pg-tags"><span>角色池</span><span class="c-txt">—</span></div>
          <div class="pg-bar wish char"><i></i></div>
          <div class="pg-tags"><span>武器池</span><span class="w-txt">—</span></div>
          <div class="pg-bar wish wpn"><i></i></div>
        </div>`).join('');
    }

    data.forEach((d, i) => {
      const g = list.children[i];
      if (!g) return;
      g.querySelector('.pid').textContent = `SEC-${String(d.idx).padStart(2, '0')}`;
      g.querySelector('.pdays').textContent = d.days == null ? '—' : `${d.days}D`;

      const vBar = g.querySelector('.pg-bar.version i');
      vBar.style.width = d.days == null ? '0%'
        : `${Math.max(0, Math.min(100, (d.days / VERSION_CYCLE_DAYS) * 100)).toFixed(1)}%`;

      [['character', '.c-txt'], ['banner', '.w-txt']].forEach(([key, txtSel], order) => {
        const w = d[key];
        const bar = g.querySelectorAll('.pg-bar.wish i')[order];
        const pct = w.total > 0 ? Math.max(0, Math.min(100, (w.pulls / w.total) * 100)) : 0;
        bar.style.width = `${pct.toFixed(1)}%`;
        bar.parentElement.classList.toggle('guaranteed', w.guaranteed);
        g.querySelector(txtSel).textContent = w.total > 0 ? `${w.pulls}/${w.total}` : `${w.pulls}/—`;
      });
    });
  }

  // ── 除游戏卡外一律用编号（SEC-01 的数字部分）──────────────
  function numberizeLabels() {
    document.querySelectorAll('#history .m-head').forEach((el, i) => {
      const n = String(i + 1).padStart(2, '0');
      if (el.textContent !== n) el.textContent = n;
    });
    document.querySelectorAll('#weeklyStatus .week .w-name').forEach((el, i) => {
      const n = String(i + 1).padStart(2, '0');
      if (el.textContent !== n) el.textContent = n;
    });
  }

  function watchLabels() {
    const obs = new MutationObserver(() => numberizeLabels());
    ['history', 'weeklyStatus'].forEach(id => {
      const el = document.getElementById(id);
      if (el) obs.observe(el, { childList: true, subtree: true, characterData: true });
    });
    numberizeLabels();
  }

  // 筛选 tab 变化后重算外围节点（「日常未完成」隐藏已完成）
  document.querySelectorAll('.filter-tabs button[data-filter]').forEach(btn => {
    btn.addEventListener('click', () => setTimeout(applyFilterVisual, 0));
  });

  watchLabels();

  // 切换筛选时只改类名，不重建节点——否则新节点一出生就带终态，过渡不会触发
  function applyFilterVisual() {
    suppressRebuild = true;                 // 筛选期间不重建，保证节点连续
    setTimeout(() => { suppressRebuild = false; }, 500);

    const tab = document.querySelector('.filter-tabs button.active[data-filter]');
    const todoOnly = !!tab && tab.dataset.filter === 'todo';
    const rows = gamesPool ? [...gamesPool.querySelectorAll('.game')] : [];
    const isDone = i => {
      const cb = rows[i] ? rows[i].querySelector('.checks input[type="checkbox"]') : null;
      return !!(cb && cb.checked);
    };
    const reduce = motionReduce();

    // 用 Web Animations 显式补间，避免「新节点出生即终态」导致 transition 不播
    const tween = (el, hide) => {
      if (!el) return;
      const already = el.classList.contains('is-filtered-out');
      if (hide === already) return;
      if (hide) el.classList.add('is-filtered-out');
      if (!reduce) {
        const drift = hide ? -1 : 1;
        el.animate(
          hide
            ? [{ opacity: 1, transform: 'translateY(0) scale(1)' },
               { opacity: 0.55, transform: `translateY(${drift * 18}px) scale(0.97)`, offset: 0.55 },
               { opacity: 0, transform: `translateY(${drift * 46}px) scale(0.93)` }]
            : [{ opacity: 0, transform: `translateY(${-46}px) scale(0.93)` },
               { opacity: 0.55, transform: `translateY(${-18}px) scale(0.97)`, offset: 0.45 },
               { opacity: 1, transform: 'translateY(0) scale(1)' }],
          { duration: 900, easing: 'cubic-bezier(.25,.8,.25,1)', fill: 'both', delay: hide ? 0 : 0 }
        );
      }
      if (!hide) el.classList.remove('is-filtered-out');
    };

    document.querySelectorAll('.orbit-node').forEach(n => {
      const i = parseInt(n.dataset.idx, 10);
      tween(n, todoOnly && isDone(i));
    });
    document.querySelectorAll('#orbitCalloutLines [data-idx]').forEach(el => {
      const i = parseInt(el.dataset.idx, 10);
      tween(el, todoOnly && isDone(i));
    });
  }

  // ── 终端日志：记录每天「何时完成了哪个游戏的日常」 ──
  // 主存储是宿主 dataDir/daily-log.json（跨端口、跨启动、清浏览器数据都不丢）；
  // 只有脱离宿主直接开页面时才退回 localStorage。
  const DAILY_LOG_KEY = 'rhine-daily-log-v1';
  const LOG_API = 'api/log';
  const LOG_HOSTED = location.hostname === '127.0.0.1' || location.hostname === 'app.local';
  let dailyLogCache = [];

  function logToken() {
    const seg = location.pathname.split('/').filter(Boolean);
    return seg.length ? seg[0] : '';
  }
  async function logRequest(method, body) {
    const response = await fetch(LOG_API, {
      method,
      headers: {'Content-Type': 'application/json', 'X-Desktop-Token': logToken()},
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '日志接口失败');
    return result;
  }
  function loadLocalLog() {
    try { return JSON.parse(localStorage.getItem(DAILY_LOG_KEY) || '[]'); } catch (e) { return []; }
  }
  function saveLocalLog(list) {
    try { localStorage.setItem(DAILY_LOG_KEY, JSON.stringify(list.slice(-200))); } catch (e) {}
  }

  function renderDailyLog() {
    const feed = document.getElementById('fakeTerminalFeed');
    if (!feed) return;
    const list = dailyLogCache.slice(-6).reverse();
    if (!list.length) {
      feed.innerHTML = '<div class="console-line"><span>IDLE · 勾选任意游戏的「日常」即写入日志</span><span>STANDBY</span></div>';
      return;
    }
    feed.innerHTML = list.map(e => {
      const done = e.act === '完成';
      const label = done ? (e.src === 'auto' ? '自动完成' : '日常完成') : '已撤销';
      return `<div class="console-line"><span><b class="c-tag">[${e.time}]</b> ${e.code} ${escapeHtml(e.name)} · ${label}</span><span>${e.date}</span></div>`;
    }).join('');
  }

  async function syncDailyLog() {
    if (!LOG_HOSTED) { dailyLogCache = loadLocalLog(); renderDailyLog(); return; }
    try {
      const result = await logRequest('GET');
      if (Array.isArray(result.entries)) dailyLogCache = result.entries;
    } catch (e) {
      dailyLogCache = loadLocalLog();
    }
    renderDailyLog();
  }

  async function logDailyEvent(row, checked, src) {
    const rows = [...document.querySelectorAll('#games .game')];
    const idx = rows.indexOf(row);
    const name = (row.querySelector('.name')?.textContent || '').trim() || `NODE-${idx + 1}`;
    const now = new Date();
    const entry = {
      time: now.toTimeString().slice(0, 8),
      date: `${now.getMonth() + 1}/${now.getDate()}`,
      code: `SEC-${String(idx + 1).padStart(2, '0')}`,
      name,
      act: checked ? '完成' : '撤销',
      src: src === 'auto' ? 'auto' : 'user',
    };
    dailyLogCache = dailyLogCache.concat([entry]).slice(-200);
    renderDailyLog();
    if (!LOG_HOSTED) { saveLocalLog(dailyLogCache); return; }
    try {
      const result = await logRequest('POST', {action: 'append', entry});
      if (result && Number.isFinite(result.count) && dailyLogCache.length > result.count) {
        dailyLogCache = dailyLogCache.slice(-result.count);
      }
    } catch (e) {
      saveLocalLog(dailyLogCache); // 接口不可用时兜底，下次同步不会丢太多
    }
  }

  function flashDeniedError() {
    const slot = document.getElementById('rhine-motif-slot');
    const motif = window.RhineMotif;
    if (!slot || !motif?.setDenied) return;
    if (document.documentElement.dataset.transition || slot.dataset.transition) return;
    motif.setDenied(1, { duration: 50, sweep: 50, hold: 180, release: 110 });
    motif.tremble();
  }

  // 只记「状态真的变了」：app.js 的 applyDaily 与助手指令都会派发 rhine:daily-change。
  // 不再监听 DOM change —— 那条路上出现过「人没撤销、日志多一笔撤销」的幽灵记录。
  window.addEventListener('rhine:daily-change', event => {
    const detail = event.detail || {};
    const rows = [...document.querySelectorAll('#games .game')];
    const index = rows.findIndex(r => r.dataset.id === detail.id);
    if (index >= 0) {
      logDailyEvent(rows[index], !!detail.value, detail.src || 'user');
      // 勾选/取消都在环上对应扇区放一次脉冲，作为「这一次操作」的可见反馈
      if (window.RhineMotif) window.RhineMotif.pulseAt(index, rows.length);
      // 取消勾选额外让整环闪一下错误态（不保持）
      if (!detail.value) flashDeniedError();
    }
  });

  // ── 引脚线绑定：锚点不再是椭圆的近似位置，而是环上真实那片鳍片的屏幕坐标 ──
  const calloutRootSvg = calloutLinesSvg ? calloutLinesSvg.ownerSVGElement : null;
  function toViewBox(clientX, clientY) {
    if (!calloutRootSvg) return null;
    const m = calloutRootSvg.getScreenCTM();
    if (!m) return null;
    const pt = calloutRootSvg.createSVGPoint();
    pt.x = clientX; pt.y = clientY;
    const p2 = pt.matrixTransform(m.inverse());
    return { x: p2.x, y: p2.y };
  }

  let calloutRaf = 0;
  let calloutParams = [];        // 每张卡片绑定的曲线参数（分带分配，一卡一片）
  let calloutRoster = '';

  function assignLobe(refs, candidates) {
    if (!refs.length || candidates.length < refs.length) return [];
    refs.sort((a, b) => a.y - b.y);
    candidates.sort((a, b) => a.y - b.y);
    const top = candidates[0].y;
    const bandHeight = (candidates.at(-1).y - top) / refs.length;
    const bands = refs.map(() => []);
    for (const [rank, fin] of candidates.entries()) {
      const band = bandHeight ? Math.floor((fin.y - top) / bandHeight) : rank;
      bands[Math.min(band, refs.length - 1)].push(fin);
    }
    // Keep every band populated when the projection is sparsely sampled.
    if (bands.some(band => !band.length)) {
      bands.forEach((_, i) => {
        bands[i] = candidates.slice(
          Math.floor(i * candidates.length / refs.length),
          Math.floor((i + 1) * candidates.length / refs.length)
        );
      });
    }

    const depths = candidates.map(fin => fin.depth);
    const nearestDepth = Math.min(...depths);
    const depthRange = Math.max(...depths) - nearestDepth || 1;
    // Reserve extra room between adjacent bands' anchors. Among sequences
    // with the same spacing penalty, prefer short leads and front-facing fins.
    const preferredGap = bandHeight * 1.12;
    let previous = [];
    for (const [i, band] of bands.entries()) {
      const ref = refs[i];
      const current = [];
      for (const fin of band) {
        const cost = Math.hypot(fin.x - ref.x, fin.y - ref.y)
          + 3 * (fin.depth - nearestDepth) / depthRange;
        let best = i === 0 ? { fin, gapCost: 0, cost, parent: null } : null;
        for (const parent of previous) {
          const gap = fin.y - parent.fin.y;
          if (gap <= 0) continue;
          const gapCost = parent.gapCost + Math.max(0, preferredGap - gap) ** 2;
          const totalCost = parent.cost + cost;
          if (!best || gapCost < best.gapCost || (gapCost === best.gapCost && totalCost < best.cost)) {
            best = { fin, gapCost, cost: totalCost, parent };
          }
        }
        if (best) current.push(best);
      }
      previous = current;
    }
    previous.sort((a, b) => a.gapCost - b.gapCost || a.cost - b.cost);
    const params = [];
    for (let choice = previous[0]; choice; choice = choice.parent) params.unshift(choice.fin.param);
    return params;
  }

  function assignCallouts() {
    const motif = window.RhineMotif;
    const svg = calloutRootSvg;
    const m = svg?.getScreenCTM();
    if (!motif?.paramScreen || !m) return;
    const nodes = [...document.querySelectorAll('#orbitNodes .orbit-node')];
    if (!nodes.length) return;

    const refs = [[], []];
    for (const node of nodes) {
      const poly = calloutLinesSvg.querySelector(`path[data-idx="${node.dataset.idx}"]`);
      const [x, y] = (poly?.dataset.card || '600,285').split(',').map(Number);
      const screen = new DOMPoint(x, y).matrixTransform(m);
      const side = node.classList.contains('side-left') ? 0 : 1;
      refs[side].push({ idx: Number(node.dataset.idx), x: screen.x, y: screen.y });
    }
    const centerX = new DOMPoint(600, 285).matrixTransform(m).x;
    const candidates = [[], []];
    for (let i = 0; i < motif.finCount; i++) {
      const param = i / motif.finCount;
      const screen = motif.paramScreen(param, true);
      if (screen) candidates[screen.x < centerX ? 0 : 1].push({ ...screen, param });
    }

    const params = [];
    for (const [side, lobeRefs] of refs.entries()) {
      const assigned = assignLobe(lobeRefs, candidates[side]);
      if (assigned.length !== lobeRefs.length) return;
      lobeRefs.forEach(({ idx }, i) => { params[idx] = assigned[i]; });
    }
    calloutParams = params;
    layoutSpecimenFrame();
  }

  function updateCalloutAnchors() {
    cancelAnimationFrame(calloutRaf);
    calloutRaf = 0;
    const motif = window.RhineMotif;
    if (!calloutLinesSvg || !motif?.paramScreen) return;
    const polys = [...calloutLinesSvg.querySelectorAll('path[data-idx]')];
    const project = poly => {
      const param = calloutParams[Number(poly.dataset.idx)];
      return param == null ? null : motif.paramScreen(param);
    };
    let points = polys.map(project);
    if (points.some(point => !point)) {
      assignCallouts();
      points = polys.map(project);
    }
    polys.forEach((poly, i) => {
      const point = points[i];
      const anchor = point && toViewBox(point.x, point.y);
      const dot = calloutLinesSvg.querySelector(`circle[data-idx="${poly.dataset.idx}"]`);
      poly.style.display = anchor ? '' : 'none';
      if (dot) dot.style.display = poly.style.display;
      if (!anchor) return;
      const cardParts = (poly.dataset.card || '600,285').split(',').map(Number);
      const cx0 = cardParts[0], cy0 = cardParts[1];
      const dx = cx0 - anchor.x;
      poly.setAttribute('d',
        `M ${anchor.x.toFixed(1)},${anchor.y.toFixed(1)} `
        + `C ${(anchor.x + dx * 0.42).toFixed(1)},${anchor.y.toFixed(1)} `
        + `${(cx0 - dx * 0.42).toFixed(1)},${cy0.toFixed(1)} `
        + `${cx0.toFixed(1)},${cy0.toFixed(1)}`);
      if (dot) {
        dot.setAttribute('cx', anchor.x.toFixed(1));
        dot.setAttribute('cy', anchor.y.toFixed(1));
      }
    });
  }
  function requestCallout() {
    if (!calloutRaf) calloutRaf = requestAnimationFrame(updateCalloutAnchors);
  }

  function syncCalloutCardEdges() {
    if (!calloutLinesSvg) return;
    for (const node of orbitNodesEl.children) {
      const poly = calloutLinesSvg.querySelector(`path[data-idx="${node.dataset.idx}"]`);
      if (!poly) continue;
      const rect = node.getBoundingClientRect();
      if (!rect.width) continue;
      const edge = node.classList.contains('side-left') ? rect.right : rect.left;
      const point = toViewBox(edge, rect.top + rect.height / 2);
      if (point) {
        poly.dataset.card = `${point.x},${point.y}`;
      }
    }
    requestCallout();
  }
  window.addEventListener('resize', syncCalloutCardEdges);
  requestCallout();

  // 直接点环上的鳍片：找最近的一片，再打开它绑定的那张卡片
  function pickFinAt(clientX, clientY) {
    const motif = window.RhineMotif;
    if (!motif?.paramScreen) return null;
    let best = null;
    for (let i = 0; i < motif.finCount; i++) {
      const param = i / motif.finCount;
      const scr = motif.paramScreen(param);
      if (!scr) continue;
      const d = Math.hypot(scr.x - clientX, scr.y - clientY);
      if (!best || d < best.d || (d === best.d && scr.depth < best.depth)) {
        best = { param, d, depth: scr.depth };
      }
    }
    return best && best.d <= 30 ? best.param : null;
  }

  function blocksFinPick(target) {
    return target instanceof Element && target.closest('button, a, input, select, textarea, label, [role="button"], .orbit-node, .specimen-panel, .filter-tabs, .rail-pools, .stage-console, .hud-tl, .hud-tr, .hud-bl, .hud-br');
  }

  const root = document.documentElement;
  const motifSlot = document.getElementById('rhine-motif-slot');
  motifSlot.addEventListener('rhine-fin-projection', updateCalloutAnchors);
  const holdRing = document.getElementById('rhine-hold-ring');
  const holdArc = holdRing.querySelector('circle');
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  let centerHold = null;
  let arcRecovery = null;

  function centerHoldAvailable() {
    return !root.hasAttribute('data-startup') && !root.dataset.transition && specimenPanel.hidden;
  }

  function inRingCenter(event) {
    const { left, top, width, height } = motifSlot.getBoundingClientRect();
    return Math.hypot(event.clientX - left - width / 2, event.clientY - top - height / 2)
      <= 70 * Math.min(1, width / 1700);
  }

  function cancelCenterHold() {
    if (!centerHold) return;
    const { frame, reduced, offset } = centerHold;
    centerHold = null;
    cancelAnimationFrame(frame);
    if (reduced) return;
    window.RhineMotif?.setDenied(0, { duration: 180, sweep: 180 });
    const recovery = holdArc.animate(
      [{ strokeDashoffset: String(offset) }, { strokeDashoffset: '0' }], 180
    );
    arcRecovery = recovery;
    holdArc.style.strokeDashoffset = '0';
    recovery.onfinish = () => {
      if (arcRecovery !== recovery) return;
      holdRing.removeAttribute('data-active');
      arcRecovery = null;
    };
  }

  function startCenterHold(event) {
    const reduced = reducedMotion.matches;
    const start = performance.now();
    const duration = reduced ? 1000 : 1500;   // 用户要求：600ms 太短，改 1.5s（reduce-motion 按比例给 1.0s）
    const hold = { pointerId: event.pointerId, frame: 0, reduced, offset: 0, lastPulse: 0, voicePlayed: false };
    centerHold = hold;
    arcRecovery?.cancel();
    arcRecovery = null;
    if (!reduced) {
      holdArc.style.strokeDashoffset = '0';
      holdRing.setAttribute('data-active', '');
      window.RhineMotif?.setDenied(0);
      window.RhineMotif?.setDenied(1, { duration, sweep: duration, start });
    } else {
      holdRing.removeAttribute('data-active');
    }

    function update(time) {
      if (!centerHoldAvailable()) {
        cancelCenterHold();
        return;
      }
      const progress = Math.min(1, Math.max(0, (time - start) / duration));
      // 按住 0.95s 后播那句人声。再晚就会撞上 2.8s 的切页（按住 1.5s + 转场 1.3s），尾巴被切掉
      if (!hold.voicePlayed && time - start >= 950) {
        hold.voicePlayed = true;
        window.RhineAudio?.voice('holdVoice');
      }
      if (!reduced) {
        hold.offset = 360 * progress;
        holdArc.style.strokeDashoffset = String(hold.offset);
        // 按住期间让环上一直有脉冲在跑，越接近满格越密（520ms → 280ms）
        const interval = 520 - 240 * progress;
        if (!hold.lastPulse) hold.lastPulse = time;   // 按下那一刻不要立刻放脉冲，否则等于普通点击脉冲
        if (time - hold.lastPulse >= interval) {
          hold.lastPulse = time;
          window.RhineMotif?.pulse();
          // 脉冲配上音效，越接近满格越响一点（1.2 → 1.6）
          if (window.RhineAudio) RhineAudio.sfx('holdPulse', 1.2 + 0.4 * progress);
        }
      }
      if (progress < 1) {
        hold.frame = requestAnimationFrame(update);
        return;
      }
      centerHold = null;
      holdRing.removeAttribute('data-active');
    }
    hold.frame = requestAnimationFrame(update);
  }

  window.addEventListener('blur', cancelCenterHold);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) cancelCenterHold();
  });
  new MutationObserver(() => {
    if (!centerHoldAvailable()) cancelCenterHold();
  }).observe(root, { attributes: true, attributeFilter: ['data-transition', 'data-startup'] });
  root.addEventListener('pointerleave', cancelCenterHold);
  for (const type of ['pointerup', 'pointercancel', 'pointermove']) {
    document.addEventListener(type, event => {
      if (event.pointerId === centerHold?.pointerId && (type !== 'pointermove' || !inRingCenter(event))) {
        cancelCenterHold();
      }
    }, true);
  }

  document.addEventListener('pointerdown', event => {
    if (event.button !== 0 || blocksFinPick(event.target)) return;
    const param = pickFinAt(event.clientX, event.clientY);
    const idx = calloutParams.indexOf(param);
    if (idx < 0 && event.isPrimary && !centerHold && centerHoldAvailable() && inRingCenter(event)) {
      event.preventDefault();
      startCenterHold(event);
      return;
    }
    if (!calloutParams.length) return;
    if (idx < 0) {
      return;
    }
    const clickable = document.querySelector(`#orbitNodes .orbit-node[data-idx="${idx}"] .node-main-click`);
    if (!clickable) return;
    event.preventDefault();
    clickable.click();
  });

  syncDailyLog();

  // 7. 主同步函数：渲染外围游戏卡片 + SVG 折线指向 + 快捷操作按钮
  function renderOrbitFromNative() {
    if (!gamesPool) return;
    if (selectedIndex < 0) window.RhineMotif?.clearFocus?.();
    const allCards = Array.from(gamesPool.querySelectorAll('.game'));
    const roster = JSON.stringify(allCards.map(card => card.dataset.id));
    if (roster !== calloutRoster) {
      calloutRoster = roster;
      calloutParams = [];
    }
    requestCallout();
    const activeTabEl = document.querySelector('.filter-tabs button.active[data-filter]');
    const todoOnly = !!activeTabEl && activeTabEl.dataset.filter === 'todo';
    const isDone = c => !!c.querySelector('.checks input[type="checkbox"]')?.checked;
    // 「日常未完成」：隐藏已完成日常的卡片与其指示线，剩余节点重新分布
    const gameCards = allCards;          // 始终按全量渲染，位置稳定
    const total = allCards.length;

    if (railTelemetry) {
      railTelemetry.textContent = `NODES // ${String(total).padStart(2, '0')} ACTIVE`;
    }

    const dDone = parseInt(document.getElementById('daily')?.textContent || '0', 10);
    const dTot = parseInt(document.getElementById('daily-total')?.textContent || '0', 10);
    const wDone = parseInt(document.getElementById('weekly')?.textContent || '0', 10);
    const wTot = parseInt(document.getElementById('weekly-total')?.textContent || '0', 10);

    const ratio = dTot > 0 ? dDone / dTot : 0;
    const activeStep = Math.min(4, Math.floor(ratio * 5));
    stepNodes.forEach((n, i) => n.classList.toggle('active', i === activeStep));

    const activeTab = document.querySelector('.filter-tabs button.active[data-filter]');
    if (filterBadge && activeTab) {
      filterBadge.textContent = activeTab.dataset.filter === 'todo' ? 'PENDING ONLY' : 'ALL SECTORS';
    }

    orbitNodesEl.innerHTML = '';
    if (calloutLinesSvg) calloutLinesSvg.innerHTML = '';

    gameCards.forEach((card, idx) => {
      const nameEl = card.querySelector('.name');
      const gameName = nameEl ? nameEl.textContent.trim() : `NODE-${idx + 1}`;
      const launchBtn = card.querySelector('.launch');
      const checkboxes = card.querySelectorAll('.checks input[type="checkbox"]');
      const dailyCb = checkboxes[0];
      const weeklyCb = checkboxes[1];
      const dailyChecked = dailyCb ? dailyCb.checked : false;
      const weeklyChecked = weeklyCb ? weeklyCb.checked : false;
      const cardInput = card.querySelector('.card-input');
      const monthDays = cardInput ? cardInput.value : '0';
      const pullInputs = card.querySelectorAll('.pull-input');
      const charPulls = pullInputs[0] ? pullInputs[0].value : '0';

      const pos = computeExternalOrbit(idx, total);
      const codeStr = String(idx + 1).padStart(2, '0');

      // 绘制 SVG 折线引线（环上锚点 -> 拐点 -> 外围游戏卡边缘）
      if (calloutLinesSvg) {
        const poly = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        poly.style.display = 'none';
        poly.dataset.idx = String(idx);
        poly.dataset.card = `${pos.cardX},${pos.cardY}`;
        calloutLinesSvg.appendChild(poly);

        const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        dot.style.display = 'none';
        dot.setAttribute('r', '5.5');
        dot.dataset.idx = String(idx);
        dot.setAttribute('class', `anchor-dot ${dailyChecked ? 'is-done' : ''}`);
        calloutLinesSvg.appendChild(dot);
      }

      // 构建外围游戏卡片（含快捷日常勾选 + 快速启动）
      const node = document.createElement('div');
      node.className = 'orbit-node'
        + (pos.side === 'left' ? ' side-left' : ' side-right')
        + (dailyChecked ? ' is-done' : '')
        + (selectedIndex === idx ? ' is-selected' : '')
;
      node.dataset.idx = String(idx);
      node.style.setProperty('--orbit-x', `${pos.cardXPct.toFixed(2)}%`);
      node.style.top = `${pos.cardYPct.toFixed(2)}%`;
      node.setAttribute('role', 'listitem');

      const canLaunch = launchBtn && !launchBtn.disabled;
      const passNum = Math.max(0, Number(monthDays) || 0);
      const passPct = Math.min(100, Math.round((passNum / 30) * 100));
      const passState = passNum <= 0 ? 'is-empty' : (passNum <= 5 ? 'is-low' : 'is-ok');

      node.innerHTML = `
        <div class="node-pass-rail ${passState}" title="月卡余量：${passNum} 天（30 天满格）" aria-hidden="true">
          <i style="width:${passPct}%"></i>
        </div>
        <div class="node-main-click" title="点击展开详细档案（月卡/卡池/抽卡）">
          <div class="node-tag-top">
            <span class="node-code">SEC-${codeStr}</span>
            <span class="node-state-dot"><i></i>${dailyChecked ? 'CLEARED' : 'PENDING'}</span>
          </div>
          <div class="node-title">${escapeHtml(gameName)}</div>
          <div class="node-sub-meta">W:${weeklyChecked ? 'OK' : '--'} · PASS:${monthDays}D · PULL:${charPulls}</div>
        </div>
        <div class="node-quick-bar">
          <button type="button" class="node-quick-btn q-daily ${dailyChecked ? 'is-checked' : ''}">
            <span class="q-dot"></span>${dailyChecked ? '日常已完' : '完成日常'}
          </button>
          <button type="button" class="node-quick-btn q-launch" ${canLaunch ? '' : 'disabled'}>
            启动游戏
          </button>
        </div>
      `;

      node.addEventListener('mouseenter', () => {
        const param = calloutParams[idx];
        if (specimenPanel.hidden && param != null) window.RhineMotif?.focusAt(param);
      });
      node.addEventListener('mouseleave', () => {
        if (specimenPanel.hidden) window.RhineMotif?.clearFocus?.();
      });

      const main = node.querySelector('.node-main-click');
      // 按压瞬间就出声，不等 click（click 在抬手时才触发，听感会滞后）
      main.addEventListener('pointerdown', () => {
        if (window.RhineAudio) RhineAudio.pulse();
      }, { passive: true });

      // 点击卡片主体打开标本详情罩
      main.addEventListener('click', () => {
        selectedIndex = idx;
        if (railCursor && total > 1) {
          railCursor.style.top = `${8 + (idx / (total - 1)) * 80}%`;
        }
        renderOrbitFromNative();
      });

      // 快捷按钮 1：直接切换日常完成
      node.querySelector('.q-daily').addEventListener('click', (e) => {
        e.stopPropagation();
        if (dailyCb) dailyCb.click();
      });

      // 快捷按钮 2：直接启动游戏
      node.querySelector('.q-launch').addEventListener('click', (e) => {
        e.stopPropagation();
        if (launchBtn && !launchBtn.disabled) launchBtn.click();
      });

      orbitNodesEl.appendChild(node);
    });

    syncCalloutCardEdges();
    syncMiniArchive();
    updateFakeTerminal(gameCards, dDone, dTot, wDone, wTot);
    renderStrips();
    renderPoolBars();
    numberizeLabels();
    // 双 rAF + 强制一次布局，确保浏览器先算过「无类」的初始样式，过渡才会真正播放
    requestAnimationFrame(() => {
      void document.body.offsetHeight;
      requestAnimationFrame(() => applyFilterVisual());
    });

    if (selectedIndex >= 0 && gameCards[selectedIndex]) {
      openSpecimenForCard(gameCards[selectedIndex], selectedIndex);
    } else if (selectedIndex >= total) {
      closeSpecimen();
    }
  }

  let panelAnimation = null;

  function layoutSpecimenFrame() {
    if (specimenPanel.hidden || !specimenPanel.dataset.idx) return;
    const slot = document.getElementById('rhine-motif-slot');
    const bounds = slot?.getBoundingClientRect();
    const x = bounds ? bounds.left + bounds.width / 2 : window.innerWidth / 2;
    const y = bounds ? bounds.top + bounds.height / 2 : window.innerHeight / 2;
    specimenPanel.style.right = 'auto';
    specimenPanel.style.bottom = 'auto';
    const width = specimenPanel.offsetWidth;
    const height = specimenPanel.offsetHeight;
    const left = Math.round(Math.max(16, Math.min(x - width / 2, window.innerWidth - width - 16)));
    const top = Math.round(Math.max(16, Math.min(y - height / 2, window.innerHeight - height - 16)));
    specimenPanel.style.left = left + 'px';
    specimenPanel.style.top = top + 'px';

    const motif = window.RhineMotif;
    if (!motif) return;
    const param = calloutParams[Number(specimenPanel.dataset.idx)];
    if (param == null) {
      motif.setMenuFrame?.(null);
      motif.clearSelect();
      motif.clearFocus();
      return;
    }
    motif.setMenuFrame?.(param, calloutParams, specimenPanel.getBoundingClientRect());
    motif.focusAt(param);
    motif.selectAt(param);
  }

  new ResizeObserver(layoutSpecimenFrame).observe(specimenPanel);
  window.addEventListener('resize', layoutSpecimenFrame);

  function expandFromCore(opacity) {
    if (window.RhineAudio) {
      RhineAudio.scatter();
      RhineAudio.sfx('panelOpen');          // 窗口打开的一次性音效，0s 起播
      // 三条轮换，避免同一条听腻
      RhineAudio.voice('panel' + (1 + Math.floor(Math.random() * 3)), 0.25);
    }
    panelAnimation?.cancel();
    panelAnimation = motionReduce() || typeof specimenPanel.animate !== 'function'
      ? null
      : specimenPanel.animate(
        [{ opacity, offset: 0 }, { opacity, offset: 0.18 }, { opacity: 1 }],
        { duration: 580, easing: 'ease-out' }
      );
  }

  function motionReduce() {
    try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; }
  }

  function openSpecimenForCard(card, idx) {
    cancelCenterHold();
    const opacity = specimenPanel.hidden ? 0 : Number(getComputedStyle(specimenPanel).opacity);
    const sameCard = specimenPanel.dataset.idx === String(idx);
    const alreadyOpen = !specimenPanel.hidden && sameCard;
    specimenPanel.hidden = false;
    specimenPanel.dataset.idx = String(idx);
    if (archiveDrawer) archiveDrawer.hidden = true;
    shell.classList.add('has-selection');

    const codeStr = String(idx + 1).padStart(2, '0');
    const nameEl = card.querySelector('.name');
    const launchBtn = card.querySelector('.launch');
    const checkboxes = card.querySelectorAll('.checks input[type="checkbox"]');
    const dailyCb = checkboxes[0];
    const weeklyCb = checkboxes[1];
    const cardInput = card.querySelector('.card-input');
    const topupBtn = card.querySelector('.topup');
    const countdownEl = card.querySelector('.version-countdown');
    const versionEditBtn = card.querySelector('.version-edit');
    const drawerEl = card.querySelector('.drawer');
    const pullRows = card.querySelectorAll('.pull');

    specimenIndex.textContent = `SECTOR // ${codeStr}`;
    specimenGhost.textContent = codeStr;
    specimenTitle.textContent = nameEl ? nameEl.textContent.trim() : `NODE-${codeStr}`;
    specimenStatusTag.textContent = dailyCb && dailyCb.checked ? 'STATUS // ARCHIVED' : 'STATUS // ACTIVE';

    specimenTitle.onclick = () => { if (nameEl) nameEl.click(); };

    if (specimenLaunchBtn) {
      specimenLaunchBtn.disabled = !launchBtn || launchBtn.disabled;
      specimenLaunchBtn.onclick = () => { if (launchBtn) launchBtn.click(); };
    }

    specimenBody.innerHTML = '';

    // 区块 1：日常与周常
    const taskSec = document.createElement('div');
    taskSec.className = 'spec-section';
    taskSec.innerHTML = `
      <div class="spec-section-head">
        <span class="rh-label">OPERATIONS // 任务核销</span>
        <span class="rh-label">JST 05:00</span>
      </div>
      <div class="spec-checks">
        <button type="button" class="spec-check-btn ${dailyCb && dailyCb.checked ? 'checked' : ''}" id="specDailyBtn">
          <span>日常任务</span><span class="dot"></span>
        </button>
        <button type="button" class="spec-check-btn ${weeklyCb && weeklyCb.checked ? 'checked' : ''}" id="specWeeklyBtn">
          <span>周常任务</span><span class="dot"></span>
        </button>
      </div>
    `;
    taskSec.querySelector('#specDailyBtn').onclick = () => { if (dailyCb) dailyCb.click(); };
    taskSec.querySelector('#specWeeklyBtn').onclick = () => { if (weeklyCb) weeklyCb.click(); };
    specimenBody.appendChild(taskSec);

    // 区块 2：月卡与版本周期
    const subSec = document.createElement('div');
    subSec.className = 'spec-section';
    subSec.innerHTML = `
      <div class="spec-section-head">
        <span class="rh-label">SUBSCRIPTION // 月卡与版本周期</span>
        <button type="button" class="secondary" id="specEditDateBtn" style="min-height:24px;padding:2px 8px;font-size:10px;">卡池日期</button>
      </div>
      <div class="spec-row-inline">
        <span>月卡剩余天数</span>
        <div style="display:flex;align-items:center;gap:6px;">
          <input type="number" id="specCardDays" value="${cardInput ? cardInput.value : 0}">
          <span class="rh-label">DAYS</span>
          <button type="button" id="specTopupBtn" style="min-height:26px;padding:3px 8px;font-size:11px;">+30天</button>
        </div>
      </div>
      <div class="spec-row-inline">
        <span>卡池倒计时</span>
        <span class="rh-code">${countdownEl ? countdownEl.textContent : '未设置'}</span>
      </div>
    `;
    const specCardDays = subSec.querySelector('#specCardDays');
    specCardDays.onchange = () => {
      if (cardInput) {
        cardInput.value = specCardDays.value;
        cardInput.dispatchEvent(new Event('input', { bubbles: true }));
      }
    };
    subSec.querySelector('#specTopupBtn').onclick = () => { if (topupBtn) topupBtn.click(); };
    const isDateOpen = !!(drawerEl && drawerEl.classList.contains('open'));
    const editDateBtn = subSec.querySelector('#specEditDateBtn');
    if (isDateOpen) editDateBtn.classList.add('active');
    editDateBtn.onclick = () => { if (versionEditBtn) versionEditBtn.click(); };

    if (isDateOpen) {
      const versionDateIn = drawerEl.querySelector('input[type="date"]');
      const versionSaveBtn = drawerEl.querySelector('.version-save');
      const versionClearBtn = drawerEl.querySelector('.version-clear');
      if (versionDateIn) {
        const dateWrap = document.createElement('div');
        dateWrap.className = 'spec-drawer-fields';
        dateWrap.innerHTML = `
          <label style="flex:1;">卡池截止日期<input type="date" id="specEndDate" min="0001-01-01" max="9999-12-31" value="${escapeHtml(versionDateIn.value || '')}"></label>
          <div style="display:flex;gap:6px;align-items:flex-end;">
            <button type="button" class="btn-solid" id="specSaveDateBtn" style="min-height:30px;padding:4px 10px;font-size:11px;">保存</button>
            <button type="button" class="secondary" id="specClearDateBtn" style="min-height:30px;padding:4px 10px;font-size:11px;">清除</button>
          </div>
        `;
        const specEndDate = dateWrap.querySelector('#specEndDate');
        specEndDate.onchange = (e) => {
          versionDateIn.value = e.target.value;
          versionDateIn.dispatchEvent(new Event('change', { bubbles: true }));
        };
        dateWrap.querySelector('#specSaveDateBtn').onclick = () => {
          versionDateIn.value = specEndDate.value;
          if (versionSaveBtn) versionSaveBtn.click();
        };
        dateWrap.querySelector('#specClearDateBtn').onclick = () => {
          if (versionClearBtn) versionClearBtn.click();
        };
        subSec.appendChild(dateWrap);
      }
    }
    specimenBody.appendChild(subSec);

    // 区块 3：抽卡统计
    if (pullRows.length > 0) {
      const wishSec = document.createElement('div');
      wishSec.className = 'spec-section';
      wishSec.innerHTML = `<div class="spec-section-head"><span class="rh-label">WISHES TELEMETRY // 抽卡水位</span><span class="rh-label">已垫 / 目标</span></div>`;

      pullRows.forEach((pRow, pIdx) => {
        const tag = pRow.querySelector('.pull-tag')?.textContent || (pIdx === 0 ? '角色' : '武器');
        const pIn = pRow.querySelector('.pull-input');
        const fIn = pRow.querySelector('.fixed-input');
        const btns = pRow.querySelectorAll('.pull-btn');
        const pityCb = pRow.querySelector('.pity input[type="checkbox"]');

        const block = document.createElement('div');
        block.className = 'spec-wish-block';
        block.innerHTML = `
          <div class="spec-row-inline">
            <span style="font-weight:700;">${escapeHtml(tag)}池</span>
            <div class="spec-wish-controls">
              <input type="number" class="w-cur" value="${pIn ? pIn.value : 0}" title="当前已垫抽数">
              <span class="rh-label">/</span>
              <input type="number" class="w-fix" value="${fIn ? fIn.value : ''}" placeholder="目标" title="目标或还差抽数">
              <button type="button" class="w-p1" style="min-height:26px;padding:3px 7px;">+1</button>
              <button type="button" class="w-p10" style="min-height:26px;padding:3px 7px;">+10</button>
              <button type="button" class="spec-pity-toggle ${pityCb && pityCb.checked ? 'active' : ''}">大保底</button>
            </div>
          </div>
        `;
        block.querySelector('.w-cur').onchange = (e) => {
          if (pIn) { pIn.value = e.target.value; pIn.dispatchEvent(new Event('input', { bubbles: true })); }
        };
        block.querySelector('.w-fix').onchange = (e) => {
          if (fIn) {
            fIn.value = e.target.value;
            fIn.dispatchEvent(new Event('blur'));
          }
        };
        block.querySelector('.w-p1').onclick = () => { if (btns[0]) btns[0].click(); };
        block.querySelector('.w-p10').onclick = () => { if (btns[1]) btns[1].click(); };
        block.querySelector('.spec-pity-toggle').onclick = () => { if (pityCb) pityCb.click(); };

        wishSec.appendChild(block);
      });
      specimenBody.appendChild(wishSec);
    }
    layoutSpecimenFrame();
    if (!alreadyOpen) expandFromCore(opacity);
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (m) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[m]));
  }

  let suppressRebuild = false;
  let pendingRebuild = null;
  const observer = new MutationObserver(() => {
    if (suppressRebuild) return;
    if (pendingRebuild) return;
    pendingRebuild = setTimeout(() => { pendingRebuild = null; renderOrbitFromNative(); }, 120);
  });
  if (gamesPool) {
    observer.observe(gamesPool, { childList: true, subtree: true, attributes: true, characterData: true });
  }
  const dailyEl = document.getElementById('daily');
  if (dailyEl) {
    observer.observe(dailyEl, { childList: true, characterData: true, subtree: true });
  }
  const historyEl = document.getElementById('history');
  if (historyEl) {
    observer.observe(historyEl, { childList: true, subtree: true });
  }

  // ---------- 人声挂点 ----------
  document.addEventListener('change', (e) => {
    const t = e.target;
    if (t && t.matches && t.matches('#games .game .daily-check')) {
      if (!window.RhineAudio) return;
      if (t.checked) {
        RhineAudio.sfx('dailyOk', 2.0);                                     // 确认音 0s
        RhineAudio.voice('daily' + (1 + Math.floor(Math.random() * 2)), 0.26);
      } else {
        RhineAudio.sfx('dailyUndo', 1.7);                                   // 撤销音 0s
        RhineAudio.voice('dailyoff' + (1 + Math.floor(Math.random() * 2)), 0.26);
      }
    }
  }, true);

  // 同一次「启动游戏」只会播一次：面板按钮会再合成点击一次行内 .launch，
  // 不拦的话 capture 阶段两条都命中，就会同时播两条语音。
  let launchVoiceAt = 0;
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (t && t.closest && t.closest('.launch, #specimenLaunchBtn')) {
      const now = performance.now();
      if (window.RhineAudio && now - launchVoiceAt > 600) {
        launchVoiceAt = now;
        RhineAudio.sfx('launchCue');   // 启动音效 0s，播报让到 0.3s 之后
        RhineAudio.voice('launch' + (1 + Math.floor(Math.random() * 2)), 0.30);   // 两条轮换
      }
    }
  }, true);

  // 退出：在 document 捕获阶段拦下，先播报再放行（app.js 的处理器绑在后面，元素级拦不住）
  document.addEventListener('click', (e) => {
    const btn = e.target && e.target.closest ? e.target.closest('#exitButton') : null;
    if (!btn || btn.dataset.exitArmed === '1') return;
    e.preventDefault();
    e.stopPropagation();
    btn.dataset.exitArmed = '1';
    const audioOn = document.documentElement.getAttribute('data-audio') !== 'off';
    if (audioOn && window.RhineAudio) RhineAudio.voice('exit');
    setTimeout(() => { btn.click(); }, audioOn ? 2100 : 50);
  }, true);

  setTimeout(() => {
    if (!window.RhineAudio) return;
    RhineAudio.preloadVoices();   // 只预热声库：真正的开机播报由启动动画在收尾处（7.2s）触发
  }, 600);

  setTimeout(renderOrbitFromNative, 80);
  setTimeout(renderOrbitFromNative, 300);
})();
