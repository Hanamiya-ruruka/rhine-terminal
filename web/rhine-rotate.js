'use strict';

(() => {
  const motif = window.RhineMotif;
  if (!motif?.rotate) return;

  const root = document.documentElement;
  const slot = document.getElementById('rhine-motif-slot');
  const hit = document.getElementById('rhine-rotate-hit');
  const specimen = document.getElementById('specimenPanel');
  const holdMs = 500;
  let press;

  new ResizeObserver(([{ contentRect }]) => {
    const diameter = Math.min(contentRect.width, contentRect.height) * 0.24;
    hit.style.setProperty('--rhine-rotate-diameter', `${diameter}px`);
  }).observe(motif.canvas);

  const available = () => !document.hidden && specimen.hidden &&
    !root.hasAttribute('data-startup') && !root.dataset.transition &&
    !slot.hasAttribute('data-rhine-rotating');

  function cancel() {
    if (!press) return;
    clearTimeout(press.timer);
    if (!press.attempted) window.RhineAudio?.stopHoldCue?.();
    press = null;
  }

  const morphSfxByTarget = {
    turbine: 'morphToTurbine',
    dna: 'morphToDna',
    mobius: 'morphToMobius',
  };

  function completeHold() {
    if (!press || press.attempted) return;
    if (available()) {
      const target = motif.rotate();
      press.attempted = Boolean(target);
      if (target) {
        window.RhineAudio?.stopHoldCue?.();
        const key = morphSfxByTarget[target];
        if (key) window.RhineAudio?.sfx?.(key, 2.0);
      }
    }
  }

  hit.addEventListener('pointerdown', event => {
    // Keep the original document-level telemetry gesture away from this hit area.
    event.stopPropagation();
    if (event.button !== 0 || !event.isPrimary || press || !available()) return;

    hit.setPointerCapture(event.pointerId);
    window.RhineAudio?.startHoldCue?.(1.8);
    press = { id: event.pointerId, x: event.clientX, y: event.clientY, startedAt: event.timeStamp };
    press.timer = setTimeout(completeHold, Math.max(0, event.timeStamp + holdMs - performance.now()));
  });
  hit.addEventListener('pointermove', event => {
    if (press?.id === event.pointerId &&
        Math.hypot(event.clientX - press.x, event.clientY - press.y) > 12) cancel();
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    hit.addEventListener(type, event => {
      if (press?.id !== event.pointerId) return;
      if (type === 'pointerup' && event.timeStamp - press.startedAt >= holdMs &&
          Math.hypot(event.clientX - press.x, event.clientY - press.y) <= 12) completeHold();
      cancel();
    });
  }
  hit.addEventListener('contextmenu', event => event.preventDefault());
  window.addEventListener('blur', cancel);
  document.addEventListener('visibilitychange', cancel);
})();
