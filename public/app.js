// Kid Factory UI: plain JS, hash routes (#/ library, #/new, #/key, #/settings, #/ep/<id>, #/ep/<id>/video,
// #/ep/<id>/package).
const $ = (sel, root = document) => root.querySelector(sel);
const app = $("#app");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const pad = (n) => String(n).padStart(2, "0");
const MOODS = { bright: "สดใส", calm: "นุ่มนวล", playful: "สนุกสนาน" };
const NET_ERROR = "ติดต่อโปรแกรมไม่ได้ ลองปิดแล้วเปิดโปรแกรมใหม่";

// ---------- helpers ----------
async function api(method, url, body) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: method === "GET" ? {} : { "content-type": "application/json" },
      body: method === "GET" || method === "DELETE" ? undefined : JSON.stringify(body ?? {}),
    });
  } catch {
    throw new Error(NET_ERROR);
  }
  let json = null;
  try { json = await res.json(); } catch {}
  // limit: ChatGPT's plan limit was reached, so "use Gemini instead" can help
  if (!res.ok) throw Object.assign(new Error(json?.error || "เกิดข้อผิดพลาด ลองใหม่"), { limit: Boolean(json?.limit) });
  return json;
}

// retry: run the same work with Gemini; offered when the error is ChatGPT's plan limit
function showError(e, icon = "⚠", retry = null) {
  $("#msgIcon").textContent = icon;
  $("#msgText").textContent = e?.message || String(e);
  const alt = $("#msgAlt");
  alt.hidden = !(retry && e?.limit);
  alt.onclick = () => { $("#msg").hidden = true; retry(); };
  $("#msg").hidden = false;
  $("#msgOk").focus();
}
$("#msgOk").onclick = () => { $("#msg").hidden = true; };

function busy(text, sub = "") {
  $("#busyText").textContent = text;
  $("#busySub").textContent = sub;
  $("#busy").hidden = false;
}
const idle = () => { $("#busy").hidden = true; };

const epLabel = (n) => (n ? `EP${n}` : "EP–");
const mmss = (sec) => {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${pad(s % 60)}`;
};
const thaiDate = (iso) => {
  try { return new Date(iso).toLocaleDateString("th-TH", { day: "numeric", month: "short", year: "2-digit" }); } catch { return ""; }
};
const statusClass = (s) => (s === "วิดีโอเสร็จ" ? "done" : s === "พร้อมประกอบ" ? "ready" : s === "ต้องประกอบใหม่" ? "redo" : "");
const trackName = (t) => {
  const n = String(t.title || "").match(/(\d+)\s*$/);
  return `${MOODS[t.mood] || t.mood}${n ? ` #${n[1]}` : ""}`;
};
const mediaUrl = (id, file, v) => `/media/${id}/${String(file).split("/").map(encodeURIComponent).join("/")}${v ? `?v=${v}` : ""}`;

// ---------- app state ----------
let state = null;          // /api/state
let ideasFound = null;     // latest 3 ideas
let ideaPicked = null;     // index into ideasFound
let topicText = "";
let poll = null;           // {id, timer}
let routeToken = 0;        // a slow screen load that is no longer the current route is dropped

function stopPoll() {
  if (poll) clearInterval(poll.timer);
  poll = null;
}

async function route() {
  const token = ++routeToken;
  stopPoll();
  stopMusic();
  stopSettingsPolls();
  idle();
  app.classList.remove("wide");
  let s;
  try {
    s = await api("GET", "/api/state");
  } catch (e) {
    if (token !== routeToken) return;
    app.innerHTML = "";
    return showError(e);
  }
  if (token !== routeToken) return;
  state = s;
  $("#fakeBadge").hidden = !state.fake;
  $("#setLink").hidden = !state.hasKey;
  $("#ver").textContent = `v${state.version}`;
  if (!updateChecked) {
    updateChecked = true;
    $("#updLink").hidden = false;
    if (state.updated) {
      showError(new Error(state.updated.ok
        ? `อัปเดตเป็นเวอร์ชัน ${state.updated.to} แล้ว`
        : `อัปเดตไม่สำเร็จ ยังใช้เวอร์ชันเดิม (${state.updated.from}) ได้ตามปกติ`), state.updated.ok ? "✓" : "⚠");
    }
    checkUpdate(true);
  }
  const h = location.hash || "#/";
  let m;
  if (!state.hasKey || h === "#/key") return keyScreen();
  if (h === "#/settings") return settingsScreen();
  if ((m = h.match(/^#\/ep\/([^/]+)\/video$/))) return episodeScreen(m[1], "video", token);
  if ((m = h.match(/^#\/ep\/([^/]+)\/package$/))) return episodeScreen(m[1], "package", token);
  if ((m = h.match(/^#\/ep\/([^/]+)$/))) return episodeScreen(m[1], "room", token);
  if (h === "#/new") return newScreen();
  return homeScreen();
}
window.addEventListener("hashchange", route);

// ---------- self-update ----------
let updateChecked = false;

async function checkUpdate(silent) {
  let u;
  try {
    u = await api("GET", "/api/update");
  } catch (e) {
    if (!silent) showError(e);
    return;
  }
  const banner = $("#updBanner");
  if (!u.available || !u.canUpdate) {
    banner.hidden = true;
    if (!silent) showError(new Error(u.available ? `มีเวอร์ชันใหม่ ${u.latest} แต่โปรแกรมชุดนี้อัปเดตเองไม่ได้` : `เป็นเวอร์ชันล่าสุดแล้ว (${u.current})`), u.available ? "⚠" : "✓");
    return;
  }
  banner.innerHTML = `
    <div class="upd-row">
      <b>มีเวอร์ชันใหม่ ${esc(u.latest)}</b>
      <button id="updNow" class="btn">อัปเดตเลย</button>
    </div>
    ${u.notes.length ? `<ul>${u.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : ""}`;
  banner.hidden = false;
  $("#updNow").onclick = doUpdate;
}

async function doUpdate() {
  busy("กำลังอัปเดต…", "ดาวน์โหลดแล้วโปรแกรมจะเปิดใหม่เอง");
  let r;
  try {
    r = await api("POST", "/api/update", {});
  } catch (e) {
    idle();
    return showError(e);
  }
  if (!r.restarting) {
    idle();
    $("#updBanner").hidden = true;
    return showError(new Error(`เป็นเวอร์ชันล่าสุดแล้ว (${r.current})`), "✓");
  }
  busy("กำลังเปิดโปรแกรมใหม่…", "รอสักครู่");
  // the window may close and reopen by itself; if it stays, reload once any version answers again
  // (the new one, or the old one after a rollback: the reloaded page then says what happened)
  for (let i = 0; i < 80; i++) {
    await new Promise((res) => setTimeout(res, 3000));
    try {
      if ((await fetch("/api/version")).ok) break;
    } catch {}
  }
  location.reload();
}
$("#updLink").onclick = (e) => { e.preventDefault(); checkUpdate(false); };

// ---------- 0 · key ----------
function keyScreen() {
  const first = !state.hasKey;
  app.innerHTML = `
    <div class="card" style="max-width:520px;margin:30px auto">
      <div class="step">${first ? "เปิดครั้งแรก" : "เปลี่ยนคีย์"}</div>
      <h1>${first ? "ยินดีต้อนรับสู่ ปิ่นโตเก่งขึ้นทุกวัน" : "เปลี่ยนคีย์ Gemini"}</h1>
      <p class="muted">วางคีย์ Gemini ครั้งเดียว ใช้อ่านเสียงเล่าเรื่อง โปรแกรมจะจำไว้ในเครื่องนี้เท่านั้น<br>
      ขอคีย์ได้ที่ Google AI Studio → “Get API key”</p>
      <input id="key" type="password" placeholder="วางคีย์ Gemini ที่นี่" autocomplete="off" spellcheck="false">
      <div class="row" style="margin-top:12px">
        <button id="saveKey" class="btn">บันทึกคีย์</button>
        ${first ? "" : `<a class="btn g" href="#/settings">ยกเลิก</a>`}
      </div>
    </div>`;
  const input = $("#key");
  input.focus();
  const save = async () => {
    const key = input.value.trim();
    if (!key) return showError(new Error("วางคีย์ Gemini ก่อนนะ"));
    try {
      await api("POST", "/api/key", { key });
      input.value = "";
      if (location.hash === "#/") route(); else location.hash = "#/";
    } catch (e) { showError(e); }
  };
  $("#saveKey").onclick = save;
  input.onkeydown = (e) => { if (e.key === "Enter") save(); };
}

// ---------- home · library ----------
function homeScreen() {
  app.innerHTML = `
    <div class="home-head">
      <h1>คลังตอน</h1>
      <span class="grow"></span>
      <a class="btn big" href="#/new">+ สร้างเรื่องใหม่</a>
    </div>
    <div class="card" id="library"></div>`;
  drawLibrary();
}

// ---------- new story · 1–2 ----------
function newScreen() {
  app.innerHTML = `
    <a class="back" href="#/">← กลับคลังตอน</a>
    <div class="new-col">
      <div class="card">
        <div class="step">1 · พิมพ์หัวข้อ</div>
        <div class="topic-row">
          <input id="topic" type="text" placeholder="เช่น สอนเด็กแปรงฟัน" value="${esc(topicText)}">
          <button id="think" class="btn">คิดเรื่องให้หน่อย</button>
        </div>
        <div id="ideas"></div>
      </div>
      <div class="card"><h2>เรื่องที่เก็บไว้</h2><div id="savedList"></div></div>
    </div>`;

  const topic = $("#topic");
  const think = async (provider) => {
    topicText = topic.value.trim();
    if (!topicText) return showError(new Error("พิมพ์หัวข้อก่อนนะ"));
    busy("กำลังคิดเรื่อง…", "รอสักครู่");
    try {
      ideasFound = (await api("POST", "/api/ideas", { topic: topicText, provider })).ideas;
      ideaPicked = null;
      drawIdeas();
    } catch (e) { showError(e, "⚠", () => think("gemini")); } finally { idle(); }
  };
  $("#think").onclick = () => think();
  topic.onkeydown = (e) => { if (e.key === "Enter") think(); };
  if (!ideasFound) topic.focus();

  drawIdeas();
  drawSaved();
}

function drawIdeas() {
  const box = $("#ideas");
  if (!box) return;
  if (!ideasFound) { box.innerHTML = ""; return; }
  const others = ideasFound.length - 1;
  box.innerHTML = `
    <div class="step" style="margin-top:14px">2 · เลือก 1 เรื่อง</div>
    ${ideasFound.map((i, n) => `
      <button class="opt ${n === ideaPicked ? "sel" : ""}" data-n="${n}"><b>${esc(i.title)}</b>${esc(i.pitch)}</button>`).join("")}
    ${ideaPicked === null ? "" : `
      <div class="ask row">
        <span style="flex:1">เก็บอีก ${others} เรื่องไว้ทำทีหลังไหม?</span>
        <button id="keepYes" class="btn">เก็บ</button>
        <button id="keepNo" class="btn g">ไม่เก็บ</button>
      </div>`}`;
  box.querySelectorAll(".opt").forEach((b) => {
    b.onclick = () => { ideaPicked = Number(b.dataset.n); drawIdeas(); };
  });
  if (ideaPicked !== null) {
    const idea = ideasFound[ideaPicked];
    const rest = ideasFound.filter((_, n) => n !== ideaPicked);
    $("#keepYes").onclick = () => writeStory(idea, rest);
    $("#keepNo").onclick = () => writeStory(idea, []);
    $("#keepYes").scrollIntoView({ block: "nearest" });
  }
}

async function writeStory(idea, keep, provider) {
  busy("กำลังเขียนเรื่อง… ใช้เวลาประมาณ 1–3 นาที", "อย่าเพิ่งปิดหน้าต่างนะ");
  try {
    const { id } = await api("POST", "/api/episodes", { idea, keep, provider });
    ideasFound = null;
    ideaPicked = null;
    topicText = "";
    location.hash = `#/ep/${id}`;
  } catch (e) {
    idle();
    showError(e, "⚠", () => writeStory(idea, keep, "gemini"));
    // kept ideas were saved even though the story failed
    try { state = await api("GET", "/api/state"); drawSaved(); } catch {}
  }
}

function drawSaved() {
  const box = $("#savedList");
  if (!box) return;
  const list = state.savedIdeas || [];
  if (!list.length) { box.innerHTML = `<p class="muted">ยังไม่มีเรื่องที่เก็บไว้</p>`; return; }
  box.innerHTML = list.map((i, n) => `
    <div class="saved">
      <div><b>${esc(i.title)}</b><small>${esc(i.pitch)}</small></div>
      <button class="btn small" data-n="${n}">เริ่มทำ</button>
    </div>`).join("");
  box.querySelectorAll("button").forEach((b) => {
    b.onclick = () => writeStory(list[Number(b.dataset.n)], []);
  });
}

function drawLibrary() {
  const box = $("#library");
  const list = state.episodes || [];
  if (!list.length) {
    box.innerHTML = `<div class="empty"><p>ยังไม่มีตอนเลย กด + สร้างเรื่องใหม่ เพื่อเริ่มตอนแรก</p><a class="btn big" href="#/new">+ สร้างเรื่องใหม่</a></div>`;
    return;
  }
  box.innerHTML = `
    <table class="lib">
      <thead><tr><th>ตอน</th><th>ชื่อเรื่อง</th><th>สถานะ</th><th>วันที่</th><th></th></tr></thead>
      <tbody>${list.map((e, n) => `
        <tr>
          <td class="ep">${epLabel(e.number)}</td>
          <td class="title">${esc(e.title)}</td>
          <td><span class="status ${statusClass(e.status)}">${esc(e.status)}</span></td>
          <td class="date">${esc(thaiDate(e.createdAt))}</td>
          <td class="act">
            <a class="btn small" href="#/ep/${encodeURIComponent(e.id)}">เปิด</a>
            <button class="btn small danger" data-n="${n}">ลบ</button>
          </td>
        </tr>`).join("")}
      </tbody>
    </table>`;
  box.querySelectorAll("button.danger").forEach((b) => {
    b.onclick = async () => {
      const e = list[Number(b.dataset.n)];
      const name = e.number ? `ตอน EP${e.number} '${e.title}'` : `ตอน '${e.title}'`;
      if (!confirm(`ลบ${name} ถาวร? กู้คืนไม่ได้`)) return;
      try {
        await api("DELETE", `/api/episodes/${encodeURIComponent(e.id)}`);
        state = await api("GET", "/api/state");
        drawLibrary();
      } catch (err) { showError(err); }
    };
  });
}

// ---------- 3–4 · episode ----------
let ep = null;        // latest /api/episodes/:id
let job = {};         // latest /job
let sel = 1;          // selected page (1-based)
let ver = {};         // cache-busters per media file
let wasRunning = {};

async function episodeScreen(id, tab, token) {
  let e1, j1;
  try {
    e1 = await api("GET", `/api/episodes/${encodeURIComponent(id)}`);
    j1 = await api("GET", `/api/episodes/${encodeURIComponent(id)}/job`);
  } catch (e) {
    if (token !== routeToken) return;
    showError(e);
    location.hash = "#/";
    return;
  }
  if (token !== routeToken) return; // the user already went somewhere else
  ep = e1;
  job = j1;
  if (!ep.story.pages[sel - 1] || app.dataset.ep !== id) sel = 1;
  app.dataset.ep = id;
  ver = {};
  wasRunning = {};
  for (const k of JOB_KINDS) if (job[k]?.running) wasRunning[k] = true;

  app.classList.add("wide");
  curTab = tab;
  app.innerHTML = `
    <div class="ep-layout">
      <aside id="side" class="side"></aside>
      <div class="card" id="screen"></div>
    </div>`;
  drawSide();
  if (tab === "room") roomShell(); else if (tab === "video") videoShell(); else packageShell();
  if (anyRunning()) startPoll();
}

let curTab = "room";

// left menu inside an episode: where am I, go back / forward any time
function drawSide() {
  const box = $("#side");
  if (!box || !ep) return;
  const id = encodeURIComponent(ep.id);
  const pages = ep.story.pages;
  const imgs = pages.filter((p) => p.image.state === "done").length;
  const voices = pages.length - ep.staleVoices.length;
  const roomDone = imgs === pages.length && voices === pages.length;
  const rendering = Boolean(job.render?.running);
  const status = ep.status ?? "";
  const videoSub = rendering ? "กำลังประกอบ…" : status === "วิดีโอเสร็จ" ? "วิดีโอเสร็จ ✓" : status === "ต้องประกอบใหม่" ? "ต้องประกอบใหม่" : "ยังไม่ได้ประกอบ";
  const videoDone = !rendering && status === "วิดีโอเสร็จ";
  const pkg = ep.package;
  const pkgDone = Boolean(pkg?.title && pkg?.cover);
  const steps = [
    { tab: "room", href: `#/ep/${id}`, name: "ห้องทำงาน", sub: `ภาพ ${imgs}/${pages.length} · เสียง ${voices}/${pages.length}`, done: roomDone },
    { tab: "video", href: `#/ep/${id}/video`, name: "ประกอบวิดีโอ", sub: videoSub, done: videoDone },
    { tab: "package", href: `#/ep/${id}/package`, name: "แพ็กเกจ", sub: job.package?.running ? "กำลังทำ…" : pkgDone ? "ปก ชื่อ คำอธิบาย ✓" : "ปก ชื่อ คำอธิบาย แฮชแท็ก", done: pkgDone },
  ];
  const at = Math.max(0, steps.findIndex((st) => st.tab === curTab));
  const prev = at === 0 ? "#/" : steps[at - 1].href;
  const next = at < steps.length - 1 ? steps[at + 1].href : "#/";
  box.innerHTML = `
    <a class="back" href="#/">← คลังตอน</a>
    <div class="side-ep"><span class="badge-ep">${epLabel(ep.number)}</span><div class="side-title">${esc(ep.story.title)}</div></div>
    <nav class="steps">${steps.map((st, i) => `
      <a class="stp ${i === at ? "on" : ""} ${st.done ? "done" : ""}" href="${st.href}" ${i === at ? 'aria-current="step"' : ""}>
        <span class="num">${st.done ? "✓" : i + 1}</span>
        <span><b>${st.name}</b><small>${esc(st.sub)}</small></span>
      </a>`).join("")}
    </nav>
    <div class="side-nav">
      <a class="btn g small" href="${prev}">← ย้อนกลับ</a>
      <a class="btn small" href="${next}">${at < steps.length - 1 ? "ไปต่อ →" : "กลับคลังตอน"}</a>
    </div>`;
}

const JOB_KINDS = ["images", "voices", "render", "package"];
const anyRunning = () => JOB_KINDS.some((k) => job[k]?.running);
let lastBody = {}; // the last request per job kind, repeated with Gemini after a ChatGPT limit

function startPoll() {
  if (poll) return;
  const id = ep.id;
  poll = {
    id,
    timer: setInterval(async () => {
      try {
        const [j, e] = await Promise.all([
          api("GET", `/api/episodes/${encodeURIComponent(id)}/job`),
          api("GET", `/api/episodes/${encodeURIComponent(id)}`),
        ]);
        if (!poll || poll.id !== id) return;
        job = j;
        bumpVersions(ep, e);
        ep = e;
        refresh();
        for (const k of JOB_KINDS) {
          if (wasRunning[k] && !job[k]?.running) {
            wasRunning[k] = false;
            if (job[k]?.error) {
              const body = lastBody[k];
              showError(Object.assign(new Error(job[k].error), { limit: job[k].limit }), "⚠",
                body ? () => startJob(k, { ...body, provider: "gemini" }) : null);
            }
          }
        }
        if (!anyRunning()) stopPoll();
      } catch {
        // a missed tick is fine; the next one retries
      }
    }, 1000),
  };
}

// a page that just turned "done" gets a fresh URL so the browser drops its cached copy
function bumpVersions(before, after) {
  after.story.pages.forEach((p, i) => {
    const b = before?.story.pages[i];
    for (const k of ["image", "voice"]) {
      if (p[k]?.state === "done" && b?.[k]?.state !== "done") ver[`${k}${i + 1}`] = Date.now();
    }
  });
}

async function startJob(kind, body = {}) {
  try {
    await api("POST", `/api/episodes/${encodeURIComponent(ep.id)}/${kind}`, body);
    lastBody[kind] = body;
    job[kind] = { running: true, progress: 0, pages: body.pages };
    wasRunning[kind] = true;
    // show "working" right away
    try { const e = await api("GET", `/api/episodes/${encodeURIComponent(ep.id)}`); bumpVersions(ep, e); ep = e; } catch {}
    refresh();
    startPoll();
  } catch (e) { showError(e); }
}

function refresh() {
  drawSide();
  if ($("#roomPages")) roomUpdate();
  if ($("#videoBox")) videoUpdate();
  if ($("#pkgBox")) packageUpdate();
}

// page status: ✓ picture and voice done, ⏳ working, ⚠ error, else what is done so far (🖼 picture, 🔊 voice)
function pageMark(p, n) {
  const voice = !ep.staleVoices.includes(n);
  const image = p.image.state === "done";
  if (p.image.state === "working" || p.voice.state === "working") return ["⏳", "wait", "กำลังทำ"];
  if (p.image.state === "error" || p.voice.state === "error") return ["⚠", "warn", "มีปัญหา กดดูหน้านี้"];
  if (image && voice) return ["✓", "ok", "ภาพและเสียงเสร็จแล้ว"];
  if (image) return ["🖼", "wait", "มีภาพแล้ว ยังไม่มีเสียง"];
  if (voice) return ["🔊", "wait", "มีเสียงแล้ว ยังไม่มีภาพ"];
  return ["", "", "ยังไม่ได้เจน"];
}

function infoLine() {
  const pages = ep.story.pages.length;
  const len = `${ep.lengthReal ? "ยาว" : "ประมาณ"} ${mmss(ep.seconds)} นาที`;
  const baht = Math.max(1, Math.round(ep.cost.thb));
  return `${pages} หน้า · ${len} <span class="cost">· ค่าใช้จ่ายประมาณ ${baht} บาท</span>`;
}

function roomShell() {
  $("#screen").innerHTML = `
    <div class="step">1 · ดูบท แก้ได้ แล้วเจน</div>
    <div class="row">
      <button id="allImages" class="btn">เจนภาพทั้งหมด</button>
      <button id="allVoices" class="btn">เจนเสียงทั้งหมด</button>
      <span id="info" class="info"></span>
    </div>
    <div id="jobs" class="jobs"></div>
    <div class="room">
      <div id="roomPages" class="pages"></div>
      <div>
        <div id="pic" class="pic"></div>
        <div id="takes" class="takes"></div>
        <div class="fix-row">
          <input id="fix" type="text" maxlength="300" placeholder="ภาพต้องแก้อะไร เช่น มือพัง, แมวหายไป (ไม่ใส่ = วาดใหม่ทั้งภาพ)">
          <button id="oneImage" class="btn g">↻ ภาพใหม่</button>
        </div>
        <div class="narr-label"><span id="pageTitle"></span><span id="savedNote" class="saved-note"></span></div>
        <textarea id="narr"></textarea>
        <div class="row" style="margin-top:8px">
          <button id="play" class="btn g">▶ ฟังเสียง</button>
          <button id="oneVoice" class="btn g">↻ เสียงใหม่</button>
        </div>
        <div id="pageState" class="page-state"></div>
      </div>
    </div>`;
  $("#allImages").onclick = () => startJob("images");
  $("#allVoices").onclick = async () => { if (await saveNarration() !== false) startJob("voices"); };
  $("#oneImage").onclick = () => {
    const fix = $("#fix");
    startJob("images", { pages: [sel], feedback: fix.value.trim() });
    fix.value = "";
  };
  $("#fix").onkeydown = (e) => { if (e.key === "Enter" && !$("#oneImage").disabled) $("#oneImage").click(); };
  $("#oneVoice").onclick = async () => { if (await saveNarration() !== false) startJob("voices", { pages: [sel] }); };
  $("#play").onclick = playVoice;
  const narr = $("#narr");
  narr.onblur = saveNarration;
  narr.oninput = () => { $("#savedNote").textContent = ""; };
  loadPage();
  roomUpdate();
}

let player = null;
function playVoice() {
  const p = ep.story.pages[sel - 1];
  if (player) { player.pause(); player = null; }
  if (p.voice.state !== "done") return;
  player = new Audio(mediaUrl(ep.id, p.voice.file, ver[`voice${sel}`]));
  player.play().catch(() => showError(new Error("เล่นเสียงไม่ได้ ลองกด ↻ เสียงใหม่")));
}

async function saveNarration() {
  const narr = $("#narr");
  if (!narr) return;
  const n = sel;
  const text = narr.value.trim();
  if (text === ep.story.pages[n - 1].narration) return;
  try {
    ep = await api("PATCH", `/api/episodes/${encodeURIComponent(ep.id)}/pages/${n}`, { narration: text });
    if (sel === n) $("#savedNote").textContent = "บันทึกแล้ว ✓ อย่าลืมกด ↻ เสียงใหม่";
    roomUpdate();
  } catch (e) {
    // a note keeps the typed text on screen (the next poll would otherwise put the old text back)
    if (sel === n) $("#savedNote").textContent = "⚠ ยังไม่ได้บันทึก";
    showError(e);
    return false; // callers stop: no voice from the old text, no page switch that would drop the typed text
  }
}

function loadPage() {
  $("#narr").value = ep.story.pages[sel - 1].narration;
  $("#savedNote").textContent = "";
  $("#pageTitle").textContent = `หน้า ${sel} · คำเล่า`;
}

function roomUpdate() {
  drawSide();
  const pages = ep.story.pages;
  $("#info").innerHTML = infoLine();
  const imgRun = Boolean(job.images?.running), voiceRun = Boolean(job.voices?.running), renderRun = Boolean(job.render?.running);
  const imagesLeft = pages.some((p) => p.image.state !== "done");
  const voicesLeft = ep.staleVoices.length > 0;
  const all = $("#allImages"), allV = $("#allVoices");
  all.disabled = imgRun || renderRun || !imagesLeft;
  all.textContent = imgRun ? "กำลังเจนภาพ…" : imagesLeft ? "เจนภาพทั้งหมด" : "✓ ภาพครบแล้ว";
  allV.disabled = voiceRun || renderRun || !voicesLeft;
  allV.textContent = voiceRun ? "กำลังเจนเสียง…" : voicesLeft ? "เจนเสียงทั้งหมด" : "✓ เสียงครบแล้ว";

  // jobs
  const bars = [];
  for (const [k, label] of [["images", "กำลังเจนภาพ"], ["voices", "กำลังเจนเสียง"]]) {
    const j = job[k];
    if (!j?.running) continue;
    const total = j.pages?.length || 0;
    const done = Math.round((j.progress || 0) * total);
    const what = j.sheet ? `กำลังวาดแผ่น “${esc(j.sheet)}” ให้คลังก่อน` : `${label}… ${total ? `${done}/${total} หน้า` : ""}`;
    bars.push(`<div class="job">${what}<div class="prog"><i style="width:${Math.round((j.progress || 0) * 100)}%"></i></div></div>`);
  }
  $("#jobs").innerHTML = bars.join("");

  // page list
  const list = $("#roomPages");
  list.innerHTML = pages.map((p, i) => {
    const [mark, cls, tip] = pageMark(p, i + 1);
    return `<button class="pg ${i + 1 === sel ? "on" : ""}" data-n="${i + 1}" title="${tip}">หน้า ${i + 1}<span class="st ${cls}">${mark}</span></button>`;
  }).join("");
  list.querySelectorAll(".pg").forEach((b) => {
    b.onclick = async () => {
      if (await saveNarration() === false) return;
      sel = Number(b.dataset.n);
      loadPage();
      roomUpdate();
    };
  });

  // selected page
  const p = pages[sel - 1];
  const pic = $("#pic");
  const want = p.image.state === "done" ? mediaUrl(ep.id, p.image.file, ver[`image${sel}`]) : null;
  if (want) {
    const img = pic.querySelector("img");
    if (!img || img.getAttribute("src") !== want) pic.innerHTML = `<img alt="ภาพหน้า ${sel}" src="${esc(want)}">`;
  } else if (p.image.state === "working") pic.innerHTML = `<span>⏳ กำลังวาดภาพ…</span>`;
  else if (p.image.state === "error") pic.innerHTML = `<span class="warn">⚠ ${esc(p.image.error)}</span>`;
  else pic.innerHTML = `<span>ยังไม่มีภาพ</span>`;

  const narr = $("#narr");
  if (document.activeElement !== narr && narr.value.trim() !== p.narration && !$("#savedNote").textContent) narr.value = p.narration;

  const stale = ep.staleVoices.includes(sel);
  $("#oneImage").disabled = imgRun || renderRun;
  $("#oneVoice").disabled = voiceRun || renderRun;
  $("#play").disabled = p.voice.state !== "done";
  const voiceText = p.voice.state === "working" ? "⏳ กำลังอัดเสียง…"
    : p.voice.state === "error" ? `<span class="warn">⚠ ${esc(p.voice.error)}</span>`
    : p.voice.state === "done" && stale ? `<span class="warn">คำเล่าเปลี่ยนแล้ว กด ↻ เสียงใหม่</span>`
    : p.voice.state === "done" ? `✓ เสียง ${p.voice.seconds?.toFixed(1)} วินาที` : "ยังไม่มีเสียง";
  const imageText = p.image.state === "done" ? `✓ ภาพ${p.image.feedback ? ` (แก้: ${esc(p.image.feedback)})` : ""}` : p.image.state === "working" ? "⏳ ภาพ" : p.image.state === "error" ? `<span class="warn">⚠ ภาพ</span>` : "ยังไม่มีภาพ";
  $("#pageState").innerHTML = `${imageText} · ${voiceText}`;
  drawTakes(p, imgRun || renderRun, voiceRun || renderRun);
}

// every image and voice made for this page; click a number to use that one (a voice also plays)
function drawTakes(p, imgBusy, voiceBusy) {
  const row = (kind, label, takes, busyNow) => {
    const cur = p[kind].state === "done" ? p[kind].file : null;
    if (!takes.length || (takes.length === 1 && takes[0].file === cur)) return ""; // nothing else to pick
    return `<span>${label}${takes.map((t, i) => {
      const old = kind === "voice" && t.forText !== p.narration ? ` title="อ่านจากคำเล่าเดิม: ${esc(t.forText)}"` : "";
      return `<button class="take ${t.file === cur ? "on" : ""}" data-kind="${kind}" data-take="${i + 1}"${old} ${busyNow ? "disabled" : ""}>${i + 1}</button>`;
    }).join("")}</span>`;
  };
  const box = $("#takes");
  box.innerHTML = row("image", "ภาพ", p.imageTakes ?? [], imgBusy) + row("voice", "เสียง", p.voiceTakes ?? [], voiceBusy);
  box.querySelectorAll(".take").forEach((b) => { b.onclick = () => pickTake(b.dataset.kind, Number(b.dataset.take)); });
}

async function pickTake(kind, take) {
  if (kind === "voice" && await saveNarration() === false) return;
  const n = sel;
  try {
    ep = await api("POST", `/api/episodes/${encodeURIComponent(ep.id)}/pages/${n}/pick`, { kind, take });
  } catch (e) { return showError(e); }
  if (sel !== n) return roomUpdate();
  if (kind === "voice") {
    loadPage(); // the voice brings back the text it was read from
    playVoice();
  }
  roomUpdate();
}

// ---------- 4 · assemble ----------
let tracks = null;
const LOOKS = [
  ["wood", "โต๊ะไม้สีน้ำตาล"], ["pink", "พื้นชมพูพาสเทล"], ["blue", "พื้นฟ้าพาสเทล"],
  ["cream", "พื้นสีครีม"], ["mint", "พื้นเขียวมินต์"], ["full", "เต็มจอ ไม่มีขอบ"],
];

async function videoShell() {
  $("#screen").innerHTML = `
    <div class="step">2 · ประกอบเป็นวิดีโอ</div>
    <div class="music-row">
      <span>เพลงประกอบ:</span>
      <select id="music"></select>
      <button id="listen" class="btn g small">▶ ฟัง</button>
      <span class="muted">(จากคลัง เลือกให้ตามอารมณ์เรื่องแล้ว)</span>
    </div>
    <div class="music-row" style="margin-top:8px">
      <span>แบบหนังสือ:</span>
      <select id="look">${LOOKS.map(([id, name]) => `<option value="${id}" ${id === ep.look ? "selected" : ""}>${name}</option>`).join("")}</select>
    </div>
    <div id="videoBox"></div>
    <div id="playerBox"></div>`;
  const lookSel = $("#look");
  lookSel.onchange = async () => {
    const was = ep.id;
    lookSel.disabled = true; // one change at a time, so replies cannot arrive out of order
    try {
      const next = await api("PATCH", `/api/episodes/${encodeURIComponent(was)}/look`, { look: lookSel.value });
      if (ep?.id !== was) return;
      ep = next;
      videoUpdate();
    } catch (e) {
      lookSel.value = ep.look;
      showError(e);
    } finally {
      lookSel.disabled = false;
    }
  };
  try {
    tracks = (await api("GET", "/api/music")).tracks;
  } catch (e) { tracks = []; showError(e); }
  const musicSel = $("#music");
  if (!musicSel) return;
  const pick = ep.musicId && tracks.some((t) => t.id === ep.musicId) ? ep.musicId : ep.suggestedMusicId;
  musicSel.innerHTML = tracks.length
    ? tracks.map((t) => `<option value="${esc(t.id)}" ${t.id === pick ? "selected" : ""}>${esc(trackName(t))}${t.mood === ep.story.mood ? " · เข้ากับเรื่อง" : ""}</option>`).join("")
    : `<option value="">ไม่มีเพลง (วิดีโอจะมีแต่เสียงเล่า)</option>`;
  const listen = $("#listen");
  listen.disabled = !tracks.length;
  listen.onclick = () => {
    if (musicPlayer) return stopMusic();
    musicPlayer = new Audio(`/music/${encodeURIComponent(musicSel.value)}.mp3`);
    musicPlayer.onended = stopMusic;
    const a = musicPlayer;
    a.play().catch((e) => {
      if (musicPlayer !== a || e?.name === "AbortError") return; // stopped (or replaced) before it started
      stopMusic();
      showError(new Error("เล่นเพลงไม่ได้"));
    });
    listen.textContent = "■ หยุด";
  };
  musicSel.onchange = stopMusic;
  videoUpdate();
}

let musicPlayer = null;
function stopMusic() {
  musicPlayer?.pause();
  musicPlayer = null;
  const b = $("#listen");
  if (b) b.textContent = "▶ ฟัง";
}

function videoUpdate() {
  const box = $("#videoBox");
  if (!box) return;
  const pages = ep.story.pages;
  const noImage = pages.map((p, i) => (p.image.state === "done" ? 0 : i + 1)).filter(Boolean);
  const noVoice = ep.staleVoices;
  const r = job.render;
  const runningNow = Boolean(r?.running);
  const pagesBusy = Boolean(job.images?.running || job.voices?.running);
  const ready = !noImage.length && !noVoice.length;
  const missing = [];
  if (noImage.length) missing.push(`ภาพหน้า ${noImage.join(", ")}`);
  if (noVoice.length) missing.push(`เสียงหน้า ${noVoice.join(", ")}`);
  const fileName = ep.video?.file ? ep.video.file.split("/").pop() : null;
  const status = ep.status ?? "";

  box.innerHTML = `
    ${ready ? "" : `<div class="missing">ยังทำไม่ครบ: ${esc(missing.join(" · "))}
      <a class="link" href="#/ep/${encodeURIComponent(ep.id)}">← กลับไปห้องทำงาน</a></div>`}
    <div style="margin-top:12px" class="row">
      <button id="renderBtn" class="btn" ${!ready || runningNow || pagesBusy ? "disabled" : ""}>${fileName ? "ประกอบวิดีโอใหม่" : "ประกอบวิดีโอ"}</button>
      <span class="muted">${infoLine()}</span>
    </div>
    ${runningNow ? `
      <div class="prog"><i style="width:${Math.round((r.progress || 0) * 100)}%"></i></div>
      <div class="muted">กำลังประกอบวิดีโอ… ${Math.round((r.progress || 0) * 100)}% (ตอนยาว 5 นาทีใช้เวลาราว 3–4 นาที)</div>` : ""}
    ${fileName && !runningNow ? `
      <div style="margin-top:14px" class="ok-line">${status === "ต้องประกอบใหม่" ? `<span class="status redo">มีหน้าเปลี่ยนหลังประกอบ ควรประกอบใหม่</span>` : `✓ เสร็จแล้ว · ${esc(fileName)}`}</div>
      <div style="margin-top:8px" class="row">
        <button id="watch" class="btn">▶ ดูวิดีโอ</button>
        <button id="openFolder" class="btn g">เปิดโฟลเดอร์</button>
      </div>` : ""}`;

  const btn = $("#renderBtn");
  btn.onclick = () => {
    stopMusic();
    const musicId = $("#music")?.value || undefined;
    $("#playerBox").innerHTML = "";
    startJob("render", { musicId });
  };
  const watch = $("#watch");
  if (watch) watch.onclick = () => {
    $("#playerBox").innerHTML = `<video id="player" controls autoplay src="${esc(mediaUrl(ep.id, ep.video.file, ep.video.at))}"></video>`;
    $("#player").scrollIntoView({ block: "nearest" });
  };
  const open = $("#openFolder");
  if (open) open.onclick = async () => {
    try { await api("POST", `/api/episodes/${encodeURIComponent(ep.id)}/open-folder`); } catch (e) { showError(e); }
  };
}

// ---------- 5 · packaging ----------
const PKG_FIELDS = [
  ["title", "ชื่อตอน"],
  ["description", "คำอธิบาย"],
  ["hashtags", "แฮชแท็ก"],
];

function packageShell() {
  $("#screen").innerHTML = `
    <div class="step">3 · แพ็กเกจสำหรับอัปโหลด YouTube</div>
    <div class="row">
      <button id="pkgAll" class="btn">ทำแพ็กเกจ</button>
      <span class="muted">คิดชื่อ คำอธิบาย แฮชแท็ก และวาดปก (แก้เองได้ทุกช่อง)</span>
    </div>
    <div id="pkgBox"></div>
    <div class="pkg">
      <div>
        <div id="cover" class="pic"></div>
        <div id="coverTakes" class="takes"></div>
        <div class="fix-row">
          <input id="coverFix" type="text" maxlength="300" placeholder="ปกต้องแก้อะไร เช่น แมวหายไป (ไม่ใส่ = วาดปกใหม่)">
          <button id="coverNew" class="btn g">↻ ปกใหม่</button>
        </div>
        <div class="row" style="margin-top:8px">
          <button id="pkgFolder" class="btn g small">เปิดโฟลเดอร์</button>
          <span class="muted">ไฟล์ปก JPG อยู่ข้างไฟล์วิดีโอ</span>
        </div>
      </div>
      <div>${PKG_FIELDS.map(([k, label]) => `
        <div class="fld">
          <div class="fld-head"><b>${label}</b><span id="${k}Note" class="saved-note"></span><span class="grow"></span>
            <button class="btn g small" data-copy="${k}">คัดลอก</button>
            <button class="btn g small" data-remake="${k}">↻ ทำใหม่</button>
          </div>
          ${k === "title" ? `<input id="pkg_${k}" type="text">` : `<textarea id="pkg_${k}" rows="${k === "description" ? 5 : 2}"></textarea>`}
        </div>`).join("")}
      </div>
    </div>`;
  $("#pkgAll").onclick = () => startJob("package", { part: "all" });
  $("#coverNew").onclick = () => {
    const fix = $("#coverFix");
    startJob("package", { part: "cover", feedback: fix.value.trim() });
    fix.value = "";
  };
  $("#pkgFolder").onclick = async () => {
    try { await api("POST", `/api/episodes/${encodeURIComponent(ep.id)}/open-folder`); } catch (e) { showError(e); }
  };
  for (const [k] of PKG_FIELDS) {
    const el = $(`#pkg_${k}`);
    el.onblur = () => savePackage(k);
    el.oninput = () => { $(`#${k}Note`).textContent = ""; };
  }
  document.querySelectorAll("[data-remake]").forEach((b) => { b.onclick = () => startJob("package", { part: b.dataset.remake }); });
  document.querySelectorAll("[data-copy]").forEach((b) => { b.onclick = () => copyText(b.dataset.copy); });
  packageUpdate(true);
}

const pkgValue = (k) => {
  const v = ep.package?.[k];
  return k === "hashtags" ? (v ?? []).join(" ") : v ?? "";
};

async function savePackage(k) {
  const el = $(`#pkg_${k}`);
  if (!el || !ep.package || el.value.trim() === pkgValue(k).trim()) return;
  try {
    ep = await api("PATCH", `/api/episodes/${encodeURIComponent(ep.id)}/package`, { [k]: el.value });
    $(`#${k}Note`).textContent = k === "title" && ep.package.coverArt ? "บันทึกแล้ว ✓ ปกเปลี่ยนชื่อตามแล้ว" : "บันทึกแล้ว ✓";
    packageUpdate(true);
  } catch (e) { showError(e); }
}

async function copyText(k) {
  const el = $(`#pkg_${k}`);
  await savePackage(k);
  try {
    await navigator.clipboard.writeText(el.value);
  } catch {
    el.select();
    document.execCommand("copy");
  }
  $(`#${k}Note`).textContent = "คัดลอกแล้ว ✓";
}

function packageUpdate(fill = false) {
  drawSide();
  const box = $("#pkgBox");
  if (!box) return;
  const pkg = ep.package;
  const busyNow = Boolean(job.package?.running);
  const blocked = busyNow || Boolean(job.images?.running);
  box.innerHTML = busyNow ? `<div class="job">${job.package.part === "cover" ? "กำลังวาดปก…" : "กำลังทำแพ็กเกจ…"} (ประมาณ 1–3 นาที)<div class="prog"><i style="width:60%"></i></div></div>`
    : !pkg ? `<div class="missing">ยังไม่มีแพ็กเกจ กด ทำแพ็กเกจ</div>` : "";
  $("#pkgAll").disabled = blocked;
  $("#coverNew").disabled = blocked;
  document.querySelectorAll("[data-remake]").forEach((b) => { b.disabled = blocked || !pkg; });
  document.querySelectorAll("[data-copy]").forEach((b) => { b.disabled = !pkg; });
  for (const [k] of PKG_FIELDS) {
    const el = $(`#pkg_${k}`);
    el.disabled = !pkg || busyNow;
    if (fill || (document.activeElement !== el && !$(`#${k}Note`).textContent)) el.value = pkgValue(k);
  }
  const cover = $("#cover");
  const want = pkg?.cover ? mediaUrl(ep.id, pkg.cover, pkg.coverAt) : null;
  if (want) {
    const img = cover.querySelector("img");
    if (!img || img.getAttribute("src") !== want) cover.innerHTML = `<img alt="ภาพปก" src="${esc(want)}">`;
  } else cover.innerHTML = `<span>${busyNow ? "⏳ กำลังวาดปก…" : "ยังไม่มีปก"}</span>`;
  const takes = pkg?.coverTakes ?? [];
  const tbox = $("#coverTakes");
  tbox.innerHTML = takes.length > 1 ? `<span>ปก${takes.map((t, i) => `<button class="take ${t.file === pkg.coverArt ? "on" : ""}" data-take="${i + 1}" ${blocked ? "disabled" : ""}>${i + 1}</button>`).join("")}</span>` : "";
  tbox.querySelectorAll(".take").forEach((b) => {
    b.onclick = async () => {
      try {
        ep = await api("POST", `/api/episodes/${encodeURIComponent(ep.id)}/package/pick`, { take: Number(b.dataset.take) });
        packageUpdate();
      } catch (e) { showError(e); }
    };
  });
}

// ---------- settings: ChatGPT, Gemini key, characters & places ----------
let gptTimer = null;
let sheetsTimer = null;
let wantLogin = false; // after installing, go straight on to sign-in
let sheets = null;     // latest /api/sheets
let selSheet = null;   // tag of the open sheet, "+" for the add form
let lastSheetBody = null;

function stopSettingsPolls() {
  clearTimeout(gptTimer);
  clearTimeout(sheetsTimer);
  gptTimer = sheetsTimer = null;
}

function settingsScreen() {
  app.innerHTML = `
    <a class="back" href="#/">← กลับคลังตอน</a>
    <div class="card">
      <h2>ChatGPT</h2>
      <p class="muted">คิดเรื่อง เขียนบท และวาดภาพทั้งหมดด้วย ChatGPT Plus (ไม่เสียเงินเพิ่มต่อภาพ)</p>
      <div id="gpt" class="gpt muted">กำลังตรวจ…</div>
    </div>
    <div class="card">
      <h2>คีย์ Gemini</h2>
      <p class="muted">ใช้อ่านเสียงเล่าเรื่อง และใช้วาดแทนเมื่อ ChatGPT ใช้ครบโควตา</p>
      <a class="btn g small" href="#/key">เปลี่ยนคีย์ Gemini</a>
    </div>
    <div class="card">
      <div class="row">
        <h2 style="margin:0">ตัวละครและสถานที่</h2>
        <span class="grow"></span>
        <button id="makeMissing" class="btn small">วาดที่ยังไม่มี</button>
        <button id="addSheet" class="btn g small">+ เพิ่มเอง</button>
      </div>
      <p class="muted">ทุกตอนใช้ชุดนี้ร่วมกัน เรื่องไหนต้องมีคนหรือสถานที่ใหม่ โปรแกรมจะวาดเพิ่มเข้าคลังให้เอง แล้วใช้ซ้ำในตอนต่อไป</p>
      <div id="sheetJob" class="jobs"></div>
      <div class="lib-layout">
        <div id="sheetList" class="sheet-list"></div>
        <div id="sheetPanel"></div>
      </div>
    </div>`;
  $("#makeMissing").onclick = () => sheetJob("/api/sheets/make-missing", {});
  $("#addSheet").onclick = () => { selSheet = "+"; drawSheets(); };
  drawGpt();
  loadSheets();
}

async function drawGpt() {
  clearTimeout(gptTimer);
  const box = $("#gpt");
  if (!box) return;
  let s;
  try { s = await api("GET", "/api/chatgpt"); } catch (e) { box.textContent = e.message; return; }
  if (!$("#gpt")) return;
  let again = false;
  if (s.fake) box.innerHTML = `<span class="dot ok">●</span> โหมดทดลอง (ไม่ใช้ ChatGPT จริง)`;
  else if (!s.installed && s.install?.running) {
    const pct = Math.round((s.install.progress || 0) * 100);
    box.innerHTML = `กำลังติดตั้ง ChatGPT… ${pct}%<div class="prog"><i style="width:${pct}%"></i></div>`;
    again = true;
  } else if (s.signedIn) {
    box.innerHTML = `<span class="dot ok">●</span> เชื่อมต่อแล้ว <b>${esc(s.email || "")}</b>${s.plan ? ` · แผน ${esc(s.plan)}` : ""}`;
  } else {
    const why = s.install?.error || s.error;
    box.innerHTML = `${why ? `<div class="warn">⚠ ${esc(why)}</div>` : ""}
      <span class="dot">●</span> ยังไม่ได้เชื่อมต่อ
      <button id="gptGo" class="btn small">เชื่อมต่อ ChatGPT</button>
      ${s.installed ? "" : `<span class="muted">(ครั้งแรกจะดาวน์โหลดประมาณ 90 MB)</span>`}`;
    $("#gptGo").onclick = () => (s.installed ? gptLogin() : gptInstall());
    if (s.installed && wantLogin) { wantLogin = false; gptLogin(); }
  }
  if (again || waitingLogin) gptTimer = setTimeout(drawGpt, 2000);
}

let waitingLogin = false;
async function gptInstall() {
  try {
    await api("POST", "/api/chatgpt/install", {});
    wantLogin = true;
    drawGpt();
  } catch (e) { showError(e); }
}

async function gptLogin() {
  try {
    const { url } = await api("POST", "/api/chatgpt/login", {});
    waitingLogin = true;
    setTimeout(() => { waitingLogin = false; }, 5 * 60 * 1000);
    $("#gpt").innerHTML = `เปิดหน้าเข้าสู่ระบบในเบราว์เซอร์แล้ว เข้าสู่ระบบ ChatGPT ให้เสร็จแล้วกลับมาที่นี่
      <div class="muted">ถ้าหน้าเว็บไม่เปิด <a class="link" href="${esc(url)}" target="_blank" rel="noopener">กดที่นี่</a></div>`;
    gptTimer = setTimeout(drawGpt, 3000);
  } catch (e) { showError(e); }
}

async function loadSheets() {
  clearTimeout(sheetsTimer);
  try { sheets = await api("GET", "/api/sheets"); } catch (e) { return showError(e); }
  if (!$("#sheetList")) return;
  drawSheets();
  if (sheets.job.running) sheetsTimer = setTimeout(loadSheets, 1500);
  else if (sheetsWasRunning) {
    sheetsWasRunning = false;
    if (sheets.job.error) {
      const body = lastSheetBody;
      showError(Object.assign(new Error(sheets.job.error), { limit: sheets.job.limit }), "⚠",
        body ? () => sheetJob(body.url, { ...body.body, provider: "gemini" }) : null);
    }
  }
}
let sheetsWasRunning = false;

async function sheetJob(url, body) {
  try {
    await api("POST", url, body);
    lastSheetBody = { url, body };
    sheetsWasRunning = true;
    loadSheets();
  } catch (e) { showError(e); }
}

const sheetUrl = (file) => `/sheets/${encodeURIComponent(file)}`;

function drawSheets() {
  if (!sheets || !$("#sheetList")) return;
  const list = sheets.sheets;
  const j = sheets.job;
  const missing = list.filter((s) => !s.chosen).length;
  const mm = $("#makeMissing");
  mm.disabled = j.running || !missing;
  mm.textContent = missing ? `วาดที่ยังไม่มี (${missing})` : "✓ วาดครบแล้ว";
  const working = list.find((s) => s.tag === j.tag);
  $("#sheetJob").innerHTML = j.running
    ? `<div class="job">กำลังวาด “${esc(working?.name ?? "")}”… ${j.tags.length > 1 ? `${Math.round(j.progress * j.tags.length)}/${j.tags.length}` : ""}<div class="prog"><i style="width:${Math.round((j.progress || 0.1) * 100)}%"></i></div></div>`
    : "";
  if (!selSheet || (selSheet !== "+" && !list.some((s) => s.tag === selSheet))) selSheet = list[0]?.tag ?? "+";
  const group = (kind, title) => `<div class="sheet-group">${title}</div>` + list.filter((s) => s.kind === kind).map((s) => `
    <button class="sh ${s.tag === selSheet ? "on" : ""}" data-tag="${esc(s.tag)}">
      <span class="sh-thumb">${s.chosen ? `<img alt="" src="${esc(sheetUrl(s.chosen))}">` : s.state === "working" || s.tag === j.tag ? "⏳" : "–"}</span>
      <span class="sh-name"><b>${esc(s.name)}</b><small>${esc(s.tag)}${s.locked ? " · 🔒" : ""}${s.auto ? " · ใหม่จากเรื่อง" : ""}</small></span>
    </button>`).join("");
  $("#sheetList").innerHTML = group("character", "ตัวละคร") + group("place", "สถานที่");
  $("#sheetList").querySelectorAll(".sh").forEach((b) => { b.onclick = () => { selSheet = b.dataset.tag; drawSheets(); }; });
  drawSheetPanel();
}

let panelKey = null; // what the panel shows; a poll that changes nothing leaves it (and any typing) alone
function drawSheetPanel() {
  const panel = $("#sheetPanel");
  const j = sheets.job;
  const cur = sheets.sheets.find((x) => x.tag === selSheet);
  const key = selSheet === "+" ? "+" : JSON.stringify([selSheet, j.running, j.tag, cur && [cur.chosen, cur.takes.length, cur.locked, cur.state, cur.error, cur.usedBy]]);
  if (key === panelKey && panel.firstChild) return;
  panelKey = key;
  if (selSheet === "+") {
    panel.innerHTML = `
      <h2>เพิ่มตัวละครหรือสถานที่</h2>
      <div class="row" style="margin-bottom:8px">
        <select id="nsKind" style="width:auto"><option value="character">ตัวละคร</option><option value="place">สถานที่</option></select>
        <input id="nsName" type="text" maxlength="60" placeholder="ชื่อ เช่น คุณยาย" style="flex:1;width:auto">
      </div>
      <textarea id="nsDesc" rows="4" maxlength="1000" placeholder="หน้าตาเป็นอย่างไร เช่น ผมสั้นสีเทา ใส่เสื้อสีม่วง หรือห้องมีโต๊ะกลมสีขาว"></textarea>
      <div class="row" style="margin-top:8px"><button id="nsSave" class="btn">เพิ่มเข้าคลัง</button></div>`;
    $("#nsSave").onclick = async () => {
      try {
        const { tag } = await api("POST", "/api/sheets", { kind: $("#nsKind").value, name: $("#nsName").value, description: $("#nsDesc").value });
        selSheet = tag;
        await loadSheets();
        sheetJob(`/api/sheets/${encodeURIComponent(tag)}/make`, {});
      } catch (e) { showError(e); }
    };
    return;
  }
  const s = sheets.sheets.find((x) => x.tag === selSheet);
  if (!s) { panel.innerHTML = ""; return; }
  const busyNow = j.running;
  const pic = s.chosen ? `<img alt="${esc(s.name)}" src="${esc(sheetUrl(s.chosen))}">`
    : s.state === "working" || s.tag === j.tag ? "<span>⏳ กำลังวาด…</span>"
    : s.error ? `<span class="warn">⚠ ${esc(s.error)}</span>` : "<span>ยังไม่ได้วาด</span>";
  const used = s.usedBy.length ? `ใช้ในตอน ${s.usedBy.map((n) => (n ? `EP${n}` : "EP–")).join(", ")}` : "ยังไม่มีตอนไหนใช้";
  panel.innerHTML = `
    <div class="sheet-head"><h2>${esc(s.name)}</h2><span class="tag">${esc(s.tag)}</span><span class="muted">${s.kind === "place" ? "สถานที่" : "ตัวละคร"} · ${used}</span></div>
    <div class="pic">${pic}</div>
    <div class="takes">${s.takes.length > 1 ? `<span>แบบ${s.takes.map((t, i) => `<button class="take ${t.file === s.chosen ? "on" : ""}" data-take="${i + 1}" ${busyNow || s.locked ? "disabled" : ""}>${i + 1}</button>`).join("")}</span>` : ""}</div>
    <div class="fix-row">
      <input id="shFix" type="text" maxlength="300" placeholder="ต้องแก้อะไร เช่น ตาเป็นจุดดำ, ผมยาวไป (ไม่ใส่ = วาดใหม่)" ${s.locked || !s.chosen ? "disabled" : ""}>
      <button id="shMake" class="btn g" ${busyNow || s.locked ? "disabled" : ""}>${s.chosen ? "↻ วาดใหม่" : "วาดแผ่นนี้"}</button>
    </div>
    <div class="row" style="margin-top:8px">
      <button id="shLock" class="btn g small" ${!s.chosen ? "disabled" : ""}>${s.locked ? "🔓 ปลดล็อก" : "🔒 ล็อกแบบนี้"}</button>
      <span class="muted">${s.locked ? "ล็อกแล้ว ทุกตอนใช้แบบนี้ แก้ไม่ได้จนกว่าจะปลดล็อก" : ""}</span>
    </div>
    <p class="muted desc">${esc(s.description)}</p>`;
  panel.querySelectorAll(".take").forEach((b) => {
    b.onclick = async () => {
      try { await api("POST", `/api/sheets/${encodeURIComponent(s.tag)}/pick`, { take: Number(b.dataset.take) }); loadSheets(); } catch (e) { showError(e); }
    };
  });
  $("#shMake").onclick = () => {
    const fix = $("#shFix");
    sheetJob(`/api/sheets/${encodeURIComponent(s.tag)}/make`, { feedback: fix.value.trim() });
    fix.value = "";
  };
  $("#shLock").onclick = async () => {
    try { await api("POST", `/api/sheets/${encodeURIComponent(s.tag)}/lock`, { locked: !s.locked }); loadSheets(); } catch (e) { showError(e); }
  };
}

route();
