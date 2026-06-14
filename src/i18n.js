/**
 * i18n utility (logic only) for GoT RPG.
 *
 * Behavior:
 * - Loads locale JSON files dynamically from ./locales/{lang}.json (relative to this module).
 * - Caches loaded locales and persists selected language in localStorage ("lang").
 * - t(key) is non-blocking: if the locale file is not yet loaded (or key missing), it immediately
 *   returns the key string so the UI can render quickly. After the JSON is loaded, translations
 *   are re-applied.
 */

const STORAGE_KEY = "lang";
const FALLBACK_LANG = "en";
const SUPPORTED_LANGS = new Set(["en", "vi"]);
/** Non-English locale bundles we ship (English is the default fallback). */
const LOCALIZED_LANGS = new Set(["vi"]);

/**
 * Pick language from device settings. Vietnamese when the device locale is vi*;
 * otherwise English.
 */
export function detectDeviceLanguage() {
  try {
    if (typeof navigator === "undefined") return FALLBACK_LANG;
    const candidates = navigator.languages?.length
      ? navigator.languages
      : [navigator.language];
    for (const raw of candidates) {
      if (!raw) continue;
      const code = String(raw).split("-")[0].toLowerCase();
      if (LOCALIZED_LANGS.has(code)) return code;
    }
  } catch (e) {
    // ignore
  }
  return FALLBACK_LANG;
}

function resolveInitialLanguage() {
  try {
    const saved = typeof localStorage !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
    if (saved && SUPPORTED_LANGS.has(saved)) return saved;
  } catch (e) {
    // ignore
  }
  return detectDeviceLanguage();
}

/**
 * LOCALES cache structure:
 * {
 *   en: { status: "loaded" | "loading" | "error", data: Object|null, promise: Promise|null },
 *   vi: { ... }
 * }
 */
const LOCALES = {};

let currentLang = resolveInitialLanguage();

/**
 * Load a locale JSON file (./locales/{lang}.json) relative to this module.
 * Returns a Promise that resolves to the locale object or null on error.
 * Caches in LOCALES to avoid duplicate network requests.
 */
export function loadLocale(lang) {
  if (!lang) return Promise.resolve(null);

  const existing = LOCALES[lang];
  if (existing) {
    if (existing.status === "loaded") return Promise.resolve(existing.data);
    if (existing.promise) return existing.promise;
  }

  const url = new URL(`./locales/${lang}.json`, import.meta.url).href;
  const promise = fetch(url, { cache: "no-cache" })
    .then((res) => {
      if (!res.ok) throw new Error(`Failed to load locale ${lang}: ${res.status}`);
      return res.json();
    })
    .then((json) => {
      LOCALES[lang] = { status: "loaded", data: json, promise: null };
      return json;
    })
    .catch((err) => {
      // Keep a record so we don't continuously retry on failure
      console.error("i18n: loadLocale error", err);
      LOCALES[lang] = { status: "error", data: null, promise: null };
      return null;
    });

  LOCALES[lang] = { status: "loading", data: null, promise };
  return promise;
}

/**
 * Translate by key from current language.
 * Non-blocking: if translation is not available, returns the key string.
 */
export function t(key) {
  const locale = LOCALES[currentLang] && LOCALES[currentLang].data;
  if (!locale || !key) return key;

  // Support nested keys using dot notation, e.g. "hero.info.level"
  const parts = String(key).split(".");
  let val = locale;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (val && Object.prototype.hasOwnProperty.call(val, p)) {
      val = val[p];
    } else {
      val = undefined;
      break;
    }
  }

  return Array.isArray(val) || typeof val === "string" ? val : key;
}

/**
 * Apply translations to all elements with [data-i18n] within root.
 * If translations are not yet loaded, the elements will receive the raw key text.
 */
export function applyTranslations(root = document) {
  if (!root || !root.querySelectorAll) return;
  root.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.getAttribute("data-i18n");
    const val = t(key);
    if (Array.isArray(val)) {
      el.textContent = val.join("\n");
    } else {
      el.textContent = val;
    }
  });
  if (root.documentElement) root.documentElement.lang = currentLang;
}

/**
 * Render the instructions list into a container element.
 */
export function renderInstructions(container) {
  if (!container) return;
  container.innerHTML = "";
  const ul = document.createElement("div");
  const items = t("instructions.items");
  if (Array.isArray(items)) {
    items.forEach((line) => {
      const li = document.createElement("div");
      li.textContent = line;
      ul.appendChild(li);
    });
  } else {
    // Render a single item containing the returned value (likely the key) so UI isn't empty.
    const li = document.createElement("div");
    li.textContent = items;
    ul.appendChild(li);
  }
  container.appendChild(ul);
}

/**
 * Set active language and persist to localStorage.
 * Non-blocking: immediately applies keys so the UI updates without waiting for fetch.
 * When the JSON finishes loading, translations are re-applied.
 */
export function setLanguage(lang) {
  if (!lang) return;
  currentLang = lang;
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch (e) {
    // ignore
  }

  // Apply immediate (will show keys if not loaded)
  applyTranslations(document);
  const instr = document.getElementById("settingsInstructions");
  if (instr) renderInstructions(instr);

  // Load and re-apply when ready
  loadLocale(lang).then(() => {
    applyTranslations(document);
    if (instr) renderInstructions(instr);
  });
}

/**
 * Initialize i18n. Uses saved preference, else device locale (vi → Vietnamese, else English).
 * Ensures localStorage has a value and starts loading the selected locale.
 */
export function initI18n() {
  try {
    const saved = typeof localStorage !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
    if (saved && SUPPORTED_LANGS.has(saved)) {
      currentLang = saved;
    } else {
      currentLang = detectDeviceLanguage();
      localStorage.setItem(STORAGE_KEY, currentLang);
    }
  } catch (e) {
    // ignore
  }

  // Expose helpers on window for convenience (used by splash/start flow)
  try {
    if (typeof window !== "undefined") {
      window.applyTranslations = applyTranslations;
      window.loadLocale = loadLocale;
    }
  } catch (e) {}

  // Apply keys immediately so the UI is populated
  applyTranslations(document);
  const instr = document.getElementById("settingsInstructions");
  if (instr) renderInstructions(instr);

  // Load selected locale and re-apply once it's available
  loadLocale(currentLang).then(() => {
    applyTranslations(document);
    if (instr) renderInstructions(instr);
  });
}

export function getLanguage() {
  return currentLang;
}
