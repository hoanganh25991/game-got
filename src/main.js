// GoT RPG — Modular Orchestrator
// This refactor splits the original monolithic file into modules per system.
// Behavior is preserved; tuning values unchanged.

import * as THREE from "https://unpkg.com/three@0.160.0/build/three.module.js";
import { DEBUG } from "./config.js";
import { COLOR, WORLD, SKILLS, VILLAGE_POS, REST_RADIUS, SCALING } from "./constants.js";
import { initWorld, updateCamera, updateGridFollow, updateEnvironmentFollow, addResizeHandler, getTargetPixelRatio } from "./world.js";
import { UIManager } from "./ui/hud.js";
import { Player, Enemy, getNearestEnemy, handWorldPos } from "./entities.js";
import { EffectsManager, createGroundRing } from "./effects.js";
import { SkillsSystem } from "./skills.js";
import { createRaycast } from "./raycast.js";
import { createHouse, createHeroOverheadBars } from "./meshes.js";
import { initEnvironment } from "./environment.js";
import { distance2D, dir2D, now, clamp01 } from "./utils.js";
import { initPortals } from "./portals.js";
import { initI18n, setLanguage, getLanguage, t } from "./i18n.js";
import { initSplash } from "./splash.js";
import { initTouchControls } from "./touch.js";
import { createInputService } from "./input/input_service.js";
import { SKILL_POOL, DEFAULT_LOADOUT } from "./skills_pool.js";
import { loadOrDefault, saveLoadout, resolveLoadout } from "./loadout.js";
import { audio } from "./audio.js";
import { createVillagesSystem } from "./villages.js";
import { createMapManager } from "./maps.js";
import { initHeroPreview } from "./ui/hero/preview.js";
import { startInstructionGuide as startInstructionGuideOverlay } from "./ui/guide.js";
import { setupSettingsScreen } from "./ui/settings/index.js";
import { renderHeroScreen as renderHeroScreenUI } from "./ui/hero/index.js";
import { updateSkillBarLabels } from "./ui/skillbar.js";
import { promptBasicUpliftIfNeeded } from "./uplift.js";
import { setupDesktopControls } from "./ui/deskop-controls.js"
import * as payments from './payments.js';


// ------------------------------------------------------------
// Mobile Device Detection & Optimization
// ------------------------------------------------------------
const isMobile = (() => {
  try {
    // Check for touch support and mobile user agents
    const hasTouchScreen = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
    const mobileUA = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
    const isSmallScreen = window.innerWidth <= 1024;
    return hasTouchScreen && (mobileUA || isSmallScreen);
  } catch (_) {
    return false;
  }
})();

// Mobile-specific performance settings - Aggressive CPU-to-GPU optimizations
const MOBILE_OPTIMIZATIONS = {
  maxPixelRatio: 1.5,           // Cap pixel ratio to reduce GPU load
  enemyCountMultiplier: 0.3,    // Reduce enemy count by 70% (was 50%)
  vfxDistanceCull: 60,          // More aggressive VFX culling (was 80)
  hudUpdateMs: 300,             // Slower HUD updates (was 250)
  minimapUpdateMs: 400,         // Slower minimap updates (was 300)
  aiStrideMultiplier: 3,        // Much more AI throttling (was 1.5)
  frameBudgetMs: 6.0,           // Tighter frame budget for 60fps (was 8.0)
  envDensityReduction: 0.4,     // Reduce environment density more (was 0.6)
  disableShadows: true,         // Disable shadows (CPU/GPU intensive)
  reduceDrawCalls: true,        // Merge geometries where possible
  cullDistance: 100,            // Freeze enemies beyond this distance
  skipSlowUpdates: true,        // Skip slow debuff indicators
  simplifyMaterials: true,      // Use simpler materials
  disableRain: true,            // Rain is very expensive
};

// ------------------------------------------------------------
// Bootstrapping world, UI, effects
// ------------------------------------------------------------
const { renderer, scene, camera, ground, cameraOffset, cameraShake } = initWorld();
const _baseCameraOffset = cameraOffset.clone();
const ui = new UIManager();

// Mobile: Aggressive GPU/CPU optimizations
if (isMobile) {
  try {
    // Cap pixel ratio to reduce GPU overdraw
    const currentRatio = renderer.getPixelRatio();
    const maxRatio = MOBILE_OPTIMIZATIONS.maxPixelRatio;
    if (currentRatio > maxRatio) {
      renderer.setPixelRatio(Math.min(currentRatio, maxRatio));
      console.info(`[Mobile] Capped pixel ratio: ${currentRatio.toFixed(2)} -> ${maxRatio}`);
    }
    
    // Disable shadows entirely on mobile (huge CPU/GPU savings)
    if (MOBILE_OPTIMIZATIONS.disableShadows) {
      renderer.shadowMap.enabled = false;
      console.info('[Mobile] Disabled shadows for performance');
    }
    
    // Force power preference to high-performance
    try {
      const gl = renderer.getContext();
      if (gl) {
        const ext = gl.getExtension('WEBGL_lose_context');
        // Context already created, log preference
        console.info('[Mobile] GPU power preference: high-performance');
      }
    } catch (_) {}
  } catch (_) {}
}

// Render quality preference (persisted). Default to "high" on desktop, "medium" on mobile.
const _renderPrefs = JSON.parse(localStorage.getItem("renderPrefs") || "{}");
let renderQuality = (typeof _renderPrefs.quality === "string" && ["low", "medium", "high"].includes(_renderPrefs.quality))
  ? _renderPrefs.quality
  : (isMobile ? "medium" : "high");

// Mobile: Force medium quality on first run for optimal performance
if (isMobile && !_renderPrefs.quality) {
  renderQuality = "medium";
  try {
    const prefs = { ..._renderPrefs, quality: "medium" };
    localStorage.setItem("renderPrefs", JSON.stringify(prefs));
    console.info("[Mobile] Auto-set quality to 'medium' for optimal performance");
  } catch (_) {}
}

const effects = new EffectsManager(scene, { quality: renderQuality });
const mapManager = createMapManager();


// Perf collector: smoothed FPS, 1% low, frame ms, and renderer.info snapshot
const __perf = {
  prevMs: performance.now(),
  hist: [],
  fps: 0,
  fpsLow1: 0,
  ms: 0,
  avgMs: 0
};

// Tiny reusable object pool to avoid allocations in hot loops.
// Temp vectors/quaternions used across update loops to reduce GC pressure.
const __tempVecA = new THREE.Vector3();
const __tempVecB = new THREE.Vector3();
const __tempVecC = new THREE.Vector3();
const __tempQuat = new THREE.Quaternion();
let __tempVecQuatOrVec;

// Global VFX gating / quality helper. Tunable at runtime:
//   window.__vfxQuality = 'high' | 'medium' | 'low' (default derived from renderQuality)
//   window.__vfxDistanceCull = 120  // meters for distance-based culling (optional)
//
// Use shouldSpawnVfx(type, position) before spawning expensive effects.
if (!window.__vfxQuality) {
  window.__vfxQuality = (renderQuality === "low") ? "low" : (isMobile ? "medium" : "high");
}
if (!window.__vfxDistanceCull) {
  window.__vfxDistanceCull = isMobile ? MOBILE_OPTIMIZATIONS.vfxDistanceCull : 140;
}
function shouldSpawnVfx(kind, pos) {
  try {
    const q = window.__vfxQuality || "high";
    const fpsNow = (__perf && __perf.fps) ? __perf.fps : 60;
    // Disallow heavy effects at low quality or very low FPS
    if (q === "low" || fpsNow < 18) return false;
    // Distance cull if position provided (use camera position)
    if (pos && camera && camera.position) {
      const dx = pos.x - camera.position.x;
      const dz = pos.z - camera.position.z;
      const d = Math.hypot(dx, dz);
      if (d > (window.__vfxDistanceCull || 140)) return false;
    }
    // Allow for 'medium' quality but still disallow some heavy kinds
    if (q === "medium") {
      if (kind === "handSpark" || kind === "largeBeam") return false;
    }
    return true;
  } catch (e) {
    return true;
  }
}

// Throttle values for UI updates (ms) - mobile uses slower updates
const HUD_UPDATE_MS = isMobile ? MOBILE_OPTIMIZATIONS.hudUpdateMs : 150;
const MINIMAP_UPDATE_MS = isMobile ? MOBILE_OPTIMIZATIONS.minimapUpdateMs : 150;
try {
  // expose for runtime tuning/debug if needed
  window.__HUD_UPDATE_MS = HUD_UPDATE_MS;
  window.__MINIMAP_UPDATE_MS = MINIMAP_UPDATE_MS;
  window.__IS_MOBILE = isMobile;
} catch (_) {}

// last-update timestamps (initialized lazily in the loop)
if (!window.__lastHudT) window.__lastHudT = 0;
if (!window.__lastMinimapT) window.__lastMinimapT = 0;
function __computePerf(nowMs) {
  const dtMs = Math.max(0.1, Math.min(1000, nowMs - (__perf.prevMs || nowMs)));
  __perf.prevMs = nowMs;
  __perf.ms = dtMs;
  __perf.hist.push(dtMs);
  if (__perf.hist.length > 600) __perf.hist.shift(); // ~10s at 60fps

  // Smooth FPS over recent 30 frames (lightweight)
  const recent = __perf.hist.slice(-30);
  const avgMs = recent.reduce((a, b) => a + b, 0) / Math.max(1, recent.length);
  __perf.avgMs = avgMs;
  __perf.fps = 1000 / avgMs;

  // Compute 1% low (p99) less frequently to avoid sorting every frame.
  // Throttle window (ms) can be tuned at runtime via window.__PERF_P99_THROTTLE_MS.
  const PERF_P99_THROTTLE_MS = (window.__PERF_P99_THROTTLE_MS || 1000);
  if (!window.__lastPerfP99T) window.__lastPerfP99T = 0;
  if ((performance.now() - window.__lastPerfP99T) >= PERF_P99_THROTTLE_MS) {
    window.__lastPerfP99T = performance.now();
    try {
      const sorted = __perf.hist.slice().sort((a, b) => a - b);
      const p99Idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99));
      const ms99 = sorted[p99Idx] || avgMs;
      __perf.fpsLow1 = 1000 / ms99;
    } catch (e) {
      // keep previous fpsLow1 on error
    }
  }
}
function getPerf() {
  const ri = renderer.info;
  const r = {
    calls: ri.render.calls,
    triangles: ri.render.triangles,
    lines: ri.render.lines,
    points: ri.render.points,
    geometries: ri.memory.geometries,
    textures: ri.memory.textures
  };
  return { fps: __perf.fps, fpsLow1: __perf.fpsLow1, ms: __perf.ms, avgMs: __perf.avgMs, renderer: r };
}

// Load environment preferences from localStorage (persist rain + density)
const _envPrefs = JSON.parse(localStorage.getItem("envPrefs") || "{}");
let envRainState = !!_envPrefs.rain;
let envDensityIndex = Number.isFinite(parseInt(_envPrefs.density, 10)) ? parseInt(_envPrefs.density, 10) : 1;
let envRainLevel = Number.isFinite(parseInt(_envPrefs.rainLevel, 10)) ? parseInt(_envPrefs.rainLevel, 10) : 1;

// Presets used by the density slider (kept in sync with index 0..2)
const ENV_PRESETS = [
  { treeCount: 20, rockCount: 10, flowerCount: 60, villageCount: 1 },
  { treeCount: 60, rockCount: 30, flowerCount: 120, villageCount: 1 },
  { treeCount: 140, rockCount: 80, flowerCount: 300, villageCount: 2 },
];

envDensityIndex = Math.min(Math.max(0, envDensityIndex), ENV_PRESETS.length - 1);

// Mobile: Apply environment density reduction and disable rain
let envPreset = ENV_PRESETS[envDensityIndex];
if (isMobile) {
  const reduction = MOBILE_OPTIMIZATIONS.envDensityReduction;
  envPreset = {
    treeCount: Math.floor(envPreset.treeCount * reduction),
    rockCount: Math.floor(envPreset.rockCount * reduction),
    flowerCount: Math.floor(envPreset.flowerCount * reduction),
    villageCount: envPreset.villageCount,
  };
  
  // Disable rain on mobile - it's very expensive
  if (MOBILE_OPTIMIZATIONS.disableRain) {
    envRainState = false;
    console.info('[Mobile] Disabled rain for performance');
  }
}

let env = initEnvironment(scene, Object.assign({}, envPreset, { enableRain: envRainState, quality: renderQuality }));
try {
  if (envRainState && env && typeof env.setRainLevel === "function") {
    env.setRainLevel(Math.min(Math.max(0, envRainLevel), 2));
  }
} catch (_) {}

/* Initialize splash first (shows full-screen loader), then i18n */
initSplash();
// Initialize i18n (device locale, fallback English)
initI18n();
// Bottom Middle = Desktop Controls
setupDesktopControls();

/* Payments (Digital Goods / Play Billing + App-priced TWA support)
   - Supports two modes:
     1) In-app SKUs (PRODUCT_IDS non-empty): use Digital Goods API as before.
     2) App-priced (no SKUs): trust license status provided by TWA wrapper (preferred)
        or verify a Play Licensing/Play Integrity token on the server.
   - For app-priced TWA: implement license check in the Android wrapper and post a message
     to the web page with { type: 'TWA_LICENSE_STATUS', entitled: boolean, licenseToken?: string }.
     The web page will store entitlement in localStorage and (optionally) verify licenseToken on your server.
*/
(function initPayments() {
  // Run async init without blocking boot
  (async () => {
    try {
      await payments.initDigitalGoods(); // harmless if unsupported
      // Configure product SKUs here if you're using in-app products.
      // For an app-priced distribution (one-time paid app with no SKUs), leave PRODUCT_IDS empty.
      const PRODUCT_IDS = []; // Example: ['com.example.app.productId'] for in-app SKU mode.

      if (Array.isArray(PRODUCT_IDS) && PRODUCT_IDS.length > 0) {
        // In-app SKU flow (unchanged)
        const purchases = await payments.checkOwned(PRODUCT_IDS);
        if (purchases && purchases.length > 0) {
          try { localStorage.setItem('app.purchased', '1'); } catch (_) {}
          window.__appPurchased = true;
          console.info('[payments] detected owned product(s):', purchases.map(p => p.itemId));
          // Optionally verify purchase tokens on server:
          // for (const p of purchases) await payments.verifyOnServer({ packageName: 'com.example.app', productId: p.itemId, purchaseToken: p.purchaseToken });
        } else {
          // fall back to previously-saved local state
          window.__appPurchased = !!localStorage.getItem('app.purchased');
        }
      } else {
        // App-priced flow (no SKUs)
        // 1) Use any previously persisted local flag while we attempt to get a definitive license status.
        window.__appPurchased = !!localStorage.getItem('app.purchased');

        // 2) Listen for license messages from the Android TWA wrapper.
        //    The wrapper should post a message to the page with:
        //      { type: 'TWA_LICENSE_STATUS', entitled: true|false, licenseToken?: '<token-for-server-verification>' }
        window.addEventListener('message', async (ev) => {
          try {
            const data = ev.data;
            if (!data || typeof data !== 'object') return;
            if (data.type === 'TWA_LICENSE_STATUS') {
              const entitled = !!data.entitled;
              window.__appPurchased = entitled;
              try { localStorage.setItem('app.purchased', entitled ? '1' : '0'); } catch (_) {}
              console.info('[payments] received TWA_LICENSE_STATUS', { entitled });

              // If the wrapper provides a token suitable for server-side verification (Play Integrity or LVL),
              // verify it on your server for stronger security.
              if (data.licenseToken) {
                try {
                  const resp = await payments.verifyLicenseOnServer({ licenseData: data.licenseToken });
                  if (resp && resp.ok && resp.entitled) {
                    window.__appPurchased = true;
                    try { localStorage.setItem('app.purchased', '1'); } catch (_) {}
                    console.info('[payments] server verified license token OK');
                  } else {
                    console.warn('[payments] server license verification returned not-entitled', resp);
                  }
                } catch (e) {
                  console.warn('[payments] license verify on server failed', e);
                }
              }
            }
          } catch (e) {
            // ignore message handler failures
            console.warn('[payments] message handler error', e);
          }
        }, false);

        // 3) Helper to request the wrapper to perform a license check (the wrapper must listen for this message).
        //    The Android wrapper should respond by posting TWA_LICENSE_STATUS back to the page.
        window.requestLicenseStatus = function requestLicenseStatus() {
          try {
            // This will send a message to the embedding context (the Android TWA wrapper).
            // The wrapper must listen for this and respond with a TWA_LICENSE_STATUS message.
            window.postMessage({ type: 'REQUEST_TWA_LICENSE_STATUS' }, '*');
          } catch (e) {
            console.warn('[payments] requestLicenseStatus failed', e);
          }
        };

        // Ask wrapper for current license state (non-blocking)
        try { window.requestLicenseStatus(); } catch (_) {}
      }
    } catch (e) {
      console.warn('[payments] initialization failed', e);
      window.__appPurchased = !!localStorage.getItem('app.purchased');
    }
  })();

  // Expose helper to restore purchases / re-check license on demand (e.g., settings "Restore purchases" button)
  window.restorePurchases = async function restorePurchases() {
    try {
      await payments.initDigitalGoods();
      const PRODUCT_IDS = []; // same configuration as above; fill if using SKUs

      if (Array.isArray(PRODUCT_IDS) && PRODUCT_IDS.length > 0) {
        const all = await payments.listPurchases();
        if (all && all.length) {
          const found = (all || []).some(p => p && PRODUCT_IDS.includes(p.itemId));
          if (found) {
            try { localStorage.setItem('app.purchased', '1'); } catch (_) {}
            window.__appPurchased = true;
          }
        }
        return all;
      } else {
        // App-priced flow: request the wrapper to re-check license and return immediately.
        try {
          window.requestLicenseStatus && window.requestLicenseStatus();
          return { ok: true, note: 'Requested wrapper license status' };
        } catch (err) {
          console.warn('[payments] restorePurchases (app priced) failed', err);
          throw err;
        }
      }
    } catch (err) {
      console.warn('[payments] restorePurchases failed', err);
      throw err;
    }
  };
})();

/* Audio: preferences + initialize on first user gesture. Do not auto-start music if disabled. */
const _audioPrefs = JSON.parse(localStorage.getItem("audioPrefs") || "{}");
let musicEnabled = _audioPrefs.music !== false; // default true
let sfxEnabled = _audioPrefs.sfx !== false;     // default true

// renderQuality initialized above from renderPrefs

audio.startOnFirstUserGesture(document);
/* Apply SFX volume per preference (default 0.5 when enabled) */
try { audio.setSfxVolume(sfxEnabled ? 0.5 : 0.0); } catch (_) {}

const __startMusicOnce = (ev) => {
  if (!musicEnabled) return;
  try {
    // FreePD CC0: "Ice and Snow" — soft, atmospheric, focus-friendly
    audio.ensureBackgroundMusic("audio/Ice and Snow.mp3", { volume: 0.35, loop: true });
  } catch (e) {
    // Fallback to generative if streaming fails
    try { audio.setMusicVolume(0.35); audio.startMusic(); } catch (_) {}
  } finally {
    try {
      document.removeEventListener("click", __startMusicOnce, true);
      document.removeEventListener("touchstart", __startMusicOnce, true);
      document.removeEventListener("keydown", __startMusicOnce, true);
    } catch (_) {}
  }
};
/* Only attach auto-start listeners when music is enabled */
if (musicEnabled) {
  document.addEventListener("click", __startMusicOnce, true);
  document.addEventListener("touchstart", __startMusicOnce, true);
  document.addEventListener("keydown", __startMusicOnce, true);
}

// Settings and overlay elements
const btnSettingsScreen = document.getElementById("btnSettingsScreen");
const btnCloseSettings = document.getElementById("btnCloseSettings");
const settingsPanel = document.getElementById("settingsPanel");
const btnHeroScreen = document.getElementById("btnHeroScreen");
const heroScreen = document.getElementById("heroScreen");
const introScreen = document.getElementById("introScreen");
const btnStart = document.getElementById("btnStart");
const btnCamera = document.getElementById("btnCamera");
const btnPortal = document.getElementById("btnPortal");
const btnMark = document.getElementById("btnMark");
const langVi = document.getElementById("langVi");
const langEn = document.getElementById("langEn");
let firstPerson = false;
// preserve original camera defaults
const _defaultCameraNear = camera.near || 0.1;
const _defaultCameraFov = camera.fov || 60;

/**
 * Toggle first-person mode and adjust camera projection to reduce clipping.
 * When enabled we use a tighter near plane and slightly wider FOV for a comfortable FPS feel.
 */
function setFirstPerson(enabled) {
  firstPerson = !!enabled;
  if (firstPerson) {
    camera.near = 0.01;
    camera.fov = 75;
    camera.updateProjectionMatrix();
    // Hide torso/head/cloak parts so arms remain visible in first-person
    try {
      if (typeof player !== "undefined" && player?.mesh?.userData?.fpHide) {
        player.mesh.userData.fpHide.forEach((o) => { if (o) o.visible = false; });
      }
      if (typeof heroBars !== "undefined" && heroBars?.container) {
        heroBars.container.visible = false;
      }
    } catch (e) {}
  } else {
    camera.near = _defaultCameraNear;
    camera.fov = _defaultCameraFov;
    camera.updateProjectionMatrix();
    // Restore visibility
    try {
      if (typeof player !== "undefined" && player?.mesh?.userData?.fpHide) {
        player.mesh.userData.fpHide.forEach((o) => { if (o) o.visible = true; });
      }
      if (typeof heroBars !== "undefined" && heroBars?.container) {
        heroBars.container.visible = true;
      }
    } catch (e) {}
  }
}

// Settings handlers (refactored)
const audioCtl = {
  audio,
  getMusicEnabled: () => musicEnabled,
  setMusicEnabled: (v) => { musicEnabled = !!v; try { localStorage.setItem("audioPrefs", JSON.stringify({ music: musicEnabled, sfx: sfxEnabled })); } catch (_) {} },
  getSfxEnabled: () => sfxEnabled,
  setSfxEnabled: (v) => { sfxEnabled = !!v; try { localStorage.setItem("audioPrefs", JSON.stringify({ music: musicEnabled, sfx: sfxEnabled })); } catch (_) {} },
};
const environmentCtx = {
  scene,
  ENV_PRESETS,
  initEnvironment,
  updateEnvironmentFollow,
  get player() { return player; },
  getState: () => ({ env, envRainState, envDensityIndex, envRainLevel }),
  setState: (st) => {
    env = st.env ?? env;
    envRainState = st.envRainState ?? envRainState;
    envDensityIndex = st.envDensityIndex ?? envDensityIndex;
    envRainLevel = st.envRainLevel ?? envRainLevel;
  },
};
const renderCtx = {
  renderer,
  cameraOffset,
  baseCameraOffset: _baseCameraOffset,
  getQuality: () => renderQuality,
  setQuality: (q) => { renderQuality = q; },
  getTargetPixelRatio: () => getTargetPixelRatio(),
  getPerf,
};
setupSettingsScreen({
  t,
  startInstructionGuide: () => startInstructionGuideOverlay(),
  elements: { btnSettingsScreen, btnCloseSettings, settingsPanel },
  environment: environmentCtx,
  render: renderCtx,
  audioCtl,
});

// Wire "Restore purchases" button in Settings to the restorePurchases() helper.
// Provides lightweight UI feedback (center message) while the request is processed.
(function wireRestoreButton() {
  const btn = document.getElementById('btnRestorePurchases');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    try {
      btn.disabled = true;
      setCenterMsg && setCenterMsg('Checking purchases...');
      const res = await window.restorePurchases();
      // Handling possible responses:
      // - SKU flow: array of purchases returned
      // - App-priced flow: { ok: true, note: 'Requested wrapper license status' } and wrapper will post TWA_LICENSE_STATUS
      if (Array.isArray(res)) {
        if (res.length > 0 || window.__appPurchased) {
          setCenterMsg && setCenterMsg('Purchase restored.');
        } else {
          setCenterMsg && setCenterMsg('No purchases found.');
        }
      } else if (res && res.ok && res.note) {
        // Requested wrapper/license re-check — final state will be delivered via TWA_LICENSE_STATUS message.
        setCenterMsg && setCenterMsg('Requested license status; awaiting response...');
      } else {
        // Fallback: rely on window.__appPurchased
        if (window.__appPurchased) {
          setCenterMsg && setCenterMsg('Purchase restored.');
        } else {
          setCenterMsg && setCenterMsg('No purchase found.');
        }
      }
      // Clear the message shortly after
      setTimeout(() => { try { clearCenterMsg && clearCenterMsg(); } catch (_) {} }, 1400);
    } catch (err) {
      console.warn('[UI] restorePurchases click failed', err);
      try { setCenterMsg && setCenterMsg('Restore failed'); } catch (_) {}
      setTimeout(() => { try { clearCenterMsg && clearCenterMsg(); } catch (_) {} }, 1400);
    } finally {
      try { btn.disabled = false; } catch (_) {}
    }
  });
})();

// Hero open/close
// Thin wrapper to render hero screen using modular UI
function showHeroScreen(initialTab = "skills") {
  const ctx = {
    t,
    player,
    SKILL_POOL,
    DEFAULT_LOADOUT,
    currentLoadout,
    setLoadoutAndSave,
    updateSkillBarLabels,
    mapManager,
    portals,
    enemies,
    effects,
    WORLD,
    setCenterMsg,
    clearCenterMsg,
    applyMapModifiersToEnemy,
    adjustEnemyCountForMap: adjustEnemyCountForCurrentMap,
  };
  try { audio.ensureBackgroundMusic("audio/Ice and Snow.mp3", { volume: 0.35, loop: true }); } catch (_) {}
  try { renderHeroScreenUI(initialTab, ctx); } catch (_) {}
}
btnHeroScreen?.addEventListener("click", () => { showHeroScreen("skills"); heroScreen?.classList.remove("hidden"); });

// Generic top-right screen-close icons (ensure any element with .screen-close closes its parent .screen)
document.querySelectorAll(".screen-close").forEach((b) => {
  b.addEventListener("click", (e) => {
    const sc = e.currentTarget.closest(".screen");
    if (sc) sc.classList.add("hidden");
  });
});

// intro may be absent (we removed it), keep safe guard
btnStart?.addEventListener("click", () => { introScreen?.classList.add("hidden"); });
// use the setter so projection updates correctly
btnCamera?.addEventListener("click", () => { setFirstPerson(!firstPerson); });
// Portal button: recall to nearest portal (same as pressing 'B')
btnPortal?.addEventListener("click", () => {
  try { portals.recallToVillage(player, setCenterMsg, clearCenterMsg); } catch (e) {}
});
// Place persistent Mark/Flag (3-minute cooldown)
btnMark?.addEventListener("click", () => {
  try {
    const remain = portals.getMarkCooldownMs?.() ?? 0;
    if (remain > 0) {
      const s = Math.ceil(remain / 1000);
      setCenterMsg(`Mark ready in ${s}s`);
      setTimeout(() => clearCenterMsg(), 1200);
      return;
    }
    const m = portals.addPersistentMarkAt?.(player.pos());
    if (m) {
      setCenterMsg("Flag placed");
      setTimeout(() => clearCenterMsg(), 1100);
    }
  } catch (_) {}
});

function updateFlagActive() {
  try {
    const lang = (typeof getLanguage === "function" ? getLanguage() : "vi");
    const on = (el, isActive) => {
      if (!el) return;
      // Keep class for any theme CSS that may target it
      try { el.classList.toggle("active", !!isActive); } catch (_) {}
      // Inline highlight to match checkbox (thunder yellow) so it's always visible
      if (isActive) {
        el.style.background = "linear-gradient(180deg, #ffe98a, #ffd94a)";
        el.style.color = "var(--theme-dark-blue)";
        el.style.borderColor = "rgba(255,217,74,0.6)";
        el.style.boxShadow = "0 6px 18px rgba(0,0,0,0.35), 0 0 10px rgba(255,217,74,0.28)";
      } else {
        el.style.background = "rgba(10,25,48,0.6)";
        el.style.color = "#fff";
        el.style.borderColor = "rgba(124,196,255,0.35)";
        el.style.boxShadow = "0 6px 14px rgba(0,0,0,0.35)";
      }
    };
    on(langVi, lang === "vi");
    on(langEn, lang === "en");
  } catch (_) {}
}
langVi?.addEventListener("click", () => { setLanguage("vi"); updateFlagActive(); });
langEn?.addEventListener("click", () => { setLanguage("en"); updateFlagActive(); });
try { updateFlagActive(); } catch (_) {}

// Environment controls (Settings panel)
// - #envRainToggle : checkbox to enable rain
// - #envDensity : range [0..2] for sparse / default / dense world
const envRainToggle = document.getElementById("envRainToggle");
const envDensity = document.getElementById("envDensity");
// Initialize controls from stored prefs
if (envRainToggle) {
  envRainToggle.checked = !!envRainState;
  envRainToggle.addEventListener("change", (ev) => {
    envRainState = !!ev.target.checked;
    if (env && typeof env.toggleRain === "function") env.toggleRain(envRainState);
    if (envRainState && env && typeof env.setRainLevel === "function") {
      try { env.setRainLevel(Math.min(Math.max(0, envRainLevel), 2)); } catch (_) {}
    }
    // persist
    try { localStorage.setItem("envPrefs", JSON.stringify({ rain: envRainState, density: envDensityIndex, rainLevel: envRainLevel })); } catch (_) {}
  });
}
if (envDensity) {
  // set initial slider value on UI scale (1..10)
  const len = ENV_PRESETS.length;
  const idx = Math.min(Math.max(0, envDensityIndex), len - 1);
  const uiVal = 1 + Math.round((idx / Math.max(1, len - 1)) * 9);
  envDensity.value = String(uiVal);
  const onEnvDensityChange = (ev) => {
    const vv = parseInt(ev.target.value, 10);
    const len = ENV_PRESETS.length;
    const ui = Math.min(Math.max(1, Number.isFinite(vv) ? vv : 5), 10);
    envDensityIndex = Math.min(Math.max(0, Math.round(((ui - 1) / 9) * (len - 1))), len - 1);
    const preset = ENV_PRESETS[envDensityIndex];
    // Recreate environment with new density while preserving rain state and rain level
    try { if (env && env.root && env.root.parent) env.root.parent.remove(env.root); } catch (e) {}
    env = initEnvironment(scene, Object.assign({}, preset, { enableRain: envRainState, quality: renderQuality }));
    try {
      if (envRainState && env && typeof env.setRainLevel === "function") {
        env.setRainLevel(Math.min(Math.max(0, envRainLevel), 2));
      }
      updateEnvironmentFollow(env, player);
    } catch (e) {}
    // persist
    try { localStorage.setItem("envPrefs", JSON.stringify({ rain: envRainState, density: envDensityIndex, rainLevel: envRainLevel })); } catch (_) {}
  };
  envDensity.addEventListener("change", onEnvDensityChange);
}

/* Rain density slider (0=low,1=medium,2=high) */
const rainDensity = document.getElementById("rainDensity");
if (rainDensity) {
  try {
    const lvl = Math.min(Math.max(0, Number.isFinite(parseInt(_envPrefs.rainLevel, 10)) ? parseInt(_envPrefs.rainLevel, 10) : 1), 2);
    const uiVal = 1 + Math.round((lvl / 2) * 9);
    rainDensity.value = String(uiVal);
  } catch (_) {}
  const onRainDensityChange = (ev) => {
    const vv = parseInt(ev.target.value, 10);
    const ui = Math.min(Math.max(1, Number.isFinite(vv) ? vv : 5), 10);
    const lvl = Math.round(((ui - 1) / 9) * 2);
    envRainLevel = Math.min(Math.max(0, lvl), 2);
    try { env && typeof env.setRainLevel === "function" && env.setRainLevel(envRainLevel); } catch (_) {}
    try { localStorage.setItem("envPrefs", JSON.stringify({ rain: envRainState, density: envDensityIndex, rainLevel: envRainLevel })); } catch (_) {}
  };
  rainDensity.addEventListener("change", onRainDensityChange);
}

/* Render quality: native select (low/medium/high) */
function initQualitySelect() {
  const sel = document.getElementById("qualitySelect");
  if (!sel) return;

  // Initialize from persisted prefs or current variable
  let q = renderQuality;
  try {
    const prefs = JSON.parse(localStorage.getItem("renderPrefs") || "{}");
    if (prefs && typeof prefs.quality === "string") q = prefs.quality;
  } catch (_) {}

  // Fallback to high if unexpected
  if (q !== "low" && q !== "medium" && q !== "high") q = "high";
  try { sel.value = q; } catch (_) {}

  // Bind once
  if (!sel.dataset.bound) {
    sel.addEventListener("change", () => {
      const v = String(sel.value || "high").toLowerCase();
      const valid = v === "low" || v === "medium" || v === "high";
      const nextQ = valid ? v : "high";
      // Persist preference before full reload
      try {
        const prev = JSON.parse(localStorage.getItem("renderPrefs") || "{}");
        prev.quality = nextQ;
        localStorage.setItem("renderPrefs", JSON.stringify(prev));
      } catch (_) {}
      try { localStorage.setItem("pendingReloadReason", "quality-change"); } catch (_) {}
      // Reload to apply enemy density and fully reinitialize subsystems for the new quality
      window.location.reload();
    });
    sel.dataset.bound = "1";
  }
}
try { initQualitySelect(); } catch (_) {}
try { initZoomControl && initZoomControl(); } catch (_) {}

/* Render zoom: range slider (0.6..1.6) */
function initZoomControl() {
  const sel = document.getElementById("zoomSlider");
  if (!sel) return;

  // Initialize from persisted prefs or UI default 2 (≈0.711)
  let z = 0.6 + (1 / 9) * 1.0;
  try {
    const prefs = JSON.parse(localStorage.getItem("renderPrefs") || "{}");
    if (typeof prefs.zoom === "number") z = prefs.zoom;
  } catch (_) {}

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  z = clamp(Number.isFinite(parseFloat(z)) ? parseFloat(z) : (0.6 + (1 / 9) * 1.0), 0.6, 1.6);

  try {
    const uiVal = 1 + Math.round(((z - 0.6) / 1.0) * 9);
    sel.value = String(Math.max(1, Math.min(10, uiVal)));
  } catch (_) {}

  // Apply immediately on init
  try {
    cameraOffset.copy(_baseCameraOffset.clone().multiplyScalar(z));
  } catch (_) {}

  // Bind once
  if (!sel.dataset.bound) {
    const onChange = () => {
      const ui = Math.max(1, Math.min(10, parseInt(sel.value, 10) || 5));
      const zoom = 0.6 + ((ui - 1) / 9) * 1.0;
      try {
        cameraOffset.copy(_baseCameraOffset.clone().multiplyScalar(zoom));
      } catch (_) {}
      try {
        const prev = JSON.parse(localStorage.getItem("renderPrefs") || "{}");
        prev.zoom = zoom;
        localStorage.setItem("renderPrefs", JSON.stringify(prev));
      } catch (_) {}
    };
    sel.addEventListener("change", onChange);
    sel.dataset.bound = "1";
  }
}

/* Settings: Audio toggles (Music / SFX) */
const musicToggle = document.getElementById("musicToggle");
const sfxToggle = document.getElementById("sfxToggle");
if (musicToggle) {
  musicToggle.checked = !!musicEnabled;
  musicToggle.addEventListener("change", () => {
    musicEnabled = !!musicToggle.checked;
    try { localStorage.setItem("audioPrefs", JSON.stringify({ music: musicEnabled, sfx: sfxEnabled })); } catch (_) {}
    if (musicEnabled) {
      // Start background music immediately
      try {
        audio.ensureBackgroundMusic("audio/Ice and Snow.mp3", { volume: 0.35, loop: true });
      } catch (e) {
        try { audio.setMusicVolume(0.35); audio.startMusic(); } catch (_) {}
      }
    } else {
      // Stop any music
      try { audio.stopStreamMusic(); } catch (_) {}
      try { audio.stopMusic(); } catch (_) {}
      try { audio.setMusicVolume(0); } catch (_) {}
    }
  });
}
if (sfxToggle) {
  sfxToggle.checked = !!sfxEnabled;
  sfxToggle.addEventListener("change", () => {
    sfxEnabled = !!sfxToggle.checked;
    try { audio.setSfxVolume(sfxEnabled ? 0.5 : 0.0); } catch (_) {}
    try { localStorage.setItem("audioPrefs", JSON.stringify({ music: musicEnabled, sfx: sfxEnabled })); } catch (_) {}
  });
}

// Settings UI initialized via setupSettingsScreen()

// Selection/aim indicators
/* Load and apply saved loadout so runtime SKILLS.Q/W/E/R reflect player's choice */
let currentLoadout = loadOrDefault(SKILL_POOL, DEFAULT_LOADOUT);

/**
 * Apply an array of 4 skill ids to the SKILLS mapping (mutates exported SKILLS).
 */
function applyLoadoutToSKILLS(loadoutIds) {
  const idMap = new Map(SKILL_POOL.map((s) => [s.id, s]));
  const keys = ["Q", "W", "E", "R"];
  for (let i = 0; i < 4; i++) {
    const id = loadoutIds[i];
    const def = idMap.get(id);
    if (def) {
      // shallow copy to avoid accidental shared references
      SKILLS[keys[i]] = Object.assign({}, def);
    }
  }
}

/**
 * Persist and apply a new loadout.
 */
function setLoadoutAndSave(ids) {
  const resolved = resolveLoadout(SKILL_POOL, ids, DEFAULT_LOADOUT);
  currentLoadout = resolved;
  applyLoadoutToSKILLS(currentLoadout);
  saveLoadout(currentLoadout);
  updateSkillBarLabels();
  try {
    console.info("[WORLD]", {
      attackRange: WORLD.attackRange,
      attackRangeMult: WORLD.attackRangeMult,
      basicAttackCooldown: WORLD.basicAttackCooldown,
      basicAttackDamage: WORLD.basicAttackDamage
    });
  } catch (e) {}
}

// Apply initial loadout so SKILLS are correct for subsequent UI/effects
applyLoadoutToSKILLS(currentLoadout);
updateSkillBarLabels();
try { window.updateSkillBarLabels = updateSkillBarLabels; } catch (e) {}
window.addEventListener("loadout-changed", () => {
  try {
    // Reload and apply loadout to runtime SKILLS mapping and refresh the HUD skillbar.
    currentLoadout = loadOrDefault(SKILL_POOL, DEFAULT_LOADOUT);
    applyLoadoutToSKILLS(currentLoadout);
    updateSkillBarLabels();
    
    // Critical: Notify the SkillsSystem instance to refresh its internal skill references
    if (skills && typeof skills.refreshSkills === 'function') {
      skills.refreshSkills();
    }
    
    // Do NOT re-render the Hero screen here. The Skills tab updates its slots in-place.
    // This preserves tab scroll positions (e.g., Maps list) and prevents cross-tab DOM pollution.
  } catch (_) {}
});

const aimPreview = null;

const attackPreview = null;

const selectionRing = createGroundRing(0.9, 1.05, 0x7cc4ff, 0.55);
selectionRing.visible = true;
effects.indicators.add(selectionRing);

// Center message helpers wired to UI
const setCenterMsg = (t) => ui.setCenterMsg(t);
const clearCenterMsg = () => ui.clearCenterMsg();
try {
  if (DEBUG) {
    setCenterMsg(`ATK rng=${WORLD.attackRange} x${WORLD.attackRangeMult} dmg=${WORLD.basicAttackDamage}`);
    setTimeout(() => clearCenterMsg(), 1800);
  }
} catch (e) {}

/* ------------------------------------------------------------
   Entities and Game State
------------------------------------------------------------ */
const player = new Player();
scene.add(player.mesh);
try { updateEnvironmentFollow(env, player); } catch (e) {}
// Map unlock check on startup and on level-up
try {
  mapManager.unlockByLevel(player.level);
  window.addEventListener("player-levelup", (ev) => {
    try {
      const lvl = ev?.detail?.level || player.level;
      const unlockedChanged = mapManager.unlockByLevel(lvl);
      // Auto-advance to highest unlocked map when new map unlocks
      if (unlockedChanged) {
        const prevIdx = mapManager.getCurrentIndex?.() || 1;
        const maxIdx = mapManager.getUnlockedMax?.() || prevIdx;
        if (maxIdx > prevIdx) {
          if (mapManager.setCurrent?.(maxIdx)) {
            // Reapply modifiers to existing enemies on map switch and adjust density
            enemies.forEach((en) => applyMapModifiersToEnemy(en));
            try { adjustEnemyCountForCurrentMap(); } catch (_) {}
            setCenterMsg && setCenterMsg(`Unlocked and switched to MAP ${maxIdx}`);
            setTimeout(() => clearCenterMsg(), 1400);
          }
        }
      }
    } catch (_) {}
  });
} catch (_) {}
try { promptBasicUpliftIfNeeded(player); } catch (_) {}
try { 
  window.addEventListener("player-levelup", () => { 
    try { promptBasicUpliftIfNeeded(player); } catch (_) {}
    // Adjust enemy count when player levels up (spawn more, stronger enemies)
    try { adjustEnemyCountForCurrentMap(); } catch (_) {}
  }); 
} catch (_) {}

// Hero overhead HP/MP bars
const heroBars = createHeroOverheadBars();
player.mesh.add(heroBars.container);

// Respawn/death messaging
player.onDeath = () => {
  player.deadUntil = now() + 3;
  setCenterMsg(t("death.msg"));
  player.aimMode = false;
  player.aimModeSkill = null;
  player.moveTarget = null;
  player.target = null;
};

/* Map modifiers helper */
function applyMapModifiersToEnemy(en) {
  try {
    const mods = mapManager.getModifiers?.() || {};
    // Apply multipliers
    en.maxHP = Math.max(1, Math.floor(en.maxHP * (mods.enemyHpMul || 1)));
    en.hp = Math.max(1, Math.min(en.maxHP, en.hp));
    en.attackDamage = Math.max(1, Math.floor(en.attackDamage * (mods.enemyDmgMul || 1)));
    en.speed = Math.max(0.1, en.speed * (mods.enemySpeedMul || 1));
    if (mods.enemyTint) {
      en.beamColor = mods.enemyTint;
      try {
        const tint = new THREE.Color(mods.enemyTint);
        en.mesh.traverse?.((o) => {
          if (o && o.material && o.material.color) {
            o.material.color.lerp(tint, 0.25);
          }
        });
      } catch (_) {}
    }
  } catch (_) {}
}
// Enemy count scaling with player level
// Base: 50 enemies at level 1
// Scaling: +2 enemies per level (50→52→54... up to 100 max)
const MIN_ENEMY_COUNT = 50;
const ENEMY_COUNT_PER_LEVEL = 2;
const MAX_ENEMY_COUNT = 100;

/**
 * Calculate target enemy count based on player level, quality settings, and map modifiers.
 * Scales from 50 enemies at level 1 to 100 enemies at level 25+.
 */
function calculateEnemyCountForLevel(playerLevel) {
  const levelBonus = Math.floor((playerLevel - 1) * ENEMY_COUNT_PER_LEVEL);
  const baseCount = Math.min(MAX_ENEMY_COUNT, MIN_ENEMY_COUNT + levelBonus);
  
  const qualityMultiplier = {
    high: 1.0,
    medium: 0.6,
    low: 0.4,
  };
  const mult = qualityMultiplier[renderQuality] || 1.0;
  const qualityAdjusted = Math.floor(baseCount * mult);
  
  const mods = mapManager.getModifiers?.() || {};
  const withMapMods = Math.floor(qualityAdjusted * (mods.enemyCountMul || 1));
  
  // Always enforce minimum, but allow level scaling
  return Math.max(MIN_ENEMY_COUNT, withMapMods);
}

// Initial enemy count based on player's starting level
const enemyCountTarget = calculateEnemyCountForLevel(player.level);

console.info(`[Enemy Spawn] Level ${player.level}: ${enemyCountTarget} enemies (base: ${MIN_ENEMY_COUNT}, max: ${MAX_ENEMY_COUNT})`);
const enemies = [];
for (let i = 0; i < enemyCountTarget; i++) {
  const angle = Math.random() * Math.PI * 2;
  const r = WORLD.enemySpawnRadius * (0.4 + Math.random() * 0.8);
  const pos = new THREE.Vector3(
    VILLAGE_POS.x + Math.cos(angle) * r,
    0,
    VILLAGE_POS.z + Math.sin(angle) * r
  );
  const e = new Enemy(pos, player.level);
  applyMapModifiersToEnemy(e);
  e.mesh.userData.enemyRef = e;
  scene.add(e.mesh);
  enemies.push(e);
}

/**
 * Dynamically adjust enemy count based on player level, map modifiers, quality, and performance.
 * Scales enemy count as player levels up (50→100 enemies from level 1→25+).
 * New enemies spawn at current player level (stronger stats).
 */
function adjustEnemyCountForCurrentMap() {
  try {
    // Calculate desired count with level scaling
    let desired = calculateEnemyCountForLevel(player.level);
    
    // Apply adaptive performance scaling (reduce if FPS is low)
    desired = Math.floor(desired * (__enemyPerfScale || 1));
    
    // Enforce minimum
    desired = Math.max(MIN_ENEMY_COUNT, desired);
    
    if (enemies.length < desired) {
      const toAdd = desired - enemies.length;
      console.info(`[Enemy Scaling] Adding ${toAdd} enemies (Level ${player.level}, Total: ${desired})`);
      for (let i = 0; i < toAdd; i++) {
        const pos = randomEnemySpawnPos();
        const e = new Enemy(pos, player.level); // Spawn at current level (stronger)
        applyMapModifiersToEnemy(e);
        e.mesh.userData.enemyRef = e;
        scene.add(e.mesh);
        enemies.push(e);
      }
    } else if (enemies.length > desired) {
      const toRemove = enemies.length - desired;
      console.info(`[Enemy Scaling] Removing ${toRemove} enemies (Level ${player.level}, Total: ${desired})`);
      for (let i = 0; i < toRemove; i++) {
        const e = enemies.pop();
        try { scene.remove(e.mesh); } catch (_) {}
      }
    }
  } catch (_) {}
}
try { window.adjustEnemyCountForMap = adjustEnemyCountForCurrentMap; } catch (_) {}

let selectedUnit = player;

// Village visuals
const houses = [
  (() => { const h = createHouse(); h.position.set(8, 0, -8); scene.add(h); return h; })(),
  (() => { const h = createHouse(); h.position.set(-10, 0, 10); scene.add(h); return h; })(),
  (() => { const h = createHouse(); h.position.set(-16, 0, -12); scene.add(h); return h; })(),
];

/* Village fence: posts + connecting rails (multi-line) for a stronger visual barrier.
   The logical VILLAGE_POS/REST_RADIUS remain the authoritative gameplay boundary. */
const fenceGroup = new THREE.Group();
const FENCE_POSTS = 28;
const fenceRadius = REST_RADIUS - 0.2;

// create posts
const postGeo = new THREE.CylinderGeometry(0.12, 0.12, 1.6, 8);
const postMat = new THREE.MeshStandardMaterial({ color: 0x6b4a2a });
const postPositions = [];
// Batch posts as a single InstancedMesh to reduce draw calls
const postsInst = new THREE.InstancedMesh(postGeo, postMat, FENCE_POSTS);
// Shared temp transforms
const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3(1, 1, 1);
const _p = new THREE.Vector3();
for (let i = 0; i < FENCE_POSTS; i++) {
  const ang = (i / FENCE_POSTS) * Math.PI * 2;
  const px = VILLAGE_POS.x + Math.cos(ang) * fenceRadius;
  const pz = VILLAGE_POS.z + Math.sin(ang) * fenceRadius;
  _p.set(px, 0.8, pz);
  _q.setFromEuler(new THREE.Euler(0, -ang, 0));
  _s.set(1, 1, 1);
  _m4.compose(_p, _q, _s);
  postsInst.setMatrixAt(i, _m4);
  postPositions.push({ x: px, z: pz });
}
postsInst.instanceMatrix.needsUpdate = true;
postsInst.castShadow = true;
postsInst.receiveShadow = true;
fenceGroup.add(postsInst);

 // connecting rails (three horizontal lines)
const railMat = new THREE.MeshStandardMaterial({ color: 0x4b3620 });
const railHeights = [0.45, 0.9, 1.35]; // y positions for rails
// Batch rails using InstancedMesh (FENCE_POSTS segments * 3 heights)
const _unitRailGeo = new THREE.BoxGeometry(1, 0.06, 0.06);
const railsCount = FENCE_POSTS * railHeights.length;
const railsInst = new THREE.InstancedMesh(_unitRailGeo, railMat, railsCount);
let railIdx = 0;
for (let i = 0; i < FENCE_POSTS; i++) {
  const a = postPositions[i];
  const b = postPositions[(i + 1) % FENCE_POSTS];
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len = Math.hypot(dx, dz);
  const angle = Math.atan2(dz, dx);
  const midX = (a.x + b.x) / 2;
  const midZ = (a.z + b.z) / 2;
  for (const h of railHeights) {
    // Compose transformation: rotation align to segment, translate to midpoint, scale X to segment length
    const pos = _p.set(midX, h, midZ);
    const quat = _q.setFromEuler(new THREE.Euler(0, -angle, 0));
    const scl = _s.set(len, 1, 1);
    _m4.compose(pos, quat, scl);
    railsInst.setMatrixAt(railIdx++, _m4);
  }
}
railsInst.instanceMatrix.needsUpdate = true;
railsInst.castShadow = false;
railsInst.receiveShadow = true;
fenceGroup.add(railsInst);

// Low translucent ground ring for visual guidance (subtle)
const fenceRing = new THREE.Mesh(
  new THREE.RingGeometry(fenceRadius - 0.08, fenceRadius + 0.08, 64),
  new THREE.MeshBasicMaterial({ color: COLOR.village, transparent: true, opacity: 0.08, side: THREE.DoubleSide })
);
fenceRing.rotation.x = -Math.PI / 2;
fenceRing.position.copy(VILLAGE_POS);
fenceGroup.add(fenceRing);

scene.add(fenceGroup);

// Portals/Recall
const portals = initPortals(scene);
// Init Mark cooldown UI after portals are created
(function initMarkCooldownUI() {
  if (!btnMark || !portals?.getMarkCooldownMs) return;
  function fmt(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return m > 0 ? `${m}m ${r}s` : `${r}s`;
  }
  function tick() {
    try {
      const remain = portals.getMarkCooldownMs();
      if (remain > 0) {
        btnMark.disabled = true;
        btnMark.title = `Mark cooldown: ${fmt(remain)}`;
        btnMark.style.opacity = "0.5";
      } else {
        btnMark.disabled = false;
        btnMark.title = "Mark (3m cd)";
        btnMark.style.opacity = "";
      }
    } catch (_) {}
  }
  try { clearInterval(window.__markCoolInt); } catch (_) {}
  window.__markCoolInt = setInterval(tick, 500);
  tick();
})();
// Villages system (dynamic villages, roads, rest)
const villages = createVillagesSystem(scene, portals);

// ------------------------------------------------------------
// Skills system (cooldowns, abilities, storms) and UI
// ------------------------------------------------------------
const skills = new SkillsSystem(player, enemies, effects, ui.getCooldownElements(), villages);
try { window.__skillsRef = skills; } catch (_) {}
try { initHeroPreview(skills, { heroScreen }); } catch (_) {}

// Touch controls (joystick + skill wheel)
const touch = initTouchControls({ player, skills, effects, aimPreview, attackPreview, enemies, getNearestEnemy, WORLD, SKILLS });

// ------------------------------------------------------------
// Raycasting
// ------------------------------------------------------------
/* Maintain a cached list of alive enemy meshes and refresh periodically to avoid
   allocating/filtering every frame when raycasting. This reduces GC and CPU work.
*/
const __enemyMeshes = [];
function __refreshEnemyMeshes() {
  try {
    __enemyMeshes.length = 0;
    for (const en of enemies) {
      if (en.alive) __enemyMeshes.push(en.mesh);
    }
  } catch (_) {}
}
__refreshEnemyMeshes();
try { clearInterval(window.__enemyMeshRefreshInt); } catch (_) {}
window.__enemyMeshRefreshInt = setInterval(__refreshEnemyMeshes, 200);

const raycast = createRaycast({
  renderer,
  camera,
  ground,
  enemiesMeshesProvider: () => __enemyMeshes,
  playerMesh: player.mesh,
});

const inputService = createInputService({
  renderer,
  raycast,
  camera,
  portals,
  player,
  enemies,
  effects,
  skills,
  WORLD,
  DEBUG,
  aimPreview,
  attackPreview,
  setCenterMsg,
  clearCenterMsg,
});
inputService.attachCaptureListeners();
if (typeof touch !== "undefined" && touch) inputService.setTouchAdapter(touch);

// ------------------------------------------------------------
// UI: cooldowns are updated by skills; HUD and minimap updated in loop
// ------------------------------------------------------------

// ------------------------------------------------------------
// Input Handling
// ------------------------------------------------------------
renderer.domElement.addEventListener("contextmenu", (e) => e.preventDefault());

let keyHoldA = false;

/* Autofire helper: attempt immediate auto-basic attack on nearest enemy within effective range.
   Respects cooldown in skills.tryBasicAttack, and enables attackMove if target is beyond range. */
function attemptAutoBasic() {
  if (!player.alive || player.frozen) return;
  try {
    const effRange = WORLD.attackRange * (WORLD.attackRangeMult || 1);
    const nearest = getNearestEnemy(player.pos(), effRange, enemies);
    if (!nearest) return;
    player.target = nearest;
    player.moveTarget = null;
    try {
      const d = distance2D(player.pos(), nearest.pos());
      player.attackMove = d > effRange * 0.95;
    } catch (err) {
      player.attackMove = false;
    }
    effects.spawnTargetPing(nearest);
    skills.tryBasicAttack(player, nearest);
  } catch (e) {}
}

/* Keyboard movement (arrow keys) */
const keyMove = { up: false, down: false, left: false, right: false };
function getKeyMoveDir() {
  const x = (keyMove.right ? 1 : 0) + (keyMove.left ? -1 : 0);
  const y = (keyMove.down ? 1 : 0) + (keyMove.up ? -1 : 0);
  const len = Math.hypot(x, y);
  if (len === 0) return { active: false, x: 0, y: 0 };
  return { active: true, x: x / len, y: y / len };
}


renderer.domElement.addEventListener("mousedown", (e) => {
  raycast.updateMouseNDC(e);
  if (e.button === 2) { // Right click: move / select (no auto-attack/move)
    if (player.frozen) {
      portals.handleFrozenPortalClick(raycast, camera, player, clearCenterMsg);
      return;
    }
    const obj = raycast.raycastEnemyOrGround();
    if (obj && obj.type === "enemy") {
      // Select enemy manually instead of auto-targeting/auto-attacking.
      selectedUnit = obj.enemy;
      effects.spawnTargetPing(obj.enemy);
    } else {
      const p = raycast.raycastGround();
      if (p) {
        // Manual move order; do not enable auto-attack.
        player.moveTarget = p.clone();
        player.target = null;
        player.attackMove = false;
        effects.spawnMovePing(p);
      }
    }
  } else if (e.button === 0) { // Left click: basic attack on enemy; ignore ground
    const obj = raycast.raycastPlayerOrEnemyOrGround();

    if (player.frozen) {
      portals.handleFrozenPortalClick(raycast, camera, player, clearCenterMsg);
      return;
    }

    const effRange = WORLD.attackRange * (WORLD.attackRangeMult || 1);

    if (obj && obj.type === "enemy") {
      selectedUnit = obj.enemy;
      if (obj.enemy && obj.enemy.alive) {
        player.target = obj.enemy;
        player.moveTarget = null;
        try {
          const d = distance2D(player.pos(), obj.enemy.pos());
          player.attackMove = d > effRange * 0.95;
        } catch (err) {
          player.attackMove = false;
        }
        effects.spawnTargetPing(obj.enemy);
        try { skills.tryBasicAttack(player, obj.enemy); } catch (_) {}
      }
    } else {
      // Ignore player/ground on left click (no move/order)
      selectedUnit = player;
    }
  }
});


window.addEventListener("keydown", (e) => {
  if (e.repeat) return;
  const k = e.key.toLowerCase();
  if (k === "a") {
    // Ensure any existing aim mode is cancelled (defensive - some UI flows may have set aim)
    try {
      player.aimMode = false;
      player.aimModeSkill = null;
      if (aimPreview) aimPreview.visible = false;
      if (attackPreview) attackPreview.visible = false;
      renderer.domElement.style.cursor = "default";
    } catch (e) {}

    keyHoldA = true; // enable autofire while held
    // Auto-select nearest enemy and attempt basic attack.
    const nearest = getNearestEnemy(player.pos(), WORLD.attackRange * (WORLD.attackRangeMult || 1), enemies);
    if (nearest) {
      // select and perform basic attack immediately
      player.target = nearest;
      player.moveTarget = null;
      try {
        const d = distance2D(player.pos(), nearest.pos());
        player.attackMove = d > (WORLD.attackRange * (WORLD.attackRangeMult || 1)) * 0.95;
      } catch (err) {
        player.attackMove = false;
      }
      effects.spawnTargetPing(nearest);
      // Attempt basic attack (skills.tryBasicAttack will check cooldown/range)
      try { skills.tryBasicAttack(player, nearest); } catch (err) { /* ignore */ }
    } else {
      // No nearby enemy: do nothing (explicitly avoid entering ATTACK aim mode)
    }
  } else if (k === "q") {
    skills.castSkill("Q");
  } else if (k === "w") {
    skills.castSkill("W");
  } else if (k === "e") {
    skills.castSkill("E");
  } else if (k === "r") {
    skills.castSkill("R");
  } else if (k === "b") {
    portals.recallToVillage(player, setCenterMsg, clearCenterMsg);
  } else if (k === "s") {
    stopPlayer();
  } else if (k === "m") {
    try {
      const remain = portals.getMarkCooldownMs?.() ?? 0;
      if (remain > 0) {
        const s = Math.ceil(remain / 1000);
        setCenterMsg(`Mark ready in ${s}s`);
        setTimeout(() => clearCenterMsg(), 1200);
      } else {
        const m = portals.addPersistentMarkAt?.(player.pos());
        if (m) {
          setCenterMsg("Flag placed");
          setTimeout(() => clearCenterMsg(), 1100);
        }
      }
    } catch (_) {}
  } else if (k === "escape") {
    // no-op (aiming removed)
  }
});

window.addEventListener("keyup", (e) => {
  const k = (e.key || "").toLowerCase();
  if (k === "a") {
    keyHoldA = false;
  }
});

/* Arrow keys: continuous movement while held */
window.addEventListener("keydown", (e) => {
  const k = e.key;
  if (k === "ArrowUp" || k === "ArrowDown" || k === "ArrowLeft" || k === "ArrowRight") {
    try { e.preventDefault(); } catch (_) {}
    if (k === "ArrowUp") keyMove.up = true;
    if (k === "ArrowDown") keyMove.down = true;
    if (k === "ArrowLeft") keyMove.left = true;
    if (k === "ArrowRight") keyMove.right = true;

    // Immediate ping on arrow press (match right-click), and start cadence
    try {
      const dir = getKeyMoveDir ? getKeyMoveDir() : { active: false };
      if (dir && dir.active && effects && effects.spawnMovePing) {
        const base = player.pos();
        const speed = 10;
        const px = base.x + dir.x * speed;
        const pz = base.z + dir.y * speed;
        effects.spawnMovePing(new THREE.Vector3(px, 0, pz));
        __arrowContPingT = now() + __MOVE_PING_INTERVAL;
      } else {
        __arrowContPingT = 0;
      }
    } catch (_) {}
  }
});
window.addEventListener("keyup", (e) => {
  const k = e.key;
  if (k === "ArrowUp" || k === "ArrowDown" || k === "ArrowLeft" || k === "ArrowRight") {
    if (k === "ArrowUp") keyMove.up = false;
    if (k === "ArrowDown") keyMove.down = false;
    if (k === "ArrowLeft") keyMove.left = false;
    if (k === "ArrowRight") keyMove.right = false;
  }
});

// ------------------------------------------------------------
// Systems Update Loop
// ------------------------------------------------------------
let lastMoveDir = new THREE.Vector3(0, 0, 0);
let lastT = now();

// Mobile: Much more aggressive AI and billboard throttling
let __aiStride = renderQuality === "low" ? 3 : (renderQuality === "medium" ? 2 : 1);
if (isMobile) {
  __aiStride = Math.ceil(__aiStride * MOBILE_OPTIMIZATIONS.aiStrideMultiplier);
}
let __aiOffset = 0;
const __MOVE_PING_INTERVAL = 0.3; // seconds between continuous move pings (joystick/arrow). Match right-click cadence.
let __joyContPingT = 0;
let __arrowContPingT = 0;
let __arrowWasActive = false;
let __bbStride = renderQuality === "high" ? 2 : 3;
if (isMobile) {
  __bbStride = Math.max(5, __bbStride + 2); // Much less frequent updates
}
let __bbOffset = 0;

// Mobile: Track frozen enemies (beyond cull distance) to skip their AI entirely
let __frozenEnemies = new Set();
let __lastCullCheckT = 0;
const __CULL_CHECK_INTERVAL = 0.5; // Check every 500ms instead of every frame

if (isMobile) {
  console.info(`[Mobile] AI stride: ${__aiStride}, Billboard stride: ${__bbStride}, Cull distance: ${MOBILE_OPTIMIZATIONS.cullDistance}m`);
}

function animate() {
  requestAnimationFrame(animate);
  const t = now();
  const dt = Math.min(0.05, t - lastT);
  lastT = t;

  // Frame time budget guard to avoid long rAF hitches (tune via window.__FRAME_BUDGET_MS)
  const __frameStartMs = performance.now();
  const __frameBudgetMs = window.__FRAME_BUDGET_MS || (isMobile ? MOBILE_OPTIMIZATIONS.frameBudgetMs : 10.0);
  const __overBudget = () => (performance.now() - __frameStartMs) > __frameBudgetMs;

  // Unified input (Hexagonal service): movement, holds, skills
  inputService.update(t, dt);

  // Mobile joystick movement (touch controls)
  try {
    if (typeof touch !== "undefined" && touch) {
      const joy = touch.getMoveDir?.();
      if (joy && joy.active && !player.frozen && !player.aimMode) {
        const speed = 10; // target distance ahead in world units
        const base = player.pos();
        const px = base.x + joy.x * speed;
        const pz = base.z + joy.y * speed;
        player.moveTarget = new THREE.Vector3(px, 0, pz);
        player.attackMove = false;
        player.target = null;

        // Continuous move ping while joystick held; match right-click indicator exactly
        try {
          const tnow = now();
          if (!__joyContPingT || tnow >= __joyContPingT) {
            effects.spawnMovePing(new THREE.Vector3(px, 0, pz));
            __joyContPingT = tnow + __MOVE_PING_INTERVAL;
          }
        } catch (e) {}
      } else {
        try { __joyContPingT = 0; } catch (_) {}
      }
    }
  } catch (_) {}

  // Continuous move pings for arrow-key movement; match right-click indicator exactly
  try {
    // Prefer the canonical movement state from inputService (capture-phase listeners)
    const ks = inputService && inputService._state ? inputService._state.moveKeys : null;
    let active = false, dx = 0, dy = 0;
    if (ks) {
      dx = (ks.right ? 1 : 0) + (ks.left ? -1 : 0);
      dy = (ks.down ? 1 : 0) + (ks.up ? -1 : 0);
      const len = Math.hypot(dx, dy);
      if (len > 0) { dx /= len; dy /= len; active = true; }
    } else {
      // Fallback to legacy local state if service not present
      const dir = getKeyMoveDir ? getKeyMoveDir() : { active: false };
      if (dir && dir.active) { dx = dir.x; dy = dir.y; active = true; }
    }

    if (active && !player.frozen && !player.aimMode) {
      const speed = 10;
      const base = player.pos();
      const px = base.x + dx * speed;
      const pz = base.z + dy * speed;

      // Fire immediately on initial press, then cadence
      if (!__arrowWasActive) {
        effects.spawnMovePing(new THREE.Vector3(px, 0, pz));
        __arrowContPingT = t + __MOVE_PING_INTERVAL;
      } else if (!__arrowContPingT || t >= __arrowContPingT) {
        effects.spawnMovePing(new THREE.Vector3(px, 0, pz));
        __arrowContPingT = t + __MOVE_PING_INTERVAL;
      }
      __arrowWasActive = true;
    } else {
      __arrowWasActive = false;
      __arrowContPingT = 0;
    }
  } catch (_) {}

  updatePlayer(dt);
  updateEnemies(dt);
  if (firstPerson && typeof player !== "undefined") {
    // Reuse temp vectors to avoid per-frame allocations in the FP hand code.
    // left/right are aliases into the shared pool (copied into mid when needed).
    const ud = player.mesh.userData || {};
    const left = __tempVecA;
    const right = __tempVecB;
    left.set(0, 0, 0);
    right.set(0, 0, 0);
    if (ud.leftHandAnchor && ud.handAnchor) {
      // getWorldPosition writes into the provided vector
      ud.leftHandAnchor.getWorldPosition(left);
      ud.handAnchor.getWorldPosition(right);
    } else {
      const p = player.pos();
      // single branch covers both handAnchor variants with identical offsets
      left.set(p.x - 0.4, p.y + 1.15, p.z + 0.25);
      right.set(p.x + 0.4, p.y + 1.15, p.z + 0.25);
    }

    // Midpoint between hands, and forward vector from player orientation
    // mid stored in __tempVecC (copied from left/right), forward reuses __tempVecA
    const mid = __tempVecC.copy(left).add(right).multiplyScalar(0.5);
    const forward = __tempVecA.set(0, 0, 1).applyQuaternion(player.mesh.quaternion).normalize();

    // FP hand VFX and gestures (two hands, thunder-in-hand, move/attack animations)
    try {
      const ud2 = player.mesh.userData || {};
      const speed = lastMoveDir.length();
      const tnow = now();

      // Movement/idle crackle scheduling around hands
      if (!ud2.nextCrackleT || tnow >= ud2.nextCrackleT) {
        const strength = 0.6 + speed * 2.0;
        effects.spawnHandCrackle(player, false, strength);
        effects.spawnHandCrackle(player, true, strength * 0.8);
        ud2.nextCrackleT = tnow + (speed > 0.1 ? 0.18 + Math.random() * 0.2 : 0.55 + Math.random() * 0.35);
      }

      // Boost orb/light intensity based on movement and a small flicker
      const flick = Math.sin(tnow * 10) * 0.2;
      if (ud2.thunderOrb && ud2.thunderOrb.material) {
        ud2.thunderOrb.material.emissiveIntensity = 2.1 + speed * 0.6 + flick;
      }
      if (ud2.leftThunderOrb && ud2.leftThunderOrb.material) {
        ud2.leftThunderOrb.material.emissiveIntensity = 1.9 + speed * 0.5 + flick * 0.8;
      }
      if (ud2.handLight) ud2.handLight.intensity = 1.2 + speed * 0.8;
      if (ud2.leftHandLight) ud2.leftHandLight.intensity = 1.0 + speed * 0.7;

      // Randomized gesture wobble while moving or idle, plus brace lift when attacking
      const rArm = ud2.rightArm, lArm = ud2.leftArm;
      if (rArm && lArm) {
        const moveAmp = 0.12 * Math.min(1, speed * 3);
        const idleAmp = 0.06;
        const phase = tnow * 6 + Math.random() * 0.05; // slight desync
        const amp = (speed > 0.02 ? moveAmp : idleAmp);
        const braceN = player.braceUntil && tnow < player.braceUntil ? Math.max(0, (player.braceUntil - tnow) / 0.18) : 0;

        // Base pose + sinusoidal bob + brace squash
        rArm.rotation.x = -Math.PI * 0.12 + Math.sin(phase) * amp - braceN * 0.15;
        lArm.rotation.x =  Math.PI * 0.12 + Math.cos(phase) * amp - braceN * 0.12;

        // Subtle sway and random micro-gestures
        rArm.rotation.y = 0.02 + Math.sin(phase * 0.5) * amp * 0.5 + (Math.random() - 0.5) * 0.01;
        lArm.rotation.y = -0.02 + Math.cos(phase * 0.5) * amp * 0.5 + (Math.random() - 0.5) * 0.01;

        // Occasional quick gesture twitch
        if (!ud2.nextGestureT || tnow >= ud2.nextGestureT) {
          rArm.rotation.z += (Math.random() - 0.5) * 0.08;
          lArm.rotation.z += (Math.random() - 0.5) * 0.08;
          ud2.nextGestureT = tnow + 0.35 + Math.random() * 0.5;
        }
      }
    } catch (e) {}

    // Position camera slightly behind the hands (negative forward)
    // and bias framing so the visible model sits near the center-bottom of the screen
    const fpBack = 4.5;      // match pre-refactor feel (further behind the hands)
    const fpUp = 2.0;        // minimal vertical raise of camera to avoid occlusion
    const fpLookAhead = 3.0;  // look further ahead so enemies occupy the center
    const fpLookUp = 1.1;     // tilt camera upward more so hands/model sit lower in the frame

    // Compute desired camera position and look target without aliasing pooled vectors.
    // desiredPos -> __tempVecB, mid in __tempVecC, forward in __tempVecA
    __tempVecB.copy(mid).addScaledVector(forward, -fpBack);
    __tempVecB.y += fpUp;
    camera.position.lerp(__tempVecB, 1 - Math.pow(0.001, dt));

    // lookTarget -> reuse __tempVecB after lerp
    const lookTarget = __tempVecB.copy(mid).addScaledVector(forward, fpLookAhead);
    lookTarget.y += fpLookUp;
    camera.lookAt(lookTarget);
  } else {
    updateCamera(camera, player, lastMoveDir, dt, cameraOffset, cameraShake);
  }
  updateGridFollow(ground, player);
  if (env) updateEnvironmentFollow(env, player);

  // Throttle HUD and minimap updates to reduce main-thread DOM work on low-end devices.
  // HUD_UPDATE_MS / MINIMAP_UPDATE_MS are configured near the top of this file and exposed for tuning.
  try {
    const nowMs = performance.now();
    // HUD
    try {
      if (!window.__lastHudT) window.__lastHudT = 0;
      if ((nowMs - window.__lastHudT) >= (window.__HUD_UPDATE_MS || HUD_UPDATE_MS)) {
        window.__lastHudT = nowMs;
        try { ui.updateHUD(player); } catch (_) {}
      }
    } catch (_) {}
    // MINIMAP
    try {
      if (!window.__lastMinimapT) window.__lastMinimapT = 0;
      if ((nowMs - window.__lastMinimapT) >= (window.__MINIMAP_UPDATE_MS || MINIMAP_UPDATE_MS)) {
        window.__lastMinimapT = nowMs;
        try { ui.updateMinimap(player, enemies, portals, villages); } catch (_) {}
      }
    } catch (_) {}
  } catch (_) {
    // Fallback: if anything goes wrong, keep original per-frame updates to preserve behavior.
    try { ui.updateHUD(player); } catch (_) {}
    try { ui.updateMinimap(player, enemies, portals, villages); } catch (_) {}
  }

  skills.update(t, dt, cameraShake);
  effects.update(t, dt);
  if (env && typeof env.update === "function") env.update(t, dt);

  // Stream world features: ensure far village(s) exist as player travels
  // Throttle world streaming to avoid per-frame overhead and hitching
  if (!window.__lastVillageStreamT) window.__lastVillageStreamT = 0;
  const __nowMs = performance.now();
  if ((__nowMs - window.__lastVillageStreamT) >= (window.__VILLAGE_STREAM_MS || 150)) {
    try { villages.ensureFarVillage(player.pos()); } catch (_) {}
    try { villages.updateVisitedVillage(player.pos()); } catch (_) {}
    window.__lastVillageStreamT = __nowMs;
  }
  // When entering a village, connect it to previous visited village with a road

  if (!__overBudget()) {
    updateIndicators(dt);
    portals.update(dt);
    villages.updateRest(player, dt);
    updateDeathRespawn();
  }

  if (!__overBudget()) {
    // Billboard enemy hp bars to face camera (throttled)
    __bbOffset = (__bbOffset + 1) % __bbStride;
    enemies.forEach((en, idx) => {
      if (!en.alive) return;
      // Mobile: Skip billboarding for frozen/culled enemies
      if (isMobile && __frozenEnemies.has(en)) return;
      if ((idx % __bbStride) !== __bbOffset) return;
      if (en.hpBar && en.hpBar.container) en.hpBar.container.lookAt(camera.position);
    });
  }

  if (!__overBudget()) {
    // Update hero overhead bars and billboard to camera
    if (heroBars) {
      const hpRatio = clamp01(player.hp / player.maxHP);
      const mpRatio = clamp01(player.mp / player.maxMP);
      heroBars.hpFill.scale.x = Math.max(0.001, hpRatio);
      heroBars.mpFill.scale.x = Math.max(0.001, mpRatio);
      heroBars.container.lookAt(camera.position);
    }
  }

  renderer.render(scene, camera);

  try {
    if (!window.__gameRenderReadyDispatched) {
      window.__gameRenderReadyDispatched = true;
      try {
        const c = renderer && renderer.domElement;
        if (c) {
          try { c.style.opacity = "1"; } catch (_) {}
        }
      } catch (_) {}
      try { window.dispatchEvent(new Event("game-render-ready")); } catch (_) {}
    }
  } catch (_) {}

  // Update perf metrics (throttled)
  try {
    __computePerf(performance.now());
    // Throttle heavy renderer.info snapshotting / perf exposure to reduce cost.
    // Tunable at runtime via window.__PERF_INFO_THROTTLE_MS (default 1000ms).
    const PERF_INFO_THROTTLE_MS = window.__PERF_INFO_THROTTLE_MS || 1000;
    if (!window.__lastPerfInfoT) window.__lastPerfInfoT = 0;
    const nowPerfT = performance.now();
    if ((nowPerfT - window.__lastPerfInfoT) >= PERF_INFO_THROTTLE_MS) {
      window.__lastPerfInfoT = nowPerfT;
      try { window.__perfMetrics = getPerf(); } catch (_) {}
    }
  } catch (_) {}

  // Adaptive performance: adjust AI stride but maintain minimum enemy count
  try {
    if (!__adaptNextT || t >= __adaptNextT) {
      const fps = __perf.fps || 60;
      if (fps < 25) {
        // Increase AI throttling instead of reducing enemy count
        __aiStride = Math.min(8, (__aiStride || 1) + 1);
        // Only slightly reduce performance scale, minimum of 1.0 to keep ~50 enemies
        __enemyPerfScale = Math.max(1.0, (__enemyPerfScale || 1) - 0.05);
      } else if (fps > 50) {
        __aiStride = Math.max(1, (__aiStride || 1) - 1);
        __enemyPerfScale = Math.min(1.2, (__enemyPerfScale || 1) + 0.05);
      }
      __adaptNextT = t + 1.5;
    }
  } catch (_) {}
}

animate();

// ------------------------------------------------------------
// Helpers and per-system updates
// ------------------------------------------------------------

// Pick a random valid spawn position for enemies around the village ring.
// Ensures spawns are outside the village rest radius and within the world enemy spawn radius.
function randomEnemySpawnPos() {
  // Dynamic enemy spawn around the hero for continuous gameplay.
  const angle = Math.random() * Math.PI * 2;
  const minR = Math.max(30, WORLD.enemySpawnRadius * 0.5);
  const maxR = Math.max(minR + 1, WORLD.enemySpawnRadius);
  const r = minR + Math.random() * (maxR - minR);

  // Base candidate around player's current position
  const center = player.pos();
  const cand = new THREE.Vector3(
    center.x + Math.cos(angle) * r,
    0,
    center.z + Math.sin(angle) * r
  );

  // Keep out of village rest radius if near village
  const dvx = cand.x - VILLAGE_POS.x;
  const dvz = cand.z - VILLAGE_POS.z;
  const dVillage = Math.hypot(dvx, dvz);
  if (dVillage < REST_RADIUS + 2) {
    const push = (REST_RADIUS + 2) - dVillage + 0.5;
    const nx = dvx / (dVillage || 1);
    const nz = dvz / (dVillage || 1);
    cand.x += nx * push;
    cand.z += nz * push;
  }

  // Keep out of any discovered dynamic village rest radius
  try {
    const list = villages?.listVillages?.() || [];
    for (const v of list) {
      const dvx2 = cand.x - v.center.x;
      const dvz2 = cand.z - v.center.z;
      const d2 = Math.hypot(dvx2, dvz2);
      const r2 = (v.radius || 0) + 2;
      if (d2 < r2) {
        const nx2 = dvx2 / (d2 || 1);
        const nz2 = dvz2 / (d2 || 1);
        const push2 = r2 - d2 + 0.5;
        cand.x += nx2 * push2;
        cand.z += nz2 * push2;
      }
    }
  } catch (_) {}

  return cand;
}

function stopPlayer() {
  // cancel movement/attack orders
  player.moveTarget = null;
  player.attackMove = false;
  player.target = null;

  // ensure no aim-related UI or state (aiming removed)
  player.aimMode = false;
  player.aimModeSkill = null;
  try {
    if (aimPreview) aimPreview.visible = false;
    if (attackPreview) attackPreview.visible = false;
    renderer.domElement.style.cursor = "default";
  } catch (_) {}

  // brief hold to prevent instant re-acquire
  player.holdUntil = now() + 0.4;
}

function updatePlayer(dt) {
  // Regen
  player.hp = Math.min(player.maxHP, player.hp + player.hpRegen * dt);
  player.mp = Math.min(player.maxMP, player.mp + player.mpRegen * dt);
  player.idlePhase += dt;

  // Dead state
  if (!player.alive) {
    player.mesh.position.y = 1.1;
    return;
  }

  // Freeze: no movement
  if (player.frozen) {
    player.mesh.position.y = 1.1;
    return;
  }

  // Auto-acquire nearest enemy if idle and in range (disabled — manual control)
  // Automatic target acquisition was removed so the player fully controls targeting and attacking.
  /*
  if (!player.moveTarget && (!player.target || !player.target.alive) && (!player.holdUntil || now() >= player.holdUntil)) {
    const nearest = getNearestEnemy(player.pos(), WORLD.attackRange + 0.5, enemies);
    if (nearest) player.target = nearest;
  }
  */

  // Attack-move: user-initiated attack-move is respected but automatic acquisition/auto-attack is disabled.
  if (player.attackMove) {
    // Intentionally left blank to avoid auto-acquiring targets while attack-moving.
    // Player must explicitly initiate attacks (e.g. press 'a' then click an enemy).
  }

  // Movement towards target or moveTarget
  let moveDir = null;
  if (player.target && player.target.alive) {
    const d = distance2D(player.pos(), player.target.pos());
    // Do NOT auto-move or auto-basic-attack when a target is set.
    // If the player explicitly used attack-move (player.attackMove) then allow moving toward the target.
    if (player.attackMove && d > (WORLD.attackRange * (WORLD.attackRangeMult || 1)) * 0.95) {
      moveDir = dir2D(player.pos(), player.target.pos());
    } else {
      // Otherwise, only auto-face the target when nearby (no auto-attack).
      if (d <= (WORLD.attackRange * (WORLD.attackRangeMult || 1)) * 1.5) {
        const v = dir2D(player.pos(), player.target.pos());
        const targetYaw = Math.atan2(v.x, v.z);
        const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, targetYaw, 0));
        player.mesh.quaternion.slerp(q, Math.min(1, player.turnSpeed * 1.5 * dt));
        player.lastFacingYaw = targetYaw;
        player.lastFacingUntil = now() + 0.6;
      }
    }
  } else if (player.moveTarget) {
    const d = distance2D(player.pos(), player.moveTarget);
    if (d > 0.6) {
      moveDir = dir2D(player.pos(), player.moveTarget);
    } else {
      player.moveTarget = null;
    }
  }

  if (moveDir) {
    const spMul = (player.speedBoostUntil && now() < player.speedBoostUntil && player.speedBoostMul) ? player.speedBoostMul : 1;
    const effSpeed = player.speed * spMul;
    player.mesh.position.x += moveDir.x * effSpeed * dt;
    player.mesh.position.z += moveDir.z * effSpeed * dt;

    // Rotate towards movement direction smoothly
    const targetYaw = Math.atan2(moveDir.x, moveDir.z);
    const euler = new THREE.Euler(0, targetYaw, 0);
    const q = new THREE.Quaternion().setFromEuler(euler);
    player.mesh.quaternion.slerp(q, Math.min(1, player.turnSpeed * dt));

    // record move direction for camera look-ahead
    lastMoveDir.set(moveDir.x, 0, moveDir.z);
  } else {
    // stationary: face current target if any
    if (player.target && player.target.alive) {
      const v = dir2D(player.pos(), player.target.pos());
      const targetYaw = Math.atan2(v.x, v.z);
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, targetYaw, 0));
      player.mesh.quaternion.slerp(q, Math.min(1, player.turnSpeed * 1.5 * dt));
      player.lastFacingYaw = targetYaw;
      player.lastFacingUntil = now() + 0.6;
    } else if (player.lastFacingUntil && now() < player.lastFacingUntil) {
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, player.lastFacingYaw || 0, 0));
      player.mesh.quaternion.slerp(q, Math.min(1, player.turnSpeed * 0.8 * dt));
    }
    // decay look-ahead
    lastMoveDir.multiplyScalar(Math.max(0, 1 - dt * 3));
  }

  // Keep y at ground
  player.mesh.position.y = 1.1;

  // Idle glow pulse and brief brace squash
  const ud = player.mesh.userData || {};
  if (ud.handLight) ud.handLight.intensity = 1.2 + Math.sin((player.idlePhase || 0) * 2.2) * 0.22;
  if (ud.thunderOrb && ud.thunderOrb.material) {
    ud.thunderOrb.material.emissiveIntensity = 2.2 + Math.sin((player.idlePhase || 0) * 2.2) * 0.35;
  }
  if (player.braceUntil && now() < player.braceUntil) {
    const n = Math.max(0, (player.braceUntil - now()) / 0.18);
    player.mesh.scale.set(1, 0.94 + 0.06 * n, 1);
  } else {
    player.mesh.scale.set(1, 1, 1);
  }
}

function updateEnemies(dt) {
  __aiOffset = (__aiOffset + 1) % __aiStride;
  
  // Mobile: Periodic culling check to freeze distant enemies
  if (isMobile && MOBILE_OPTIMIZATIONS.cullDistance) {
    const t = now();
    if (t - __lastCullCheckT > __CULL_CHECK_INTERVAL) {
      __lastCullCheckT = t;
      __frozenEnemies.clear();
      const cullDist = MOBILE_OPTIMIZATIONS.cullDistance;
      const playerPos = player.pos();
      
      enemies.forEach((en) => {
        if (!en.alive) return;
        const dist = distance2D(en.pos(), playerPos);
        if (dist > cullDist) {
          __frozenEnemies.add(en);
          // Stop their movement target to save cycles
          en.moveTarget = null;
        }
      });
    }
  }
  
  enemies.forEach((en, __idx) => {
    // Skip AI updates for frozen enemies entirely
    if (isMobile && __frozenEnemies.has(en)) {
      // Still update HP bar position if visible, but skip AI
      if ((__idx % __bbStride) === __bbOffset && en.hpBar?.container) {
        en.hpBar.container.lookAt(camera.position);
      }
      return;
    }
    
    if ((__idx % __aiStride) !== __aiOffset) return;
    if (!en.alive) {
      // Death cleanup, SFX, and XP grant + schedule respawn
      if (!en._xpGranted) {
        try { audio.sfx("enemy_die"); } catch (e) {}
        en._xpGranted = true;
        player.gainXP(en.xpOnDeath);
        // schedule respawn to maintain density
        en._respawnAt = now() + (WORLD.enemyRespawnDelay || 8);
      }
      // Handle respawn to maintain enemy density; scale stats with current hero level
      if (en._respawnAt && now() >= en._respawnAt) {
        const pos = randomEnemySpawnPos();
        en.respawn(pos, player.level);
        applyMapModifiersToEnemy(en);
      }
      return;
    }
    const toPlayer = player.alive ? distance2D(en.pos(), player.pos()) : Infinity;

    // Stream/recycle enemies that are far away to maintain density around the hero
    const STREAM_DESPAWN_DIST = (WORLD.enemySpawnRadius || 220) * 1.6;
    if (toPlayer > STREAM_DESPAWN_DIST) {
      const pos = randomEnemySpawnPos();
      en.mesh.position.copy(pos);
      en.moveTarget = null;
      en.nextAttackReady = now() + 0.8;
      // skip AI this frame after relocation
      return;
    }

    if (toPlayer < WORLD.aiAggroRadius) {
      // chase player
      const d = toPlayer;
      const ar = en.attackRange || WORLD.aiAttackRange;
      if (d > ar) {
        const v = dir2D(en.pos(), player.pos());
        const spMul = en.slowUntil && now() < en.slowUntil ? en.slowFactor || 0.5 : 1;
        // Tentative next position
        const nx = en.mesh.position.x + v.x * en.speed * spMul * dt;
        const nz = en.mesh.position.z + v.z * en.speed * spMul * dt;
        const nextDistToVillage = Math.hypot(nx - VILLAGE_POS.x, nz - VILLAGE_POS.z);
        if (nextDistToVillage <= REST_RADIUS - 0.25) {
          // Clamp to fence boundary so enemies cannot enter origin village
          const dirFromVillage = dir2D(VILLAGE_POS, en.pos());
          en.mesh.position.x = VILLAGE_POS.x + dirFromVillage.x * (REST_RADIUS - 0.25);
          en.mesh.position.z = VILLAGE_POS.z + dirFromVillage.z * (REST_RADIUS - 0.25);
        } else {
          // Check dynamic villages
          const nextPos = new THREE.Vector3(nx, 0, nz);
          let clamped = false;
          try {
            const inside = villages?.isInsideAnyVillage?.(nextPos);
            if (inside && inside.inside && inside.key !== "origin") {
              const dirFrom = dir2D(inside.center, en.pos());
              const rad = Math.max(0.25, (inside.radius || REST_RADIUS) - 0.25);
              en.mesh.position.x = inside.center.x + dirFrom.x * rad;
              en.mesh.position.z = inside.center.z + dirFrom.z * rad;
              clamped = true;
            }
          } catch (_) {}
          if (!clamped) {
            en.mesh.position.x = nx;
            en.mesh.position.z = nz;
          }
        }
        // face
        const yaw = Math.atan2(v.x, v.z);
        const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, 0));
        en.mesh.quaternion.slerp(q, 0.2);
      } else {
        // Attack
        const t = now();
        if (t >= (en.nextAttackReady || 0)) {
          const cd = en.attackCooldown || WORLD.aiAttackCooldown;
          en.nextAttackReady = t + cd;
          // Visual / Effect per enemy kind
          // Reuse temp vectors to avoid allocations in hot attack path
          __tempVecA.copy(en.pos()).add(__tempVecB.set(0, 1.4, 0)); // from
          __tempVecC.copy(player.pos()).add(__tempVecB.set(0, 1.2, 0)); // to

          try {
            // Centralized VFX gating: use shouldSpawnVfx(kind, pos) to decide whether to spawn heavy effects.
            if (en.attackEffect === "melee") {
              // impact strike at player (light-weight)
              try { effects.spawnStrike(player.pos(), 0.9, 0xff9955); } catch (_) {}
            } else if (en.attackEffect === "electric") {
              try {
                if (shouldSpawnVfx("electric", __tempVecA)) {
                  effects.spawnElectricBeamAuto(__tempVecA, __tempVecC, en.beamColor || 0x9fd8ff, 0.1);
                }
              } catch (_) {}
            } else {
              // default beam (archer/others)
              try {
                if (shouldSpawnVfx("largeBeam", __tempVecA)) {
                  effects.spawnBeam(__tempVecA, __tempVecC, en.beamColor || 0xff8080, 0.09);
                }
              } catch (_) {}
            }
          } catch (e) {}
          // Damage
          player.takeDamage(en.attackDamage);
          // SFX: player hit by enemy
          try { audio.sfx("player_hit"); } catch (e) {}
          // floating damage popup on player
          try { effects.spawnDamagePopup(player.pos(), en.attackDamage, 0xffd0d0); } catch (e) {}
        }
      }
    } else {
      // Wander around their spawn origin
      if (!en.moveTarget || Math.random() < 0.005) {
        const ang = Math.random() * Math.PI * 2;
        const r = Math.random() * WORLD.aiWanderRadius;
        __tempVecA.copy(en.pos()).add(__tempVecB.set(Math.cos(ang) * r, 0, Math.sin(ang) * r));
        en.moveTarget = __tempVecA.clone();
      }
      const d = distance2D(en.pos(), en.moveTarget);
      if (d > 0.8) {
        const v = dir2D(en.pos(), en.moveTarget);
        const spMul = en.slowUntil && now() < en.slowUntil ? en.slowFactor || 0.5 : 1;
        en.mesh.position.x += v.x * en.speed * spMul * 0.6 * dt;
        en.mesh.position.z += v.z * en.speed * spMul * 0.6 * dt;
      }
    }

    // keep y
    en.mesh.position.y = 1.0;

    // Update HP bar
    en.updateHPBar();

    // Death cleanup, SFX, and XP grant + schedule respawn
    if (!en.alive && !en._xpGranted) {
      try { audio.sfx("enemy_die"); } catch (e) {}
      en._xpGranted = true;
      player.gainXP(en.xpOnDeath);
      // schedule respawn to maintain enemy density
      en._respawnAt = now() + (WORLD.enemyRespawnDelay || 8);
    }
    // Handle respawn to maintain enemy density; scale stats with current hero level
    if (!en.alive && en._respawnAt && now() >= en._respawnAt) {
      const pos = randomEnemySpawnPos();
      en.respawn(pos, player.level);
    }
  });
}

function updateIndicators(dt) {
  // Selection ring: follow currently selected unit
  if (selectedUnit && selectedUnit.alive) {
    selectionRing.visible = true;
    const p = selectedUnit.pos();
    selectionRing.position.set(p.x, 0.02, p.z);
    const col = selectedUnit.team === "enemy" ? 0xff6060 : 0x7cc4ff;
    selectionRing.material.color.setHex(col);
  } else {
    selectionRing.visible = false;
  }

  // Subtle rotation for aim ring for feedback

  // Mobile: Skip slow debuff indicators (expensive CPU work)
  if (!isMobile || !MOBILE_OPTIMIZATIONS.skipSlowUpdates) {
    // Slow debuff indicator rings
    const t = now();
    enemies.forEach((en) => {
      const slowed = en.slowUntil && t < en.slowUntil;
      if (slowed) {
        if (!en._slowRing) {
          const r = createGroundRing(0.6, 0.9, 0x66aaff, 0.7);
          effects.indicators.add(r);
          en._slowRing = r;
        }
        const p = en.pos();
        en._slowRing.position.set(p.x, 0.02, p.z);
        en._slowRing.visible = true;
      } else if (en._slowRing) {
        effects.indicators.remove(en._slowRing);
        en._slowRing.geometry.dispose?.();
        en._slowRing = null;
      }
    });
  }

  // Hand charged micro-sparks when any skill is ready
  const anyReady = !(skills.isOnCooldown("Q") && skills.isOnCooldown("W") && skills.isOnCooldown("E") && skills.isOnCooldown("R"));
  const t = now();
  if (anyReady && (window.__nextHandSparkT ?? 0) <= t) {
    // Use temp vectors to avoid allocating from/to per spark
    const from = handWorldPos(player);
    __tempVecA.copy(from);
    __tempVecB.set((Math.random() - 0.5) * 0.6, 0.2 + Math.random() * 0.3, (Math.random() - 0.5) * 0.6);
    __tempVecC.copy(from).add(__tempVecB);
    effects.spawnElectricBeam(__tempVecA, __tempVecC, 0x9fd8ff, 0.06, 5, 0.2);
    window.__nextHandSparkT = t + 0.5 + Math.random() * 0.5;
  }
}

function updateDeathRespawn() {
  const t = now();
  if (!player.alive && player.deadUntil && t >= player.deadUntil) {
    // Respawn at village
    player.alive = true;
    player.mesh.visible = true;
    player.mesh.position.copy(VILLAGE_POS).add(new THREE.Vector3(1.5, 0, 0));
    player.hp = player.maxHP;
    player.mp = player.maxMP;
    player.moveTarget = null;
    player.target = null;
    player.invulnUntil = now() + 2;
    clearCenterMsg();
  }
}

// ------------------------------------------------------------
// Window resize
// ------------------------------------------------------------
addResizeHandler(renderer, camera);

// ------------------------------------------------------------
// Align player start facing village center
// ------------------------------------------------------------
(function initFace() {
  const v = dir2D(player.pos(), VILLAGE_POS);
  const yaw = Math.atan2(v.x, v.z);
  player.mesh.quaternion.setFromEuler(new THREE.Euler(0, yaw, 0));
})();

// ------------------------------------------------------------
// Guide overlay wiring (modular version)
// ------------------------------------------------------------
try { window.startInstructionGuide = startInstructionGuideOverlay; } catch (_) {}
document.addEventListener("click", (ev) => {
  const tEl = ev.target;
  if (tEl && tEl.id === "btnInstructionGuide") {
    try { startInstructionGuideOverlay(); } catch (_) {}
  }
});
