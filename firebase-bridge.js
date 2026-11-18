// LetterRow analytics bridge: Unity C# (FirebaseBridge.jslib) -> Firebase JS SDK.
// Plan: Assets/Scripts/Analytics/Docs/Analytics_Firebase_Plan.md, sections 5.5 and 6.
//
// index.html imports this module with ?v=<build>; Unity calls window.GameFirebase.* through the jslib
// (calls made before the module loaded wait in window.GameFirebaseQueue).
// - Documents (attempts/, sessions/) go to Firestore through a localStorage queue: whatever is not written yet
//   (offline, page closed, blocked) is sent on the next launch.
// - Events go to Google Analytics (may be blocked by ad blockers; documents do not depend on it).
// - When the page is hidden (app switch, tab closed) the attempt in progress is saved as result "quit" and the
//   session gets its "end" block: Unity itself gets no frames in a hidden tab, so only JavaScript can do this.
// Everything fails softly: analytics must never break the game.

const SDK_VERSION = "13.4.0";
const SDK_BASE = "https://www.gstatic.com/firebasejs/" + SDK_VERSION + "/";
const KEY = "LetterRow.analytics.";
const QUEUE_KEY = KEY + "queue";      // documents not yet written: [{ c, id, d, t }]
const PENDING_KEY = KEY + "pending";  // attempt in progress (JSON from Unity)
const SESSION_KEY = KEY + "session";  // session document + live { place, scene, level, startMs, lastEndMs }
const MAX_QUEUE = 100;
const MAX_EVENTS = 300;
const RETRY_MS = 30000;

const query = new URLSearchParams(location.search);
const debugMode = query.has("debug");

const state = {
  phase: "waiting",     // waiting -> loading -> ready | error | off
  project: "",
  uid: "",
  analytics: "waiting", // waiting -> on | unsupported | blocked
  sent: 0,
  failed: 0,
  dropped: 0,
  queued: 0,
  events: 0,
  lastError: "",
  sdk: SDK_VERSION,
  loadSec: 0,
};

let fb = null;                 // { app, auth, db, fs, an, analytics }
let config = null;             // init payload from Unity
const eventBuffer = [];        // events that came before Analytics was ready
const userProps = {};
let flushing = false;
let retryTimer = 0;

function note(error) {
  const text = error && (error.code || error.message) ? (error.code || "") + " " + (error.message || "") : String(error);
  state.lastError = text.trim().slice(0, 240);
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function readJson(key, fallback) {
  try {
    const text = localStorage.getItem(key);
    return text ? JSON.parse(text) : fallback;
  } catch (e) {
    return fallback;
  }
}

function writeText(key, text) {
  try {
    if (text == null) localStorage.removeItem(key);
    else localStorage.setItem(key, text);
  } catch (e) {
    note(e);
  }
}

// ---------- Document queue ----------

function readQueue() {
  const q = readJson(QUEUE_KEY, []);
  return Array.isArray(q) ? q : [];
}

function writeQueue(q) {
  if (q.length > MAX_QUEUE) {
    state.dropped += q.length - MAX_QUEUE;
    q = q.slice(q.length - MAX_QUEUE);
  }
  writeText(QUEUE_KEY, JSON.stringify(q));
  state.queued = q.length;
}

// A newer version of the same document replaces the queued one (the final attempt replaces its "quit").
function enqueue(collection, id, data) {
  if (!collection || !id || !data) return;
  const q = readQueue().filter(item => !(item.c === collection && item.id === id));
  q.push({ c: collection, id: id, d: data, t: Date.now() });
  writeQueue(q);
}

function removeItem(item) {
  writeQueue(readQueue().filter(x => !(x.c === item.c && x.id === item.id && x.t === item.t)));
}

// Rejected for good (rules, bad data): drop it, otherwise it would block the queue forever.
function isPermanent(error) {
  const code = error && error.code;
  return code === "permission-denied" || code === "invalid-argument" || code === "failed-precondition";
}

function scheduleRetry() {
  if (retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = 0;
    flush();
  }, RETRY_MS);
}

async function flush() {
  if (!fb || flushing) return;
  flushing = true;
  try {
    for (;;) {
      const q = readQueue();
      state.queued = q.length;
      if (q.length === 0) break;
      const item = q[0];
      const data = Object.assign({}, item.d, { uid: state.uid, savedAt: fb.fs.serverTimestamp() });
      try {
        await fb.fs.setDoc(fb.fs.doc(fb.db, item.c, item.id), data);
        state.sent++;
        removeItem(item);
      } catch (e) {
        state.failed++;
        note(e);
        if (isPermanent(e)) {
          state.dropped++;
          removeItem(item);
          continue;
        }
        scheduleRetry();
        break;
      }
    }
  } finally {
    flushing = false;
  }
}

// ---------- Firebase ----------

async function init(json) {
  if (state.phase !== "waiting") return;
  try {
    config = JSON.parse(json);
  } catch (e) {
    state.phase = "error";
    note(e);
    return;
  }
  if (!config || !config.firebase || !config.firebase.apiKey) {
    state.phase = "off";
    return;
  }
  state.phase = "loading";
  state.project = config.firebase.projectId || "";
  state.loadSec = round1(performance.now() / 1000);
  try {
    const [appMod, authMod, fsMod] = await Promise.all([
      import(SDK_BASE + "firebase-app.js"),
      import(SDK_BASE + "firebase-auth.js"),
      import(SDK_BASE + "firebase-firestore-lite.js"),
    ]);
    const app = appMod.initializeApp(config.firebase);
    const auth = authMod.getAuth(app);
    await auth.authStateReady();
    const user = auth.currentUser || (await authMod.signInAnonymously(auth)).user;
    fb = { app, auth, db: fsMod.getFirestore(app), fs: fsMod };
    state.uid = user.uid;
    state.phase = "ready";
  } catch (e) {
    state.phase = "error";
    note(e);
    fb = null;
    return;
  }
  initAnalytics(); // not awaited: blocked Analytics must not hold back the documents
  flush();
}

// Started without network: try again when the browser is back online.
function retryInit() {
  if (state.phase === "error" && config) {
    state.phase = "waiting";
    init(JSON.stringify(config));
  } else {
    flush();
  }
}

async function initAnalytics() {
  try {
    const an = await import(SDK_BASE + "firebase-analytics.js");
    if (!(await an.isSupported())) {
      state.analytics = "unsupported";
      eventBuffer.length = 0;
      return;
    }
    const analytics = an.getAnalytics(fb.app);
    fb.an = an;
    fb.analytics = analytics;
    // global: true = gtag('set', ...) right away; the default path (config update) arrived after the first events.
    if (config.installId) an.setUserId(analytics, config.installId, { global: true });
    if (config.tester) userProps.tester = config.tester;
    if (config.build) userProps.build = config.build;
    if (Object.keys(userProps).length > 0) an.setUserProperties(analytics, userProps, { global: true });
    state.analytics = "on";
    logEventNow("game_loaded", { load_sec: state.loadSec, build: config.build || "" });
    for (const [name, params] of eventBuffer.splice(0)) logEventNow(name, params);
  } catch (e) {
    state.analytics = "blocked";
    eventBuffer.length = 0;
    note(e);
  }
}

// ?debug: debug_mode on every event (it travels as ep.debug_mode, and DebugView picks it up; checked 2026-11-18).
// debug_mode in the initializeAnalytics config did NOT reach DebugView: Firebase sends it as a config update.
function logEventNow(name, params) {
  try {
    const p = Object.assign({}, params);
    if (debugMode) p.debug_mode = true;
    fb.an.logEvent(fb.analytics, name, p);
    state.events++;
  } catch (e) {
    note(e);
  }
}

// ---------- Leaving the game ----------

let lastHidden = 0;

function onHidden() {
  const now = Date.now();
  // visibilitychange and pagehide both fire when a tab closes: one save is enough.
  if (now - lastHidden < 1000) return;
  lastHidden = now;
  const nowIso = new Date(now).toISOString();
  let place = "";
  let attemptSec = 0;

  const attempt = readJson(PENDING_KEY, null);
  if (attempt && attempt.id && !attempt.result) {
    const started = Date.parse(attempt.startedAt);
    attemptSec = isFinite(started) ? Math.max(0, (now - started) / 1000) : 0;
    const paused = (attempt.time && attempt.time.paused) || 0;
    attempt.result = "quit";
    attempt.endedAt = nowIso;
    attempt.time = Object.assign({}, attempt.time, {
      total: round1(attemptSec),
      active: round1(Math.max(0, attemptSec - paused)),
    });
    attempt.quit = { hiddenAt: round1(attemptSec), place: "level" };
    enqueue("attempts", attempt.id, attempt);
  }

  const session = readJson(SESSION_KEY, null);
  if (session && session.session) {
    const live = session.live || {};
    place = live.place || "";
    const end = {
      at: nowIso,
      sec: round1((now - (live.startMs || now)) / 1000),
      place: place,
      scene: live.scene || "",
    };
    if (live.level) end.level = live.level;
    if (live.lastEndMs) end.sinceLevelEnd = round1((now - live.lastEndMs) / 1000);
    const doc = Object.assign({}, session);
    delete doc.live;
    doc.end = end;
    if (state.loadSec) doc.loadSec = state.loadSec;
    enqueue("sessions", session.session, doc);
  }

  if (fb && fb.analytics) {
    const live = (session && session.live) || {};
    logEventNow("app_hidden", {
      place: place,
      level: live.level || 0,
      time_sec: round1(attemptSec),
      session_sec: round1((now - (live.startMs || now)) / 1000),
      build: (config && config.build) || "",
    });
  }
  flush();
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") onHidden();
  else flush();
});
window.addEventListener("pagehide", onHidden);
window.addEventListener("online", retryInit);

// ---------- API for FirebaseBridge.jslib ----------

const api = {
  init: init,
  event(name, paramsJson) {
    let params = {};
    try {
      params = JSON.parse(paramsJson || "{}");
    } catch (e) {
      note(e);
    }
    if (fb && fb.analytics) logEventNow(name, params);
    else if (state.analytics === "waiting" && eventBuffer.length < MAX_EVENTS) eventBuffer.push([name, params]);
  },
  userProperty(name, value) {
    userProps[name] = value;
    if (fb && fb.analytics) {
      try {
        fb.an.setUserProperties(fb.analytics, { [name]: value }, { global: true });
      } catch (e) {
        note(e);
      }
    }
  },
  save(collection, id, json) {
    try {
      enqueue(collection, id, JSON.parse(json));
    } catch (e) {
      note(e);
      return;
    }
    flush();
  },
  pending(json) {
    writeText(PENDING_KEY, json);
  },
  clearPending() {
    writeText(PENDING_KEY, null);
  },
  session(json) {
    writeText(SESSION_KEY, json);
  },
  // Same as the page being hidden (tests; Unity never calls it).
  hidden: onHidden,
  status() {
    state.queued = readQueue().length;
    return JSON.stringify(state);
  },
};

window.GameFirebase = api;
state.queued = readQueue().length;
const early = window.GameFirebaseQueue || [];
window.GameFirebaseQueue = null;
for (const [name, args] of early) {
  try {
    api[name].apply(api, args);
  } catch (e) {
    note(e);
  }
}
