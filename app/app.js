import { Unzip, UnzipInflate } from './vendor/fflate.js';

// Official Language Transfer download. Their server sends CORS headers, so the
// audio goes straight from them to this device and is never re-hosted.
const ZIP_URL = 'https://downloads.languagetransfer.org/french/french.zip';
const ZIP_SIZE = 374011591;
const TRIP = '2027-01-03';
const DEFAULT_FINISH = '2026-12-20';

const $ = (s, el = document) => el.querySelector(s);
const view = $('#view');
const audio = $('#audio');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = s => { s = Math.max(0, Math.floor(s || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

// ---------- dates ----------
const dayOf = d => Math.floor((d.getTime() - d.getTimezoneOffset() * 6e4) / 864e5);
const today = () => dayOf(new Date());
const dayOfISO = iso => { const [y, m, d] = iso.split('-').map(Number); return dayOf(new Date(y, m - 1, d)); };
const isoOfDay = n => new Date(n * 864e5).toISOString().slice(0, 10);

// ---------- state ----------
const KEY = 'ltf-state-v1';
const state = Object.assign(
  { done: {}, pos: {}, cards: {}, log: {}, finishBy: DEFAULT_FINISH, rate: 1, autoSpeak: true, last: null },
  (() => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } })()
);
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch {} };
const logActivity = () => { const k = isoOfDay(today()); state.log[k] = (state.log[k] || 0) + 1; save(); };

function streak() {
  let d = today(), n = 0;
  if (!state.log[isoOfDay(d)]) d--;
  while (state.log[isoOfDay(d)]) { n++; d--; }
  return n;
}

// ---------- audio storage (IndexedDB) ----------
let dbp;
function db() {
  return dbp ??= new Promise((res, rej) => {
    const r = indexedDB.open('ltf-audio', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('audio');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idb(mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const tx = d.transaction('audio', mode);
    const req = fn(tx.objectStore('audio'));
    tx.oncomplete = () => res(req?.result);
    tx.onerror = () => rej(tx.error);
  });
}
const putAudio = (n, blob) => idb('readwrite', s => s.put(blob, n));
const getAudio = n => idb('readonly', s => s.get(n));
const audioKeys = () => idb('readonly', s => s.getAllKeys());
const clearAudio = () => idb('readwrite', s => s.clear());

async function ingestZip(stream, total, onProgress) {
  let failure = null, read = 0;
  const writes = [];
  const unzip = new Unzip(file => {
    const m = file.name.match(/Lesson\s*(\d+)\.mp3$/i);
    if (!m) return;
    const n = +m[1], chunks = [];
    file.ondata = (err, data, final) => {
      if (err) { failure = err; return; }
      chunks.push(data.slice());
      if (final) writes.push(putAudio(n, new Blob(chunks, { type: 'audio/mpeg' })).then(() => onProgress(read / total, n)));
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    read += value.length;
    unzip.push(value);
    if (failure) throw failure;
    onProgress(read / total);
  }
  unzip.push(new Uint8Array(0), true);
  await Promise.all(writes);
  if (failure) throw failure;
}

// ---------- lesson content ----------
let index = [];
const lessonCache = {};
async function loadIndex() {
  try { index = await (await fetch('lessons/index.json')).json(); }
  catch { index = Array.from({ length: 40 }, (_, i) => ({ n: i + 1, title: '', dur: 0 })); }
}
async function loadLesson(n) {
  if (!lessonCache[n]) {
    try { lessonCache[n] = await (await fetch(`lessons/${String(n).padStart(2, '0')}.json`)).json(); }
    catch { lessonCache[n] = { n, title: '', summary: '', points: [], vocab: [], drills: [], transcript: [] }; }
  }
  return lessonCache[n];
}
const nextLesson = () => index.find(l => !state.done[l.n]);

// ---------- practice decks (verbs, gender) ----------
let decks = { verbs: { title: 'Survival verbs', units: [] }, gender: { title: 'Le or la?', units: [] } };
const deckCards = {};
async function loadDecks() {
  try { decks = await (await fetch('decks.json')).json(); } catch {}
  for (const u of decks.verbs.units)
    for (const [en, fr] of u.cards) deckCards[`v|${fr}`] = { kind: 'verb', en, fr, src: u.title };
  for (const u of decks.gender.units)
    for (const [word, g, en, note] of u.cards) deckCards[`g|${word}`] = { kind: 'gender', word, g, en, note, src: u.title };
}
const unitIds = (deck, u) => u.cards.map(c => deck === 'verbs' ? `v|${c[1]}` : `g|${c[0]}`);
const unitStarted = (deck, u) => unitIds(deck, u).some(id => state.cards[id]);
const unitLearned = (deck, u) => unitIds(deck, u).filter(id => state.cards[id]?.reps >= 2).length;
const nextUnit = deck => decks[deck].units.find(u => !unitStarted(deck, u));
const withArticle = (word, g) => (/^[aeiouyéèêâîôûh]/i.test(word) ? "l'" : g === 'm' ? 'le ' : 'la ') + word;
const indefinite = (word, g) => `${g === 'm' ? 'un' : 'une'} ${word}`;
const title = l => l.title ? `Lesson ${l.n} · ${l.title}` : `Lesson ${l.n}`;

// ---------- spaced repetition ----------
const cardId = (n, d) => `${n}|${d.fr}`;
function addIds(ids) {
  for (const id of ids) state.cards[id] ??= { due: today(), ivl: 0, ease: 2.5, reps: 0 };
}
const addCards = lesson => addIds(lesson.drills.map(d => cardId(lesson.n, d)));
function schedule(c, g) {
  c = { ...c };
  if (g === 0) { c.reps = 0; c.ivl = 0; c.ease = Math.max(1.3, c.ease - 0.2); c.due = today(); return c; }
  if (c.reps === 0) c.ivl = [0, 1, 1, 3][g];
  else if (c.reps === 1) c.ivl = [0, 2, 3, 6][g];
  else c.ivl = Math.max(c.ivl + 1, Math.round(c.ivl * [0, 1.2, c.ease, c.ease * 1.3][g]));
  c.ease = Math.max(1.3, c.ease + [0, -0.15, 0, 0.15][g]);
  c.reps++;
  c.due = today() + c.ivl;
  return c;
}
const dueIds = () => Object.entries(state.cards).filter(([, c]) => c.due <= today()).map(([id]) => id);
const ivlLabel = c => c.ivl === 0 ? 'now' : c.ivl === 1 ? '1 day' : c.ivl < 30 ? `${c.ivl} days` : `${Math.round(c.ivl / 30)} mo`;

async function drillFor(id) {
  if (deckCards[id]) return deckCards[id];
  const [n, fr] = [+id.split('|')[0], id.slice(id.indexOf('|') + 1)];
  const l = await loadLesson(n);
  return { kind: 'drill', src: `Lesson ${n}`, ...(l.drills.find(d => d.fr === fr) || { en: '', fr }) };
}

// ---------- speech ----------
let frVoice;
function pickVoice() {
  const vs = speechSynthesis.getVoices().filter(v => v.lang?.toLowerCase().startsWith('fr'));
  frVoice = vs.find(v => /fr-FR/i.test(v.lang) && /enhanced|premium|amélie|thomas/i.test(v.name)) || vs.find(v => /fr-FR/i.test(v.lang)) || vs[0];
}
if ('speechSynthesis' in window) { pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; }
function say(text) {
  if (!('speechSynthesis' in window)) return;
  if (!audio.paused) audio.pause();
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text.replace(/\(.*?\)/g, ''));
  u.lang = 'fr-FR'; if (frVoice) u.voice = frVoice; u.rate = 0.9;
  speechSynthesis.speak(u);
}

// ---------- player ----------
let playing = null; // lesson number loaded in <audio>
let objUrl = null;
async function loadAudio(n) {
  if (playing === n) return true;
  const blob = await getAudio(n).catch(() => null);
  if (!blob) return false;
  if (objUrl) URL.revokeObjectURL(objUrl);
  objUrl = URL.createObjectURL(blob);
  audio.src = objUrl;
  audio.playbackRate = state.rate;
  playing = n;
  const start = state.pos[n] || 0;
  await new Promise(r => { audio.onloadedmetadata = r; audio.load(); });
  if (start > 0 && start < audio.duration - 3) audio.currentTime = start;
  state.last = n; save();
  const l = index.find(x => x.n === n) || { n };
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: title(l), artist: 'Language Transfer', album: 'Introduction to French',
      artwork: [{ src: 'icon-512.png', sizes: '512x512', type: 'image/png' }],
    });
  }
  updateMini();
  return true;
}
const toggle = () => audio.paused ? audio.play() : audio.pause();
const skip = s => { audio.currentTime = Math.max(0, Math.min(audio.duration || 0, audio.currentTime + s)); };
if ('mediaSession' in navigator) {
  navigator.mediaSession.setActionHandler('play', () => audio.play());
  navigator.mediaSession.setActionHandler('pause', () => audio.pause());
  navigator.mediaSession.setActionHandler('seekbackward', () => skip(-10));
  navigator.mediaSession.setActionHandler('seekforward', () => skip(10));
}

let lastSave = 0;
audio.addEventListener('timeupdate', () => {
  if (playing == null) return;
  state.pos[playing] = audio.currentTime;
  if (Date.now() - lastSave > 4000) { lastSave = Date.now(); save(); }
  onTick();
});
audio.addEventListener('play', () => { updateMini(); onTick(); });
audio.addEventListener('pause', () => { save(); updateMini(); onTick(); });
audio.addEventListener('ended', () => {
  state.pos[playing] = 0; save();
  if (!state.done[playing]) toast(`End of lesson ${playing}. Tap “Mark complete” to add its drills to Review.`);
});

let onTick = () => {};
function updateMini() {
  const mini = $('#mini');
  const onLessonPage = location.hash === `#/lesson/${playing}`;
  mini.hidden = playing == null || onLessonPage || (audio.paused && !audio.currentTime);
  $('#mini-open').textContent = playing ? `Lesson ${playing} · ${fmt(audio.currentTime)}` : '';
  $('#mini-play').textContent = audio.paused ? '▶' : '❚❚';
}
$('#mini-play').onclick = toggle;
$('#mini-back').onclick = () => skip(-10);
$('#mini-open').onclick = () => { location.hash = `#/lesson/${playing}`; };

// ---------- ui helpers ----------
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
}
function updateBadge() {
  const n = dueIds().length, b = $('#due-badge');
  b.hidden = !n; b.textContent = n;
}
const standalone = () => navigator.standalone || matchMedia('(display-mode: standalone)').matches;

// ---------- views ----------
async function viewToday() {
  const keys = await audioKeys().catch(() => []);
  const doneCount = Object.keys(state.done).length;
  const daysToTrip = dayOfISO(TRIP) - today();
  const daysToFinish = Math.max(1, dayOfISO(state.finishBy) - today() + 1);
  const remaining = index.length - doneCount;
  const pace = remaining ? Math.ceil(remaining / daysToFinish) : 0;
  const doneToday = Object.values(state.done).filter(d => d === isoOfDay(today())).length;
  const todays = index.filter(l => !state.done[l.n]).slice(0, Math.max(0, pace - doneToday));
  const due = dueIds().length;
  const learned = Object.values(state.cards).filter(c => c.reps >= 2).length;
  const next = nextLesson();

  view.innerHTML = `
    <h1>${daysToTrip > 0 ? `${daysToTrip} days until France` : 'Bon voyage !'}</h1>
    <p class="muted">${new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}</p>

    ${keys.length < 40 ? `
      <div class="card">
        <h2>Set up lesson audio</h2>
        <p class="muted small">${keys.length ? `${keys.length}/40 lessons saved on this phone.` : 'Download the 40 lessons to this phone once (374 MB). Then they play offline.'}</p>
        <a class="btn block" href="#/more">Set up audio</a>
      </div>` : ''}

    ${next ? `
      <div class="card hero">
        <div class="small muted">${todays.length ? "Today's lesson" : 'Up next (ahead of schedule)'}</div>
        <h2 style="margin:4px 0 2px">${esc(title(next))}</h2>
        <div class="small muted">${next.dur ? `${Math.round(next.dur / 60)} min` : ''}${state.pos[next.n] ? ` · resume at ${fmt(state.pos[next.n])}` : ''}</div>
        <div class="btn-row"><a class="btn light" href="#/lesson/${next.n}">${state.pos[next.n] ? 'Continue' : 'Start'} lesson</a></div>
        ${todays.length > 1 ? `<p class="small muted" style="margin:10px 0 0">Plus ${todays.slice(1).map(l => `lesson ${l.n}`).join(', ')} today to stay on pace.</p>` : ''}
      </div>` : `
      <div class="card hero"><h2>All 40 lessons done 🎉</h2><p class="muted">Keep reviewing daily so it sticks.</p></div>`}

    <div class="card">
      <div class="row spread"><h2 style="margin:0">Review</h2><span class="muted small">${due} due</span></div>
      <p class="muted small">${due ? 'Say each one out loud before you reveal the answer.' : 'Nothing due. Finish a lesson to add its drills.'}</p>
      ${due ? `<a class="btn block" href="#/review">Review ${due} card${due > 1 ? 's' : ''}</a>` : ''}
    </div>

    ${(() => {
      const v = nextUnit('verbs'), g = nextUnit('gender');
      if (!v && !g) return '';
      return `
      <div class="card">
        <div class="row spread"><h2 style="margin:0">Practice</h2><a class="small" href="#/practice">All units ›</a></div>
        <p class="muted small">Add one new unit a day alongside your lesson.</p>
        ${v ? `<a class="btn ghost block" style="margin-top:8px" href="#/unit/verbs/${v.id}">Verbs: ${esc(v.title)}</a>` : ''}
        ${g ? `<a class="btn ghost block" style="margin-top:8px" href="#/unit/gender/${g.id}">Le/la: ${esc(g.title)}</a>` : ''}
      </div>`;
    })()}

    <div class="grid2">
      <div class="card stat"><b>${doneCount}<small class="muted">/40</small></b><span>lessons done</span>
        <div class="bar" style="margin-top:8px"><i style="width:${doneCount / 40 * 100}%"></i></div></div>
      <div class="card stat"><b>${streak()}</b><span>day streak</span></div>
      <div class="card stat"><b>${learned}</b><span>phrases learned</span></div>
      <div class="card stat"><b>${pace}</b><span>lesson${pace === 1 ? '' : 's'}/day to finish by ${new Date(state.finishBy).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</span></div>
    </div>`;
}

function viewLessons() {
  const next = nextLesson();
  view.innerHTML = `
    <h1>Lessons</h1>
    <p class="muted">Language Transfer · Introduction to French</p>
    <ul class="list">${index.map(l => `
      <li><a href="#/lesson/${l.n}">
        <span class="num ${state.done[l.n] ? 'done' : next?.n === l.n ? 'next' : ''}">${state.done[l.n] ? '✓' : l.n}</span>
        <span class="t"><div>${esc(l.title || `Lesson ${l.n}`)}</div>
          <div class="small muted">${l.dur ? `${Math.round(l.dur / 60)} min` : ''}${state.pos[l.n] && !state.done[l.n] ? ` · ${fmt(state.pos[l.n])} in` : ''}</div></span>
        <span class="muted">›</span>
      </a></li>`).join('')}</ul>`;
}

async function viewLesson(n) {
  const l = await loadLesson(n);
  const meta = index.find(x => x.n === n) || { n };
  const ok = await loadAudio(n);
  let tab = sessionStorage.getItem('ltf-tab') || 'notes';

  view.innerHTML = `
    <p style="margin:8px 0 0"><a href="#/lessons">‹ Lessons</a></p>
    <h1>Lesson ${n}</h1>
    <p class="muted">${esc(meta.title || l.title)}</p>

    <div class="card player">
      ${ok ? `
        <input class="scrub" type="range" min="0" max="1000" value="0" aria-label="Position">
        <div class="times"><span class="cur">0:00</span><span class="dur">${fmt(audio.duration)}</span></div>
        <div class="controls">
          <button class="icon-btn" data-skip="-10" aria-label="Back 10 seconds">↺10</button>
          <button class="icon-btn play" aria-label="Play or pause">▶</button>
          <button class="icon-btn" data-skip="10" aria-label="Forward 10 seconds">10↻</button>
        </div>
        <div class="row spread" style="margin-top:12px">
          <span class="small muted">Pause whenever you're asked to answer.</span>
          <button class="chip speed">${state.rate}×</button>
        </div>` : `
        <p>Audio for this lesson isn't on this phone yet.</p>
        <a class="btn block" href="#/more">Set up audio</a>`}
    </div>

    <div class="seg" role="tablist">
      <button data-tab="notes">Notes</button>
      <button data-tab="drills">Drills (${l.drills.length})</button>
      <button data-tab="tx">Transcript</button>
    </div>
    <div id="pane"></div>

    <div class="btn-row">
      ${state.done[n]
        ? `<button class="btn ghost" id="undone">Completed ✓ (undo)</button>`
        : `<button class="btn" id="done">Mark complete</button>`}
    </div>`;

  const pane = $('#pane');
  const renderPane = () => {
    view.querySelectorAll('.seg button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
    if (tab === 'notes') {
      pane.innerHTML = l.summary || l.points.length ? `
        <div class="card">
          ${l.summary ? `<p>${esc(l.summary)}</p>` : ''}
          ${l.points.length ? `<h3>Key points</h3><ul class="points">${l.points.map(p => `<li>${esc(p)}</li>`).join('')}</ul>` : ''}
          ${l.vocab.length ? `<h3>Words &amp; phrases</h3><table class="vocab">${l.vocab.map(v => `
            <tr><td><span class="say" data-say="${esc(v.fr)}">${esc(v.fr)} 🔈</span></td><td>${esc(v.en)}</td></tr>`).join('')}</table>` : ''}
        </div>` : `<p class="muted">Notes for this lesson aren't ready yet.</p>`;
    } else if (tab === 'drills') {
      pane.innerHTML = l.drills.length ? `
        <p class="small muted">Cover the answer, say it out loud, then tap to check.</p>
        <div class="card" style="padding-top:4px">${l.drills.map((d, i) => `
          <div class="drill">
            <div>${esc(d.en)}</div>
            <div class="ans fr hide" data-i="${i}">${esc(d.fr)}</div>
            <div class="tools">
              <button class="chip" data-say="${esc(d.fr)}">🔈 Hear it</button>
              ${ok && d.t != null ? `<button class="chip" data-seek="${d.t}">▶ In lesson ${fmt(d.t)}</button>` : ''}
            </div>
          </div>`).join('')}</div>
        <a class="btn ghost block" href="#/review/lesson/${n}">Practise these as flashcards</a>` : `<p class="muted">Drills for this lesson aren't ready yet.</p>`;
    } else {
      pane.innerHTML = l.transcript.length ? `
        <p class="small muted">Auto-generated transcript. Tap a line to jump there.</p>
        <div class="card tx">${l.transcript.map(s => `<p data-seek="${s.t}"><time>${fmt(s.t)}</time>${esc(s.x)}</p>`).join('')}</div>`
        : `<p class="muted">Transcript not ready yet.</p>`;
    }
    onTick();
  };
  view.querySelectorAll('.seg button').forEach(b => b.onclick = () => { tab = b.dataset.tab; sessionStorage.setItem('ltf-tab', tab); renderPane(); });
  renderPane();

  view.onclick = e => {
    const t = e.target.closest('[data-say],[data-seek],.ans.hide,[data-skip],.play,.speed');
    if (!t) return;
    if (t.matches('.ans.hide')) t.classList.remove('hide');
    else if (t.dataset.say) say(t.dataset.say);
    else if (t.dataset.seek) { audio.currentTime = +t.dataset.seek; audio.play(); }
    else if (t.dataset.skip) skip(+t.dataset.skip);
    else if (t.matches('.play')) toggle();
    else if (t.matches('.speed')) {
      state.rate = { 1: 1.25, 1.25: 1.5, 1.5: 0.85, 0.85: 1 }[state.rate] || 1;
      audio.playbackRate = state.rate; t.textContent = `${state.rate}×`; save();
    }
  };

  const scrub = $('.scrub'), cur = $('.cur'), playBtn = $('.player .play');
  if (scrub) scrub.oninput = () => { audio.currentTime = scrub.value / 1000 * audio.duration; };
  let lastSeg = -1;
  onTick = () => {
    if (playing !== n || !scrub) return;
    if (document.activeElement !== scrub) scrub.value = audio.currentTime / audio.duration * 1000 || 0;
    cur.textContent = fmt(audio.currentTime);
    playBtn.textContent = audio.paused ? '▶' : '❚❚';
    if (tab === 'tx') {
      let i = -1;
      for (let k = 0; k < l.transcript.length && l.transcript[k].t <= audio.currentTime; k++) i = k;
      if (i !== lastSeg) {
        const ps = pane.querySelectorAll('.tx p');
        ps[lastSeg]?.classList.remove('now'); ps[i]?.classList.add('now');
        if (!audio.paused) ps[i]?.scrollIntoView({ block: 'center', behavior: 'smooth' });
        lastSeg = i;
      }
    }
  };
  onTick();

  const doneBtn = $('#done'), undoBtn = $('#undone');
  if (doneBtn) doneBtn.onclick = () => {
    state.done[n] = isoOfDay(today()); addCards(l); logActivity(); save(); updateBadge();
    toast(l.drills.length ? `Nice! ${l.drills.length} drills added to Review.` : 'Lesson complete!');
    viewLesson(n);
  };
  if (undoBtn) undoBtn.onclick = () => { delete state.done[n]; save(); viewLesson(n); };
}

// ids: cards to go through. cram: practise without changing the schedule.
async function viewReview({ ids = dueIds(), cram = false, heading = 'Review' } = {}) {
  const queue = [...ids];
  queue.sort(() => Math.random() - 0.5);
  let done = 0;
  const total = queue.length;

  const show = async () => {
    if (!queue.length) {
      updateBadge();
      const upcoming = Object.values(state.cards).filter(c => c.due === today() + 1).length;
      view.innerHTML = `
        <h1>Review</h1>
        <div class="card" style="text-align:center;padding:32px 16px">
          <h2>${total ? 'Session complete 🎉' : 'All caught up'}</h2>
          <p class="muted">${total ? `${done} cards reviewed.` : Object.keys(state.cards).length ? 'No cards are due right now.' : 'Complete a lesson to add its drills here.'}
          ${upcoming ? `<br>${upcoming} due tomorrow.` : ''}</p>
          <a class="btn" href="#/today">Back to Today</a>
        </div>`;
      return;
    }
    const id = queue[0];
    const d = await drillFor(id);
    const c = state.cards[id] || { due: today(), ivl: 0, ease: 2.5, reps: 0 };
    const grade = g => {
      queue.shift();
      if (!cram && state.cards[id]) { state.cards[id] = schedule(c, g); logActivity(); }
      if (g === 0) queue.push(id); else done++;
      save(); updateBadge(); show();
    };
    const header = `
      <h1>${esc(heading)}</h1>
      <div class="bar" style="margin:8px 0 4px"><i style="width:${done / total * 100}%"></i></div>
      <p class="small muted">${queue.length} left</p>`;

    if (d.kind === 'gender') {
      view.innerHTML = `${header}
        <div class="card flash">
          <div class="src">${esc(d.src)} · Le or la?</div>
          <div class="q" style="font-size:30px">${esc(d.word)}</div>
          <div class="muted">${esc(d.en)}</div>
          <div class="a" hidden></div>
          <div class="small muted note" hidden></div>
        </div>
        <div class="grades two">
          <button class="btn ghost" data-pick="m">le · un</button>
          <button class="btn ghost" data-pick="f">la · une</button>
        </div>
        <button class="btn block" id="next" hidden>Next</button>`;
      view.querySelectorAll('[data-pick]').forEach(b => b.onclick = () => {
        const right = b.dataset.pick === d.g;
        const a = $('.flash .a');
        a.hidden = false;
        a.className = `a ${right ? 'ok' : 'bad'}`;
        a.textContent = `${right ? '✓' : '✗'} ${withArticle(d.word, d.g)} · ${indefinite(d.word, d.g)}`;
        if (d.note) { $('.flash .note').hidden = false; $('.flash .note').textContent = d.note; }
        $('.grades').hidden = true;
        $('#next').hidden = false;
        $('#next').onclick = () => grade(right ? 2 : 0);
        if (state.autoSpeak) say(withArticle(d.word, d.g));
      });
      return;
    }

    view.innerHTML = `${header}
      <div class="card flash">
        <div class="src">${esc(d.src)} · How would you say…</div>
        <div class="q">${esc(d.en)}</div>
        <div class="a" hidden>${esc(d.fr)} <button class="chip" data-say="${esc(d.fr)}">🔈</button></div>
      </div>
      <button class="btn block" id="reveal">Show answer</button>
      <div class="grades" hidden>
        ${['Again', 'Hard', 'Good', 'Easy'].map((g, i) => `<button class="btn g${i}" data-g="${i}">${g}<small>${cram ? '' : ivlLabel(schedule(c, i))}</small></button>`).join('')}
      </div>`;
    $('#reveal').onclick = () => {
      $('.flash .a').hidden = false; $('#reveal').hidden = true; $('.grades').hidden = false;
      if (state.autoSpeak) say(d.fr);
    };
    view.querySelector('[data-say]').onclick = e => say(e.currentTarget.dataset.say);
    view.querySelectorAll('[data-g]').forEach(b => b.onclick = () => grade(+b.dataset.g));
  };
  show();
}

function viewPractice() {
  const section = deck => `
    <h3>${esc(decks[deck].title)}</h3>
    <ul class="list">${decks[deck].units.map((u, i) => {
      const started = unitStarted(deck, u), learned = unitLearned(deck, u);
      return `<li><a href="#/unit/${deck}/${u.id}">
        <span class="num ${learned === u.cards.length ? 'done' : started ? 'next' : ''}">${learned === u.cards.length ? '✓' : i + 1}</span>
        <span class="t"><div>${esc(u.title)}</div>
          <div class="small muted">${started ? `${learned}/${u.cards.length} learned` : `${u.cards.length} cards`}</div></span>
        <span class="muted">›</span></a></li>`;
    }).join('')}</ul>`;
  view.innerHTML = `
    <h1>Practice</h1>
    <p class="muted">Targeted drills for conjugation and le/la. Start a unit to add it to your daily Review.</p>
    ${section('verbs')}
    ${section('gender')}`;
}

function viewUnit(deck, uid) {
  const u = decks[deck]?.units.find(x => x.id === uid);
  if (!u) { location.hash = '#/practice'; return; }
  const started = unitStarted(deck, u);
  const ids = unitIds(deck, u);
  const due = ids.filter(id => state.cards[id] && state.cards[id].due <= today()).length;
  view.innerHTML = `
    <p style="margin:8px 0 0"><a href="#/practice">‹ Practice</a></p>
    <h1>${esc(u.title)}</h1>
    <div class="card"><p style="margin:0">${esc(u.intro)}</p></div>
    <div class="btn-row">
      ${!started ? `<a class="btn" href="#/review/unit/${deck}/${uid}">Start unit (${u.cards.length} cards)</a>`
        : due ? `<a class="btn" href="#/review/unit/${deck}/${uid}">Review ${due} due</a>`
        : `<a class="btn ghost" href="#/review/unit/${deck}/${uid}">Practise again</a>`}
    </div>
    <h3>${deck === 'verbs' ? 'Prompts' : 'Words'}</h3>
    <div class="card" style="padding-top:4px">${deck === 'verbs'
      ? u.cards.map(([en, fr]) => `
        <div class="drill"><div>${esc(en)}</div>
          <div class="ans fr hide">${esc(fr)}</div>
          <div class="tools"><button class="chip" data-say="${esc(fr)}">🔈 Hear it</button></div></div>`).join('')
      : u.cards.map(([w, g, en, note]) => `
        <div class="drill"><div class="row spread"><span><span class="ans fr hide">${esc(withArticle(w, g))}</span> <span class="muted">· ${esc(en)}</span></span>
          <button class="chip" data-say="${esc(withArticle(w, g))}">🔈</button></div>
          ${note ? `<div class="small muted">${esc(note)}</div>` : ''}</div>`).join('')}
    </div>`;
  view.onclick = e => {
    const t = e.target.closest('[data-say],.ans.hide');
    if (!t) return;
    if (t.matches('.ans.hide')) t.classList.remove('hide');
    else say(t.dataset.say);
  };
}

async function viewMore() {
  const keys = await audioKeys().catch(() => []);
  const est = await navigator.storage?.estimate?.().catch(() => null);
  view.innerHTML = `
    <h1>More</h1>

    ${!standalone() ? `
      <div class="card" style="border-color:var(--amber)">
        <h2>Install it first</h2>
        <p class="small">In Safari, tap <b>Share</b> → <b>Add to Home Screen</b>, then open <b>Français</b> from your home screen. Download the audio <i>from there</i>: iPhone keeps home-screen apps' storage separate from Safari's.</p>
      </div>` : ''}

    <div class="card">
      <h2>Lesson audio</h2>
      <p class="small muted">${keys.length}/40 lessons saved on this phone${est ? ` · ${Math.round(est.usage / 1e6)} MB used` : ''}.</p>
      <div class="bar"><i id="dl-bar" style="width:${keys.length / 40 * 100}%"></i></div>
      <p class="small muted" id="dl-msg" style="margin-top:8px">Downloads the free course zip (374 MB) straight from Language Transfer. Use Wi-Fi and keep the app open until it finishes.</p>
      <div class="btn-row">
        <button class="btn" id="dl">${keys.length ? 'Download again' : 'Download lessons'}</button>
      </div>
      <details style="margin-top:12px"><summary class="small muted">Other options</summary>
        <p class="small">If the download keeps failing, get <a href="${ZIP_URL}">french.zip</a> in Safari, then import it (or the MP3s) from Files:</p>
        <input type="file" id="imp" accept=".zip,audio/mpeg,.mp3" multiple>
        <div class="btn-row"><button class="btn ghost" id="clear">Delete saved audio</button></div>
      </details>
    </div>

    <div class="card">
      <h2>Plan</h2>
      <label class="field small">Finish all lessons by
        <input type="date" id="finish" value="${state.finishBy}" min="${isoOfDay(today())}" max="${TRIP}"></label>
      <label class="row small"><input type="checkbox" id="autosay" ${state.autoSpeak ? 'checked' : ''}> Speak answers aloud in Review</label>
    </div>

    <div class="card">
      <h2>Backup</h2>
      <p class="small muted">Your progress lives on this phone. Export a backup now and then.</p>
      <div class="btn-row">
        <button class="btn ghost" id="export">Export progress</button>
        <label class="btn ghost">Import<input type="file" id="import" accept="application/json,.json" hidden></label>
      </div>
    </div>

    <p class="small muted">Lessons and audio: <a href="https://www.languagetransfer.org/french">Language Transfer</a>, the free course by Mihalis Eleftheriou. If it helps you, consider <a href="https://www.languagetransfer.org/french">supporting them</a>. Notes and drills in this app are study aids built from the audio.</p>`;

  const bar = $('#dl-bar'), msg = $('#dl-msg');
  const run = async (stream, total) => {
    $('#dl').disabled = true;
    navigator.storage?.persist?.();
    let saved = 0;
    try {
      await ingestZip(stream, total, (p, n) => {
        if (n) saved++;
        bar.style.width = `${p * 100}%`;
        msg.textContent = `Downloading… ${Math.round(p * 100)}% · ${saved} lessons saved`;
      });
      toast('All lessons saved. They now play offline.');
    } catch (e) {
      toast(`Stopped: ${e.message || e}. Tap download again to retry.`);
    }
    viewMore();
  };
  $('#dl').onclick = async () => {
    msg.textContent = 'Connecting…';
    try {
      const res = await fetch(ZIP_URL);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      run(res.body, +res.headers.get('content-length') || ZIP_SIZE);
    } catch (e) { msg.textContent = `Couldn't start the download (${e.message}). Try again on Wi-Fi.`; }
  };
  $('#imp').onchange = async e => {
    const files = [...e.target.files];
    for (const f of files) {
      if (/\.zip$/i.test(f.name)) await run(f.stream(), f.size);
      else { const m = f.name.match(/(\d+)\D*\.mp3$/i); if (m) await putAudio(+m[1], f); }
    }
    toast(`Imported ${files.length} file${files.length > 1 ? 's' : ''}.`);
    viewMore();
  };
  $('#clear').onclick = async () => {
    if (!confirm('Delete all saved lesson audio from this phone?')) return;
    await clearAudio(); playing = null; audio.removeAttribute('src'); updateMini(); viewMore();
  };
  $('#finish').onchange = e => { state.finishBy = e.target.value || DEFAULT_FINISH; save(); };
  $('#autosay').onchange = e => { state.autoSpeak = e.target.checked; save(); };
  $('#export').onclick = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(state)], { type: 'application/json' }));
    a.download = `french-progress-${isoOfDay(today())}.json`; a.click();
  };
  $('#import').onchange = async e => {
    try {
      const data = JSON.parse(await e.target.files[0].text());
      if (!data.cards || !data.done) throw new Error('not a progress file');
      Object.assign(state, data); save(); updateBadge(); toast('Progress restored.');
    } catch (err) { toast(`Import failed: ${err.message}`); }
  };
}

// ---------- router ----------
async function route() {
  onTick = () => {};
  view.onclick = null;
  const h = location.hash || '#/today';
  const [, a, b, c] = h.split('/');
  const tab = { lesson: 'lessons', unit: 'practice' }[a] || (a === 'review' && b === 'unit' ? 'practice' : a);
  document.querySelectorAll('.tabs a').forEach(t => t.classList.toggle('on', t.dataset.tab === tab));
  if (a === 'lesson') await viewLesson(+b);
  else if (a === 'lessons') viewLessons();
  else if (a === 'practice') viewPractice();
  else if (a === 'unit') viewUnit(b, c);
  else if (a === 'review' && b === 'lesson') {
    const l = await loadLesson(+c);
    await viewReview({ ids: l.drills.map(d => cardId(l.n, d)), cram: true, heading: `Lesson ${l.n} drills` });
  } else if (a === 'review' && b === 'unit') {
    const deck = c, u = decks[deck]?.units.find(x => x.id === h.split('/')[4]);
    if (!u) { location.hash = '#/practice'; return; }
    const ids = unitIds(deck, u);
    const fresh = !unitStarted(deck, u);
    addIds(ids); save(); updateBadge();
    const due = ids.filter(id => state.cards[id].due <= today());
    await viewReview(due.length ? { ids: due, heading: u.title } : { ids, cram: true, heading: u.title });
    if (fresh) logActivity();
  } else if (a === 'review') await viewReview();
  else if (a === 'more') await viewMore();
  else await viewToday();
  updateMini();
  window.scrollTo(0, 0);
}
addEventListener('hashchange', route);
document.addEventListener('visibilitychange', () => { if (document.hidden) save(); else updateBadge(); });

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
await Promise.all([loadIndex(), loadDecks()]);
updateBadge();
route();
