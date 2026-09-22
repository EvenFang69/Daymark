const APP_NAME = "Daymark";

const state = {
  session: null,
  page: "record",
  entries: [],
  todayEntries: [],
  entryDetails: {},
  rawOpen: {},
  rawLoaded: {},
  detailEntryId: null,
  detailLoading: {},
  detailErrors: {},
  timelineDate: "",
  timelineEntries: [],
  timelineReport: null,
  reviewView: "month",
  calendarCursor: "",
  calendarSelectedDate: "",
  calendarDays: [],
  calendarLoading: false,
  reviewEntries: [],
  reviewReport: null,
  reportLoading: false,
  searchQuery: "",
  answers: [],
  answersLoaded: false,
  askPendingRequest: null,
  asking: false,
  memory: { rollups: [], proposals: [] },
  memoryDetail: null,
  memoryDetailLoading: false,
  memoryDetailError: "",
  memoryExpandedRollup: "",
  sourceVersion: null,
  searchRawOpen: {},
  newEntryIds: {},
  sending: false,
  polling: {},
  settingsOpen: false,
  dialog: null,
  composer: "",
  sendStatus: "",
  sendFailed: false,
  pendingSend: null,
  reviewDataKey: "",
  reviewError: "",
  timelineDataDate: "",
  timelineLoading: false,
  timelineError: "",
  reviewReturnView: "month",
  followupDrafts: {},
  replyingEntries: {},
  composerAttachments: [],
  connectionRetrying: false,
  notice: null,
  error: "",
};

let navigationRevision = 0;
let entriesRevision = 0;
const requests = { review: 0, timeline: 0, entries: 0, search: 0 };
const reviewCache = new Map();
const timelineCache = new Map();
const reportPolls = new Map();
const pageScroll = {};
let overlayScroll = null;
let overlayFocus = null;
let overlayTimer;
let overlayClosing = false;
let gesture = null;
let suppressCalendarClickUntil = 0;
let appearanceTimer;
let appearanceTransitionTimer;
let appearanceSaving = false;
let businessDateTimer;
let memoryDigestPolling = false;
const SPEECH_VOICES = [
  { id: "warm", label: "普通话女声" },
];
const SPEECH_RATES = [.8, 1, 1.25, 1.5, 2];
let speechPlayback = { key: "", text: "", audio: null, objectUrl: "", status: "idle", voice: "warm", rate: 1, error: "" };
try {
  if (localStorage.getItem("journal-speech-voice-version") !== "2") {
    localStorage.setItem("journal-speech-voice", "warm");
    localStorage.setItem("journal-speech-voice-version", "2");
  }
} catch { /* localStorage can be unavailable in private browsing */ }
const answerPolls = new Set();
const MOTION = { enter: 440, exit: 320, theme: 680, curve: "cubic-bezier(.22,1,.36,1)" };
let connectionRetryTimer;
let connectionRetryAttempt = 0;

function cacheResult(cache, key, value) {
  cache.delete(key);
  cache.set(key, value);
  if (cache.size > 16) cache.delete(cache.keys().next().value);
}

// Patch only changed nodes: polling must not replace focused inputs or scroll surfaces.
function nodeKey(node) {
  if (node.nodeType !== 1) return `#${node.nodeType}`;
  return node.tagName + ":" + (node.id || node.getAttribute("data-key") ||
    node.getAttribute("data-entry-id") || node.getAttribute("data-date") ||
    node.getAttribute("data-view") || node.getAttribute("data-action") ||
    node.getAttribute("name") || node.classList[0] || "");
}

function patchChildren(parent, template) {
  let current = parent.firstChild;
  for (const wanted of [...template.childNodes]) {
    const key = nodeKey(wanted);
    let match = current;
    while (match && nodeKey(match) !== key) match = match.nextSibling;
    if (!match) {
      parent.insertBefore(wanted.cloneNode(true), current);
      continue;
    }
    if (match !== current) parent.insertBefore(match, current);
    patchNode(match, wanted);
    current = match.nextSibling;
  }
  while (current) { const next = current.nextSibling; current.remove(); current = next; }
}

function patchNode(current, wanted) {
  if (current.nodeType !== 1) {
    if (current.nodeValue !== wanted.nodeValue) current.nodeValue = wanted.nodeValue;
    return;
  }
  for (const attribute of [...current.attributes]) {
    if (!wanted.hasAttribute(attribute.name) && attribute.name !== "style") current.removeAttribute(attribute.name);
  }
  for (const attribute of [...wanted.attributes]) {
    if (current.getAttribute(attribute.name) !== attribute.value) current.setAttribute(attribute.name, attribute.value);
  }
  if (current.matches("input, textarea, select")) return;
  patchChildren(current, wanted);
}

function patchHTML(parent, html) {
  if (!parent) return;
  const template = document.createElement("template");
  template.innerHTML = html;
  patchChildren(parent, template.content);
}

const motion = new WeakMap();
function animateSurface(element, direction = 0) {
  if (!element?.animate || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  motion.get(element)?.cancel();
  const animation = element.animate([
    { opacity: .3, transform: `translate3d(${direction * 22}px, ${direction ? 0 : 10}px, 0)` },
    { opacity: 1, transform: "translate3d(0, 0, 0)" },
  ], { duration: MOTION.enter, easing: MOTION.curve });
  motion.set(element, animation);
}

const $ = (selector) => document.querySelector(selector);
const esc = (value = "") => String(value)
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#039;");

function renderSpeakButton(key, text) {
  if (!String(text || "").trim()) return "";
  return `<span class="speech-control" data-speech-key="${esc(key)}" data-speech-text="${esc(text)}"><button class="speak-button" type="button" data-action="speak" aria-label="朗读这段内容">朗读</button></span>`;
}

function speechSetting(name, fallback) {
  try { return localStorage.getItem(name) || fallback; }
  catch { return fallback; }
}

function formatAudioTime(value) {
  const seconds = Number.isFinite(Number(value)) ? Math.max(0, Math.round(Number(value))) : 0;
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function speechButtonMarkup() {
  return `<button class="speak-button" type="button" data-action="speak" aria-label="朗读这段内容">朗读</button>`;
}

function speechPlayerMarkup() {
  const loading = speechPlayback.status === "loading";
  const failed = speechPlayback.status === "failed";
  const audio = speechPlayback.audio;
  const duration = Number.isFinite(audio?.duration) ? audio.duration : 0;
  const current = Number.isFinite(audio?.currentTime) ? audio.currentTime : 0;
  const paused = !audio || audio.paused;
  const voiceOptions = SPEECH_VOICES.map((voice) => `<option value="${voice.id}" ${voice.id === speechPlayback.voice ? "selected" : ""}>${voice.label}</option>`).join("");
  if (loading) return `<span class="speech-loading"><i></i><span>正在准备自然语音…</span><button type="button" data-action="speech-stop" aria-label="取消朗读">×</button></span>`;
  if (failed) return `<span class="speech-failed"><span>${esc(speechPlayback.error || "语音暂时无法生成")}</span><button type="button" data-action="speech-retry">重试</button><button type="button" data-action="speech-stop" aria-label="关闭">×</button></span>`;
  return `<span class="speech-player">
    <span class="speech-main-controls">
      <button type="button" data-action="speech-skip" data-seconds="-10" aria-label="后退10秒">↶<small>10</small></button>
      <button class="speech-play" type="button" data-action="speech-toggle" aria-label="${paused ? "继续播放" : "暂停"}">${paused ? "▶" : "Ⅱ"}</button>
      <button type="button" data-action="speech-skip" data-seconds="10" aria-label="前进10秒"><small>10</small>↷</button>
    </span>
    <input class="speech-progress" type="range" min="0" max="${duration || 1}" step="0.1" value="${Math.min(current, duration || 1)}" aria-label="朗读进度" />
    <span class="speech-time">${formatAudioTime(current)} / ${formatAudioTime(duration)}</span>
    <button class="speech-rate" type="button" data-action="speech-rate" aria-label="调整播放速度">${speechPlayback.rate}×</button>
    ${SPEECH_VOICES.length > 1 ? `<select class="speech-voice" aria-label="选择中文音色">${voiceOptions}</select>` : `<span class="speech-voice-label">普通话</span>`}
    <button class="speech-close" type="button" data-action="speech-stop" aria-label="关闭播放器">×</button>
  </span>`;
}

function updateSpeechProgress() {
  const control = [...document.querySelectorAll(".speech-control")].find((item) => item.dataset.speechKey === speechPlayback.key);
  const audio = speechPlayback.audio;
  if (!control || !audio) return;
  const progress = control.querySelector(".speech-progress");
  const time = control.querySelector(".speech-time");
  const play = control.querySelector(".speech-play");
  const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
  if (progress) { progress.max = String(duration || 1); progress.value = String(Math.min(audio.currentTime || 0, duration || 1)); }
  if (time) time.textContent = `${formatAudioTime(audio.currentTime)} / ${formatAudioTime(duration)}`;
  if (play) { play.textContent = audio.paused ? "▶" : "Ⅱ"; play.setAttribute("aria-label", audio.paused ? "继续播放" : "暂停"); }
}

function updateSpeechButtons() {
  document.querySelectorAll(".speech-control").forEach((control) => {
    const active = speechPlayback.key && control.dataset.speechKey === speechPlayback.key;
    if (!active) {
      if (!control.querySelector(".speak-button")) control.innerHTML = speechButtonMarkup();
      return;
    }
    const expectedClass = speechPlayback.status === "loading" ? "speech-loading" : speechPlayback.status === "failed" ? "speech-failed" : "speech-player";
    if (!control.querySelector(`.${expectedClass}`)) control.innerHTML = speechPlayerMarkup();
    updateSpeechProgress();
  });
}

function stopSpeaking() {
  const previous = speechPlayback;
  previous.audio?.pause();
  if (previous.audio) previous.audio.src = "";
  if (previous.objectUrl) URL.revokeObjectURL(previous.objectUrl);
  speechPlayback = { key: "", text: "", audio: null, objectUrl: "", status: "idle", voice: previous.voice || "warm", rate: previous.rate || 1, error: "" };
  updateSpeechButtons();
}

async function requestSpeech(text, voice) {
  const response = await fetch("/api/speech", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": state.session?.csrf_token || "" },
    body: JSON.stringify({ text, voice }),
  });
  if (!response.ok) {
    let code = "speech_generation_failed";
    try { code = (await response.json()).error || code; } catch { /* keep bounded error */ }
    throw new Error(code);
  }
  return response.blob();
}

async function startSpeaking(control, { resumeAt = 0, autoplay = true } = {}) {
  const key = control.dataset.speechKey || "speech";
  const text = String(control.dataset.speechText || "").trim();
  if (!text) return;
  if (speechPlayback.key && speechPlayback.key !== key) stopSpeaking();
  const voice = speechPlayback.key === key ? speechPlayback.voice : speechSetting("journal-speech-voice", "warm");
  const storedRate = Number(speechSetting("journal-speech-rate", "1"));
  speechPlayback = { key, text, audio: null, objectUrl: "", status: "loading", voice, rate: SPEECH_RATES.includes(storedRate) ? storedRate : 1, error: "" };
  updateSpeechButtons();
  try {
    const blob = await requestSpeech(text, voice);
    if (speechPlayback.key !== key || speechPlayback.voice !== voice) return;
    const objectUrl = URL.createObjectURL(blob);
    const audio = new Audio(objectUrl);
    audio.preload = "auto";
    audio.playbackRate = speechPlayback.rate;
    speechPlayback = { ...speechPlayback, audio, objectUrl, status: "ready" };
    audio.addEventListener("loadedmetadata", () => {
      audio.currentTime = Math.min(Math.max(0, resumeAt), Number.isFinite(audio.duration) ? audio.duration : resumeAt);
      updateSpeechButtons();
      if (autoplay) audio.play().catch(() => updateSpeechProgress());
    });
    audio.addEventListener("timeupdate", updateSpeechProgress);
    audio.addEventListener("play", updateSpeechProgress);
    audio.addEventListener("pause", updateSpeechProgress);
    audio.addEventListener("ended", updateSpeechProgress);
    audio.addEventListener("error", () => {
      if (speechPlayback.key === key) {
        speechPlayback.status = "failed";
        speechPlayback.error = "音频加载失败";
        updateSpeechButtons();
      }
    });
    updateSpeechButtons();
  } catch (error) {
    if (speechPlayback.key !== key) return;
    speechPlayback.status = "failed";
    speechPlayback.error = errorText(error);
    updateSpeechButtons();
  }
}

function toggleSpeaking(button) {
  const control = button.closest(".speech-control");
  if (!control) return;
  if (speechPlayback.key === control.dataset.speechKey) return stopSpeaking();
  startSpeaking(control).catch(showError);
}

function changeSpeechVoice(control, voice) {
  if (!SPEECH_VOICES.some((item) => item.id === voice)) return;
  try { localStorage.setItem("journal-speech-voice", voice); } catch { /* keep session value */ }
  const resumeAt = speechPlayback.audio?.currentTime || 0;
  const autoplay = !!speechPlayback.audio && !speechPlayback.audio.paused;
  speechPlayback.voice = voice;
  speechPlayback.audio?.pause();
  if (speechPlayback.objectUrl) URL.revokeObjectURL(speechPlayback.objectUrl);
  speechPlayback.audio = null;
  speechPlayback.objectUrl = "";
  startSpeaking(control, { resumeAt, autoplay }).catch(showError);
}

function clockMinutes(value, fallback) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || ""));
  if (!match) return fallback;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59 ? hour * 60 + minute : fallback;
}

function minutesInTimezone(timezone, now = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone || "Asia/Shanghai",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(now);
    const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return Number(value.hour) * 60 + Number(value.minute);
  } catch {
    return now.getHours() * 60 + now.getMinutes();
  }
}

function appearanceForMinutes(settings = {}, minutes = 0) {
  const mode = settings.appearance_mode || "auto";
  if (mode === "dark" || mode === "light") return mode;
  const darkStart = clockMinutes(settings.dark_mode_start, 20 * 60);
  const lightStart = clockMinutes(settings.light_mode_start, 7 * 60);
  if (darkStart === lightStart) return "dark";
  const isDark = darkStart < lightStart
    ? minutes >= darkStart && minutes < lightStart
    : minutes >= darkStart || minutes < lightStart;
  return isDark ? "dark" : "light";
}

function activeAppearance(settings = {}) {
  return appearanceForMinutes(settings, minutesInTimezone(settings.timezone));
}

function cacheAppearance(settings = {}) {
  try {
    localStorage.setItem("journal-appearance", JSON.stringify({
      timezone: settings.timezone || "Asia/Shanghai",
      appearance_mode: settings.appearance_mode || "auto",
      dark_mode_start: settings.dark_mode_start || "20:00",
      light_mode_start: settings.light_mode_start || "07:00",
    }));
  } catch { /* Private browsing can block local storage. */ }
}

function scheduleAppearance(settings = state.session?.settings) {
  clearTimeout(appearanceTimer);
  if (!settings || (settings.appearance_mode || "auto") !== "auto") return;
  const now = new Date();
  const delay = 60_000 - now.getSeconds() * 1000 - now.getMilliseconds() + 80;
  appearanceTimer = setTimeout(() => {
    applyAppearance(settings, { animate: true, schedule: true, persist: false });
  }, delay);
}

function applyAppearance(settings = state.session?.settings, {
  animate = false, schedule = true, persist = true,
} = {}) {
  const root = document.documentElement;
  if (!root || !settings) return "light";
  const appearance = activeAppearance(settings);
  const changed = root.dataset.theme !== appearance;
  if (changed && animate && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
    clearTimeout(appearanceTransitionTimer);
    root.classList.add("theme-transition");
    // Install transitions before changing their target, without replacing any DOM.
    getComputedStyle(root).backgroundColor;
    appearanceTransitionTimer = setTimeout(() => root.classList.remove("theme-transition"), MOTION.theme + 100);
  }
  root.dataset.theme = appearance;
  root.style.colorScheme = appearance;
  document.querySelector('meta[name="theme-color"]')?.setAttribute(
    "content", appearance === "dark" ? "#10151b" : "#f7f8fa"
  );
  if (persist) cacheAppearance(settings);
  if (schedule) scheduleAppearance(settings);
  syncAppearanceToggle(appearance);
  return appearance;
}

function appearanceToggleMarkup(settings = state.session?.settings || {}) {
  const appearance = activeAppearance(settings);
  const dark = appearance === "dark";
  const label = dark ? "切换为浅色" : "切换为深色";
  return `<button class="icon-button appearance-toggle ${dark ? "is-dark" : ""}" data-action="toggle-appearance" aria-label="${label}" title="${label}"><span aria-hidden="true">${dark ? "☼" : "☾"}</span></button>`;
}

function syncAppearanceToggle(appearance = document.documentElement?.dataset.theme || "light") {
  const button = document.querySelector('[data-action="toggle-appearance"]');
  if (!button) return;
  const dark = appearance === "dark";
  const label = dark ? "切换为浅色" : "切换为深色";
  button.classList.toggle("is-dark", dark);
  button.setAttribute("aria-label", label);
  button.setAttribute("title", label);
  const icon = button.querySelector("span");
  if (icon) icon.textContent = dark ? "☼" : "☾";
}

function restoreAppearance() {
  try {
    const settings = JSON.parse(localStorage.getItem("journal-appearance") || "null");
    if (settings) applyAppearance(settings, { persist: false, schedule: false });
  } catch { /* A fresh install can simply render the default light palette first. */ }
}

async function api(path, options = {}) {
  const { timeoutMs = 15000, ...requestOptions } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const isMultipart = typeof FormData !== "undefined" && requestOptions.body instanceof FormData;
  const headers = { ...(isMultipart ? {} : { "Content-Type": "application/json" }), ...(options.headers || {}) };
  if (state.session?.csrf_token && options.method && options.method !== "GET") {
    headers["X-CSRF-Token"] = state.session.csrf_token;
  }
  try {
    const response = await fetch(path, { credentials: "same-origin", ...requestOptions, headers, signal: controller.signal });
    let data;
    try { data = await response.json(); }
    catch { throw new Error("invalid_server_response"); }
    if (!response.ok) throw new Error(data.error || `请求失败（${response.status}）`);
    return data;
  } catch (error) {
    if (error.name === "AbortError") throw new Error("request_timeout");
    if (error instanceof TypeError) throw new Error("connection_failed");
    throw error;
  } finally { clearTimeout(timer); }
}

// Retain an uncertain submission ID across reloads so retries cannot duplicate it.
function saveDraft() {
  try { localStorage.setItem("journal-composer", JSON.stringify({ text: state.composer, pending: state.pendingSend })); }
  catch { /* Storage can be unavailable in private browsing. Keep the in-memory draft. */ }
}

function restoreDraft() {
  try {
    const draft = JSON.parse(localStorage.getItem("journal-composer") || "{}");
    state.composer = typeof draft.text === "string" ? draft.text : "";
    state.pendingSend = draft.pending && typeof draft.pending.id === "string" && typeof draft.pending.text === "string" ? draft.pending : null;
  } catch { /* Ignore unavailable or invalid local storage. */ }
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function isoDate(dateValue) {
  const year = dateValue.getFullYear();
  const month = String(dateValue.getMonth() + 1).padStart(2, "0");
  const day = String(dateValue.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dateObject(value) {
  const [year, month, day] = String(value).split("-").map(Number);
  return new Date(year, month - 1, day, 12, 0, 0);
}

function localDate() { return isoDate(new Date()); }

function formatDate(value) {
  if (!value) return "";
  const [, month, day] = value.split("-");
  return `${month}月${day}日`;
}

function formatLongDate(value) {
  if (!value) return "";
  return dateObject(value).toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "short" });
}

function formatTime(value) {
  if (!value) return "";
  const dateValue = new Date(value);
  if (Number.isNaN(dateValue.getTime())) return value.slice(11, 16);
  return dateValue.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
}

function businessDate(now = new Date()) {
  const settings = state.session?.settings || {};
  const timezone = settings.timezone || "Asia/Shanghai";
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(now);
    const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    const cutoff = clockMinutes(settings.business_day_cutoff, 4 * 60);
    const minutes = Number(value.hour) * 60 + Number(value.minute);
    const current = new Date(Date.UTC(Number(value.year), Number(value.month) - 1, Number(value.day)));
    if (minutes < cutoff) current.setUTCDate(current.getUTCDate() - 1);
    return `${current.getUTCFullYear()}-${String(current.getUTCMonth() + 1).padStart(2, "0")}-${String(current.getUTCDate()).padStart(2, "0")}`;
  } catch {
    return state.session?.business_date || localDate();
  }
}

function scheduleBusinessDateRefresh() {
  clearInterval(businessDateTimer);
  let previous = businessDate();
  businessDateTimer = setInterval(() => {
    const current = businessDate();
    if (current === previous || !state.session) return;
    previous = current;
    state.session.business_date = current;
    loadEntries().catch(showError);
    if (state.page === "timeline" && !state.timelineDate) loadTimeline().catch(showError);
    if (state.page === "review") loadReviewData().catch(showError);
  }, 60_000);
}

function shiftDateValue(value, days) {
  const current = dateObject(value);
  current.setDate(current.getDate() + days);
  return isoDate(current);
}

function shiftMonthValue(value, months) {
  const current = dateObject(value);
  current.setDate(1);
  current.setMonth(current.getMonth() + months);
  return isoDate(current);
}

function startOfWeek(value) {
  const current = dateObject(value);
  current.setDate(current.getDate() - ((current.getDay() + 6) % 7));
  return isoDate(current);
}

function endOfWeek(value) { return shiftDateValue(startOfWeek(value), 6); }

function monthGridRange(value) {
  const first = dateObject(value);
  first.setDate(1);
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0, 12, 0, 0);
  const start = shiftDateValue(isoDate(first), -((first.getDay() + 6) % 7));
  const end = shiftDateValue(isoDate(last), 6 - ((last.getDay() + 6) % 7));
  return { start, end };
}

function errorText(error) {
  const messages = {
    unauthorized: "登录状态已失效，请重新登录。",
    csrf_failed: "页面状态已更新，请刷新后再试。",
    not_found: "没有找到这条记录。",
    empty_entry: "先写一点内容再发送。",
    empty_reply: "可以回答一句，也可以选择跳过。",
    invalid_date: "日期格式不正确，请使用 YYYY-MM-DD。",
    invalid_calendar_range: "日历范围太大，请缩小后再试。",
    local_space_unavailable: "本地服务没有连接，请确认服务正在运行。",
    api_error: "AI 服务暂时不可用，原文已经保存。",
    missing_api_key: "还没有配置 AI API Key，原文已经保存。",
    entry_not_pending: "这条记录当前不需要重试。",
    request_timeout: "暂未收到保存确认，草稿已保留，请重试。",
    connection_failed: "连不上 Mac 上的记录服务，草稿已保留，请确认 Mac 服务运行后重试。",
    invalid_server_response: "记录服务返回了无效响应，正在尝试恢复连接。",
    entry_too_long: "内容超过 20000 字，请分段发送。",
    request_id_conflict: "重试内容与原提交不一致，请保留草稿后重新打开页面。",
    attachments_too_large: "资料总大小超过 100 MB，请分批上传。",
    attachment_too_large: "单个资料超过 25 MB。",
    too_many_attachments: "一次最多添加 12 个资料。",
    attachment_missing: "资料文件暂时找不到，但记录本身仍在。",
    invalid_settings: "请检查时区和时间，白天与夜间开始时间不能相同。",
    empty_speech: "没有可朗读的内容。",
    speech_too_long: "这段内容太长，请分段朗读。",
    speech_unavailable: "这台 Mac 暂时无法生成中文音频。",
    speech_generation_failed: "中文音频生成失败，请稍后重试。",
  };
  return messages[error?.message] || error?.message || "操作失败，请稍后再试。";
}

function aiFailureText(code) {
  const reasons = {
    api_timeout: "AI 服务响应超时，原文已保存。",
    rate_limit_exceeded: "AI 中转服务正在限流，原文已保存。",
    insufficient_quota: "AI 中转账户额度不足，原文已保存，需要检查平台余额。",
    authentication_failed: "AI 密钥验证失败，原文已保存，需要检查服务端配置。",
    missing_api_key: "尚未配置 AI 密钥，原文已保存。",
    permission_denied: "AI 中转服务拒绝了访问，原文已保存。",
    output_truncated: "AI 返回内容被截断，尚未形成完整结果，原文已保存。",
    invalid_json_output: "AI 返回格式不完整，未作为整理结果归档，原文已保存。",
    invalid_schema_output: "AI 返回内容不符合记录结构，原文已保存。",
    connection_failed: "暂时连接不上 AI 服务，原文已保存。",
    upstream_unavailable: "AI 中转服务暂时不可用，原文已保存。",
    model_refusal: "AI 未能处理这段内容，原文仍完整保留。",
  };
  return reasons[code] || "原文已保存，AI 这次未能完成整理。";
}

function showError(error, prefix = "") {
  state.error = `${prefix}${errorText(error)}`;
  if (state.session) updateOverlays();
  else render();
}

function cleanItems(value) {
  return Array.isArray(value) ? value.map((item) => typeof item === "object" ? item.text || "" : String(item)).filter(Boolean) : [];
}

function typePills(analysis) {
  return (analysis?.record_type || []).slice(0, 3).map((item) => `<span class="pill">${esc(item)}</span>`).join("");
}

function renderSignals(analysis) {
  return `${typePills(analysis)} ${(analysis?.tags || []).slice(0, 4).map((tag) => `<span class="tag">#${esc(tag)}</span>`).join("")}`;
}

function renderInsightRows(analysis) {
  const groups = [
    ["progress", "进展", "progress"],
    ["decisions", "判断", "decision"],
    ["problems", "问题", "problem"],
    ["next_actions", "下一步", "action"],
  ];
  return groups.map(([field, label, kind]) => {
    const items = cleanItems(analysis?.[field]).slice(0, 3);
    if (!items.length) return "";
    return `<div class="insight-row insight-${kind}"><span class="insight-label">${label}</span><div>${items.map((item) => `<p>${esc(item)}</p>`).join("")}</div></div>`;
  }).join("");
}

function entrySpeechText(analysis, fallback = "") {
  const parts = [analysis?.summary || fallback];
  for (const [field, label] of [["progress", "进展"], ["decisions", "判断"], ["problems", "问题"], ["next_actions", "下一步"]]) {
    const items = cleanItems(analysis?.[field]).slice(0, 3);
    if (items.length) parts.push(`${label}。${items.join("。")}`);
  }
  if (analysis?.followup_question) parts.push(`需要确认。${analysis.followup_question}`);
  return parts.filter(Boolean).join("。 ");
}

function entryStatusLabel(entry) {
  if (entry?.ai_state === "retrying") return "等待自动重试";
  if (entry?.ai_state === "pending" || entry?.ai_state === "processing") return "正在理解";
  if (entry?.ai_state === "failed") return "需要重试";
  if (entry?.status === "needs_followup") return "待确认";
  if (entry?.status === "recorded") return "已保存";
  return "已整理";
}

function statusClass(entry) {
  if (entry?.ai_state === "retrying") return "is-retrying";
  if (entry?.ai_state === "failed") return "is-failed";
  if (entry?.ai_state === "pending" || entry?.ai_state === "processing") return "is-processing";
  if (entry?.status === "needs_followup") return "is-followup";
  return "is-ready";
}

function render({ main = true, animate = false } = {}) {
  const root = $("#app");
  if (!state.session) {
    root.innerHTML = renderOffline();
    bindApp();
    return;
  }
  const shell = root.querySelector(".app-shell");
  const pageChanged = root.dataset.page !== state.page;
  if (!shell) {
    root.innerHTML = `<div class="app-shell"><header class="topbar"><div class="topbar-inner"><button class="brand-mark brand-button" data-page="record" aria-label="回到记录"><span class="brand-dot"></span><span>${APP_NAME}</span></button><nav class="desktop-nav" aria-label="桌面导航">${navItem("record", "✎", "记录")}${navItem("timeline", "◷", "时间线")}${navItem("review", "▦", "复盘")}${navItem("ask", "⌕", "问自己")}</nav><div class="topbar-actions"><button class="business-day" data-action="settings" aria-label="调整业务日截止时间" title="调整业务日截止时间"><span class="day-dot"></span>业务日 ${esc(state.session.settings?.business_day_cutoff || "04:00")}</button>${appearanceToggleMarkup()}<button class="icon-button" data-action="settings" aria-label="设置" title="设置">⚙</button></div></div></header><main class="main-content" id="main-content"></main><nav class="bottom-nav" aria-label="主要导航">${navItem("record", "✎", "记录")}${navItem("timeline", "◷", "时间线")}${navItem("review", "▦", "复盘")}${navItem("ask", "⌕", "问自己")}</nav><div id="overlay-root"></div><div id="toast-root"></div></div>`;
    main = true;
    animate = true;
  }
  root.dataset.page = state.page;
  for (const button of root.querySelectorAll(".nav-item")) {
    const active = button.dataset.page === state.page;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
  bindApp();
  if (main || pageChanged) updateMainContent({ animate });
  updateOverlays();
}

function updateMainContent({ animate = false } = {}) {
  const main = $("#main-content");
  if (!main) return;
  const previousInput = $("#composer-input");
  patchHTML(main, renderPage());
  const nextInput = $("#composer-input");
  if (nextInput) {
    if (nextInput !== previousInput) {
      nextInput.value = state.composer;
      resizeComposer(nextInput);
    }
    setComposerBusy(state.sending);
  }
  const askInput = $("#search-input");
  if (askInput) resizeComposer(askInput);
  updateSpeechButtons();
  if (animate) animateSurface(main);
}

function updateOverlays() {
  const overlays = $("#overlay-root");
  const toast = $("#toast-root");
  if (!overlays || !toast) return;
  const html = state.dialog ? renderDialog() : state.settingsOpen ? renderSettings() : state.detailEntryId ? renderDetailDrawer() : "";
  clearTimeout(overlayTimer);
  if (html) {
    if (overlayScroll === null) {
      overlayScroll = window.scrollY;
      overlayFocus = document.activeElement;
      document.body.style.position = "fixed";
      document.body.style.top = `-${overlayScroll}px`;
      document.body.style.width = "100%";
    }
    const hadPanel = overlays.querySelector("[data-overlay-panel]");
    patchHTML(overlays, html);
    overlays.firstElementChild?.classList.remove("is-closing");
    if (state.settingsOpen) syncAppearanceControls();
    for (const element of document.querySelectorAll(".topbar, #main-content, .bottom-nav")) element.inert = true;
    const panel = overlays.querySelector("[data-overlay-panel]");
    panel?.setAttribute("role", "dialog");
    panel?.setAttribute("aria-modal", "true");
    panel?.setAttribute("aria-label", state.dialog ? state.dialog.title : state.settingsOpen ? "设置" : "完整过程");
    if (!hadPanel) panel?.querySelector("button")?.focus({ preventScroll: true });
  } else if (overlayScroll !== null) {
    overlays.firstElementChild?.classList.add("is-closing");
    overlayTimer = setTimeout(() => {
      overlays.replaceChildren();
      document.body.style.position = "";
      document.body.style.top = "";
      document.body.style.width = "";
      for (const element of document.querySelectorAll(".topbar, #main-content, .bottom-nav")) element.inert = false;
      window.scrollTo({ top: overlayScroll, behavior: "instant" });
      overlayScroll = null;
      overlayClosing = false;
      if (overlayFocus?.isConnected) overlayFocus.focus({ preventScroll: true });
    }, matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : MOTION.exit);
  }
  patchHTML(toast, state.error ? `<div class="toast error-toast" role="status">${esc(state.error)}<button data-action="clear-error" aria-label="关闭提示">×</button></div>` : state.notice ? `<div class="toast notice-toast" role="status"><span>${esc(state.notice.message)}</span>${state.notice.entryId ? `<button class="toast-action" data-action="restore-entry" data-id="${state.notice.entryId}">撤销</button>` : ""}<button data-action="clear-notice" aria-label="关闭提示">×</button></div>` : "");
}

function renderOffline() {
  const waiting = state.connectionRetrying;
  return `<main class="auth-page"><div class="auth-panel"><div class="brand-mark large"><span class="brand-dot"></span><span>${APP_NAME}</span></div><p class="auth-kicker">私人本地空间</p><h1>${waiting ? "正在重新连接" : "正在连接你的记录"}</h1><p class="auth-copy">${waiting ? "服务恢复后会自动回到你的记录，不需要反复刷新页面。" : "这个版本不需要登录。请确认服务正在运行，然后重新打开页面。"}</p><button class="primary-button reconnect-button" type="button" data-action="reconnect" ${waiting ? "disabled" : ""}>${waiting ? "自动重连中…" : "重新连接"}</button>${state.error ? `<p class="form-error">${esc(state.error)}</p>` : ""}</div></main>`;
}

function navItem(page, icon, label) {
  return `<button class="nav-item ${state.page === page ? "active" : ""}" data-page="${page}"><span class="nav-icon">${icon}</span><span>${label}</span></button>`;
}

function renderAuth() {
  const setup = state.setupRequired;
  return `<main class="auth-page"><div class="auth-panel"><div class="brand-mark large"><span class="brand-dot"></span><span>${APP_NAME}</span></div><p class="auth-kicker">${setup ? "只属于你的长期记录" : "欢迎回来"}</p><h1>${setup ? "先把你的私人空间建起来" : "继续记录今天"}</h1><p class="auth-copy">${setup ? "原文、追问、判断和后来的修正，都会留在你自己的数据库里。" : "这里不需要整理好再说。想到什么，直接留下。"}</p><form id="auth-form" class="auth-form">${setup ? `<label>用户名<input name="username" autocomplete="username" placeholder="例如：me" value="me" /></label>` : `<label>用户名<input name="username" autocomplete="username" required /></label>`}<label>密码<input name="password" type="password" minlength="8" autocomplete="${setup ? "new-password" : "current-password"}" required placeholder="${setup ? "至少 8 位" : ""}" /></label><button class="primary-button" type="submit">${setup ? "创建私人空间" : "登录"}</button><p class="form-hint">${setup ? "密码只在本地验证，不会发送到 AI 服务。" : "这是单用户私人系统。"}</p></form>${state.error ? `<p class="form-error">${esc(state.error)}</p>` : ""}</div></main>`;
}

function renderPage() {
  if (state.page === "timeline") return renderTimeline();
  if (state.page === "review") return renderReview();
  if (state.page === "ask") return renderAsk();
  return renderRecord();
}

function renderRecord() {
  const entries = [...state.entries].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  const pending = entries.filter((entry) => entry.status === "needs_followup").length;
  return `<section class="page-view record-page" data-key="record"><div class="page-intro record-intro"><div><p class="eyebrow">${formatLongDate(businessDate())}</p><h1>把今天留给自己。</h1></div><div class="quiet-status"><span class="status-dot"></span>${pending ? `${pending} 个待确认` : "AI 会在值得时追问"}</div></div><div class="feed" id="feed">${entries.length ? entries.map(renderEntryCard).join("") : renderEmptyRecord()}</div><form class="composer" id="composer-form"><div class="composer-editor"><textarea id="composer-input" name="text" rows="2" maxlength="20000" placeholder="想到什么就写什么，口语、重复、没想清楚都可以…">${esc(state.composer)}</textarea></div>${renderComposerAttachments()}<div class="composer-footer"><div class="composer-tools"><button class="attachment-button" type="button" data-action="pick-attachments" aria-label="添加资料" title="添加资料">＋</button><input id="attachment-input" type="file" multiple hidden /><span class="composer-hint">文字、图片或资料都可以，也可以拖进来</span></div><button class="send-button" type="submit" ${state.sending ? "disabled" : ""} aria-label="发送" title="发送">↑</button></div></form></section>`;
}

function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function attachmentKey(file) {
  return `${file.name}:${file.size}:${file.lastModified}:${file.type || ""}`;
}

function appendComposerFiles(files) {
  const incoming = [...(files || [])].filter((file) => (
    typeof File === "undefined" || file instanceof File
  ));
  if (!incoming.length) return;
  const current = state.composerAttachments || [];
  const known = new Set(current.map((item) => attachmentKey(item.file)));
  const additions = incoming.filter((file) => !known.has(attachmentKey(file)));
  const combined = [...current, ...additions.map((file) => ({ file }))];
  const totalSize = combined.reduce((sum, item) => sum + (item.file?.size || 0), 0);
  if (combined.length > 12) {
    state.error = "一次最多添加 12 个资料。";
    updateOverlays();
    return;
  }
  if (totalSize > 100 * 1024 * 1024) {
    state.error = "资料总大小超过 100 MB，请分批上传。";
    updateOverlays();
    return;
  }
  state.composerAttachments = [
    ...current,
    ...additions.map((file) => ({
      file,
      name: file.name || "未命名资料",
      type: file.type || "application/octet-stream",
      size: file.size,
      previewUrl: file.type?.startsWith("image/") ? URL.createObjectURL(file) : "",
    })),
  ];
  state.error = "";
  updateMainContent({ animate: false });
  updateOverlays();
}

function renderComposerAttachments() {
  const files = state.composerAttachments || [];
  if (!files.length) return "";
  return `<div class="composer-attachments" aria-label="待上传资料">${files.map((file, index) => `<div class="pending-attachment">${file.type?.startsWith("image/") && file.previewUrl ? `<img src="${esc(file.previewUrl)}" alt="" />` : `<span class="file-glyph">▧</span>`}<div><strong>${esc(file.name)}</strong><small>${formatBytes(file.size)}</small></div><button type="button" class="icon-button" data-action="remove-attachment" data-index="${index}" aria-label="移除 ${esc(file.name)}">×</button></div>`).join("")}</div>`;
}

function renderEntryAttachments(attachments = []) {
  if (!attachments.length) return "";
  return `<div class="entry-attachments" aria-label="关联资料">${attachments.map((attachment) => attachment.is_image ? `<a class="attachment-image" href="${esc(attachment.url)}" target="_blank" rel="noreferrer"><img src="${esc(attachment.url)}" alt="${esc(attachment.original_name)}" loading="lazy" /><span>${esc(attachment.original_name)}</span></a>` : `<a class="attachment-file" href="${esc(attachment.url)}?download=1"><span class="file-glyph">▧</span><span><strong>${esc(attachment.original_name)}</strong><small>${formatBytes(attachment.size_bytes)}</small></span><span class="download-mark">↓</span></a>`).join("")}</div>`;
}

function renderEmptyRecord() {
  return `<div class="empty-state record-empty"><div class="empty-icon">✦</div><h2>从一件小事开始</h2><p>不用分类，不用想清楚。先说给自己听，AI 会帮你留住真正有价值的东西。</p></div>`;
}

function latestAssistant(entry) { return [...(entry.messages || [])].reverse().find((message) => message.role === "assistant"); }

function renderRawEvidence(entry) {
  if (!state.rawOpen[entry.id] && !state.rawLoaded[entry.id]) return "";
  return `<div class="raw-drawer"><div class="raw-label">原始输入</div><p>${esc(entry.raw_text).replaceAll("\n", "<br>")}</p><button class="mini-link" data-action="edit-date" data-id="${entry.id}">归档日期：${esc(entry.record_date)} · 修改</button></div>`;
}

function renderEntryCard(entry) {
  const analysis = entry.analysis || {};
  const failed = entry.ai_state === "failed";
  const retrying = entry.ai_state === "retrying";
  const processing = !failed && !retrying && (entry.ai_state === "pending" || entry.ai_state === "processing" || (!entry.ai_state && !entry.analysis && entry.status === "recorded"));
  const hasSupplement = (entry.messages || []).some((message) => message.kind === "supplemental");
  const replyPending = !!state.replyingEntries[entry.id] || (entry.status === "needs_followup" && hasSupplement && ["pending", "processing", "retrying"].includes(entry.ai_state));
  const followup = entry.status === "needs_followup" && analysis.needs_followup && !replyPending && !(failed && hasSupplement);
  const assistant = latestAssistant(entry);
  const summary = analysis.summary || (failed ? aiFailureText(entry.ai_error) : retrying ? `${aiFailureText(entry.ai_error)} 稍后会自动重试，不用重复提交。` : processing ? "原文已保存，AI 正在阅读和整理…" : assistant?.kind !== "processing" && assistant?.content || "已保存这段记录。");
  const speak = !processing && !failed ? renderSpeakButton(`entry-${entry.id}`, entrySpeechText(analysis, summary)) : "";
  const replyStatus = replyPending ? `<div class="followup-received" role="status"><span class="status-dot"></span><div><strong>补充已收到</strong><small>${retrying ? "AI 服务暂时繁忙，系统会自动重试，不用重复提交。" : "正在结合原记录重新理解，可以继续记录其他事情。"}</small></div></div>` : "";
  return `<article class="entry-card ${statusClass(entry)} ${state.newEntryIds[entry.id] ? "is-new" : ""}" data-entry-id="${entry.id}"><div class="entry-topline"><span>${formatDate(entry.record_date)} · ${formatTime(entry.created_at)}</span><span class="entry-state">${entryStatusLabel(entry)}</span></div><div class="ai-lead"><div class="ai-avatar ${processing ? "is-pulsing" : ""}">✦</div><div class="ai-body"><div class="ai-kicker"><span>AI 整理 ${failed ? "· 稍后再试" : ""}</span>${speak}</div><p class="ai-summary ${processing ? "is-shimmer" : ""}">${esc(summary)}</p>${failed ? `<div class="ai-error-line"><span>${hasSupplement ? "补充和原文都已保存" : "原文没有丢"}</span><button class="inline-action" data-action="retry" data-id="${entry.id}">重新整理</button></div>` : ""}${!processing && !failed ? `<div class="insight-stack">${renderInsightRows(analysis)}</div><div class="entry-signals">${renderSignals(analysis)}</div>` : ""}</div></div>${renderEntryAttachments(entry.attachments)}${replyStatus}${followup ? `<div class="followup-panel"><div class="followup-question">${esc(analysis.followup_question || assistant?.content || "这件事还有一个重要地方想确认一下。")}</div><textarea class="followup-input" rows="2" placeholder="回答这一件最重要的事，或者直接跳过…">${esc(state.followupDrafts[entry.id] || "")}</textarea><div class="followup-actions"><button class="text-button" data-action="skip" data-id="${entry.id}">跳过</button><button class="small-primary" data-action="reply" data-id="${entry.id}">回复</button></div></div>` : ""}<div class="entry-bottomline"><button class="raw-toggle" data-action="toggle-raw" data-id="${entry.id}" aria-expanded="${!!state.rawOpen[entry.id]}"><span class="chevron ${state.rawOpen[entry.id] ? "open" : ""}">⌄</span>${state.rawOpen[entry.id] ? "收起原文" : "查看原文"}</button><div class="entry-manage-actions"><button class="mini-link" data-action="edit-date" data-id="${entry.id}">调整日期</button><button class="detail-link" data-action="open-detail" data-id="${entry.id}">完整过程 <span>↗</span></button></div></div><div class="raw-reveal ${state.rawOpen[entry.id] ? "is-open" : ""}" ${state.rawOpen[entry.id] ? "" : "inert"} aria-hidden="${!state.rawOpen[entry.id]}"><div class="raw-reveal-inner">${renderRawEvidence(entry)}</div></div></article>`;
}

function recordEntries() {
  return [...state.entries].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

function updateRecordStatus() {
  const status = document.querySelector(".record-intro .quiet-status");
  if (!status) return;
  const pending = recordEntries().filter((entry) => entry.status === "needs_followup").length;
  status.innerHTML = `<span class="status-dot"></span>${pending ? `${pending} 个待确认` : "AI 会在值得时追问"}`;
}

function settleNewCard(id) {
  window.setTimeout(() => {
    const card = [...document.querySelectorAll("#feed .entry-card")].find((item) => String(item.dataset.entryId) === String(id));
    card?.classList.remove("is-new");
    delete state.newEntryIds[id];
  }, 540);
}

function patchEntryCard(id, { isNew = false } = {}) {
  const entry = [...state.entries, ...state.timelineEntries, ...state.reviewEntries].find((item) => String(item.id) === String(id));
  const feed = $("#feed");
  if (!entry) return;
  if (isNew) state.newEntryIds[id] = true;
  const cards = [...document.querySelectorAll(".entry-card")].filter((item) => String(item.dataset.entryId) === String(id));
  for (const card of cards) {
    const template = document.createElement("template");
    template.innerHTML = renderEntryCard(entry);
    patchNode(card, template.content.firstElementChild);
  }
  if (!cards.length && feed) {
    feed.querySelector(".record-empty")?.remove();
    feed.insertAdjacentHTML("afterbegin", renderEntryCard(entry));
  }
  updateRecordStatus();
  if (isNew) settleNewCard(id);
}

function syncRecordFeed() {
  const feed = $("#feed");
  if (!feed) return;
  const entries = recordEntries();
  patchHTML(feed, entries.length ? entries.map(renderEntryCard).join("") : renderEmptyRecord());
  updateRecordStatus();
}

function renderDetailDrawer() {
  if (state.detailErrors[state.detailEntryId]) {
    return `<div class="drawer-backdrop" data-action="close-detail"><aside class="detail-drawer" data-overlay-panel><div class="drawer-handle"></div><div class="drawer-header"><h2>完整过程</h2><button class="icon-button" data-action="close-detail" aria-label="关闭">×</button></div><div class="view-error" role="status"><span>这条记录暂时没有加载出来，原文仍在数据库中。</span><button class="text-button" data-action="retry-detail">重试</button></div></aside></div>`;
  }
  const entry = state.entryDetails[state.detailEntryId] || state.entries.find((item) => String(item.id) === String(state.detailEntryId));
  if (!entry) {
    return `<div class="drawer-backdrop" data-action="close-detail"><aside class="detail-drawer" data-overlay-panel><div class="drawer-handle"></div><div class="drawer-header"><div><p class="eyebrow">完整过程</p><h2>正在找回</h2></div><button class="icon-button" data-action="close-detail" aria-label="关闭">×</button></div><div class="detail-loading"><span class="loading-orb">✦</span>正在找回这条记录的完整过程…</div></aside></div>`;
  }
  return `<div class="drawer-backdrop" data-action="close-detail"><aside class="detail-drawer" data-overlay-panel><div class="drawer-handle"></div><div class="drawer-header"><div><p class="eyebrow">完整过程</p><h2>${formatLongDate(entry.record_date)}</h2></div><div class="drawer-header-actions"><button class="text-button" data-action="edit-date" data-id="${entry.id}">调整日期</button><button class="text-button danger-text" data-action="delete-entry" data-id="${entry.id}">删除</button><button class="icon-button" data-action="close-detail" aria-label="关闭">×</button></div></div>${state.detailLoading[entry.id] ? `<div class="detail-loading"><span class="loading-orb">✦</span>正在找回这条记录的完整过程…</div>` : renderEntryHistory(entry)}</aside></div>`;
}

function renderEntryHistory(entry) {
  const messages = entry.messages || [];
  const versions = (entry.analysis_versions || []).filter((v) => !state.sourceVersion || v._version === Number(state.sourceVersion));
  const corrections = entry.corrections || [];
  return `${renderEvidenceTools(entry)}<div class="history-panel drawer-history"><section class="history-section"><div class="history-label">原始输入</div><p class="history-raw">${esc(entry.raw_text || "这条记录没有文字，原始内容在下方资料中。").replaceAll("\n", "<br>")}</p>${renderEntryAttachments(entry.attachments)}</section>${messages.length ? `<section class="history-section"><div class="history-label">对话过程</div><div class="history-messages">${messages.map((message) => `<div class="history-message"><span>${message.role === "user" ? "你" : message.role === "system" ? "系统" : APP_NAME}</span><p>${esc(message.content).replaceAll("\n", "<br>")}</p></div>`).join("")}</div></section>` : ""}${versions.length ? `<section class="history-section"><div class="history-label">AI 理解版本</div><div class="analysis-history">${versions.map((version) => `<div class="analysis-version"><div><strong>第 ${version._version} 版</strong><span>${version._is_final ? "最终归档" : "待确认"} · ${formatTime(version._created_at)}</span></div><p>${esc(version.summary || "暂无摘要")}</p>${cleanItems(version.progress).length ? `<small>进展：${esc(cleanItems(version.progress).join("；"))}</small>` : ""}${version.followup_question && !version._is_final ? `<small>追问：${esc(version.followup_question)}</small>` : ""}</div>`).join("")}</div></section>` : ""}${corrections.length ? `<section class="history-section"><div class="history-label">后续修正</div><div class="correction-list">${corrections.map((item) => `<div><span>${formatTime(item.created_at)}</span><p>${esc(item.previous_value)} → ${esc(item.new_value)}<small>${esc(item.reason === "user_edit" ? "手动修改日期" : item.reason === "natural_language" ? "自然语言修正" : "AI 识别日期")}</small></p></div>`).join("")}</div></section>` : ""}</div>`;
}

function renderDialog() {
  const dialog = state.dialog || {};
  const isDate = dialog.type === "date";
  const isDelete = dialog.type === "delete";
  const isFeedback = dialog.type === "feedback" || dialog.type === "report-feedback";
  const label = isDate ? "归档日期" : isDelete ? "" : isFeedback ? "补充说明" : "复盘补充";
  const placeholder = isDate ? "" : isFeedback ? "只写最关键的修正即可。原文和之前的 AI 版本都会保留。" : "补充这一点，或者说明为什么暂时无法回答。";
  return `<div class="modal-backdrop dialog-backdrop" data-action="close-dialog"><section class="input-dialog" data-overlay-panel><div class="sheet-handle" aria-hidden="true"></div><div class="modal-header"><div><p class="eyebrow">${esc(dialog.kicker || APP_NAME)}</p><h2>${esc(dialog.title || "补充信息")}</h2></div><button class="icon-button" data-action="close-dialog" aria-label="关闭">×</button></div><form id="dialog-form" class="dialog-form">${isDelete ? `<p class="dialog-copy">这条记录会从记录、时间线、复盘和搜索中移除。删除后可以立即撤销，完整导出仍保留审计信息。</p>` : `<label>${label}${isDate ? `<input name="value" type="date" value="${esc(dialog.value || "")}" required />` : `<textarea name="text" rows="5" placeholder="${esc(placeholder)}">${esc(dialog.value || "")}</textarea>`}</label>`}<div class="dialog-actions"><button type="button" class="outline-button" data-action="close-dialog">取消</button><button type="submit" class="primary-button ${isDelete ? "danger-button" : ""}">${esc(dialog.submitLabel || "保存")}</button></div></form></section></div>`;
}

function openDialog(dialog) {
  showOverlay({ dialog: { ...dialog, value: dialog.value || "" } });
  window.setTimeout(() => {
    const field = document.querySelector("#dialog-form input, #dialog-form textarea");
    field?.focus({ preventScroll: true });
    if (field?.select && dialog.type !== "date") field.select();
  }, 0);
}

function closeDialog() {
  closeOverlay();
}

async function submitDialog(event) {
  event.preventDefault();
  const dialog = state.dialog;
  if (!dialog) return;
  const formElement = event.target.closest?.("#dialog-form");
  if (!(formElement instanceof HTMLFormElement)) {
    showError(new Error("没有找到需要提交的表单，请重新打开后再试。"));
    return;
  }
  const submitButton = formElement.querySelector('button[type="submit"]');
  if (submitButton?.disabled) return;
  const submitLabel = submitButton?.textContent || "保存";
  if (submitButton) {
    submitButton.disabled = true;
    submitButton.setAttribute("aria-busy", "true");
    submitButton.textContent = dialog.type === "delete" ? "删除中…" : "保存中…";
  }
  const form = new FormData(formElement);
  const value = String(form.get("value") || form.get("text") || "").trim();
  if (dialog.type === "date" && !value) {
    submitButton?.removeAttribute("aria-busy");
    if (submitButton) {
      submitButton.disabled = false;
      submitButton.textContent = submitLabel;
    }
    return;
  }
  try {
    if (dialog.type === "delete") {
      await api(`/api/entries/${dialog.id}`, { method: "DELETE" });
      closeDialog();
      state.notice = { message: "记录已移除。", entryId: dialog.id };
      delete state.entryDetails[dialog.id];
      await loadEntries({ renderPage: false });
      await refreshLocation();
      updateOverlays();
      return;
    }
    if (dialog.type === "date") {
      await api(`/api/entries/${dialog.id}`, { method: "PATCH", body: JSON.stringify({ record_date: value }) });
      delete state.entryDetails[dialog.id];
      closeDialog();
      await loadEntries();
      if (state.page === "timeline") await loadTimeline();
      if (state.page === "review") await loadReviewData();
      return;
    }
    if (dialog.type === "feedback") {
      await api("/api/feedback", { method: "POST", body: JSON.stringify({ entry_id: dialog.id, rating: dialog.rating, text: value }) });
      delete state.entryDetails[dialog.id];
      closeDialog();
      await openDetail(dialog.id, { historyEntry: false });
      if (value) watchEntry(dialog.id);
      return;
    }
    if (dialog.type === "report-feedback") {
      await api("/api/report-feedback", { method: "POST", body: JSON.stringify({ report_id: dialog.reportId, rating: dialog.rating, text: value }) });
      closeDialog();
      return;
    }
    await api("/api/review-answer", { method: "POST", body: JSON.stringify({ id: dialog.id, text: value }) });
    closeDialog();
    await refreshLocation();
  } catch (error) {
    showError(error);
  } finally {
    if (document.contains(submitButton)) {
      submitButton.disabled = false;
      submitButton.removeAttribute("aria-busy");
      submitButton.textContent = submitLabel;
    }
  }
}

function renderTimeline() {
  const dateValue = state.timelineDate || businessDate();
  return `<section class="page-view timeline-page" data-key="timeline"><div class="page-heading"><div><p class="eyebrow">你的记忆流</p><h1>${formatLongDate(dateValue)}</h1></div><button class="date-input date-input-button" data-action="timeline-today">回到今天</button></div><div class="date-strip"><button class="square-button" data-action="shift-date" data-days="-1" aria-label="前一天">‹</button><div><strong>${formatDate(dateValue)}</strong><span>${state.timelineLoading ? "正在读取" : `${state.timelineEntries.length} 条记录`}</span></div><button class="square-button" data-action="shift-date" data-days="1" aria-label="后一天">›</button></div>${renderLoadError(state.timelineError)}${state.timelineLoading ? renderDaySkeleton() : state.timelineError && !state.timelineEntries.length ? "" : renderDayContent(dateValue, state.timelineEntries, state.timelineReport, "timeline")}</section>`;
}

function renderDayContent(dateValue, entries, report, source = "day") {
  if (!entries.length) return `<div class="empty-state"><h2>这一天还没有记录</h2></div>`;
  const attention = entries.filter(entry => entry.status === "needs_followup" || entry.ai_state === "failed");
  const evidence = entries.map(entry => `<section class="day-original" data-key="original-${entry.id}"><div class="entry-topline"><time>${formatTime(entry.created_at)}</time><button class="detail-link" data-action="open-detail" data-id="${entry.id}">完整过程 ↗</button></div><p>${esc(entry.raw_text || "资料记录").replaceAll("\n", "<br>")}</p>${renderEntryAttachments(entry.attachments)}</section>`).join("");
  const daily = report ? renderReport(report, "当日日志") : `<div class="report-state" role="status">当天内容已保存，合并整理尚未完成。<button class="text-button" data-action="refresh-report">整理这一天</button></div>`;
  return `<div class="day-content" data-key="day-${dateValue}">${daily}${attention.length ? `<div class="day-attention">${attention.map(renderEntryCard).join("")}</div>` : ""}<details class="day-evidence" data-key="evidence-${dateValue}"><summary>原始记录与补充 · ${entries.length} 次</summary>${evidence}</details></div>`;
}

function formatMonthTitle(value) {
  if (!value) return "复盘";
  const current = dateObject(value);
  return `${current.getFullYear()}年${current.getMonth() + 1}月`;
}

function renderReview() {
  const title = state.reviewView === "month" ? formatMonthTitle(state.calendarCursor) : state.reviewView === "week" ? `${formatDate(startOfWeek(state.calendarSelectedDate))} – ${formatDate(endOfWeek(state.calendarSelectedDate))}` : formatLongDate(state.calendarSelectedDate);
  return `<section class="page-view review-page" data-key="review"><div class="review-hero"><h1>复盘</h1><div class="view-switcher" role="tablist" aria-label="日历视图" style="--selected-tab:${["month", "week", "day"].indexOf(state.reviewView)}">${["month", "week", "day"].map((view) => `<button class="${state.reviewView === view ? "active" : ""}" data-action="calendar-view" data-view="${view}" role="tab" aria-selected="${state.reviewView === view}">${view === "month" ? "月" : view === "week" ? "周" : "日"}</button>`).join("")}</div></div><div class="calendar-context">${state.reviewView === "day" ? `<button class="text-button calendar-back" data-action="calendar-back">‹ 返回${state.reviewReturnView === "week" ? "周" : "月"}视图</button>` : `<span>${formatMonthTitle(state.calendarSelectedDate)}</span>`}<button class="text-button" data-action="calendar-today">回到今天</button></div><div class="calendar-toolbar"><button class="icon-button" data-action="calendar-shift" data-step="-1" aria-label="上一个周期">‹</button><h2 class="calendar-title">${esc(title)}</h2><button class="icon-button" data-action="calendar-shift" data-step="1" aria-label="下一个周期">›</button></div>${renderLoadError(state.reviewError)}<div class="calendar-viewport" aria-busy="${state.calendarLoading}">${state.reviewView === "month" ? renderMonthView() : state.reviewView === "week" ? renderWeekView() : renderDayReview()}</div>${renderMemoryPanel()}</section>`;
}

function renderLoadError(message) {
  return message ? `<div class="view-error" role="status"><span>${esc(message)}</span><button class="text-button" data-action="retry-view">重试</button></div>` : "";
}

function renderDaySkeleton() {
  return `<div class="day-loading" role="status" aria-label="正在读取记录"><span>正在读取记录…</span><div></div><div></div></div>`;
}

function renderCalendarSkeleton() {
  return `<div class="calendar-skeleton">${Array.from({ length: 14 }, () => `<span></span>`).join("")}</div>`;
}

function calendarDayMap() { return Object.fromEntries((state.calendarDays || []).map((day) => [day.date, day])); }

function dayCell(day, isOutside = false) {
  const item = calendarDayMap()[day] || { entry_count: 0, has_records: false, intensity: 0, focus: "", signals: [], report_status: "empty" };
  const selected = day === state.calendarSelectedDate;
  const current = day === businessDate();
  return `<button class="calendar-day ${isOutside ? "is-outside" : ""} ${selected ? "is-selected" : ""} ${current ? "is-today" : ""} intensity-${item.intensity}" data-action="select-calendar-date" data-date="${day}" title="${esc(item.focus || formatDate(day))}"><span class="calendar-day-number">${Number(day.slice(-2))}</span>${item.has_records ? `<span class="calendar-day-count">${item.entry_count}</span><span class="calendar-day-focus">${esc(item.focus || "有记录")}</span><span class="calendar-signals">${item.signals.slice(0, 3).map((signal) => `<i class="signal-${signal}"></i>`).join("")}</span>` : ""}</button>`;
}

function renderMonthView() {
  const range = monthGridRange(state.calendarCursor || businessDate());
  const dates = [];
  let cursor = range.start;
  while (cursor <= range.end) { dates.push(cursor); cursor = shiftDateValue(cursor, 1); }
  const month = dateObject(state.calendarCursor || businessDate()).getMonth();
  return `<div class="calendar-panel month-panel"><div class="weekday-row">${["一", "二", "三", "四", "五", "六", "日"].map((label) => `<span>${label}</span>`).join("")}</div><div class="month-grid" data-gesture-surface>${dates.map((day) => dayCell(day, dateObject(day).getMonth() !== month)).join("")}</div><div class="calendar-legend"><span><i class="legend-dot progress"></i>进展</span><span><i class="legend-dot decision"></i>判断</span><span><i class="legend-dot problem"></i>问题</span><span class="calendar-load-status" role="status">${state.calendarLoading ? "正在读取…" : ""}</span></div>${renderReviewReport(state.reviewReport, "月度复盘")}</div>`;
}

function renderWeekView() {
  const start = startOfWeek(state.calendarSelectedDate || businessDate());
  const dates = Array.from({ length: 7 }, (_, index) => shiftDateValue(start, index));
  const map = calendarDayMap();
  return `<div class="calendar-panel week-panel"><div class="week-grid">${dates.map((day) => { const item = map[day] || { entry_count: 0, intensity: 0, focus: "", signals: [] }; const selected = day === state.calendarSelectedDate; return `<button class="week-day-card ${selected ? "is-selected" : ""} intensity-${item.intensity}" data-action="select-calendar-date" data-date="${day}"><span class="week-day-name">${dateObject(day).toLocaleDateString("zh-CN", { weekday: "short" })}</span><strong>${Number(day.slice(-2))}</strong><span class="week-day-count">${item.entry_count ? `${item.entry_count} 条` : "空白"}</span><span class="week-day-focus">${esc(item.focus || "还没有形成重点")}</span><span class="calendar-signals">${(item.signals || []).slice(0, 3).map((signal) => `<i class="signal-${signal}"></i>`).join("")}</span></button>`; }).join("")}</div>${renderReviewReport(state.reviewReport, "本周复盘")}</div>`;
}

function renderDayReview() {
  if (state.calendarLoading) return renderDaySkeleton();
  if (state.reviewError && !state.reviewEntries.length) return "";
  const dateValue = state.calendarSelectedDate || businessDate();
  return `<div class="calendar-panel day-panel"><div class="day-review-heading"><div><p class="eyebrow">${formatLongDate(dateValue)}</p><h2>${state.reviewEntries.length ? `${state.reviewEntries.length} 条记录` : "还没有记录"}</h2></div><button class="outline-button" data-action="open-record-date">在时间线查看</button></div>${renderDayContent(dateValue, state.reviewEntries, state.reviewReport, "day")}</div>`;
}

function renderReviewReport(report, label) {
  if (state.calendarLoading && !report) return `<div class="report-empty" role="status">正在读取${label}…</div>`;
  if (state.reviewError && !report) return "";
  if (!report) return `<div class="report-empty"><span class="report-empty-orb">✧</span><span>${label}还在等待记录积累</span></div>`;
  return renderReport(report, label);
}

function sourceButtons(refs = []) {
  const sources = refs
    .map((ref) => typeof ref === "number" ? { entry_id: ref } : ref)
    .map((ref) => ({ id: Number(ref?.entry_id), version: Number(ref?.analysis_version) || 0 }))
    .filter((ref) => Number.isFinite(ref.id) && ref.id > 0);
  if (!sources.length) return "";
  return `<span class="claim-sources" aria-label="查看证据">${sources.map(({ id, version }) => {
    const label = version ? `查看原始记录 ${id}，AI 第 ${version} 版` : `查看原始记录 ${id}`;
    return `<button class="source-chip" data-action="source-entry" data-id="${id}" data-version="${version || ""}" aria-label="${esc(label)}" title="${esc(label)}">#${id}</button>`;
  }).join("")}</span>`;
}

function focusSourceButtons(entryIds = []) {
  const ids = [...new Set((entryIds || [])
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0))];
  if (!ids.length) return "";
  const visible = sourceButtons(ids.slice(0, 4).map((entry_id) => ({ entry_id })));
  const remaining = ids.length - Math.min(ids.length, 4);
  return `<span class="focus-sources">${visible}${remaining ? `<span class="source-more">+${remaining}</span>` : ""}</span>`;
}

function renderReportBody(content) {
  const themes = (content.themes || []).map(theme => `<article class="report-theme"><strong>${esc(theme.label)}</strong><p>${esc(theme.description)}</p>${sourceButtons(theme.sources || (theme.source_entry_ids || []).map(entry_id => ({ entry_id })))}</article>`).join("");
  const candidateItems = (content.action_candidates || []).map(candidate => `<article class="report-candidate"><div><strong>${esc(candidate.text)}</strong><p>${esc(candidate.reason)}</p></div>${sourceButtons(candidate.sources || (candidate.source_entry_ids || []).map(entry_id => ({ entry_id })))}</article>`).join("");
  const candidates = candidateItems ? `<details class="report-section report-candidates report-actions-fold"><summary>待确认行动 · ${content.action_candidates.length}</summary><div class="report-candidate-list">${candidateItems}</div></details>` : "";
  return `${themes ? `<section class="report-section report-themes"><h3>反复主题</h3>${themes}</section>` : ""}${(content.sections || []).map(section => `<section class="report-section"><h3>${esc(section.label)}</h3><ul>${(section.items || []).map(renderReportItem).join("")}</ul></section>`).join("")}${candidates}${content.observation ? `<section class="report-observation"><span>AI观察</span><p>${esc(content.observation)}</p>${sourceButtons(content.observation_sources || (content.observation_source_entry_ids || []).map(entry_id => ({ entry_id })))}</section>` : ""}`;
}

function reportSpeechText(content = {}) {
  const parts = [content.title];
  for (const theme of content.themes || []) parts.push(`${theme.label}。${theme.description}`);
  for (const section of content.sections || []) {
    const items = (section.items || []).map((item) => typeof item === "string" ? item : item?.text).filter(Boolean);
    if (items.length) parts.push(`${section.label}。${items.join("。")}`);
  }
  if (content.observation) parts.push(`AI观察。${content.observation}`);
  return parts.filter(Boolean).join("。 ");
}

function renderReport(report, label = "复盘") {
  const content = report.content || {};
  const status = report.status || "ready";
  const hasContent = content.sections?.length || content.themes?.length || content.action_candidates?.length || content.observation;
  const statusText = status === "failed" ? "更新暂未完成，已保留上一版" : status === "stale" ? "有新记录，等待更新" : "正在整理";
  const question = report.review_question;
  const feedbackActions = report.id
    ? `<div class="report-feedback-actions"><button class="text-button" data-action="report-feedback" data-id="${report.id}" data-rating="incorrect">修正内容</button></div>`
    : "";
  const speechAction = status === "ready" ? renderSpeakButton(`report-${report.id || label}-${content.period_label || ""}`, reportSpeechText(content)) : "";
  const headerActions = speechAction || feedbackActions ? `<div class="report-header-actions">${speechAction}${feedbackActions}</div>` : "";
  const sourceCount = report.source_entry_ids?.length || content.source_entry_ids?.length || 0;
  const corrections = (report.feedback || []).filter(item => item.rating === "incorrect");
  const feedback = corrections.length ? `<details class="report-feedback-history"><summary>修正记录 · ${corrections.length}</summary>${corrections.slice(0, 5).map(item => `<p>${item.text ? esc(item.text) : "已标记需要修正"}</p>`).join("")}</details>` : "";
  return `<article class="report"><div class="report-header"><div><p class="eyebrow">${esc(content.period_label || label)}</p><h2>${esc(content.title || label)}</h2></div>${headerActions}</div>${status !== "ready" ? `<div class="report-state" role="status">${hasContent ? statusText : status === "failed" ? "这次复盘暂未完成，原文已保存" : statusText}${["failed", "stale"].includes(status) ? '<button class="text-button" data-action="refresh-report">重试</button>' : ""}</div>` : ""}${renderReportBody(content)}${question?.status === "pending" ? `<section class="review-question"><p>${esc(question.question)}</p><div class="memory-actions"><button class="text-button" data-action="review-answer" data-id="${question.id}">补充</button><button class="text-button" data-action="review-skip" data-id="${question.id}">跳过</button></div></section>` : ""}${report.versions?.length ? `<details class="report-history"><summary>历史版本 · ${report.versions.length}</summary>${report.versions.map(v => `<details><summary>${esc(v.created_at)} · ${esc(v.prompt_version)}</summary>${renderReportBody(v.content || {})}</details>`).join("")}</details>` : ""}${feedback}<div class="source-note">基于 ${sourceCount} 条原始记录</div></article>`;
}

function renderReportItem(item) {
  if (typeof item === "string") return `<li><span>${esc(item)}</span><small>历史内容，未附逐条来源</small></li>`;
  return `<li><span>${esc(item?.text || "")}</span>${sourceButtons(item?.sources || (item?.source_entry_ids || []).map(entry_id => ({ entry_id })))}</li>`;
}

function renderMemoryPanel() {
  const labels = { proposed: "待确认", accepted: "已接受", deferred: "暂缓", dismissed: "已忽略", done: "已完成" };
  const rollups = state.memory?.rollups || [];
  const details = state.memoryDetail?.proposals || [];
  const renderProposal = p => `<article class="memory-item" data-key="proposal-${p.id}"><div class="memory-meta">${p.kind === "background" ? "长期背景" : "行动建议"} · ${labels[p.status] || esc(p.status)}</div><p>${esc(p.text)}</p><small>${esc(p.reason)}</small>${sourceButtons(p.sources)}<div class="memory-actions">${p.status !== "accepted" ? `<button class="text-button" data-action="proposal" data-id="${p.id}" data-status="accepted">${["done", "dismissed"].includes(p.status) ? "重新接受" : "接受"}</button>` : p.kind === "action" ? `<button class="text-button" data-action="proposal" data-id="${p.id}" data-status="done">标记完成</button>` : ""}${["proposed", "accepted"].includes(p.status) ? `<button class="text-button" data-action="proposal" data-id="${p.id}" data-status="deferred">暂缓</button>` : ""}${!["dismissed", "done"].includes(p.status) ? `<button class="text-button" data-action="proposal" data-id="${p.id}" data-status="dismissed">忽略</button>` : ""}</div>${p.events?.length ? `<details><summary>状态历史</summary>${p.events.map(e => `<p><small>${esc(e.created_at)} · ${labels[e.status]}</small></p>`).join("")}</details>` : ""}</article>`;
  const renderFocus = rollup => {
    const open = state.memoryExpandedRollup === rollup.rollup_key;
    const related = open
      ? details.filter(proposal => proposal.rollup_key === rollup.rollup_key && !["dismissed", "done"].includes(proposal.status))
      : [];
    const sourceIds = rollup.source_entry_ids || [];
    const sourceCount = rollup.source_entry_count || sourceIds.length;
    return `<article class="focus-card ${open ? "is-open" : ""}" data-key="focus-${esc(rollup.rollup_key)}"><div class="focus-card-header"><div><div class="memory-meta">当前重点</div><h3>${esc(rollup.title)}</h3></div><span class="focus-count">${rollup.proposal_count} 条建议 · ${sourceCount} 条来源</span></div><p class="focus-summary">${esc(rollup.summary)}</p><div class="focus-action"><span>最小行动</span><p>${esc(rollup.next_action)}</p></div><p class="focus-reason">${esc(rollup.reason)}</p><div class="focus-footer">${focusSourceButtons(sourceIds)}<button class="focus-detail-toggle" data-action="toggle-memory-detail" data-key="${esc(rollup.rollup_key)}" aria-expanded="${open}">${open ? "收起相关建议" : `查看相关建议 · ${rollup.proposal_count}`}</button></div>${open ? `<div class="focus-proposals">${state.memoryDetailLoading ? `<p class="memory-meta">正在打开相关建议…</p>` : state.memoryDetailError ? `<p class="memory-error">${esc(state.memoryDetailError)}</p>` : related.length ? related.map(renderProposal).join("") : `<p class="memory-meta">这个方向暂时没有可展开的建议。</p>`}</div>` : ""}</article>`;
  };
  const historyOpen = state.memoryExpandedRollup === "__history__";
  const historical = historyOpen
    ? details.filter(p => ["dismissed", "done"].includes(p.status))
    : [];
  const digest = state.memory?.digest;
  const digestState = digest?.status === "failed"
    ? `<span class="memory-digest-status is-failed">重点整理暂未完成 <button class="text-button" data-action="refresh-memory">重试</button></span>`
    : ["queued", "running"].includes(digest?.status)
      ? `<span class="memory-digest-status">正在精炼重点，当前合并结果仍可使用</span>`
      : "";
  const completedCount = state.memory?.completed_proposal_count || 0;
  const historySection = completedCount
    ? `<details class="memory-history" ${historyOpen ? "open" : ""}><summary data-action="toggle-memory-history">已完成与已忽略 · ${completedCount}</summary>${state.memoryDetailLoading && historyOpen ? `<p class="memory-meta">正在读取历史建议…</p>` : state.memoryDetail ? (historical.length ? historical.map(renderProposal).join("") : `<p class="memory-meta">暂时没有可显示的历史建议。</p>`) : `<p class="memory-meta">展开后读取已完成和已忽略的建议。</p>`}</details>`
    : "";
  return `<section class="memory-panel"><div class="memory-panel-header"><div><h2>当前重点</h2><p class="memory-meta">${state.memory?.active_proposal_count || 0} 条进行中的建议，已合并成少数方向</p></div>${digestState}</div>${rollups.length ? `<div class="focus-list">${rollups.map(renderFocus).join("")}</div>` : '<p class="memory-meta">暂时没有需要长期关注的方向。</p>'}${state.memoryDetailLoading && !state.memoryExpandedRollup ? `<div class="memory-detail-loading" role="status">正在读取相关建议…</div>` : ""}${state.memoryDetailError ? `<p class="memory-error">${esc(state.memoryDetailError)}</p>` : ""}${historySection}${state.memory?.background?.text ? `<details class="memory-background"><summary>已确认的长期背景</summary><p class="history-raw">${esc(state.memory.background.text)}</p></details>` : ""}</section>`;
}

function renderEvidenceTools(entry) {
  const labels = { supports: "支持", contradicts: "与先前判断矛盾", updates: "后续更新", outcome: "后来的结果" };
  return `<section class="evidence-tools">${state.sourceVersion ? `<p class="memory-meta">引用当时的 AI 第 ${Number(state.sourceVersion)} 版</p>` : ""}<div class="memory-actions"><button class="text-button" data-action="feedback" data-id="${entry.id}" data-rating="incorrect">修正 AI 理解</button></div>${(entry.relations || []).map(link => `<div class="relation-item"><strong>${link.verification === "legacy_candidate" ? "历史候选关联" : esc(labels[link.relation_type] || "关联")}</strong>${link.evidence?.quote ? `<p>${esc(link.evidence.previous_quote)} → ${esc(link.evidence.quote)}</p>` : ""}${sourceButtons(link.evidence?.sources || [{ entry_id: link.from_entry_id === entry.id ? link.to_entry_id : link.from_entry_id }])}<small>AI关联，仍可回看原文核实</small></div>`).join("")}</section>`;
}

async function loadMemory() {
  state.memory = await api("/api/memory");
  if (state.page === "review" && ["queued", "running"].includes(state.memory?.digest?.status)) watchMemoryDigest();
}

async function loadMemoryDetail() {
  if (state.memoryDetail || state.memoryDetailLoading) return;
  state.memoryDetailLoading = true;
  state.memoryDetailError = "";
  render({ animate: false });
  try {
    const result = await api("/api/memory?detail=1");
    if (state.page !== "review") return;
    state.memoryDetail = result;
    if (result.rollup_fingerprint !== state.memory?.rollup_fingerprint) {
      state.memory = result;
    }
  } catch (error) {
    if (state.page === "review") state.memoryDetailError = `相关建议暂时没读出来：${errorText(error)}`;
  } finally {
    state.memoryDetailLoading = false;
    if (state.page === "review") render({ animate: false });
  }
}

async function watchMemoryDigest() {
  if (memoryDigestPolling || state.page !== "review") return;
  memoryDigestPolling = true;
  try {
    for (let attempt = 0; attempt < 36 && state.page === "review"; attempt += 1) {
      await sleep(attempt < 5 ? 2000 : 5000);
      if (state.page !== "review" || document.hidden) continue;
      const result = await api("/api/memory");
      if (state.page !== "review") return;
      const previous = state.memory;
      state.memory = result;
      if (
        previous?.rollup_fingerprint !== result?.rollup_fingerprint
        || JSON.stringify(previous?.digest) !== JSON.stringify(result?.digest)
      ) {
        state.memoryDetail = null;
        state.memoryExpandedRollup = "";
        render({ animate: false });
      }
      if (!["queued", "running"].includes(result?.digest?.status)) return;
    }
  } catch (error) {
    if (state.page === "review") state.memoryDetailError = `重点整理状态暂时没更新：${errorText(error)}`;
  } finally {
    memoryDigestPolling = false;
  }
}

function askAnswerText(content = {}) {
  if (content.answer) return String(content.answer);
  const parts = [];
  for (const section of content.sections || []) {
    for (const item of section.items || []) parts.push(typeof item === "string" ? item : item?.text || "");
  }
  if (content.observation) parts.push(content.observation);
  return parts.filter(Boolean).join("\n");
}

function askSpeechText(content = {}) {
  const parts = [askAnswerText(content)];
  if (content.evidence?.length) parts.push(`依据。${content.evidence.map((item) => item.point).join("。")}`);
  if (content.uncertainty) parts.push(`还不能确定。${content.uncertainty}`);
  if (content.suggested_next_step) parts.push(`建议。${content.suggested_next_step}`);
  return parts.filter(Boolean).join("。 ");
}

function renderAskAnswer(item) {
  const content = item.content || {};
  const status = item.status || "ready";
  const pending = status === "queued" || status === "processing";
  const failed = status === "failed";
  const main = askAnswerText(content);
  const evidence = (content.evidence || []).map((evidenceItem) => `<li><span>${esc(evidenceItem.point)}</span>${sourceButtons((evidenceItem.source_entry_ids || []).map((entry_id) => ({ entry_id })))}</li>`).join("");
  const allSources = item.source_entry_ids || content.source_entry_ids || [];
  const body = pending
    ? `<div class="ask-thinking" role="status"><span></span><span></span><span></span><p>正在翻阅你的记录并组织回答…</p></div>`
    : failed
      ? `<div class="ask-failed"><p>${esc(aiFailureText(item.error))}</p><button class="text-button" data-action="retry-answer" data-id="${item.id}">重新回答</button></div>`
      : `<div class="ask-answer-main">${esc(main || "这次没有形成有效回答。").replaceAll("\n", "<br>")}</div>${evidence ? `<details class="ask-evidence"><summary>回答依据 · ${content.evidence.length}</summary><ul>${evidence}</ul></details>` : ""}${content.uncertainty ? `<div class="ask-caveat"><span>还不能确定</span><p>${esc(content.uncertainty)}</p>${sourceButtons((content.uncertainty_source_entry_ids || []).map((entry_id) => ({ entry_id })))}</div>` : ""}${content.suggested_next_step ? `<div class="ask-next"><span>接下来可以做</span><p>${esc(content.suggested_next_step)}</p>${sourceButtons((content.suggested_next_step_source_entry_ids || []).map((entry_id) => ({ entry_id })))}</div>` : ""}`;
  const speak = !pending && !failed ? renderSpeakButton(`answer-${item.id}`, askSpeechText(content)) : "";
  return `<div class="ask-turn" data-key="answer-${item.id}"><div class="ask-user-row"><div class="ask-user-bubble">${esc(item.question)}</div></div><article class="ask-assistant ${pending ? "is-thinking" : ""}"><div class="ask-assistant-head"><span class="ai-avatar">✦</span><strong>${APP_NAME}</strong>${speak}</div>${body}${!pending && !failed && allSources.length ? `<div class="ask-source-line"><span>参考了 ${allSources.length} 条记录</span>${focusSourceButtons(allSources)}</div>` : ""}</article></div>`;
}

function renderAsk() {
  const visibleAnswers = state.answers.filter((item, index, answers) => {
    const next = answers[index + 1];
    if (!next || next.question !== item.question) return true;
    return Math.abs(new Date(next.created_at) - new Date(item.created_at)) > 5 * 60 * 1000;
  });
  const turns = visibleAnswers.map(renderAskAnswer).join("");
  const empty = !visibleAnswers.length ? `<div class="ask-welcome"><div class="ai-avatar">✦</div><h2>从自己的记录里找答案</h2><p>我会结合原文、后来补充和判断变化回答，并把依据带回来。</p><div class="ask-suggestions"><button data-action="ask-suggestion" data-question="结合最近的记录，我现在最值得优先解决什么？">我现在最该先做什么？</button><button data-action="ask-suggestion" data-question="最近哪些问题反复出现，可能一直在消耗我的时间？">什么在反复消耗我？</button></div></div>` : "";
  return `<section class="page-view ask-page" data-key="ask"><div class="page-heading ask-heading"><div><p class="eyebrow">基于你的历史记录</p><h1>问自己</h1></div><span>${visibleAnswers.length ? `${visibleAnswers.length} 轮对话` : ""}</span></div><div class="ask-thread" id="ask-thread">${empty}${turns}</div><form id="search-form" class="ask-composer"><textarea id="search-input" rows="1" maxlength="4000" placeholder="问问过去的自己…">${esc(state.searchQuery)}</textarea><button type="submit" ${state.asking ? "disabled" : ""} aria-label="发送问题">${state.asking ? "…" : "↑"}</button></form></section>`;
}

function renderSettings() {
  const settings = state.session.settings || {};
  const mode = settings.appearance_mode || "auto";
  const automatic = mode === "auto";
  return `<div class="modal-backdrop" data-action="close-settings"><section class="settings-modal" data-overlay-panel><div class="sheet-handle" aria-hidden="true"></div><div class="modal-header"><div><p class="eyebrow">数据与偏好</p><h2>设置</h2></div><button class="icon-button" data-action="close-settings" aria-label="关闭">×</button></div><form id="settings-form" class="settings-form"><label>显示名称<input name="display_name" value="${esc(settings.display_name || "我")}" /></label><label>时区<input name="timezone" value="${esc(settings.timezone || "Asia/Shanghai")}" /></label><label>业务日截止时间<input name="business_day_cutoff" type="time" value="${esc(settings.business_day_cutoff || "04:00")}" /></label><div class="appearance-settings"><div><strong>外观</strong><span>按当前设置的时区自动切换。</span></div><label>显示模式<select name="appearance_mode"><option value="auto" ${mode === "auto" ? "selected" : ""}>按时间自动</option><option value="light" ${mode === "light" ? "selected" : ""}>始终浅色</option><option value="dark" ${mode === "dark" ? "selected" : ""}>始终深色</option></select></label><div class="appearance-times ${automatic ? "" : "is-disabled"}" data-appearance-times><label>夜间开始<input name="dark_mode_start" type="time" value="${esc(settings.dark_mode_start || "20:00")}" ${automatic ? "" : "disabled"} /></label><label>白天开始<input name="light_mode_start" type="time" value="${esc(settings.light_mode_start || "07:00")}" ${automatic ? "" : "disabled"} /></label></div></div><button class="primary-button" type="submit">保存设置</button></form><div class="data-tools"><div><strong>数据可迁移</strong><span>原文、对话、AI 版本、关系和复盘都可带走。</span></div><div class="data-buttons"><button class="outline-button" data-action="export-sqlite">SQLite</button><button class="outline-button" data-action="export-json">JSON</button><button class="outline-button" data-action="export-md">Markdown</button><button class="outline-button" data-action="export-vault">Vault ZIP</button></div></div><p class="local-mode-note">本地单用户模式：打开即用，不设置登录密码。</p></section></div>`;
}

function syncAppearanceControls(form = $("#settings-form")) {
  const mode = form?.querySelector('[name="appearance_mode"]')?.value || "auto";
  const automatic = mode === "auto";
  form?.querySelector("[data-appearance-times]")?.classList.toggle("is-disabled", !automatic);
  for (const input of form?.querySelectorAll("[data-appearance-times] input") || []) {
    input.disabled = !automatic;
  }
}

function bindAuth() {
  $("#auth-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    state.error = "";
    try {
      await api(state.setupRequired ? "/api/setup" : "/api/login", { method: "POST", body: JSON.stringify(Object.fromEntries(form)) });
      await loadSession();
    } catch (error) {
      state.error = errorText(error);
      render();
    }
  });
}

function stopConnectionRecovery() {
  clearTimeout(connectionRetryTimer);
  connectionRetryTimer = undefined;
  connectionRetryAttempt = 0;
  state.connectionRetrying = false;
}

function startConnectionRecovery() {
  if (connectionRetryTimer || state.session) return;
  state.connectionRetrying = true;
  render();
  const retry = async () => {
    if (state.session) return stopConnectionRecovery();
    connectionRetryTimer = undefined;
    connectionRetryAttempt += 1;
    try {
      await loadSession();
      stopConnectionRecovery();
    } catch (error) {
      state.error = errorText(error);
      const delay = Math.min(15000, 1500 * Math.pow(1.35, Math.min(connectionRetryAttempt - 1, 7)));
      connectionRetryTimer = setTimeout(retry, delay);
      render();
    }
  };
  connectionRetryTimer = setTimeout(retry, 1200);
}

async function reconnectNow() {
  if (state.session) return;
  clearTimeout(connectionRetryTimer);
  connectionRetryTimer = undefined;
  state.connectionRetrying = true;
  state.error = "";
  render();
  try {
    await loadSession();
    stopConnectionRecovery();
  } catch (error) {
    state.error = errorText(error);
    state.connectionRetrying = false;
    render();
    startConnectionRecovery();
  }
}

function bindApp() {
  const root = $("#app");
  if (!root || root.dataset.eventsBound === "1") return;
  root.dataset.eventsBound = "1";
  root.addEventListener("pointerdown", (event) => {
    if ((event.target.closest(".send-button") && document.activeElement === $("#composer-input"))
      || (event.target.closest(".ask-composer button") && document.activeElement === $("#search-input"))) {
      // Keep the keyboard and sticky composer stationary until the click arrives.
      event.preventDefault();
    }
  });
  root.addEventListener("click", (event) => {
    if (Date.now() < suppressCalendarClickUntil && event.target.closest("[data-gesture-surface]")) {
      event.preventDefault();
      return;
    }
    if (event.target.closest(".send-button")) {
      event.preventDefault();
      submitEntry(event);
      return;
    }
    const target = event.target.closest("[data-page], [data-action]");
    if (!target || !root.contains(target)) return;
    if ((target.classList.contains("drawer-backdrop") || target.classList.contains("modal-backdrop")) && event.target !== target) return;
    if (target.dataset.page) {
      selectPage(target.dataset.page).catch(showError);
      return;
    }
    handleAction(event, target);
  });
  root.addEventListener("submit", (event) => {
    if (event.target.matches("#composer-form")) submitEntry(event);
    else if (event.target.matches("#search-form")) {
      event.preventDefault();
      state.searchQuery = $("#search-input")?.value.trim() || "";
      searchEntries().catch(showError);
    } else if (event.target.matches("#settings-form")) saveSettings(event);
    else if (event.target.matches("#dialog-form")) submitDialog(event);
  });
  root.addEventListener("input", (event) => {
    if (event.target.matches(".speech-progress")) {
      if (speechPlayback.audio) speechPlayback.audio.currentTime = Number(event.target.value || 0);
      updateSpeechProgress();
      return;
    }
    if (event.target.matches("#composer-input")) {
      state.composer = event.target.value;
      saveDraft();
      resizeComposer(event.target);
    }
    if (event.target.matches(".followup-input")) state.followupDrafts[event.target.closest(".entry-card").dataset.entryId] = event.target.value;
    if (event.target.matches("#search-input")) {
      state.searchQuery = event.target.value;
      resizeComposer(event.target);
    }
  });
  root.addEventListener("keydown", (event) => {
    if (event.target.matches("#search-input") && event.key === "Enter" && !event.shiftKey
      && !matchMedia("(pointer: coarse)").matches) {
      event.preventDefault();
      event.target.closest("form")?.requestSubmit();
    }
  });
  root.addEventListener("change", (event) => {
    if (event.target.matches(".speech-voice")) {
      const control = event.target.closest(".speech-control");
      if (control) changeSpeechVoice(control, event.target.value);
      return;
    }
    if (event.target.matches('#settings-form [name="appearance_mode"]')) {
      syncAppearanceControls(event.target.closest("form"));
      return;
    }
    if (!event.target.matches("#attachment-input")) return;
    appendComposerFiles(event.target.files);
    event.target.value = "";
  });
  root.addEventListener("dragover", (event) => {
    if (!event.target.closest("#composer-form")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    $("#composer-form")?.classList.add("is-dragging");
  });
  root.addEventListener("dragleave", (event) => {
    if (!event.target.closest("#composer-form")) return;
    if (!event.relatedTarget || !event.relatedTarget.closest?.("#composer-form")) {
      $("#composer-form")?.classList.remove("is-dragging");
    }
  });
  root.addEventListener("drop", (event) => {
    if (!event.target.closest("#composer-form")) return;
    event.preventDefault();
    $("#composer-form")?.classList.remove("is-dragging");
    appendComposerFiles(event.dataTransfer?.files);
  });
  root.addEventListener("paste", (event) => {
    if (!event.target.closest("#composer-form")) return;
    const files = [...(event.clipboardData?.files || [])];
    if (!files.length) return;
    event.preventDefault();
    appendComposerFiles(files);
  });
  root.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.dialog) { closeDialog(); return; }
    if (event.key === "Escape" && (state.settingsOpen || state.detailEntryId)) { closeOverlay(); return; }
    if (event.key === "Tab" && overlayScroll !== null) {
      const controls = [...document.querySelectorAll("#overlay-root button, #overlay-root input, #overlay-root textarea")].filter((node) => !node.disabled);
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
    if (!event.target.matches("#composer-input")) return;
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229 && !matchMedia("(pointer: coarse)").matches) {
      event.preventDefault();
      event.target.form?.requestSubmit();
    }
  });
  root.addEventListener("touchstart", (event) => {
    const surface = event.target.closest("[data-gesture-surface]");
    gesture = null;
    if (!surface || event.touches.length !== 1) return;
    const touch = event.touches[0];
    if (touch.clientX < 24 || touch.clientX > window.innerWidth - 24) return;
    // Only the month grid owns a swipe. Reports and daily logs remain native scrolling.
    gesture = { surface, x: touch.clientX, y: touch.clientY, id: touch.identifier, time: Date.now(), revision: navigationRevision, vertical: false };
  }, { passive: true });
  root.addEventListener("touchmove", (event) => {
    if (!gesture) return;
    const touch = [...event.touches].find((item) => item.identifier === gesture.id);
    if (!touch || event.touches.length !== 1) { gesture = null; return; }
    if (Math.abs(touch.clientY - gesture.y) > 16) gesture.vertical = true;
  }, { passive: true });
  root.addEventListener("touchcancel", () => { gesture = null; }, { passive: true });
  root.addEventListener("touchend", (event) => {
    const started = gesture;
    gesture = null;
    const touch = [...event.changedTouches].find((item) => item.identifier === started?.id);
    if (!started || !touch || started.revision !== navigationRevision || !started.surface.isConnected) return;
    const dx = touch.clientX - started.x, dy = touch.clientY - started.y;
    if (Math.hypot(dx, dy) > 12) suppressCalendarClickUntil = Date.now() + 450;
    if (!started.vertical && Math.abs(dx) > 72 && Math.abs(dx) > Math.abs(dy) * 2.5 && Date.now() - started.time < 700) shiftCalendar(dx < 0 ? 1 : -1);
  }, { passive: true });
}

function resizeComposer(input) { input.style.height = "auto"; input.style.height = `${Math.min(input.scrollHeight, 220)}px`; }

function setComposerBusy(busy) {
  const form = $("#composer-form");
  const button = form?.querySelector(".send-button");
  if (form) {
    form.classList.toggle("is-sending", busy);
    form.classList.toggle("has-send-error", state.sendFailed);
    form.setAttribute("aria-busy", String(busy));
    const hint = form.querySelector(".composer-hint");
    hint.setAttribute("role", "status");
    hint.setAttribute("aria-live", "polite");
    hint.textContent = state.sendStatus || "文字、图片或资料都可以，也可以拖进来";
  }
  if (button) {
    button.disabled = busy;
    button.textContent = busy ? "…" : "↑";
    button.setAttribute("aria-label", busy ? "正在保存" : state.sendFailed ? "重试发送" : "发送");
  }
}

async function selectPage(page) {
  if (state.page === page) return;
  return navigate({ page, settingsOpen: false, detailEntryId: null });
}

function routeSnapshot() {
  const keys = ["page", "reviewView", "calendarCursor", "calendarSelectedDate", "reviewReturnView", "timelineDate", "settingsOpen", "detailEntryId", "dialog"];
  return Object.fromEntries(keys.map((key) => [key, state[key]]));
}

function saveHistoryPosition() {
  history.replaceState({ journal: routeSnapshot(), scroll: overlayScroll ?? window.scrollY }, "");
}

async function navigate(patch, { direction = 0 } = {}) {
  saveHistoryPosition();
  const previousPage = state.page;
  pageScroll[previousPage] = overlayScroll ?? window.scrollY;
  Object.assign(state, patch, { error: "", reportLoading: false });
  navigationRevision++;
  const revision = navigationRevision;
  history.pushState({ journal: routeSnapshot(), scroll: previousPage === state.page ? 0 : pageScroll[state.page] || 0 }, "");
  const loading = refreshLocation({ animate: true, direction });
  window.scrollTo({ top: previousPage === state.page ? 0 : pageScroll[state.page] || 0, behavior: "instant" });
  try { await loading; } catch (error) { if (revision === navigationRevision) showError(error); }
}

function refreshLocation(options = {}) {
  if (state.page === "review") return loadReviewData(options);
  if (state.page === "timeline") return loadTimeline(options);
  if (state.page === "ask") return loadAnswers(options);
  render({ animate: options.animate });
  if (state.page === "record") return loadEntries();
}

function showOverlay(patch) {
  saveHistoryPosition();
  Object.assign(state, { settingsOpen: false, detailEntryId: null }, patch);
  history.pushState({ journal: routeSnapshot(), scroll: overlayScroll ?? window.scrollY, overlay: true }, "");
  updateOverlays();
}

function closeOverlay() {
  if (overlayClosing) return;
  overlayClosing = true;
  if (history.state?.overlay) history.back();
  else { state.settingsOpen = false; state.detailEntryId = null; state.dialog = null; updateOverlays(); }
}

window.addEventListener("popstate", (event) => {
  if (!event.state?.journal) return;
  const previous = routeSnapshot();
  Object.assign(state, event.state.journal, { error: "", reportLoading: false });
  const changed = ["page", "reviewView", "calendarCursor", "calendarSelectedDate", "timelineDate"].some((key) => state[key] !== previous[key]);
  if (changed) {
    navigationRevision++;
    const revision = navigationRevision;
    Promise.resolve(refreshLocation({ animate: true })).catch((error) => { if (revision === navigationRevision) showError(error); });
    window.scrollTo({ top: event.state.scroll || 0, behavior: "instant" });
  } else updateOverlays();
  if (state.detailEntryId) openDetail(state.detailEntryId, { historyEntry: false }).catch(showError);
});

function upsertEntry(entry) {
  entriesRevision++;
  const index = state.entries.findIndex((item) => String(item.id) === String(entry.id));
  if (index === -1) state.entries.unshift(entry);
  else state.entries[index] = { ...state.entries[index], ...entry };
  for (const key of ["timelineEntries", "reviewEntries"]) {
    state[key] = state[key].map((item) => String(item.id) === String(entry.id) ? { ...item, ...entry } : item);
  }
  state.todayEntries = state.entries.filter((item) => item.record_date === businessDate());
  return state.entries.find((item) => String(item.id) === String(entry.id));
}

async function submitEntry(event) {
  event.preventDefault();
  const input = $("#composer-input");
  if (!input || state.sending) return;
  const originalValue = input.value;
  const text = originalValue.trim();
  const attachmentsSnapshot = [...(state.composerAttachments || [])];
  if ((!text && !attachmentsSnapshot.length) || text.length > 20000) {
    state.sendStatus = text.length > 20000 ? errorText(new Error("entry_too_long")) : "先添加文字或资料再发送。";
    state.sendFailed = true;
    setComposerBusy(false);
    return;
  }
  if (!state.pendingSend || state.pendingSend.text !== text) {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    state.pendingSend = { id: Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(""), text };
  }
  state.sending = true;
  state.composer = originalValue;
  state.sendFailed = false;
  state.sendStatus = "正在保存…";
  saveDraft();
  setComposerBusy(true);
  let savedEntry;
  let commandResult;
  try {
    let payload;
    if (attachmentsSnapshot.length) {
      payload = new FormData();
      payload.append("text", text);
      payload.append("request_id", state.pendingSend.id);
      attachmentsSnapshot.forEach((item) => payload.append("attachments", item.file, item.name));
    } else {
      payload = JSON.stringify({ text, request_id: state.pendingSend.id });
    }
    const result = await api("/api/entries", { method: "POST", body: payload, timeoutMs: 120000 });
    if (!result.entry?.id) throw new Error("暂未收到有效的保存确认，草稿已保留，请重试。");
    savedEntry = result.entry;
    commandResult = result.command || null;
    // Clear only the acknowledged draft; typing the next note remains available.
    const attachmentsUnchanged = state.composerAttachments.length === attachmentsSnapshot.length
      && state.composerAttachments.every((item, index) => item.file === attachmentsSnapshot[index].file);
    if (state.composer === originalValue && attachmentsUnchanged) {
      state.composer = "";
      state.composerAttachments = [];
      attachmentsSnapshot.forEach((item) => item.previewUrl && URL.revokeObjectURL(item.previewUrl));
      const currentInput = $("#composer-input");
      const attachmentInput = $("#attachment-input");
      if (currentInput) { currentInput.value = ""; resizeComposer(currentInput); }
      if (attachmentInput) attachmentInput.value = "";
      updateMainContent({ animate: false });
    }
    state.pendingSend = null;
    state.sendStatus = result.command?.message || "已保存，AI 正在整理。";
    if (result.command) savedEntry = null;
  } catch (error) {
    state.sendFailed = true;
    state.sendStatus = errorText(error);
  } finally {
    state.sending = false;
    saveDraft();
    setComposerBusy(false);
  }
  if (savedEntry) {
    upsertEntry(savedEntry);
    try { if (state.page === "record") patchEntryCard(savedEntry.id, { isNew: true }); }
    catch { state.sendStatus = "原文已保存，列表显示失败，可在时间线查看。"; setComposerBusy(false); }
    watchEntry(savedEntry.id);
  } else if (!state.sendFailed && commandResult) {
    await loadEntries();
    if (state.page === "timeline") await loadTimeline();
    if (state.page === "review") await loadReviewData();
    if (commandResult.type === "content_correction") watchEntry(commandResult.entry_id);
  }
}

async function watchEntry(id) {
  if (state.polling[id]) return;
  state.polling[id] = true;
  try {
    for (let attempt = 0; ; attempt += 1) {
      await sleep(attempt === 0 ? 350 : attempt < 5 ? 2000 : 5000);
      if (document.hidden) continue;
      const result = await api(`/api/entries/${id}`);
      upsertEntry(result.entry);
      patchEntryCard(result.entry.id);
      if (String(state.detailEntryId) === String(id)) {
        state.entryDetails[id] = { ...state.entryDetails[id], ...result.entry };
        updateOverlays();
      }
      if (["ready", "failed"].includes(result.entry.ai_state)) break;
    }
    await loadEntries({ renderPage: false });
    if (state.page === "timeline") await loadTimeline();
    if (state.page === "review") await loadReviewData();
  } catch (error) {
    state.error = `这条记录已经保存，但状态刷新失败：${errorText(error)}`;
    updateOverlays();
  } finally { delete state.polling[id]; }
}

async function handleAction(event, target = event.target.closest("[data-action]")) {
  if (!target) return;
  const action = target.dataset.action;
  const busyAction = ["skip", "retry", "reply"].includes(action);
  if (busyAction && target.disabled) return;
  if (busyAction) { target.disabled = true; target.setAttribute("aria-busy", "true"); }
  try {
    if (action === "settings") { showOverlay({ settingsOpen: true }); return; }
    if (action === "reconnect") { await reconnectNow(); return; }
    if (action === "toggle-appearance") { await toggleAppearance(); return; }
    if (action === "speak") { toggleSpeaking(target); return; }
    if (action === "speech-stop") { stopSpeaking(); return; }
    if (action === "speech-toggle") {
      const audio = speechPlayback.audio;
      if (!audio) return;
      if (audio.paused) await audio.play().catch(() => {});
      else audio.pause();
      updateSpeechProgress();
      return;
    }
    if (action === "speech-skip") {
      const audio = speechPlayback.audio;
      if (!audio) return;
      const duration = Number.isFinite(audio.duration) ? audio.duration : Infinity;
      audio.currentTime = Math.min(duration, Math.max(0, audio.currentTime + Number(target.dataset.seconds || 0)));
      updateSpeechProgress();
      return;
    }
    if (action === "speech-rate") {
      const current = SPEECH_RATES.indexOf(speechPlayback.rate);
      speechPlayback.rate = SPEECH_RATES[(current + 1) % SPEECH_RATES.length];
      if (speechPlayback.audio) speechPlayback.audio.playbackRate = speechPlayback.rate;
      try { localStorage.setItem("journal-speech-rate", String(speechPlayback.rate)); } catch { /* keep session value */ }
      target.textContent = `${speechPlayback.rate}×`;
      return;
    }
    if (action === "speech-retry") {
      const control = target.closest(".speech-control");
      if (control) startSpeaking(control).catch(showError);
      return;
    }
    if (action === "ask-suggestion") {
      state.searchQuery = target.dataset.question || "";
      render({ animate: false });
      const input = $("#search-input");
      input?.focus();
      if (input) resizeComposer(input);
      return;
    }
    if (action === "retry-answer") {
      const result = await api(`/api/answers/${target.dataset.id}/retry`, { method: "POST" });
      upsertAnswer(result.answer);
      render({ animate: false });
      watchAnswer(result.answer.id);
      return;
    }
    if (action === "close-settings") { closeOverlay(); return; }
    if (action === "close-dialog") { closeDialog(); return; }
    if (action === "clear-error") { state.error = ""; updateOverlays(); return; }
    if (action === "clear-notice") { state.notice = null; updateOverlays(); return; }
    if (action === "pick-attachments") { $("#attachment-input")?.click(); return; }
    if (action === "remove-attachment") {
      const index = Number(target.dataset.index);
      const removed = state.composerAttachments.splice(index, 1)[0];
      removed?.previewUrl && URL.revokeObjectURL(removed.previewUrl);
      updateMainContent({ animate: false });
      return;
    }
    if (action === "logout") { await api("/api/logout", { method: "POST" }).catch(() => {}); state.session = null; render(); return; }
    if (action === "toggle-raw") { const id = target.dataset.id; state.rawOpen[id] = !state.rawOpen[id]; state.rawLoaded[id] = true; patchEntryCard(id); return; }
    if (action === "toggle-search-raw") { const id = target.dataset.id; state.searchRawOpen[id] = !state.searchRawOpen[id]; render(); return; }
    if (action === "open-detail") { state.sourceVersion = null; await openDetail(target.dataset.id); return; }
    if (action === "retry-detail") { await openDetail(state.detailEntryId, { historyEntry: false }); return; }
    if (action === "close-detail") { closeOverlay(); return; }
    if (action === "skip") { const result = await api(`/api/entries/${target.dataset.id}/skip`, { method: "POST" }); upsertEntry(result.entry); patchEntryCard(result.entry.id); return; }
    if (action === "retry") { const result = await api(`/api/entries/${target.dataset.id}/retry`, { method: "POST" }); upsertEntry(result.entry); patchEntryCard(result.entry.id); watchEntry(result.entry.id); return; }
    if (action === "reply") {
      const id = target.dataset.id;
      const article = target.closest(".entry-card");
      const text = article?.querySelector(".followup-input")?.value.trim();
      if (!text) return;
      state.replyingEntries[id] = true;
      patchEntryCard(id);
      try {
        const result = await api(`/api/entries/${id}/reply`, { method: "POST", body: JSON.stringify({ text }) });
        delete state.followupDrafts[id];
        upsertEntry(result.entry);
        delete state.replyingEntries[id];
        patchEntryCard(result.entry.id);
        watchEntry(result.entry.id);
      } catch (error) {
        delete state.replyingEntries[id];
        patchEntryCard(id);
        throw error;
      }
      return;
    }
    if (action === "edit-date") {
      const entry = state.entries.find((item) => String(item.id) === String(target.dataset.id))
        || state.timelineEntries.find((item) => String(item.id) === String(target.dataset.id));
      openDialog({
        type: "date",
        id: Number(target.dataset.id),
        value: entry?.record_date || businessDate(),
        title: "修改归档日期",
        kicker: "日期修正",
        submitLabel: "保存日期",
      });
      return;
    }
    if (action === "delete-entry") {
      openDialog({ type: "delete", id: Number(target.dataset.id), title: "删除这条记录？", kicker: "记录管理", submitLabel: "删除记录" });
      return;
    }
    if (action === "restore-entry") {
      const result = await api(`/api/entries/${target.dataset.id}/restore`, { method: "POST" });
      state.notice = { message: "记录已恢复。", entryId: null };
      upsertEntry(result.entry);
      await refreshLocation();
      updateOverlays();
      return;
    }
    if (action === "shift-date") { await navigate({ timelineDate: shiftDateValue(state.timelineDate || businessDate(), Number(target.dataset.days)) }, { direction: Number(target.dataset.days) }); return; }
    if (action === "timeline-today") { await navigate({ timelineDate: businessDate() }); return; }
    if (action === "calendar-view") {
      const view = target.dataset.view;
      if (view !== state.reviewView) await navigate({ reviewView: view, calendarCursor: state.calendarSelectedDate, ...(view === "day" ? { reviewReturnView: state.reviewView } : {}) });
      return;
    }
    if (action === "calendar-back") { await navigate({ reviewView: state.reviewReturnView, calendarCursor: state.calendarSelectedDate }); return; }
    if (action === "calendar-shift") { shiftCalendar(Number(target.dataset.step)); return; }
    if (action === "calendar-today") { await navigate({ calendarSelectedDate: businessDate(), calendarCursor: businessDate() }); return; }
    if (action === "select-calendar-date") { await navigate({ calendarSelectedDate: target.dataset.date, reviewView: "day", reviewReturnView: state.reviewView }); return; }
    if (action === "open-record-date") { await navigate({ page: "timeline", timelineDate: state.calendarSelectedDate }); return; }
    if (action === "retry-view") { await refreshLocation(); return; }
    if (action === "source-entry") { state.sourceVersion = target.dataset.version || null; await openDetail(target.dataset.id); return; }
    if (action === "toggle-memory-detail" || action === "toggle-memory-history") {
      const key = action === "toggle-memory-history" ? "__history__" : target.dataset.key;
      if (state.memoryExpandedRollup === key) {
        state.memoryExpandedRollup = "";
        render({ animate: false });
        return;
      }
      state.memoryExpandedRollup = key;
      await loadMemoryDetail();
      return;
    }
    if (action === "refresh-memory") {
      const result = await api("/api/memory/digest", { method: "POST" });
      state.memory = result;
      state.memoryDetail = null;
      state.memoryExpandedRollup = "";
      render({ animate: false });
      watchMemoryDigest();
      return;
    }
    if (action === "proposal") {
      state.memory = await api("/api/memory", { method: "POST", body: JSON.stringify({ id: Number(target.dataset.id), status: target.dataset.status }) });
      state.memoryDetail = null;
      state.memoryExpandedRollup = "";
      render(); return;
    }
    if (action === "feedback") {
      openDialog({
        type: "feedback",
        id: Number(target.dataset.id),
        rating: "incorrect",
        title: "哪里需要修正？",
        kicker: "修正 AI 理解",
        submitLabel: "保留并重新理解",
      });
      return;
    }
    if (action === "review-answer") {
      openDialog({ type: "review", id: Number(target.dataset.id), title: "补充这一点", kicker: "复盘追问", submitLabel: "更新复盘" });
      return;
    }
    if (action === "review-skip") {
      await api("/api/review-answer", { method: "POST", body: JSON.stringify({ id: Number(target.dataset.id), text: "" }) });
      await refreshLocation();
      return;
    }
    if (action === "refresh-report") { await createReport(); return; }
    if (["export-json", "export-md", "export-sqlite", "export-vault"].includes(action)) {
      const format = action === "export-md" ? "markdown" : action === "export-sqlite" ? "sqlite" : action === "export-vault" ? "vault" : "json";
      window.location.href = `/api/export?format=${format}`;
    }
    if (action === "report-feedback") {
      openDialog({
        type: "report-feedback",
        reportId: Number(target.dataset.id),
        rating: "incorrect",
        title: "这次复盘哪里不准？",
        kicker: "修正复盘",
        submitLabel: "保存修正",
      });
      return;
    }
  } catch (error) { showError(error); }
  finally { if (busyAction) { target.disabled = false; target.removeAttribute("aria-busy"); } }
}

async function toggleAppearance() {
  if (appearanceSaving || !state.session) return;
  appearanceSaving = true;
  const previous = { ...(state.session?.settings || {}) };
  const current = document.documentElement.dataset.theme || activeAppearance(previous);
  const optimistic = { ...previous, appearance_mode: current === "dark" ? "light" : "dark" };
  state.session.settings = optimistic;
  applyAppearance(optimistic, { animate: true });
  try {
    const result = await api("/api/settings", {
      method: "PATCH",
      body: JSON.stringify({ appearance_mode: optimistic.appearance_mode }),
    });
    state.session.settings = result.settings;
    applyAppearance(result.settings, { animate: false });
  } catch (error) {
    state.session.settings = previous;
    applyAppearance(previous, { animate: true });
    throw error;
  } finally { appearanceSaving = false; }
}

async function openDetail(id, { historyEntry = true } = {}) {
  state.detailLoading[id] = !state.entryDetails[id];
  delete state.detailErrors[id];
  if (historyEntry) showOverlay({ detailEntryId: id });
  else updateOverlays();
  if (state.entryDetails[id]) return;
  try { const result = await api(`/api/entries/${id}`); state.entryDetails[id] = result.entry; }
  catch (error) { state.detailErrors[id] = errorText(error); }
  finally { state.detailLoading[id] = false; if (String(state.detailEntryId) === String(id)) updateOverlays(); }
}

async function editEntryDate(id) {
  const entry = state.entries.find((item) => String(item.id) === String(id)) || state.timelineEntries.find((item) => String(item.id) === String(id));
  if (!entry) return;
  openDialog({
    type: "date",
    id: Number(id),
    value: entry.record_date,
    title: "修改归档日期",
    kicker: "日期修正",
    submitLabel: "保存日期",
  });
}

async function saveSettings(event) {
  event.preventDefault();
  const form = new FormData(event.target);
  const current = state.session?.settings || {};
  const payload = Object.fromEntries(form);
  // Disabled time fields are intentionally omitted in fixed light/dark mode.
  payload.dark_mode_start ||= current.dark_mode_start || "20:00";
  payload.light_mode_start ||= current.light_mode_start || "07:00";
  try {
    const result = await api("/api/settings", { method: "PATCH", body: JSON.stringify(payload) });
    state.session.settings = result.settings;
    applyAppearance(result.settings, { animate: true });
    closeOverlay();
    await loadSession();
  }
  catch (error) { showError(error); }
}

async function loadSession() {
  const session = await api("/api/session");
  if (!session.authenticated) throw new Error("local_space_unavailable");
  const previousSession = state.session;
  state.session = session;
  try {
    applyAppearance(session.settings, { schedule: true });
    scheduleBusinessDateRefresh();
    await loadMemory();
    state.calendarSelectedDate = state.calendarSelectedDate || businessDate();
    state.calendarCursor = state.calendarCursor || businessDate();
    await loadEntries();
    if ($("#app .app-shell")) render({ main: false });
    else render();
    stopConnectionRecovery();
  } catch (error) {
    if (!previousSession) state.session = null;
    throw error;
  }
}

async function loadEntries({ renderPage = true } = {}) {
  const request = ++requests.entries, revision = entriesRevision;
  const today = businessDate();
  const [result, todayResult] = await Promise.all([api("/api/entries?limit=80"), api(`/api/entries?date=${encodeURIComponent(today)}&limit=100`)]);
  if (request !== requests.entries || revision !== entriesRevision) return;
  state.entries = result.entries || [];
  state.todayEntries = todayResult.entries || [];
  for (const entry of state.entries) {
    if (["pending", "processing", "retrying"].includes(entry.ai_state)) watchEntry(entry.id);
  }
  if (state.page === "record" && renderPage) {
    if ($("#feed")) syncRecordFeed();
    else render({ animate: false });
  }
}

async function loadTimeline({ animate = false, direction = 0 } = {}) {
  const dateValue = state.timelineDate || businessDate();
  state.timelineDate = dateValue;
  const revision = navigationRevision, request = ++requests.timeline;
  const current = () => state.page === "timeline" && revision === navigationRevision && request === requests.timeline;
  if (state.timelineDataDate !== dateValue) {
    const cached = timelineCache.get(dateValue);
    state.timelineEntries = cached?.entries || [];
    state.timelineReport = cached?.report || null;
    state.timelineDataDate = dateValue;
    state.timelineLoading = !cached;
  }
  state.timelineError = "";
  render();
  if (animate) animateSurface($(".timeline-page"), direction);
  try {
    const [timeline, report] = await Promise.all([api(`/api/timeline?date=${encodeURIComponent(dateValue)}`), api(`/api/reports?type=daily&date=${encodeURIComponent(dateValue)}`)]);
    if (!current()) return;
    cacheResult(timelineCache, dateValue, { entries: timeline.entries || [], report: report.report });
    state.timelineEntries = timeline.entries || [];
    state.timelineReport = report.report;
  } catch (error) { if (current()) state.timelineError = errorText(error); }
  finally { if (current()) { state.timelineLoading = false; render(); } }
  if (current() && ["queued", "processing", "pending"].includes(state.timelineReport?.status)) watchReport("daily", dateValue);
}

function calendarRange() {
  if (state.reviewView === "month") return monthGridRange(state.calendarCursor || businessDate());
  if (state.reviewView === "week") return { start: startOfWeek(state.calendarSelectedDate || businessDate()), end: endOfWeek(state.calendarSelectedDate || businessDate()) };
  const dateValue = state.calendarSelectedDate || businessDate();
  return { start: dateValue, end: dateValue };
}

function reportEndForReview() {
  if (state.reviewView === "month") { const cursor = dateObject(state.calendarCursor || businessDate()); const last = isoDate(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0, 12, 0, 0)); return (state.calendarCursor || businessDate()).slice(0, 7) === businessDate().slice(0, 7) ? businessDate() : last; }
  return state.reviewView === "week" ? endOfWeek(state.calendarSelectedDate || businessDate()) : state.calendarSelectedDate || businessDate();
}

function reportTypeForReview() { return state.reviewView === "month" ? "monthly" : state.reviewView === "week" ? "weekly" : "daily"; }

function reviewKey() {
  const range = calendarRange();
  return `${state.reviewView}:${range.start}:${range.end}`;
}

async function loadReviewData({ animate = false, direction = 0 } = {}) {
  state.calendarCursor = state.calendarCursor || state.calendarSelectedDate || businessDate();
  state.calendarSelectedDate = state.calendarSelectedDate || businessDate();
  // Capture all request parameters before awaiting; late responses never own navigation.
  const key = reviewKey(), view = state.reviewView, range = calendarRange();
  const dateValue = state.calendarSelectedDate, type = reportTypeForReview(), endDate = reportEndForReview();
  const revision = navigationRevision, request = ++requests.review;
  const current = () => state.page === "review" && revision === navigationRevision && request === requests.review && key === reviewKey();
  if (state.reviewDataKey !== key) {
    const cached = reviewCache.get(key);
    state.calendarDays = cached?.days || [];
    state.reviewEntries = cached?.entries || [];
    state.reviewReport = cached?.report || null;
    state.calendarLoading = !cached;
    state.reviewDataKey = key;
    state.reportLoading = false;
  }
  state.reviewError = "";
  render();
  if (animate) animateSurface($(".calendar-viewport"), direction);
  try {
    const [calendar, report, timeline, memoryResult] = await Promise.all([
      api(`/api/calendar?view=${view}&start=${range.start}&end=${range.end}`),
      api(`/api/reports?type=${type}&date=${encodeURIComponent(endDate)}`),
      view === "day" ? api(`/api/timeline?date=${encodeURIComponent(dateValue)}`) : Promise.resolve({ entries: [] }),
      api("/api/memory"),
    ]);
    if (!current()) return;
    cacheResult(reviewCache, key, { days: calendar.days || [], entries: timeline.entries || [], report: report.report });
    state.calendarDays = calendar.days || [];
    state.reviewEntries = timeline.entries || [];
    state.reviewReport = report.report;
    if (state.memory?.rollup_fingerprint !== memoryResult?.rollup_fingerprint) {
      state.memoryDetail = null;
      state.memoryExpandedRollup = "";
    }
    state.memory = memoryResult;
    if (["queued", "running"].includes(state.memory?.digest?.status)) watchMemoryDigest();
  } catch (error) { if (current()) state.reviewError = errorText(error); }
  finally { if (current()) { state.calendarLoading = false; render(); } }
  if (current() && state.reviewReport && ["queued", "processing", "pending"].includes(state.reviewReport.status)) watchReport(type, endDate);
}

async function watchReport(type, endDate) {
  const page = state.page, isTimeline = page === "timeline";
  const key = isTimeline ? `timeline:${endDate}` : reviewKey(), revision = navigationRevision, request = requests[page];
  const token = `${revision}:${request}`;
  if (reportPolls.get(key) === token) return;
  reportPolls.set(key, token);
  const current = () => state.page === page && revision === navigationRevision && request === requests[page] && (isTimeline ? state.timelineDate === endDate : key === reviewKey());
  try {
    for (let attempt = 0; current(); attempt += 1) {
      await sleep(attempt < 5 ? 2000 : 5000);
      if (!current()) return;
      if (document.hidden) continue;
      const result = await api(`/api/reports?type=${type}&date=${encodeURIComponent(endDate)}`);
      if (!current()) return;
      const previous = state[isTimeline ? "timelineReport" : "reviewReport"];
      state[isTimeline ? "timelineReport" : "reviewReport"] = result.report;
      const cached = isTimeline ? timelineCache.get(endDate) : reviewCache.get(key);
      if (cached) cached.report = result.report;
      if (JSON.stringify(previous) !== JSON.stringify(result.report)) render({ animate: false });
      if (!result.report || ["ready", "failed"].includes(result.report.status)) return;
    }
  } catch (error) {
    if (current()) { state[isTimeline ? "timelineError" : "reviewError"] = "复盘状态暂未更新，可稍后重试。"; render(); }
  } finally {
    if (reportPolls.get(key) === token) reportPolls.delete(key);
  }
}

async function createReport() {
  if (state.reportLoading) return;
  const revision = navigationRevision, page = state.page;
  const current = () => state.page === page && revision === navigationRevision;
  const type = page === "timeline" ? "daily" : reportTypeForReview(), endDate = page === "timeline" ? state.timelineDate : reportEndForReview();
  state.reportLoading = true;
  render({ animate: false });
  try { const result = await api("/api/reports", { method: "POST", body: JSON.stringify({ type, date: endDate }) }); if (current()) { state[page === "timeline" ? "timelineReport" : "reviewReport"] = result.report; render(); watchReport(type, endDate); } }
  catch (error) { if (current()) showError(error); }
  finally { if (current()) { state.reportLoading = false; render(); } }
}

function shiftCalendar(step) {
  if (state.page !== "review") return;
  const dateValue = state.reviewView === "month" ? shiftMonthValue(state.calendarCursor || businessDate(), step) : shiftDateValue(state.calendarSelectedDate || businessDate(), step * (state.reviewView === "week" ? 7 : 1));
  return navigate({ calendarCursor: dateValue, calendarSelectedDate: dateValue }, { direction: step });
}

async function searchEntries() {
  const request = ++requests.search, revision = navigationRevision, query = state.searchQuery.trim();
  if (!query.trim()) return;
  if (!state.askPendingRequest || state.askPendingRequest.question !== query) {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    state.askPendingRequest = {
      question: query,
      id: Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(""),
    };
  }
  state.asking = true;
  render({ animate: false });
  try {
    const result = await api("/api/ask", {
      method: "POST",
      timeoutMs: 30000,
      body: JSON.stringify({ question: query, request_id: state.askPendingRequest.id }),
    });
    if (request !== requests.search || revision !== navigationRevision || state.page !== "ask") return;
    upsertAnswer(result.answer);
    state.searchQuery = "";
    state.askPendingRequest = null;
    render({ animate: false });
    scrollAskToBottom();
    watchAnswer(result.answer.id);
  } catch (error) { showError(error); }
  finally { if (request === requests.search) { state.asking = false; if (state.page === "ask") render(); } }
}

function upsertAnswer(answer) {
  if (!answer?.id) return;
  const index = state.answers.findIndex((item) => String(item.id) === String(answer.id));
  if (index === -1) state.answers.push(answer);
  else state.answers[index] = { ...state.answers[index], ...answer };
  state.answers.sort((a, b) => Number(a.id) - Number(b.id));
}

function scrollAskToBottom() {
  requestAnimationFrame(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" }));
}

async function loadAnswers({ animate = false } = {}) {
  const revision = navigationRevision;
  if (!state.answersLoaded) render({ animate });
  try {
    const result = await api("/api/answers?limit=60");
    if (state.page !== "ask" || revision !== navigationRevision) return;
    state.answers = result.answers || [];
    state.answersLoaded = true;
    render({ animate: false });
    for (const answer of state.answers) {
      if (["queued", "processing"].includes(answer.status)) watchAnswer(answer.id);
    }
  } catch (error) {
    if (state.page === "ask" && revision === navigationRevision) showError(error);
  }
}

async function watchAnswer(id) {
  if (!id || answerPolls.has(id)) return;
  answerPolls.add(id);
  try {
    for (let attempt = 0; ; attempt += 1) {
      await sleep(attempt < 4 ? 1500 : 4000);
      if (document.hidden) continue;
      const result = await api(`/api/answers/${id}`);
      upsertAnswer(result.answer);
      if (state.page === "ask") render({ animate: false });
      if (["ready", "failed"].includes(result.answer.status)) break;
    }
  } catch (error) {
    if (state.page === "ask") showError(error);
  } finally {
    answerPolls.delete(id);
  }
}

restoreAppearance();

window.addEventListener("visibilitychange", () => {
  if (!document.hidden && state.session?.settings) {
    applyAppearance(state.session.settings, { animate: false });
  }
});

window.addEventListener("online", () => {
  if (!state.session) reconnectNow().catch(() => {});
});

window.addEventListener("load", async () => {
  restoreDraft();
  try { await loadSession(); history.scrollRestoration = "manual"; saveHistoryPosition(); if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {}); }
  catch (error) { state.error = errorText(error); render(); startConnectionRecovery(); }
});
