// Kid Factory UI: plain JS, hash routes (#/, #/key, #/ep/<id>, #/ep/<id>/video).
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
  if (!res.ok) throw new Error(json?.error || "เกิดข้อผิดพลาด ลองใหม่");
  return json;
}

function showError(e) {
  $("#msgText").textContent = e?.message || String(e);
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

function stopPoll() {
  if (poll) clearInterval(poll.timer);
  poll = null;
}

async function route() {
  stopPoll();
  idle();
  try {
    state = await api("GET", "/api/state");
  } catch (e) {
    app.innerHTML = "";
    return showError(e);
  }
  $("#fakeBadge").hidden = !state.fake;
  $("#keyLink").hidden = !state.hasKey;
  const h = location.hash || "#/";
  let m;
  if (!state.hasKey || h === "#/key") return keyScreen();
  if ((m = h.match(/^#\/ep\/([^/]+)\/video$/))) return episodeScreen(m[1], "video");
  if ((m = h.match(/^#\/ep\/([^/]+)$/))) return episodeScreen(m[1], "room");
  return startScreen();
}
window.addEventListener("hashchange", route);

// ---------- 0 · key ----------
function keyScreen() {
  const first = !state.hasKey;
  app.innerHTML = `
    <div class="card" style="max-width:520px;margin:30px auto">
      <div class="step">${first ? "เปิดครั้งแรก" : "เปลี่ยนคีย์"}</div>
      <h1>${first ? "ยินดีต้อนรับสู่ ปิ่นโตเก่งขึ้นทุกวัน" : "เปลี่ยนคีย์ Gemini"}</h1>
      <p class="muted">วางคีย์ Gemini ครั้งเดียว โปรแกรมจะจำไว้ในเครื่องนี้เท่านั้น<br>
      ขอคีย์ได้ที่ Google AI Studio → “Get API key”</p>
      <input id="key" type="password" placeholder="วางคีย์ Gemini ที่นี่" autocomplete="off" spellcheck="false">
      <div class="row" style="margin-top:12px">
        <button id="saveKey" class="btn">บันทึกคีย์</button>
        ${first ? "" : `<a class="btn g" href="#/">ยกเลิก</a>`}
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

// ---------- 1–2 · start ----------
function startScreen() {
  app.innerHTML = `
    <div class="cols">
      <div>
        <div class="card">
          <div class="step">1 · พิมพ์หัวข้อ</div>
          <div class="topic-row">
            <input id="topic" type="text" placeholder="เช่น สอนเด็กแปรงฟัน" value="${esc(topicText)}">
            <button id="think" class="btn">คิดเรื่องให้หน่อย</button>
          </div>
          <div id="ideas"></div>
        </div>
      </div>
      <div>
        <div class="card"><h2>เรื่องที่เก็บไว้</h2><div id="savedList"></div></div>
      </div>
    </div>
    <div class="card"><h2>คลังตอน</h2><div id="library"></div></div>`;

  const topic = $("#topic");
  const think = async () => {
    topicText = topic.value.trim();
    if (!topicText) return showError(new Error("พิมพ์หัวข้อก่อนนะ"));
    busy("กำลังคิดเรื่อง…", "รอสักครู่");
    try {
      ideasFound = (await api("POST", "/api/ideas", { topic: topicText })).ideas;
      ideaPicked = null;
      drawIdeas();
    } catch (e) { showError(e); } finally { idle(); }
  };
  $("#think").onclick = think;
  topic.onkeydown = (e) => { if (e.key === "Enter") think(); };
  if (!ideasFound) topic.focus();

  drawIdeas();
  drawSaved();
  drawLibrary();
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

async function writeStory(idea, keep) {
  busy("กำลังเขียนเรื่อง… ใช้เวลาประมาณ 1–3 นาที", "อย่าเพิ่งปิดหน้าต่างนะ");
  try {
    const { id } = await api("POST", "/api/episodes", { idea, keep });
    ideasFound = null;
    ideaPicked = null;
    topicText = "";
    location.hash = `#/ep/${id}`;
  } catch (e) {
    idle();
    showError(e);
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
  if (!list.length) { box.innerHTML = `<p class="muted">ยังไม่มีตอน เริ่มจากพิมพ์หัวข้อด้านบน</p>`; return; }
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

async function episodeScreen(id, tab) {
  try {
    ep = await api("GET", `/api/episodes/${encodeURIComponent(id)}`);
    job = await api("GET", `/api/episodes/${encodeURIComponent(id)}/job`);
  } catch (e) {
    showError(e);
    location.hash = "#/";
    return;
  }
  if (!ep.story.pages[sel - 1] || app.dataset.ep !== id) sel = 1;
  app.dataset.ep = id;
  ver = {};
  wasRunning = {};
  for (const k of ["images", "voices", "render"]) if (job[k]?.running) wasRunning[k] = true;

  app.innerHTML = `
    <div class="ep-head">
      <span class="step" style="margin:0">${epLabel(ep.number)}</span>
      <h1>${esc(ep.story.title)}</h1>
      <nav class="tabs">
        <a class="tab ${tab === "room" ? "on" : ""}" href="#/ep/${encodeURIComponent(id)}">3 · ห้องทำงาน</a>
        <a class="tab ${tab === "video" ? "on" : ""}" href="#/ep/${encodeURIComponent(id)}/video">4 · ประกอบวิดีโอ</a>
      </nav>
    </div>
    <div class="card" id="screen"></div>`;
  if (tab === "room") roomShell(); else videoShell();
  if (anyRunning()) startPoll();
}

const anyRunning = () => ["images", "voices", "render"].some((k) => job[k]?.running);

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
        for (const k of ["images", "voices", "render"]) {
          if (wasRunning[k] && !job[k]?.running) {
            wasRunning[k] = false;
            if (job[k]?.error) showError(new Error(job[k].error));
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
    job[kind] = { running: true, progress: 0, pages: body.pages };
    wasRunning[kind] = true;
    // show "working" right away
    try { const e = await api("GET", `/api/episodes/${encodeURIComponent(ep.id)}`); bumpVersions(ep, e); ep = e; } catch {}
    refresh();
    startPoll();
  } catch (e) { showError(e); }
}

function refresh() {
  if ($("#roomPages")) roomUpdate();
  if ($("#videoBox")) videoUpdate();
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
    <div class="step">3 · ดูบท แก้ได้ แล้วเจน</div>
    <div class="row">
      <button id="allImages" class="btn">เจนภาพทั้งหมด</button>
      <button id="allVoices" class="btn">เจนเสียงทั้งหมด</button>
      <span id="info" class="info"></span>
      <span class="grow"></span>
      <a id="toVideo" class="btn g" href="#/ep/${encodeURIComponent(ep.id)}/video">ไปประกอบวิดีโอ →</a>
    </div>
    <div id="jobs" class="jobs"></div>
    <div class="room">
      <div id="roomPages" class="pages"></div>
      <div>
        <div id="pic" class="pic"></div>
        <div class="narr-label"><span id="pageTitle"></span><span id="savedNote" class="saved-note"></span></div>
        <textarea id="narr"></textarea>
        <div class="row" style="margin-top:8px">
          <button id="oneImage" class="btn g">↻ ภาพใหม่</button>
          <button id="play" class="btn g">▶ ฟังเสียง</button>
          <button id="oneVoice" class="btn g">↻ เสียงใหม่</button>
        </div>
        <div id="pageState" class="page-state"></div>
      </div>
    </div>`;
  $("#allImages").onclick = () => startJob("images");
  $("#allVoices").onclick = () => startJob("voices");
  $("#oneImage").onclick = () => startJob("images", { pages: [sel] });
  $("#oneVoice").onclick = async () => { await saveNarration(); startJob("voices", { pages: [sel] }); };
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
  } catch (e) { showError(e); }
}

function loadPage() {
  $("#narr").value = ep.story.pages[sel - 1].narration;
  $("#savedNote").textContent = "";
  $("#pageTitle").textContent = `หน้า ${sel} · คำเล่า`;
}

function roomUpdate() {
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
  const ready = !imagesLeft && !voicesLeft;
  $("#toVideo").className = ready ? "btn" : "btn g";

  // jobs
  const bars = [];
  for (const [k, label] of [["images", "กำลังเจนภาพ"], ["voices", "กำลังเจนเสียง"]]) {
    const j = job[k];
    if (!j?.running) continue;
    const total = j.pages?.length || 0;
    const done = Math.round((j.progress || 0) * total);
    bars.push(`<div class="job">${label}… ${total ? `${done}/${total} หน้า` : ""}<div class="prog"><i style="width:${Math.round((j.progress || 0) * 100)}%"></i></div></div>`);
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
      await saveNarration();
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
  const imageText = p.image.state === "done" ? "✓ ภาพ" : p.image.state === "working" ? "⏳ ภาพ" : p.image.state === "error" ? `<span class="warn">⚠ ภาพ</span>` : "ยังไม่มีภาพ";
  $("#pageState").innerHTML = `${imageText} · ${voiceText}`;
}

// ---------- 4 · assemble ----------
let tracks = null;

async function videoShell() {
  $("#screen").innerHTML = `
    <div class="step">4 · ประกอบเป็นวิดีโอ</div>
    <div class="music-row">
      <span>เพลงประกอบ:</span>
      <select id="music"></select>
      <span class="muted">(จากคลัง เลือกให้ตามอารมณ์เรื่องแล้ว)</span>
    </div>
    <div id="videoBox"></div>
    <div id="playerBox"></div>`;
  try {
    tracks = (await api("GET", "/api/music")).tracks;
  } catch (e) { tracks = []; showError(e); }
  const musicSel = $("#music");
  if (!musicSel) return;
  const pick = ep.musicId && tracks.some((t) => t.id === ep.musicId) ? ep.musicId : ep.suggestedMusicId;
  musicSel.innerHTML = tracks.length
    ? tracks.map((t) => `<option value="${esc(t.id)}" ${t.id === pick ? "selected" : ""}>${esc(trackName(t))}${t.mood === ep.story.mood ? " · เข้ากับเรื่อง" : ""}</option>`).join("")
    : `<option value="">ไม่มีเพลง (วิดีโอจะมีแต่เสียงเล่า)</option>`;
  videoUpdate();
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

route();
