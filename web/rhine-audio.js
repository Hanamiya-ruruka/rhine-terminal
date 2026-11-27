/* Rhine Audio — 莱茵档案终端的合成音效（无素材文件，纯 WebAudio 生成）
   受音效总开关控制：html[data-audio="off"] 时全部静音。
   对外接口：window.RhineAudio = { pulse, soft, scatter, close, setEnabled }  */
(function () {
  'use strict';

  var ctx = null;
  var master = null;
  var synthBus = null;
  var voiceBus = null;
  var MASTER_GAIN = 0.32;      // 总体音量，偏克制

  function enabled() {
    return document.documentElement.getAttribute('data-audio') !== 'off';
  }

  function ensure() {
    if (!enabled()) return null;
    if (!ctx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = MASTER_GAIN;
      // 轻压高频毛刺，贴近工业设备而不是电子玩具
      var shelf = ctx.createBiquadFilter();
      shelf.type = 'highshelf';
      shelf.frequency.value = 6200;
      shelf.gain.value = -4;
      synthBus = ctx.createGain();
      synthBus.gain.value = 1;
      voiceBus = ctx.createGain();
      voiceBus.gain.value = 1;
      synthBus.connect(master);
      voiceBus.connect(master);
      master.connect(shelf);
      shelf.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  // 噪声缓冲只建一次，颗粒与瞬态都从它切片
  var noiseBuffer = null;
  function noise() {
    if (!noiseBuffer) {
      var len = Math.floor(ctx.sampleRate * 0.5);
      noiseBuffer = ctx.createBuffer(1, len, ctx.sampleRate);
      var d = noiseBuffer.getChannelData(0);
      for (var i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
    return noiseBuffer;
  }

  function env(node, t0, peak, attack, decay) {
    var g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
    node.connect(g);
    g.connect(synthBus || master);
    return g;
  }

  function grain(t0, dur, freq, q, peak, type) {
    var src = ctx.createBufferSource();
    src.buffer = noise();
    src.playbackRate.value = 1;
    var bp = ctx.createBiquadFilter();
    bp.type = type || 'bandpass';
    bp.frequency.value = freq;
    bp.Q.value = q || 4;
    src.connect(bp);
    env(bp, t0, peak, Math.min(0.004, dur * 0.25), dur);
    src.start(t0, Math.random() * 0.4, dur + 0.02);
    src.stop(t0 + dur + 0.05);
  }

  function tone(t0, f0, f1, dur, peak, type) {
    var o = ctx.createOscillator();
    o.type = type || 'sine';
    o.frequency.setValueAtTime(f0, t0);
    if (f1 && f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(f1, 1), t0 + dur);
    env(o, t0, peak, 0.006, dur);
    o.start(t0);
    o.stop(t0 + dur + 0.05);
  }

  function swell(t0, f0, f1, dur, peak) {
    var o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(f0, t0);
    o.frequency.exponentialRampToValueAtTime(Math.max(f1, 1), t0 + dur);
    var g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + 0.06);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g);
    g.connect(synthBus || master);
    o.start(t0);
    o.stop(t0 + dur + 0.05);
  }

  /* 只保留 TTS 播报：合成音效全部关闭（改回 true 即可恢复） */
  var SFX_ENABLED = false;

  /* 点击脉冲：机械继电器 + 低频体感
     一条 5ms 的高频瞬态打头，跟一个 180→110Hz 的下坠体感 */
  function pulse() {
    if (!SFX_ENABLED) return;
    if (!ensure()) return;
    var t = ctx.currentTime + 0.001;
    grain(t, 0.012, 2400, 1.6, 0.55);          // 触点
    grain(t + 0.004, 0.03, 900, 2.2, 0.22);    // 机构回弹
    tone(t, 186, 112, 0.14, 0.30);             // 低频体感
    tone(t + 0.002, 1180, 1180, 0.026, 0.06);  // 一点金属尖
  }

  /* 轻量版：快捷按钮（完成/启动）用，少一层体感 */
  function soft() {
    if (!SFX_ENABLED) return;
    if (!ensure()) return;
    var t = ctx.currentTime + 0.001;
    grain(t, 0.010, 2000, 1.8, 0.35);
    tone(t, 240, 190, 0.07, 0.16);
  }

  /* 鳍片散开：低频涌起 + 颗粒由密到疏、中心频率下行
     视觉上是整环同步起散、种子微错峰，所以颗粒只做 ±12ms 抖动 */
  function scatter(delaySec) {
    if (!SFX_ENABLED) return;
    if (!ensure()) return;
    var D = 0.42;
    var wait = (typeof delaySec === 'number' && delaySec >= 0) ? delaySec : 0.14;
    var t0 = ctx.currentTime + wait;

    swell(t0, 96, 54, D * 0.95, 0.34);                // 低沉涌动，60ms 缓慢起音，避开点击瞬态
    grain(t0, D * 0.7, 640, 0.9, 0.10, 'lowpass');    // 底噪气流

    var n = 26;
    for (var i = 0; i < n; i++) {
      var k = i / (n - 1);                            // 0 → 1
      var at = Math.max(ctx.currentTime, t0 + Math.pow(k, 0.85) * D * 0.78 + (Math.random() - 0.5) * 0.012);
      var f = 3600 - k * 2500;                        // 3600 → 1100Hz 下行
      var gain = 0.20 * (1 - k * 0.72);
      grain(at, 0.022 + Math.random() * 0.012, f, 3.4, gain);
    }

    grain(t0 + D * 0.55, 0.18, 1500, 0.7, 0.05, 'bandpass');  // 收尾余韵
  }

  /* 关闭面板：颗粒先聚后散、上行短促，比散开短一半 */
  function close(delaySec) {
    if (!SFX_ENABLED) return;
    if (!ensure()) return;
    var wait = (typeof delaySec === 'number' && delaySec >= 0) ? delaySec : 0.06;
    var t0 = ctx.currentTime + wait;
    tone(t0, 70, 104, 0.16, 0.22);
    for (var i = 0; i < 12; i++) {
      var k = i / 11;
      var at = Math.max(ctx.currentTime, t0 + k * 0.15 + (Math.random() - 0.5) * 0.01);
      grain(at, 0.018, 1100 + k * 1900, 3.0, 0.14 * (1 - k * 0.5));
    }
  }

  /* ---------- TTS 播报 ---------- */
  // 面板打开这类一次性音效单独一个通道（不受 SFX_ENABLED 影响，仍受总开关控制）
  var SFX_FILES = { panelOpen: 'panel_open.wav', panelClose: 'panel_close.wav',
    launchCue: 'launch_cue.wav',
    dailyOk: 'daily_ok.wav', dailyUndo: 'daily_undo.wav',
    ringPulse: 'ring_pulse.wav',
    holdPulse: 'hold_pulse.wav',
    errorBraam: 'error_braam.wav',
    bootUnlock: 'boot_unlock.wav',
    bootBlade: 'boot_blade.wav',
    bootAssemble: 'boot_assemble.wav',
    morphHold: 'morph_hold.wav',
    morphToTurbine: 'morph_to_turbine.wav',
    morphToDna: 'morph_to_dna.wav',
    morphToMobius: 'morph_to_mobius.wav',
    morphLock: 'morph_lock.wav',
    uiClick: 'ui_click.wav',
    uiToggle: 'ui_toggle.wav',
    uiConfirm: 'ui_confirm.wav',
    uiAlert: 'ui_alert.wav' };

  var VOICE_FILES = {
    bed: 'boot_bed.wav',
    pen: 'boot_pen.wav',
    boot: 'boot_end.wav',
    daily1: 'daily_on1.wav',
    daily2: 'daily_on2.wav',
    dailyoff1: 'daily_off1.wav',
    dailyoff2: 'daily_off2.wav',
    launch1: 'launch1.wav',
    launch2: 'launch2.wav',
    panel1: 'panel1.wav',
    panel2: 'panel2.wav',
    panel3: 'panel3.wav',
    exit: 'exit.wav',
    holdVoice: 'hold_voice.wav',   // 长按环心 0.95s 后的那一句
    returnVoice: 'return_voice.wav',   // 异常页点 RETURN
    morphTimed: 'morph_timed.wav',
    morphLedger: 'morph_ledger.wav',
    morphDaily: 'morph_daily.wav',
    timedFault: 'timed_fault.wav',
    timedSync: 'timed_sync.wav',
    ledgerRecord: 'ledger_record.wav'
  };
  var voiceBuffers = {};
  var voiceLoading = {};

  function loadVoice(key, fileOverride) {
    var url = fileOverride || VOICE_FILES[key];
    if (!url) return Promise.resolve(null);
    if (url.indexOf('/') < 0) url = 'audio/' + url;
    if (voiceBuffers[key]) return Promise.resolve(voiceBuffers[key]);
    if (!voiceLoading[key]) {
      voiceLoading[key] = fetch(url, { cache: 'force-cache' })
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); })
        .then(function (ab) { return ctx.decodeAudioData(ab); })
        .then(function (buf) { voiceBuffers[key] = buf; return buf; })
        .catch(function () { return null; });
    }
    return voiceLoading[key];
  }

  // 语音清单：整批重生成后只改 web/audio/voices.json，代码不动。
  // 读不到就用内置默认表，行为不变。
  function loadManifest() {
    if (loadManifest.done) return loadManifest.done;
    loadManifest.done = fetch('audio/voices.json', { cache: 'no-cache' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (m) {
        var voices = m && m.voices, sfxMap = m && m.sfx;
        if (voices) {
          Object.keys(voices).forEach(function (k) {
            var files = [].concat(voices[k] || []).filter(Boolean);
            if (files.length) VOICE_FILES[k] = files[0];
          });
        }
        if (sfxMap) {
          Object.keys(sfxMap).forEach(function (k) {
            var files = [].concat(sfxMap[k] || []).filter(Boolean);
            if (files.length) SFX_FILES[k] = files[0];
          });
        }
        return true;
      })
      .catch(function () { return false; });
    return loadManifest.done;
  }

  function preloadVoices() {
    if (!ensure()) return;
    loadManifest().then(function () { preloadVoiceFiles(); });
  }

  function preloadVoiceFiles() {
    if (!ctx) return;
    Object.keys(VOICE_FILES).filter(function (k) { return k !== 'bed'; }).forEach(function (k) { loadVoice(k); });
    ['morphHold', 'morphToTurbine', 'morphToDna', 'morphToMobius', 'morphLock',
      'uiClick', 'uiToggle', 'uiConfirm', 'uiAlert'].forEach(function (k) {
      if (SFX_FILES[k]) loadVoice('sfx:' + k, SFX_FILES[k]);
    });
  }

  function voice(key, delaySec, gainScale) {
    if (!ensure()) return;
    var delay = typeof delaySec === 'number' && delaySec >= 0 ? delaySec : 0;
    loadVoice(key).then(function (buf) {
      if (!buf || !enabled()) return;
      var t = ctx.currentTime + delay;
      var src = ctx.createBufferSource();
      src.buffer = buf;
      var g = ctx.createGain();
      g.gain.value = typeof gainScale === 'number' ? gainScale : 1;
      src.connect(g);
      g.connect(voiceBus || master);
      src.start(t);
      // 人声期间把合成音压下去，避免两套声音抢
      if (synthBus) {
        var now = ctx.currentTime;
        var end = t + buf.duration;
        synthBus.gain.cancelScheduledValues(now);
        synthBus.gain.setValueAtTime(synthBus.gain.value, now);
        synthBus.gain.linearRampToValueAtTime(0.25, now + 0.08);
        synthBus.gain.setValueAtTime(0.25, Math.max(now + 0.1, end - 0.1));
        synthBus.gain.linearRampToValueAtTime(1, end + 0.3);
      }
    });
  }

  /* 一次性音效（面板打开等）：不经过 SFX_ENABLED，但仍受音效总开关控制 */
  function sfx(key, gainScale, opts) {
    if (!ensure()) return;
    var file = SFX_FILES[key];
    if (!file) return;
    var isBoot = !!(opts && opts.boot);
    loadVoice('sfx:' + key, file).then(function (buf) {
      if (!buf || !enabled()) return;
      var src = ctx.createBufferSource();
      src.buffer = buf;
      var g = ctx.createGain();
      g.gain.value = typeof gainScale === 'number' ? gainScale : 2.0;
      src.connect(g);
      if (isBoot) {
        if (!bootBus) {
          bootBus = ctx.createGain();
          bootBus.connect(master);
        }
        g.connect(bootBus);
      } else {
        g.connect(synthBus || master);
      }
      src.start(0);
    });
  }

  function preloadBootSfx() {
    if (!ensure()) return;
    loadManifest().then(function () {
      ['bootUnlock', 'bootBlade', 'bootAssemble'].forEach(function (k) {
        if (SFX_FILES[k]) loadVoice('sfx:' + k, SFX_FILES[k]);
      });
    });
  }

  var holdCueSource = null;
  function startHoldCue(gainScale) {
    if (!ensure()) return;
    stopHoldCue();
    var file = SFX_FILES.morphHold;
    if (!file) return;
    var token = {};
    holdCueSource = token;
    loadVoice('sfx:morphHold', file).then(function (buf) {
      if (!buf || !enabled() || holdCueSource !== token) return;
      var src = ctx.createBufferSource();
      src.buffer = buf;
      var g = ctx.createGain();
      g.gain.value = typeof gainScale === 'number' ? gainScale : 1.8;
      src.connect(g);
      g.connect(synthBus || master);
      src.onended = function () { if (holdCueSource === src) holdCueSource = null; };
      holdCueSource = src;
      src.start(0);
    });
  }

  function stopHoldCue() {
    if (!holdCueSource) return;
    if (typeof holdCueSource.stop === 'function') {
      try { holdCueSource.stop(); } catch (e) {}
      try { holdCueSource.disconnect(); } catch (e) {}
    }
    holdCueSource = null;
  }

  /* 启动铺底：整段播放一次，gainScale 控制相对音量 */
  var bedSource = null;
  function bed(gainScale) {
    if (!ensure()) return;
    stopBed();
    loadVoice('bed').then(function (buf) {
      if (!buf || !enabled()) return;
      bedSource = ctx.createBufferSource();
      bedSource.buffer = buf;
      var g = ctx.createGain();
      g.gain.value = typeof gainScale === 'number' ? gainScale : 1;
      bedSource.connect(g);
      g.connect(ctx.destination);   // 铺底走独立输出：master 全局增益只有 0.32，经过它会被压到听不见
      bedSource.start(0);
    });
  }

  function stopBed() {
    if (!bedSource) return;
    try { bedSource.stop(); } catch (e) {}
    try { bedSource.disconnect(); } catch (e) {}
    bedSource = null;
  }

  function setVolume(v) {
    MASTER_GAIN = Math.max(0, Math.min(1, v));
    if (master) master.gain.value = MASTER_GAIN;
  }

  // 供页面判断：音频上下文是否真的在跑（自动播放策略会把首次播放静默掉）
  function isRunning() { return !!(ctx && ctx.state === 'running'); }

  function setEnabled(on) {
    if (!on) {
      stopBootSounds();
      if (ctx && ctx.state === 'running') ctx.suspend();
    } else if (ctx) {
      ctx.resume();
    }
  }

  var bootBus = null;
  function stopBootSounds() {
    if (!bootBus) return;
    bootBus.disconnect();
    bootBus = null;
  }

  function bootCue(cue) {
    if (!SFX_ENABLED) return;
    if (document.hidden || document.documentElement.dataset.audio !== 'on' || !ensure() || ctx.state !== 'running') return;
    if (!bootBus) {
      bootBus = ctx.createGain();
      bootBus.connect(synthBus);
    }
    var now = ctx.currentTime;
    function note(offset, from, to, length, level, shape) {
      var source = ctx.createOscillator();
      var gain = ctx.createGain();
      var at = now + offset;
      source.type = shape || 'sine';
      source.frequency.setValueAtTime(from, at);
      source.frequency.exponentialRampToValueAtTime(to, at + length);
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(level, at + Math.min(0.018, length / 4));
      gain.gain.exponentialRampToValueAtTime(0.0001, at + length);
      source.connect(gain);
      gain.connect(bootBus);
      source.onended = function () { source.disconnect(); gain.disconnect(); };
      source.start(at);
      source.stop(at + length + 0.01);
    }
    if (cue === 'type') {
      [0, 0.11, 0.24].forEach(function (offset) { note(offset, 940, 410, 0.034, 0.12, 'triangle'); });
    } else if (cue === 'assemble') {
      note(0, 125, 285, 0.82, 0.21);
      note(0.21, 560, 710, 0.5, 0.08, 'triangle');
    } else if (cue === 'ready') {
      note(0, 523, 523, 0.16, 0.18);
      note(0.105, 784, 784, 0.33, 0.16);
    }
  }
  window.RhineAudio = { sfx: sfx, preloadBootSfx: preloadBootSfx, startHoldCue: startHoldCue, stopHoldCue: stopHoldCue, isRunning: isRunning, bootCue: bootCue, stopBootSounds: stopBootSounds, bed: bed, stopBed: stopBed, pulse: pulse, soft: soft, scatter: scatter, close: close, voice: voice, preloadVoices: preloadVoices, setEnabled: setEnabled, setVolume: setVolume };

  // 总开关联动：关掉时挂起上下文，打开时恢复
  window.addEventListener('rhine:audio', function (e) {
    try { setEnabled(!!(e.detail && e.detail.on)); } catch (err) {}
  });

  // 全站克制点击音效代理：避开已有专属音效的日常大控件，覆盖三态所有按钮/筛选/弹窗/列表交互
  document.addEventListener('click', function (e) {
    var target = e.target;
    if (!target || typeof target.closest !== 'function') return;
    if (target.closest('#boot-screen, #rhine-rotate-hit, #exitButton, #tel-triggerFaultBtn')) return;
    if (target.closest('.orbit-node, #specimenLaunchBtn, #specimenCloseBtn')) return;

    var el = target.closest(
      'button:not(:disabled), input[type="checkbox"], .ledger-item, .dial-arc, .dial-legend-row, .dial-rank-row, .game-row, .game-card'
    );
    if (!el) return;

    if (el.matches('button.danger, button.fault-btn')) {
      sfx('uiAlert', 1.6);
    } else if (el.matches('button[type="submit"], #closeSettings, #tel-doneTrackingBtn')) {
      sfx('uiConfirm', 1.7);
    } else if (el.matches('.filter-tabs button, .period-pills button, .cat-tabs button, .subtag-chips button, #audioToggle, input[type="checkbox"]')) {
      sfx('uiToggle', 1.5);
    } else {
      sfx('uiClick', 1.5);
    }
  }, true);
})();
