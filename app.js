/* GRAMCAST AI — shared web app logic.
 * Data source: the exact two endpoints the voice agent's tools call
 *   find_place  → https://geocoding-api.open-meteo.com/v1/search (India-restricted)
 *   get_weather → https://api.open-meteo.com/v1/forecast
 * No API key required. Numbers shown come only from tool output — never invented.
 */
const GC = (() => {
  const GEO_URL = "https://geocoding-api.open-meteo.com/v1/search";
  const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";

  /* ---------- store (localStorage) ---------- */
  function get(key, fallback) {
    try { const v = JSON.parse(localStorage.getItem("gc_" + key)); return v ?? fallback; }
    catch { return fallback; }
  }
  function set(key, value) { localStorage.setItem("gc_" + key, JSON.stringify(value)); }
  function push(key, item, cap = 60) {
    const arr = get(key, []); arr.unshift(item);
    if (arr.length > cap) arr.length = cap;
    set(key, arr);
  }

  // session: no demo login anymore. A person is identified by a site visit.
  function seedUsers() {
    if (!get("users", null)) {
      set("users", []);
    }
  }
  function session() { return null; }
  function logout() { location.href = "index.html"; }
  function requireRole(role) {
    const s = session();
    if (!s) { location.href = "login.html"; return null; }
    // blocked users are kicked out on their next page visit
    const u = get("users", []).find(x => x.id === s.id);
    if (u && u.blocked) {
      localStorage.removeItem("gc_session");
      location.href = "login.html";
      return null;
    }
    if (role === "admin" && s.role !== "admin") { location.href = "dashboard.html"; return null; }
    if (role === "user" && s.role === "admin") { /* admins can also view farmer view */ }
    return s;
  }

  /* ---------- tools: find_place + get_weather ---------- */
  async function findPlaces(name, count = 1) {
    const u = new URL(GEO_URL);
    u.searchParams.set("name", name);
    u.searchParams.set("country", "IN");
    u.searchParams.set("count", String(count));
    u.searchParams.set("language", "en");
    let body;
    try {
      const res = await fetch(u, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`geocoding HTTP ${res.status}`);
      body = await res.json();
    } catch {
      const e = new Error("Maaf kijiye, is samay weather forecast data available nahi hai. Kripya thodi der baad dobara try karein.");
      e.noData = true; throw e;
    }
    return (body.results || []).map(h => ({
      latitude: h.latitude, longitude: h.longitude,
      place_name: h.name, district: h.admin2, region: h.admin1,
    }));
  }
  async function findPlace(name) {
    const hits = await findPlaces(name, 1);
    if (!hits.length) {
      const e = new Error("Maaf kijiye, mujhe is location ka exact Panchayat forecast verify nahi mil raha.");
      e.noData = true; throw e;
    }
    return hits[0];
  }
  async function getWeather(place, days = 5) {
    const u = new URL(FORECAST_URL);
    u.searchParams.set("latitude", String(place.latitude));
    u.searchParams.set("longitude", String(place.longitude));
    u.searchParams.set("current", "weather_code,temperature_2m");
    u.searchParams.set("daily",
      "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,precipitation_hours");
    u.searchParams.set("forecast_days", String(days + 1));
    u.searchParams.set("timezone", "Asia/Kolkata");
    let body;
    try {
      const res = await fetch(u, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`forecast HTTP ${res.status}`);
      body = await res.json();
    } catch {
      const e = new Error("Maaf kijiye, is samay weather forecast data available nahi hai. Kripya thodi der baad dobara try karein.");
      e.noData = true; throw e;
    }
    if (!body.daily) {
      const e = new Error("Maaf kijiye, is samay weather forecast data available nahi hai. Kripya thodi der baad dobara try karein.");
      e.noData = true; throw e;
    }
    return body;
  }

  function logQuery(place, user) {
    push("forecast_log", {
      place: place.place_name + (place.region ? ", " + place.region : ""),
      lat: place.latitude, lon: place.longitude,
      by: user ? user.name + " (" + user.role + ")" : "guest",
      at: new Date().toISOString(),
      atText: new Date().toLocaleString("en-IN"),
    });
  }

  /* ---------- speech: WMO codes (from prompts/GRAMCAST_PROMPT.md) ---------- */
  function wmoSpeech(code) {
    if (code == null) return { hi: "unknown", en: "unknown" };
    if (code <= 2)   return { hi: "saaf / mainly saaf aasmaan", en: "Clear / mainly clear sky" };
    if (code === 3)  return { hi: "badal chhaaye hue",          en: "Overcast" };
    if (code <= 48)  return { hi: "kohra",                     en: "Fog" };
    if (code <= 57)  return { hi: "halki runha / buund",       en: "Light drizzle" };
    if (code <= 65)  return { hi: "baarish",                  en: "Rain" };
    if (code <= 77)  return { hi: "fauwara / baraf ki larhi",  en: "Snow / sleet" };
    if (code <= 82)  return { hi: "barasi / garaj-chamak",     en: "Rain showers / thunder" };
    if (code <= 86)  return { hi: "outha hua baarish",         en: "Showers" };
    if (code === 95) return { hi: "gajargur-aandhi",           en: "Thunderstorm" };
    return { hi: "kaada garaj purviandhi", en: "Severe thunderstorm" };
  }

  /* intensity from data only: probability + mm/day sum */
  function intensityFor(day) {
    const p = day.precipitation_probability_max;
    const mm = day.precipitation_sum;
    const prob = p == null ? null : Number(p);
    const sum = mm == null ? null : Number(mm);
    if ((prob == null || prob <= 0) && (sum == null || sum <= 0)) {
      return { label: "baarish ki sambhavna nahi / no rain expected", level: "none" };
    }
    if ((prob != null && prob >= 70) || (sum != null && sum >= 15))
      return { label: "tez baarish ho sakti hai / heavy rain possible", level: "heavy" };
    if ((prob != null && prob >= 40) || (sum != null && sum >= 3))
      return { label: "adarth baarish ho sakti hai / moderate rain possible", level: "moderate" };
    return { label: "halki baarish ho sakti hai / light rain possible", level: "light" };
  }

  /* indicative confidence — derived from spread of rain probability, clearly labelled indicative */
  function indicativeConfidence(day) {
    const p = Number(day.precipitation_probability_max);
    if (!Number.isFinite(p)) return { label: "unknown", chip: "muted" };
    const dist = Math.abs(p - 50);
    if (dist >= 30) return { label: "high (indicative)", chip: "ok" };
    if (dist >= 15) return { label: "medium (indicative)", chip: "warn" };
    return { label: "low (indicative)", chip: "bad" };
  }

  /* ---------- farming advisory (mirrors the agent's advisory rules) ---------- */
  function advisoryFor(day) {
    const inten = intensityFor(day);
    const tmax = Number(day.temperature_2m_max);
    const code = Number(day.weather_code);
    const adv = { level: "ok", lines: [] };

    if (inten.level === "heavy") {
      adv.level = "bad";
      adv.lines.push(
        "Baarish ki sambhavna zyada hai — irrigation aur spraying postpone karna behtar ho sakta hai.",
        "Khet ke khule samaan (fertilizer, seeds, tools) weather-safe jagah par chhupaayein aur drainage check karein."
      );
    } else if (inten.level === "moderate") {
      adv.level = "warn";
      adv.lines.push(
        "Adarth baarish ki sambhavna hai — irrigation ki timing baarish ke hisaab se set karein; spraying ke liye dry window dekhein."
      );
    } else {
      adv.lines.push(
        "Baarish ki sambhavna kam hai — sowing, harvesting ya field work jaise baahari kaam ke liye favourable window hai."
      );
    }
    if (Number.isFinite(tmax) && tmax >= 38) {
      adv.level = adv.level === "bad" ? "bad" : "warn";
      adv.lines.push("Temperature kaafi zyada rahega (" + tmax + "°C) — dopahar ke samay kheti ke kaam mein extra savdhani rakhein, paani ka arrangement rakhein.");
    }
    if (code >= 45 && code <= 48) {
      adv.lines.push("Kohra (fog) ka sambhav hai — subah ke vehicle movement aur machinery work mein savdhani rakhein.");
    }
    return adv;
  }

  function placeLabel(place) {
    return place.place_name +
      (place.district ? ", " + place.district : "") +
      (place.region ? ", " + place.region : "");
  }

  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, c =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function el(html) { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstElementChild; }

  /* ---------- UI helpers ---------- */
  function showToast(msg, kind, sec) {
    const box = document.getElementById("toastBox");
    if (!box) return;
    const el2 = document.createElement("div");
    el2.className = "toast" + (kind ? " " + kind : "");
    el2.textContent = msg;
    box.appendChild(el2);
    setTimeout(() => { el2.classList.add("show"); }, 10);
    setTimeout(() => {
      el2.classList.remove("show");
      setTimeout(() => el2.remove(), 320);
    }, sec || 4200);
  }
  function showAlert(msg, kind) {
    const box = document.getElementById("alertBox");
    if (!box) return;
    const el2 = document.createElement("div");
    el2.className = "alert" + (kind ? " " + kind : "");
    el2.textContent = msg;
    box.appendChild(el2);
    setTimeout(() => { el2.classList.add("show"); }, 10);
    setTimeout(() => {
      el2.classList.remove("show");
      setTimeout(() => el2.remove(), 320);
    }, 3400);
  }
  function showStats(containerId, labels, values) {
    const box = document.getElementById(containerId);
    if (!box) return;
    box.innerHTML = labels.map((l, i) =>
      '<div class="day-card stat"><div class="v">' + values[i] + '</div><div class="l">' + l + "</div></div>"
    ).join("");
  }
  function showForecast(containerId, place, w, days) {
    const box = document.getElementById(containerId);
    if (!box) return;
    const d = w && w.daily;
    const n = Math.min(days || 3, d ? d.time.length : 0);
    if (!n) { box.innerHTML = "<p class=\"empty\">No forecast block returned — no data to show.</p>"; return; }
    let html = "";
    for (let i = 0; i < n; i++) {
      const day = {
        weather_code: d.weather_code[i],
        temperature_2m_max: d.temperature_2m_max[i],
        temperature_2m_min: d.temperature_2m_min[i],
        precipitation_probability_max: d.precipitation_probability_max[i],
        precipitation_sum: d.precipitation_sum[i],
        precipitation_hours: d.precipitation_hours[i],
        time: d.time[i]
      };
      const c = GC.wmoSpeech(day.weather_code);
      const inten = GC.intensityFor(day);
      const conf = GC.indicativeConfidence(day);
      const adv = GC.advisoryFor(day);
      const cls = inten.level === "heavy" ? "rainy" : (Number(day.temperature_2m_max) >= 38 ? "hot" : "");
      html += '<div class="day-card ' + cls + '">' +
        '<div class="d">' + GC.esc(day.time) + '</div>' +
        '<div class="cond">' + GC.esc(c.hi) + '</div>' +
        '<div class="row"><span>Max / Min °C</span><span>' + day.temperature_2m_max + " / " + day.temperature_2m_min + "</span></div>" +
        '<div class="row"><span>Baarish ki sambhavna</span><span>' + (day.precipitation_probability_max ?? "n/a") + "%</span></div>" +
        '<div class="row"><span>Intensit:</span><span>' + GC.esc(inten.label.split(" / ")[0]) + '</span></div>' +
        '<div class="row"><span>Total</span><span>' + (day.precipitation_sum ?? "n/a") + " mm</span></div>" +
        '<div class="row"><span>Confidence</span><span>' + GC.esc(conf.label) + '</span></div>' +
        '<div class="row"><span>Advisory</span><span class="adv-line">' + GC.esc(adv.lines.join(" / ")) + '</span></div>' +
        "</div>";
    }
    box.innerHTML = html;
  }
  function renderSaved(locKey, listEl, placeFn, onRender) {
    const list = GC.store.get(locKey, []);
    listEl.innerHTML = "";
    list.forEach((l, i) => {
      const chip = GC.el('<span class="loc-chip">' + GC.esc(l.place_name) +
        '<button title="remove" data-i="' + i + '">✕</button></span>');
      chip.addEventListener("click", e => { if (e.target.tagName !== "BUTTON") { const p = placeFn ? placeFn(l) : l; onRender && onRender(p); } });
      chip.querySelector("button").addEventListener("click", e => {
        e.stopPropagation();
        const arr = GC.store.get(locKey, []); arr.splice(i, 1); GC.store.set(locKey, arr);
        renderSaved(locKey, listEl);
      });
      listEl.appendChild(chip);
    });
  }
  function renderCallLog(tableEl, rows, rowFn) {
    tableEl.innerHTML = rows.length ? rows.map(r => rowFn(r)).join("") : "<tr><td colspan=\"5\">No calls yet.</td></tr>";
  }
  function renderCallDetails(destTable, calls) {
    destTable.innerHTML =
      "<tr><td colspan=2><strong>" + calls.length + " raw call record(s)</strong></td></tr>" +
      calls.map(c =>
        "<tr><td>Caller</td><td>" + GC.esc(c.caller) + "</td></tr>" +
        "<tr><td>Village asked</td><td>" + GC.esc(c.village) + "</td></tr>" +
        "<tr><td>Duration</td><td>" + GC.esc(c.dur) + "</td></tr>" +
        "<tr><td>When (UTC)</td><td>" + GC.esc(c.at || "") + "</td></tr>" +
        "<tr><td>When (Local)</td><td>" + GC.esc(new Date(c.at).toLocaleString("en-IN")) + "</td></tr>" +
        "<tr><td>Outcome</td><td>" + GC.esc(c.outcome) + "</td></tr>"
      ).join("");
  }
  function renderUsers(tableEl, users, session, onToggle) {
    tableEl.innerHTML = users.map(u => {
      const self = u.id === session.id;
      const chipRole = '<span class="chip ' + (u.role === "admin" ? "ok" : "info") + '">' + GC.esc(u.role) + "</span>";
      const chipStatus = '<span class="chip ' + (u.blocked ? "bad" : "ok") + '">' + (u.blocked ? "blocked" : "active") + "</span>";
      const btn = '<button data-act="toggle" data-id="' + u.id + '" class="btn sm ' + (u.blocked ? "out" : "danger") + '"' + (self ? " disabled title='You cannot block your own session'" : "") + ">" + (u.blocked ? "Unblock" : "Block") + "</button>";
      return "<tr><td>" + GC.esc(u.name) + " </td>" +
        "<td>" + chipRole + "</td>" + "<td>" + chipStatus + "</td>" + "<td>" + btn + "</td>";
    }).join("");
  }
  function searchLog(rows, q) {
    if (!q) return rows;
    const k = q.toLowerCase();
    return rows.filter(r => (r.place || "").toLowerCase().includes(k) ||
      (r.caller || "").toString().toLowerCase().includes(k) ||
      (r.village || "").toString().toLowerCase().includes(k) ||
      (r.outcome || "").toString().toLowerCase().includes(k) ||
      (r.at || "").toString().toLowerCase().includes(k) ||
      (r.atText || "").toString().toLowerCase().includes(k));
  }
  function filterToday(rows) { return rows.filter(r => (r.at || "").slice(0, 10) === new Date().toISOString().slice(0, 10)); }
  function filterOutcome(rows, o) { return o ? rows.filter(r => (r.outcome || "") === o) : rows; }
  function userFrom(id, users) { return users.find(u => u.id === id); }
  async function getUserCallHistory(uid) {
    const users = GC.store.get("users", []);
    const u = userFrom(uid, users);
    if (!u) return null;
    const byId = {};
    GC.store.get("call_log", []).forEach(c => { (byId[c.caller] = byId[c.caller] || []).push(c); });
    const list = (byId[uid] || []).map(c => Object.assign({}, c));
    list.sort((a, b) => (b.at || "").localeCompare(a.at || ""));
    return { user: u, calls: list };
  }
  function escForCsv(s) { return GC.esc(s).replace(/"/g, '""'); }
  function exportCsv(name, rows, cols) {
    const lines = [cols.join(",")];
    rows.forEach(r => { lines.push(cols.map(c => escForCsv(r[c])).join(",")); });
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  }
  function pruneSampleRows() {
    const arr = GC.store.get("call_log", []);
    const fresh = arr.filter(c => !(c.sample === "sample data - wire Exotel CDR feed here"));
    if (fresh.length !== arr.length) { GC.store.set("call_log", fresh); return true; }
    return false;
  }
  function localTime(iso) { return new Date(iso).toLocaleString("en-IN"); }
  function isoDate(iso) { return (iso || "").slice(0, 10); }
  function nocall() {
    const r = { caller: "—", village: "—", dur: "—", at: new Date().toISOString(), outcome: "no data" };
    return r;
  }
  function userKey(id) { return "locs_" + id; }
  function uniqueId(v) { return typeof v === "string" ? v : (v === undefined ? "" : v); }
  async function getUserCallHistory(uid) {
    const users = GC.store.get("users", []);
    const u = users.find(x => x.id === uid);
    if (!u) return { user: null, calls: [] };
    const byCaller = {};
    GC.store.get("call_log", []).forEach(c => { (byCaller[c.caller] = byCaller[c.caller] || []).push(c); });
    const list = (byCaller[uid] || []).map(c => Object.assign({}, c));
    list.sort((a, b) => (b.at || "").localeCompare(a.at || ""));
    return { user: u, calls: list };
  }
  function escForCsv(s) { return GC.esc(s).replace(/"/g, '""'); }
  function exportCsv(name, rows, cols) {
    const lines = [cols.join(",")];
    rows.forEach(r => { lines.push(cols.map(c => escForCsv(r[c])).join(",")); });
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  }
  function pruneSampleRows() {
    const arr = GC.store.get("call_log", []);
    const fresh = arr.filter(c => !(c.sample === "sample data - wire Exotel CDR feed here"));
    if (fresh.length !== arr.length) { GC.store.set("call_log", fresh); return true; }
    return false;
  }
  const FACTS = {
    agent: "GRAMCAST-AI-f7c7a63d-8219",
    deploy: "GRAMCAST-AI-cf467d95-cf03",
    phone: "+91 11 4118 9624",
    phone_dial: "011 4118 9624",
    telephony: "Exotel",
    voice: "shubh (Sarvam TTS)",
    language: "hi-IN (default)",
    source: "Open-Meteo model data — not an official IMD warning",
  };

  return {
    findPlace, findPlaces, getWeather, logQuery,
    wmoSpeech, intensityFor, indicativeConfidence, advisoryFor,
    placeLabel, esc, el,
    showToast, showAlert, showStats, showForecast,
    renderSaved, renderCallLog, renderCallDetails,
    renderUsers, searchLog, filterToday, filterOutcome,
    getUserCallHistory, exportCsv, pruneSampleRows, localTime, isoDate,
    nocall, userKey, FACTS,
    store: { get, set, push },
    uniqueId,
    getUserCallHistory,
    exportCsv,
    pruneSampleRows,
    localTime,
    isoDate,
    nocall,
    userKey,
    auth: { session, logout, requireRole, seed: seedUsers },
  };

  // Attach to global window so inline scripts can access GC
  window.GC = GC;
})();
