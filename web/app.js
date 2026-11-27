
const STORAGE_KEY = "game_checklist_auto_reset_v3";
const OLD_STORAGE_KEYS = [
  "game_checklist_auto_reset_v2",
  "game_checklist_auto_reset_v1",
  "game_checklist_auto_reset"
];

const defaultGames = [
  "二重螺旋",
  "鸣潮",
  "绝区零",
  "星之拯救者",
  "忘却前夜",
  "卡厄斯",
  "***",
  "***"
];

const DAY_MS = 86400000;
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const RESET_HOUR = 5;

const DESKTOP = location.hostname === "127.0.0.1" || location.hostname === "app.local";
const TOKEN = location.pathname.split("/")[1] || "";
let state;
let nativeRaw = null;
let saveQueue = Promise.resolve();
let noticeTimer;
let saveRevision = 0;

let browsePending = false;
let assistantAllowed = false;
let assistantLoopStarted = false;
async function api(endpoint, body){
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), endpoint === 'browse' ? 600000 : 10000);
  try {
    const response = await fetch(`api/${endpoint}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {"Content-Type":"application/json", "X-Desktop-Token":TOKEN, "X-Save-Revision":String(saveRevision)},
      signal: controller.signal,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const result = await response.json();
    if(!response.ok) throw new Error(result.error || "操作失败");
    return result;
  } catch(error) {
    if(error.name === 'AbortError') throw new Error('操作超时，请重试；若文件选择窗口已打开，请先关闭它');
    throw error;
  } finally { clearTimeout(timer); }
}
function notify(message){
  const settings = document.getElementById("settingsDialog");
  if(settings.open) document.getElementById("settingsStatus").textContent = message;
  const box = document.getElementById("notice");
  box.textContent = message; box.hidden = false;
  clearTimeout(noticeTimer); noticeTimer = setTimeout(() => { box.hidden = true; }, 6000);
}
function newGame(name = "新游戏"){
  return {id:crypto.randomUUID(), name, launchPath:"", daily:false, weekly:false,
    cardLeft:0, cardLastKey:dailyKey(new Date()), versionEndDate:"", characterPulls:0, bannerPulls:0,
    characterFixed:"", bannerFixed:"", characterFixedLocked:false, bannerFixedLocked:false,
    characterGuaranteed:false, bannerGuaranteed:false};
}
function normalizeState(parsed){
  if(!parsed || !Array.isArray(parsed.games) || parsed.games.some(g => !g || typeof g !== "object")) throw new Error("无效的存档格式");
  const now = new Date(), ids = new Set();
  const num = value => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
  const history = source => Object.fromEntries(Object.entries(source || {}).filter(([key,value]) => Array.isArray(value)).map(([key,value]) => [key,value.map(v => v == null ? null : !!v)]));
  return {
    lastDailyKey: /^\d{4}-\d{2}-\d{2}$/.test(parsed.lastDailyKey || "") ? parsed.lastDailyKey : dailyKey(now),
    lastWeeklyKey: /^\d{4}-W\d{2}$/.test(parsed.lastWeeklyKey || "") ? parsed.lastWeeklyKey : weeklyKey(now),
    history:history(parsed.history), weeklyHistory:history(parsed.weeklyHistory),
    games:parsed.games.map(g => {
      const item = newGame(String(g.name ?? "新游戏"));
      if(typeof g.id === "string" && g.id && !ids.has(g.id)) item.id = g.id;
      ids.add(item.id); item.launchPath = String(g.launchPath || "");
      for(const key of ["daily","weekly","characterFixedLocked","bannerFixedLocked","characterGuaranteed","bannerGuaranteed"]) item[key] = !!g[key];
      for(const key of ["cardLeft","characterPulls","bannerPulls"]) item[key] = num(g[key]);
      for(const key of ["characterFixed","bannerFixed"]) item[key] = g[key] == null || g[key] === "" ? "" : num(g[key]);
      item.cardLastKey = /^\d{4}-\d{2}-\d{2}$/.test(g.cardLastKey || "") ? g.cardLastKey : dailyKey(now);
      item.versionEndDate = validVersionDate(g.versionEndDate) ? g.versionEndDate : "";
      return item;
    })
  };
}
async function boot(){
  try{
    if(DESKTOP){ const result = await api("state"); saveRevision=Number(result.revision)||0; nativeRaw = result.state ? JSON.stringify(result.state) : null; }
    state = loadState(); autoResetIfNeeded(); syncCurrentDailyDraftFromCheckedState(); render();
    setupSettings(); save().catch(() => {});
    setInterval(() => { if(autoResetIfNeeded()) render(); }, 60000);
    scheduleReset();
    document.addEventListener("visibilitychange", () => { if(!document.hidden && autoResetIfNeeded()) render(); });
    window.addEventListener("focus", () => { if(autoResetIfNeeded()) render(); });
    if(DESKTOP){
      setInterval(() => { api("heartbeat",{}).catch(() => {}); }, 15000);
      await setupAssistant().catch(error => { document.getElementById("assistantStatus").textContent = "AI连接未就绪：" + error.message; });
    }else{
      document.getElementById("assistantEnabled").disabled = true;
      document.getElementById("assistantStatus").textContent = "请通过桌面版连接AI助手";
    }
  }catch(error){ document.getElementById("saveStatus").textContent = "读取失败"; notify(error.message + "；请关闭后重试，原存档未覆盖。"); }
}
function scheduleReset(){
  setTimeout(() => { if(autoResetIfNeeded()) render(); scheduleReset(); }, Math.max(1,nextDailyReset(new Date()).getTime()-Date.now()));
}

function freshState(){
  const now = new Date();
  return {
    lastDailyKey: dailyKey(now),
    lastWeeklyKey: weeklyKey(now),
    history: {},
    weeklyHistory: {},
    games: defaultGames.map(name => newGame(name))
  };
}

function findSavedStateRaw(){
  if(DESKTOP) return nativeRaw;
  const direct = localStorage.getItem(STORAGE_KEY);
  if(direct) return direct;

  for(const key of OLD_STORAGE_KEYS){
    const raw = localStorage.getItem(key);
    if(raw) return raw;
  }

  // 兜底迁移：如果以前改过 STORAGE_KEY，尽量从同源 localStorage 里找回旧版数据。
  for(let i = 0; i < localStorage.length; i++){
    const key = localStorage.key(i);
    if(!key || !key.startsWith("game_checklist")) continue;
    const raw = localStorage.getItem(key);
    try{
      const parsed = JSON.parse(raw);
      if(parsed && Array.isArray(parsed.games)) return raw;
    }catch(e){}
  }

  return null;
}

function loadState(){
  const raw = findSavedStateRaw();
  return raw ? normalizeState(JSON.parse(raw)) : freshState();
}
function save(){
  const snapshot = JSON.stringify(state);
  const revision = ++saveRevision;
  const status = document.getElementById("saveStatus");
  status.textContent = "保存中…";
  updateSummary();
  saveQueue = saveQueue.catch(() => {}).then(async () => {
    if(revision !== saveRevision) return; // Coalesce queued edits to the latest complete snapshot.
    if(DESKTOP) await api("save", JSON.parse(snapshot));
    else localStorage.setItem(STORAGE_KEY, snapshot);
    if(revision === saveRevision) status.textContent = "已保存";
  });
  saveQueue.catch(error => { status.textContent = "保存失败"; notify("保存失败：" + error.message); });
  return saveQueue;
}

function remainingPulls(target, current){
  if(target === "" || target == null) return "";
  return Math.max(0, Number(target || 0) - Number(current || 0));
}

function validVersionDate(value){
  if(typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000")) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0,10) === value;
}
function versionCountdown(value, now = new Date()){
  if(!validVersionDate(value)) return "未设置日期";
  const days = Math.round((new Date(`${value}T00:00:00Z`) - keyToDate(dailyKey(now))) / DAY_MS);
  return days < 0 ? "已结束" : `剩余 ${days} 天`;
}
function updateVersionCountdown(row, game){
  const el = row.querySelector(".version-countdown");
  if(!el) return;
  if(!game.versionEndDate){ el.textContent = "未设置"; el.className = "version-countdown empty"; return; }
  const text = versionCountdown(game.versionEndDate);
  el.textContent = text;
  el.className = "version-countdown" + (text === "已结束" ? " expired" : "");
}
function refreshVersionCountdowns(){
  all("#games .game").forEach(row => {
    const game = gameById(row.dataset.id);
    if(game) updateVersionCountdown(row, game);
  });
}

let filterMode = "all";

function gameById(id){ return state.games.find(g => g.id === id) || null; }

function wishLine(pool, label, g){
  const locked = !!g[pool + "FixedLocked"];
  const shown = locked ? remainingPulls(g[pool + "Fixed"], g[pool + "Pulls"]) : g[pool + "Fixed"];
  return `
    <div class="pull" data-pool="${pool}">
      <span class="pull-tag">${label}</span>
      <input class="pull-input ${pool}-pulls" type="number" min="0" max="99999" value="${g[pool + "Pulls"]}" placeholder="抽数" title="当前${label}抽数" aria-label="${label}抽数">
      <input class="fixed-input ${pool}-fixed ${locked ? "locked" : ""}" type="number" min="0" max="99999" placeholder="目标" value="${shown}" aria-label="${label}目标剩余抽数" title="输入目标总抽数后按回车锁定；锁定时显示还差多少抽">
      <button type="button" class="pull-btn ${pool}-plus-one" aria-label="${label}抽数加1">+1</button>
      <button type="button" class="pull-btn ${pool}-plus" aria-label="${label}抽数加10">+10</button>
      <label class="pity" title="勾选/取消会把该池抽数归零"><input type="checkbox" class="${pool}-guaranteed" ${g[pool + "Guaranteed"] ? "checked" : ""}><span>保底</span></label>
    </div>`;
}

function render(){
  const box = document.getElementById("games");
  box.innerHTML = state.games.map((g, i) => `
    <article class="game" data-id="${escapeHtml(g.id)}" style="animation-delay:${Math.min(i, 8) * 45}ms">
      <div class="row">
        <div class="identity">
          <div class="monogram">${pad(i + 1)}</div>
          <div class="id-text">
            <div class="name" contenteditable="plaintext-only" spellcheck="false" title="点击可直接改名">${escapeHtml(g.name)}</div>
            <div class="id-actions">
              <button type="button" class="launch" ${g.launchPath ? "" : "disabled"} title="${g.launchPath ? "启动游戏" : "请在设置中添加启动位置"}">启动 ↗</button>
            </div>
          </div>
        </div>
        <div class="checks">
          <label class="check"><input type="checkbox" class="daily-check" ${g.daily ? "checked" : ""}><span>日常</span></label>
          <label class="check"><input type="checkbox" class="weekly-check" ${g.weekly ? "checked" : ""}><span>周常</span></label>
        </div>
        <div class="info">
          <div class="info-line">
            <span class="info-label">月卡</span>
            <input class="card-input" type="number" min="0" max="999" value="${g.cardLeft}" aria-label="月卡剩余天数">
            <span class="unit">天</span>
            <button type="button" class="topup" aria-label="充月卡啦，加29天" title="充月卡啦（+29 天）">+29</button>
          </div>
          <div class="info-line">
            <span class="info-label">卡池</span>
            <span class="version-countdown" role="status"></span>
            <button type="button" class="version-edit" title="设置卡池截止日期">改</button>
          </div>
        </div>
        <div class="wishes">
          ${wishLine("character", "角色", g)}
          ${wishLine("banner", "武器", g)}
        </div>
      </div>
      <div class="drawer">
        <div class="fields">
          <label>卡池截止日期<input class="version-date" type="date" min="0001-01-01" max="9999-12-31" value="${g.versionEndDate}" aria-label="卡池截止日期"></label>
          <button type="button" class="gold version-save">保存日期</button>
          <button type="button" class="secondary version-clear">清除日期</button>
        </div>
      </div>
    </article>
  `).join("");

  bindRows();
  updateSummary();
  renderCalendar();
  renderWeeklyStatus();
  applyFilter();
}

function applyName(id, value){
  const g = gameById(id); if(!g) return false;
  const name = String(value == null ? "" : value).replace(/\s+/g, " ").trim();
  if(!name) return false;
  if(name === g.name) return true;
  g.name = name;
  save();
  renderCalendar();
  renderWeeklyStatus();
  updateSummary();
  return true;
}
// 日常状态发生真实变化时通知外部：日志流按「状态」记录，不按 DOM 事件，杜绝幽灵记录。
function notifyDailyChange(id, value, src){
  window.dispatchEvent(new CustomEvent("rhine:daily-change", {detail:{id:id, value:!!value, src:src || "user"}}));
}
function applyDaily(id, value){
  const g = gameById(id); if(!g) return false;
  g.daily = !!value;
  notifyDailyChange(id, g.daily, "user");
  saveCurrentDailyDraft();
  save();
  renderCalendar();
  updateSummary();
  applyFilter();
  return true;
}
function applyWeekly(id, value){
  const g = gameById(id); if(!g) return false;
  g.weekly = !!value;
  saveCurrentWeeklyDraft();
  save();
  renderWeeklyStatus();
  updateSummary();
  return true;
}
function applyCardLeft(id, value){
  const g = gameById(id); if(!g) return false;
  g.cardLeft = Math.max(0, Math.min(999, Number(value) || 0));
  g.cardLastKey = dailyKey(new Date());
  save();
  updateSummary();
  return true;
}
function applyTopup(id){
  const g = gameById(id); if(!g) return false;
  g.cardLeft = Math.min(999, Number(g.cardLeft || 0) + 29);
  g.cardLastKey = dailyKey(new Date());
  save();
  updateSummary();
  return true;
}
function applyVersionDate(id, value){
  const g = gameById(id); if(!g) return false;
  const next = value ? String(value) : "";
  if(next && !validVersionDate(next)) return false;
  g.versionEndDate = next;
  save();
  return true;
}
function applyPulls(id, pool, delta){
  const g = gameById(id); if(!g) return false;
  const field = pool === "banner" ? "bannerPulls" : "characterPulls";
  g[field] = Math.max(0, Math.min(99999, Number(g[field] || 0) + Number(delta || 0)));
  save();
  return true;
}
function applyPullsValue(id, pool, value){
  const g = gameById(id); if(!g) return false;
  const field = pool === "banner" ? "bannerPulls" : "characterPulls";
  g[field] = Math.max(0, Math.min(99999, Number(value) || 0));
  save();
  return true;
}
function applyTarget(id, pool, value){
  const g = gameById(id); if(!g) return false;
  const blank = value === "" || value === null || value === undefined;
  g[pool + "Fixed"] = blank ? "" : Math.max(0, Number(value) || 0);
  g[pool + "FixedLocked"] = !blank;
  save();
  return true;
}
function applyGuarantee(id, pool, value){
  const g = gameById(id); if(!g) return false;
  g[pool + "Guaranteed"] = !!value;
  g[pool + "Pulls"] = 0;
  save();
  return true;
}

function bindRows(){
  all("#games .game").forEach(row => {
    const id = row.dataset.id;
    const get = () => gameById(id);
    const nameEl = row.querySelector(".name");
    const dailyCheck = row.querySelector(".daily-check");
    const weeklyCheck = row.querySelector(".weekly-check");
    const cardInput = row.querySelector(".card-input");
    const versionEdit = row.querySelector(".version-edit");
    const drawer = row.querySelector(".drawer");
    const versionDate = row.querySelector(".version-date");

    row.querySelector(".launch").addEventListener("click", () => { if(get()) launchGame(id); });

    nameEl.addEventListener("focus", () => nameEl.classList.add("editing"));
    nameEl.addEventListener("keydown", e => { if(e.key === "Enter"){ e.preventDefault(); nameEl.blur(); } });
    nameEl.addEventListener("blur", () => {
      nameEl.classList.remove("editing");
      const g = get(); if(!g) return;
      const value = nameEl.textContent;
      if(!applyName(id, value)){ nameEl.textContent = g.name; return; }
      nameEl.textContent = g.name;
    });

    dailyCheck.addEventListener("change", e => { applyDaily(id, e.target.checked); });
    weeklyCheck.addEventListener("change", e => { applyWeekly(id, e.target.checked); });

    cardInput.addEventListener("input", e => { applyCardLeft(id, e.target.value); });
    row.querySelector(".topup").addEventListener("click", () => {
      const g = get(); if(!g) return;
      applyTopup(id);
      cardInput.value = g.cardLeft;
    });

    versionEdit.addEventListener("click", () => {
      const open = drawer.classList.toggle("open");
      versionEdit.classList.toggle("active", open);
      if(open) versionDate.focus();
    });
    const commitDate = () => {
      const g = get(); if(!g) return;
      if(!applyVersionDate(id, versionDate.value)){
        notify("请选择有效的卡池截止日期");
        versionDate.value = g.versionEndDate;
        return;
      }
      versionDate.value = g.versionEndDate;
      updateVersionCountdown(row, g);
      drawer.classList.remove("open");
      versionEdit.classList.remove("active");
    };
    row.querySelector(".version-save").addEventListener("click", commitDate);
    versionDate.addEventListener("change", commitDate);
    row.querySelector(".version-clear").addEventListener("click", () => {
      const g = get(); if(!g) return;
      applyVersionDate(id, "");
      versionDate.value = "";
      updateVersionCountdown(row, g);
    });

    for(const pool of ["character", "banner"]){
      const pullsInput = row.querySelector(`.${pool}-pulls`);
      const fixedInput = row.querySelector(`.${pool}-fixed`);
      const guarCheck = row.querySelector(`.${pool}-guaranteed`);
      const syncRemain = () => {
        const g = get(); if(!g) return;
        if(g[pool + "FixedLocked"]) fixedInput.value = remainingPulls(g[pool + "Fixed"], g[pool + "Pulls"]);
      };

      pullsInput.addEventListener("input", e => {
        applyPullsValue(id, pool, e.target.value);
        syncRemain();
      });

      fixedInput.addEventListener("focus", () => {
        const g = get(); if(!g) return;
        fixedInput.value = g[pool + "Fixed"];
        g[pool + "FixedLocked"] = false;
        fixedInput.classList.remove("locked");
      });
      fixedInput.addEventListener("blur", () => {
        const g = get(); if(!g) return;
        applyTarget(id, pool, fixedInput.value);
        fixedInput.value = remainingPulls(g[pool + "Fixed"], g[pool + "Pulls"]);
        fixedInput.classList.toggle("locked", g[pool + "FixedLocked"]);
      });
      fixedInput.addEventListener("input", e => {
        const g = get(); if(!g || g[pool + "FixedLocked"]) return;
        g[pool + "Fixed"] = e.target.value === "" ? "" : Math.max(0, Number(e.target.value) || 0);
        save();
      });
      fixedInput.addEventListener("keydown", e => {
        const g = get(); if(!g || e.key !== "Enter" || g[pool + "FixedLocked"]) return;
        if(e.target.value === "") return;
        e.preventDefault();
        applyTarget(id, pool, e.target.value);
        fixedInput.value = remainingPulls(g[pool + "Fixed"], g[pool + "Pulls"]);
        fixedInput.classList.add("locked");
        fixedInput.blur();
      });

      guarCheck.addEventListener("change", e => {
        const g = get(); if(!g) return;
        applyGuarantee(id, pool, e.target.checked);
        notify(`「${g.name}」${pool === "character" ? "角色" : "武器"}抽数已归零`);
        render();
      });

      row.querySelector(`.${pool}-plus-one`).addEventListener("click", () => {
        applyPulls(id, pool, 1);
        const g = get(); if(!g) return;
        pullsInput.value = g[pool + "Pulls"];
        syncRemain();
      });
      row.querySelector(`.${pool}-plus`).addEventListener("click", () => {
        applyPulls(id, pool, 10);
        const g = get(); if(!g) return;
        pullsInput.value = g[pool + "Pulls"];
        syncRemain();
      });
    }

    const g0 = get();
    if(g0) updateVersionCountdown(row, g0);
  });
}

function applyFilter(){
  const total = state.games.length;
  let visible = 0;
  all("#games .game").forEach(row => {
    const g = gameById(row.dataset.id);
    const hide = filterMode === "todo" && !!g && g.daily;
    row.hidden = hide;
    if(!hide) visible++;
  });
  const box = document.getElementById("empty");
  if(box) box.hidden = !(filterMode === "todo" && total > 0 && visible === 0);
}

function updateSummary(){
  const total = state.games.length;
  const done = state.games.filter(g => g.daily).length;
  const week = state.games.filter(g => g.weekly).length;
  const dEl = document.getElementById("daily");
  const dtEl = document.getElementById("daily-total");
  const wEl = document.getElementById("weekly");
  const wtEl = document.getElementById("weekly-total");
  const mEl = document.getElementById("monthly");
  const barEl = document.getElementById("bar");
  if(dEl) dEl.textContent = done;
  if(dtEl) dtEl.textContent = total;
  if(wEl) wEl.textContent = week;
  if(wtEl) wtEl.textContent = total;
  if(mEl) mEl.textContent = state.games.filter(g => Number(g.cardLeft) > 0).length;
  if(barEl) barEl.style.width = total ? (done / total * 100) + "%" : "0%";
  const note = document.getElementById("summary");
  if(note){
    if(!total) note.textContent = "还没有游戏。打开「设置」添加，或在设置里恢复默认。";
    else if(done === total) note.textContent = "今日已完成，剩下的时间留给自己。";
    else note.textContent = `还有 ${total - done} 款游戏的日常待完成。`;
  }
}

function autoResetIfNeeded(){
  const now = new Date();
  const currentDaily = dailyKey(now);
  const currentWeekly = weeklyKey(now);

  let changed = false;

  // 月卡：按跨过的日常刷新日自动扣天数
  state.games.forEach(g => {
    const diff = diffDailyKeys(g.cardLastKey || currentDaily, currentDaily);
    if(diff > 0){
      if(g.cardLeft > 0){
        g.cardLeft = Math.max(0, g.cardLeft - diff);
      }
      g.cardLastKey = currentDaily;
      changed = true;
    }
  });

  // 日常：跨过 05:00 后，记录上一个日常周期，然后清空
  if(state.lastDailyKey !== currentDaily){
    // 如果用户已经点过“记录今天并清空日常”，这里不能用清空后的状态覆盖已有记录。
    if(!Array.isArray(state.history[state.lastDailyKey])){
      recordDailySnapshot(state.lastDailyKey, state.games.map(g => !!g.daily));
    }

    const missingDays = diffDailyKeys(state.lastDailyKey, currentDaily) - 1;
    if(missingDays > 0){
      let d = keyToDate(state.lastDailyKey);
      for(let i = 0; i < missingDays; i++){
        d.setUTCDate(d.getUTCDate() + 1);
        const missingKey = dateToKey(d);
        if(!Array.isArray(state.history[missingKey])){
          recordDailySnapshot(missingKey, state.games.map(() => false));
        }
      }
    }

    state.games.forEach(g => { g.daily = false; });
    state.lastDailyKey = currentDaily;
    changed = true;
  }

  if(state.lastWeeklyKey !== currentWeekly){
    // 周常：跨过周一 05:00 后，记录上一个周常周期，然后清空。
    // 勾选时也会实时写入草稿，这里再补一次，避免刷新/打开时机导致“无记录”。
    recordWeeklySnapshot(state.lastWeeklyKey, state.games.map(g => !!g.weekly));
    state.games.forEach(g => { g.weekly = false; });
    state.lastWeeklyKey = currentWeekly;
    changed = true;
  }

  trimHistory();
  refreshVersionCountdowns();
  if(changed) save();
  return changed;
}

function recordDailySnapshot(key, doneArray){
  state.history[key] = doneArray.slice();
}

function saveCurrentDailyDraft(){
  // 勾选/取消日常时就把当天状态存一份草稿。
  // 这样刷新页面后，小日历不会因为还没到 05:00 自动刷新而显示“无记录”。
  recordDailySnapshot(dailyKey(new Date()), state.games.map(g => !!g.daily));
}

function syncCurrentDailyDraftFromCheckedState(){
  // 兼容旧数据：如果刷新页面时已经有日常勾选，但当天还没有小日历记录，补写一次。
  // 全部未勾选时不主动写入，避免只是打开页面就生成一排“未完成”。
  const key = dailyKey(new Date());
  if(state.lastDailyKey === key && !Array.isArray(state.history[key]) && state.games.some(g => !!g.daily)){
    recordDailySnapshot(key, state.games.map(g => !!g.daily));
    save();
  }
}

function recordWeeklySnapshot(key, doneArray){
  if(!state.weeklyHistory) state.weeklyHistory = {};
  state.weeklyHistory[key] = doneArray.slice();
}

function saveCurrentWeeklyDraft(){
  // 勾选周常时就把本周状态存一份草稿。
  // 到下周一 05:00 后，“上周周常状态”可以直接读取这份记录，避免只显示“无记录”。
  recordWeeklySnapshot(weeklyKey(new Date()), state.games.map(g => !!g.weekly));
}

function recordTodayNow(){
  if(!confirm("确定要把当前日常勾选状态记录到今天，并清空日常吗？")) return;
  const key = dailyKey(new Date());
  recordDailySnapshot(key, state.games.map(g => !!g.daily));
  state.games.forEach(g => { g.daily = false; });
  state.lastDailyKey = key;
  trimHistory();
  save();
  render();
}

function renderCalendar(){
  const el = document.getElementById("history");
  if(!el) return;
  const dates = recentDailyKeys(7);
  const active = state.games.map((g, i) => ({ g, i }))
    .filter(x => x.g.name && x.g.name.trim() && x.g.name.trim() !== "***");

  if(!active.length){
    el.style.gridTemplateColumns = "1fr";
    el.innerHTML = '<div class="sub">暂无游戏</div>';
    return;
  }

  el.style.gridTemplateColumns = `36px repeat(${active.length}, minmax(0, 1fr))`;
  let html = '<span></span>' + active.map(x =>
    `<span class="m-head" title="${escapeHtml(x.g.name)}">${escapeHtml(String(x.g.name).slice(0, 1))}</span>`
  ).join("");

  html += dates.map(key => {
    const rec = state.history[key];
    const cells = active.map(x => {
      const v = rec ? rec[x.i] : null;
      const who = escapeHtml(x.g.name);
      if(v == null) return `<span class="cell" title="${formatKeyShort(key)} ${who}：未完成">×</span>`;
      return v
        ? `<span class="cell yes" title="${formatKeyShort(key)} ${who}：已完成">✓</span>`
        : `<span class="cell" title="${formatKeyShort(key)} ${who}：未完成">×</span>`;
    }).join("");
    return `<span class="m-date">${formatKeyShort(key)}</span>` + cells;
  }).join("");

  el.innerHTML = html;
}

function renderWeeklyStatus(){
  const box = document.getElementById("weeklyStatus");
  if(!box) return;
  const lastWeek = previousWeeklyKey(new Date());
  const rec = (state.weeklyHistory || {})[lastWeek];
  const active = state.games.map((g, i) => ({ g, i }))
    .filter(x => x.g.name && x.g.name.trim() && x.g.name.trim() !== "***");

  if(!active.length){
    box.innerHTML = '<div class="sub">暂无游戏</div>';
    return;
  }

  box.innerHTML = active.map(x => {
    const has = Array.isArray(rec) && rec[x.i] != null;
    const done = has ? !!rec[x.i] : false;      // 无记录一律按未完成处理
    const cls = done ? "done" : "miss";
    const text = done ? "✓ 已完成" : "— 未完成";
    return `<div class="week"><span class="w-name" title="${escapeHtml(x.g.name)}">${escapeHtml(x.g.name)}</span><span class="${cls}">${text}</span></div>`;
  }).join("");
}


function manualClearDaily(){
  if(!confirm("确定要把当前日常状态记录到今天，并清空所有日常勾选吗？")) return;
  const key = dailyKey(new Date());
  recordDailySnapshot(key, state.games.map(g => !!g.daily));
  state.games.forEach(g => { g.daily = false; });
  state.lastDailyKey = key;
  trimHistory();
  save();
  render();
}

function recordLastWeekNow(){
  if(!confirm("确定要把当前周常勾选状态补录为上周记录吗？适合在今天已经显示‘无记录’时手动补救。")) return;
  const key = previousWeeklyKey(new Date());
  recordWeeklySnapshot(key, state.games.map(g => !!g.weekly));
  save();
  render();
}

function manualClearWeekly(){
  if(!confirm("确定要清空所有周常勾选吗？")) return;
  state.games.forEach(g => { g.weekly = false; });
  state.lastWeeklyKey = weeklyKey(new Date());
  save();
  render();
}

function clearHistory(){
  if(!confirm("确定要清空最近一周日常记录吗？")) return;
  state.history = {};
  save();
  render();
}

function resetEverything(){
  if(!confirm("确定要全部重置吗？游戏名、勾选状态、月卡剩余、抽卡记录、大保底状态、小日历都会恢复初始状态。")) return;
  state = freshState();
  save();
  render();
}

// 所有周期固定采用日本时间（UTC+9），不受设备时区影响。
// 日期键使用 UTC 日期对象承载，避免本地时区和夏令时干扰。
function dailyKey(date){
  return dateToKey(new Date(date.getTime() + JST_OFFSET_MS - RESET_HOUR * 3600000));
}

function dateToKey(d){
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())}`;
}

function keyToDate(key){
  const [y,m,d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m-1, d));
}

function diffDailyKeys(fromKey, toKey){
  return Math.round((keyToDate(toKey) - keyToDate(fromKey)) / DAY_MS);
}

function weeklyKey(date){
  const d = keyToDate(dailyKey(date));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const year = d.getUTCFullYear();
  const weekNo = Math.ceil(((d - Date.UTC(year, 0, 1)) / DAY_MS + 1) / 7);
  return `${year}-W${pad(weekNo)}`;
}

function previousWeeklyKey(date){
  return weeklyKey(new Date(date.getTime() - 7 * DAY_MS));
}

function nextDailyReset(now){
  return new Date(keyToDate(dailyKey(now)).getTime() + DAY_MS
    + RESET_HOUR * 3600000 - JST_OFFSET_MS);
}

function nextWeeklyReset(now){
  const day = keyToDate(dailyKey(now));
  const daysUntilMonday = 8 - (day.getUTCDay() || 7);
  return new Date(day.getTime() + daysUntilMonday * DAY_MS
    + RESET_HOUR * 3600000 - JST_OFFSET_MS);
}

function recentDailyKeys(n){
  const today = keyToDate(dailyKey(new Date()));
  const arr = [];
  for(let i = 0; i < n; i++){
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    arr.push(dateToKey(d));
  }
  return arr;
}

function trimHistory(){
  const keep = new Set(recentDailyKeys(35));
  Object.keys(state.history).forEach(k => {
    if(!keep.has(k)) delete state.history[k];
  });
}

function shortName(name){
  const s = String(name);
  return s.length > 5 ? s.slice(0,5) + "…" : s;
}

function formatKeyShort(key){
  const [,m,d] = key.split("-");
  return `${m}/${d}`;
}

function all(selector){
  return typeof document.querySelectorAll === "function"
    ? Array.from(document.querySelectorAll(selector))
    : [];
}

function escapeHtml(str){
  return String(str)
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;");
}

function pad(n){
  return String(n).padStart(2, "0");
}

function formatDateTime(d){
  const jst = new Date(d.getTime() + JST_OFFSET_MS);
  return `${pad(jst.getUTCMonth()+1)}/${pad(jst.getUTCDate())} ${pad(jst.getUTCHours())}:${pad(jst.getUTCMinutes())}（日本时间）`;
}

async function launchGame(id){
  if(!DESKTOP){ notify('启动功能请通过「启动小助手.cmd」打开桌面版使用。'); return; }
  try{ await save(); await api('launch',{id}); notify('已发送启动请求'); }
  catch(error){ notify('启动失败：'+error.message); }
}

async function setupAssistant(){
  const checkbox = document.getElementById("assistantEnabled");
  const status = document.getElementById("assistantStatus");
  const settings = await api("assistant/settings");
  assistantAllowed = settings.enabled === true;
  checkbox.checked = assistantAllowed;
  const showStatus = () => { status.textContent = assistantAllowed ? "AI操作已开启，等待 Bionic 指令" : "AI操作已关闭"; };
  showStatus();
  checkbox.addEventListener("change", async () => {
    checkbox.disabled = true;
    try{
      const result = await api("assistant/settings", {enabled:checkbox.checked});
      assistantAllowed = result.enabled === true;
      checkbox.checked = assistantAllowed;
      showStatus();
    }catch(error){ checkbox.checked = assistantAllowed; status.textContent = "开关未保存：" + error.message; }
    finally{ checkbox.disabled = false; }
  });
  setTimeout(pollAssistant, 0);
}
async function pollAssistant(){
  if(assistantLoopStarted || !DESKTOP) return;
  assistantLoopStarted = true;
  // Long polling keeps commands on the same state/save path as manual edits.
  while(true){
    try{
      const response = await api("assistant/poll", {});
      if(!response.command) continue;
      const command = response.command;
      const result = await executeAssistantCommand(command.request);
      // Retry only the receipt. Never re-execute an action after a lost response.
      let received = false;
      while(!received){
        try{ await api("assistant/complete", {requestId:command.requestId,lease:command.lease,result}); received = true; }
        catch(error){ await new Promise(resolve => setTimeout(resolve, 2000)); }
      }
    }catch(error){ await new Promise(resolve => setTimeout(resolve, 2000)); }
  }
}
async function flushAssistantSave(){
  await save();
  // A manual edit during the request may append a newer snapshot to the queue.
  let pending;
  do{ pending = saveQueue; await pending; }while(pending !== saveQueue);
}
async function executeAssistantCommand(request){
  try{
    if(!assistantAllowed) return {ok:false,code:"disabled",message:"AI操作已关闭，指令未执行"};
    if(!request || !["list","set_completion","launch","topup_monthcard","set_pool_date","add_pulls"].includes(request.action)) return {ok:false,code:"unsupported",message:"不支持此操作"};
    if(autoResetIfNeeded()) render();
    if(request.action === "list"){
      return {ok:true,day:dailyKey(new Date()),calendarDate:dateToKey(new Date(Date.now()+JST_OFFSET_MS)),week:weeklyKey(new Date()),timezone:"Asia/Tokyo",resetHour:5,
        games:state.games.map(assistantGameSnapshot)};
    }
    const game = state.games.find(g => g.id === request.gameId);
    if(!game) return {ok:false,code:"game_not_found",message:"游戏不存在，请重新查看游戏列表"};
    if(["topup_monthcard","set_pool_date","add_pulls"].includes(request.action)){
      let field, expected, message, before, added;
      const appliedDay = dailyKey(new Date());
      if(request.action === "topup_monthcard"){
        field = "cardLeft";
        before = Number(game.cardLeft || 0);
        if(!Number.isFinite(before) || before < 0 || before > 999) return {ok:false,code:"invalid_state",message:"当前月卡天数超出0到999范围，请先在界面检查"};
        expected = Math.min(999, before + 29);
        added = expected - before;
        game.cardLastKey = appliedDay;
        message = `「${game.name}」月卡增加 ${added} 天，执行后剩余 ${expected} 天` + (added < 29 ? "（已达到999天上限）" : "");
      }else if(request.action === "set_pool_date"){
        if(!validVersionDate(request.date)) return {ok:false,code:"invalid_arguments",message:"请提供有效的YYYY-MM-DD卡池日期"};
        field = "versionEndDate";
        expected = request.date;
        message = `已将「${game.name}」卡池截止日期设为 ${expected}，${versionCountdown(expected)}`;
      }else{
        if(!["character","weapon"].includes(request.pool) || !Number.isInteger(request.count) || request.count < 1 || request.count > 99999) return {ok:false,code:"invalid_arguments",message:"请明确角色/武器池，并提供1到99999的整数抽数"};
        field = request.pool === "character" ? "characterPulls" : "bannerPulls";
        before = Number(game[field] || 0);
        if(!Number.isFinite(before) || before < 0 || before > 99999) return {ok:false,code:"invalid_state",message:"当前抽数超出0到99999范围，请先在界面检查"};
        expected = Math.min(99999, before + request.count);
        added = expected - before;
        message = `「${game.name}」${request.pool === "character" ? "角色" : "武器"}抽数增加 ${added} 抽，执行后为 ${expected} 抽` + (added < request.count ? "（已达到99999抽上限）" : "");
      }
      game[field] = expected;
      render();
      try{ await flushAssistantSave(); }
      catch(error){
        return {ok:false,code:"save_failed",applied:true,saved:false,message:"操作已更新到当前界面，但保存未确认：" + error.message + "。请先恢复保存，不要重复充值或累加抽数",game:assistantGameSnapshot(game)};
      }
      if(!state.games.includes(game) || game[field] !== expected || (request.action === "topup_monthcard" && dailyKey(new Date()) !== appliedDay)){
        return {ok:false,code:"state_changed",applied:true,saved:true,message:"本次操作已应用，但保存期间记录或刷新周期发生变化，请重新查看当前状态，不要重复充值或累加抽数"};
      }
      notify("AI：" + message);
      return {ok:true,applied:true,saved:true,message,before,added,game:assistantGameSnapshot(game)};
    }
    if(request.action === "set_completion"){
      if(!["daily","weekly"].includes(request.field) || typeof request.done !== "boolean") return {ok:false,code:"invalid_arguments",message:"完成状态参数无效"};
      const appliedDay = dailyKey(new Date()), appliedWeek = weeklyKey(new Date());
      game[request.field] = request.done;
      if(request.field === "daily"){ notifyDailyChange(game.id, !!request.done, "auto"); saveCurrentDailyDraft(); } else saveCurrentWeeklyDraft();
      render();
      await flushAssistantSave();
      if(!state.games.includes(game) || game[request.field] !== request.done ||
        (request.field === "daily" ? dailyKey(new Date()) !== appliedDay : weeklyKey(new Date()) !== appliedWeek)){
        return {ok:false,code:"state_changed",message:"保存期间记录或刷新周期发生变化，请重新查看当前状态"};
      }
      const message = `已将「${game.name}」的${request.field === "daily" ? "日常" : "周常"}设为${request.done ? "已完成" : "未完成"}`;
      notify("AI：" + message);
      return {ok:true,message,day:appliedDay,week:appliedWeek,game:{id:game.id,name:game.name,daily:game.daily,weekly:game.weekly}};
    }
    if(!game.launchPath) return {ok:false,code:"launch_not_configured",message:"请先在设置中为此游戏配置启动位置"};
    await flushAssistantSave();
    await api("launch", {id:game.id});
    const message = `已向系统发送「${game.name}」启动请求`;
    notify("AI：" + message);
    return {ok:true,message};
  }catch(error){
    return {ok:false,code:"operation_failed",message:error.message + "；未确认操作成功，请检查保存状态和当前界面"};
  }
}
function assistantGameSnapshot(game){
  return {id:game.id,name:game.name,daily:game.daily,weekly:game.weekly,cardLeft:game.cardLeft,
    poolEndDate:game.versionEndDate,poolRemaining:versionCountdown(game.versionEndDate),canLaunch:!!game.launchPath,
    characterPulls:game.characterPulls,weaponPulls:game.bannerPulls,
    characterTargetTotal:game.characterFixed,weaponTargetTotal:game.bannerFixed,
    characterRemaining:remainingPulls(game.characterFixed,game.characterPulls),weaponRemaining:remainingPulls(game.bannerFixed,game.bannerPulls),
    characterGuaranteed:game.characterGuaranteed,weaponGuaranteed:game.bannerGuaranteed};
}
function deleteGame(id){
  const index = state.games.findIndex(g => g.id === id);
  if(index < 0) return;
  state.games.splice(index,1);
  for(const history of [state.history,state.weeklyHistory]){
    for(const key of Object.keys(history)){
      if(Array.isArray(history[key])) history[key].splice(index,1);
    }
  }
  if(state.games.length===0){ state.history={}; state.weeklyHistory={}; }
  return save();
}
function renderSettings(){
  const container=document.getElementById('settingsGames'); container.innerHTML='';
  for(const game of state.games){
    const row=document.createElement('div'); row.className='settings-game';
    row.innerHTML=`<label>游戏名称<input class="setting-name" type="text" value="${escapeHtml(game.name)}"></label><label>启动位置（.exe、.lnk 或 Steam 启动链接）<input class="setting-path" type="text" value="${escapeHtml(game.launchPath)}" placeholder="选择程序，或粘贴完整路径"></label><button class="browse secondary">浏览</button><button class="delete danger">删除</button>`;
    row.querySelector('.setting-name').addEventListener('input', e=>{ game.name=e.target.value; save(); render(); });
    row.querySelector('.setting-path').addEventListener('input',e=>{ game.launchPath=e.target.value.trim().replace(/^"|"$/g,''); save(); render(); });
    row.querySelector('.browse').addEventListener('click',async()=>{
      if(!DESKTOP){notify('浏览程序需要通过桌面版启动；预览中可以手动填写路径。');return;}
      if(browsePending)return;
      browsePending=true;
      const button=row.querySelector('.browse');button.disabled=true;
      notify('正在打开文件选择窗口，请完成或取消选择…');
      try{
        const result=await api('browse',{});
        if(result.path && state.games.some(g=>g.id===game.id)){game.launchPath=result.path;row.querySelector('.setting-path').value=result.path;await save();render();notify('启动位置已保存');}
        else notify('已取消选择');
      }catch(error){notify(error.message);}
      finally{browsePending=false;button.disabled=false;}
    });
    row.querySelector('.delete').addEventListener('click',async()=>{
      if(!confirm(`确定删除「${game.name}」？它的日常、周常历史、月卡、抽卡记录和启动路径将一并删除。`))return;
      try{await deleteGame(game.id);renderSettings();render();notify('游戏及其全部记录已删除');}
      catch(error){notify('删除尚未保存，请重试：'+error.message);}
    });
    container.appendChild(row);
  }
  document.getElementById('settingsStatus').textContent=`共 ${state.games.length} 个游戏`;
}
function setupSettings(){
  const dialog=document.getElementById('settingsDialog');
  document.getElementById('exitButton').addEventListener('click',async()=>{try{await save();if(DESKTOP){await api('exit',{});document.body.innerHTML='<p style="padding:40px">小助手已退出，可以关闭此窗口。</p>';window.close();}else notify('请关闭此预览页面。');}catch(error){notify(error.message);}});
  document.getElementById('settingsButton').addEventListener('click',()=>{renderSettings();dialog.showModal();});
  document.getElementById('closeSettings').addEventListener('click',async()=>{try{notify('正在保存设置…');await save();dialog.close();}catch(error){notify('设置未保存：'+error.message+'。可再次点击完成重试。');}});
  document.getElementById('addGame').addEventListener('click',async()=>{
    try{state.games.push(newGame());await save();renderSettings();render();
    const names=dialog.querySelectorAll('.setting-name');names[names.length-1].focus();}catch(error){notify(error.message);}
  });
  document.getElementById('exportButton').addEventListener('click',()=>{
    autoResetIfNeeded();
    const blob=new Blob([JSON.stringify({format:'daily-helper',version:1,state},null,2)],{type:'application/json'});
    const url=URL.createObjectURL(blob),link=document.createElement('a');
    link.href=url;link.download=`日常小助手备份_${dailyKey(new Date())}.json`;link.click();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
  });
  document.getElementById('importButton').addEventListener('click',()=>document.getElementById('importFile').click());
  document.getElementById('importFile').addEventListener('change',async e=>{
    const file=e.target.files[0];if(!file)return;
    try{
      if(file.size>4*1024*1024)throw new Error('文件过大');
      const data=JSON.parse(await file.text());const replacement=normalizeState(data.state||data);
      if(!confirm('导入会替换当前全部游戏和记录，是否继续？'))return;
      state=replacement;autoResetIfNeeded();await save();render();notify('导入完成');
    }catch(error){notify('导入失败：'+error.message);}finally{e.target.value='';}
  });
}
all("[data-filter]").forEach(btn => {
  btn.addEventListener("click", () => {
    filterMode = btn.dataset.filter;
    all("[data-filter]").forEach(x => x.classList.toggle("active", x === btn));
    applyFilter();
  });
});
const showAllBtn = document.getElementById("showall");
if(showAllBtn) showAllBtn.addEventListener("click", () => {
  filterMode = "all";
  all("[data-filter]").forEach(x => x.classList.toggle("active", x.dataset.filter === "all"));
  applyFilter();
});
const bootReady = boot();

/* ===== 背景波纹与标题扰动（内联，OGL 1.0.11 / MIT；入场播完即停，指针交互再唤醒） ===== */
window.microDemo = window.microDemo || {status:'skip', frames:0};
window.fuzzyDemo = window.fuzzyDemo || {draws:0};
(function(){
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
  window.microDemo.status = 'loading';
(function(){try{if(!document.getElementById('bg-status')){var s=document.createElement('span');s.id='bg-status';s.hidden=true;s.style.display='none';document.body.appendChild(s);}}catch(e){}})();
(function(){try{const OGL=(function(){/* esm.sh - ogl@1.0.11 */
function ot(i){let t=i[0],e=i[1],r=i[2];return Math.sqrt(t*t+e*e+r*r)}function Lt(i,t){return i[0]=t[0],i[1]=t[1],i[2]=t[2],i}function pi(i,t,e,r){return i[0]=t,i[1]=e,i[2]=r,i}function Ht(i,t,e){return i[0]=t[0]+e[0],i[1]=t[1]+e[1],i[2]=t[2]+e[2],i}function Qt(i,t,e){return i[0]=t[0]-e[0],i[1]=t[1]-e[1],i[2]=t[2]-e[2],i}function di(i,t,e){return i[0]=t[0]*e[0],i[1]=t[1]*e[1],i[2]=t[2]*e[2],i}function mi(i,t,e){return i[0]=t[0]/e[0],i[1]=t[1]/e[1],i[2]=t[2]/e[2],i}function Pt(i,t,e){return i[0]=t[0]*e,i[1]=t[1]*e,i[2]=t[2]*e,i}function gi(i,t){let e=t[0]-i[0],r=t[1]-i[1],s=t[2]-i[2];return Math.sqrt(e*e+r*r+s*s)}function xi(i,t){let e=t[0]-i[0],r=t[1]-i[1],s=t[2]-i[2];return e*e+r*r+s*s}function Kt(i){let t=i[0],e=i[1],r=i[2];return t*t+e*e+r*r}function yi(i,t){return i[0]=-t[0],i[1]=-t[1],i[2]=-t[2],i}function wi(i,t){return i[0]=1/t[0],i[1]=1/t[1],i[2]=1/t[2],i}function St(i,t){let e=t[0],r=t[1],s=t[2],n=e*e+r*r+s*s;return n>0&&(n=1/Math.sqrt(n)),i[0]=t[0]*n,i[1]=t[1]*n,i[2]=t[2]*n,i}function Zt(i,t){return i[0]*t[0]+i[1]*t[1]+i[2]*t[2]}function $t(i,t,e){let r=t[0],s=t[1],n=t[2],a=e[0],h=e[1],o=e[2];return i[0]=s*o-n*h,i[1]=n*a-r*o,i[2]=r*h-s*a,i}function Ct(i,t,e,r){let s=t[0],n=t[1],a=t[2];return i[0]=s+r*(e[0]-s),i[1]=n+r*(e[1]-n),i[2]=a+r*(e[2]-a),i}function Mi(i,t,e,r,s){let n=Math.exp(-r*s),a=t[0],h=t[1],o=t[2];return i[0]=e[0]+(a-e[0])*n,i[1]=e[1]+(h-e[1])*n,i[2]=e[2]+(o-e[2])*n,i}function Ei(i,t,e){let r=t[0],s=t[1],n=t[2],a=e[3]*r+e[7]*s+e[11]*n+e[15];return a=a||1,i[0]=(e[0]*r+e[4]*s+e[8]*n+e[12])/a,i[1]=(e[1]*r+e[5]*s+e[9]*n+e[13])/a,i[2]=(e[2]*r+e[6]*s+e[10]*n+e[14])/a,i}function Ai(i,t,e){let r=t[0],s=t[1],n=t[2],a=e[3]*r+e[7]*s+e[11]*n+e[15];return a=a||1,i[0]=(e[0]*r+e[4]*s+e[8]*n)/a,i[1]=(e[1]*r+e[5]*s+e[9]*n)/a,i[2]=(e[2]*r+e[6]*s+e[10]*n)/a,i}function _i(i,t,e){let r=t[0],s=t[1],n=t[2];return i[0]=r*e[0]+s*e[3]+n*e[6],i[1]=r*e[1]+s*e[4]+n*e[7],i[2]=r*e[2]+s*e[5]+n*e[8],i}function vi(i,t,e){let r=t[0],s=t[1],n=t[2],a=e[0],h=e[1],o=e[2],l=e[3],c=h*n-o*s,f=o*r-a*n,p=a*s-h*r,u=h*p-o*f,d=o*c-a*p,x=a*f-h*c,m=l*2;return c*=m,f*=m,p*=m,u*=2,d*=2,x*=2,i[0]=r+c+u,i[1]=s+f+d,i[2]=n+p+x,i}var bi=function(){let i=[0,0,0],t=[0,0,0];return function(e,r){Lt(i,e),Lt(t,r),St(i,i),St(t,t);let s=Zt(i,t);return s>1?0:s<-1?Math.PI:Math.acos(s)}}();function Fi(i,t){return i[0]===t[0]&&i[1]===t[1]&&i[2]===t[2]}var E=class i extends Array{constructor(t=0,e=t,r=t){return super(t,e,r),this}get x(){return this[0]}get y(){return this[1]}get z(){return this[2]}set x(t){this[0]=t}set y(t){this[1]=t}set z(t){this[2]=t}set(t,e=t,r=t){return t.length?this.copy(t):(pi(this,t,e,r),this)}copy(t){return Lt(this,t),this}add(t,e){return e?Ht(this,t,e):Ht(this,this,t),this}sub(t,e){return e?Qt(this,t,e):Qt(this,this,t),this}multiply(t){return t.length?di(this,this,t):Pt(this,this,t),this}divide(t){return t.length?mi(this,this,t):Pt(this,this,1/t),this}inverse(t=this){return wi(this,t),this}len(){return ot(this)}distance(t){return t?gi(this,t):ot(this)}squaredLen(){return Kt(this)}squaredDistance(t){return t?xi(this,t):Kt(this)}negate(t=this){return yi(this,t),this}cross(t,e){return e?$t(this,t,e):$t(this,this,t),this}scale(t){return Pt(this,this,t),this}normalize(){return St(this,this),this}dot(t){return Zt(this,t)}equals(t){return Fi(this,t)}applyMatrix3(t){return _i(this,this,t),this}applyMatrix4(t){return Ei(this,this,t),this}scaleRotateMatrix4(t){return Ai(this,this,t),this}applyQuaternion(t){return vi(this,this,t),this}angle(t){return bi(this,t)}lerp(t,e){return Ct(this,this,t,e),this}smoothLerp(t,e,r){return Mi(this,this,t,e,r),this}clone(){return new i(this[0],this[1],this[2])}fromArray(t,e=0){return this[0]=t[e],this[1]=t[e+1],this[2]=t[e+2],this}toArray(t=[],e=0){return t[e]=this[0],t[e+1]=this[1],t[e+2]=this[2],t}transformDirection(t){let e=this[0],r=this[1],s=this[2];return this[0]=t[0]*e+t[4]*r+t[8]*s,this[1]=t[1]*e+t[5]*r+t[9]*s,this[2]=t[2]*e+t[6]*r+t[10]*s,this.normalize()}};var Ri=new E,ms=1,gs=1,zi=!1,O=class{constructor(t,e={}){t.canvas||console.error("gl not passed as first argument to Geometry"),this.gl=t,this.attributes=e,this.id=ms++,this.VAOs={},this.drawRange={start:0,count:0},this.instancedCount=0,this.gl.renderer.bindVertexArray(null),this.gl.renderer.currentGeometry=null,this.glState=this.gl.renderer.state;for(let r in e)this.addAttribute(r,e[r])}addAttribute(t,e){if(this.attributes[t]=e,e.id=gs++,e.size=e.size||1,e.type=e.type||(e.data.constructor===Float32Array?this.gl.FLOAT:e.data.constructor===Uint16Array?this.gl.UNSIGNED_SHORT:this.gl.UNSIGNED_INT),e.target=t==="index"?this.gl.ELEMENT_ARRAY_BUFFER:this.gl.ARRAY_BUFFER,e.normalized=e.normalized||!1,e.stride=e.stride||0,e.offset=e.offset||0,e.count=e.count||(e.stride?e.data.byteLength/e.stride:e.data.length/e.size),e.divisor=e.instanced||0,e.needsUpdate=!1,e.usage=e.usage||this.gl.STATIC_DRAW,e.buffer||this.updateAttribute(e),e.divisor){if(this.isInstanced=!0,this.instancedCount&&this.instancedCount!==e.count*e.divisor)return console.warn("geometry has multiple instanced buffers of different length"),this.instancedCount=Math.min(this.instancedCount,e.count*e.divisor);this.instancedCount=e.count*e.divisor}else t==="index"?this.drawRange.count=e.count:this.attributes.index||(this.drawRange.count=Math.max(this.drawRange.count,e.count))}updateAttribute(t){let e=!t.buffer;e&&(t.buffer=this.gl.createBuffer()),this.glState.boundBuffer!==t.buffer&&(this.gl.bindBuffer(t.target,t.buffer),this.glState.boundBuffer=t.buffer),e?this.gl.bufferData(t.target,t.data,t.usage):this.gl.bufferSubData(t.target,0,t.data),t.needsUpdate=!1}setIndex(t){this.addAttribute("index",t)}setDrawRange(t,e){this.drawRange.start=t,this.drawRange.count=e}setInstancedCount(t){this.instancedCount=t}createVAO(t){this.VAOs[t.attributeOrder]=this.gl.renderer.createVertexArray(),this.gl.renderer.bindVertexArray(this.VAOs[t.attributeOrder]),this.bindAttributes(t)}bindAttributes(t){t.attributeLocations.forEach((e,{name:r,type:s})=>{if(!this.attributes[r]){console.warn(`active attribute ${r} not being supplied`);return}let n=this.attributes[r];this.gl.bindBuffer(n.target,n.buffer),this.glState.boundBuffer=n.buffer;let a=1;s===35674&&(a=2),s===35675&&(a=3),s===35676&&(a=4);let h=n.size/a,o=a===1?0:a*a*4,l=a===1?0:a*4;for(let c=0;c<a;c++)this.gl.vertexAttribPointer(e+c,h,n.type,n.normalized,n.stride+o,n.offset+c*l),this.gl.enableVertexAttribArray(e+c),this.gl.renderer.vertexAttribDivisor(e+c,n.divisor)}),this.attributes.index&&this.gl.bindBuffer(this.gl.ELEMENT_ARRAY_BUFFER,this.attributes.index.buffer)}draw({program:t,mode:e=this.gl.TRIANGLES}){this.gl.renderer.currentGeometry!==`${this.id}_${t.attributeOrder}`&&(this.VAOs[t.attributeOrder]||this.createVAO(t),this.gl.renderer.bindVertexArray(this.VAOs[t.attributeOrder]),this.gl.renderer.currentGeometry=`${this.id}_${t.attributeOrder}`),t.attributeLocations.forEach((s,{name:n})=>{let a=this.attributes[n];a.needsUpdate&&this.updateAttribute(a)});let r=2;this.attributes.index?.type===this.gl.UNSIGNED_INT&&(r=4),this.isInstanced?this.attributes.index?this.gl.renderer.drawElementsInstanced(e,this.drawRange.count,this.attributes.index.type,this.attributes.index.offset+this.drawRange.start*r,this.instancedCount):this.gl.renderer.drawArraysInstanced(e,this.drawRange.start,this.drawRange.count,this.instancedCount):this.attributes.index?this.gl.drawElements(e,this.drawRange.count,this.attributes.index.type,this.attributes.index.offset+this.drawRange.start*r):this.gl.drawArrays(e,this.drawRange.start,this.drawRange.count)}getPosition(){let t=this.attributes.position;if(t.data)return t;if(!zi)return console.warn("No position buffer data found to compute bounds"),zi=!0}computeBoundingBox(t){t||(t=this.getPosition());let e=t.data,r=t.size;this.bounds||(this.bounds={min:new E,max:new E,center:new E,scale:new E,radius:1/0});let s=this.bounds.min,n=this.bounds.max,a=this.bounds.center,h=this.bounds.scale;s.set(1/0),n.set(-1/0);for(let o=0,l=e.length;o<l;o+=r){let c=e[o],f=e[o+1],p=e[o+2];s.x=Math.min(c,s.x),s.y=Math.min(f,s.y),s.z=Math.min(p,s.z),n.x=Math.max(c,n.x),n.y=Math.max(f,n.y),n.z=Math.max(p,n.z)}h.sub(n,s),a.add(s,n).divide(2)}computeBoundingSphere(t){t||(t=this.getPosition());let e=t.data,r=t.size;this.bounds||this.computeBoundingBox(t);let s=0;for(let n=0,a=e.length;n<a;n+=r)Ri.fromArray(e,n),s=Math.max(s,this.bounds.center.squaredDistance(Ri));this.bounds.radius=Math.sqrt(s)}remove(){for(let t in this.VAOs)this.gl.renderer.deleteVertexArray(this.VAOs[t]),delete this.VAOs[t];for(let t in this.attributes)this.gl.deleteBuffer(this.attributes[t].buffer),delete this.attributes[t]}};var xs=1,Li={},U=class{constructor(t,{vertex:e,fragment:r,uniforms:s={},transparent:n=!1,cullFace:a=t.BACK,frontFace:h=t.CCW,depthTest:o=!0,depthWrite:l=!0,depthFunc:c=t.LEQUAL}={}){t.canvas||console.error("gl not passed as first argument to Program"),this.gl=t,this.uniforms=s,this.id=xs++,e||console.warn("vertex shader not supplied"),r||console.warn("fragment shader not supplied"),this.transparent=n,this.cullFace=a,this.frontFace=h,this.depthTest=o,this.depthWrite=l,this.depthFunc=c,this.blendFunc={},this.blendEquation={},this.stencilFunc={},this.stencilOp={},this.transparent&&!this.blendFunc.src&&(this.gl.renderer.premultipliedAlpha?this.setBlendFunc(this.gl.ONE,this.gl.ONE_MINUS_SRC_ALPHA):this.setBlendFunc(this.gl.SRC_ALPHA,this.gl.ONE_MINUS_SRC_ALPHA)),this.vertexShader=t.createShader(t.VERTEX_SHADER),this.fragmentShader=t.createShader(t.FRAGMENT_SHADER),this.program=t.createProgram(),t.attachShader(this.program,this.vertexShader),t.attachShader(this.program,this.fragmentShader),this.setShaders({vertex:e,fragment:r})}setShaders({vertex:t,fragment:e}){if(t&&(this.gl.shaderSource(this.vertexShader,t),this.gl.compileShader(this.vertexShader),this.gl.getShaderInfoLog(this.vertexShader)!==""&&console.warn(`${this.gl.getShaderInfoLog(this.vertexShader)}
Vertex Shader
${Si(t)}`)),e&&(this.gl.shaderSource(this.fragmentShader,e),this.gl.compileShader(this.fragmentShader),this.gl.getShaderInfoLog(this.fragmentShader)!==""&&console.warn(`${this.gl.getShaderInfoLog(this.fragmentShader)}
Fragment Shader
${Si(e)}`)),this.gl.linkProgram(this.program),!this.gl.getProgramParameter(this.program,this.gl.LINK_STATUS))return console.warn(this.gl.getProgramInfoLog(this.program));this.uniformLocations=new Map;let r=this.gl.getProgramParameter(this.program,this.gl.ACTIVE_UNIFORMS);for(let a=0;a<r;a++){let h=this.gl.getActiveUniform(this.program,a);this.uniformLocations.set(h,this.gl.getUniformLocation(this.program,h.name));let o=h.name.match(/(\w+)/g);h.uniformName=o[0],h.nameComponents=o.slice(1)}this.attributeLocations=new Map;let s=[],n=this.gl.getProgramParameter(this.program,this.gl.ACTIVE_ATTRIBUTES);for(let a=0;a<n;a++){let h=this.gl.getActiveAttrib(this.program,a),o=this.gl.getAttribLocation(this.program,h.name);o!==-1&&(s[o]=h.name,this.attributeLocations.set(h,o))}this.attributeOrder=s.join("")}setBlendFunc(t,e,r,s){this.blendFunc.src=t,this.blendFunc.dst=e,this.blendFunc.srcAlpha=r,this.blendFunc.dstAlpha=s,t&&(this.transparent=!0)}setBlendEquation(t,e){this.blendEquation.modeRGB=t,this.blendEquation.modeAlpha=e}setStencilFunc(t,e,r){this.stencilRef=e,this.stencilFunc.func=t,this.stencilFunc.ref=e,this.stencilFunc.mask=r}setStencilOp(t,e,r){this.stencilOp.stencilFail=t,this.stencilOp.depthFail=e,this.stencilOp.depthPass=r}applyState(){this.depthTest?this.gl.renderer.enable(this.gl.DEPTH_TEST):this.gl.renderer.disable(this.gl.DEPTH_TEST),this.cullFace?this.gl.renderer.enable(this.gl.CULL_FACE):this.gl.renderer.disable(this.gl.CULL_FACE),this.blendFunc.src?this.gl.renderer.enable(this.gl.BLEND):this.gl.renderer.disable(this.gl.BLEND),this.cullFace&&this.gl.renderer.setCullFace(this.cullFace),this.gl.renderer.setFrontFace(this.frontFace),this.gl.renderer.setDepthMask(this.depthWrite),this.gl.renderer.setDepthFunc(this.depthFunc),this.blendFunc.src&&this.gl.renderer.setBlendFunc(this.blendFunc.src,this.blendFunc.dst,this.blendFunc.srcAlpha,this.blendFunc.dstAlpha),this.gl.renderer.setBlendEquation(this.blendEquation.modeRGB,this.blendEquation.modeAlpha),this.stencilFunc.func||this.stencilOp.stencilFail?this.gl.renderer.enable(this.gl.STENCIL_TEST):this.gl.renderer.disable(this.gl.STENCIL_TEST),this.gl.renderer.setStencilFunc(this.stencilFunc.func,this.stencilFunc.ref,this.stencilFunc.mask),this.gl.renderer.setStencilOp(this.stencilOp.stencilFail,this.stencilOp.depthFail,this.stencilOp.depthPass)}use({flipFaces:t=!1}={}){let e=-1;this.gl.renderer.state.currentProgram===this.id||(this.gl.useProgram(this.program),this.gl.renderer.state.currentProgram=this.id),this.uniformLocations.forEach((s,n)=>{let a=this.uniforms[n.uniformName];for(let h of n.nameComponents){if(!a)break;if(h in a)a=a[h];else{if(Array.isArray(a.value))break;a=void 0;break}}if(!a)return Pi(`Active uniform ${n.name} has not been supplied`);if(a&&a.value===void 0)return Pi(`${n.name} uniform is missing a value parameter`);if(a.value.texture)return e=e+1,a.value.update(e),Jt(this.gl,n.type,s,e);if(a.value.length&&a.value[0].texture){let h=[];return a.value.forEach(o=>{e=e+1,o.update(e),h.push(e)}),Jt(this.gl,n.type,s,h)}Jt(this.gl,n.type,s,a.value)}),this.applyState(),t&&this.gl.renderer.setFrontFace(this.frontFace===this.gl.CCW?this.gl.CW:this.gl.CCW)}remove(){this.gl.deleteProgram(this.program)}};function Jt(i,t,e,r){r=r.length?ys(r):r;let s=i.renderer.state.uniformLocations.get(e);if(r.length)if(s===void 0||s.length!==r.length)i.renderer.state.uniformLocations.set(e,r.slice(0));else{if(ws(s,r))return;s.set?s.set(r):Ms(s,r),i.renderer.state.uniformLocations.set(e,s)}else{if(s===r)return;i.renderer.state.uniformLocations.set(e,r)}switch(t){case 5126:return r.length?i.uniform1fv(e,r):i.uniform1f(e,r);case 35664:return i.uniform2fv(e,r);case 35665:return i.uniform3fv(e,r);case 35666:return i.uniform4fv(e,r);case 35670:case 5124:case 35678:case 36306:case 35680:case 36289:return r.length?i.uniform1iv(e,r):i.uniform1i(e,r);case 35671:case 35667:return i.uniform2iv(e,r);case 35672:case 35668:return i.uniform3iv(e,r);case 35673:case 35669:return i.uniform4iv(e,r);case 35674:return i.uniformMatrix2fv(e,!1,r);case 35675:return i.uniformMatrix3fv(e,!1,r);case 35676:return i.uniformMatrix4fv(e,!1,r)}}function Si(i){let t=i.split(`
`);for(let e=0;e<t.length;e++)t[e]=e+1+": "+t[e];return t.join(`
`)}function ys(i){let t=i.length,e=i[0].length;if(e===void 0)return i;let r=t*e,s=Li[r];s||(Li[r]=s=new Float32Array(r));for(let n=0;n<t;n++)s.set(i[n],n*e);return s}function ws(i,t){if(i.length!==t.length)return!1;for(let e=0,r=i.length;e<r;e++)if(i[e]!==t[e])return!1;return!0}function Ms(i,t){for(let e=0,r=i.length;e<r;e++)i[e]=t[e]}var te=0;function Pi(i){te>100||(console.warn(i),te++,te>100&&console.warn("More than 100 program warnings - stopping logs."))}var ee=new E,Es=1,ie=class{constructor({canvas:t=document.createElement("canvas"),width:e=300,height:r=150,dpr:s=1,alpha:n=!1,depth:a=!0,stencil:h=!1,antialias:o=!1,premultipliedAlpha:l=!1,preserveDrawingBuffer:c=!1,powerPreference:f="default",autoClear:p=!0,webgl:u=2}={}){let d={alpha:n,depth:a,stencil:h,antialias:o,premultipliedAlpha:l,preserveDrawingBuffer:c,powerPreference:f};this.dpr=s,this.alpha=n,this.color=!0,this.depth=a,this.stencil=h,this.premultipliedAlpha=l,this.autoClear=p,this.id=Es++,u===2&&(this.gl=t.getContext("webgl2",d)),this.isWebgl2=!!this.gl,this.gl||(this.gl=t.getContext("webgl",d)),this.gl||console.error("unable to create webgl context"),this.gl.renderer=this,this.setSize(e,r),this.state={},this.state.blendFunc={src:this.gl.ONE,dst:this.gl.ZERO},this.state.blendEquation={modeRGB:this.gl.FUNC_ADD},this.state.cullFace=!1,this.state.frontFace=this.gl.CCW,this.state.depthMask=!0,this.state.depthFunc=this.gl.LEQUAL,this.state.premultiplyAlpha=!1,this.state.flipY=!1,this.state.unpackAlignment=4,this.state.framebuffer=null,this.state.viewport={x:0,y:0,width:null,height:null},this.state.textureUnits=[],this.state.activeTextureUnit=0,this.state.boundBuffer=null,this.state.uniformLocations=new Map,this.state.currentProgram=null,this.extensions={},this.isWebgl2?(this.getExtension("EXT_color_buffer_float"),this.getExtension("OES_texture_float_linear")):(this.getExtension("OES_texture_float"),this.getExtension("OES_texture_float_linear"),this.getExtension("OES_texture_half_float"),this.getExtension("OES_texture_half_float_linear"),this.getExtension("OES_element_index_uint"),this.getExtension("OES_standard_derivatives"),this.getExtension("EXT_sRGB"),this.getExtension("WEBGL_depth_texture"),this.getExtension("WEBGL_draw_buffers")),this.getExtension("WEBGL_compressed_texture_astc"),this.getExtension("EXT_texture_compression_bptc"),this.getExtension("WEBGL_compressed_texture_s3tc"),this.getExtension("WEBGL_compressed_texture_etc1"),this.getExtension("WEBGL_compressed_texture_pvrtc"),this.getExtension("WEBKIT_WEBGL_compressed_texture_pvrtc"),this.vertexAttribDivisor=this.getExtension("ANGLE_instanced_arrays","vertexAttribDivisor","vertexAttribDivisorANGLE"),this.drawArraysInstanced=this.getExtension("ANGLE_instanced_arrays","drawArraysInstanced","drawArraysInstancedANGLE"),this.drawElementsInstanced=this.getExtension("ANGLE_instanced_arrays","drawElementsInstanced","drawElementsInstancedANGLE"),this.createVertexArray=this.getExtension("OES_vertex_array_object","createVertexArray","createVertexArrayOES"),this.bindVertexArray=this.getExtension("OES_vertex_array_object","bindVertexArray","bindVertexArrayOES"),this.deleteVertexArray=this.getExtension("OES_vertex_array_object","deleteVertexArray","deleteVertexArrayOES"),this.drawBuffers=this.getExtension("WEBGL_draw_buffers","drawBuffers","drawBuffersWEBGL"),this.parameters={},this.parameters.maxTextureUnits=this.gl.getParameter(this.gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS),this.parameters.maxAnisotropy=this.getExtension("EXT_texture_filter_anisotropic")?this.gl.getParameter(this.getExtension("EXT_texture_filter_anisotropic").MAX_TEXTURE_MAX_ANISOTROPY_EXT):0}setSize(t,e){this.width=t,this.height=e,this.gl.canvas.width=t*this.dpr,this.gl.canvas.height=e*this.dpr,this.gl.canvas.style&&Object.assign(this.gl.canvas.style,{width:t+"px",height:e+"px"})}setViewport(t,e,r=0,s=0){this.state.viewport.width===t&&this.state.viewport.height===e||(this.state.viewport.width=t,this.state.viewport.height=e,this.state.viewport.x=r,this.state.viewport.y=s,this.gl.viewport(r,s,t,e))}setScissor(t,e,r=0,s=0){this.gl.scissor(r,s,t,e)}enable(t){this.state[t]!==!0&&(this.gl.enable(t),this.state[t]=!0)}disable(t){this.state[t]!==!1&&(this.gl.disable(t),this.state[t]=!1)}setBlendFunc(t,e,r,s){this.state.blendFunc.src===t&&this.state.blendFunc.dst===e&&this.state.blendFunc.srcAlpha===r&&this.state.blendFunc.dstAlpha===s||(this.state.blendFunc.src=t,this.state.blendFunc.dst=e,this.state.blendFunc.srcAlpha=r,this.state.blendFunc.dstAlpha=s,r!==void 0?this.gl.blendFuncSeparate(t,e,r,s):this.gl.blendFunc(t,e))}setBlendEquation(t,e){t=t||this.gl.FUNC_ADD,!(this.state.blendEquation.modeRGB===t&&this.state.blendEquation.modeAlpha===e)&&(this.state.blendEquation.modeRGB=t,this.state.blendEquation.modeAlpha=e,e!==void 0?this.gl.blendEquationSeparate(t,e):this.gl.blendEquation(t))}setCullFace(t){this.state.cullFace!==t&&(this.state.cullFace=t,this.gl.cullFace(t))}setFrontFace(t){this.state.frontFace!==t&&(this.state.frontFace=t,this.gl.frontFace(t))}setDepthMask(t){this.state.depthMask!==t&&(this.state.depthMask=t,this.gl.depthMask(t))}setDepthFunc(t){this.state.depthFunc!==t&&(this.state.depthFunc=t,this.gl.depthFunc(t))}setStencilMask(t){this.state.stencilMask!==t&&(this.state.stencilMask=t,this.gl.stencilMask(t))}setStencilFunc(t,e,r){this.state.stencilFunc===t&&this.state.stencilRef===e&&this.state.stencilFuncMask===r||(this.state.stencilFunc=t||this.gl.ALWAYS,this.state.stencilRef=e||0,this.state.stencilFuncMask=r||0,this.gl.stencilFunc(t||this.gl.ALWAYS,e||0,r||0))}setStencilOp(t,e,r){this.state.stencilFail===t&&this.state.stencilDepthFail===e&&this.state.stencilDepthPass===r||(this.state.stencilFail=t,this.state.stencilDepthFail=e,this.state.stencilDepthPass=r,this.gl.stencilOp(t,e,r))}activeTexture(t){this.state.activeTextureUnit!==t&&(this.state.activeTextureUnit=t,this.gl.activeTexture(this.gl.TEXTURE0+t))}bindFramebuffer({target:t=this.gl.FRAMEBUFFER,buffer:e=null}={}){this.state.framebuffer!==e&&(this.state.framebuffer=e,this.gl.bindFramebuffer(t,e))}getExtension(t,e,r){return e&&this.gl[e]?this.gl[e].bind(this.gl):(this.extensions[t]||(this.extensions[t]=this.gl.getExtension(t)),e?this.extensions[t]?this.extensions[t][r].bind(this.extensions[t]):null:this.extensions[t])}sortOpaque(t,e){return t.renderOrder!==e.renderOrder?t.renderOrder-e.renderOrder:t.program.id!==e.program.id?t.program.id-e.program.id:t.zDepth!==e.zDepth?t.zDepth-e.zDepth:e.id-t.id}sortTransparent(t,e){return t.renderOrder!==e.renderOrder?t.renderOrder-e.renderOrder:t.zDepth!==e.zDepth?e.zDepth-t.zDepth:e.id-t.id}sortUI(t,e){return t.renderOrder!==e.renderOrder?t.renderOrder-e.renderOrder:t.program.id!==e.program.id?t.program.id-e.program.id:e.id-t.id}getRenderList({scene:t,camera:e,frustumCull:r,sort:s}){let n=[];if(e&&r&&e.updateFrustum(),t.traverse(a=>{if(!a.visible)return!0;a.draw&&(r&&a.frustumCulled&&e&&!e.frustumIntersectsMesh(a)||n.push(a))}),s){let a=[],h=[],o=[];n.forEach(l=>{l.program.transparent?l.program.depthTest?h.push(l):o.push(l):a.push(l),l.zDepth=0,!(l.renderOrder!==0||!l.program.depthTest||!e)&&(l.worldMatrix.getTranslation(ee),ee.applyMatrix4(e.projectionViewMatrix),l.zDepth=ee.z)}),a.sort(this.sortOpaque),h.sort(this.sortTransparent),o.sort(this.sortUI),n=a.concat(h,o)}return n}render({scene:t,camera:e,target:r=null,update:s=!0,sort:n=!0,frustumCull:a=!0,clear:h}){r===null?(this.bindFramebuffer(),this.setViewport(this.width*this.dpr,this.height*this.dpr)):(this.bindFramebuffer(r),this.setViewport(r.width,r.height)),(h||this.autoClear&&h!==!1)&&(this.depth&&(!r||r.depth)&&(this.enable(this.gl.DEPTH_TEST),this.setDepthMask(!0)),(this.stencil||!r||r.stencil)&&(this.enable(this.gl.STENCIL_TEST),this.setStencilMask(255)),this.gl.clear((this.color?this.gl.COLOR_BUFFER_BIT:0)|(this.depth?this.gl.DEPTH_BUFFER_BIT:0)|(this.stencil?this.gl.STENCIL_BUFFER_BIT:0))),s&&t.updateMatrixWorld(),e&&e.updateMatrixWorld(),this.getRenderList({scene:t,camera:e,frustumCull:a,sort:n}).forEach(l=>{l.draw({camera:e})})}};function Nt(i,t){return i[0]=t[0],i[1]=t[1],i[2]=t[2],i[3]=t[3],i}function It(i,t,e,r,s){return i[0]=t,i[1]=e,i[2]=r,i[3]=s,i}function re(i,t,e){return i[0]=t[0]*e,i[1]=t[1]*e,i[2]=t[2]*e,i[3]=t[3]*e,i}function Ot(i,t){let e=t[0],r=t[1],s=t[2],n=t[3],a=e*e+r*r+s*s+n*n;return a>0&&(a=1/Math.sqrt(a)),i[0]=e*a,i[1]=r*a,i[2]=s*a,i[3]=n*a,i}function Dt(i,t){return i[0]*t[0]+i[1]*t[1]+i[2]*t[2]+i[3]*t[3]}function Ni(i){return i[0]=0,i[1]=0,i[2]=0,i[3]=1,i}function Ii(i,t,e){e=e*.5;let r=Math.sin(e);return i[0]=r*t[0],i[1]=r*t[1],i[2]=r*t[2],i[3]=Math.cos(e),i}function se(i,t,e){let r=t[0],s=t[1],n=t[2],a=t[3],h=e[0],o=e[1],l=e[2],c=e[3];return i[0]=r*c+a*h+s*l-n*o,i[1]=s*c+a*o+n*h-r*l,i[2]=n*c+a*l+r*o-s*h,i[3]=a*c-r*h-s*o-n*l,i}function Oi(i,t,e){e*=.5;let r=t[0],s=t[1],n=t[2],a=t[3],h=Math.sin(e),o=Math.cos(e);return i[0]=r*o+a*h,i[1]=s*o+n*h,i[2]=n*o-s*h,i[3]=a*o-r*h,i}function Di(i,t,e){e*=.5;let r=t[0],s=t[1],n=t[2],a=t[3],h=Math.sin(e),o=Math.cos(e);return i[0]=r*o-n*h,i[1]=s*o+a*h,i[2]=n*o+r*h,i[3]=a*o-s*h,i}function Bi(i,t,e){e*=.5;let r=t[0],s=t[1],n=t[2],a=t[3],h=Math.sin(e),o=Math.cos(e);return i[0]=r*o+s*h,i[1]=s*o-r*h,i[2]=n*o+a*h,i[3]=a*o-n*h,i}function Vi(i,t,e,r){let s=t[0],n=t[1],a=t[2],h=t[3],o=e[0],l=e[1],c=e[2],f=e[3],p,u,d,x,m;return u=s*o+n*l+a*c+h*f,u<0&&(u=-u,o=-o,l=-l,c=-c,f=-f),1-u>1e-6?(p=Math.acos(u),d=Math.sin(p),x=Math.sin((1-r)*p)/d,m=Math.sin(r*p)/d):(x=1-r,m=r),i[0]=x*s+m*o,i[1]=x*n+m*l,i[2]=x*a+m*c,i[3]=x*h+m*f,i}function Ui(i,t){let e=t[0],r=t[1],s=t[2],n=t[3],a=e*e+r*r+s*s+n*n,h=a?1/a:0;return i[0]=-e*h,i[1]=-r*h,i[2]=-s*h,i[3]=n*h,i}function ki(i,t){return i[0]=-t[0],i[1]=-t[1],i[2]=-t[2],i[3]=t[3],i}function Gi(i,t){let e=t[0]+t[4]+t[8],r;if(e>0)r=Math.sqrt(e+1),i[3]=.5*r,r=.5/r,i[0]=(t[5]-t[7])*r,i[1]=(t[6]-t[2])*r,i[2]=(t[1]-t[3])*r;else{let s=0;t[4]>t[0]&&(s=1),t[8]>t[s*3+s]&&(s=2);let n=(s+1)%3,a=(s+2)%3;r=Math.sqrt(t[s*3+s]-t[n*3+n]-t[a*3+a]+1),i[s]=.5*r,r=.5/r,i[3]=(t[n*3+a]-t[a*3+n])*r,i[n]=(t[n*3+s]+t[s*3+n])*r,i[a]=(t[a*3+s]+t[s*3+a])*r}return i}function Xi(i,t,e="YXZ"){let r=Math.sin(t[0]*.5),s=Math.cos(t[0]*.5),n=Math.sin(t[1]*.5),a=Math.cos(t[1]*.5),h=Math.sin(t[2]*.5),o=Math.cos(t[2]*.5);return e==="XYZ"?(i[0]=r*a*o+s*n*h,i[1]=s*n*o-r*a*h,i[2]=s*a*h+r*n*o,i[3]=s*a*o-r*n*h):e==="YXZ"?(i[0]=r*a*o+s*n*h,i[1]=s*n*o-r*a*h,i[2]=s*a*h-r*n*o,i[3]=s*a*o+r*n*h):e==="ZXY"?(i[0]=r*a*o-s*n*h,i[1]=s*n*o+r*a*h,i[2]=s*a*h+r*n*o,i[3]=s*a*o-r*n*h):e==="ZYX"?(i[0]=r*a*o-s*n*h,i[1]=s*n*o+r*a*h,i[2]=s*a*h-r*n*o,i[3]=s*a*o+r*n*h):e==="YZX"?(i[0]=r*a*o+s*n*h,i[1]=s*n*o+r*a*h,i[2]=s*a*h-r*n*o,i[3]=s*a*o-r*n*h):e==="XZY"&&(i[0]=r*a*o-s*n*h,i[1]=s*n*o-r*a*h,i[2]=s*a*h+r*n*o,i[3]=s*a*o+r*n*h),i}var Wi=Nt,qi=It;var Yi=Dt;var ji=Ot;var K=class extends Array{constructor(t=0,e=0,r=0,s=1){super(t,e,r,s),this.onChange=()=>{},this._target=this;let n=["0","1","2","3"];return new Proxy(this,{set(a,h){let o=Reflect.set(...arguments);return o&&n.includes(h)&&a.onChange(),o}})}get x(){return this[0]}get y(){return this[1]}get z(){return this[2]}get w(){return this[3]}set x(t){this._target[0]=t,this.onChange()}set y(t){this._target[1]=t,this.onChange()}set z(t){this._target[2]=t,this.onChange()}set w(t){this._target[3]=t,this.onChange()}identity(){return Ni(this._target),this.onChange(),this}set(t,e,r,s){return t.length?this.copy(t):(qi(this._target,t,e,r,s),this.onChange(),this)}rotateX(t){return Oi(this._target,this._target,t),this.onChange(),this}rotateY(t){return Di(this._target,this._target,t),this.onChange(),this}rotateZ(t){return Bi(this._target,this._target,t),this.onChange(),this}inverse(t=this._target){return Ui(this._target,t),this.onChange(),this}conjugate(t=this._target){return ki(this._target,t),this.onChange(),this}copy(t){return Wi(this._target,t),this.onChange(),this}normalize(t=this._target){return ji(this._target,t),this.onChange(),this}multiply(t,e){return e?se(this._target,t,e):se(this._target,this._target,t),this.onChange(),this}dot(t){return Yi(this._target,t)}fromMatrix3(t){return Gi(this._target,t),this.onChange(),this}fromEuler(t,e){return Xi(this._target,t,t.order),e||this.onChange(),this}fromAxisAngle(t,e){return Ii(this._target,t,e),this.onChange(),this}slerp(t,e){return Vi(this._target,this._target,t,e),this.onChange(),this}fromArray(t,e=0){return this._target[0]=t[e],this._target[1]=t[e+1],this._target[2]=t[e+2],this._target[3]=t[e+3],this.onChange(),this}toArray(t=[],e=0){return t[e]=this[0],t[e+1]=this[1],t[e+2]=this[2],t[e+3]=this[3],t}};var _s=1e-6;function Hi(i,t){return i[0]=t[0],i[1]=t[1],i[2]=t[2],i[3]=t[3],i[4]=t[4],i[5]=t[5],i[6]=t[6],i[7]=t[7],i[8]=t[8],i[9]=t[9],i[10]=t[10],i[11]=t[11],i[12]=t[12],i[13]=t[13],i[14]=t[14],i[15]=t[15],i}function Qi(i,t,e,r,s,n,a,h,o,l,c,f,p,u,d,x,m){return i[0]=t,i[1]=e,i[2]=r,i[3]=s,i[4]=n,i[5]=a,i[6]=h,i[7]=o,i[8]=l,i[9]=c,i[10]=f,i[11]=p,i[12]=u,i[13]=d,i[14]=x,i[15]=m,i}function Ki(i){return i[0]=1,i[1]=0,i[2]=0,i[3]=0,i[4]=0,i[5]=1,i[6]=0,i[7]=0,i[8]=0,i[9]=0,i[10]=1,i[11]=0,i[12]=0,i[13]=0,i[14]=0,i[15]=1,i}function Zi(i,t){let e=t[0],r=t[1],s=t[2],n=t[3],a=t[4],h=t[5],o=t[6],l=t[7],c=t[8],f=t[9],p=t[10],u=t[11],d=t[12],x=t[13],m=t[14],g=t[15],A=e*h-r*a,w=e*o-s*a,_=e*l-n*a,M=r*o-s*h,y=r*l-n*h,b=s*l-n*o,z=c*x-f*d,R=c*m-p*d,v=c*g-u*d,L=f*m-p*x,T=f*g-u*x,S=p*g-u*m,F=A*S-w*T+_*L+M*v-y*R+b*z;return F?(F=1/F,i[0]=(h*S-o*T+l*L)*F,i[1]=(s*T-r*S-n*L)*F,i[2]=(x*b-m*y+g*M)*F,i[3]=(p*y-f*b-u*M)*F,i[4]=(o*v-a*S-l*R)*F,i[5]=(e*S-s*v+n*R)*F,i[6]=(m*_-d*b-g*w)*F,i[7]=(c*b-p*_+u*w)*F,i[8]=(a*T-h*v+l*z)*F,i[9]=(r*v-e*T-n*z)*F,i[10]=(d*y-x*_+g*A)*F,i[11]=(f*_-c*y-u*A)*F,i[12]=(h*R-a*L-o*z)*F,i[13]=(e*L-r*R+s*z)*F,i[14]=(x*w-d*M-m*A)*F,i[15]=(c*M-f*w+p*A)*F,i):null}function ne(i){let t=i[0],e=i[1],r=i[2],s=i[3],n=i[4],a=i[5],h=i[6],o=i[7],l=i[8],c=i[9],f=i[10],p=i[11],u=i[12],d=i[13],x=i[14],m=i[15],g=t*a-e*n,A=t*h-r*n,w=t*o-s*n,_=e*h-r*a,M=e*o-s*a,y=r*o-s*h,b=l*d-c*u,z=l*x-f*u,R=l*m-p*u,v=c*x-f*d,L=c*m-p*d,T=f*m-p*x;return g*T-A*L+w*v+_*R-M*z+y*b}function ae(i,t,e){let r=t[0],s=t[1],n=t[2],a=t[3],h=t[4],o=t[5],l=t[6],c=t[7],f=t[8],p=t[9],u=t[10],d=t[11],x=t[12],m=t[13],g=t[14],A=t[15],w=e[0],_=e[1],M=e[2],y=e[3];return i[0]=w*r+_*h+M*f+y*x,i[1]=w*s+_*o+M*p+y*m,i[2]=w*n+_*l+M*u+y*g,i[3]=w*a+_*c+M*d+y*A,w=e[4],_=e[5],M=e[6],y=e[7],i[4]=w*r+_*h+M*f+y*x,i[5]=w*s+_*o+M*p+y*m,i[6]=w*n+_*l+M*u+y*g,i[7]=w*a+_*c+M*d+y*A,w=e[8],_=e[9],M=e[10],y=e[11],i[8]=w*r+_*h+M*f+y*x,i[9]=w*s+_*o+M*p+y*m,i[10]=w*n+_*l+M*u+y*g,i[11]=w*a+_*c+M*d+y*A,w=e[12],_=e[13],M=e[14],y=e[15],i[12]=w*r+_*h+M*f+y*x,i[13]=w*s+_*o+M*p+y*m,i[14]=w*n+_*l+M*u+y*g,i[15]=w*a+_*c+M*d+y*A,i}function $i(i,t,e){let r=e[0],s=e[1],n=e[2],a,h,o,l,c,f,p,u,d,x,m,g;return t===i?(i[12]=t[0]*r+t[4]*s+t[8]*n+t[12],i[13]=t[1]*r+t[5]*s+t[9]*n+t[13],i[14]=t[2]*r+t[6]*s+t[10]*n+t[14],i[15]=t[3]*r+t[7]*s+t[11]*n+t[15]):(a=t[0],h=t[1],o=t[2],l=t[3],c=t[4],f=t[5],p=t[6],u=t[7],d=t[8],x=t[9],m=t[10],g=t[11],i[0]=a,i[1]=h,i[2]=o,i[3]=l,i[4]=c,i[5]=f,i[6]=p,i[7]=u,i[8]=d,i[9]=x,i[10]=m,i[11]=g,i[12]=a*r+c*s+d*n+t[12],i[13]=h*r+f*s+x*n+t[13],i[14]=o*r+p*s+m*n+t[14],i[15]=l*r+u*s+g*n+t[15]),i}function Ji(i,t,e){let r=e[0],s=e[1],n=e[2];return i[0]=t[0]*r,i[1]=t[1]*r,i[2]=t[2]*r,i[3]=t[3]*r,i[4]=t[4]*s,i[5]=t[5]*s,i[6]=t[6]*s,i[7]=t[7]*s,i[8]=t[8]*n,i[9]=t[9]*n,i[10]=t[10]*n,i[11]=t[11]*n,i[12]=t[12],i[13]=t[13],i[14]=t[14],i[15]=t[15],i}function tr(i,t,e,r){let s=r[0],n=r[1],a=r[2],h=Math.hypot(s,n,a),o,l,c,f,p,u,d,x,m,g,A,w,_,M,y,b,z,R,v,L,T,S,F,C;return Math.abs(h)<_s?null:(h=1/h,s*=h,n*=h,a*=h,o=Math.sin(e),l=Math.cos(e),c=1-l,f=t[0],p=t[1],u=t[2],d=t[3],x=t[4],m=t[5],g=t[6],A=t[7],w=t[8],_=t[9],M=t[10],y=t[11],b=s*s*c+l,z=n*s*c+a*o,R=a*s*c-n*o,v=s*n*c-a*o,L=n*n*c+l,T=a*n*c+s*o,S=s*a*c+n*o,F=n*a*c-s*o,C=a*a*c+l,i[0]=f*b+x*z+w*R,i[1]=p*b+m*z+_*R,i[2]=u*b+g*z+M*R,i[3]=d*b+A*z+y*R,i[4]=f*v+x*L+w*T,i[5]=p*v+m*L+_*T,i[6]=u*v+g*L+M*T,i[7]=d*v+A*L+y*T,i[8]=f*S+x*F+w*C,i[9]=p*S+m*F+_*C,i[10]=u*S+g*F+M*C,i[11]=d*S+A*F+y*C,t!==i&&(i[12]=t[12],i[13]=t[13],i[14]=t[14],i[15]=t[15]),i)}function er(i,t){return i[0]=t[12],i[1]=t[13],i[2]=t[14],i}function oe(i,t){let e=t[0],r=t[1],s=t[2],n=t[4],a=t[5],h=t[6],o=t[8],l=t[9],c=t[10];return i[0]=Math.hypot(e,r,s),i[1]=Math.hypot(n,a,h),i[2]=Math.hypot(o,l,c),i}function ir(i){let t=i[0],e=i[1],r=i[2],s=i[4],n=i[5],a=i[6],h=i[8],o=i[9],l=i[10],c=t*t+e*e+r*r,f=s*s+n*n+a*a,p=h*h+o*o+l*l;return Math.sqrt(Math.max(c,f,p))}var he=function(){let i=[1,1,1];return function(t,e){let r=i;oe(r,e);let s=1/r[0],n=1/r[1],a=1/r[2],h=e[0]*s,o=e[1]*n,l=e[2]*a,c=e[4]*s,f=e[5]*n,p=e[6]*a,u=e[8]*s,d=e[9]*n,x=e[10]*a,m=h+f+x,g=0;return m>0?(g=Math.sqrt(m+1)*2,t[3]=.25*g,t[0]=(p-d)/g,t[1]=(u-l)/g,t[2]=(o-c)/g):h>f&&h>x?(g=Math.sqrt(1+h-f-x)*2,t[3]=(p-d)/g,t[0]=.25*g,t[1]=(o+c)/g,t[2]=(u+l)/g):f>x?(g=Math.sqrt(1+f-h-x)*2,t[3]=(u-l)/g,t[0]=(o+c)/g,t[1]=.25*g,t[2]=(p+d)/g):(g=Math.sqrt(1+x-h-f)*2,t[3]=(o-c)/g,t[0]=(u+l)/g,t[1]=(p+d)/g,t[2]=.25*g),t}}();function rr(i,t,e,r){let s=ot([i[0],i[1],i[2]]),n=ot([i[4],i[5],i[6]]),a=ot([i[8],i[9],i[10]]);ne(i)<0&&(s=-s),e[0]=i[12],e[1]=i[13],e[2]=i[14];let o=i.slice(),l=1/s,c=1/n,f=1/a;o[0]*=l,o[1]*=l,o[2]*=l,o[4]*=c,o[5]*=c,o[6]*=c,o[8]*=f,o[9]*=f,o[10]*=f,he(t,o),r[0]=s,r[1]=n,r[2]=a}function sr(i,t,e,r){let s=i,n=t[0],a=t[1],h=t[2],o=t[3],l=n+n,c=a+a,f=h+h,p=n*l,u=n*c,d=n*f,x=a*c,m=a*f,g=h*f,A=o*l,w=o*c,_=o*f,M=r[0],y=r[1],b=r[2];return s[0]=(1-(x+g))*M,s[1]=(u+_)*M,s[2]=(d-w)*M,s[3]=0,s[4]=(u-_)*y,s[5]=(1-(p+g))*y,s[6]=(m+A)*y,s[7]=0,s[8]=(d+w)*b,s[9]=(m-A)*b,s[10]=(1-(p+x))*b,s[11]=0,s[12]=e[0],s[13]=e[1],s[14]=e[2],s[15]=1,s}function nr(i,t){let e=t[0],r=t[1],s=t[2],n=t[3],a=e+e,h=r+r,o=s+s,l=e*a,c=r*a,f=r*h,p=s*a,u=s*h,d=s*o,x=n*a,m=n*h,g=n*o;return i[0]=1-f-d,i[1]=c+g,i[2]=p-m,i[3]=0,i[4]=c-g,i[5]=1-l-d,i[6]=u+x,i[7]=0,i[8]=p+m,i[9]=u-x,i[10]=1-l-f,i[11]=0,i[12]=0,i[13]=0,i[14]=0,i[15]=1,i}function ar(i,t,e,r,s){let n=1/Math.tan(t/2),a=1/(r-s);return i[0]=n/e,i[1]=0,i[2]=0,i[3]=0,i[4]=0,i[5]=n,i[6]=0,i[7]=0,i[8]=0,i[9]=0,i[10]=(s+r)*a,i[11]=-1,i[12]=0,i[13]=0,i[14]=2*s*r*a,i[15]=0,i}function or(i,t,e,r,s,n,a){let h=1/(t-e),o=1/(r-s),l=1/(n-a);return i[0]=-2*h,i[1]=0,i[2]=0,i[3]=0,i[4]=0,i[5]=-2*o,i[6]=0,i[7]=0,i[8]=0,i[9]=0,i[10]=2*l,i[11]=0,i[12]=(t+e)*h,i[13]=(s+r)*o,i[14]=(a+n)*l,i[15]=1,i}function hr(i,t,e,r){let s=t[0],n=t[1],a=t[2],h=r[0],o=r[1],l=r[2],c=s-e[0],f=n-e[1],p=a-e[2],u=c*c+f*f+p*p;u===0?p=1:(u=1/Math.sqrt(u),c*=u,f*=u,p*=u);let d=o*p-l*f,x=l*c-h*p,m=h*f-o*c;return u=d*d+x*x+m*m,u===0&&(l?h+=1e-6:o?l+=1e-6:o+=1e-6,d=o*p-l*f,x=l*c-h*p,m=h*f-o*c,u=d*d+x*x+m*m),u=1/Math.sqrt(u),d*=u,x*=u,m*=u,i[0]=d,i[1]=x,i[2]=m,i[3]=0,i[4]=f*m-p*x,i[5]=p*d-c*m,i[6]=c*x-f*d,i[7]=0,i[8]=c,i[9]=f,i[10]=p,i[11]=0,i[12]=s,i[13]=n,i[14]=a,i[15]=1,i}function le(i,t,e){return i[0]=t[0]+e[0],i[1]=t[1]+e[1],i[2]=t[2]+e[2],i[3]=t[3]+e[3],i[4]=t[4]+e[4],i[5]=t[5]+e[5],i[6]=t[6]+e[6],i[7]=t[7]+e[7],i[8]=t[8]+e[8],i[9]=t[9]+e[9],i[10]=t[10]+e[10],i[11]=t[11]+e[11],i[12]=t[12]+e[12],i[13]=t[13]+e[13],i[14]=t[14]+e[14],i[15]=t[15]+e[15],i}function ce(i,t,e){return i[0]=t[0]-e[0],i[1]=t[1]-e[1],i[2]=t[2]-e[2],i[3]=t[3]-e[3],i[4]=t[4]-e[4],i[5]=t[5]-e[5],i[6]=t[6]-e[6],i[7]=t[7]-e[7],i[8]=t[8]-e[8],i[9]=t[9]-e[9],i[10]=t[10]-e[10],i[11]=t[11]-e[11],i[12]=t[12]-e[12],i[13]=t[13]-e[13],i[14]=t[14]-e[14],i[15]=t[15]-e[15],i}function lr(i,t,e){return i[0]=t[0]*e,i[1]=t[1]*e,i[2]=t[2]*e,i[3]=t[3]*e,i[4]=t[4]*e,i[5]=t[5]*e,i[6]=t[6]*e,i[7]=t[7]*e,i[8]=t[8]*e,i[9]=t[9]*e,i[10]=t[10]*e,i[11]=t[11]*e,i[12]=t[12]*e,i[13]=t[13]*e,i[14]=t[14]*e,i[15]=t[15]*e,i}var V=class extends Array{constructor(t=1,e=0,r=0,s=0,n=0,a=1,h=0,o=0,l=0,c=0,f=1,p=0,u=0,d=0,x=0,m=1){return super(t,e,r,s,n,a,h,o,l,c,f,p,u,d,x,m),this}get x(){return this[12]}get y(){return this[13]}get z(){return this[14]}get w(){return this[15]}set x(t){this[12]=t}set y(t){this[13]=t}set z(t){this[14]=t}set w(t){this[15]=t}set(t,e,r,s,n,a,h,o,l,c,f,p,u,d,x,m){return t.length?this.copy(t):(Qi(this,t,e,r,s,n,a,h,o,l,c,f,p,u,d,x,m),this)}translate(t,e=this){return $i(this,e,t),this}rotate(t,e,r=this){return tr(this,r,t,e),this}scale(t,e=this){return Ji(this,e,typeof t=="number"?[t,t,t]:t),this}add(t,e){return e?le(this,t,e):le(this,this,t),this}sub(t,e){return e?ce(this,t,e):ce(this,this,t),this}multiply(t,e){return t.length?e?ae(this,t,e):ae(this,this,t):lr(this,this,t),this}identity(){return Ki(this),this}copy(t){return Hi(this,t),this}fromPerspective({fov:t,aspect:e,near:r,far:s}={}){return ar(this,t,e,r,s),this}fromOrthogonal({left:t,right:e,bottom:r,top:s,near:n,far:a}){return or(this,t,e,r,s,n,a),this}fromQuaternion(t){return nr(this,t),this}setPosition(t){return this.x=t[0],this.y=t[1],this.z=t[2],this}inverse(t=this){return Zi(this,t),this}compose(t,e,r){return sr(this,t,e,r),this}decompose(t,e,r){return rr(this,t,e,r),this}getRotation(t){return he(t,this),this}getTranslation(t){return er(t,this),this}getScaling(t){return oe(t,this),this}getMaxScaleOnAxis(){return ir(this)}lookAt(t,e,r){return hr(this,t,e,r),this}determinant(){return ne(this)}fromArray(t,e=0){return this[0]=t[e],this[1]=t[e+1],this[2]=t[e+2],this[3]=t[e+3],this[4]=t[e+4],this[5]=t[e+5],this[6]=t[e+6],this[7]=t[e+7],this[8]=t[e+8],this[9]=t[e+9],this[10]=t[e+10],this[11]=t[e+11],this[12]=t[e+12],this[13]=t[e+13],this[14]=t[e+14],this[15]=t[e+15],this}toArray(t=[],e=0){return t[e]=this[0],t[e+1]=this[1],t[e+2]=this[2],t[e+3]=this[3],t[e+4]=this[4],t[e+5]=this[5],t[e+6]=this[6],t[e+7]=this[7],t[e+8]=this[8],t[e+9]=this[9],t[e+10]=this[10],t[e+11]=this[11],t[e+12]=this[12],t[e+13]=this[13],t[e+14]=this[14],t[e+15]=this[15],t}};function cr(i,t,e="YXZ"){return e==="XYZ"?(i[1]=Math.asin(Math.min(Math.max(t[8],-1),1)),Math.abs(t[8])<.99999?(i[0]=Math.atan2(-t[9],t[10]),i[2]=Math.atan2(-t[4],t[0])):(i[0]=Math.atan2(t[6],t[5]),i[2]=0)):e==="YXZ"?(i[0]=Math.asin(-Math.min(Math.max(t[9],-1),1)),Math.abs(t[9])<.99999?(i[1]=Math.atan2(t[8],t[10]),i[2]=Math.atan2(t[1],t[5])):(i[1]=Math.atan2(-t[2],t[0]),i[2]=0)):e==="ZXY"?(i[0]=Math.asin(Math.min(Math.max(t[6],-1),1)),Math.abs(t[6])<.99999?(i[1]=Math.atan2(-t[2],t[10]),i[2]=Math.atan2(-t[4],t[5])):(i[1]=0,i[2]=Math.atan2(t[1],t[0]))):e==="ZYX"?(i[1]=Math.asin(-Math.min(Math.max(t[2],-1),1)),Math.abs(t[2])<.99999?(i[0]=Math.atan2(t[6],t[10]),i[2]=Math.atan2(t[1],t[0])):(i[0]=0,i[2]=Math.atan2(-t[4],t[5]))):e==="YZX"?(i[2]=Math.asin(Math.min(Math.max(t[1],-1),1)),Math.abs(t[1])<.99999?(i[0]=Math.atan2(-t[9],t[5]),i[1]=Math.atan2(-t[2],t[0])):(i[0]=0,i[1]=Math.atan2(t[8],t[10]))):e==="XZY"&&(i[2]=Math.asin(-Math.min(Math.max(t[4],-1),1)),Math.abs(t[4])<.99999?(i[0]=Math.atan2(t[6],t[5]),i[1]=Math.atan2(t[8],t[0])):(i[0]=Math.atan2(-t[9],t[10]),i[1]=0)),i}var fr=new V,xt=class extends Array{constructor(t=0,e=t,r=t,s="YXZ"){super(t,e,r),this.order=s,this.onChange=()=>{},this._target=this;let n=["0","1","2"];return new Proxy(this,{set(a,h){let o=Reflect.set(...arguments);return o&&n.includes(h)&&a.onChange(),o}})}get x(){return this[0]}get y(){return this[1]}get z(){return this[2]}set x(t){this._target[0]=t,this.onChange()}set y(t){this._target[1]=t,this.onChange()}set z(t){this._target[2]=t,this.onChange()}set(t,e=t,r=t){return t.length?this.copy(t):(this._target[0]=t,this._target[1]=e,this._target[2]=r,this.onChange(),this)}copy(t){return this._target[0]=t[0],this._target[1]=t[1],this._target[2]=t[2],this.onChange(),this}reorder(t){return this._target.order=t,this.onChange(),this}fromRotationMatrix(t,e=this.order){return cr(this._target,t,e),this.onChange(),this}fromQuaternion(t,e=this.order,r){return fr.fromQuaternion(t),this._target.fromRotationMatrix(fr,e),r||this.onChange(),this}fromArray(t,e=0){return this._target[0]=t[e],this._target[1]=t[e+1],this._target[2]=t[e+2],this}toArray(t=[],e=0){return t[e]=this[0],t[e+1]=this[1],t[e+2]=this[2],t}};var H=class{constructor(){this.parent=null,this.children=[],this.visible=!0,this.matrix=new V,this.worldMatrix=new V,this.matrixAutoUpdate=!0,this.worldMatrixNeedsUpdate=!1,this.position=new E,this.quaternion=new K,this.scale=new E(1),this.rotation=new xt,this.up=new E(0,1,0),this.rotation._target.onChange=()=>this.quaternion.fromEuler(this.rotation,!0),this.quaternion._target.onChange=()=>this.rotation.fromQuaternion(this.quaternion,void 0,!0)}setParent(t,e=!0){this.parent&&t!==this.parent&&this.parent.removeChild(this,!1),this.parent=t,e&&t&&t.addChild(this,!1)}addChild(t,e=!0){~this.children.indexOf(t)||this.children.push(t),e&&t.setParent(this,!1)}removeChild(t,e=!0){~this.children.indexOf(t)&&this.children.splice(this.children.indexOf(t),1),e&&t.setParent(null,!1)}updateMatrixWorld(t){this.matrixAutoUpdate&&this.updateMatrix(),(this.worldMatrixNeedsUpdate||t)&&(this.parent===null?this.worldMatrix.copy(this.matrix):this.worldMatrix.multiply(this.parent.worldMatrix,this.matrix),this.worldMatrixNeedsUpdate=!1,t=!0);for(let e=0,r=this.children.length;e<r;e++)this.children[e].updateMatrixWorld(t)}updateMatrix(){this.matrix.compose(this.quaternion,this.position,this.scale),this.worldMatrixNeedsUpdate=!0}traverse(t){if(!t(this))for(let e=0,r=this.children.length;e<r;e++)this.children[e].traverse(t)}decompose(){this.matrix.decompose(this.quaternion._target,this.position,this.scale),this.rotation.fromQuaternion(this.quaternion)}lookAt(t,e=!1){e?this.matrix.lookAt(this.position,t,this.up):this.matrix.lookAt(t,this.position,this.up),this.matrix.getRotation(this.quaternion._target),this.rotation.fromQuaternion(this.quaternion)}};var Fs=new V,Ts=new E,Rs=new E,ht=class extends H{constructor(t,{near:e=.1,far:r=100,fov:s=45,aspect:n=1,left:a,right:h,bottom:o,top:l,zoom:c=1}={}){super(),Object.assign(this,{near:e,far:r,fov:s,aspect:n,left:a,right:h,bottom:o,top:l,zoom:c}),this.projectionMatrix=new V,this.viewMatrix=new V,this.projectionViewMatrix=new V,this.worldPosition=new E,this.type=a||h?"orthographic":"perspective",this.type==="orthographic"?this.orthographic():this.perspective()}perspective({near:t=this.near,far:e=this.far,fov:r=this.fov,aspect:s=this.aspect}={}){return Object.assign(this,{near:t,far:e,fov:r,aspect:s}),this.projectionMatrix.fromPerspective({fov:r*(Math.PI/180),aspect:s,near:t,far:e}),this.type="perspective",this}orthographic({near:t=this.near,far:e=this.far,left:r=this.left||-1,right:s=this.right||1,bottom:n=this.bottom||-1,top:a=this.top||1,zoom:h=this.zoom}={}){return Object.assign(this,{near:t,far:e,left:r,right:s,bottom:n,top:a,zoom:h}),r/=h,s/=h,n/=h,a/=h,this.projectionMatrix.fromOrthogonal({left:r,right:s,bottom:n,top:a,near:t,far:e}),this.type="orthographic",this}updateMatrixWorld(){return super.updateMatrixWorld(),this.viewMatrix.inverse(this.worldMatrix),this.worldMatrix.getTranslation(this.worldPosition),this.projectionViewMatrix.multiply(this.projectionMatrix,this.viewMatrix),this}updateProjectionMatrix(){return this.type==="perspective"?this.perspective():this.orthographic()}lookAt(t){return super.lookAt(t,!0),this}project(t){return t.applyMatrix4(this.viewMatrix),t.applyMatrix4(this.projectionMatrix),this}unproject(t){return t.applyMatrix4(Fs.inverse(this.projectionMatrix)),t.applyMatrix4(this.worldMatrix),this}updateFrustum(){this.frustum||(this.frustum=[new E,new E,new E,new E,new E,new E]);let t=this.projectionViewMatrix;this.frustum[0].set(t[3]-t[0],t[7]-t[4],t[11]-t[8]).constant=t[15]-t[12],this.frustum[1].set(t[3]+t[0],t[7]+t[4],t[11]+t[8]).constant=t[15]+t[12],this.frustum[2].set(t[3]+t[1],t[7]+t[5],t[11]+t[9]).constant=t[15]+t[13],this.frustum[3].set(t[3]-t[1],t[7]-t[5],t[11]-t[9]).constant=t[15]-t[13],this.frustum[4].set(t[3]-t[2],t[7]-t[6],t[11]-t[10]).constant=t[15]-t[14],this.frustum[5].set(t[3]+t[2],t[7]+t[6],t[11]+t[10]).constant=t[15]+t[14];for(let e=0;e<6;e++){let r=1/this.frustum[e].distance();this.frustum[e].multiply(r),this.frustum[e].constant*=r}}frustumIntersectsMesh(t,e=t.worldMatrix){if(!t.geometry.attributes.position||((!t.geometry.bounds||t.geometry.bounds.radius===1/0)&&t.geometry.computeBoundingSphere(),!t.geometry.bounds))return!0;let r=Ts;r.copy(t.geometry.bounds.center),r.applyMatrix4(e);let s=t.geometry.bounds.radius*e.getMaxScaleOnAxis();return this.frustumIntersectsSphere(r,s)}frustumIntersectsSphere(t,e){let r=Rs;for(let s=0;s<6;s++){let n=this.frustum[s];if(r.copy(n).dot(t)+n.constant<-e)return!1}return!0}};function ur(i,t){return i[0]=t[0],i[1]=t[1],i[2]=t[2],i[3]=t[4],i[4]=t[5],i[5]=t[6],i[6]=t[8],i[7]=t[9],i[8]=t[10],i}function pr(i,t){let e=t[0],r=t[1],s=t[2],n=t[3],a=e+e,h=r+r,o=s+s,l=e*a,c=r*a,f=r*h,p=s*a,u=s*h,d=s*o,x=n*a,m=n*h,g=n*o;return i[0]=1-f-d,i[3]=c-g,i[6]=p+m,i[1]=c+g,i[4]=1-l-d,i[7]=u-x,i[2]=p-m,i[5]=u+x,i[8]=1-l-f,i}function dr(i,t){return i[0]=t[0],i[1]=t[1],i[2]=t[2],i[3]=t[3],i[4]=t[4],i[5]=t[5],i[6]=t[6],i[7]=t[7],i[8]=t[8],i}function mr(i,t,e,r,s,n,a,h,o,l){return i[0]=t,i[1]=e,i[2]=r,i[3]=s,i[4]=n,i[5]=a,i[6]=h,i[7]=o,i[8]=l,i}function gr(i){return i[0]=1,i[1]=0,i[2]=0,i[3]=0,i[4]=1,i[5]=0,i[6]=0,i[7]=0,i[8]=1,i}function xr(i,t){let e=t[0],r=t[1],s=t[2],n=t[3],a=t[4],h=t[5],o=t[6],l=t[7],c=t[8],f=c*a-h*l,p=-c*n+h*o,u=l*n-a*o,d=e*f+r*p+s*u;return d?(d=1/d,i[0]=f*d,i[1]=(-c*r+s*l)*d,i[2]=(h*r-s*a)*d,i[3]=p*d,i[4]=(c*e-s*o)*d,i[5]=(-h*e+s*n)*d,i[6]=u*d,i[7]=(-l*e+r*o)*d,i[8]=(a*e-r*n)*d,i):null}function fe(i,t,e){let r=t[0],s=t[1],n=t[2],a=t[3],h=t[4],o=t[5],l=t[6],c=t[7],f=t[8],p=e[0],u=e[1],d=e[2],x=e[3],m=e[4],g=e[5],A=e[6],w=e[7],_=e[8];return i[0]=p*r+u*a+d*l,i[1]=p*s+u*h+d*c,i[2]=p*n+u*o+d*f,i[3]=x*r+m*a+g*l,i[4]=x*s+m*h+g*c,i[5]=x*n+m*o+g*f,i[6]=A*r+w*a+_*l,i[7]=A*s+w*h+_*c,i[8]=A*n+w*o+_*f,i}function yr(i,t,e){let r=t[0],s=t[1],n=t[2],a=t[3],h=t[4],o=t[5],l=t[6],c=t[7],f=t[8],p=e[0],u=e[1];return i[0]=r,i[1]=s,i[2]=n,i[3]=a,i[4]=h,i[5]=o,i[6]=p*r+u*a+l,i[7]=p*s+u*h+c,i[8]=p*n+u*o+f,i}function wr(i,t,e){let r=t[0],s=t[1],n=t[2],a=t[3],h=t[4],o=t[5],l=t[6],c=t[7],f=t[8],p=Math.sin(e),u=Math.cos(e);return i[0]=u*r+p*a,i[1]=u*s+p*h,i[2]=u*n+p*o,i[3]=u*a-p*r,i[4]=u*h-p*s,i[5]=u*o-p*n,i[6]=l,i[7]=c,i[8]=f,i}function Mr(i,t,e){let r=e[0],s=e[1];return i[0]=r*t[0],i[1]=r*t[1],i[2]=r*t[2],i[3]=s*t[3],i[4]=s*t[4],i[5]=s*t[5],i[6]=t[6],i[7]=t[7],i[8]=t[8],i}function Er(i,t){let e=t[0],r=t[1],s=t[2],n=t[3],a=t[4],h=t[5],o=t[6],l=t[7],c=t[8],f=t[9],p=t[10],u=t[11],d=t[12],x=t[13],m=t[14],g=t[15],A=e*h-r*a,w=e*o-s*a,_=e*l-n*a,M=r*o-s*h,y=r*l-n*h,b=s*l-n*o,z=c*x-f*d,R=c*m-p*d,v=c*g-u*d,L=f*m-p*x,T=f*g-u*x,S=p*g-u*m,F=A*S-w*T+_*L+M*v-y*R+b*z;return F?(F=1/F,i[0]=(h*S-o*T+l*L)*F,i[1]=(o*v-a*S-l*R)*F,i[2]=(a*T-h*v+l*z)*F,i[3]=(s*T-r*S-n*L)*F,i[4]=(e*S-s*v+n*R)*F,i[5]=(r*v-e*T-n*z)*F,i[6]=(x*b-m*y+g*M)*F,i[7]=(m*_-d*b-g*w)*F,i[8]=(d*y-x*_+g*A)*F,i):null}var et=class extends Array{constructor(t=1,e=0,r=0,s=0,n=1,a=0,h=0,o=0,l=1){return super(t,e,r,s,n,a,h,o,l),this}set(t,e,r,s,n,a,h,o,l){return t.length?this.copy(t):(mr(this,t,e,r,s,n,a,h,o,l),this)}translate(t,e=this){return yr(this,e,t),this}rotate(t,e=this){return wr(this,e,t),this}scale(t,e=this){return Mr(this,e,t),this}multiply(t,e){return e?fe(this,t,e):fe(this,this,t),this}identity(){return gr(this),this}copy(t){return dr(this,t),this}fromMatrix4(t){return ur(this,t),this}fromQuaternion(t){return pr(this,t),this}fromBasis(t,e,r){return this.set(t[0],t[1],t[2],e[0],e[1],e[2],r[0],r[1],r[2]),this}inverse(t=this){return xr(this,t),this}getNormalMatrix(t){return Er(this,t),this}};var Ls=0,D=class extends H{constructor(t,{geometry:e,program:r,mode:s=t.TRIANGLES,frustumCulled:n=!0,renderOrder:a=0}={}){super(),t.canvas||console.error("gl not passed as first argument to Mesh"),this.gl=t,this.id=Ls++,this.geometry=e,this.program=r,this.mode=s,this.frustumCulled=n,this.renderOrder=a,this.modelViewMatrix=new V,this.normalMatrix=new et,this.beforeRenderCallbacks=[],this.afterRenderCallbacks=[]}onBeforeRender(t){return this.beforeRenderCallbacks.push(t),this}onAfterRender(t){return this.afterRenderCallbacks.push(t),this}draw({camera:t}={}){t&&(this.program.uniforms.modelMatrix||Object.assign(this.program.uniforms,{modelMatrix:{value:null},viewMatrix:{value:null},modelViewMatrix:{value:null},normalMatrix:{value:null},projectionMatrix:{value:null},cameraPosition:{value:null}}),this.program.uniforms.projectionMatrix.value=t.projectionMatrix,this.program.uniforms.cameraPosition.value=t.worldPosition,this.program.uniforms.viewMatrix.value=t.viewMatrix,this.modelViewMatrix.multiply(t.viewMatrix,this.worldMatrix),this.normalMatrix.getNormalMatrix(this.modelViewMatrix),this.program.uniforms.modelMatrix.value=this.worldMatrix,this.program.uniforms.modelViewMatrix.value=this.modelViewMatrix,this.program.uniforms.normalMatrix.value=this.normalMatrix),this.beforeRenderCallbacks.forEach(r=>r&&r({mesh:this,camera:t}));let e=this.program.cullFace&&this.worldMatrix.determinant()<0;this.program.use({flipFaces:e}),this.geometry.draw({mode:this.mode,program:this.program}),this.afterRenderCallbacks.forEach(r=>r&&r({mesh:this,camera:t}))}};var Ar=new Uint8Array(4);function _r(i){return(i&i-1)===0}var Ss=1,G=class{constructor(t,{image:e,target:r=t.TEXTURE_2D,type:s=t.UNSIGNED_BYTE,format:n=t.RGBA,internalFormat:a=n,wrapS:h=t.CLAMP_TO_EDGE,wrapT:o=t.CLAMP_TO_EDGE,wrapR:l=t.CLAMP_TO_EDGE,generateMipmaps:c=r===(t.TEXTURE_2D||t.TEXTURE_CUBE_MAP),minFilter:f=c?t.NEAREST_MIPMAP_LINEAR:t.LINEAR,magFilter:p=t.LINEAR,premultiplyAlpha:u=!1,unpackAlignment:d=4,flipY:x=r==(t.TEXTURE_2D||t.TEXTURE_3D),anisotropy:m=0,level:g=0,width:A,height:w=A,length:_=1}={}){this.gl=t,this.id=Ss++,this.image=e,this.target=r,this.type=s,this.format=n,this.internalFormat=a,this.minFilter=f,this.magFilter=p,this.wrapS=h,this.wrapT=o,this.wrapR=l,this.generateMipmaps=c,this.premultiplyAlpha=u,this.unpackAlignment=d,this.flipY=x,this.anisotropy=Math.min(m,this.gl.renderer.parameters.maxAnisotropy),this.level=g,this.width=A,this.height=w,this.length=_,this.texture=this.gl.createTexture(),this.store={image:null},this.glState=this.gl.renderer.state,this.state={},this.state.minFilter=this.gl.NEAREST_MIPMAP_LINEAR,this.state.magFilter=this.gl.LINEAR,this.state.wrapS=this.gl.REPEAT,this.state.wrapT=this.gl.REPEAT,this.state.anisotropy=0}bind(){this.glState.textureUnits[this.glState.activeTextureUnit]!==this.id&&(this.gl.bindTexture(this.target,this.texture),this.glState.textureUnits[this.glState.activeTextureUnit]=this.id)}update(t=0){let e=!(this.image===this.store.image&&!this.needsUpdate);if((e||this.glState.textureUnits[t]!==this.id)&&(this.gl.renderer.activeTexture(t),this.bind()),!!e){if(this.needsUpdate=!1,this.flipY!==this.glState.flipY&&(this.gl.pixelStorei(this.gl.UNPACK_FLIP_Y_WEBGL,this.flipY),this.glState.flipY=this.flipY),this.premultiplyAlpha!==this.glState.premultiplyAlpha&&(this.gl.pixelStorei(this.gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,this.premultiplyAlpha),this.glState.premultiplyAlpha=this.premultiplyAlpha),this.unpackAlignment!==this.glState.unpackAlignment&&(this.gl.pixelStorei(this.gl.UNPACK_ALIGNMENT,this.unpackAlignment),this.glState.unpackAlignment=this.unpackAlignment),this.minFilter!==this.state.minFilter&&(this.gl.texParameteri(this.target,this.gl.TEXTURE_MIN_FILTER,this.minFilter),this.state.minFilter=this.minFilter),this.magFilter!==this.state.magFilter&&(this.gl.texParameteri(this.target,this.gl.TEXTURE_MAG_FILTER,this.magFilter),this.state.magFilter=this.magFilter),this.wrapS!==this.state.wrapS&&(this.gl.texParameteri(this.target,this.gl.TEXTURE_WRAP_S,this.wrapS),this.state.wrapS=this.wrapS),this.wrapT!==this.state.wrapT&&(this.gl.texParameteri(this.target,this.gl.TEXTURE_WRAP_T,this.wrapT),this.state.wrapT=this.wrapT),this.wrapR!==this.state.wrapR&&(this.gl.texParameteri(this.target,this.gl.TEXTURE_WRAP_R,this.wrapR),this.state.wrapR=this.wrapR),this.anisotropy&&this.anisotropy!==this.state.anisotropy&&(this.gl.texParameterf(this.target,this.gl.renderer.getExtension("EXT_texture_filter_anisotropic").TEXTURE_MAX_ANISOTROPY_EXT,this.anisotropy),this.state.anisotropy=this.anisotropy),this.image){if(this.image.width&&(this.width=this.image.width,this.height=this.image.height),this.target===this.gl.TEXTURE_CUBE_MAP)for(let r=0;r<6;r++)this.gl.texImage2D(this.gl.TEXTURE_CUBE_MAP_POSITIVE_X+r,this.level,this.internalFormat,this.format,this.type,this.image[r]);else if(ArrayBuffer.isView(this.image))this.target===this.gl.TEXTURE_2D?this.gl.texImage2D(this.target,this.level,this.internalFormat,this.width,this.height,0,this.format,this.type,this.image):(this.target===this.gl.TEXTURE_2D_ARRAY||this.target===this.gl.TEXTURE_3D)&&this.gl.texImage3D(this.target,this.level,this.internalFormat,this.width,this.height,this.length,0,this.format,this.type,this.image);else if(this.image.isCompressedTexture)for(let r=0;r<this.image.length;r++)this.gl.compressedTexImage2D(this.target,r,this.internalFormat,this.image[r].width,this.image[r].height,0,this.image[r].data);else this.target===this.gl.TEXTURE_2D?this.gl.texImage2D(this.target,this.level,this.internalFormat,this.format,this.type,this.image):this.gl.texImage3D(this.target,this.level,this.internalFormat,this.width,this.height,this.length,0,this.format,this.type,this.image);this.generateMipmaps&&(!this.gl.renderer.isWebgl2&&(!_r(this.image.width)||!_r(this.image.height))?(this.generateMipmaps=!1,this.wrapS=this.wrapT=this.gl.CLAMP_TO_EDGE,this.minFilter=this.gl.LINEAR):this.gl.generateMipmap(this.target)),this.onUpdate&&this.onUpdate()}else if(this.target===this.gl.TEXTURE_CUBE_MAP)for(let r=0;r<6;r++)this.gl.texImage2D(this.gl.TEXTURE_CUBE_MAP_POSITIVE_X+r,0,this.gl.RGBA,1,1,0,this.gl.RGBA,this.gl.UNSIGNED_BYTE,Ar);else this.width?this.target===this.gl.TEXTURE_2D?this.gl.texImage2D(this.target,this.level,this.internalFormat,this.width,this.height,0,this.format,this.type,null):this.gl.texImage3D(this.target,this.level,this.internalFormat,this.width,this.height,this.length,0,this.format,this.type,null):this.gl.texImage2D(this.target,0,this.gl.RGBA,1,1,0,this.gl.RGBA,this.gl.UNSIGNED_BYTE,Ar);this.store.image=this.image}}};var j=class{constructor(t,{width:e=t.canvas.width,height:r=t.canvas.height,target:s=t.FRAMEBUFFER,color:n=1,depth:a=!0,stencil:h=!1,depthTexture:o=!1,wrapS:l=t.CLAMP_TO_EDGE,wrapT:c=t.CLAMP_TO_EDGE,wrapR:f=t.CLAMP_TO_EDGE,minFilter:p=t.LINEAR,magFilter:u=p,type:d=t.UNSIGNED_BYTE,format:x=t.RGBA,internalFormat:m=x,unpackAlignment:g,premultiplyAlpha:A}={}){this.gl=t,this.width=e,this.height=r,this.depth=a,this.stencil=h,this.buffer=this.gl.createFramebuffer(),this.target=s,this.gl.renderer.bindFramebuffer(this),this.textures=[];let w=[];for(let _=0;_<n;_++)this.textures.push(new G(t,{width:e,height:r,wrapS:l,wrapT:c,wrapR:f,minFilter:p,magFilter:u,type:d,format:x,internalFormat:m,unpackAlignment:g,premultiplyAlpha:A,flipY:!1,generateMipmaps:!1})),this.textures[_].update(),this.gl.framebufferTexture2D(this.target,this.gl.COLOR_ATTACHMENT0+_,this.gl.TEXTURE_2D,this.textures[_].texture,0),w.push(this.gl.COLOR_ATTACHMENT0+_);w.length>1&&this.gl.renderer.drawBuffers(w),this.texture=this.textures[0],o&&(this.gl.renderer.isWebgl2||this.gl.renderer.getExtension("WEBGL_depth_texture"))?(this.depthTexture=new G(t,{width:e,height:r,minFilter:this.gl.NEAREST,magFilter:this.gl.NEAREST,format:this.stencil?this.gl.DEPTH_STENCIL:this.gl.DEPTH_COMPONENT,internalFormat:t.renderer.isWebgl2?this.stencil?this.gl.DEPTH24_STENCIL8:this.gl.DEPTH_COMPONENT16:this.gl.DEPTH_COMPONENT,type:this.stencil?this.gl.UNSIGNED_INT_24_8:this.gl.UNSIGNED_INT}),this.depthTexture.update(),this.gl.framebufferTexture2D(this.target,this.stencil?this.gl.DEPTH_STENCIL_ATTACHMENT:this.gl.DEPTH_ATTACHMENT,this.gl.TEXTURE_2D,this.depthTexture.texture,0)):(a&&!h&&(this.depthBuffer=this.gl.createRenderbuffer(),this.gl.bindRenderbuffer(this.gl.RENDERBUFFER,this.depthBuffer),this.gl.renderbufferStorage(this.gl.RENDERBUFFER,this.gl.DEPTH_COMPONENT16,e,r),this.gl.framebufferRenderbuffer(this.target,this.gl.DEPTH_ATTACHMENT,this.gl.RENDERBUFFER,this.depthBuffer)),h&&!a&&(this.stencilBuffer=this.gl.createRenderbuffer(),this.gl.bindRenderbuffer(this.gl.RENDERBUFFER,this.stencilBuffer),this.gl.renderbufferStorage(this.gl.RENDERBUFFER,this.gl.STENCIL_INDEX8,e,r),this.gl.framebufferRenderbuffer(this.target,this.gl.STENCIL_ATTACHMENT,this.gl.RENDERBUFFER,this.stencilBuffer)),a&&h&&(this.depthStencilBuffer=this.gl.createRenderbuffer(),this.gl.bindRenderbuffer(this.gl.RENDERBUFFER,this.depthStencilBuffer),this.gl.renderbufferStorage(this.gl.RENDERBUFFER,this.gl.DEPTH_STENCIL,e,r),this.gl.framebufferRenderbuffer(this.target,this.gl.DEPTH_STENCIL_ATTACHMENT,this.gl.RENDERBUFFER,this.depthStencilBuffer))),this.gl.renderer.bindFramebuffer({target:this.target})}setSize(t,e){if(!(this.width===t&&this.height===e)){this.width=t,this.height=e,this.gl.renderer.bindFramebuffer(this);for(let r=0;r<this.textures.length;r++)this.textures[r].width=t,this.textures[r].height=e,this.textures[r].needsUpdate=!0,this.textures[r].update(),this.gl.framebufferTexture2D(this.target,this.gl.COLOR_ATTACHMENT0+r,this.gl.TEXTURE_2D,this.textures[r].texture,0);this.depthTexture?(this.depthTexture.width=t,this.depthTexture.height=e,this.depthTexture.needsUpdate=!0,this.depthTexture.update(),this.gl.framebufferTexture2D(this.target,this.gl.DEPTH_ATTACHMENT,this.gl.TEXTURE_2D,this.depthTexture.texture,0)):(this.depthBuffer&&(this.gl.bindRenderbuffer(this.gl.RENDERBUFFER,this.depthBuffer),this.gl.renderbufferStorage(this.gl.RENDERBUFFER,this.gl.DEPTH_COMPONENT16,t,e)),this.stencilBuffer&&(this.gl.bindRenderbuffer(this.gl.RENDERBUFFER,this.stencilBuffer),this.gl.renderbufferStorage(this.gl.RENDERBUFFER,this.gl.STENCIL_INDEX8,t,e)),this.depthStencilBuffer&&(this.gl.bindRenderbuffer(this.gl.RENDERBUFFER,this.depthStencilBuffer),this.gl.renderbufferStorage(this.gl.RENDERBUFFER,this.gl.DEPTH_STENCIL,t,e))),this.gl.renderer.bindFramebuffer({target:this.target})}}};var vr={black:"#000000",white:"#ffffff",red:"#ff0000",green:"#00ff00",blue:"#0000ff",fuchsia:"#ff00ff",cyan:"#00ffff",yellow:"#ffff00",orange:"#ff8000"};function br(i){i.length===4&&(i=i[0]+i[1]+i[1]+i[2]+i[2]+i[3]+i[3]);let t=/^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(i);return t||console.warn(`Unable to convert hex string ${i} to rgb values`),[parseInt(t[1],16)/255,parseInt(t[2],16)/255,parseInt(t[3],16)/255]}function Ps(i){return i=parseInt(i),[(i>>16&255)/255,(i>>8&255)/255,(i&255)/255]}function ue(i){return i===void 0?[0,0,0]:arguments.length===3?arguments:isNaN(i)?i[0]==="#"?br(i):vr[i.toLowerCase()]?br(vr[i.toLowerCase()]):(console.warn("Color format not recognised"),[0,0,0]):Ps(i)}var lt=class extends Array{constructor(t){return Array.isArray(t)?super(...t):super(...ue(...arguments))}get r(){return this[0]}get g(){return this[1]}get b(){return this[2]}set r(t){this[0]=t}set g(t){this[1]=t}set b(t){this[2]=t}set(t){return Array.isArray(t)?this.copy(t):this.copy(ue(...arguments))}copy(t){return this[0]=t[0],this[1]=t[1],this[2]=t[2],this}};function Fr(i,t){return i[0]=t[0],i[1]=t[1],i}function Tr(i,t,e){return i[0]=t,i[1]=e,i}function pe(i,t,e){return i[0]=t[0]+e[0],i[1]=t[1]+e[1],i}function de(i,t,e){return i[0]=t[0]-e[0],i[1]=t[1]-e[1],i}function Rr(i,t,e){return i[0]=t[0]*e[0],i[1]=t[1]*e[1],i}function zr(i,t,e){return i[0]=t[0]/e[0],i[1]=t[1]/e[1],i}function Bt(i,t,e){return i[0]=t[0]*e,i[1]=t[1]*e,i}function Lr(i,t){var e=t[0]-i[0],r=t[1]-i[1];return Math.sqrt(e*e+r*r)}function Sr(i,t){var e=t[0]-i[0],r=t[1]-i[1];return e*e+r*r}function me(i){var t=i[0],e=i[1];return Math.sqrt(t*t+e*e)}function Pr(i){var t=i[0],e=i[1];return t*t+e*e}function Cr(i,t){return i[0]=-t[0],i[1]=-t[1],i}function Nr(i,t){return i[0]=1/t[0],i[1]=1/t[1],i}function Ir(i,t){var e=t[0],r=t[1],s=e*e+r*r;return s>0&&(s=1/Math.sqrt(s)),i[0]=t[0]*s,i[1]=t[1]*s,i}function Or(i,t){return i[0]*t[0]+i[1]*t[1]}function ge(i,t){return i[0]*t[1]-i[1]*t[0]}function Dr(i,t,e,r){var s=t[0],n=t[1];return i[0]=s+r*(e[0]-s),i[1]=n+r*(e[1]-n),i}function Br(i,t,e,r,s){let n=Math.exp(-r*s),a=t[0],h=t[1];return i[0]=e[0]+(a-e[0])*n,i[1]=e[1]+(h-e[1])*n,i}function Vr(i,t,e){var r=t[0],s=t[1];return i[0]=e[0]*r+e[3]*s+e[6],i[1]=e[1]*r+e[4]*s+e[7],i}function Ur(i,t,e){let r=t[0],s=t[1];return i[0]=e[0]*r+e[4]*s+e[12],i[1]=e[1]*r+e[5]*s+e[13],i}function kr(i,t){return i[0]===t[0]&&i[1]===t[1]}var X=class i extends Array{constructor(t=0,e=t){return super(t,e),this}get x(){return this[0]}get y(){return this[1]}set x(t){this[0]=t}set y(t){this[1]=t}set(t,e=t){return t.length?this.copy(t):(Tr(this,t,e),this)}copy(t){return Fr(this,t),this}add(t,e){return e?pe(this,t,e):pe(this,this,t),this}sub(t,e){return e?de(this,t,e):de(this,this,t),this}multiply(t){return t.length?Rr(this,this,t):Bt(this,this,t),this}divide(t){return t.length?zr(this,this,t):Bt(this,this,1/t),this}inverse(t=this){return Nr(this,t),this}len(){return me(this)}distance(t){return t?Lr(this,t):me(this)}squaredLen(){return this.squaredDistance()}squaredDistance(t){return t?Sr(this,t):Pr(this)}negate(t=this){return Cr(this,t),this}cross(t,e){return e?ge(t,e):ge(this,t)}scale(t){return Bt(this,this,t),this}normalize(){return Ir(this,this),this}dot(t){return Or(this,t)}equals(t){return kr(this,t)}applyMatrix3(t){return Vr(this,this,t),this}applyMatrix4(t){return Ur(this,this,t),this}lerp(t,e){return Dr(this,this,t,e),this}smoothLerp(t,e,r){return Br(this,this,t,e,r),this}clone(){return new i(this[0],this[1])}fromArray(t,e=0){return this[0]=t[e],this[1]=t[e+1],this}toArray(t=[],e=0){return t[e]=this[0],t[e+1]=this[1],t}};var yt=class extends Array{constructor(t=0,e=t,r=t,s=t){return super(t,e,r,s),this}get x(){return this[0]}get y(){return this[1]}get z(){return this[2]}get w(){return this[3]}set x(t){this[0]=t}set y(t){this[1]=t}set z(t){this[2]=t}set w(t){this[3]=t}set(t,e=t,r=t,s=t){return t.length?this.copy(t):(It(this,t,e,r,s),this)}copy(t){return Nt(this,t),this}normalize(){return Ot(this,this),this}multiply(t){return re(this,this,t),this}dot(t){return Dt(this,t)}fromArray(t,e=0){return this[0]=t[e],this[1]=t[e+1],this[2]=t[e+2],this[3]=t[e+3],this}toArray(t=[],e=0){return t[e]=this[0],t[e+1]=this[1],t[e+2]=this[2],t[e+3]=this[3],t}};var tt=class i extends O{constructor(t,{width:e=1,height:r=1,widthSegments:s=1,heightSegments:n=1,attributes:a={}}={}){let h=s,o=n,l=(h+1)*(o+1),c=h*o*6,f=new Float32Array(l*3),p=new Float32Array(l*3),u=new Float32Array(l*2),d=c>65536?new Uint32Array(c):new Uint16Array(c);i.buildPlane(f,p,u,d,e,r,0,h,o),Object.assign(a,{position:{size:3,data:f},normal:{size:3,data:p},uv:{size:2,data:u},index:{data:d}}),super(t,a)}static buildPlane(t,e,r,s,n,a,h,o,l,c=0,f=1,p=2,u=1,d=-1,x=0,m=0){let g=x,A=n/o,w=a/l;for(let _=0;_<=l;_++){let M=_*w-a/2;for(let y=0;y<=o;y++,x++){let b=y*A-n/2;if(t[x*3+c]=b*u,t[x*3+f]=M*d,t[x*3+p]=h/2,e[x*3+c]=0,e[x*3+f]=0,e[x*3+p]=h>=0?1:-1,r[x*2]=y/o,r[x*2+1]=1-_/l,_===l||y===o)continue;let z=g+y+_*(o+1),R=g+y+(_+1)*(o+1),v=g+y+(_+1)*(o+1)+1,L=g+y+_*(o+1)+1;s[m*6]=z,s[m*6+1]=R,s[m*6+2]=L,s[m*6+3]=R,s[m*6+4]=v,s[m*6+5]=L,m++}}}};var xe=class extends O{constructor(t,{width:e=1,height:r=1,depth:s=1,widthSegments:n=1,heightSegments:a=1,depthSegments:h=1,attributes:o={}}={}){let l=n,c=a,f=h,p=(l+1)*(c+1)*2+(l+1)*(f+1)*2+(c+1)*(f+1)*2,u=(l*c*2+l*f*2+c*f*2)*6,d=new Float32Array(p*3),x=new Float32Array(p*3),m=new Float32Array(p*2),g=p>65536?new Uint32Array(u):new Uint16Array(u),A=0,w=0;tt.buildPlane(d,x,m,g,s,r,e,f,c,2,1,0,-1,-1,A,w),A+=(f+1)*(c+1),w+=f*c,tt.buildPlane(d,x,m,g,s,r,-e,f,c,2,1,0,1,-1,A,w),A+=(f+1)*(c+1),w+=f*c,tt.buildPlane(d,x,m,g,e,s,r,f,l,0,2,1,1,1,A,w),A+=(l+1)*(f+1),w+=l*f,tt.buildPlane(d,x,m,g,e,s,-r,f,l,0,2,1,1,-1,A,w),A+=(l+1)*(f+1),w+=l*f,tt.buildPlane(d,x,m,g,e,r,-s,l,c,0,1,2,-1,-1,A,w),A+=(l+1)*(c+1),w+=l*c,tt.buildPlane(d,x,m,g,e,r,s,l,c,0,1,2,1,-1,A,w),Object.assign(o,{position:{size:3,data:d},normal:{size:3,data:x},uv:{size:2,data:m},index:{data:g}}),super(t,o)}};var ye=class extends O{constructor(t,{radius:e=.5,widthSegments:r=16,heightSegments:s=Math.ceil(r*.5),phiStart:n=0,phiLength:a=Math.PI*2,thetaStart:h=0,thetaLength:o=Math.PI,attributes:l={}}={}){let c=r,f=s,p=n,u=a,d=h,x=o,m=(c+1)*(f+1),g=c*f*6,A=new Float32Array(m*3),w=new Float32Array(m*3),_=new Float32Array(m*2),M=m>65536?new Uint32Array(g):new Uint16Array(g),y=0,b=0,z=0,R=d+x,v=[],L=new E;for(let T=0;T<=f;T++){let S=[],F=T/f;for(let C=0;C<=c;C++,y++){let N=C/c,B=-e*Math.cos(p+N*u)*Math.sin(d+F*x),I=e*Math.cos(d+F*x),W=e*Math.sin(p+N*u)*Math.sin(d+F*x);A[y*3]=B,A[y*3+1]=I,A[y*3+2]=W,L.set(B,I,W).normalize(),w[y*3]=L.x,w[y*3+1]=L.y,w[y*3+2]=L.z,_[y*2]=N,_[y*2+1]=1-F,S.push(b++)}v.push(S)}for(let T=0;T<f;T++)for(let S=0;S<c;S++){let F=v[T][S+1],C=v[T][S],N=v[T+1][S],B=v[T+1][S+1];(T!==0||d>0)&&(M[z*3]=F,M[z*3+1]=C,M[z*3+2]=B,z++),(T!==f-1||R<Math.PI)&&(M[z*3]=C,M[z*3+1]=N,M[z*3+2]=B,z++)}Object.assign(l,{position:{size:3,data:A},normal:{size:3,data:w},uv:{size:2,data:_},index:{data:M}}),super(t,l)}};var we=class extends O{constructor(t,{radiusTop:e=.5,radiusBottom:r=.5,height:s=1,radialSegments:n=8,heightSegments:a=1,openEnded:h=!1,thetaStart:o=0,thetaLength:l=Math.PI*2,attributes:c={}}={}){let f=n,p=a,u=o,d=l,x=h?0:r&&e?2:1,m=(f+1)*(p+1+x)+x,g=f*p*6+x*f*3,A=new Float32Array(m*3),w=new Float32Array(m*3),_=new Float32Array(m*2),M=m>65536?new Uint32Array(g):new Uint16Array(g),y=0,b=0,z=[];R(),h||(e&&v(!0),r&&v(!1));function R(){let L,T,S=new E,F=(r-e)/s;for(T=0;T<=p;T++){let C=[],N=T/p,B=N*(r-e)+e;for(L=0;L<=f;L++){let I=L/f,W=I*d+u,Q=Math.sin(W),J=Math.cos(W);A.set([B*Q,(.5-N)*s,B*J],y*3),S.set(Q,F,J).normalize(),w.set([S.x,S.y,S.z],y*3),_.set([I,1-N],y*2),C.push(y++)}z.push(C)}for(L=0;L<f;L++)for(T=0;T<p;T++){let C=z[T][L],N=z[T+1][L],B=z[T+1][L+1],I=z[T][L+1];M.set([C,N,I,N,B,I],b*3),b+=2}}function v(L){let T,S=L===!0?e:r,F=L===!0?1:-1,C=y;for(A.set([0,.5*s*F,0],y*3),w.set([0,F,0],y*3),_.set([.5,.5],y*2),y++,T=0;T<=f;T++){let B=T/f*d+u,I=Math.cos(B),W=Math.sin(B);A.set([S*W,.5*s*F,S*I],y*3),w.set([0,F,0],y*3),_.set([I*.5+.5,W*.5*F+.5],y*2),y++}for(T=0;T<f;T++){let N=C+T+1;L?M.set([N,N+1,C],b*3):M.set([N+1,N,C],b*3),b++}}Object.assign(c,{position:{size:3,data:A},normal:{size:3,data:w},uv:{size:2,data:_},index:{data:M}}),super(t,c)}};var it=class extends O{constructor(t,{attributes:e={}}={}){Object.assign(e,{position:{size:2,data:new Float32Array([-1,-1,3,-1,-1,3])},uv:{size:2,data:new Float32Array([0,0,2,0,0,2])}}),super(t,e)}};var Me=class extends O{constructor(t,{radius:e=.5,tube:r=.2,radialSegments:s=8,tubularSegments:n=6,arc:a=Math.PI*2,attributes:h={}}={}){let o=(s+1)*(n+1),l=s*n*6,c=new Float32Array(o*3),f=new Float32Array(o*3),p=new Float32Array(o*2),u=o>65536?new Uint32Array(l):new Uint16Array(l),d=new E,x=new E,m=new E,g=0;for(let A=0;A<=s;A++)for(let w=0;w<=n;w++,g++){let _=w/n*a,M=A/s*Math.PI*2;x.x=(e+r*Math.cos(M))*Math.cos(_),x.y=(e+r*Math.cos(M))*Math.sin(_),x.z=r*Math.sin(M),c.set([x.x,x.y,x.z],g*3),d.x=e*Math.cos(_),d.y=e*Math.sin(_),m.sub(x,d).normalize(),f.set([m.x,m.y,m.z],g*3),p.set([w/n,A/s],g*2)}g=0;for(let A=1;A<=s;A++)for(let w=1;w<=n;w++,g++){let _=(n+1)*A+w-1,M=(n+1)*(A-1)+w-1,y=(n+1)*(A-1)+w,b=(n+1)*A+w;u.set([_,M,b,M,y,b],g*6)}Object.assign(h,{position:{size:3,data:c},normal:{size:3,data:f},uv:{size:2,data:p},index:{data:u}}),super(t,h)}};var q={NONE:-1,ROTATE:0,DOLLY:1,PAN:2,DOLLY_PAN:3},st=new E,Z=new X,$=new X;function Is(i,{element:t=document,enabled:e=!0,target:r=new E,ease:s=.25,inertia:n=.85,enableRotate:a=!0,rotateSpeed:h=.1,autoRotate:o=!1,autoRotateSpeed:l=1,enableZoom:c=!0,zoomSpeed:f=1,zoomStyle:p="dolly",enablePan:u=!0,panSpeed:d=.1,minPolarAngle:x=0,maxPolarAngle:m=Math.PI,minAzimuthAngle:g=-1/0,maxAzimuthAngle:A=1/0,minDistance:w=0,maxDistance:_=1/0}={}){this.enabled=e,this.target=r,this.zoomStyle=p,s=s||1,n=n||0,this.minDistance=w,this.maxDistance=_;let M={radius:1,phi:0,theta:0},y={radius:1,phi:0,theta:0},b={radius:1,phi:0,theta:0},z=new E,R=new E;R.copy(i.position).sub(this.target),b.radius=y.radius=R.distance(),b.theta=y.theta=Math.atan2(R.x,R.z),b.phi=y.phi=Math.acos(Math.min(Math.max(R.y/y.radius,-1),1)),this.offset=R,this.update=()=>{o&&W(),y.radius*=M.radius,y.theta+=M.theta,y.phi+=M.phi,y.theta=Math.max(g,Math.min(A,y.theta)),y.phi=Math.max(x,Math.min(m,y.phi)),y.radius=Math.max(this.minDistance,Math.min(this.maxDistance,y.radius)),b.phi+=(y.phi-b.phi)*s,b.theta+=(y.theta-b.theta)*s,b.radius+=(y.radius-b.radius)*s,this.target.add(z);let P=b.radius*Math.sin(Math.max(1e-6,b.phi));R.x=P*Math.sin(b.theta),R.y=b.radius*Math.cos(b.phi),R.z=P*Math.cos(b.theta),i.position.copy(this.target).add(R),i.lookAt(this.target),M.theta*=n,M.phi*=n,z.multiply(n),M.radius=1},this.forcePosition=()=>{R.copy(i.position).sub(this.target),b.radius=y.radius=R.distance(),b.theta=y.theta=Math.atan2(R.x,R.z),b.phi=y.phi=Math.acos(Math.min(Math.max(R.y/y.radius,-1),1)),i.lookAt(this.target)};let v=new X,L=new X,T=new X,S=q.NONE;this.mouseButtons={ORBIT:0,ZOOM:1,PAN:2};function F(){return Math.pow(.95,f)}function C(P,k){st.set(k[0],k[1],k[2]),st.multiply(-P),z.add(st)}function N(P,k){st.set(k[4],k[5],k[6]),st.multiply(P),z.add(st)}let B=(P,k)=>{let Y=t===document?document.body:t;st.copy(i.position).sub(this.target);let at=st.distance();at*=Math.tan((i.fov||45)/2*Math.PI/180),C(2*P*at/Y.clientHeight,i.matrix),N(2*k*at/Y.clientHeight,i.matrix)},I=P=>{this.zoomStyle==="dolly"?M.radius/=P:(i.fov/=P,i.type==="orthographic"?i.orthographic():i.perspective())};function W(){let P=2*Math.PI/60/60*l;M.theta-=P}function Q(P,k){Z.set(P,k),$.sub(Z,v).multiply(h);let Y=t===document?document.body:t;M.theta-=2*Math.PI*$.x/Y.clientHeight,M.phi-=2*Math.PI*$.y/Y.clientHeight,v.copy(Z)}function J(P){Z.set(P.clientX,P.clientY),$.sub(Z,T),$.y>0?I(F()):$.y<0&&I(1/F()),T.copy(Z)}function nt(P,k){Z.set(P,k),$.sub(Z,L).multiply(d),B($.x,$.y),L.copy(Z)}function us(P){if(c){let k=P.touches[0].pageX-P.touches[1].pageX,Y=P.touches[0].pageY-P.touches[1].pageY,at=Math.sqrt(k*k+Y*Y);T.set(0,at)}if(u){let k=.5*(P.touches[0].pageX+P.touches[1].pageX),Y=.5*(P.touches[0].pageY+P.touches[1].pageY);L.set(k,Y)}}function ps(P){if(c){let k=P.touches[0].pageX-P.touches[1].pageX,Y=P.touches[0].pageY-P.touches[1].pageY,at=Math.sqrt(k*k+Y*Y);Z.set(0,at),$.set(0,Math.pow(Z.y/T.y,f)),I($.y),T.copy(Z)}if(u){let k=.5*(P.touches[0].pageX+P.touches[1].pageX),Y=.5*(P.touches[0].pageY+P.touches[1].pageY);nt(k,Y)}}let oi=P=>{if(this.enabled){switch(P.button){case this.mouseButtons.ORBIT:if(a===!1)return;v.set(P.clientX,P.clientY),S=q.ROTATE;break;case this.mouseButtons.ZOOM:if(c===!1)return;T.set(P.clientX,P.clientY),S=q.DOLLY;break;case this.mouseButtons.PAN:if(u===!1)return;L.set(P.clientX,P.clientY),S=q.PAN;break}S!==q.NONE&&(window.addEventListener("mousemove",Yt,!1),window.addEventListener("mouseup",jt,!1))}},Yt=P=>{if(this.enabled)switch(S){case q.ROTATE:if(a===!1)return;Q(P.clientX,P.clientY);break;case q.DOLLY:if(c===!1)return;J(P);break;case q.PAN:if(u===!1)return;nt(P.clientX,P.clientY);break}},jt=()=>{window.removeEventListener("mousemove",Yt,!1),window.removeEventListener("mouseup",jt,!1),S=q.NONE},hi=P=>{!this.enabled||!c||S!==q.NONE&&S!==q.ROTATE||(P.stopPropagation(),P.preventDefault(),P.deltaY<0?I(1/F()):P.deltaY>0&&I(F()))},li=P=>{if(this.enabled)switch(P.preventDefault(),P.touches.length){case 1:if(a===!1)return;v.set(P.touches[0].pageX,P.touches[0].pageY),S=q.ROTATE;break;case 2:if(c===!1&&u===!1)return;us(P),S=q.DOLLY_PAN;break;default:S=q.NONE}},ci=P=>{if(this.enabled)switch(P.preventDefault(),P.stopPropagation(),P.touches.length){case 1:if(a===!1)return;Q(P.touches[0].pageX,P.touches[0].pageY);break;case 2:if(c===!1&&u===!1)return;ps(P);break;default:S=q.NONE}},fi=()=>{this.enabled&&(S=q.NONE)},ui=P=>{this.enabled&&P.preventDefault()};function ds(){t.addEventListener("contextmenu",ui,!1),t.addEventListener("mousedown",oi,!1),t.addEventListener("wheel",hi,{passive:!1}),t.addEventListener("touchstart",li,{passive:!1}),t.addEventListener("touchend",fi,!1),t.addEventListener("touchmove",ci,{passive:!1})}this.remove=function(){t.removeEventListener("contextmenu",ui),t.removeEventListener("mousedown",oi),t.removeEventListener("wheel",hi),t.removeEventListener("touchstart",li),t.removeEventListener("touchend",fi),t.removeEventListener("touchmove",ci),window.removeEventListener("mousemove",Yt),window.removeEventListener("mouseup",jt)},ds()}var Os=new X,Ds=new X,Bs=new X,Ee=new E,Gr=new E,Xr=new E,Vs=new E,Us=new E,ks=new E,Wr=new E,Ae=new E,qr=new E,Yr=new E,Gs=new E,jr=new V,_e=class{constructor(){this.origin=new E,this.direction=new E}castMouse(t,e=[0,0]){if(t.type==="orthographic"){let{left:r,right:s,bottom:n,top:a,zoom:h}=t,o=r/h+(s-r)/h*(e[0]*.5+.5),l=n/h+(a-n)/h*(e[1]*.5+.5);this.origin.set(o,l,0),this.origin.applyMatrix4(t.worldMatrix),this.direction.x=-t.worldMatrix[8],this.direction.y=-t.worldMatrix[9],this.direction.z=-t.worldMatrix[10]}else t.worldMatrix.getTranslation(this.origin),this.direction.set(e[0],e[1],.5),t.unproject(this.direction),this.direction.sub(this.origin).normalize()}intersectBounds(t,{maxDistance:e,output:r=[]}={}){Array.isArray(t)||(t=[t]);let s=jr,n=Ee,a=Gr,h=r;return h.length=0,t.forEach(o=>{(!o.geometry.bounds||o.geometry.bounds.radius===1/0)&&o.geometry.computeBoundingSphere();let l=o.geometry.bounds;s.inverse(o.worldMatrix);let c;if(e&&(a.copy(this.direction).scaleRotateMatrix4(s),c=e*a.len()),n.copy(this.origin).applyMatrix4(s),a.copy(this.direction).transformDirection(s),e&&n.distance(l.center)-l.radius>c)return;let f=0;if(o.geometry.raycast==="sphere"){if(n.distance(l.center)>l.radius&&(f=this.intersectSphere(l,n,a),!f))return}else if((n.x<l.min.x||n.x>l.max.x||n.y<l.min.y||n.y>l.max.y||n.z<l.min.z||n.z>l.max.z)&&(f=this.intersectBox(l,n,a),!f))return;e&&f>c||(o.hit||(o.hit={localPoint:new E,point:new E}),o.hit.localPoint.copy(a).multiply(f).add(n),o.hit.point.copy(o.hit.localPoint).applyMatrix4(o.worldMatrix),o.hit.distance=o.hit.point.distance(this.origin),h.push(o))}),h.sort((o,l)=>o.hit.distance-l.hit.distance),h}intersectMeshes(t,{cullFace:e=!0,maxDistance:r,includeUV:s=!0,includeNormal:n=!0,output:a=[]}={}){let h=this.intersectBounds(t,{maxDistance:r,output:a});if(!h.length)return h;let o=jr,l=Ee,c=Gr,f=Xr,p=Vs,u=Us,d=ks,x=Wr,m=Ae,g=Os,A=Ds,w=Bs;for(let _=h.length-1;_>=0;_--){let M=h[_];o.inverse(M.worldMatrix);let y;r&&(c.copy(this.direction).scaleRotateMatrix4(o),y=r*c.len()),l.copy(this.origin).applyMatrix4(o),c.copy(this.direction).transformDirection(o);let b=0,z,R,v,L=M.geometry,T=L.attributes,S=T.index,F=T.position,C=Math.max(0,L.drawRange.start),N=Math.min(S?S.count:F.count,L.drawRange.start+L.drawRange.count),B=F.size;for(let I=C;I<N;I+=3){let W=S?S.data[I]:I,Q=S?S.data[I+1]:I+1,J=S?S.data[I+2]:I+2;f.fromArray(F.data,W*B),p.fromArray(F.data,Q*B),u.fromArray(F.data,J*B);let nt=this.intersectTriangle(f,p,u,e,l,c,x);nt&&(r&&nt>y||(!b||nt<b)&&(b=nt,z=W,R=Q,v=J,d.copy(x)))}b||h.splice(_,1),M.hit.localPoint.copy(c).multiply(b).add(l),M.hit.point.copy(M.hit.localPoint).applyMatrix4(M.worldMatrix),M.hit.distance=M.hit.point.distance(this.origin),M.hit.faceNormal||(M.hit.localFaceNormal=new E,M.hit.faceNormal=new E,M.hit.uv=new X,M.hit.localNormal=new E,M.hit.normal=new E),M.hit.localFaceNormal.copy(d),M.hit.faceNormal.copy(M.hit.localFaceNormal).transformDirection(M.worldMatrix),(s||n)&&(f.fromArray(F.data,z*3),p.fromArray(F.data,R*3),u.fromArray(F.data,v*3),this.getBarycoord(M.hit.localPoint,f,p,u,m)),s&&T.uv&&(g.fromArray(T.uv.data,z*2),A.fromArray(T.uv.data,R*2),w.fromArray(T.uv.data,v*2),M.hit.uv.set(g.x*m.x+A.x*m.y+w.x*m.z,g.y*m.x+A.y*m.y+w.y*m.z)),n&&T.normal&&(f.fromArray(T.normal.data,z*3),p.fromArray(T.normal.data,R*3),u.fromArray(T.normal.data,v*3),M.hit.localNormal.set(f.x*m.x+p.x*m.y+u.x*m.z,f.y*m.x+p.y*m.y+u.y*m.z,f.z*m.x+p.z*m.y+u.z*m.z),M.hit.normal.copy(M.hit.localNormal).transformDirection(M.worldMatrix))}return h.sort((_,M)=>_.hit.distance-M.hit.distance),h}intersectPlane(t,e=this.origin,r=this.direction){let s=Ee;s.sub(t.origin,e);let n=s.dot(t.normal),a=r.dot(t.normal);if(a==0)return 0;let h=n/a;return h<=0?0:e.add(r.scale(h))}intersectSphere(t,e=this.origin,r=this.direction){let s=Xr;s.sub(t.center,e);let n=s.dot(r),a=s.dot(s)-n*n,h=t.radius*t.radius;if(a>h)return 0;let o=Math.sqrt(h-a),l=n-o,c=n+o;return l<0&&c<0?0:l<0?c:l}intersectBox(t,e=this.origin,r=this.direction){let s,n,a,h,o,l,c=1/r.x,f=1/r.y,p=1/r.z,u=t.min,d=t.max;return s=((c>=0?u.x:d.x)-e.x)*c,n=((c>=0?d.x:u.x)-e.x)*c,a=((f>=0?u.y:d.y)-e.y)*f,h=((f>=0?d.y:u.y)-e.y)*f,s>h||a>n||(a>s&&(s=a),h<n&&(n=h),o=((p>=0?u.z:d.z)-e.z)*p,l=((p>=0?d.z:u.z)-e.z)*p,s>l||o>n)||(o>s&&(s=o),l<n&&(n=l),n<0)?0:s>=0?s:n}intersectTriangle(t,e,r,s=!0,n=this.origin,a=this.direction,h=Wr){let o=Ae,l=qr,c=Yr;o.sub(e,t),l.sub(r,t),h.cross(o,l);let f=a.dot(h);if(!f)return 0;let p;if(f>0){if(s)return 0;p=1}else p=-1,f=-f;c.sub(n,t);let u=p*a.dot(l.cross(c,l));if(u<0)return 0;let d=p*a.dot(o.cross(c));if(d<0||u+d>f)return 0;let x=-p*c.dot(h);return x<0?0:x/f}getBarycoord(t,e,r,s,n=Ae){let a=qr,h=Yr,o=Gs;a.sub(s,e),h.sub(r,e),o.sub(t,e);let l=a.dot(a),c=a.dot(h),f=a.dot(o),p=h.dot(h),u=h.dot(o),d=l*p-c*c;if(d===0)return n.set(-2,-1,-1);let x=1/d,m=(p*f-c*u)*x,g=(l*u-c*f)*x;return n.set(1-m-g,g,m)}};var ve="catmullrom",be="cubicbezier",Zr="quadraticbezier",ct=new E,ft=new E,Vt=new E,Hr=new E;function Xs(i,t,e=.168,r=.168){if(t<1?ct.sub(i[1],i[0]).scale(e).add(i[0]):ct.sub(i[t+1],i[t-1]).scale(e).add(i[t]),t>i.length-3){let s=i.length-1;ft.sub(i[s-1],i[s]).scale(r).add(i[s])}else ft.sub(i[t],i[t+2]).scale(r).add(i[t+1]);return[ct.clone(),ft.clone()]}function Qr(i,t,e,r){let s=1-i;ct.copy(t).scale(s**2),ft.copy(e).scale(2*s*i),Vt.copy(r).scale(i**2);let n=new E;return n.add(ct,ft).add(Vt),n}function Kr(i,t,e,r,s){let n=1-i;ct.copy(t).scale(n**3),ft.copy(e).scale(3*n**2*i),Vt.copy(r).scale(3*n*i**2),Hr.copy(s).scale(i**3);let a=new E;return a.add(ct,ft).add(Vt).add(Hr),a}var dt=class i{constructor({points:t=[new E(0,0,0),new E(0,1,0),new E(1,1,0),new E(1,0,0)],divisions:e=12,type:r=ve}={}){this.points=t,this.divisions=e,this.type=r}_getQuadraticBezierPoints(t=this.divisions){let e=[],r=this.points.length;if(r<3)return console.warn("Not enough points provided."),[];let s=this.points[0],n=this.points[1],a=this.points[2];for(let o=0;o<=t;o++){let l=Qr(o/t,s,n,a);e.push(l)}let h=3;for(;r-h>0;){s.copy(a),n=a.scale(2).sub(n),a=this.points[h];for(let o=1;o<=t;o++){let l=Qr(o/t,s,n,a);e.push(l)}h++}return e}_getCubicBezierPoints(t=this.divisions){let e=[],r=this.points.length;if(r<4)return console.warn("Not enough points provided."),[];let s=this.points[0],n=this.points[1],a=this.points[2],h=this.points[3];for(let l=0;l<=t;l++){let c=Kr(l/t,s,n,a,h);e.push(c)}let o=4;for(;r-o>1;){s.copy(h),n=h.scale(2).sub(a),a=this.points[o],h=this.points[o+1];for(let l=1;l<=t;l++){let c=Kr(l/t,s,n,a,h);e.push(c)}o+=2}return e}_getCatmullRomPoints(t=this.divisions,e=.168,r=.168){let s=[];if(this.points.length<=2)return this.points;let a;return this.points.forEach((h,o)=>{if(o===0)a=h;else{let[l,c]=Xs(this.points,o-1,e,r),f=new i({points:[a,l,c,h],type:be});s.pop(),s.push(...f.getPoints(t)),a=h}}),s}getPoints(t=this.divisions,e=.168,r=.168){let s=this.type;return s===Zr?this._getQuadraticBezierPoints(t):s===be?this._getCubicBezierPoints(t):s===ve?this._getCatmullRomPoints(t,e,r):this.points}};dt.CATMULLROM=ve;dt.CUBICBEZIER=be;dt.QUADRATICBEZIER=Zr;var rt=class{constructor(){this._len=-1,this.tiltStart=0,this.tiltEnd=0}getLength(){return this._len<0&&this.updateLength(),this._len}getTiltAt(t){return this.tiltStart*(1-t)*this.tiltEnd*t}clone(){return new this.constructor().copy(this)}copy(t){return this._len=t._len,this.tiltStart=t.tiltStart,this.tiltEnd=t.tiltEnd,this}};var mt=[-.06405689286260563,.06405689286260563,-.1911188674736163,.1911188674736163,-.3150426796961634,.3150426796961634,-.4337935076260451,.4337935076260451,-.5454214713888396,.5454214713888396,-.6480936519369755,.6480936519369755,-.7401241915785544,.7401241915785544,-.820001985973903,.820001985973903,-.8864155270044011,.8864155270044011,-.9382745520027328,.9382745520027328,-.9747285559713095,.9747285559713095,-.9951872199970213,.9951872199970213],Ut=[.12793819534675216,.12793819534675216,.1258374563468283,.1258374563468283,.12167047292780339,.12167047292780339,.1155056680537256,.1155056680537256,.10744427011596563,.10744427011596563,.09761865210411388,.09761865210411388,.08619016153195327,.08619016153195327,.0733464814110803,.0733464814110803,.05929858491543678,.05929858491543678,.04427743881741981,.04427743881741981,.028531388628933663,.028531388628933663,.0123412297999872,.0123412297999872],$r=i=>i*Math.PI/180,Jr=i=>180*i/Math.PI,kt=(i,t,e)=>Math.max(t,Math.min(i,e));function ts(i,t,e,r){let s=t[0],n=t[1],a=t[2],h=1-r;return i[0]=s*s*h+r,i[1]=n*s*h+a*e,i[2]=a*s*h-n*e,i[3]=0,i[4]=s*n*h-a*e,i[5]=n*n*h+r,i[6]=a*n*h+s*e,i[7]=0,i[8]=s*a*h+n*e,i[9]=n*a*h-s*e,i[10]=a*a*h+r,i[11]=0,i[12]=0,i[13]=0,i[14]=0,i[15]=1,i}function Fe(i,t,e,r=t,s=e){let n=Math.sin(i),a=Math.cos(i),h=a*t.x+n*e.x,o=a*t.y+n*e.y,l=a*t.z+n*e.z,c=a*e.x-n*t.x,f=a*e.y-n*t.y,p=a*e.z-n*t.z;r.set(h,o,l),s.set(c,f,p)}var Ws=new E;function Te(i,t,e,r,s){let n=1-i;return n*n*n*t+3*n*n*i*e+3*n*i*i*r+i*i*i*s}function Re(i,t,e,r,s){let n=1-i;return 3*n*n*(e-t)+6*n*i*(r-e)+3*i*i*(s-r)}var wt=class extends rt{constructor(t,e,r,s,n=0,a=0){super(),this.p0=t,this.p1=e,this.p2=r,this.p3=s,this.tiltStart=n,this.tiltEnd=a,this._len=-1}updateLength(){let e=mt.length,r=0;for(let s=0,n;s<e;s++)n=.5*mt[s]+.5,r+=Ut[s]*this.getDerivativeAt(n,Ws).len();this._len=.5*r}getPointAt(t,e=new E){return e.x=Te(t,this.p0.x,this.p1.x,this.p2.x,this.p3.x),e.y=Te(t,this.p0.y,this.p1.y,this.p2.y,this.p3.y),e.z=Te(t,this.p0.z,this.p1.z,this.p2.z,this.p3.z),e}getDerivativeAt(t,e=new E){return e.x=Re(t,this.p0.x,this.p1.x,this.p2.x,this.p3.x),e.y=Re(t,this.p0.y,this.p1.y,this.p2.y,this.p3.y),e.z=Re(t,this.p0.z,this.p1.z,this.p2.z,this.p3.z),e}getTangentAt(t,e=new E){return this.getDerivativeAt(t,e).normalize()}lastPoint(){return this.p3}};var qs=new E;function ze(i,t,e,r){let s=1-i;return s*s*t+2*s*i*e+i*i*r}function Le(i,t,e,r){return 2*(1-i)*(e-t)+2*i*(r-e)}var Mt=class extends rt{constructor(t,e,r,s=0,n=0){super(),this.p0=t,this.p1=e,this.p2=r,this.tiltStart=s,this.tiltEnd=n,this._len=-1}updateLength(){let e=mt.length,r=0;for(let s=0,n;s<e;s++)n=.5*mt[s]+.5,r+=Ut[s]*this.getDerivativeAt(n,qs).len();this._len=.5*r}getPointAt(t,e=new E){return e.x=ze(t,this.p0.x,this.p1.x,this.p2.x),e.y=ze(t,this.p0.y,this.p1.y,this.p2.y),e.z=ze(t,this.p0.z,this.p1.z,this.p2.z),e}getDerivativeAt(t,e=new E){return e.x=Le(t,this.p0.x,this.p1.x,this.p2.x),e.y=Le(t,this.p0.y,this.p1.y,this.p2.y),e.z=Le(t,this.p0.z,this.p1.z,this.p2.z),e}getTangentAt(t,e=new E){return this.getDerivativeAt(t,e).normalize()}lastPoint(){return this.p2}};var Ys=new E,Et=class extends rt{constructor(t,e,r=0,s=0){super(),this.p0=t,this.p1=e,this.tiltStart=r,this.tiltEnd=s,this._len=-1}updateLength(){this._len=Ys.sub(this.p1,this.p0).len()}getPointAt(t,e=new E){return Ct(e,this.p0,this.p1,t),e}getTangentAt(t,e=new E){return e.sub(this.p1,this.p0).normalize()}lastPoint(){return this.p1}};var ut=new E,es=new V;function js(i,t){if(this[i]==null)throw new Error(t)}var Se=class{constructor(){this._segments=[],this._lengthOffsets=null,this._totalLength=-1,this._lastPoint=null,this._lastTilt=0,this._assertLastPoint=js.bind(this,"_lastPoint","Can`t get previous point of curve. Did you forget moveTo command?"),this.tiltFunction=null}moveTo(t,e=0){this._totalLength=-1,this._lastPoint=t,this._lastTilt=e}bezierCurveTo(t,e,r,s=0){this._assertLastPoint();let n=new wt(this._lastPoint,t,e,r,this._lastTilt,s);return this.addSegment(n),this}quadraticCurveTo(t,e,r=0){this._assertLastPoint();let s=new Mt(this._lastPoint,t,e,this._lastTilt,r);return this.addSegment(s),this}lineTo(t,e=0){this._assertLastPoint();let r=new Et(this._lastPoint,t,this._lastTilt,e);return this.addSegment(r),this}addSegment(t){return this._totalLength=-1,this._lastPoint=t.lastPoint(),this._lastTilt=t.tiltEnd,this._segments.push(t),this}getSegments(){return this._segments}updateLength(){let t=this._segments.length;this._lengthOffsets=new Array(t);let e=0;for(let r=0;r<t;r++)this._lengthOffsets[r]=e,e+=this._segments[r].getLength();this._totalLength=e}getLength(){return this._totalLength<0&&this.updateLength(),this._totalLength}findSegmentIndexAtLength(t){let e=this.getLength();if(t<=0)return[0,0];if(t>=e)return[this._segments.length-1,1];let r=0,s=this._lengthOffsets.length-1,n=-1,a;for(;r<=s;)if(a=Math.ceil((r+s)/2),a===0||a===this._lengthOffsets.length-1||t>=this._lengthOffsets[a]&&t<this._lengthOffsets[a+1]){n=a;break}else t<this._lengthOffsets[a]?s=a-1:r=a+1;let o=this._segments[n].getLength(),l=(t-this._lengthOffsets[n])/o;return[n,l]}getPointAtLength(t,e=new E){let[r,s]=this.findSegmentIndexAtLength(t);return this._segments[r].getPointAt(s,e)}getPointAt(t,e=new E){let r=this.getLength();return this.getPointAtLength(t*r,e)}getTangentAtLength(t,e=new E){let[r,s]=this.findSegmentIndexAtLength(t);return this._segments[r].getTangentAt(s,e)}getTangentAt(t,e=new E){let r=this.getLength();return this.getTangentAtLength(t*r,e)}getTiltAtLength(t){let[e,r]=this.findSegmentIndexAtLength(t);return this._segments[e].getTiltAt(r)}getTiltAt(t){let e=this.getLength();return this.getTiltAtLength(t*e)}getPoints(t=64){let e=new Array(t+1);for(let r=0;r<=t;r++)e[r]=this.getPointAt(r/t);return e}computeFrenetFrames(t=64,e=!1){let r=new Array(t+1),s=new Array(t+1),n=this.tiltFunction??(u=>u),a=this.getLength();for(let u=0;u<=t;u++){let[d,x]=this.findSegmentIndexAtLength(a*u/t),m=this._segments[d];r[u]=m.getTangentAt(x),s[u]=n(m.getTiltAt(x),u/t,this)}let h=Math.abs(r[0].x),o=Math.abs(r[0].y),l=Math.abs(r[0].z),c=new E;h<o&&h<l?c.set(1,0,0):o<h&&o<l?c.set(0,1,0):c.set(0,0,1);let f=new Array(t+1),p=new Array(t+1);f[0]=new E,p[0]=new E,ut.cross(r[0],c).normalize(),f[0].cross(r[0],ut),p[0].cross(r[0],f[0]);for(let u=1;u<r.length;u++){f[u]=f[u-1].clone(),p[u]=new E,ut.cross(r[u-1],r[u]);let d=ut.len();if(d>Number.EPSILON){ut.scale(1/d);let x=kt(r[u-1].dot(r[u]),-1,1),m=kt(d,-1,1);ts(es,ut,m,x),f[u].applyMatrix4(es)}p[u].cross(r[u],f[u])}for(let u=0;u<s.length;u++)Fe($r(s[u]),f[u],p[u]);if(e===!0){let u=f[f.length-1],d=Math.acos(kt(f[0].dot(u),-1,1))/(f.length-1);r[0].dot(ut.cross(f[0],u))>0&&(d=-d);for(let x=1;x<f.length-1;x++){let m=d*x;Fe(m,f[x],p[x]),s[x]+=Jr(m)}f[f.length-1]=f[0].clone(),p[p.length-1]=p[0].clone()}return{tangents:r,normals:f,binormals:p,tilts:s}}};var Gt=new E,pt=new E,Pe=new X,Xt=new E,Ce=class extends O{constructor(t,{path:e,radius:r=1,tubularSegments:s=64,radialSegments:n=8,closed:a=!1,attributes:h={}}={}){super(t,h),this.path=e,this.radius=r,this.tubularSegments=s,this.radialSegments=n,this.closed=a,this.frenetFrames=e.computeFrenetFrames(s,a);let o=(s+1)*(n+1),l=s*n*6;this.positions=new Float32Array(o*3),this.normals=new Float32Array(o*3),this.uvs=new Float32Array(o*2),this.indices=o>65536?new Uint32Array(l):new Uint16Array(l),this._generateAttributes(),this._generateIndices(),this.addAttribute("position",{size:3,data:this.positions}),this.addAttribute("normal",{size:3,data:this.normals}),this.addAttribute("uv",{size:2,data:this.uvs}),this.setIndex({data:this.indices})}_generateAttributes(){for(let t=0;t<=this.tubularSegments;t++){let e=t;t===this.tubularSegments&&(e=this.closed?0:this.tubularSegments),this.path.getPointAt(e/this.tubularSegments,Xt);let r=this.frenetFrames.normals[e],s=this.frenetFrames.binormals[e];for(let n=0;n<=this.radialSegments;n++){let a=n/this.radialSegments*Math.PI*2,h=Math.sin(a),o=-Math.cos(a),l=t*(this.radialSegments+1)+n;pt.x=o*r.x+h*s.x,pt.y=o*r.y+h*s.y,pt.z=o*r.z+h*s.z,this.normals.set(pt,l*3),Gt.x=Xt.x+this.radius*pt.x,Gt.y=Xt.y+this.radius*pt.y,Gt.z=Xt.z+this.radius*pt.z,this.positions.set(Gt,l*3),Pe.x=t/this.tubularSegments,Pe.y=n/this.radialSegments,this.uvs.set(Pe,l*2)}}}_generateIndices(){for(let t=1;t<=this.tubularSegments;t++)for(let e=1;e<=this.radialSegments;e++){let r=(this.radialSegments+1)*(t-1)+(e-1),s=(this.radialSegments+1)*t+(e-1),n=(this.radialSegments+1)*t+e,a=(this.radialSegments+1)*(t-1)+e,h=(t-1)*this.radialSegments+(e-1);this.indices.set([r,s,a,s,n,a],h*6)}}};var Ne=class{constructor(t,{width:e,height:r,dpr:s,wrapS:n=t.CLAMP_TO_EDGE,wrapT:a=t.CLAMP_TO_EDGE,minFilter:h=t.LINEAR,magFilter:o=t.LINEAR,geometry:l=new it(t),targetOnly:c=null,depth:f=!0}={}){this.gl=t,this.passes=[],this.geometry=l,this.uniform={value:null},this.targetOnly=c,s&&(this.dpr=s),e&&(this.width=e),r&&(this.height=r),s=this.dpr||this.gl.renderer.dpr,this.resolutionWidth=Math.floor(this.width||this.gl.renderer.width*s),this.resolutionHeight=Math.floor(this.height||this.gl.renderer.height*s);let p={dpr:this.dpr,width:this.resolutionWidth,height:this.resolutionHeight,wrapS:n,wrapT:a,minFilter:h,magFilter:o,depth:f},u=this.fbo={read:new j(this.gl,p),write:new j(this.gl,p),swap:()=>{let d=u.read;u.read=u.write,u.write=d}}}addPass({vertex:t=Hs,fragment:e=Qs,uniforms:r={},textureUniform:s="tMap",enabled:n=!0}={}){r[s]={value:this.fbo.read.texture};let a=new U(this.gl,{vertex:t,fragment:e,uniforms:r}),o={mesh:new D(this.gl,{geometry:this.geometry,program:a}),program:a,uniforms:r,enabled:n,textureUniform:s};return this.passes.push(o),o}resize({width:t,height:e,dpr:r}={}){r&&(this.dpr=r),t&&(this.width=t),e&&(this.height=e),r=this.dpr||this.gl.renderer.dpr,this.resolutionWidth=Math.floor(this.width||this.gl.renderer.width*r),this.resolutionHeight=Math.floor(this.height||this.gl.renderer.height*r),this.fbo.read.setSize(this.resolutionWidth,this.resolutionHeight),this.fbo.write.setSize(this.resolutionWidth,this.resolutionHeight)}render({scene:t,camera:e,texture:r,target:s=null,update:n=!0,sort:a=!0,frustumCull:h=!0,beforePostCallbacks:o}){let l=this.passes.filter(c=>c.enabled);r||(this.gl.renderer.render({scene:t,camera:e,target:l.length||!s&&this.targetOnly?this.fbo.write:s,update:n,sort:a,frustumCull:h}),this.fbo.swap(),o&&o.forEach(c=>c&&c())),l.forEach((c,f)=>{c.mesh.program.uniforms[c.textureUniform].value=!f&&r?r:this.fbo.read.texture,this.gl.renderer.render({scene:c.mesh,target:f===l.length-1&&(s||!this.targetOnly)?s:this.fbo.write,clear:!0}),this.fbo.swap()}),this.uniform.value=this.fbo.read.texture}},Hs=`
    attribute vec2 uv;
    attribute vec2 position;

    varying vec2 vUv;

    void main() {
        vUv = uv;
        gl_Position = vec4(position, 0, 1);
    }
`,Qs=`
    precision highp float;

    uniform sampler2D tMap;
    varying vec2 vUv;

    void main() {
        gl_FragColor = texture2D(tMap, vUv);
    }
`;var Ie=new E,Oe=new K,De=new E,is=new E,rs=new K,ss=new E,At=class{constructor({objects:t,data:e}){this.objects=t,this.data=e,this.elapsed=0,this.weight=1,this.duration=e.frames.length-1}update(t=1,e){let r=e?1:this.weight/t,s=this.elapsed%this.duration,n=Math.floor(s),a=s-n,h=this.data.frames[n],o=this.data.frames[(n+1)%this.duration];this.objects.forEach((l,c)=>{Ie.fromArray(h.position,c*3),Oe.fromArray(h.quaternion,c*4),De.fromArray(h.scale,c*3),is.fromArray(o.position,c*3),rs.fromArray(o.quaternion,c*4),ss.fromArray(o.scale,c*3),Ie.lerp(is,a),Oe.slerp(rs,a),De.lerp(ss,a),l.position.lerp(Ie,r),l.quaternion.slerp(Oe,r),l.scale.lerp(De,r)})}};var ns=new V,Be=class extends D{constructor(t,{rig:e,geometry:r,program:s,mode:n=t.TRIANGLES}={}){super(t,{geometry:r,program:s,mode:n}),this.createBones(e),this.createBoneTexture(),this.animations=[],Object.assign(this.program.uniforms,{boneTexture:{value:this.boneTexture},boneTextureSize:{value:this.boneTextureSize}})}createBones(t){if(this.root=new H,this.bones=[],!(!t.bones||!t.bones.length)){for(let e=0;e<t.bones.length;e++){let r=new H;r.position.fromArray(t.bindPose.position,e*3),r.quaternion.fromArray(t.bindPose.quaternion,e*4),r.scale.fromArray(t.bindPose.scale,e*3),this.bones.push(r)}t.bones.forEach((e,r)=>{if(this.bones[r].name=e.name,e.parent===-1)return this.bones[r].setParent(this.root);this.bones[r].setParent(this.bones[e.parent])}),this.root.updateMatrixWorld(!0),this.bones.forEach(e=>{e.bindInverse=new V(...e.worldMatrix).inverse()})}}createBoneTexture(){if(!this.bones.length)return;let t=Math.max(4,Math.pow(2,Math.ceil(Math.log(Math.sqrt(this.bones.length*4))/Math.LN2)));this.boneMatrices=new Float32Array(t*t*4),this.boneTextureSize=t,this.boneTexture=new G(this.gl,{image:this.boneMatrices,generateMipmaps:!1,type:this.gl.FLOAT,internalFormat:this.gl.renderer.isWebgl2?this.gl.RGBA32F:this.gl.RGBA,minFilter:this.gl.NEAREST,magFilter:this.gl.NEAREST,flipY:!1,width:t})}addAnimation(t){let e=new At({objects:this.bones,data:t});return this.animations.push(e),e}update(){let t=0;this.animations.forEach(e=>t+=e.weight),this.animations.forEach((e,r)=>{e.update(t,r===0)})}draw({camera:t}={}){this.root.updateMatrixWorld(!0),this.bones.forEach((e,r)=>{ns.multiply(e.worldMatrix,e.bindInverse),this.boneMatrices.set(ns,r*16)}),this.boneTexture&&(this.boneTexture.needsUpdate=!0),super.draw({camera:t})}};function Ks({font:i,text:t,width:e=1/0,align:r="left",size:s=1,letterSpacing:n=0,lineHeight:a=1.4,wordSpacing:h=0,wordBreak:o=!1}){let l=this,c,f,p,u,d,x=/\n/,m=/\s/;g(),A();function g(){c={},i.chars.forEach(y=>c[y.char]=y)}function A(){p=i.common.lineHeight,u=i.common.base,d=s/u;let b=t.replace(/[ \n]/g,"").length;f={position:new Float32Array(b*4*3),uv:new Float32Array(b*4*2),id:new Float32Array(b*4),index:new Uint16Array(b*6)};for(let z=0;z<b;z++)f.id.set([z,z,z,z],z*4),f.index.set([z*4,z*4+2,z*4+1,z*4+1,z*4+2,z*4+3],z*6);w()}function w(){let y=[],b=0,z=0,R=0,v=L();function L(){let F={width:0,glyphs:[]};return y.push(F),z=b,R=0,F}let T=100,S=0;for(;b<t.length&&S<T;){S++;let F=t[b];if(!v.width&&m.test(F)){b++,z=b,R=0;continue}if(x.test(F)){b++,v=L();continue}let C=c[F]||c[" "];if(v.glyphs.length){let B=v.glyphs[v.glyphs.length-1][0],I=M(C.id,B.id)*d;v.width+=I,R+=I}v.glyphs.push([C,v.width]);let N=0;if(m.test(F)?(z=b,R=0,N+=h*s):N+=n*s,N+=C.xadvance*d,v.width+=N,R+=N,v.width>e){if(o&&v.glyphs.length>1){v.width-=N,v.glyphs.pop(),v=L();continue}else if(!o&&R!==v.width){let B=b-z+1;v.glyphs.splice(-B,B),b=z,v.width-=R,v=L();continue}}b++,S=0}v.width||y.pop(),_(y)}function _(y){let b=i.common.scaleW,z=i.common.scaleH,R=.07*s,v=0;for(let L=0;L<y.length;L++){let T=y[L];for(let S=0;S<T.glyphs.length;S++){let F=T.glyphs[S][0],C=T.glyphs[S][1];if(r==="center"?C-=T.width*.5:r==="right"&&(C-=T.width),m.test(F.char))continue;C+=F.xoffset*d,R-=F.yoffset*d;let N=F.width*d,B=F.height*d;f.position.set([C,R-B,0,C,R,0,C+N,R-B,0,C+N,R,0],v*4*3);let I=F.x/b,W=F.width/b,Q=1-F.y/z,J=F.height/z;f.uv.set([I,Q-J,I,Q,I+W,Q-J,I+W,Q],v*4*2),R+=F.yoffset*d,v++}R-=s*a}l.buffers=f,l.numLines=y.length,l.height=l.numLines*s*a,l.width=Math.max(...y.map(L=>L.width))}function M(y,b){for(let z=0;z<i.kernings.length;z++){let R=i.kernings[z];if(!(R.first<y)&&!(R.second<b))return R.first>y||R.first===y&&R.second>b?0:R.amount}return 0}this.resize=function(y){({width:e}=y),w()},this.update=function(y){({text:t}=y),A()}}var Zs=`
    precision highp float;
    precision highp int;

    attribute vec3 position;
    attribute vec3 normal;

    uniform mat3 normalMatrix;
    uniform mat4 modelViewMatrix;
    uniform mat4 projectionMatrix;

    varying vec3 vNormal;

    void main() {
        vNormal = normalize(normalMatrix * normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
`,$s=`
    precision highp float;
    precision highp int;

    varying vec3 vNormal;

    void main() {
        gl_FragColor.rgb = normalize(vNormal);
        gl_FragColor.a = 1.0;
    }
`;function Ve(i){return new U(i,{vertex:Zs,fragment:$s,cullFace:!1})}var Ue=class{constructor(t,{size:e=128,falloff:r=.3,alpha:s=1,dissipation:n=.98,type:a}={}){let h=this;this.gl=t,this.uniform={value:null},this.mask={read:null,write:null,swap:()=>{let c=h.mask.read;h.mask.read=h.mask.write,h.mask.write=c,h.uniform.value=h.mask.read.texture}},o(),this.aspect=1,this.mouse=new X,this.velocity=new X,this.mesh=l();function o(){a||(a=t.HALF_FLOAT||t.renderer.extensions.OES_texture_half_float.HALF_FLOAT_OES);let c=t.renderer.isWebgl2||t.renderer.extensions[`OES_texture_${a===t.FLOAT?"":"half_"}float_linear`]?t.LINEAR:t.NEAREST,f={width:e,height:e,type:a,format:t.RGBA,internalFormat:t.renderer.isWebgl2?a===t.FLOAT?t.RGBA32F:t.RGBA16F:t.RGBA,minFilter:c,depth:!1};h.mask.read=new j(t,f),h.mask.write=new j(t,f),h.mask.swap()}function l(){return new D(t,{geometry:new it(t),program:new U(t,{vertex:Js,fragment:tn,uniforms:{tMap:h.uniform,uFalloff:{value:r*.5},uAlpha:{value:s},uDissipation:{value:n},uAspect:{value:1},uMouse:{value:h.mouse},uVelocity:{value:h.velocity}},depthTest:!1})})}}update(){this.mesh.program.uniforms.uAspect.value=this.aspect,this.gl.renderer.render({scene:this.mesh,target:this.mask.write,clear:!1}),this.mask.swap()}},Js=`
    attribute vec2 uv;
    attribute vec2 position;

    varying vec2 vUv;

    void main() {
        vUv = uv;
        gl_Position = vec4(position, 0, 1);
    }
`,tn=`
    precision highp float;

    uniform sampler2D tMap;

    uniform float uFalloff;
    uniform float uAlpha;
    uniform float uDissipation;
    
    uniform float uAspect;
    uniform vec2 uMouse;
    uniform vec2 uVelocity;

    varying vec2 vUv;

    void main() {
        vec4 color = texture2D(tMap, vUv) * uDissipation;

        vec2 cursor = vUv - uMouse;
        cursor.x *= uAspect;

        vec3 stamp = vec3(uVelocity * vec2(1, -1), 1.0 - pow(1.0 - min(1.0, length(uVelocity)), 3.0));
        float falloff = smoothstep(uFalloff, 0.0, length(cursor)) * uAlpha;

        color.rgb = mix(color.rgb, stamp, vec3(falloff));

        gl_FragColor = color;
    }
`;var ke=class{constructor(t,{data:e=new Float32Array(16),geometry:r=new it(t),type:s}){this.gl=t;let n=e;this.passes=[],this.geometry=r,this.dataLength=n.length/4,this.size=Math.pow(2,Math.ceil(Math.log(Math.ceil(Math.sqrt(this.dataLength)))/Math.LN2)),this.coords=new Float32Array(this.dataLength*2);for(let o=0;o<this.dataLength;o++){let l=o%this.size/this.size,c=Math.floor(o/this.size)/this.size;this.coords.set([l,c],o*2)}let a=(()=>{if(n.length===this.size*this.size*4)return n;{let o=new Float32Array(this.size*this.size*4);return o.set(n),o}})();this.uniform={value:new G(t,{image:a,target:t.TEXTURE_2D,type:t.FLOAT,format:t.RGBA,internalFormat:t.renderer.isWebgl2?t.RGBA32F:t.RGBA,wrapS:t.CLAMP_TO_EDGE,wrapT:t.CLAMP_TO_EDGE,generateMipmaps:!1,minFilter:t.NEAREST,magFilter:t.NEAREST,width:this.size,flipY:!1})};let h={width:this.size,height:this.size,type:s||t.HALF_FLOAT||t.renderer.extensions.OES_texture_half_float.HALF_FLOAT_OES,format:t.RGBA,internalFormat:t.renderer.isWebgl2?s===t.FLOAT?t.RGBA32F:t.RGBA16F:t.RGBA,minFilter:t.NEAREST,depth:!1,unpackAlignment:1};this.fbo={read:new j(t,h),write:new j(t,h),swap:()=>{let o=this.fbo.read;this.fbo.read=this.fbo.write,this.fbo.write=o,this.uniform.value=this.fbo.read.texture}}}addPass({vertex:t=en,fragment:e=rn,uniforms:r={},textureUniform:s="tMap",enabled:n=!0}={}){r[s]=this.uniform;let a=new U(this.gl,{vertex:t,fragment:e,uniforms:r}),o={mesh:new D(this.gl,{geometry:this.geometry,program:a}),program:a,uniforms:r,enabled:n,textureUniform:s};return this.passes.push(o),o}render(){this.passes.filter(e=>e.enabled).forEach((e,r)=>{this.gl.renderer.render({scene:e.mesh,target:this.fbo.write,clear:!1}),this.fbo.swap()})}},en=`
    attribute vec2 uv;
    attribute vec2 position;

    varying vec2 vUv;

    void main() {
        vUv = uv;
        gl_Position = vec4(position, 0, 1);
    }
`,rn=`
    precision highp float;

    uniform sampler2D tMap;
    varying vec2 vUv;

    void main() {
        gl_FragColor = texture2D(tMap, vUv);
    }
`;var gt=new E,Ge=class{constructor(t,{points:e,vertex:r=sn,fragment:s=nn,uniforms:n={},attributes:a={}}){this.gl=t,this.points=e,this.count=e.length,this.position=new Float32Array(this.count*3*2),this.prev=new Float32Array(this.count*3*2),this.next=new Float32Array(this.count*3*2);let h=new Float32Array(this.count*1*2),o=new Float32Array(this.count*2*2),l=new Uint16Array((this.count-1)*3*2);for(let p=0;p<this.count;p++){h.set([-1,1],p*2);let u=p/(this.count-1);if(o.set([0,u,1,u],p*4),p===this.count-1)continue;let d=p*2;l.set([d+0,d+1,d+2],(d+0)*3),l.set([d+2,d+1,d+3],(d+1)*3)}let c=this.geometry=new O(t,Object.assign(a,{position:{size:3,data:this.position},prev:{size:3,data:this.prev},next:{size:3,data:this.next},side:{size:1,data:h},uv:{size:2,data:o},index:{size:1,data:l}}));this.updateGeometry(),n.uResolution||(this.resolution=n.uResolution={value:new X}),n.uDPR||(this.dpr=n.uDPR={value:1}),n.uThickness||(this.thickness=n.uThickness={value:1}),n.uColor||(this.color=n.uColor={value:new lt("#000")}),n.uMiter||(this.miter=n.uMiter={value:1}),this.resize();let f=this.program=new U(t,{vertex:r,fragment:s,uniforms:n});this.mesh=new D(t,{geometry:c,program:f})}updateGeometry(){this.points.forEach((t,e)=>{t.toArray(this.position,e*3*2),t.toArray(this.position,e*3*2+3),e?(t.toArray(this.next,(e-1)*3*2),t.toArray(this.next,(e-1)*3*2+3)):(gt.copy(t).sub(this.points[e+1]).add(t),gt.toArray(this.prev,e*3*2),gt.toArray(this.prev,e*3*2+3)),e===this.points.length-1?(gt.copy(t).sub(this.points[e-1]).add(t),gt.toArray(this.next,e*3*2),gt.toArray(this.next,e*3*2+3)):(t.toArray(this.prev,(e+1)*3*2),t.toArray(this.prev,(e+1)*3*2+3))}),this.geometry.attributes.position.needsUpdate=!0,this.geometry.attributes.prev.needsUpdate=!0,this.geometry.attributes.next.needsUpdate=!0}resize(){this.resolution&&this.resolution.value.set(this.gl.canvas.width,this.gl.canvas.height),this.dpr&&(this.dpr.value=this.gl.renderer.dpr)}},sn=`
    precision highp float;

    attribute vec3 position;
    attribute vec3 next;
    attribute vec3 prev;
    attribute vec2 uv;
    attribute float side;

    uniform mat4 modelViewMatrix;
    uniform mat4 projectionMatrix;
    uniform vec2 uResolution;
    uniform float uDPR;
    uniform float uThickness;
    uniform float uMiter;

    varying vec2 vUv;

    vec4 getPosition() {
        mat4 mvp = projectionMatrix * modelViewMatrix;
        vec4 current = mvp * vec4(position, 1);
        vec4 nextPos = mvp * vec4(next, 1);
        vec4 prevPos = mvp * vec4(prev, 1);

        vec2 aspect = vec2(uResolution.x / uResolution.y, 1);    
        vec2 currentScreen = current.xy / current.w * aspect;
        vec2 nextScreen = nextPos.xy / nextPos.w * aspect;
        vec2 prevScreen = prevPos.xy / prevPos.w * aspect;
    
        vec2 dir1 = normalize(currentScreen - prevScreen);
        vec2 dir2 = normalize(nextScreen - currentScreen);
        vec2 dir = normalize(dir1 + dir2);
    
        vec2 normal = vec2(-dir.y, dir.x);
        normal /= mix(1.0, max(0.3, dot(normal, vec2(-dir1.y, dir1.x))), uMiter);
        normal /= aspect;

        float pixelWidthRatio = 1.0 / (uResolution.y / uDPR);
        float pixelWidth = current.w * pixelWidthRatio;
        normal *= pixelWidth * uThickness;
        current.xy -= normal * side;
    
        return current;
    }

    void main() {
        vUv = uv;
        gl_Position = getPosition();
    }
`,nn=`
    precision highp float;

    uniform vec3 uColor;
    
    varying vec2 vUv;

    void main() {
        gl_FragColor.rgb = uColor;
        gl_FragColor.a = 1.0;
    }
`;var qe=class{constructor(t,{light:e=new ht(t),width:r=1024,height:s=r}){this.gl=t,this.light=e,this.target=new j(t,{width:r,height:s}),this.targetUniform={value:this.target.texture},this.depthProgram=new U(t,{vertex:Xe,fragment:We,cullFace:!1}),this.castMeshes=[]}add({mesh:t,receive:e=!0,cast:r=!0,vertex:s=Xe,fragment:n=We,uniformProjection:a="shadowProjectionMatrix",uniformView:h="shadowViewMatrix",uniformTexture:o="tShadow"}){if(e&&!t.program.uniforms[a]&&(t.program.uniforms[a]={value:this.light.projectionMatrix},t.program.uniforms[h]={value:this.light.viewMatrix},t.program.uniforms[o]=this.targetUniform),!!r&&(this.castMeshes.push(t),t.colorProgram=t.program,!t.depthProgram)){if(s===Xe&&n===We){t.depthProgram=this.depthProgram;return}t.depthProgram=new U(this.gl,{vertex:s,fragment:n,cullFace:!1})}}setSize({width:t=1024,height:e=t}){this.target=new j(this.gl,{width:t,height:e}),this.targetUniform.value=this.target.texture}render({scene:t}){t.traverse(e=>{e.draw&&(~this.castMeshes.indexOf(e)?e.program=e.depthProgram:(e.isForceVisibility=e.visible,e.visible=!1))}),this.gl.renderer.render({scene:t,camera:this.light,target:this.target}),t.traverse(e=>{e.draw&&(~this.castMeshes.indexOf(e)?e.program=e.colorProgram:e.visible=e.isForceVisibility)})}},Xe=`
    attribute vec3 position;
    attribute vec2 uv;

    uniform mat4 modelViewMatrix;
    uniform mat4 projectionMatrix;

    void main() {
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
`,We=`
    precision highp float;

    vec4 packRGBA (float v) {
        vec4 pack = fract(vec4(1.0, 255.0, 65025.0, 16581375.0) * v);
        pack -= pack.yzww * vec2(1.0 / 255.0, 0.0).xxxy;
        return pack;
    }

    void main() {
        gl_FragColor = packRGBA(gl_FragCoord.z);
    }
`;var _t=class extends G{constructor(t,{buffer:e,wrapS:r=t.CLAMP_TO_EDGE,wrapT:s=t.CLAMP_TO_EDGE,anisotropy:n=0,minFilter:a,magFilter:h}={}){if(super(t,{generateMipmaps:!1,wrapS:r,wrapT:s,anisotropy:n,minFilter:a,magFilter:h}),e)return this.parseBuffer(e)}parseBuffer(t){let e=new an(t);e.mipmaps.isCompressedTexture=!0,this.image=e.mipmaps,this.internalFormat=e.glInternalFormat,e.numberOfMipmapLevels>1?this.minFilter===this.gl.LINEAR&&(this.minFilter=this.gl.NEAREST_MIPMAP_LINEAR):this.minFilter===this.gl.NEAREST_MIPMAP_LINEAR&&(this.minFilter=this.gl.LINEAR)}};function an(i){let t=[171,75,84,88,32,49,49,187,13,10,26,10],e=new Uint8Array(i,0,12);for(let f=0;f<e.length;f++)if(e[f]!==t[f])return console.error("File missing KTX identifier");let r=Uint32Array.BYTES_PER_ELEMENT,s=new DataView(i,12,13*r),n=s.getUint32(0,!0)===67305985;if(s.getUint32(1*r,n)!==0)return console.warn("only compressed formats currently supported");this.glInternalFormat=s.getUint32(4*r,n);let h=s.getUint32(6*r,n),o=s.getUint32(7*r,n);this.numberOfFaces=s.getUint32(10*r,n),this.numberOfMipmapLevels=Math.max(1,s.getUint32(11*r,n));let l=s.getUint32(12*r,n);this.mipmaps=[];let c=12+13*4+l;for(let f=0;f<this.numberOfMipmapLevels;f++){let p=new Int32Array(i,c,1)[0];c+=4;for(let u=0;u<this.numberOfFaces;u++){let d=new Uint8Array(i,c,p);this.mipmaps.push({data:d,width:h,height:o}),c+=p,c+=3-(p+3)%4}h=h>>1,o=o>>1}}var Wt={},vt=[],Ye=class{static load(t,{src:e,wrapS:r=t.CLAMP_TO_EDGE,wrapT:s=t.CLAMP_TO_EDGE,anisotropy:n=0,format:a=t.RGBA,internalFormat:h=a,generateMipmaps:o=!0,minFilter:l=o?t.NEAREST_MIPMAP_LINEAR:t.LINEAR,magFilter:c=t.LINEAR,premultiplyAlpha:f=!1,unpackAlignment:p=4,flipY:u=!0}={}){let d=this.getSupportedExtensions(t),x="none";if(typeof e=="string"&&(x=e.split(".").pop().split("?")[0].toLowerCase()),typeof e=="object"){for(let A in e)if(d.includes(A.toLowerCase())){x=A.toLowerCase(),e=e[A];break}}let m=e+r+s+n+a+h+o+l+c+f+p+u+t.renderer.id;if(Wt[m])return Wt[m];let g;switch(x){case"ktx":case"pvrtc":case"s3tc":case"etc":case"etc1":case"astc":g=new _t(t,{src:e,wrapS:r,wrapT:s,anisotropy:n,minFilter:l,magFilter:c}),g.loaded=this.loadKTX(e,g);break;case"webp":case"jpg":case"jpeg":case"png":g=new G(t,{wrapS:r,wrapT:s,anisotropy:n,format:a,internalFormat:h,generateMipmaps:o,minFilter:l,magFilter:c,premultiplyAlpha:f,unpackAlignment:p,flipY:u}),g.loaded=this.loadImage(t,e,g,u);break;default:console.warn("No supported format supplied"),g=new G(t)}return g.ext=x,Wt[m]=g,g}static getSupportedExtensions(t){if(vt.length)return vt;let e={pvrtc:t.renderer.getExtension("WEBGL_compressed_texture_pvrtc")||t.renderer.getExtension("WEBKIT_WEBGL_compressed_texture_pvrtc"),s3tc:t.renderer.getExtension("WEBGL_compressed_texture_s3tc"),etc1:t.renderer.getExtension("WEBGL_compressed_texture_etc1"),astc:t.renderer.getExtension("WEBGL_compressed_texture_astc"),bc7:t.renderer.getExtension("EXT_texture_compression_bptc")};for(let r in e)e[r]&&vt.push(r);return vt.push("png","jpg","webp"),vt}static loadKTX(t,e){return fetch(t).then(r=>r.arrayBuffer()).then(r=>e.parseBuffer(r))}static loadImage(t,e,r,s){return on(e,s).then(n=>(!t.renderer.isWebgl2&&(!as(n.width)||!as(n.height))&&(r.generateMipmaps&&(r.generateMipmaps=!1),r.minFilter===t.NEAREST_MIPMAP_LINEAR&&(r.minFilter=t.LINEAR),r.wrapS===t.REPEAT&&(r.wrapS=r.wrapT=t.CLAMP_TO_EDGE)),r.image=n,r.onUpdate=()=>{n.close&&n.close(),r.onUpdate=null},n))}static clearCache(){Wt={}}};function as(i){return Math.log2(i)%1===0}function on(i,t){return new Promise((e,r)=>{if(hn())fetch(i,{mode:"cors"}).then(s=>s.blob()).then(s=>createImageBitmap(s,{imageOrientation:t?"flipY":"none",premultiplyAlpha:"none"})).then(e).catch(s=>r(s));else{let s=new Image;s.crossOrigin="",s.src=i,s.onerror=({type:n})=>r(`${n}: Loading image`),s.onload=()=>e(s)}})}function hn(){if(!navigator.userAgent.toLowerCase().includes("chrome"))return!1;try{createImageBitmap}catch{return!1}return!0}var os=new E,ln=new E,cn=new E,fn=new E,hs=new K,un=new K,pn=new K,dn=new K,bt=class{constructor(t,e=1){this.data=t,this.elapsed=0,this.weight=e,this.loop=!0,this.startTime=t.reduce((r,{times:s})=>Math.min(r,s[0]),1/0),this.endTime=t.reduce((r,{times:s})=>Math.max(r,s[s.length-1]),0),this.duration=this.endTime-this.startTime}update(t=1,e){let r=e?1:this.weight/t,s=this.duration?(this.loop?this.elapsed%this.duration:Math.min(this.elapsed,this.duration-.001))+this.startTime:0;this.data.forEach(({node:n,transform:a,interpolation:h,times:o,values:l})=>{if(!this.duration){let A=os,w=3;a==="quaternion"&&(A=hs,w=4),A.fromArray(l,0),w===4?n[a].slerp(A,r):n[a].lerp(A,r);return}let c=Math.max(1,o.findIndex(A=>A>s))-1,f=c+1,p=(s-o[c])/(o[f]-o[c]);h==="STEP"&&(p=0);let u=os,d=ln,x=cn,m=fn,g=3;a==="quaternion"&&(u=hs,d=un,x=pn,m=dn,g=4),h==="CUBICSPLINE"?(u.fromArray(l,c*g*3+g*1),d.fromArray(l,c*g*3+g*2),x.fromArray(l,f*g*3+g*0),m.fromArray(l,f*g*3+g*1),u=this.cubicSplineInterpolate(p,u,d,x,m),g===4&&u.normalize()):(u.fromArray(l,c*g),m.fromArray(l,f*g),g===4?u.slerp(m,p):u.lerp(m,p)),g===4?n[a].slerp(u,r):n[a].lerp(u,r)})}cubicSplineInterpolate(t,e,r,s,n){let a=t*t,h=a*t,o=3*a-2*h,l=h-a,c=1-o,f=l-a+t;for(let p=0;p<e.length;p++)e[p]=c*e[p]+f*(1-t)*r[p]+o*n[p]+l*t*s[p];return e}};var ls=new V,mn=new V,Ft=class extends D{constructor(t,{skeleton:e,geometry:r,program:s,mode:n=t.TRIANGLES}={}){super(t,{geometry:r,program:s,mode:n}),this.skeleton=e,this.program=s,this.createBoneTexture()}createBoneTexture(){if(!this.skeleton.joints.length)return;let t=Math.max(4,Math.pow(2,Math.ceil(Math.log(Math.sqrt(this.skeleton.joints.length*4))/Math.LN2)));this.boneMatrices=new Float32Array(t*t*4),this.boneTextureSize=t,this.boneTexture=new G(this.gl,{image:this.boneMatrices,generateMipmaps:!1,type:this.gl.FLOAT,internalFormat:this.gl.renderer.isWebgl2?this.gl.RGBA32F:this.gl.RGBA,minFilter:this.gl.NEAREST,magFilter:this.gl.NEAREST,flipY:!1,width:t})}updateUniforms(){this.skeleton.joints.forEach((t,e)=>{ls.multiply(t.worldMatrix,t.bindInverse),this.boneMatrices.set(ls,e*16)}),this.boneTexture.needsUpdate=!0,this.program.uniforms.boneTexture.value=this.boneTexture,this.program.uniforms.boneTextureSize.value=this.boneTextureSize}draw({camera:t}={}){this.program.uniforms.boneTexture||Object.assign(this.program.uniforms,{boneTexture:{value:this.boneTexture},boneTextureSize:{value:this.boneTextureSize}}),this.updateUniforms();let e=this.worldMatrix;this.worldMatrix=mn,super.draw({camera:t}),this.worldMatrix=e}};var Tt=class extends D{constructor(...t){super(...t),this.frustumCulled=!1,this.isInstancedMesh=!0}addFrustumCull(){this.instanceTransforms=null,this.instanceLightmapScaleOffset=null,this.totalInstanceCount=0,this.frustumCullFunction=null,this.instanceRenderList=null,this.geometry.attributes.instanceMatrix||console.error(`mesh ${this.name?`"${this.name}" `:""}missing instanceMatrix attribute; unable to frustum cull`);let t=this.geometry.attributes.instanceMatrix.data;this.instanceTransforms=[];for(let e=0,r=0;e<t.length;e+=16,r++){let s=new H;s.index=r,s.matrix.fromArray(t,e),s.decompose(),this.instanceTransforms.push(s),s.setParent(this.parent)}if(this.totalInstanceCount=this.instanceTransforms.length,this.geometry.attributes.lightmapScaleOffset){let e=this.geometry.attributes.lightmapScaleOffset.data;for(let r=0,s=0;r<e.length;r+=4,s++)this.instanceTransforms[s].lightmapData=new yt().fromArray(e,r)}this.frustumCullFunction=({camera:e})=>{this.instanceRenderList=[],this.instanceTransforms.forEach(r=>{e.frustumIntersectsMesh(this,r.worldMatrix)&&this.instanceRenderList.push(r)}),this.instanceRenderList.forEach((r,s)=>{r.matrix.toArray(this.geometry.attributes.instanceMatrix.data,s*16),r.lightmapData&&(r.lightmapData.toArray(this.geometry.attributes.lightmapScaleOffset.data,s*4),this.geometry.attributes.lightmapScaleOffset.needsUpdate=!0)}),this.geometry.instancedCount=this.instanceRenderList.length,this.geometry.attributes.instanceMatrix.needsUpdate=!0},this.onBeforeRender(this.frustumCullFunction)}removeFrustumCull(){this.offBeforeRender(this.frustumCullFunction),this.geometry.instancedCount=this.totalInstanceCount,this.instanceTransforms.forEach((t,e)=>{t.matrix.toArray(this.geometry.attributes.instanceMatrix.data,e*16),t.lightmapData&&(t.lightmapData.toArray(this.geometry.attributes.lightmapScaleOffset.data,e*4),this.geometry.attributes.lightmapScaleOffset.needsUpdate=!0)}),this.geometry.attributes.instanceMatrix.needsUpdate=!0}};var cs={5120:Int8Array,5121:Uint8Array,5122:Int16Array,5123:Uint16Array,5125:Uint32Array,5126:Float32Array,"image/jpeg":Uint8Array,"image/png":Uint8Array,"image/webp":Uint8Array},gn={SCALAR:1,VEC2:2,VEC3:3,VEC4:4,MAT2:4,MAT3:9,MAT4:16},fs={POSITION:"position",NORMAL:"normal",TANGENT:"tangent",TEXCOORD_0:"uv",TEXCOORD_1:"uv2",COLOR_0:"color",WEIGHTS_0:"skinWeight",JOINTS_0:"skinIndex"},xn={translation:"position",rotation:"quaternion",scale:"scale"},je=class{static setDracoManager(t){this.dracoManager=t}static setBasisManager(t){this.basisManager=t}static async load(t,e){let r=e.split("/").slice(0,-1).join("/")+"/",s=await this.parseDesc(e);return this.parse(t,s,r)}static async parse(t,e,r){(e.asset===void 0||e.asset.version[0]<2)&&console.warn("Only GLTF >=2.0 supported. Attempting to parse."),e.extensionsRequired?.includes("KHR_draco_mesh_compression")&&!this.dracoManager&&console.warn("KHR_draco_mesh_compression extension required but no manager supplied. Use .setDracoManager()"),e.extensionsRequired?.includes("KHR_texture_basisu")&&!this.basisManager&&console.warn("KHR_texture_basisu extension required but no manager supplied. Use .setBasisManager()");let s=await this.loadBuffers(e,r);t.renderer.bindVertexArray(null);let n=this.parseBufferViews(t,e,s),a=await this.parseImages(t,e,r,n),h=this.parseTextures(t,e,a),o=this.parseMaterials(t,e,h),l=this.parseSkins(t,e,n),c=await this.parseMeshes(t,e,n,o,l),[f,p]=this.parseNodes(t,e,c,l,a);this.populateSkins(l,f);let u=this.parseAnimations(t,e,f,n),d=this.parseScenes(e,f),x=d[e.scene],m=this.parseLights(t,e,f,d);for(let g=f.length;g>=0;g--)f[g]||f.splice(g,1);return{json:e,buffers:s,bufferViews:n,cameras:p,images:a,textures:h,materials:o,meshes:c,nodes:f,lights:m,animations:u,scenes:d,scene:x}}static parseDesc(t){return fetch(t,{mode:"cors"}).then(e=>e.arrayBuffer()).then(e=>{let r=new TextDecoder;return r.decode(new Uint8Array(e,0,4))==="glTF"?this.unpackGLB(e):JSON.parse(r.decode(e))})}static unpackGLB(t){let e=new Uint32Array(t,0,3);if(e[0]!==1179937895)throw new Error("Invalid glTF asset.");if(e[1]!==2)throw new Error(`Unsupported glTF binary version, "${e[1]}".`);let r=new Uint32Array(t,12,2),s=20,n=r[0];if(r[1]!==1313821514)throw new Error("Unexpected GLB layout.");let a=new TextDecoder().decode(t.slice(s,s+n)),h=JSON.parse(a);if(s+n===t.byteLength)return h;let o=new Uint32Array(t,s+n,2);if(o[1]!==5130562)throw new Error("Unexpected GLB layout.");let l=s+n+8,c=o[0],f=t.slice(l,l+c);return h.buffers[0].binary=f,h}static resolveURI(t,e){return typeof t!="string"||t===""?"":(/^https?:\/\//i.test(e)&&/^\//.test(t)&&(e=e.replace(/(^https?:\/\/[^\/]+).*/i,"$1")),/^(https?:)?\/\//i.test(t)||/^data:.*,.*$/i.test(t)||/^blob:.*$/i.test(t)?t:e+t)}static loadBuffers(t,e){return t.buffers?Promise.all(t.buffers.map(r=>{if(r.binary)return r.binary;let s=this.resolveURI(r.uri,e);return fetch(s,{mode:"cors"}).then(n=>n.arrayBuffer())})):null}static parseBufferViews(t,e,r){if(!e.bufferViews)return null;let s=e.bufferViews;return e.meshes&&e.meshes.forEach(({primitives:n})=>{n.forEach(({attributes:a,indices:h,extensions:o})=>{for(let l in a){let c=e.accessors[a[l]];c.bufferView===void 0&&o&&o.KHR_draco_mesh_compression&&(c.bufferView=o.KHR_draco_mesh_compression.bufferView,s[c.bufferView].isDraco=!0),s[c.bufferView].isAttribute=!0}if(h!==void 0){let l=e.accessors[h];l.bufferView===void 0&&o&&o.KHR_draco_mesh_compression&&(l.bufferView=o.KHR_draco_mesh_compression.bufferView,s[l.bufferView].isDraco=!0),s[l.bufferView].isAttribute=!0,s[l.bufferView].target=t.ELEMENT_ARRAY_BUFFER}})}),e.accessors.forEach(({bufferView:n,componentType:a})=>{n!==void 0&&(s[n].componentType=a)}),e.images&&e.images.forEach(({uri:n,bufferView:a,mimeType:h})=>{a!==void 0&&(s[a].mimeType=h)}),s.forEach(({buffer:n,byteOffset:a=0,byteLength:h,byteStride:o,target:l=t.ARRAY_BUFFER,name:c,extensions:f,extras:p,componentType:u,mimeType:d,isAttribute:x,isDraco:m},g)=>{if(s[g].data=r[n].slice(a,a+h),!x||m)return;let A=t.createBuffer();t.bindBuffer(l,A),t.renderer.state.boundBuffer=A,t.bufferData(l,s[g].data,t.STATIC_DRAW),s[g].buffer=A}),s}static parseImages(t,e,r,s){return e.images?Promise.all(e.images.map(async({uri:n,bufferView:a,mimeType:h,name:o})=>{if(h==="image/ktx2"){let{data:c}=s[a];return await this.basisManager.parseTexture(c)}let l=new Image;if(l.name=o,n)l.src=this.resolveURI(n,r);else if(a!==void 0){let{data:c}=s[a],f=new Blob([c],{type:h});l.src=URL.createObjectURL(f)}return l.ready=new Promise(c=>{l.onload=()=>c()}),l})):null}static parseTextures(t,e,r){return e.textures?e.textures.map(s=>this.createTexture(t,e,r,s)):null}static createTexture(t,e,r,{sampler:s,source:n,name:a,extensions:h,extras:o}){n===void 0&&h&&(h.EXT_texture_webp&&(n=h.EXT_texture_webp.source),h.KHR_texture_basisu&&(n=h.KHR_texture_basisu.source));let l=r[n];if(l.texture)return l.texture;let c={flipY:!1,wrapS:t.REPEAT,wrapT:t.REPEAT},f=s!==void 0?e.samplers[s]:null;if(f&&["magFilter","minFilter","wrapS","wrapT"].forEach(u=>{f[u]&&(c[u]=f[u])}),l.isBasis){c.image=l,c.internalFormat=l.internalFormat,l.isCompressedTexture&&(c.generateMipmaps=!1,l.length>1&&(this.minFilter=t.NEAREST_MIPMAP_LINEAR));let u=new G(t,c);return u.name=a,l.texture=u,u}let p=new G(t,c);return p.name=a,l.texture=p,l.ready.then(()=>{p.image=l}),p}static parseMaterials(t,e,r){return e.materials?e.materials.map(({name:s,extensions:n,extras:a,pbrMetallicRoughness:h={},normalTexture:o,occlusionTexture:l,emissiveTexture:c,emissiveFactor:f=[0,0,0],alphaMode:p="OPAQUE",alphaCutoff:u=.5,doubleSided:d=!1})=>{let{baseColorFactor:x=[1,1,1,1],baseColorTexture:m,metallicFactor:g=1,roughnessFactor:A=1,metallicRoughnessTexture:w}=h;return m&&(m.texture=r[m.index]),o&&(o.texture=r[o.index]),w&&(w.texture=r[w.index]),l&&(l.texture=r[l.index]),c&&(c.texture=r[c.index]),{name:s,extensions:n,extras:a,baseColorFactor:x,baseColorTexture:m,metallicFactor:g,roughnessFactor:A,metallicRoughnessTexture:w,normalTexture:o,occlusionTexture:l,emissiveTexture:c,emissiveFactor:f,alphaMode:p,alphaCutoff:u,doubleSided:d}}):null}static parseSkins(t,e,r){return e.skins?e.skins.map(({inverseBindMatrices:s,skeleton:n,joints:a})=>({inverseBindMatrices:this.parseAccessor(s,e,r),skeleton:n,joints:a})):null}static parseMeshes(t,e,r,s,n){return e.meshes?Promise.all(e.meshes.map(async({primitives:a,weights:h,name:o,extensions:l,extras:c={}},f)=>{let p=0,u=[],d=!1;return e.nodes&&e.nodes.forEach(({mesh:m,skin:g,extras:A})=>{m===f&&(p++,g!==void 0&&u.push(g),A&&A.lightmap_scale_offset&&(d=!0))}),!!u.length?(a=await Promise.all(u.map(async m=>(await this.parsePrimitives(t,a,e,r,s,1,d)).map(({geometry:g,program:A,mode:w})=>{let _=new Ft(t,{skeleton:n[m],geometry:g,program:A,mode:w});return _.name=o,_.extras=c,l&&(_.extensions=l),_.frustumCulled=!1,_}))),a.instanceCount=0,a.numInstances=p):a=(await this.parsePrimitives(t,a,e,r,s,p,d)).map(({geometry:m,program:g,mode:A})=>{let w=m.attributes.instanceMatrix?Tt:D,_=new w(t,{geometry:m,program:g,mode:A});return _.name=o,_.extras=c,l&&(_.extensions=l),_.numInstances=p,_}),{primitives:a,weights:h,name:o}})):null}static parsePrimitives(t,e,r,s,n,a,h){return Promise.all(e.map(async({attributes:o,indices:l,material:c,mode:f=4,targets:p,extensions:u,extras:d})=>{let x=new Ve(t);c!==void 0&&(x.gltfMaterial=n[c]);let m=new O(t);if(d&&(m.extras=d),u&&(m.extensions=u),u&&u.KHR_draco_mesh_compression){let g=u.KHR_draco_mesh_compression.bufferView,A=u.KHR_draco_mesh_compression.attributes,w={},_={},M={},y={};for(let R in o){let v=r.accessors[o[R]],L=fs[R];w[L]=A[R],_[L]=v.componentType,M[L]=cs[v.componentType].name,y[L]=v.normalized===!0}let{data:b}=s[g],z=await this.dracoManager.decodeGeometry(b,{attributeIds:w,attributeTypes:M});for(let R=0;R<z.attributes.length;R++){let v=z.attributes[R],L=v.name,T=v.array,S=v.itemSize,F=_[L],C=y[L],N=t.createBuffer();t.bindBuffer(t.ARRAY_BUFFER,N),t.renderer.state.boundBuffer=N,t.bufferData(t.ARRAY_BUFFER,T,t.STATIC_DRAW),m.addAttribute(L,{data:T,size:S,type:F,normalized:C,buffer:N})}if(z.index){let R=z.index.array,v=z.index.itemSize,L=t.createBuffer();t.bindBuffer(t.ELEMENT_ARRAY_BUFFER,L),t.renderer.state.boundBuffer=L,t.bufferData(t.ELEMENT_ARRAY_BUFFER,R,t.STATIC_DRAW),m.addAttribute("index",{data:R,size:v,type:5125,normalized:!1,buffer:L})}}else{for(let g in o)m.addAttribute(fs[g],this.parseAccessor(o[g],r,s));l!==void 0&&m.addAttribute("index",this.parseAccessor(l,r,s))}return a>1&&m.addAttribute("instanceMatrix",{instanced:1,size:16,data:new Float32Array(a*16)}),h&&m.addAttribute("lightmapScaleOffset",{instanced:1,size:4,data:new Float32Array(a*4)}),{geometry:m,program:x,mode:f}}))}static parseAccessor(t,e,r){let{bufferView:s,byteOffset:n=0,componentType:a,normalized:h=!1,count:o,type:l,min:c,max:f,sparse:p}=e.accessors[t],{data:u,buffer:d,byteOffset:x=0,byteStride:m=0,target:g}=r[s],A=gn[l],w=cs[a],_=w.BYTES_PER_ELEMENT,M=m/_,y=!!m&&M!==A,b;if(y){let z=new w(u,n);b=new w(o*A);for(let R=0;R<o;R++){let v=M*R,L=v+A;b.set(z.slice(v,L),R*A)}}else b=new w(u,n,o*A);return{data:b,size:A,type:a,normalized:h,buffer:d,stride:m,offset:n,count:o,min:c,max:f}}static parseNodes(t,e,r,s,n){if(!e.nodes)return null;let a=[],h=e.nodes.map(({camera:o,children:l,skin:c,matrix:f,mesh:p,rotation:u,scale:d,translation:x,weights:m,name:g,extensions:A,extras:w})=>{let _=o!==void 0,M=_?new ht(t):new H;if(_){let v=e.cameras[o];if(v.type==="perspective"){let{yfov:L,znear:T,zfar:S}=v.perspective;M.perspective({fov:L*(180/Math.PI),near:T,far:S})}else{let{xmag:L,ymag:T,znear:S,zfar:F}=v.orthographic;M.orthographic({near:S,far:F,left:-L,right:L,top:-T,bottom:T})}a.push(M)}g&&(M.name=g),w&&(M.extras=w),A&&(M.extensions=A),w&&w.lightmapTexture!==void 0&&(w.lightmapTexture.texture=this.createTexture(t,e,n,{source:w.lightmapTexture.index})),f?(M.matrix.copy(f),M.decompose()):(u&&M.quaternion.copy(u),d&&M.scale.copy(d),x&&M.position.copy(x),M.updateMatrix());let y=!1,b=!0,z=!1;if(p!==void 0&&(c!==void 0?(r[p].primitives[r[p].primitives.instanceCount].forEach(v=>{w&&Object.assign(v.extras,w),v.setParent(M)}),r[p].primitives.instanceCount++,r[p].primitives.instanceCount===r[p].primitives.numInstances&&(delete r[p].primitives.numInstances,delete r[p].primitives.instanceCount)):r[p].primitives.forEach(v=>{w&&Object.assign(v.extras,w),v.geometry.isInstanced&&(y=!0,v.instanceCount?b=!1:v.instanceCount=0,v.geometry.attributes.instanceMatrix&&(z=!0,M.matrix.toArray(v.geometry.attributes.instanceMatrix.data,v.instanceCount*16)),v.geometry.attributes.lightmapScaleOffset&&v.geometry.attributes.lightmapScaleOffset.data.set(w.lightmap_scale_offset,v.instanceCount*4),v.instanceCount++,v.instanceCount===v.numInstances&&(delete v.numInstances,delete v.instanceCount,v.geometry.attributes.instanceMatrix&&(v.geometry.attributes.instanceMatrix.needsUpdate=!0),v.geometry.attributes.lightmapScaleOffset&&(v.geometry.attributes.lightmapScaleOffset.needsUpdate=!0))),y?b&&v.setParent(M):v.setParent(M)})),z){if(!b)return null;M.matrix.identity(),M.decompose()}return M});return e.nodes.forEach(({children:o=[]},l)=>{o.forEach(c=>{h[c]&&h[c].setParent(h[l])})}),r.forEach(({primitives:o},l)=>{o.forEach((c,f)=>{c.isInstancedMesh&&c.addFrustumCull()})}),[h,a]}static populateSkins(t,e){t&&t.forEach(r=>{r.joints=r.joints.map((s,n)=>{let a=e[s];return a.skin=r,a.bindInverse=new V(...r.inverseBindMatrices.data.slice(n*16,(n+1)*16)),a}),r.skeleton&&(r.skeleton=e[r.skeleton])})}static parseAnimations(t,e,r,s){return e.animations?e.animations.map(({channels:n,samplers:a,name:h},o)=>{let l=n.map(({sampler:c,target:f})=>{let{input:p,interpolation:u="LINEAR",output:d}=a[c],{node:x,path:m}=f,g=r[x],A=xn[m],w=this.parseAccessor(p,e,s).data,_=this.parseAccessor(d,e,s).data;return g.animations||(g.animations=[]),g.animations.includes(o)||g.animations.push(o),{node:g,transform:A,interpolation:u,times:w,values:_}});return{name:h,animation:new bt(l)}}):null}static parseScenes(t,e){return t.scenes?t.scenes.map(({nodes:r=[],name:s,extensions:n,extras:a})=>{let h=r.reduce((o,l)=>(e[l]&&o.push(e[l]),o),[]);return h.extras=a,h}):null}static parseLights(t,e,r,s){let n={directional:[],point:[],spot:[]};s.forEach(h=>h.forEach(o=>o.updateMatrixWorld()));let a=e.extensions?.KHR_lights_punctual?.lights||[];return r.forEach(h=>{if(!h?.extensions?.KHR_lights_punctual)return;let o=h.extensions.KHR_lights_punctual.light,l=a[o],c={name:l.name||"",color:{value:new E().set(l.color||1)}};switch(l.intensity!==void 0&&c.color.value.multiply(l.intensity),l.type){case"directional":c.direction={value:new E(0,0,1).transformDirection(h.worldMatrix)};break;case"point":c.position={value:new E().applyMatrix4(h.worldMatrix)},c.distance={value:l.range},c.decay={value:2};break;case"spot":Object.assign(c,l);break}n[l.type].push(c)}),n}};var He=0,Qe=class{constructor(t){this.onMessage=this.onMessage.bind(this),this.queue=new Map,this.initWorker(t)}initWorker(t){this.worker=new Worker(t),this.worker.onmessage=this.onMessage}onMessage({data:t}){let{id:e,error:r,geometry:s}=t;if(r){console.log(r,e);return}let n=this.queue.get(e);this.queue.delete(e),n(s)}decodeGeometry(t,e){He++,this.worker.postMessage({id:He,buffer:t,config:e});let r,s=new Promise(n=>r=n);return this.queue.set(He,r),s}};var Ke,Ze=0,$e=class{constructor(t,e){Ke||(Ke=this.getSupportedFormat(e)),this.onMessage=this.onMessage.bind(this),this.queue=new Map,this.initWorker(t)}getSupportedFormat(t=document.createElement("canvas").getContext("webgl")){return t.getExtension("WEBGL_compressed_texture_astc")?"astc":t.getExtension("EXT_texture_compression_bptc")?"bptc":t.getExtension("WEBGL_compressed_texture_s3tc")?"s3tc":t.getExtension("WEBGL_compressed_texture_etc1")?"etc1":t.getExtension("WEBGL_compressed_texture_pvrtc")||t.getExtension("WEBKIT_WEBGL_compressed_texture_pvrtc")?"pvrtc":"none"}initWorker(t){this.worker=new Worker(t),this.worker.onmessage=this.onMessage}onMessage({data:t}){let{id:e,error:r,image:s}=t;if(r){console.log(r,e);return}let n=this.queue.get(e);this.queue.delete(e),s.isBasis=!0,n(s)}parseTexture(t){Ze++,this.worker.postMessage({id:Ze,buffer:t,supportedFormat:Ke});let e,r=new Promise(s=>e=s);return this.queue.set(Ze,e),r}};var Je=class extends D{constructor(t,{geometry:e,wireColor:r=new lt(0,.75,.5),...s}={}){let n=new U(t,{vertex:wn,fragment:Mn,uniforms:{wireColor:{value:r}}}),a=e.attributes.position.data,h=[],o=new Set;function l(p){for(let u=0;u<p.length;u+=2)yn(p[u]*3,p[u+1]*3,a,o)&&h.push(p[u],p[u+1])}if(e.attributes.index){let p=e.attributes.index.data;for(let u=0;u<p.length;u+=3)l([p[u],p[u+1],p[u+1],p[u+2],p[u+2],p[u]])}else{let p=Math.floor(a.length/3);for(let u=0;u<p;u+=3)l([u,u+1,u+1,u+2,u+2,u])}let c=h.length>65536?new Uint32Array(h):new Uint16Array(h),f=new O(t,{position:{...e.attributes.position},index:{data:c}});super(t,{...s,mode:t.LINES,geometry:f,program:n})}};function yn(i,t,e,r){let s=[e[i],e[i+1],e[i+2],e[t],e[t+1],e[t+2]].join("#"),n=[e[t],e[t+1],e[t+2],e[i],e[i+1],e[i+2]].join("#"),a=r.size;return r.add(s),r.add(n),r.size-a===2}var wn=`
attribute vec3 position;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;

void main() {    
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`,Mn=`
precision highp float;
uniform vec3 wireColor;

void main() {    
    gl_FragColor = vec4(wireColor, 1.0);
}
`;var ti=class extends D{constructor(t,{size:e=1,symmetric:r=!1,xColor:s=new E(.96,.21,.32),yColor:n=new E(.44,.64,.11),zColor:a=new E(.18,.52,.89),...h}={}){let o=r?-e:0,l=e,c=new Float32Array([o,0,0,l,0,0,0,o,0,0,l,0,0,0,o,0,0,l]),f=new Float32Array([...s,...s,...n,...n,...a,...a]),p=new O(t,{position:{size:3,data:c},color:{size:3,data:f}}),u=new U(t,{vertex:En,fragment:An});super(t,{...h,mode:t.LINES,geometry:p,program:u})}},En=`
attribute vec3 position;
attribute vec3 color;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;

varying vec3 vColor;

void main() {    
    vColor = color;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`,An=`
precision highp float;
varying vec3 vColor;

void main() {    
    gl_FragColor = vec4(vColor, 1.0);
}
`;var ei=class extends D{constructor(t,{size:e=10,divisions:r=10,color:s=new E(.75,.75,.75),...n}={}){let a=(e+1)*2*2,h=new Float32Array(a*3),o=e/2;for(let f=0;f<=r;f++){let u=f/r*e-o;h.set([u,0,-o,u,0,o],f*12),h.set([-o,0,u,o,0,u],f*12+6)}let l=new O(t,{position:{size:3,data:h}}),c=new U(t,{vertex:_n,fragment:vn,uniforms:{color:{value:s}}});super(t,{...n,mode:t.LINES,geometry:l,program:c})}},_n=`
attribute vec3 position;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;

void main() {    
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`,vn=`
precision highp float;
uniform vec3 color;

void main() {    
    gl_FragColor = vec4(color, 1.0);
}
`;var ii=class extends D{constructor(t,{size:e=.1,color:r=new E(.86,.16,.86),...s}={}){let n=t.gl,a=t.geometry.attributes.normal.count,h=new Float32Array(a*2*3),o=new Float32Array(a*2*3),l=new Float32Array(a*2),c=t.geometry.attributes.normal.data,f=t.geometry.attributes.position.data,p=new Float32Array([0,e]);for(let x=0;x<a;x++){let m=x*6,g=x*3,A=f.subarray(g,g+3);h.set(A,m),h.set(A,m+3);let w=c.subarray(g,g+3);o.set(w,m),o.set(w,m+3),l.set(p,x*2)}let u=new O(n,{position:{size:3,data:h},normal:{size:3,data:o},size:{size:1,data:l}}),d=new U(n,{vertex:bn,fragment:Fn,uniforms:{color:{value:r},worldNormalMatrix:{value:new et},objectWorldMatrix:{value:t.worldMatrix}}});super(n,{...s,mode:n.LINES,geometry:u,program:d}),this.object=t}draw(t){this.program.uniforms.worldNormalMatrix.value.getNormalMatrix(this.object.worldMatrix),super.draw(t)}},bn=`
attribute vec3 position;
attribute vec3 normal;
attribute float size;

uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
uniform mat4 objectWorldMatrix;
uniform mat3 worldNormalMatrix;

void main() {
    vec3 n = normalize(worldNormalMatrix * normal) * size;
    vec3 p = (objectWorldMatrix * vec4(position, 1.0)).xyz;
    gl_Position = projectionMatrix * viewMatrix * vec4(p + n, 1.0);
}
`,Fn=`
precision highp float;
uniform vec3 color;

void main() {    
    gl_FragColor = vec4(color, 1.0);
}
`;var Rt=new E,qt=new E,zt=new E,ri=new E,si=new E,ni=class extends D{constructor(t,{size:e=.1,color:r=new E(.15,.86,.86),...s}={}){let n=t.gl,a=t.geometry.attributes.position.data,h=new Float32Array([0,e]),o=t.geometry.attributes.index,l=o?g=>o.data[g]:g=>g,c=o?o.data.length:Math.floor(a.length/3),f=Math.floor(c/3),p=new Float32Array(f*2*3),u=new Float32Array(f*2*3),d=new Float32Array(f*2);for(let g=0;g<c;g+=3){Rt.fromArray(a,l(g+0)*3),qt.fromArray(a,l(g+1)*3),zt.fromArray(a,l(g+2)*3),ri.add(Rt,qt).add(zt).multiply(1/3),Rt.sub(Rt,qt),zt.sub(zt,qt),si.cross(zt,Rt).normalize();let A=g*2;p.set(ri,A),p.set(ri,A+3),u.set(si,A),u.set(si,A+3),d.set(h,g/3*2)}let x=new O(n,{position:{size:3,data:p},normal:{size:3,data:u},size:{size:1,data:d}}),m=new U(n,{vertex:Tn,fragment:Rn,uniforms:{color:{value:r},worldNormalMatrix:{value:new et},objectWorldMatrix:{value:t.worldMatrix}}});super(n,{...s,mode:n.LINES,geometry:x,program:m}),this.object=t}draw(t){this.program.uniforms.worldNormalMatrix.value.getNormalMatrix(this.object.worldMatrix),super.draw(t)}},Tn=`
attribute vec3 position;
attribute vec3 normal;
attribute float size;

uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
uniform mat4 objectWorldMatrix;
uniform mat3 worldNormalMatrix;

void main() {
    vec3 n = normalize(worldNormalMatrix * normal) * size;
    vec3 p = (objectWorldMatrix * vec4(position, 1.0)).xyz;
    gl_Position = projectionMatrix * viewMatrix * vec4(p + n, 1.0);
}
`,Rn=`
precision highp float;
uniform vec3 color;

void main() {    
    gl_FragColor = vec4(color, 1.0);
}
`;var ai=class extends G{constructor(t,e){super(t,{...e,target:t.TEXTURE_3D,width:e.width?e.width:2,height:e.height?e.height:2});let r=new Image;r.crossOrigin="*",r.src=e.src,r.onload=()=>{let s=document.createElement("canvas");s.width=r.width,s.height=r.height;let n=s.getContext("2d");n.scale(1,-1),n.translate(0,-r.height),n.drawImage(r,0,0);let a=n.getImageData(0,0,r.width,r.height).data;s=null,n=null;let h;switch(this.format){case t.RED:h=1;break;case t.RG:h=2;break;case t.RGB:h=3;break;default:h=4;break}let o=this.width*this.height*this.length*h,l=this.type===t.UNSIGNED_BYTE?new Uint8Array(o):new Float32Array(o),c=0;for(let f=0;f<this.length;f++)for(let p=0;p<this.height;p++)for(let u=0;u<this.width;u++){let d=f%e.tileCountX*this.width,x=Math.floor(f/e.tileCountX)*(this.width*this.height*e.tileCountX),m=u+d+(p*r.width+x),g=a[m*4],A=a[m*4+1],w=a[m*4+2],_=a[m*4+3],M=[g,A,w,_];for(let y=0;y<h;y++)this.type===this.gl.UNSIGNED_BYTE?l[c++]=M[y]:l[c++]=M[y]/255}this.image=l,this.needsUpdate=!0}}};return {Animation:At,AxesHelper:ti,BasisManager:$e,Box:xe,Camera:ht,Color:lt,Curve:dt,Cylinder:we,DracoManager:Qe,Euler:xt,FaceNormalsHelper:ni,Flowmap:Ue,GLTFAnimation:bt,GLTFLoader:je,GLTFSkin:Ft,GPGPU:ke,Geometry:O,GridHelper:ei,InstancedMesh:Tt,KTXTexture:_t,Mat3:et,Mat4:V,Mesh:D,NormalProgram:Ve,Orbit:Is,Path:Se,Plane:tt,Polyline:Ge,Post:Ne,Program:U,Quat:K,Raycast:_e,RenderTarget:j,Renderer:ie,Shadow:qe,Skin:Be,Sphere:ye,Text:Ks,Texture:G,Texture3D:ai,TextureLoader:Ye,Torus:Me,Transform:H,Triangle:it,Tube:Ce,Vec2:X,Vec3:E,Vec4:yt,VertexNormalsHelper:ii,WireMesh:Je};;
})();const {Renderer,Program,Mesh,Triangle,RenderTarget,Texture}=OGL;
const SWELL_PRESETS = {
  swell: {
    scale: 1.5,
    speed: 0.6,
    direction: 250,
    chop: 0.55,
    stretch: 0,
    glint: 0.7,
    contrast: 1.25,
    perspective: 0.55,
    fog: 0.55
  },
  tide: {
    scale: 1.3,
    speed: 0.5,
    direction: 262,
    chop: 0.2,
    stretch: 0.12,
    glint: 0.45,
    contrast: 1.1,
    perspective: 0.5,
    fog: 0.4
  },
  storm: {
    scale: 0.55,
    speed: 1.6,
    direction: 236,
    chop: 1,
    stretch: 0.3,
    glint: 1.3,
    contrast: 1.8,
    perspective: 0.8,
    fog: 0.35
  },
  signal: {
    scale: 0.85,
    speed: 1.2,
    direction: 180,
    chop: 0.6,
    stretch: 0.85,
    glint: 0.25,
    contrast: 1.2,
    perspective: 0,
    fog: 0
  }
};

const FLUID_SIZE = 96;
const PRESSURE_STEPS = 16;
const SPLAT_FORCE = 6900;
const SPLASH_JETS = 3;
const PIXEL_BUDGET = 2e6;

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

const parseColor = (value, fallback) => {
  try {
    const ctx = document.createElement('canvas').getContext('2d');
    if (!ctx) return fallback;
    ctx.fillStyle = '#000000';
    ctx.fillStyle = value;
    const resolved = ctx.fillStyle;
    if (resolved.startsWith('#')) {
      const n = parseInt(resolved.slice(1), 16);
      return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, 1];
    }
    const parts = resolved.match(/[\d.]+/g);
    if (!parts || parts.length < 3) return fallback;
    return [Number(parts[0]) / 255, Number(parts[1]) / 255, Number(parts[2]) / 255, parts[3] ? Number(parts[3]) : 1];
  } catch {
    return fallback;
  }
};

const passVertex = `#version 300 es
in vec2 position;
void main() {
  gl_Position = vec4(position, 0.0, 1.0);
}
`;

const fluidVertex = `#version 300 es
in vec2 position;
uniform vec2 uTexel;
out vec2 vUv;
out vec2 vL;
out vec2 vR;
out vec2 vT;
out vec2 vB;
void main() {
  vUv = position * 0.5 + 0.5;
  vL = vUv - vec2(uTexel.x, 0.0);
  vR = vUv + vec2(uTexel.x, 0.0);
  vT = vUv + vec2(0.0, uTexel.y);
  vB = vUv - vec2(0.0, uTexel.y);
  gl_Position = vec4(position, 0.0, 1.0);
}
`;

const fluidHead = `#version 300 es
precision highp float;
in vec2 vUv;
in vec2 vL;
in vec2 vR;
in vec2 vT;
in vec2 vB;
out vec4 fragColor;
`;

const splatFragment = `${fluidHead}
uniform sampler2D uTarget;
uniform float uAspect;
uniform vec2 uPoint;
uniform vec3 uValue;
uniform float uRadius;
void main() {
  vec2 offset = vUv - uPoint;
  offset.x *= uAspect;
  float falloff = exp(-dot(offset, offset) / uRadius);
  fragColor = vec4(texture(uTarget, vUv).xyz + uValue * falloff, 1.0);
}
`;

const curlFragment = `${fluidHead}
uniform sampler2D uVelocity;
void main() {
  float left = texture(uVelocity, vL).y;
  float right = texture(uVelocity, vR).y;
  float top = texture(uVelocity, vT).x;
  float bottom = texture(uVelocity, vB).x;
  fragColor = vec4(0.5 * (right - left - top + bottom), 0.0, 0.0, 1.0);
}
`;

const vorticityFragment = `${fluidHead}
uniform sampler2D uVelocity;
uniform sampler2D uCurl;
uniform float uSwirl;
uniform float uDt;
void main() {
  float left = texture(uCurl, vL).x;
  float right = texture(uCurl, vR).x;
  float top = texture(uCurl, vT).x;
  float bottom = texture(uCurl, vB).x;
  float middle = texture(uCurl, vUv).x;
  vec2 force = 0.5 * vec2(abs(top) - abs(bottom), abs(right) - abs(left));
  force = force / (length(force) + 0.0001) * uSwirl * middle;
  force.y = -force.y;
  vec2 velocity = texture(uVelocity, vUv).xy + force * uDt;
  fragColor = vec4(clamp(velocity, -1000.0, 1000.0), 0.0, 1.0);
}
`;

const divergenceFragment = `${fluidHead}
uniform sampler2D uVelocity;
void main() {
  vec2 middle = texture(uVelocity, vUv).xy;
  float left = vL.x < 0.0 ? -middle.x : texture(uVelocity, vL).x;
  float right = vR.x > 1.0 ? -middle.x : texture(uVelocity, vR).x;
  float top = vT.y > 1.0 ? -middle.y : texture(uVelocity, vT).y;
  float bottom = vB.y < 0.0 ? -middle.y : texture(uVelocity, vB).y;
  fragColor = vec4(0.5 * (right - left + top - bottom), 0.0, 0.0, 1.0);
}
`;

const pressureFragment = `${fluidHead}
uniform sampler2D uPressure;
uniform sampler2D uDivergence;
void main() {
  float left = texture(uPressure, vL).x;
  float right = texture(uPressure, vR).x;
  float top = texture(uPressure, vT).x;
  float bottom = texture(uPressure, vB).x;
  float divergence = texture(uDivergence, vUv).x;
  fragColor = vec4((left + right + top + bottom - divergence) * 0.25, 0.0, 0.0, 1.0);
}
`;

const projectFragment = `${fluidHead}
uniform sampler2D uPressure;
uniform sampler2D uVelocity;
void main() {
  float left = texture(uPressure, vL).x;
  float right = texture(uPressure, vR).x;
  float top = texture(uPressure, vT).x;
  float bottom = texture(uPressure, vB).x;
  vec2 velocity = texture(uVelocity, vUv).xy - vec2(right - left, top - bottom);
  fragColor = vec4(velocity, 0.0, 1.0);
}
`;

const advectFragment = `${fluidHead}
uniform sampler2D uVelocity;
uniform sampler2D uSource;
uniform vec2 uTexel;
uniform float uDt;
uniform float uFade;
void main() {
  vec2 from = vUv - uDt * texture(uVelocity, vUv).xy * uTexel;
  fragColor = texture(uSource, from) / (1.0 + uFade * uDt);
}
`;

const scaleFragment = `${fluidHead}
uniform sampler2D uSource;
uniform float uValue;
void main() {
  fragColor = texture(uSource, vUv) * uValue;
}
`;

const fieldFragment = `#version 300 es
precision highp float;
uniform vec2 uSize;
uniform vec4 uGrid;
uniform vec2 uOrigin;
uniform vec2 uSlat;
uniform float uTime;
uniform float uScale;
uniform float uDirection;
uniform float uChop;
uniform float uStretch;
uniform float uGlint;
uniform float uContrast;
uniform float uPerspective;
uniform float uFog;
uniform float uIntro;
uniform sampler2D tVelocity;
uniform sampler2D tInk;
uniform vec2 uFluidTexel;
uniform float uFluid;
uniform float uInk;
uniform float uLean;
out vec4 fragColor;

const float TURN[4] = float[4](0.0, -0.95, 0.78, 1.62);
const float LENGTH[4] = float[4](2.6, 1.7, 1.12, 0.76);
const float HEIGHT[4] = float[4](1.0, 0.75, 0.5, 0.3);
const float SHIFT[4] = float[4](0.0, 2.3, 4.1, 1.1);

void main() {
  vec2 cell = floor(gl_FragCoord.xy);
  float row = uGrid.y - 1.0 - cell.y;
  vec2 center = uOrigin + vec2(cell.x, row) * uGrid.zw + uSlat * 0.5;
  float v = clamp(center.y / uSize.y, 0.0, 1.0);

  vec2 flow = vec2(0.0);
  float ink = 0.0;
  if (uFluid > 0.5) {
    vec2 fluidUv = clamp(vec2(center.x / uSize.x, 1.0 - center.y / uSize.y), 0.0, 1.0);
    flow = texture(tVelocity, fluidUv).xy * uFluidTexel * uSize;
    ink = texture(tInk, fluidUv).x;
  }

  float horizon = mix(8.0, 0.5, uPerspective);
  float depth = (1.0 + horizon) / (v + horizon);
  vec2 world = vec2((center.x - uSize.x * 0.5) / uSize.y * depth, (depth - 1.0) * horizon * 2.2);
  world -= flow * 0.00018 * depth;
  world /= max(uScale, 0.05);

  float meander = 0.55 * sin(dot(world, vec2(0.23, 0.41)) * 0.9 + uTime * 0.13)
    + 0.3 * sin(dot(world, vec2(-0.37, 0.19)) * 1.4 - uTime * 0.09);

  float steep = uChop * 0.45;
  float height = 0.0;
  float total = 0.0;
  for (int i = 0; i < 4; i++) {
    float angle = uDirection + TURN[i];
    vec2 heading = vec2(cos(angle), sin(angle));
    float k = 6.2831853 / LENGTH[i];
    float omega = sqrt(9.81 * k) * 0.35;
    float theta = k * dot(world, heading) - omega * uTime + SHIFT[i] + meander * (0.6 + 0.3 * float(i));
    height += HEIGHT[i] * (cos(theta) + steep * cos(2.0 * theta));
    total += HEIGHT[i] * (1.0 + steep);
  }
  float level = clamp(0.5 + 0.5 * height / (total * 0.85), 0.0, 1.0);
  float crest = smoothstep(0.6, 1.0, level);
  float glint = crest * crest * uGlint;

  float haze = mix(1.0, 1.0 - uFog, pow(1.0 - v, 1.4));
  float light = (pow(level, uContrast) + glint * 0.8) * haze;
  float glow = 1.0 - exp(-max(ink, 0.0) * uInk * 1.6);
  light = 1.0 - (1.0 - clamp(light, 0.0, 1.0)) * (1.0 - glow);

  float front = uIntro * 1.35;
  float reveal = 1.0 - smoothstep(front - 0.35, front, v);
  float sweep = exp(-pow((v - front + 0.22) / 0.07, 2.0)) * (1.0 - uIntro);
  light = (light + sweep * 0.8) * reveal;
  light = max(light, 0.045 * reveal);
  float span = mix(1.0 - uStretch, 1.0, level) + glow * 0.3;
  span = clamp(span, 0.08, 1.0) * mix(0.1, 1.0, reveal);
  float tint = clamp(max(glint * 1.4, glow * 0.9) + sweep, 0.0, 1.0);
  float lean = clamp(flow.x / 1400.0, -1.0, 1.0) * uLean * reveal;

  fragColor = vec4(clamp(light, 0.0, 1.0), span, tint, 0.5 + 0.5 * lean);
}
`;

const slatFragment = `#version 300 es
precision highp float;
uniform sampler2D tField;
uniform vec2 uSize;
uniform float uDpr;
uniform vec4 uGrid;
uniform vec2 uOrigin;
uniform vec2 uSlat;
uniform float uRound;
uniform float uTilt;
uniform vec3 uColor;
uniform vec3 uGlintColor;
uniform vec4 uBackground;
out vec4 fragColor;

float pill(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

void main() {
  vec2 p = vec2(gl_FragCoord.x, uSize.y * uDpr - gl_FragCoord.y) / uDpr;
  vec2 local = p - uOrigin;
  vec2 cell = floor(local / uGrid.zw);
  vec4 background = vec4(uBackground.rgb * uBackground.a, uBackground.a);
  vec4 slat = vec4(0.0);
  int reach = uTilt > 0.0 ? 1 : 0;
  for (int dx = -1; dx <= 1; dx++) {
    if (abs(dx) > reach) continue;
    vec2 neighbour = cell + vec2(float(dx), 0.0);
    if (neighbour.x < 0.0 || neighbour.y < 0.0 || neighbour.x >= uGrid.x || neighbour.y >= uGrid.y) continue;
    vec4 field = texelFetch(tField, ivec2(int(neighbour.x), int(uGrid.y - 1.0 - neighbour.y)), 0);
    vec2 offset = local - neighbour * uGrid.zw - uSlat * 0.5;
    float angle = (field.a - 0.5) * 2.0 * uTilt;
    float c = cos(angle);
    float s = sin(angle);
    vec2 turned = vec2(c * offset.x + s * offset.y, c * offset.y - s * offset.x);
    vec2 halfSize = vec2(uSlat.x * 0.5, uSlat.y * 0.5 * field.g);
    float radius = uRound * min(halfSize.x, halfSize.y);
    float alpha = clamp(0.5 - pill(turned, halfSize, radius) * uDpr, 0.0, 1.0) * field.r;
    if (alpha > slat.a) slat = vec4(mix(uColor, uGlintColor, field.b) * alpha, alpha);
  }
  fragColor = slat + background * (1.0 - slat.a);
}
`;

const settingsRef={current:{color:parseColor('#8a8430',[.54,.52,.19,1]),glintColor:parseColor('#eee8a0',[.93,.91,.63,1]),backgroundColor:parseColor('#161719',[.086,.09,.098,1]),slatWidth:7,slatHeight:20,gap:5,roundness:.12,...SWELL_PRESETS.swell,speed:.28,glint:.4,contrast:1.45,fog:.65,interactive:true,cursorStrength:.65,cursorSize:60,swirl:0,trail:1.1,lean:.1,intro:true,introDuration:1,paused:false}};const wakeRef={current:null};
(function(){const container = document.getElementById("micro-bg");
    if (!container) return undefined;

    const renderer = new Renderer({ alpha: true, premultipliedAlpha: true, antialias: false, depth: false });
    const gl = renderer.gl;
    if (!renderer.isWebgl2) {
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      return undefined;
    }
    gl.clearColor(0, 0, 0, 0);
    const canvas = gl.canvas;
    canvas.style.display = 'block';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.setAttribute('aria-hidden', 'true');
    container.appendChild(canvas);

    const geometry = new Triangle(gl);
    const blank = new Texture(gl);
    const floatTargets = !!(
      gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float')
    );

    const dispose = target => {
      gl.deleteFramebuffer(target.buffer);
      gl.deleteTexture(target.texture.texture);
    };

    let fieldTarget = new RenderTarget(gl, {
      width: 1,
      height: 1,
      depth: false,
      minFilter: gl.NEAREST,
      magFilter: gl.NEAREST
    });

    const fieldUniforms = {
      uSize: { value: [1, 1] },
      uGrid: { value: [1, 1, 1, 1] },
      uOrigin: { value: [0, 0] },
      uSlat: { value: [1, 1] },
      uTime: { value: 0 },
      uScale: { value: 1 },
      uDirection: { value: 0 },
      uChop: { value: 0.5 },
      uStretch: { value: 0.3 },
      uGlint: { value: 1 },
      uContrast: { value: 1 },
      uPerspective: { value: 0.7 },
      uFog: { value: 0.5 },
      uIntro: { value: 0 },
      tVelocity: { value: blank },
      tInk: { value: blank },
      uFluidTexel: { value: [1, 1] },
      uFluid: { value: 0 },
      uInk: { value: 1 },
      uLean: { value: 0.5 }
    };
    const fieldMesh = new Mesh(gl, {
      geometry,
      program: new Program(gl, {
        vertex: passVertex,
        fragment: fieldFragment,
        uniforms: fieldUniforms,
        depthTest: false,
        depthWrite: false
      })
    });

    const slatUniforms = {
      tField: { value: fieldTarget.texture },
      uSize: { value: [1, 1] },
      uDpr: { value: 1 },
      uGrid: { value: [1, 1, 1, 1] },
      uOrigin: { value: [0, 0] },
      uSlat: { value: [1, 1] },
      uRound: { value: 1 },
      uTilt: { value: 0 },
      uColor: { value: [1, 1, 1] },
      uGlintColor: { value: [1, 1, 1] },
      uBackground: { value: [0, 0, 0, 1] }
    };
    const slatMesh = new Mesh(gl, {
      geometry,
      program: new Program(gl, {
        vertex: passVertex,
        fragment: slatFragment,
        uniforms: slatUniforms,
        depthTest: false,
        depthWrite: false
      })
    });

    const fluidTexel = { value: [1, 1] };
    const fluidPass = (fragment, uniforms) =>
      new Mesh(gl, {
        geometry,
        program: new Program(gl, {
          vertex: fluidVertex,
          fragment,
          uniforms: { uTexel: fluidTexel, ...uniforms },
          depthTest: false,
          depthWrite: false
        })
      });
    const splatPass = fluidPass(splatFragment, {
      uTarget: { value: blank },
      uAspect: { value: 1 },
      uPoint: { value: [0, 0] },
      uValue: { value: [0, 0, 0] },
      uRadius: { value: 0.01 }
    });
    const curlPass = fluidPass(curlFragment, { uVelocity: { value: blank } });
    const vorticityPass = fluidPass(vorticityFragment, {
      uVelocity: { value: blank },
      uCurl: { value: blank },
      uSwirl: { value: 20 },
      uDt: { value: 0.016 }
    });
    const divergencePass = fluidPass(divergenceFragment, { uVelocity: { value: blank } });
    const pressurePass = fluidPass(pressureFragment, { uPressure: { value: blank }, uDivergence: { value: blank } });
    const projectPass = fluidPass(projectFragment, { uPressure: { value: blank }, uVelocity: { value: blank } });
    const advectPass = fluidPass(advectFragment, {
      uVelocity: { value: blank },
      uSource: { value: blank },
      uDt: { value: 0.016 },
      uFade: { value: 1 }
    });
    const scalePass = fluidPass(scaleFragment, { uSource: { value: blank }, uValue: { value: 0 } });

    let reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

    let width = 1;
    let height = 1;
    let raf = 0;
    let last = performance.now();
    let time = 0;
    let introClock = 0;
    let visible = true;
    let alive = true;
    let fluid = null;
    let fluidUntil = 0;
    let fluidDirty = false;
    let splashTurn = 0;
    const splats = [];
    const pointer = { x: 0, y: 0, tracked: false };

    const run = (mesh, target) => renderer.render({ scene: mesh, target, clear: false });

    const floatTarget = (w, h) =>
      new RenderTarget(gl, {
        width: w,
        height: h,
        depth: false,
        type: gl.HALF_FLOAT,
        format: gl.RGBA,
        internalFormat: gl.RGBA16F,
        minFilter: gl.LINEAR,
        magFilter: gl.LINEAR
      });

    const swapPair = (w, h) => ({
      read: floatTarget(w, h),
      write: floatTarget(w, h),
      swap() {
        const next = this.read;
        this.read = this.write;
        this.write = next;
      }
    });

    const disposeFluid = () => {
      if (!fluid) return;
      [fluid.velocity, fluid.ink, fluid.pressure].forEach(pair => {
        dispose(pair.read);
        dispose(pair.write);
      });
      dispose(fluid.divergence);
      dispose(fluid.curl);
      fluid = null;
    };

    const buildFluid = () => {
      if (!floatTargets) return;
      const aspect = width / height;
      const w = Math.max(8, Math.round(aspect >= 1 ? FLUID_SIZE * aspect : FLUID_SIZE));
      const h = Math.max(8, Math.round(aspect >= 1 ? FLUID_SIZE : FLUID_SIZE / aspect));
      if (fluid && fluid.width === w && fluid.height === h) return;
      disposeFluid();
      fluid = {
        width: w,
        height: h,
        velocity: swapPair(w, h),
        ink: swapPair(w, h),
        pressure: swapPair(w, h),
        divergence: floatTarget(w, h),
        curl: floatTarget(w, h)
      };
      fluidTexel.value = [1 / w, 1 / h];
    };

    let resizePending = false;
    const applyResize = () => {
      width = Math.max(1, container.clientWidth);
      height = Math.max(1, container.clientHeight);
      renderer.dpr = Math.min(window.devicePixelRatio || 1, 1, Math.sqrt(PIXEL_BUDGET / (width * height)));
      renderer.setSize(width, height);
      buildFluid();
    };

    const resize = () => {
      resizePending = true;
      start();
    };

    const layout = s => {
      const slatW = clamp(s.slatWidth, 1, 64);
      const slatH = clamp(s.slatHeight, 2, 240);
      const gapSize = clamp(s.gap, 0, 64);
      const pitchX = slatW + gapSize;
      const pitchY = slatH + gapSize;
      const cols = Math.min(2048, Math.ceil((width + gapSize) / pitchX) + 1);
      const rows = Math.min(2048, Math.ceil((height + gapSize) / pitchY) + 1);
      const originX = (width - (cols * pitchX - gapSize)) / 2;
      const originY = (height - (rows * pitchY - gapSize)) / 2;
      if (fieldTarget.width !== cols || fieldTarget.height !== rows) {
        dispose(fieldTarget);
        fieldTarget = new RenderTarget(gl, {
          width: cols,
          height: rows,
          depth: false,
          minFilter: gl.NEAREST,
          magFilter: gl.NEAREST
        });
        slatUniforms.tField.value = fieldTarget.texture;
      }
      const tilt = Math.min(0.42, Math.asin(clamp((pitchX * 1.5 - slatW * 0.5) / (slatH * 0.5), 0, 1)));
      return { slatW, slatH, tilt, grid: [cols, rows, pitchX, pitchY], origin: [originX, originY] };
    };

    const splat = (pair, point, value, radius) => {
      const u = splatPass.program.uniforms;
      u.uTarget.value = pair.read.texture;
      u.uAspect.value = width / height;
      u.uPoint.value = point;
      u.uValue.value = value;
      u.uRadius.value = radius;
      run(splatPass, pair.write);
      pair.swap();
    };

    const stepFluid = (f, dt, s) => {
      if (s.swirl > 0) {
        curlPass.program.uniforms.uVelocity.value = f.velocity.read.texture;
        run(curlPass, f.curl);

        const vorticity = vorticityPass.program.uniforms;
        vorticity.uVelocity.value = f.velocity.read.texture;
        vorticity.uCurl.value = f.curl.texture;
        vorticity.uSwirl.value = clamp(s.swirl, 0, 2) * 40;
        vorticity.uDt.value = dt;
        run(vorticityPass, f.velocity.write);
        f.velocity.swap();
      }

      divergencePass.program.uniforms.uVelocity.value = f.velocity.read.texture;
      run(divergencePass, f.divergence);

      scalePass.program.uniforms.uSource.value = f.pressure.read.texture;
      scalePass.program.uniforms.uValue.value = 0.8;
      run(scalePass, f.pressure.write);
      f.pressure.swap();

      pressurePass.program.uniforms.uDivergence.value = f.divergence.texture;
      for (let i = 0; i < PRESSURE_STEPS; i++) {
        pressurePass.program.uniforms.uPressure.value = f.pressure.read.texture;
        run(pressurePass, f.pressure.write);
        f.pressure.swap();
      }

      projectPass.program.uniforms.uPressure.value = f.pressure.read.texture;
      projectPass.program.uniforms.uVelocity.value = f.velocity.read.texture;
      run(projectPass, f.velocity.write);
      f.velocity.swap();

      const fade = 1 / clamp(s.trail, 0.1, 10);
      const advect = advectPass.program.uniforms;
      advect.uDt.value = dt;
      advect.uVelocity.value = f.velocity.read.texture;
      advect.uSource.value = f.velocity.read.texture;
      advect.uFade.value = fade * 1.4;
      run(advectPass, f.velocity.write);
      f.velocity.swap();

      advect.uVelocity.value = f.velocity.read.texture;
      advect.uSource.value = f.ink.read.texture;
      advect.uFade.value = fade;
      run(advectPass, f.ink.write);
      f.ink.swap();
    };

    const clearFluid = f => {
      scalePass.program.uniforms.uValue.value = 0;
      [f.velocity, f.ink, f.pressure].forEach(pair => {
        scalePass.program.uniforms.uSource.value = pair.read.texture;
        run(scalePass, pair.write);
        pair.swap();
      });
    };

    let renderedAt = 0;
    const frame = now => {
      raf = 0;
      if (document.hidden) return;
      if (now-renderedAt < 32 && !resizePending) { raf=requestAnimationFrame(frame); return; }
      renderedAt=now; window.microDemo.frames++;
      if (resizePending) {
        resizePending = false;
        applyResize();
      }
      if (!alive) return;
      const s = settingsRef.current;
      const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
      last = now;
      if (!s) return;

      if (!s.paused && !reducedMotion) time += dt * s.speed;
      introClock = s.intro && !reducedMotion ? introClock + dt / Math.max(0.2, s.introDuration) : 1;
      const introLinear = Math.min(introClock, 1);
      const introEase =
        introLinear < 0.5 ? 4 * introLinear * introLinear * introLinear : 1 - Math.pow(-2 * introLinear + 2, 3) / 2;

      if (fluid && splats.length) {
        const radius = Math.pow(clamp(s.cursorSize, 4, 600) / height, 2) * 0.35;
        const aspect = width / height;
        for (const [u, v, du, dv, turn] of splats) {
          if (turn === null) {
            splat(fluid.velocity, [u, v], [du * SPLAT_FORCE, dv * SPLAT_FORCE, 0], radius);
            splat(fluid.ink, [u, v], [0.13, 0, 0], radius);
            continue;
          }
          const jet = radius * 0.55;
          const reach = Math.sqrt(jet * 0.5) * 1.9;
          const push = SPLAT_FORCE * 0.08;
          for (let i = 0; i < SPLASH_JETS; i++) {
            const angle = turn + (i / SPLASH_JETS) * Math.PI * 2;
            const dx = Math.cos(angle);
            const dy = Math.sin(angle);
            const point = [u + (dx * reach) / aspect, v + dy * reach];
            const spin = [(dx - dy) * Math.SQRT1_2 * push, (dy + dx) * Math.SQRT1_2 * push, 0];
            splat(fluid.velocity, point, spin, jet);
            splat(fluid.ink, point, [0.75, 0, 0], jet);
          }
          splat(fluid.ink, [u, v], [0.45, 0, 0], radius);
        }
        splats.length = 0;
        fluidDirty = true;
      }
      const fluidActive = fluid !== null && now < fluidUntil;
      if (fluid) {
        if (fluidActive) stepFluid(fluid, Math.min(Math.max(dt, 1 / 240), 1 / 30), s);
        else if (fluidDirty) {
          clearFluid(fluid);
          fluidDirty = false;
        }
      }

      const grid = layout(s);

      fieldUniforms.uSize.value = [width, height];
      fieldUniforms.uGrid.value = grid.grid;
      fieldUniforms.uOrigin.value = grid.origin;
      fieldUniforms.uSlat.value = [grid.slatW, grid.slatH];
      fieldUniforms.uTime.value = time;
      fieldUniforms.uScale.value = s.scale;
      fieldUniforms.uDirection.value = (s.direction * Math.PI) / 180;
      fieldUniforms.uChop.value = clamp(s.chop, 0, 1.5);
      fieldUniforms.uStretch.value = clamp(s.stretch, 0, 0.95);
      fieldUniforms.uGlint.value = Math.max(0, s.glint);
      fieldUniforms.uContrast.value = clamp(s.contrast, 0.2, 4);
      fieldUniforms.uPerspective.value = clamp(s.perspective, 0, 1);
      fieldUniforms.uFog.value = clamp(s.fog, 0, 1);
      fieldUniforms.uIntro.value = introEase;
      fieldUniforms.uFluid.value = fluidActive ? 1 : 0;
      fieldUniforms.tVelocity.value = fluid ? fluid.velocity.read.texture : blank;
      fieldUniforms.tInk.value = fluid ? fluid.ink.read.texture : blank;
      fieldUniforms.uFluidTexel.value = fluidTexel.value;
      fieldUniforms.uInk.value = clamp(s.cursorStrength, 0, 3);
      fieldUniforms.uLean.value = clamp(s.lean, 0, 1);
      renderer.render({ scene: fieldMesh, target: fieldTarget });

      slatUniforms.uSize.value = [width, height];
      slatUniforms.uDpr.value = renderer.dpr;
      slatUniforms.uGrid.value = grid.grid;
      slatUniforms.uOrigin.value = grid.origin;
      slatUniforms.uSlat.value = [grid.slatW, grid.slatH];
      slatUniforms.uRound.value = clamp(s.roundness, 0, 1);
      slatUniforms.uTilt.value = fluidActive && s.lean > 0 ? grid.tilt : 0;
      slatUniforms.uColor.value = s.color.slice(0, 3);
      slatUniforms.uGlintColor.value = s.glintColor.slice(0, 3);
      slatUniforms.uBackground.value = s.backgroundColor;
      renderer.render({ scene: slatMesh });

      const introRunning = s.intro && !reducedMotion && introClock < 1;
      if (visible && (introRunning || fluidActive || fluidDirty)) raf = requestAnimationFrame(frame);
    };

    const start = () => {
      if (raf || !visible || !alive) return;
      last = performance.now();
      raf = requestAnimationFrame(frame);
    };

    const locate = e => {
      const rect = container.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const w = Math.max(1, rect.width);
      const h = Math.max(1, rect.height);
      return { x, y, u: x / w, v: 1 - y / h, h, inside: x >= 0 && y >= 0 && x <= w && y <= h };
    };

    const queue = (u, v, du, dv, turn) => {
      if (splats.length > 32) splats.shift();
      splats.push([u, v, du, dv, turn]);
      const s = settingsRef.current;
      fluidUntil = performance.now() + Math.max(1.5, (s ? s.trail : 1.4) * 5) * 1000;
      start();
    };

    const onPointerMove = e => {
      const s = settingsRef.current;
      const spot = locate(e);
      if (!fluid || !s || !s.interactive || reducedMotion || !spot.inside) {
        pointer.tracked = false;
        return;
      }
      if (pointer.tracked && (spot.x !== pointer.x || spot.y !== pointer.y)) {
        queue(spot.u, spot.v, (spot.x - pointer.x) / spot.h, (pointer.y - spot.y) / spot.h, null);
      }
      pointer.x = spot.x;
      pointer.y = spot.y;
      pointer.tracked = true;
    };

    const onPointerDown = e => {
      const s = settingsRef.current;
      const spot = locate(e);
      if (!fluid || !s || !s.interactive || reducedMotion || !spot.inside) return;
      splashTurn += 2.39996;
      queue(spot.u, spot.v, 0, 0, splashTurn);
    };

    const onPointerLeave = () => {
      pointer.tracked = false;
    };

    const onPointerOut = e => {
      if (!e.relatedTarget) onPointerLeave();
    };

    const onVisibility = () => { if(document.hidden){cancelAnimationFrame(raf);raf=0;}else start(); };

    window.addEventListener('pointermove', onPointerMove, { passive: true });
    window.addEventListener('pointerdown', onPointerDown, { passive: true });
    window.addEventListener('pointerout', onPointerOut, { passive: true });
    window.addEventListener('blur', onPointerLeave);
    document.addEventListener('visibilitychange', onVisibility);

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(container);
    const intersectionObserver = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      start();
    });
    intersectionObserver.observe(container);

    wakeRef.current = start;
    const syncMotion=()=>{reducedMotion=window.matchMedia('(prefers-reduced-motion: reduce)').matches;fluidUntil=0;splats.length=0;start();};
    new MutationObserver(syncMotion).observe(document.body,{attributes:true,attributeFilter:['class']});
    window.matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change',syncMotion);
    window.microDemo.status='webgl2';window.microDemo.fluid=!!floatTargets;
    canvas.addEventListener('webglcontextlost',e=>{e.preventDefault();alive=false;cancelAnimationFrame(raf);window.microDemo.status='context-lost';document.getElementById('bg-status').textContent='背景已降级为静态底色';});
    resize();

    return () => {
      alive = false;
      visible = false;
      cancelAnimationFrame(raf);
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointerout', onPointerOut);
      window.removeEventListener('blur', onPointerLeave);
      document.removeEventListener('visibilitychange', onVisibility);
      wakeRef.current = null;
      disposeFluid();
      dispose(fieldTarget);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
    };})();if(window.microDemo.status==='loading'){window.microDemo.status='unsupported';document.getElementById('bg-status').textContent='WebGL2 不可用 · 使用静态底色';}}catch(e){window.microDemo.status='error';window.microDemo.error=String(e);document.getElementById('bg-status').textContent='背景不可用 · 使用静态底色';console.error(e)}})();
  if (window.microDemo.status === 'skip') window.microDemo.status = 'loading';
})();
(function(){
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
(()=>{const INTRO_PEAK = 2;
const BURST_ATTACK = 70;
const BURST_DECAY = 240;

const followsText = value => !value || /^(currentcolor|inherit)$/i.test(value);

let colorProbe = null;

const toRgb = value => {
  if (!colorProbe) {
    const probe = document.createElement('canvas');
    probe.width = 1;
    probe.height = 1;
    colorProbe = probe.getContext('2d', { willReadFrequently: true });
  }
  if (!colorProbe) return [255, 255, 255];
  colorProbe.clearRect(0, 0, 1, 1);
  colorProbe.fillStyle = '#000';
  colorProbe.fillStyle = value;
  colorProbe.fillRect(0, 0, 1, 1);
  const [r, g, b] = colorProbe.getImageData(0, 0, 1, 1).data;
  return [r, g, b];
};

const channelColor = (rgb, channel, additive) =>
  `rgb(${rgb.map((value, index) => (index === channel ? value : additive ? 0 : 255)).join(',')})`;


const records=new Map();function attach(host){
  let text=host.textContent;
  if(host.scrollWidth > host.clientWidth + 1 && host.clientWidth > 0){
    const probeCtx=document.createElement("canvas").getContext("2d");
    const hcs=getComputedStyle(host);
    probeCtx.font=`${hcs.fontWeight} ${hcs.fontSize} ${hcs.fontFamily}`;
    let t=text;
    while(t.length>1 && probeCtx.measureText(t+"…").width > host.clientWidth){t=t.slice(0,-1);}
    text=t+"…";
  }const cs=getComputedStyle(host);const fontSize=parseFloat(cs.fontSize),fontWeight=cs.fontWeight,fontFamily=cs.fontFamily,color=cs.color;const enableHover=true,baseIntensity=0,hoverIntensity=host.id==='greeting'?.32:(host.classList&&host.classList.contains('name')?.18:.22),fuzzRange=host.id==='greeting'?18:(host.classList&&host.classList.contains('name')?10:12),fps=30,direction='horizontal',transitionDuration=0,clickEffect=false,gradientKey='',letterSpacing=0,sliceSize=1,trigger='hover',intro=true,introDuration=host.id==='greeting'?650:420,colorSplit=0,splitOn=false;const glitchRef={current:false},introRef={current:{start:0,done:false}},tuningRef={current:{enableHover,baseIntensity,hoverIntensity,fps,transitionDuration,clickEffect,sliceSize,trigger,intro,introDuration,colorSplit}};const canvas=document.createElement('canvas');canvas.className='fuzzy-canvas';canvas.setAttribute('aria-hidden','true');host.appendChild(canvas);const canvasRef={current:canvas};return (()=>{const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    const source = document.createElement('canvas');
    const sourceCtx = source.getContext('2d');
    const scratch = document.createElement('canvas');
    const scratchCtx = scratch.getContext('2d');
    const channels = splitOn
      ? [0, 1, 2].map(() => {
          const layer = document.createElement('canvas');
          return { canvas: layer, ctx: layer.getContext('2d') };
        })
      : [];
    if (!canvas || !ctx || !sourceCtx || !scratchCtx || channels.some(channel => !channel.ctx)) return;

    let reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    const usesInk = followsText(color) && !gradientKey;
    const splitPad = splitOn ? Math.ceil(fuzzRange * 0.5) + 4 : 0;
    const padX = fuzzRange + 20 + (direction === 'vertical' ? 0 : splitPad);
    const padY = direction === 'horizontal' ? 0 : fuzzRange + 10 + (direction === 'vertical' ? splitPad : 0);
    const inset = 5;
    let cancelled = false;
    let built = false;
    let visible = true;
    let frame = 0;
    let resizeFrame = 0;
    let lastFrame = 0;
    let lastInkCheck = 0;
    let clickTimer;
    let hovering = false;
    let clicking = false;
    let burstAt = 0;
    let eased = reduceMotion ? 0 : tuningRef.current.baseIntensity;
    let intensity = eased;
    let coarse = 1;
    let drawn = -1;
    let ink = '';
    let blend = 'lighter';
    let dpr = 1;
    let fontPx = 16;
    let rows = new Int32Array(1);
    let cols = new Int32Array(1);
    let box = { left: 0, ascent: 0, width: 0, height: 0, cssWidth: 0, cssHeight: 0 };

    const family = () => (fontFamily === 'inherit' ? getComputedStyle(canvas).fontFamily || 'sans-serif' : fontFamily);
    const font = () => `${fontWeight} ${fontPx}px ${family()}`;
    const resolveInk = () => (usesInk ? getComputedStyle(canvas).color || '#000' : color);
    const pixelRatio = () => Math.max(2, Math.min(window.devicePixelRatio || 1, 3));
    const introPending = () => !introRef.current.done && tuningRef.current.intro && !reduceMotion;

    const measureFontSize = () => {
      if (typeof fontSize === 'number') return fontSize;
      const probe = document.createElement('span');
      probe.style.fontSize = fontSize;
      (canvas.parentElement || document.body).appendChild(probe);
      const size = parseFloat(getComputedStyle(probe).fontSize);
      probe.remove();
      return Number.isFinite(size) && size > 0 ? size : 16;
    };

    const paintText = (target, targetCtx, tone) => {
      target.width = source.width;
      target.height = source.height;
      targetCtx.setTransform(1, 0, 0, 1, 0, 0);
      targetCtx.clearRect(0, 0, target.width, target.height);
      targetCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      targetCtx.font = font();
      targetCtx.textBaseline = 'alphabetic';
      if (gradientKey) {
        const stops = gradientKey.split('|');
        const fill = targetCtx.createLinearGradient(0, 0, box.width + inset * 2, 0);
        stops.forEach((stop, index) => fill.addColorStop(index / (stops.length - 1), tone(stop)));
        targetCtx.fillStyle = fill;
      } else {
        targetCtx.fillStyle = tone(ink);
      }
      if (letterSpacing !== 0) {
        let x = inset;
        for (const char of text) {
          targetCtx.fillText(char, x, box.ascent);
          x += targetCtx.measureText(char).width + letterSpacing;
        }
      } else {
        targetCtx.fillText(text, inset + box.left, box.ascent);
      }
    };

    const paintSource = () => {
      paintText(source, sourceCtx, value => value);
      if (!splitOn) return;
      const tones = (gradientKey ? gradientKey.split('|') : [ink]).map(toRgb);
      const light =
        tones.reduce((sum, [r, g, b]) => sum + (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255, 0) / tones.length >= 0.5;
      blend = light ? 'lighter' : 'multiply';
      channels.forEach((channel, index) =>
        paintText(channel.canvas, channel.ctx, value => channelColor(toRgb(value), index, light))
      );
    };

    const fuzz = (image, shift, jitter, step, amp) => {
      const sw = image.width;
      const sh = image.height;
      const ox = Math.round(padX * dpr);
      const oy = Math.round(padY * dpr);
      const sx = direction === 'vertical' ? 0 : shift;
      const sy = direction === 'vertical' ? shift : 0;
      const wobble = () => (jitter ? Math.round((Math.random() - 0.5) * jitter) : 0);
      if (amp < 0.5) {
        ctx.drawImage(image, ox + sx, oy + sy);
        return;
      }
      if (direction === 'vertical') {
        for (let x = 0, index = 0; x < sw; x += step, index++) {
          const w = Math.min(step, sw - x);
          ctx.drawImage(image, x, 0, w, sh, ox + x, oy + cols[index] + wobble() + sy, w, sh);
        }
        return;
      }
      const both = direction === 'both';
      const target = both ? scratchCtx : ctx;
      if (both) scratchCtx.clearRect(0, 0, scratch.width, scratch.height);
      for (let y = 0, index = 0; y < sh; y += step, index++) {
        const h = Math.min(step, sh - y);
        target.drawImage(image, 0, y, sw, h, ox + rows[index] + wobble() + sx, both ? y : oy + y, sw, h);
      }
      if (!both) return;
      const reach = Math.ceil(amp / 2 + Math.abs(sx) + jitter / 2) + 1;
      const from = Math.max(0, Math.floor((ox - reach) / step) * step);
      const to = Math.min(scratch.width, ox + sw + reach);
      for (let x = from; x < to; x += step) {
        const w = Math.min(step, to - x);
        ctx.drawImage(scratch, x, 0, w, sh, x, oy + cols[x / step], w, sh);
      }
    };

    const draw = () => {
      const tuning = tuningRef.current;
      const step = Math.max(1, Math.round(Math.max(1, tuning.sliceSize) * coarse * dpr));
      const amp = intensity * fuzzRange * dpr;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      drawn = intensity;
      if (amp >= 0.5) {
        if (direction === 'vertical') {
          for (let index = 0; index * step < source.width; index++) {
            cols[index] = Math.round((Math.random() - 0.5) * amp);
          }
        } else {
          for (let index = 0; index * step < source.height; index++) {
            rows[index] = Math.round((Math.random() - 0.5) * amp);
          }
          if (direction === 'both') {
            for (let index = 0; index * step < canvas.width; index++) {
              cols[index] = Math.round((Math.random() - 0.5) * amp * 0.5);
            }
          }
        }
      }
      const split = splitOn ? Math.round(tuning.colorSplit * (2 + intensity * fuzzRange * 0.18) * dpr) : 0;
      if (split < 1) {
        fuzz(source, 0, 0, step, amp);
        return;
      }
      const jitter = tuning.colorSplit * amp * 0.2;
      ctx.globalCompositeOperation = blend;
      fuzz(channels[0].canvas, -split, jitter, step, amp);
      fuzz(channels[1].canvas, 0, 0, step, amp);
      fuzz(channels[2].canvas, split, jitter, step, amp);
      ctx.globalCompositeOperation = 'source-over';
    };

    const build = () => {
      dpr = pixelRatio();
      fontPx = measureFontSize();
      sourceCtx.setTransform(1, 0, 0, 1, 0, 0);
      sourceCtx.font = font();
      const metrics = sourceCtx.measureText(text);
      const left = metrics.actualBoundingBoxLeft ?? 0;
      let width = left + (metrics.actualBoundingBoxRight ?? metrics.width);
      if (letterSpacing !== 0) {
        width = -letterSpacing;
        for (const char of text) width += sourceCtx.measureText(char).width + letterSpacing;
      }
      const ascent = metrics.actualBoundingBoxAscent ?? fontPx;
      const descent = metrics.actualBoundingBoxDescent ?? fontPx * 0.2;
      const textWidth = Math.max(1, Math.ceil(width));
      const textHeight = Math.max(1, Math.ceil(ascent + descent));
      box = {
        left,
        ascent,
        width: textWidth,
        height: textHeight,
        cssWidth: textWidth + inset * 2 + padX * 2,
        cssHeight: textHeight + padY * 2
      };
      source.width = Math.ceil((textWidth + inset * 2) * dpr);
      source.height = Math.ceil(textHeight * dpr);
      canvas.width = Math.ceil(box.cssWidth * dpr);
      canvas.height = Math.ceil(box.cssHeight * dpr);
      scratch.width = canvas.width;
      scratch.height = source.height;
      rows = new Int32Array(source.height + 1);
      cols = new Int32Array(canvas.width + 1);
      canvas.style.width = `${box.cssWidth}px`;canvas.style.left=`${-padX-inset}px`;
      canvas.style.height = `${box.cssHeight}px`;
      if (introPending() && !introRef.current.start) canvas.style.opacity = '0';
      ink = resolveInk();
      paintSource();
      built = true;host.classList.add("fuzzy-ready");
      draw();
    };

    const tick = now => {
      frame = 0;
      if (cancelled || !visible || document.hidden) return;
      const tuning = tuningRef.current;
      const interval = 1000 / Math.max(1, tuning.fps);
      if (now - lastFrame < interval - 1) {frame=requestAnimationFrame(tick);return;}
      lastFrame = Math.max(lastFrame + interval, now - interval);
      if (usesInk && now - lastInkCheck > 250) {
        lastInkCheck = now;
        const next = resolveInk();
        if (next !== ink) {
          ink = next;
          paintSource();
          drawn = -1;
        }
      }
      const base = reduceMotion ? 0 : tuning.baseIntensity;
      const active = reduceMotion ? 0 :
        tuning.trigger === 'always'
          ? reduceMotion
            ? base
            : tuning.hoverIntensity
          : tuning.trigger !== 'click' && hovering && tuning.enableHover
            ? tuning.hoverIntensity
            : base;
      const goal = clicking || glitchRef.current ? 1 : active;
      if (tuning.transitionDuration > 0) {
        eased += (goal - eased) * (1 - Math.pow(0.05, 1 / tuning.transitionDuration));
        if (Math.abs(goal - eased) < 0.002) eased = goal;
      } else {
        eased = goal;
      }
      let level = eased;
      let energy = 0;
      if (burstAt) {
        const age = now - burstAt;
        const envelope =
          age < BURST_ATTACK ? 1 - Math.pow(1 - age / BURST_ATTACK, 2) : Math.exp(-(age - BURST_ATTACK) / BURST_DECAY);
        if (age >= BURST_ATTACK && envelope < 0.004) {
          burstAt = 0;
        } else {
          const peak = Math.min(2, 0.6 + tuning.hoverIntensity * 1.4);
          level += (Math.max(peak, level) - level) * envelope;
          energy = envelope;
        }
      }
      const introState = introRef.current;
      if (!introState.done) {
        if (!tuning.intro || reduceMotion) {
          introState.done = true;
          canvas.style.opacity = '';
        } else {
          if (!introState.start) introState.start = now;
          const progress = Math.min(1, (now - introState.start) / Math.max(1, tuning.introDuration));
          const envelope = Math.pow(1 - progress, 2.5);
          level += (INTRO_PEAK - level) * envelope;
          energy = Math.max(energy, envelope);
          canvas.style.opacity = progress < 0.3 ? (1 - Math.pow(1 - progress / 0.3, 2)).toFixed(3) : '';
          if (progress >= 1) introState.done = true;
        }
      }
      intensity = level;
      coarse = 1 + 3 * energy * energy;
      if (intensity === 0 && drawn === 0) return;
      draw();window.fuzzyDemo.draws++;canvas.dataset.intensity=intensity.toFixed(3);if(intensity>0 || introPending())frame=requestAnimationFrame(tick);
    };

    /* 只在进入视口时恢复循环。绝不能因为 isIntersecting=false 就置 visible=false：
       首次回调在布局尚未稳定时会误报，一旦置假，tick 永久不启动，
       画布只显示 build 时那一帧清晰版——表现就是「fuzzy 完全没效果」。
       离场也无所谓：tick 在 intensity 归零后本来就只多跑一帧就退出，静止零开销。 */
    const observer =
      typeof IntersectionObserver !== 'undefined'
        ? new IntersectionObserver(([entry]) => {
            if (!entry.isIntersecting) return;
            visible = true;
            if (built && !frame && !cancelled) frame = requestAnimationFrame(tick);
          })
        : null;
    observer?.observe(canvas);

    const isOverText = event => {
      const rect = canvas.getBoundingClientRect();
      if (!built || !rect.width || !rect.height) return false;
      const x = ((event.clientX - rect.left) * box.cssWidth) / rect.width;
      const y = ((event.clientY - rect.top) * box.cssHeight) / rect.height;
      const left = padX + inset;
      return x >= left && x <= left + box.width && y >= padY && y <= padY + box.height;
    };

    const handlePointerMove = event => {
      hovering = isOverText(event);if(!frame&&!document.hidden)frame=requestAnimationFrame(tick);
    };

    const handlePointerUp = event => {
      if (event.pointerType !== 'mouse') hovering = false;if(!frame)frame=requestAnimationFrame(tick);
    };

    const handlePointerLeave = () => {
      hovering = false;if(!frame)frame=requestAnimationFrame(tick);
    };

    /* 鼠标移出窗口或窗口失焦时，部分环境不补发 pointerleave，
       hovering 会一直为 true，画布就卡在扰动帧。这里兜底重置。 */
    const handleWindowBlur = () => {
      hovering = false; clicking = false;
      if (!frame && !document.hidden) frame = requestAnimationFrame(tick);
    };
    window.addEventListener('blur', handleWindowBlur);
    document.addEventListener('pointerleave', handleWindowBlur, true);

    const handleClick = () => {
      const tuning = tuningRef.current;
      if (tuning.trigger === 'click') {
        burstAt = performance.now();
        return;
      }
      if (!tuning.clickEffect) return;
      clicking = true;
      clearTimeout(clickTimer);
      clickTimer = setTimeout(() => {
        clicking = false;
      }, 150);
    };

    const handleResize = () => {
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => {
        if (built && (measureFontSize() !== fontPx || pixelRatio() !== dpr)) build();
      });
    };

    host.addEventListener('pointermove', handlePointerMove);
    host.addEventListener('pointerdown', handlePointerMove);
    host.addEventListener('pointerup', handlePointerUp);
    host.addEventListener('pointerleave', handlePointerLeave);
    host.addEventListener('pointercancel', handlePointerLeave);
    host.addEventListener('click', handleClick);
    window.addEventListener('resize', handleResize);

    const start = async () => {
      fontPx = measureFontSize();
      try {
        await document.fonts?.load(font());
      } catch {
        await document.fonts?.ready;
      }
      if (cancelled) return;
      build();
      if (visible && !frame) frame = requestAnimationFrame(tick);
    };

const sync=()=>{reduceMotion=matchMedia('(prefers-reduced-motion: reduce)').matches;if(reduceMotion){hovering=false;introRef.current.done=true;canvas.style.opacity='';}drawn=-1;if(!frame)frame=requestAnimationFrame(tick);};
    const motionObserver=new MutationObserver(sync);motionObserver.observe(document.body,{attributes:true,attributeFilter:['class']});const mq=matchMedia('(prefers-reduced-motion: reduce)');mq.addEventListener('change',sync);
    const visibility=()=>{if(document.hidden){cancelAnimationFrame(frame);frame=0;}else if(!frame)frame=requestAnimationFrame(tick);};document.addEventListener('visibilitychange',visibility);
    sync();start();

    return () => {
      cancelled = true;motionObserver.disconnect();mq.removeEventListener("change",sync);document.removeEventListener("visibilitychange",visibility);
      cancelAnimationFrame(frame);
      cancelAnimationFrame(resizeFrame);
      clearTimeout(clickTimer);
      observer?.disconnect();
      host.removeEventListener('pointermove', handlePointerMove);
      host.removeEventListener('pointerdown', handlePointerMove);
      host.removeEventListener('pointerup', handlePointerUp);
      host.removeEventListener('pointerleave', handlePointerLeave);
      host.removeEventListener('pointercancel', handlePointerLeave);
      host.removeEventListener('click', handleClick);
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('blur', handleWindowBlur);
      document.removeEventListener('pointerleave', handleWindowBlur, true);
    };})();}function refresh(){
  for(const [el,cleanup] of Array.from(records.entries())){
    if(!el.isConnected){
      if(typeof cleanup==='function') cleanup();
      records.delete(el);
    }
  }
  document.querySelectorAll("#brandTitle,#greeting,.name").forEach(el=>{
    if(!records.has(el)) records.set(el,attach(el));
  });
}
refresh();
const gamesContainer=document.getElementById("games");
if(gamesContainer) new MutationObserver(refresh).observe(gamesContainer,{childList:true});
})();
})();
