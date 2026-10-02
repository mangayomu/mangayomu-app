/**
 * Theme utilities — persist & toggle dark mode.
 * Shared by imports from views that need theme control.
 */
var STORAGE_KEY = "manga-theme";

function getTheme() {
  try { return localStorage.getItem(STORAGE_KEY); } catch (e) { return null; }
}

function setTheme(t) {
  try { localStorage.setItem(STORAGE_KEY, t); } catch (e) {}
}

function applyTheme(t) {
  if (t === "dark") {
    document.documentElement.classList.add("dark");
  } else {
    document.documentElement.classList.remove("dark");
  }
}

export function isDark() {
  var t = getTheme();
  if (t === "dark") return true;
  if (t === "light") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function toggleTheme() {
  var dark = isDark();
  var next = dark ? "light" : "dark";
  setTheme(next);
  applyTheme(next);
}

export function setThemePreference(theme) {
  if (theme !== "light" && theme !== "dark") return;
  setTheme(theme);
  applyTheme(theme);
}
