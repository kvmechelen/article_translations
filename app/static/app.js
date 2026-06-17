/* ---- State ---- */
const state = {
  user: null,
  articles: [],
  langFilter: null,
  currentArticle: null,
  currentLang: null,
  segments: {},
  showOnlyUnverified: false,
};

/* ---- API ---- */
async function api(method, path, body) {
  const opts = { method, headers: { "Content-Type": "application/json" } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(path, opts);
  if (res.status === 401) { showLogin(); return null; }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || res.statusText);
  return data;
}

/* ---- Toast ---- */
let _toastTimer;
function toast(msg, duration = 2500) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove("show"), duration);
}

/* ---- Router (hash-based) ---- */
function navigate(hash) { window.location.hash = hash; }

window.addEventListener("hashchange", route);
async function route() {
  if (!state.user) { showLogin(); return; }
  const hash = window.location.hash.slice(1) || "/";
  if (hash === "/" || hash === "") return showQueue();
  const m = hash.match(/^\/articles\/([^/]+)\/([a-z]{2})$/);
  if (m) return showEditor(m[1], m[2]);
  showQueue();
}

/* ---- Login page ---- */
function showLogin() {
  document.getElementById("nav").classList.add("hidden");
  document.getElementById("page-login").classList.remove("hidden");
  document.getElementById("page-app").classList.add("hidden");
}

async function doLogin() {
  const email = document.getElementById("login-email").value.trim();
  const password = document.getElementById("login-password").value;
  const errEl = document.getElementById("login-error");
  const btn = document.getElementById("btn-signin");
  errEl.textContent = "";
  btn.disabled = true;
  btn.textContent = "Signing in…";
  try {
    const res = await fetch("/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      errEl.textContent = data.detail || "Login failed";
      return;
    }
    state.user = data;
    document.getElementById("page-login").classList.add("hidden");
    document.getElementById("nav").classList.remove("hidden");
    document.getElementById("page-app").classList.remove("hidden");
    document.getElementById("nav-user").textContent = `${data.name} (${data.languages.join(", ")})`;
    navigate("/");
    route();
  } catch (err) {
    errEl.textContent = "Network error: " + err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = "Sign in";
  }
}

document.getElementById("btn-signin").addEventListener("click", doLogin);
document.getElementById("login-password").addEventListener("keydown", (e) => {
  if (e.key === "Enter") doLogin();
});
document.getElementById("login-email").addEventListener("keydown", (e) => {
  if (e.key === "Enter") doLogin();
});

document.getElementById("btn-logout").addEventListener("click", async () => {
  await api("POST", "/logout");
  state.user = null;
  window.location.hash = "";
  showLogin();
});

/* ---- Queue page ---- */
async function showQueue() {
  document.getElementById("page-queue").classList.remove("hidden");
  document.getElementById("page-editor").classList.add("hidden");

  const langs = state.user.languages;

  // Build lang filter chips
  const filterEl = document.getElementById("lang-filter");
  filterEl.innerHTML = "";
  const allChip = mkChip("All", null);
  filterEl.appendChild(allChip);
  langs.forEach(l => filterEl.appendChild(mkChip(l.toUpperCase(), l)));

  setActiveChip(state.langFilter);
  await loadQueue();
}

function mkChip(label, lang) {
  const btn = document.createElement("button");
  btn.className = "lang-chip" + (state.langFilter === lang ? " active" : "");
  btn.textContent = label;
  btn.dataset.lang = lang ?? "";
  btn.addEventListener("click", () => {
    state.langFilter = lang;
    setActiveChip(lang);
    renderQueue();
  });
  return btn;
}

function setActiveChip(lang) {
  document.querySelectorAll(".lang-chip").forEach(c => {
    c.classList.toggle("active", (c.dataset.lang || null) === lang);
  });
}

async function loadQueue() {
  const qs = state.langFilter ? `?language=${state.langFilter}` : "";
  try {
    state.articles = await api("GET", `/articles${qs}`) ?? [];
  } catch (err) {
    state.articles = [];
    toast("Failed to load queue: " + err.message);
  }
  renderQueue();
}

function renderQueue() {
  const list = document.getElementById("article-list");
  let articles = state.articles;
  if (state.langFilter) {
    articles = articles.filter(a => a.unverified_by_lang[state.langFilter]);
  }

  if (!articles.length) {
    list.innerHTML = '<p class="empty">All caught up — no unverified segments.</p>';
    return;
  }

  list.innerHTML = "";
  articles.forEach(art => {
    const card = document.createElement("div");
    card.className = "card article-card";

    const langs = Object.entries(art.unverified_by_lang);
    const total = art.total_segments_all_langs;
    const verified = art.verified_segments;
    const pct = total ? Math.round((verified / total) * 100) : 0;

    card.innerHTML = `
      <div style="flex:1; min-width:0;">
        <div class="art-title">${esc(art.title)}</div>
        <div class="art-id">#${esc(art.article_id)}</div>
      </div>
      <div class="art-langs">
        ${langs.map(([l, n]) => `<span class="lang-badge" title="${n} unverified">${l} ${n}</span>`).join("")}
      </div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px;min-width:130px;">
        <div class="progress-bar-wrap"><div class="progress-bar" style="width:${pct}%"></div></div>
        <div class="progress-label">${verified}/${total} verified</div>
      </div>`;

    card.addEventListener("click", () => {
      const firstLang = langs[0][0];
      navigate(`/articles/${art.article_id}/${state.langFilter || firstLang}`);
    });
    list.appendChild(card);
  });
}

/* ---- Sync button ---- */
document.getElementById("btn-sync").addEventListener("click", async () => {
  const btn = document.getElementById("btn-sync");
  const resultEl = document.getElementById("sync-result");
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Syncing…';
  resultEl.innerHTML = "";
  try {
    const s = await api("POST", "/sync");
    if (!s) return;
    resultEl.innerHTML = `
      <div class="sync-result">
        <strong>Sync complete</strong> &mdash;
        ${s.articles_processed} articles processed,
        ${s.machine_translated} machine-translated,
        ${s.preserved} preserved.
        <pre>${esc(s.raw_output)}</pre>
      </div>`;
    await loadQueue();
    toast("Sync complete");
  } catch (err) {
    resultEl.innerHTML = `<div class="error-msg">Sync failed: ${esc(err.message)}</div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = "Sync";
  }
});

/* ---- Editor page ---- */
async function showEditor(articleId, lang) {
  document.getElementById("page-queue").classList.add("hidden");
  document.getElementById("page-editor").classList.remove("hidden");
  document.getElementById("editor-content").innerHTML = '<p class="empty">Loading…</p>';

  if (!state.user.languages.includes(lang)) {
    document.getElementById("editor-content").innerHTML = '<p class="error-msg">You are not assigned to this language.</p>';
    return;
  }

  state.currentArticle = articleId;
  state.currentLang = lang;

  try {
    const data = await api("GET", `/articles/${articleId}?language=${lang}`);
    if (!data) return;
    renderEditor(data);
  } catch (err) {
    document.getElementById("editor-content").innerHTML = `<p class="error-msg">${esc(err.message)}</p>`;
  }
}

function renderEditor(data) {
  state.segments = data.segments;

  document.getElementById("editor-title").textContent = data.title || data.article_id;
  document.getElementById("editor-lang").textContent = data.language.toUpperCase();

  // Verify all button
  document.getElementById("btn-verify-all").onclick = () => verifyAll(data);

  // Show only unverified toggle
  document.getElementById("chk-unverified").checked = state.showOnlyUnverified;
  document.getElementById("chk-unverified").onchange = (e) => {
    state.showOnlyUnverified = e.target.checked;
    applyUnverifiedFilter();
  };

  const list = document.getElementById("editor-content");
  list.innerHTML = "";

  const segKeys = Object.keys(data.segments);
  if (!segKeys.length) {
    list.innerHTML = '<p class="empty">No segments.</p>';
    return;
  }

  segKeys.forEach(key => {
    const seg = data.segments[key];
    list.appendChild(buildSegmentRow(key, seg));
  });

  applyUnverifiedFilter();
}

function buildSegmentRow(key, seg) {
  const row = document.createElement("div");
  row.className = `segment-row ${seg.status}`;
  row.dataset.key = key;
  row.dataset.status = seg.status;

  const metaText = seg.updated_by
    ? `${seg.updated_by} · ${fmtDate(seg.updated_at)}`
    : "";

  row.innerHTML = `
    <div class="seg-header">
      <span class="seg-key">${esc(key)}</span>
      <span class="seg-field">${esc(seg.field)}</span>
      <span class="badge badge-${seg.status}">${seg.status}</span>
      <span class="badge badge-${seg.origin}">${seg.origin}</span>
    </div>
    <div class="seg-body">
      <div>
        <div class="seg-source-label">English source</div>
        <div class="seg-source">${seg.source || '<em style="color:#9ca3af">empty</em>'}</div>
      </div>
      <div>
        <label class="seg-source-label" for="tgt-${key}">${esc(state.currentLang.toUpperCase())} translation</label>
        <textarea id="tgt-${key}" rows="3">${esc(seg.target || "")}</textarea>
      </div>
    </div>
    <div class="seg-actions">
      <button class="btn btn-ghost btn-sm" onclick="copyEnglish('${key}')">Copy English</button>
      <button class="btn btn-ghost btn-sm" onclick="saveDraft('${key}')">Save draft</button>
      <button class="btn btn-success btn-sm" onclick="verifySegment('${key}')">Verify</button>
      <span class="seg-meta">${esc(metaText)}</span>
    </div>`;

  return row;
}

function applyUnverifiedFilter() {
  document.querySelectorAll(".segment-row").forEach(row => {
    row.classList.toggle("hidden", state.showOnlyUnverified && row.dataset.status === "verified");
  });
}

function copyEnglish(key) {
  const seg = state.segments[key];
  if (!seg) return;
  const ta = document.getElementById(`tgt-${key}`);
  ta.value = seg.source;
  ta.focus();
}

async function saveDraft(key) {
  const ta = document.getElementById(`tgt-${key}`);
  if (!ta) return;
  await putSegment(key, ta.value, false);
}

async function verifySegment(key) {
  const ta = document.getElementById(`tgt-${key}`);
  if (!ta) return;
  await putSegment(key, ta.value, true);
}

async function verifyAll(data) {
  const keys = Object.keys(data.segments).filter(k => data.segments[k].status !== "verified");
  if (!keys.length) { toast("Nothing to verify"); return; }

  const btn = document.getElementById("btn-verify-all");
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>';

  for (const key of keys) {
    const ta = document.getElementById(`tgt-${key}`);
    if (!ta || !ta.value.trim()) continue;
    await putSegment(key, ta.value, true, { silent: true });
  }

  toast(`Verified ${keys.length} segment(s)`);
  btn.disabled = false;
  btn.textContent = "Verify all";
}

async function putSegment(key, target, verify, opts = {}) {
  const articleId = state.currentArticle;
  const lang = state.currentLang;
  try {
    const updated = await api(
      "PUT",
      `/articles/${articleId}/segments/${key}?language=${lang}`,
      { target, verify }
    );
    if (!updated) return;

    // Update local state
    state.segments[key] = { ...state.segments[key], ...updated };

    // Update the row in the DOM
    const row = document.querySelector(`.segment-row[data-key="${key}"]`);
    if (row) {
      row.dataset.status = updated.status;
      row.className = `segment-row ${updated.status}`;
      // update badges
      row.querySelector(".badge-verified, .badge-unverified").textContent = updated.status;
      row.querySelector(".badge-verified, .badge-unverified").className = `badge badge-${updated.status}`;
      row.querySelector(".badge-human, .badge-machine").textContent = updated.origin;
      row.querySelector(".badge-human, .badge-machine").className = `badge badge-${updated.origin}`;
      const meta = row.querySelector(".seg-meta");
      if (meta) meta.textContent = `${updated.updated_by} · ${fmtDate(updated.updated_at)}`;
    }

    applyUnverifiedFilter();
    if (!opts.silent) toast(verify ? "Verified" : "Draft saved");
  } catch (err) {
    if (!opts.silent) toast("Error: " + err.message);
  }
}

/* ---- Helpers ---- */
function esc(s) {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleDateString() + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/* ---- Back navigation ---- */
document.getElementById("btn-back").addEventListener("click", () => navigate("/"));

/* ---- Bootstrap ---- */
(async () => {
  try {
    const user = await api("GET", "/me");
    if (user) {
      state.user = user;
      document.getElementById("page-login").classList.add("hidden");
      document.getElementById("nav").classList.remove("hidden");
      document.getElementById("page-app").classList.remove("hidden");
      document.getElementById("nav-user").textContent = `${user.name} (${user.languages.join(", ")})`;
      route();
    } else {
      showLogin();
    }
  } catch {
    showLogin();
  }
})();
