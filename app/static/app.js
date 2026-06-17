/* ---- State ---- */
const state = {
  user: null,       // {email, name, languages, role}
  articles: [],
  langFilter: null,
  currentArticle: null,
  currentLang: null,
  segments: {},
  showOnlyUnverified: false,
  // users admin
  users: [],
  editingEmail: null,   // null = create, string = editing existing
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

/* ---- Router ---- */
function navigate(hash) { window.location.hash = hash; }

window.addEventListener("hashchange", route);
async function route() {
  if (!state.user) { showLogin(); return; }
  const hash = window.location.hash.slice(1) || "/";
  if (hash === "/" || hash === "") return showQueue();
  if (hash === "/account") return showAccount();
  if (hash === "/admin/users") {
    if (state.user.role !== "admin") { navigate("/"); return; }
    return showUsers();
  }
  const m = hash.match(/^\/articles\/([^/]+)\/([a-z]{2})$/);
  if (m) return showEditor(m[1], m[2]);
  navigate("/");
}

/* ---- Nav ---- */
function updateNav() {
  const u = state.user;
  document.getElementById("nav-user").textContent = u.name;
  document.getElementById("nav-users").classList.toggle("hidden", u.role !== "admin");
  document.getElementById("btn-sync").classList.toggle("hidden", u.role !== "admin");
}

/* ---- Login ---- */
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
    if (!res.ok) { errEl.textContent = data.detail || "Login failed"; return; }
    state.user = data;
    document.getElementById("page-login").classList.add("hidden");
    document.getElementById("nav").classList.remove("hidden");
    document.getElementById("page-app").classList.remove("hidden");
    updateNav();
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
document.getElementById("login-password").addEventListener("keydown", e => { if (e.key === "Enter") doLogin(); });
document.getElementById("login-email").addEventListener("keydown", e => { if (e.key === "Enter") doLogin(); });

document.getElementById("btn-logout").addEventListener("click", async () => {
  await api("POST", "/logout");
  state.user = null;
  window.location.hash = "";
  showLogin();
});

/* ---- Helpers ---- */
function hidePage(id) { document.getElementById(id).classList.add("hidden"); }
function showPage(id) { document.getElementById(id).classList.remove("hidden"); }

function activatePage(pageId) {
  ["page-queue", "page-editor", "page-account", "page-users"].forEach(hidePage);
  showPage(pageId);
}

function esc(s) {
  if (s == null) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleDateString() + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/* ============================================================
   QUEUE
   ============================================================ */

async function showQueue() {
  activatePage("page-queue");

  // Proofreaders have exactly one language — no filter chips needed
  const langs = state.user.languages;
  const filterEl = document.getElementById("lang-filter");
  filterEl.innerHTML = "";

  if (state.user.role === "admin" && langs.length > 1) {
    const allChip = mkChip("All", null);
    filterEl.appendChild(allChip);
    langs.forEach(l => filterEl.appendChild(mkChip(l.toUpperCase(), l)));
    setActiveChip(state.langFilter);
  } else {
    // Proofreader: force filter to their one language
    state.langFilter = langs[0] || null;
  }

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
    loadQueue();
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
  const articles = state.articles;

  if (!articles.length) {
    list.innerHTML = '<p class="empty">No articles found. Run a Sync to load articles.</p>';
    return;
  }

  const needsWork = [];
  const allDone = [];

  for (const art of articles) {
    if (state.langFilter) {
      const s = art.lang_stats[state.langFilter];
      if (s && s.verified >= s.total && s.total > 0) allDone.push(art);
      else needsWork.push(art);
    } else {
      if (art.verified_segments >= art.total_segments_all_langs && art.total_segments_all_langs > 0)
        allDone.push(art);
      else needsWork.push(art);
    }
  }

  updateQueueProgress();

  list.innerHTML = "";
  needsWork.forEach(art => list.appendChild(buildArticleCard(art)));

  if (allDone.length) {
    const sep = document.createElement("div");
    sep.className = "queue-separator";
    sep.textContent = `Fully verified${state.langFilter ? " in " + state.langFilter.toUpperCase() : ""} (${allDone.length})`;
    list.appendChild(sep);
    allDone.forEach(art => list.appendChild(buildArticleCard(art)));
  }
}

function buildArticleCard(art) {
  const card = document.createElement("div");
  card.className = "card article-card";

  const assignedLangs = state.user.languages;
  const badgesHtml = assignedLangs.map(l => {
    const s = art.lang_stats[l];
    if (!s) return "";
    if (s.verified >= s.total && s.total > 0)
      return `<span class="lang-badge lang-badge-done" title="${s.total}/${s.total} verified">${l} ✓</span>`;
    const unv = s.total - s.verified;
    return `<span class="lang-badge" title="${unv} unverified">${l} ${unv}</span>`;
  }).join("");

  const total = art.total_segments_all_langs;
  const verified = art.verified_segments;
  const pct = total ? Math.round((verified / total) * 100) : 0;

  card.innerHTML = `
    <div style="flex:1; min-width:0;">
      <div class="art-title">${esc(art.title)}</div>
      <div class="art-id">#${esc(art.article_id)}</div>
    </div>
    <div class="art-langs">${badgesHtml}</div>
    <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px;min-width:130px;">
      <div class="progress-bar-wrap"><div class="progress-bar" style="width:${pct}%"></div></div>
      <div class="progress-label">${verified}/${total} verified</div>
    </div>`;

  card.addEventListener("click", () => {
    let targetLang = state.langFilter;
    if (!targetLang) {
      targetLang = assignedLangs.find(l => {
        const s = art.lang_stats[l];
        return s && s.verified < s.total;
      }) || assignedLangs[0];
    }
    navigate(`/articles/${art.article_id}/${targetLang}`);
  });

  return card;
}

/* ---- Sync ---- */
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

/* ============================================================
   EDITOR
   ============================================================ */

async function showEditor(articleId, lang) {
  activatePage("page-editor");
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
  document.getElementById("btn-verify-all").onclick = () => verifyAll(data);
  document.getElementById("chk-unverified").checked = state.showOnlyUnverified;
  document.getElementById("chk-unverified").onchange = e => {
    state.showOnlyUnverified = e.target.checked;
    applyUnverifiedFilter();
  };

  const list = document.getElementById("editor-content");
  list.innerHTML = "";

  const segKeys = Object.keys(data.segments);
  if (!segKeys.length) { list.innerHTML = '<p class="empty">No segments.</p>'; return; }

  segKeys.forEach(key => list.appendChild(buildSegmentRow(key, data.segments[key])));
  applyUnverifiedFilter();
  updateEditorProgress();
}

function buildSegmentRow(key, seg) {
  const row = document.createElement("div");
  row.className = `segment-row ${seg.status}`;
  row.dataset.key = key;
  row.dataset.status = seg.status;

  const metaText = seg.updated_by ? `${seg.updated_by} · ${fmtDate(seg.updated_at)}` : "";

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

function updateQueueProgress() {
  const articles = state.articles;
  if (!articles.length) {
    document.getElementById("queue-progress").classList.add("hidden");
    return;
  }

  let totalSegs = 0, totalVerified = 0;
  for (const art of articles) {
    if (state.langFilter) {
      const s = art.lang_stats[state.langFilter];
      if (s) { totalSegs += s.total; totalVerified += s.verified; }
    } else {
      totalSegs += art.total_segments_all_langs;
      totalVerified += art.verified_segments;
    }
  }

  const pct = totalSegs ? Math.round((totalVerified / totalSegs) * 100) : 0;
  const scope = state.langFilter ? state.langFilter.toUpperCase() : "all languages";

  document.getElementById("queue-progress").classList.remove("hidden");
  document.getElementById("queue-progress-bar").style.width = pct + "%";
  document.getElementById("queue-progress-label").textContent =
    `${totalVerified.toLocaleString()} / ${totalSegs.toLocaleString()} verified (${pct}%) — ${scope}`;
}

function updateEditorProgress() {
  const segs = Object.values(state.segments);
  const total = segs.length;
  if (!total) return;
  const verified = segs.filter(s => s.status === "verified").length;
  const pct = Math.round((verified / total) * 100);
  const unverified = total - verified;

  document.getElementById("editor-progress").classList.remove("hidden");
  document.getElementById("editor-progress-bar").style.width = pct + "%";
  document.getElementById("editor-progress-label").textContent =
    `${verified} / ${total} verified (${pct}%) · ${unverified} remaining`;
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
  if (ta) await putSegment(key, ta.value, false);
}

async function verifySegment(key) {
  const ta = document.getElementById(`tgt-${key}`);
  if (ta) await putSegment(key, ta.value, true);
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
  btn.textContent = "Verify all unverified";
}

async function putSegment(key, target, verify, opts = {}) {
  const articleId = state.currentArticle;
  const lang = state.currentLang;
  try {
    const updated = await api("PUT", `/articles/${articleId}/segments/${key}?language=${lang}`, { target, verify });
    if (!updated) return;
    state.segments[key] = { ...state.segments[key], ...updated };
    const row = document.querySelector(`.segment-row[data-key="${key}"]`);
    if (row) {
      row.dataset.status = updated.status;
      row.className = `segment-row ${updated.status}`;
      row.querySelector(".badge-verified, .badge-unverified").textContent = updated.status;
      row.querySelector(".badge-verified, .badge-unverified").className = `badge badge-${updated.status}`;
      row.querySelector(".badge-human, .badge-machine").textContent = updated.origin;
      row.querySelector(".badge-human, .badge-machine").className = `badge badge-${updated.origin}`;
      const meta = row.querySelector(".seg-meta");
      if (meta) meta.textContent = `${updated.updated_by} · ${fmtDate(updated.updated_at)}`;
    }
    applyUnverifiedFilter();
    updateEditorProgress();
    if (!opts.silent) toast(verify ? "Verified" : "Draft saved");
  } catch (err) {
    if (!opts.silent) toast("Error: " + err.message);
  }
}

document.getElementById("btn-back").addEventListener("click", () => navigate("/"));

/* ============================================================
   ACCOUNT SETTINGS
   ============================================================ */

async function showAccount() {
  activatePage("page-account");
  document.getElementById("acc-name").value = state.user.name;
  document.getElementById("acc-email").value = state.user.email;
  document.getElementById("profile-msg").classList.add("hidden");
  document.getElementById("password-msg").classList.add("hidden");
  document.getElementById("acc-pw-current").value = "";
  document.getElementById("acc-pw-new").value = "";
  document.getElementById("acc-pw-confirm").value = "";
}

document.getElementById("btn-save-profile").addEventListener("click", async () => {
  const name = document.getElementById("acc-name").value.trim();
  const email = document.getElementById("acc-email").value.trim();
  const msgEl = document.getElementById("profile-msg");
  msgEl.classList.add("hidden");
  try {
    const updated = await api("PUT", "/me", { name, email });
    if (!updated) return;
    state.user = { ...state.user, ...updated };
    updateNav();
    msgEl.textContent = "Profile saved.";
    msgEl.className = "success-msg";
    msgEl.classList.remove("hidden");
  } catch (err) {
    msgEl.textContent = err.message;
    msgEl.className = "error-msg";
    msgEl.classList.remove("hidden");
  }
});

document.getElementById("btn-save-password").addEventListener("click", async () => {
  const current = document.getElementById("acc-pw-current").value;
  const next = document.getElementById("acc-pw-new").value;
  const confirm = document.getElementById("acc-pw-confirm").value;
  const msgEl = document.getElementById("password-msg");
  msgEl.classList.add("hidden");

  if (next !== confirm) {
    msgEl.textContent = "New passwords do not match.";
    msgEl.className = "error-msg";
    msgEl.classList.remove("hidden");
    return;
  }
  try {
    await api("PUT", "/me/password", { current_password: current, new_password: next });
    document.getElementById("acc-pw-current").value = "";
    document.getElementById("acc-pw-new").value = "";
    document.getElementById("acc-pw-confirm").value = "";
    msgEl.textContent = "Password changed.";
    msgEl.className = "success-msg";
    msgEl.classList.remove("hidden");
  } catch (err) {
    msgEl.textContent = err.message;
    msgEl.className = "error-msg";
    msgEl.classList.remove("hidden");
  }
});

/* ============================================================
   USERS ADMIN
   ============================================================ */

async function showUsers() {
  activatePage("page-users");
  await loadUsers();
}

async function loadUsers() {
  try {
    state.users = await api("GET", "/users") ?? [];
    renderUsers();
  } catch (err) {
    toast("Failed to load users: " + err.message);
  }
}

function renderUsers() {
  const tbody = document.getElementById("users-tbody");
  tbody.innerHTML = "";
  state.users.forEach(u => {
    const tr = document.createElement("tr");
    const isMe = u.email === state.user.email;
    tr.innerHTML = `
      <td>${esc(u.name)}${isMe ? ' <span style="font-size:11px;color:var(--muted)">(you)</span>' : ""}</td>
      <td>${esc(u.email)}</td>
      <td><span class="role-badge role-${u.role}">${u.role}</span></td>
      <td>${(u.languages || []).map(l => `<span class="lang-badge" style="font-size:10px;padding:1px 6px">${l}</span>`).join(" ")}</td>
      <td style="text-align:right;white-space:nowrap">
        <button class="btn btn-ghost btn-sm" onclick="openEditModal('${esc(u.email)}')">Edit</button>
        ${isMe ? "" : `<button class="btn btn-ghost btn-sm" style="color:var(--danger)" onclick="confirmDelete('${esc(u.email)}')">Delete</button>`}
      </td>`;
    tbody.appendChild(tr);
  });
}

/* ---- Modal ---- */

document.getElementById("btn-invite").addEventListener("click", () => openCreateModal());
document.getElementById("modal-cancel").addEventListener("click", closeModal);
document.getElementById("user-modal").addEventListener("click", e => {
  if (e.target === document.getElementById("user-modal")) closeModal();
});

function openCreateModal() {
  state.editingEmail = null;
  document.getElementById("modal-title").textContent = "Invite user";
  document.getElementById("m-name").value = "";
  document.getElementById("m-email").value = "";
  document.getElementById("m-email").disabled = false;
  document.getElementById("m-role").value = "proofreader";
  document.getElementById("m-pw-label").textContent = "Password";
  document.getElementById("m-pw-wrap").classList.remove("hidden");
  document.getElementById("m-password").value = "";
  document.querySelectorAll("#m-langs input").forEach(cb => cb.checked = false);
  document.getElementById("modal-error").classList.add("hidden");
  document.getElementById("user-modal").classList.remove("hidden");
}

function openEditModal(email) {
  const u = state.users.find(x => x.email === email);
  if (!u) return;
  state.editingEmail = email;
  document.getElementById("modal-title").textContent = "Edit user";
  document.getElementById("m-name").value = u.name;
  document.getElementById("m-email").value = u.email;
  document.getElementById("m-email").disabled = true;
  document.getElementById("m-role").value = u.role;
  document.getElementById("m-pw-label").textContent = "New password (leave blank to keep)";
  document.getElementById("m-pw-wrap").classList.remove("hidden");
  document.getElementById("m-password").value = "";
  document.querySelectorAll("#m-langs input").forEach(cb => {
    cb.checked = (u.languages || []).includes(cb.value);
  });
  document.getElementById("modal-error").classList.add("hidden");
  document.getElementById("user-modal").classList.remove("hidden");
}

function closeModal() {
  document.getElementById("user-modal").classList.add("hidden");
}

document.getElementById("modal-save").addEventListener("click", async () => {
  const name = document.getElementById("m-name").value.trim();
  const email = document.getElementById("m-email").value.trim();
  const role = document.getElementById("m-role").value;
  const password = document.getElementById("m-password").value;
  const languages = Array.from(document.querySelectorAll("#m-langs input:checked")).map(cb => cb.value);
  const errEl = document.getElementById("modal-error");
  errEl.classList.add("hidden");

  if (!name || !email) { errEl.textContent = "Name and email are required."; errEl.classList.remove("hidden"); return; }
  if (languages.length === 0) { errEl.textContent = "Select at least one language."; errEl.classList.remove("hidden"); return; }
  if (role === "proofreader" && languages.length > 1) {
    errEl.textContent = "Proofreaders can only have one language.";
    errEl.classList.remove("hidden");
    return;
  }

  try {
    if (state.editingEmail) {
      const updates = { name, role, languages };
      if (password) updates.password = password;
      await api("PUT", `/users/${encodeURIComponent(state.editingEmail)}`, updates);
    } else {
      if (!password) { errEl.textContent = "Password is required."; errEl.classList.remove("hidden"); return; }
      await api("POST", "/users", { email, name, password, languages, role });
    }
    closeModal();
    await loadUsers();
    toast(state.editingEmail ? "User updated" : "User created");
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove("hidden");
  }
});

async function confirmDelete(email) {
  if (!confirm(`Delete user ${email}? This cannot be undone.`)) return;
  try {
    await api("DELETE", `/users/${encodeURIComponent(email)}`);
    await loadUsers();
    toast("User deleted");
  } catch (err) {
    toast("Error: " + err.message);
  }
}

/* ============================================================
   Bootstrap
   ============================================================ */
(async () => {
  try {
    const user = await api("GET", "/me");
    if (user) {
      state.user = user;
      document.getElementById("page-login").classList.add("hidden");
      document.getElementById("nav").classList.remove("hidden");
      document.getElementById("page-app").classList.remove("hidden");
      updateNav();
      route();
    } else {
      showLogin();
    }
  } catch {
    showLogin();
  }
})();
