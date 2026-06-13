/* ============================================================
   DATA MODEL  (unified WYSIWYG editor)
   A song = { meta: {...}, lines: [ line, ... ] }
   line types:
     { type:'section', label:'Verse 1' }
     { type:'lyric', text:'And can it be...', chords:[ {off, chord}, ... ] }
   A lyric line is a single string of plain text plus a list of chord
   anchors, each pinned to a character offset into that text. A blank line
   is just a lyric line whose text is empty.

   The editor surface is ONE contenteditable holding pure lyric text (one
   <div class="line"> per song line). Chords live in a separate overlay
   layer drawn ABOVE the words, so the text stays a clean, natively
   editable document: select across lines, cut/copy/paste, Enter for a new
   line — all the normal text-editor behaviours work for free. Chord
   anchors are kept in sync with the text as it changes.
   ============================================================ */

let song = { meta: {}, lines: [] };
const META_ORDER = ['title','artist','key','tempo','time'];
const META_KEEP = ['roadmap','notes','ccli_license','ccli','copyright','footer']; // preserved, edited/handled outside the meta inputs

/* A line counts as a section heading when, on its own, it reads like one:
   "Verse 1", "Chorus", "[Bridge]", "Pre-Chorus", "Tag", "Hook:" etc. */
const SECTION_RE = /^\s*\[?\s*(pre[-\s]?chorus|chorus|verse|bridge|intro|outro|tag|interlude|refrain|ending|vamp|instrumental|solo|coda|hook|breakdown|turnaround|reprise|chant)(\s*\d+\s*\w?)?(\s*[:\-–].*)?\s*\]?\s*$/i;

/* ============================================================
   UNDO / REDO
   Snapshot the whole song (deep JSON clone). Structural changes snapshot
   immediately; typing snapshots once per burst (debounced) so one undo
   reverts a whole typing run, not each letter.
   ============================================================ */
let undoStack = [];
let redoStack = [];
const HISTORY_LIMIT = 100;
let typingTimer = null;

function snapshot(){ return JSON.stringify(song); }
function restore(s){ song = JSON.parse(s); }

/* ============================================================
   PROJECT LIBRARY (multiple songs saved in-browser)
   - chordscribe:index      → [{id, title, updatedAt}]  (lightweight list)
   - chordscribe:proj:<id>   → the full song object for one project
   - chordscribe:current     → id of the project currently open
   The currently-open project IS the global `song`; edits autosave into
   its own slot (saveLocal, below), so switching projects never clobbers.
   ============================================================ */
const IDX_KEY    = 'chordscribe:index';
const PROJ_KEY   = id => 'chordscribe:proj:' + id;
const CUR_KEY    = 'chordscribe:current';
const LEGACY_KEY = 'chordscribe:song';     // pre-library single autosave slot
let currentProjectId = null;
let saveTimer = null;

function uid(){ return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2,7); }
function projectTitle(s){ return ((s && s.meta && s.meta.title) || '').trim() || 'Untitled'; }

function readIndex(){
  try { const a = JSON.parse(localStorage.getItem(IDX_KEY)); return Array.isArray(a) ? a : []; }
  catch(e){ return []; }
}
function writeIndex(idx){ try { localStorage.setItem(IDX_KEY, JSON.stringify(idx)); } catch(e){} }

function loadProjectSong(id){
  try {
    const raw = localStorage.getItem(PROJ_KEY(id));
    if(!raw) return null;
    const s = JSON.parse(raw);
    if(s && Array.isArray(s.lines) && s.meta) return s;   // sanity-check shape
  } catch(e){}
  return null;
}

// Persist a song into a project slot and refresh its index entry (title + time).
function writeProject(id, s){
  try {
    localStorage.setItem(PROJ_KEY(id), JSON.stringify(s));
    const idx = readIndex();
    const entry = idx.find(p => p.id === id);
    const now = Date.now();
    if(entry){ entry.title = projectTitle(s); entry.updatedAt = now; }
    else idx.push({ id, title: projectTitle(s), updatedAt: now });
    writeIndex(idx);
  } catch(e){ /* quota exceeded / private mode — fail silently */ }
}

// debounced autosave of the open project (called from history pushes)
function saveLocal(){
  if(saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {       // debounced so typing doesn't hammer storage
    saveTimer = null;
    if(currentProjectId) writeProject(currentProjectId, song);
  }, 400);
}
// flush any pending debounced save immediately (before switching projects)
function flushSave(){
  if(saveTimer){ clearTimeout(saveTimer); saveTimer = null; }
  if(currentProjectId) writeProject(currentProjectId, song);
}

function setCurrentProject(id){
  currentProjectId = id;
  try { localStorage.setItem(CUR_KEY, id); } catch(e){}
}

// Decide which song to show at startup: migrate the old single slot if present,
// else open the last-open (or most recent) project, else fall back to the sample.
function bootProjects(){
  let idx = readIndex();
  if(idx.length === 0){
    let migrated = null;
    try {
      const raw = localStorage.getItem(LEGACY_KEY);
      if(raw){ const s = JSON.parse(raw); if(s && Array.isArray(s.lines) && s.meta) migrated = s; }
    } catch(e){}
    const first = migrated || parseChordPro(SAMPLE);
    const id = uid();
    setCurrentProject(id);
    writeProject(id, first);
    try { localStorage.removeItem(LEGACY_KEY); } catch(e){}
    return first;
  }
  let cur = null;
  try { cur = localStorage.getItem(CUR_KEY); } catch(e){}
  if(!cur || !idx.find(p => p.id === cur)){
    cur = idx.slice().sort((a,b) => b.updatedAt - a.updatedAt)[0].id;
  }
  setCurrentProject(cur);
  return loadProjectSong(cur) || parseChordPro(SAMPLE);
}

function pushHistory(){
  if(typingTimer){ clearTimeout(typingTimer); typingTimer = null; }
  undoStack.push(snapshot());
  if(undoStack.length > HISTORY_LIMIT) undoStack.shift();
  redoStack = [];
  saveLocal();
}

function pushHistoryTyping(){
  if(typingTimer === null){
    undoStack.push(snapshot());
    if(undoStack.length > HISTORY_LIMIT) undoStack.shift();
    redoStack = [];
  } else {
    clearTimeout(typingTimer);
  }
  typingTimer = setTimeout(() => { typingTimer = null; }, 700);
  saveLocal();
}

function undo(){
  if(typingTimer){ clearTimeout(typingTimer); typingTimer = null; }
  if(undoStack.length === 0) return;
  redoStack.push(snapshot());
  restore(undoStack.pop());
  render();
  saveLocal();
}
function redo(){
  if(redoStack.length === 0) return;
  undoStack.push(snapshot());
  restore(redoStack.pop());
  render();
  saveLocal();
}

document.addEventListener('keydown', e => {
  const mod = e.ctrlKey || e.metaKey;
  if(!mod) return;
  const k = e.key.toLowerCase();
  if(k === 'z' && !e.shiftKey){ e.preventDefault(); undo(); }
  else if((k === 'z' && e.shiftKey) || k === 'y'){ e.preventDefault(); redo(); }
});

/* ============================================================
   PARSER: ChordPro  ->  model
   ============================================================ */
function parseChordPro(text){
  const out = { meta:{}, lines:[] };
  const raw = text.replace(/\r\n/g,'\n').split('\n');
  for(let line of raw){
    const dir = line.match(/^\s*\{\s*([a-zA-Z_]+)\s*:?\s*(.*?)\s*\}\s*$/);
    if(dir){
      const key = dir[1].toLowerCase();
      const val = dir[2];
      if(key==='comment' || key==='c'){
        out.lines.push({ type:'section', label: val });
      } else {
        out.meta[key] = val.replace(/\\n/g,'\n');   // decode escaped newlines (notes)
      }
      continue;
    }
    if(line.trim()===''){ out.lines.push({type:'lyric', text:'', chords:[]}); continue; }
    out.lines.push(lineFromSegments(parseSegments(line)));
  }
  // Trim leading blanks (e.g. the separator the serializer writes after the
  // metadata block) so they don't accumulate across export/import round trips.
  while(out.lines.length && isBlank(out.lines[0])) out.lines.shift();
  // Trim trailing blanks
  while(out.lines.length && isBlank(out.lines[out.lines.length-1])) out.lines.pop();
  return out;
}

function parseSegments(line){
  const segs = [];
  const re = /\[([^\]]*)\]/g;
  let last = 0, m;
  let pendingChord = null;
  while((m = re.exec(line)) !== null){
    const textBefore = line.slice(last, m.index);
    if(textBefore.length || pendingChord!==null){
      segs.push({ chord: pendingChord, text: textBefore });
    }
    pendingChord = m[1];
    last = re.lastIndex;
  }
  const tail = line.slice(last);
  if(tail.length || pendingChord!==null){
    segs.push({ chord: pendingChord, text: tail });
  }
  if(segs.length===0) segs.push({chord:null, text:''});
  return segs;
}

/* segments (chord+text runs) -> {type:'lyric', text, chords[]} */
function lineFromSegments(segs){
  let text = '';
  const chords = [];
  for(const s of segs){
    if(s.chord!==null && s.chord!==undefined && s.chord!=='') chords.push({off: text.length, chord: s.chord});
    text += s.text;
  }
  return { type:'lyric', text, chords };
}

/* ============================================================
   MODEL HELPERS
   ============================================================ */
/* A line is "blank" only if it has no text AND no chords. A whitespace line
   that carries chords is an instrumental break, not a blank, so it still
   renders and exports its chords. */
function isBlank(ln){
  return ln.type==='lyric' && (ln.text||'').trim()==='' && (!ln.chords || ln.chords.length===0);
}
function visText(ln){ return ln.type==='section' ? ln.label : (ln.text||''); }
function visLen(ln){ return visText(ln).length; }

/* Decide what a line IS from its raw text, carrying chords through when it
   stays a lyric line. Returns a fresh line object. */
function classify(text, chords){
  if(text.trim()!=='' && SECTION_RE.test(text)){
    return { type:'section', label: text.replace(/\s+$/,'') };
  }
  const safe = (chords||[]).filter(c => c.off>=0 && c.off<=text.length).map(c => ({off:c.off, chord:c.chord}));
  return { type:'lyric', text, chords: safe };
}

/* Derive chord+text segments (each chord starts a run) for export/serialize. */
function segmentsOf(ln){
  const chords = (ln.chords||[]).slice().sort((a,b)=>a.off-b.off);
  const text = ln.text || '';
  const segs = [];
  const first = chords.length ? chords[0].off : text.length;
  if(first>0 || chords.length===0) segs.push({chord:null, text: text.slice(0, first)});
  for(let i=0;i<chords.length;i++){
    const off = chords[i].off;
    const next = (i+1<chords.length) ? chords[i+1].off : text.length;
    segs.push({chord: chords[i].chord, text: text.slice(off, next)});
  }
  if(segs.length===0) segs.push({chord:null, text:''});
  return segs;
}

function lineToChordPro(ln){
  const chords = (ln.chords||[]).slice().sort((a,b)=>a.off-b.off);
  let out = '', pos = 0;
  for(const c of chords){ out += ln.text.slice(pos, c.off) + `[${c.chord}]`; pos = c.off; }
  out += ln.text.slice(pos);
  return out;
}

/* ============================================================
   SERIALIZER: model -> ChordPro source
   ============================================================ */
function toChordPro(s){
  const lines = [];
  const esc = v => String(v).replace(/\n/g,'\\n');     // keep directives single-line (notes)
  const emit = k => { if(s.meta[k]!==undefined && s.meta[k]!=='') lines.push(`{${k}: ${esc(s.meta[k])}}`); };
  for(const k of META_ORDER){ emit(k); }
  for(const k of META_KEEP){ emit(k); }
  for(const k in s.meta){
    if(!META_ORDER.includes(k) && !META_KEEP.includes(k)) emit(k);
  }
  lines.push('');
  for(const ln of s.lines){
    if(ln.type==='section'){ lines.push(`{comment: ${ln.label}}`); }
    else if(isBlank(ln)){ lines.push(''); }
    else { lines.push(lineToChordPro(ln)); }
  }
  return lines.join('\n');
}

/* ---------- stacked ASCII (chords over lyrics) for plain-text export ---------- */
function lineToAscii(ln){
  let lyric = '', chord = '';
  for(const seg of segmentsOf(ln)){
    const c = (seg.chord!==null && seg.chord!==undefined) ? seg.chord : '';
    if(c){ while(chord.length < lyric.length) chord += ' '; chord += c; }
    lyric += seg.text;
  }
  return { chords: chord.replace(/\s+$/,''), lyrics: lyric };
}

function lineToAnchors(ln){
  let lyric = '';
  const anchors = [];
  for(const seg of segmentsOf(ln)){
    const c = (seg.chord!==null && seg.chord!==undefined) ? seg.chord : '';
    if(c) anchors.push({ col: lyric.length, chord: c });
    lyric += seg.text;
  }
  return { lyrics: lyric, anchors };
}

function collectChords(){
  const set = [];
  for(const ln of song.lines){
    if(ln.type!=='lyric') continue;
    for(const c of (ln.chords||[])){
      if(c.chord && !set.includes(c.chord)) set.push(c.chord);
    }
  }
  return set;
}

/* ============================================================
   MODULATION  (transpose chords by semitones)
   A chord is root note + quality, optionally with a "/bass" note. We
   transpose the root and the bass, leaving the quality (m7, sus4, add9…)
   untouched. Accidental spelling follows the song key: a flat key spells
   the moved notes with flats, otherwise sharps.
   ============================================================ */
const SHARP_NOTES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const FLAT_NOTES  = ['C','Db','D','Eb','E','F','Gb','G','Ab','A','Bb','B'];
const NOTE_BASE = { C:0, D:2, E:4, F:5, G:7, A:9, B:11 };

function noteToIndex(note){
  let i = NOTE_BASE[note[0].toUpperCase()];
  if(i === undefined) return null;
  for(let k=1; k<note.length; k++){
    const ch = note[k];
    if(ch==='#' || ch==='♯') i++;
    else if(ch==='b' || ch==='♭') i--;
    else break;
  }
  return ((i % 12) + 12) % 12;
}

function transposeNote(note, semis, flats){
  const idx = noteToIndex(note);
  if(idx === null) return note;
  const ni = ((idx + semis) % 12 + 12) % 12;
  return (flats ? FLAT_NOTES : SHARP_NOTES)[ni];
}

/* Transpose a chord symbol (e.g. "F#m7", "D/F#") by `semis` half steps. */
function transposeChord(chord, semis, flats){
  if(!chord || !semis) return chord;
  return chord.split('/').map(part => {
    const m = part.match(/^(\s*)([A-Ga-g][#b♯♭]?)(.*)$/);
    if(!m) return part;
    return m[1] + transposeNote(m[2], semis, flats) + m[3];
  }).join('/');
}

/* Whether to spell moved notes with flats — follows the song key. */
function preferFlats(key){
  if(key && /[b♭]/.test(key.replace(/^.*\//,''))) return true;   // flat key
  return false;                                                  // default: sharps
}

/* Modulate the WHOLE song (every chord + the key field). */
function modulateSong(semis){
  const hasChords = song.lines.some(ln => ln.type==='lyric' && ln.chords && ln.chords.length);
  if(!hasChords && !song.meta.key){ toast('Nothing to modulate'); return; }
  const flats = preferFlats(song.meta.key);
  pushHistory();
  for(const ln of song.lines){
    if(ln.type!=='lyric' || !ln.chords) continue;
    for(const c of ln.chords) c.chord = transposeChord(c.chord, semis, flats);
  }
  if(song.meta.key) song.meta.key = transposeChord(song.meta.key, semis, flats);
  render();
  toast('Modulated ' + (semis>0 ? 'up' : 'down') + ' a half step');
}

/* Collect refs to the chords that fall inside the current text selection. */
function chordsInSelection(pos){
  const hits = [];
  for(let i=pos.sL; i<=pos.eL; i++){
    const ln = song.lines[i];
    if(ln.type!=='lyric' || !ln.chords) continue;
    for(const c of ln.chords){
      const inSel = (pos.sL===pos.eL) ? (c.off>=pos.sOff && c.off<=pos.eOff)
                  : (i===pos.sL)      ? (c.off>=pos.sOff)
                  : (i===pos.eL)      ? (c.off<=pos.eOff)
                  : true;
      if(inSel) hits.push(c);
    }
  }
  return hits;
}

/* Modulate only the chords above the highlighted words. */
function modulateSelection(semis){
  const pos = currentPos();
  if(!pos){ toast('Highlight some words first'); return; }
  const hits = chordsInSelection(pos);
  if(!hits.length){ toast('No chords in selection'); return; }
  const flats = preferFlats(song.meta.key);
  pushHistory();                       // snapshot BEFORE mutating
  for(const c of hits) c.chord = transposeChord(c.chord, semis, flats);
  // only chords (the overlay) changed — text DOM and the selection stay put
  positionChords();
  updateUndoButtons();
  requestAnimationFrame(updateSelToolbar);
  toast('Modulated selection ' + (semis>0 ? 'up' : 'down'));
}

/* ============================================================
   THE EDITOR  (unified, WYSIWYG)
   ============================================================ */
const editor = document.getElementById('editor');
const editorWrap = document.getElementById('editorWrap');
const chordLayer = document.getElementById('chordLayer');

function render(){
  chordSel = [];   // model is being rebuilt; old chord refs are now stale
  renderMeta();
  renderRoadmap();
  if(typeof view !== 'undefined' && view === 'source'){
    sourceEdit.value = toChordPro(song);
    autosizeSource();
  } else {
    renderEditor();
  }
  updateUndoButtons();
}

function updateUndoButtons(){
  const ub = document.getElementById('undoBtn'); if(ub) ub.disabled = undoStack.length === 0;
  const rb = document.getElementById('redoBtn'); if(rb) rb.disabled = redoStack.length === 0;
}

function renderMeta(){
  const bar = document.getElementById('metaBar');
  bar.innerHTML = '';
  const fields = [
    ['title','Title','title-inp'],
    ['artist','Artist',''],
    ['key','Key',''],
    ['tempo','Tempo',''],
    ['time','Time','']
  ];
  for(const [k,label,cls] of fields){
    const f = document.createElement('div'); f.className='field';
    const l = document.createElement('label'); l.textContent=label;
    const i = document.createElement('input');
    if(cls) i.className=cls;
    i.value = song.meta[k] || '';
    i.placeholder = label;
    i.oninput = e => { pushHistoryTyping(); song.meta[k] = e.target.value; };
    f.appendChild(l); f.appendChild(i); bar.appendChild(f);
  }
}

/* ---- Road map + Notes ----
   Both live in song.meta (meta.roadmap / meta.notes) so they round-trip
   through ChordPro, undo/redo and import/export like any other metadata.
   The road map is free-typed shorthand (e.g. "V1 V2 CH") shown back as
   chips; notes is a free-text reminder box that grows with its content. */
const roadmapInput = document.getElementById('roadmapInput');
const notesInput = document.getElementById('notesInput');
const roadmapChips = document.getElementById('roadmapChips');

function roadmapTokens(str){ return (str||'').split(/[\s,]+/).filter(Boolean); }

function buildRoadmapChips(){
  roadmapChips.innerHTML = '';
  for(const t of roadmapTokens(song.meta.roadmap)){
    const c = document.createElement('span'); c.className = 'rm-chip'; c.textContent = t;
    roadmapChips.appendChild(c);
  }
}

function autosizeNotes(){
  notesInput.style.height = 'auto';
  notesInput.style.height = notesInput.scrollHeight + 'px';
}

/* Reflect the model into the inputs (skip the one being typed in so the
   caret isn't disturbed). */
function renderRoadmap(){
  if(document.activeElement !== roadmapInput) roadmapInput.value = song.meta.roadmap || '';
  if(document.activeElement !== notesInput) notesInput.value = song.meta.notes || '';
  buildRoadmapChips();
  autosizeNotes();
}

function setMetaField(key, value){
  pushHistoryTyping();
  if(value.trim() === '') delete song.meta[key];
  else song.meta[key] = value;
  updateUndoButtons();
}

roadmapInput.addEventListener('input', e => {
  setMetaField('roadmap', e.target.value);
  buildRoadmapChips();
});
notesInput.addEventListener('input', e => {
  setMetaField('notes', e.target.value);
  autosizeNotes();
});

/* Build a single .line element for a model line. */
function buildLineEl(ln){
  const el = document.createElement('div');
  el.className = 'line' + (ln.type==='section' ? ' sec' : '') + (isBlank(ln) ? ' blank' : '');
  const text = visText(ln);
  if(text === '') el.appendChild(document.createElement('br'));
  else el.appendChild(document.createTextNode(text));
  el.__line = ln;
  return el;
}

function renderEditor(){
  editor.innerHTML = '';
  chordLayer.innerHTML = '';
  if(song.lines.length === 0){
    song.lines.push({type:'lyric', text:'', chords:[]});
  }
  for(const ln of song.lines) editor.appendChild(buildLineEl(ln));
  positionChords();
}

/* Refresh a single line element's class to match its (possibly changed) type. */
function refreshClass(el){
  const ln = el.__line;
  el.className = 'line' + (ln.type==='section' ? ' sec' : '') + (isBlank(ln) ? ' blank' : '');
}

/* ---- chord overlay placement ---- */
/* The x of a character offset within a line, in editorWrap content coords. */
function chordX(el, off){
  const tn = el.firstChild;
  if(!tn || tn.nodeType !== 3) return lineContentLeft(el);   // empty line: no text node
  const wrapLeft = editorWrap.getBoundingClientRect().left;
  const len = tn.length;
  const o = Math.max(0, Math.min(off, len));
  const r = document.createRange();
  // A collapsed range in the middle of the text gives us the left edge directly.
  if(o < len){
    r.setStart(tn, o); r.setEnd(tn, o);
    const rects = r.getClientRects();
    if(rects.length) return rects[0].left - wrapLeft;
  }
  // At the end of the text node, a collapsed range returns no rects in
  // WebKit/Blink, so measure the last character and take its right edge.
  if(o > 0){
    r.setStart(tn, o-1); r.setEnd(tn, o);
    const rects = r.getClientRects();
    if(rects.length) return rects[rects.length-1].right - wrapLeft;
  }
  return lineContentLeft(el);
}

/* Width of one space in the editor font (cached; reset on font change). */
let _spaceW = null;
function getSpaceWidth(){
  if(_spaceW) return _spaceW;
  const s = document.createElement('span');
  const cs = getComputedStyle(editor);
  s.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;';
  s.style.fontFamily = cs.fontFamily;
  s.style.fontSize = cs.fontSize;
  s.textContent = ' '.repeat(20);
  editorWrap.appendChild(s);
  _spaceW = (s.getBoundingClientRect().width / 20) || 8;
  s.remove();
  return _spaceW;
}

/* Left edge of a line's text content, in editorWrap coords. */
function lineContentLeft(el){
  const pl = parseFloat(getComputedStyle(el).paddingLeft) || 0;
  return el.getBoundingClientRect().left + pl - editorWrap.getBoundingClientRect().left;
}

/* x of a free column (for placing chords on empty / instrumental lines). */
function chordXForColumn(el, col){ return lineContentLeft(el) + col * getSpaceWidth(); }

/* Gap (px) kept between adjacent free-placed chord tags so they read clearly. */
const CHORD_MIN_GAP = 6;

/* ---- multi-select of free-placed chords (marquee / shift-click) ----
   chordSel holds {ln, c} pairs referencing live model chord objects, so the
   selection survives positionChords() re-renders (the model objects persist). */
let chordSel = [];
let marqueeActive = false;
function isFreePlacedLine(ln){ return ln && ln.type==='lyric' && (ln.text||'').trim()===''; }
function isChordSelected(c){ return chordSel.some(s => s.c === c); }
function clearChordSel(){ if(chordSel.length){ chordSel = []; paintSelection(); } }
function toggleChordSel(ln, c){
  const i = chordSel.findIndex(s => s.c === c);
  if(i>=0) chordSel.splice(i,1); else chordSel.push({ ln, c });
  paintSelection();
}
function mergeSel(base, add){
  const out = base.slice();
  for(const a of add){ if(!out.some(s => s.c === a.c)) out.push(a); }
  return out;
}
/* Refresh just the .selected classes without re-laying-out the chords. */
function paintSelection(){
  for(const t of chordLayer.children){ if(t.__c) t.classList.toggle('selected', isChordSelected(t.__c)); }
}

/* ---- copy / cut / paste of selected chords ----
   chordClip stores each chord with a column offset relative to the left-most
   one, so a paste re-creates the same shape (and varying gaps) at a new anchor.
   This is an in-app clipboard; it doesn't touch the system clipboard. */
let chordClip = null;
let lastMouseX = 0, lastMouseY = 0;
document.addEventListener('mousemove', e => { lastMouseX = e.clientX; lastMouseY = e.clientY; });

function copyChordSel(){
  if(!chordSel.length) return false;
  const min = Math.min(...chordSel.map(s => s.c.off));
  chordClip = chordSel.map(s => ({ chord: s.c.chord, rel: s.c.off - min }));
  return true;
}
function deleteChordSel(){
  if(!chordSel.length) return false;
  pushHistory();
  for(const s of chordSel){ s.ln.chords = s.ln.chords.filter(c => c !== s.c); }
  chordSel = [];
  renderEditor();
  updateUndoButtons();
  return true;
}
function cutChordSel(){
  if(!copyChordSel()) return false;
  return deleteChordSel();
}
/* Paste the clipboard onto a target line, anchoring the left-most chord at the
   column under the cursor and selecting the result so it can be nudged. */
function pasteChords(lineEl){
  if(!chordClip || !chordClip.length || !lineEl) return false;
  const ln = lineEl.__line;
  if(ln.type !== 'lyric') return false;
  const t = computeTarget(lineEl, lastMouseX);
  const base = t ? t.off : (ln.text || '').length;
  pushHistory();
  const maxOff = base + Math.max(...chordClip.map(c => c.rel));
  if((ln.text || '').trim() === '' && (ln.text || '').length < maxOff){
    ln.text = (ln.text || '') + ' '.repeat(maxOff - (ln.text || '').length);
  }
  const newSel = [];
  for(const item of chordClip){
    const off = base + item.rel;
    ln.chords = (ln.chords || []).filter(c => c.off !== off);
    const nc = { off, chord: item.chord };
    ln.chords.push(nc);
    newSel.push({ ln, c: nc });
  }
  ln.chords.sort((a,b)=>a.off-b.off);
  renderEditor();
  chordSel = newSel;
  paintSelection();
  updateUndoButtons();
  return true;
}

/* ---- copy / place chord ROWS across sections (chords only, no lyrics) ----
   Use case: verse 1 has nicely formatted chords you want to reuse on verse 2,
   whose words don't line up. Each selected lyric line's chords are stored
   anchored to a WORD (which word, and how far into it) rather than an absolute
   column, so they can be re-snapped onto another set of lines and then cleaned
   up by hand. Separate from chordClip (the column-exact, lyrics-free in-app
   clipboard used by Cmd+C/V on free-placed lines). */
let chordRowClip = null;

/* Start/end column of every run of non-space characters (a "word"). */
function wordSpans(text){
  const spans = []; const re = /\S+/g; let m;
  while((m = re.exec(text))) spans.push({ start: m.index, end: m.index + m[0].length });
  return spans;
}
/* Anchor an absolute chord offset to the nearest word: { wi, within }, where
   `within` is the offset into that word (negative = sits in the gap before it).
   Offsets past the last word anchor to the line end (wi = -1). */
function anchorChord(off, spans, textLen){
  let wi = spans.findIndex(s => off >= s.start && off < s.end);
  if(wi >= 0) return { wi, within: off - spans[wi].start };
  wi = spans.findIndex(s => s.start > off);            // first word after the gap
  if(wi >= 0) return { wi, within: off - spans[wi].start };   // within < 0
  return { wi: -1, within: off - textLen };            // trailing: end-anchored
}
/* Resolve a word anchor back to a column on a target line's words. */
function resolveAnchor(a, spans, textLen){
  if(a.wi < 0) return Math.max(0, Math.min(textLen + a.within, textLen));   // end-anchored
  if(a.wi >= spans.length) return textLen;             // fewer words here: park at the end
  const s = spans[a.wi];
  let off = s.start + a.within;
  if(a.within >= 0) off = Math.min(off, s.end);        // keep it on (or just past) the word
  return Math.max(0, Math.min(off, textLen));
}

/* Copy the chord pattern from the highlighted lyric lines (no lyrics). One row
   per non-blank lyric line so line N maps to line N when placed. */
function copyChordRows(){
  const pos = currentPos();
  if(!pos) return false;
  const rows = [];
  for(let i=pos.sL; i<=pos.eL; i++){
    const ln = song.lines[i];
    if(ln.type !== 'lyric' || isBlank(ln)) continue;
    const spans = wordSpans(ln.text || '');
    rows.push((ln.chords || []).map(c => {
      const a = anchorChord(c.off, spans, (ln.text||'').length);
      return { wi: a.wi, within: a.within, chord: c.chord };
    }));
  }
  if(!rows.length){ toast('Select lines with chords first'); return false; }
  chordRowClip = rows;
  toast('Copied chords from ' + rows.length + ' line' + (rows.length>1?'s':''));
  return true;
}

/* Snap the copied chord rows onto the highlighted lines, approximating word
   positions. Overwrites each target line's chords so the pattern lands clean. */
function placeChordRows(){
  if(!chordRowClip || !chordRowClip.length){ toast('Copy chords from a section first'); return; }
  const pos = currentPos();
  if(!pos) return;
  const targets = [];
  for(let i=pos.sL; i<=pos.eL; i++){
    const ln = song.lines[i];
    if(ln.type === 'lyric' && !isBlank(ln)) targets.push(ln);
  }
  if(!targets.length){ toast('Select the lines to place chords on'); return; }
  pushHistory();                       // snapshot BEFORE mutating
  const n = Math.min(targets.length, chordRowClip.length);
  for(let k=0; k<n; k++){
    const ln = targets[k];
    const text = ln.text || '';
    const spans = wordSpans(text);
    const used = new Set();
    const placed = [];
    for(const a of chordRowClip[k]){
      let off = resolveAnchor(a, spans, text.length);
      while(used.has(off) && off < text.length) off++;   // don't stack two on one column
      used.add(off);
      placed.push({ off, chord: a.chord });
    }
    placed.sort((x,y)=>x.off-y.off);
    ln.chords = placed;
  }
  renderEditor();
  updateUndoButtons();
  requestAnimationFrame(updateSelToolbar);
  toast('Placed chords on ' + n + ' line' + (n>1?'s':''));
}

function positionChords(){
  chordLayer.innerHTML = '';
  for(const el of editor.children){
    const ln = el.__line;
    if(!ln || ln.type!=='lyric' || !ln.chords || !ln.chords.length) continue;
    const top = el.offsetTop;
    // On instrumental/blank lines the chords are free-placed over whitespace, so
    // a single space-width per column packs them tighter than the export, where
    // cells grow to fit each chord. Lay them out, then push any that would
    // overlap to the right so the editor reads like the export preview.
    const freePlaced = (ln.text||'').trim()==='';
    const placed = [];
    for(const c of ln.chords){
      const tag = document.createElement('span');
      tag.className = 'ed-chord' + (isChordSelected(c) ? ' selected' : '');
      tag.textContent = c.chord;
      tag.style.left = chordX(el, c.off) + 'px';
      tag.style.top = top + 'px';
      tag.dataset.off = c.off;
      tag.__c = c; tag.__ln = ln;
      tag.onmousedown = ev => startChordDrag(ev, el, c, tag);
      tag.onclick = ev => ev.stopPropagation(); // don't let it bubble to closePop
      chordLayer.appendChild(tag);
      placed.push({ tag, left: parseFloat(tag.style.left) });
    }
    if(freePlaced && placed.length > 1){
      placed.sort((a,b) => a.left - b.left);
      for(let i=1; i<placed.length; i++){
        const prev = placed[i-1];
        // offsetWidth is the truth; if layout isn't ready (0), estimate from the
        // chord's character count so we still spread rather than silently stack.
        const w = prev.tag.offsetWidth || (prev.tag.textContent.length * getSpaceWidth() + 6);
        const minLeft = prev.left + w + CHORD_MIN_GAP;
        if(placed[i].left < minLeft){
          placed[i].left = minLeft;
          placed[i].tag.style.left = minLeft + 'px';
        }
      }
    }
  }
}

/* ---- mapping between DOM selection and (line, offset) ---- */
function lineElOf(node){
  let el = node;
  while(el && el !== editor){
    if(el.parentNode === editor) return el;
    el = el.parentNode;
  }
  return null;
}
function lineIndexOfEl(el){ return Array.prototype.indexOf.call(editor.children, el); }
function offsetInEl(el, node, nodeOffset){
  if(node === el) return 0;             // caret on the element itself (empty line)
  if(node.nodeType === 3) return nodeOffset;
  return 0;
}
function caretLineEl(){
  const sel = getSelection();
  if(!sel.rangeCount) return null;
  return lineElOf(sel.getRangeAt(0).startContainer);
}
function currentPos(){
  const sel = getSelection();
  if(!sel.rangeCount) return null;
  const r = sel.getRangeAt(0);
  const sEl = lineElOf(r.startContainer), eEl = lineElOf(r.endContainer);
  if(!sEl || !eEl) return null;
  return {
    sL: lineIndexOfEl(sEl), sOff: offsetInEl(sEl, r.startContainer, r.startOffset),
    eL: lineIndexOfEl(eEl), eOff: offsetInEl(eEl, r.endContainer, r.endOffset),
    collapsed: r.collapsed
  };
}
function setCaret(lineIndex, off){
  const el = editor.children[lineIndex];
  if(!el) return;
  const tn = el.firstChild;
  const r = document.createRange();
  if(tn && tn.nodeType === 3) r.setStart(tn, Math.max(0, Math.min(off, tn.length)));
  else r.setStart(el, 0);
  r.collapse(true);
  const sel = getSelection();
  sel.removeAllRanges(); sel.addRange(r);
}

/* ---- keeping chord anchors glued to the text as it changes ---- */
/* A single contiguous edit turned old text into new text. Shift / clamp /
   drop chord offsets accordingly (common-prefix + common-suffix diff). */
function syncChords(ln, nt){
  const ot = ln.text;
  if(ot === nt){ return; }
  let p = 0;
  const minLen = Math.min(ot.length, nt.length);
  while(p < minLen && ot[p] === nt[p]) p++;
  let s = 0;
  while(s < (minLen - p) && ot[ot.length-1-s] === nt[nt.length-1-s]) s++;
  const oldEnd = ot.length - s;
  const delta = nt.length - ot.length;
  const seen = new Set();
  ln.chords = ln.chords.map(c => {
    let o = c.off;
    if(o <= p){ /* before the change */ }
    else if(o >= oldEnd) o += delta;
    else o = p;                            // inside the replaced span -> collapse to its start
    return { off: o, chord: c.chord };
  }).filter(c => {
    if(c.off < 0 || c.off > nt.length) return false;
    if(seen.has(c.off)) return false;       // de-dupe collisions
    seen.add(c.off); return true;
  }).sort((a,b)=>a.off-b.off);
}

/* Pull a single line's text from the DOM into the model after a native edit. */
function syncLine(el){
  pushHistoryTyping();
  const text = el.textContent;
  const ln = el.__line;
  const becomes = classify(text, (ln && ln.type==='lyric') ? ln.chords : []);
  if(ln && ln.type==='lyric' && becomes.type==='lyric'){
    syncChords(ln, text);                   // keep same object so chords stay glued
    ln.text = text;
  } else {
    const i = lineIndexOfEl(el);
    if(i>=0) song.lines[i] = becomes;
    el.__line = becomes;
  }
  refreshClass(el);
  positionChords();
  updateUndoButtons();
}

/* ---- the one structural primitive: replace a range with fragments ----
   Each fragment is { text, chords } (chord offsets relative to that
   fragment's text). The first fragment merges into the surviving prefix of
   the start line, the last into the suffix of the end line, and any middle
   fragments are inserted whole — so chords survive paste, Enter, merges and
   multi-line deletes. classify() re-detects section headings from the text. */
function spliceFragments(sL, sOff, eL, eOff, frags){
  pushHistory();
  const lines = song.lines;
  const startLn = lines[sL], endLn = lines[eL];
  const prefix = visText(startLn).slice(0, sOff);
  const suffix = visText(endLn).slice(eOff);
  const prefixChords = (startLn.type==='lyric' ? startLn.chords : [])
    .filter(c => c.off <= sOff).map(c => ({off: Math.min(c.off, sOff), chord: c.chord}));
  const suffixChords = (endLn.type==='lyric' ? endLn.chords : [])
    .filter(c => c.off >= eOff).map(c => ({off: c.off - eOff, chord: c.chord}));

  const newLines = [];
  let caretLine, caretOff;
  const shift = (chords, by) => chords.map(c => ({off: c.off + by, chord: c.chord}));

  if(frags.length === 1){
    const f = frags[0];
    const text = prefix + f.text + suffix;
    const chords = prefixChords
      .concat(shift(f.chords, prefix.length))
      .concat(shift(suffixChords, prefix.length + f.text.length));
    newLines.push(classify(text, chords));
    caretLine = sL; caretOff = prefix.length + f.text.length;
  } else {
    const f0 = frags[0];
    newLines.push(classify(prefix + f0.text, prefixChords.concat(shift(f0.chords, prefix.length))));
    for(let i=1; i<frags.length-1; i++) newLines.push(classify(frags[i].text, frags[i].chords.slice()));
    const fl = frags[frags.length-1];
    newLines.push(classify(fl.text + suffix, fl.chords.concat(shift(suffixChords, fl.text.length))));
    caretLine = sL + newLines.length - 1; caretOff = fl.text.length;
  }

  lines.splice(sL, eL - sL + 1, ...newLines);
  renderEditor();
  setCaret(caretLine, caretOff);
  updateUndoButtons();
}

/* Plain-text replace: split on newlines into chord-free fragments. */
function replaceRange(sL, sOff, eL, eOff, insertText){
  spliceFragments(sL, sOff, eL, eOff, insertText.split('\n').map(p => ({text: p, chords: []})));
}

function mergeWithPrev(i){
  replaceRange(i-1, visLen(song.lines[i-1]), i, 0, '');
}

/* Pull the selected range out as chord-carrying fragments (for copy/cut). */
function extractFragments(pos){
  const frags = [];
  for(let i=pos.sL; i<=pos.eL; i++){
    const ln = song.lines[i];
    const len = visLen(ln);
    const a = (i===pos.sL) ? pos.sOff : 0;
    const b = (i===pos.eL) ? pos.eOff : len;
    const text = visText(ln).slice(a, b);
    const chords = (ln.type==='lyric' ? ln.chords : [])
      .filter(c => c.off>=a && (c.off<b || (c.off===b && b===len)))
      .map(c => ({off: c.off-a, chord: c.chord}));
    frags.push({ text, chords });
  }
  return frags;
}
function cloneFrags(frags){
  return frags.map(f => ({ text: f.text, chords: f.chords.map(c => ({off:c.off, chord:c.chord})) }));
}

/* ---- editor event wiring ---- */
editor.addEventListener('beforeinput', e => {
  const it = e.inputType;
  // paste / cut are handled by their own events (cleaner clipboard text)
  if(it === 'insertFromPaste' || it === 'insertFromDrop' || it === 'deleteByCut'){ e.preventDefault(); return; }

  const pos = currentPos();
  if(!pos) return;

  if(it === 'insertParagraph' || it === 'insertLineBreak'){
    e.preventDefault();
    replaceRange(pos.sL, pos.sOff, pos.eL, pos.eOff, '\n', true);
    return;
  }

  if(it === 'deleteContentBackward' && pos.collapsed){
    if(pos.sOff === 0){ e.preventDefault(); if(pos.sL > 0) mergeWithPrev(pos.sL); }
    return; // otherwise native intra-line delete
  }
  if(it === 'deleteContentForward' && pos.collapsed){
    const len = visLen(song.lines[pos.sL]);
    if(pos.sOff >= len){ e.preventDefault(); if(pos.sL < song.lines.length-1) mergeWithPrev(pos.sL+1); }
    return;
  }

  // anything spanning more than one line, we drive ourselves
  if(pos.sL !== pos.eL){
    e.preventDefault();
    const ins = it.startsWith('insert') ? (e.data || '') : '';
    replaceRange(pos.sL, pos.sOff, pos.eL, pos.eOff, ins, true);
    return;
  }
  // single-line insert / delete with a selection or caret -> native, reconciled on 'input'
});

editor.addEventListener('input', () => {
  const el = caretLineEl();
  if(el) syncLine(el);
});

/* Internal clipboard: remembers the chords of whatever was copied/cut inside
   the editor. The system clipboard still gets clean lyric text (so pasting
   into other apps is plain), but when the pasted text matches what we stored
   we re-insert the rich fragments so chords come along. */
let internalClip = null;

editor.addEventListener('copy', e => {
  const pos = currentPos();
  if(!pos || pos.collapsed) return;
  const text = selectedText(pos);
  e.clipboardData.setData('text/plain', text);
  e.preventDefault();
  internalClip = { text, frags: extractFragments(pos) };
});

editor.addEventListener('cut', e => {
  const pos = currentPos();
  if(!pos || pos.collapsed) return;
  const text = selectedText(pos);
  e.clipboardData.setData('text/plain', text);
  e.preventDefault();
  internalClip = { text, frags: extractFragments(pos) };
  replaceRange(pos.sL, pos.sOff, pos.eL, pos.eOff, '');
});

editor.addEventListener('paste', e => {
  e.preventDefault();
  const t = ((e.clipboardData || window.clipboardData).getData('text/plain') || '')
    .replace(/\r\n/g,'\n').replace(/\r/g,'\n');
  const pos = currentPos(); if(!pos) return;
  if(internalClip && t === internalClip.text){
    spliceFragments(pos.sL, pos.sOff, pos.eL, pos.eOff, cloneFrags(internalClip.frags));
  } else {
    replaceRange(pos.sL, pos.sOff, pos.eL, pos.eOff, t);
  }
});

function selectedText(pos){
  const parts = [];
  for(let i=pos.sL; i<=pos.eL; i++){
    const t = visText(song.lines[i]);
    let a = (i===pos.sL) ? pos.sOff : 0;
    let b = (i===pos.eL) ? pos.eOff : t.length;
    parts.push(t.slice(a, b));
  }
  return parts.join('\n');
}

/* ============================================================
   SELECTION TOOLBAR — appears above a highlighted range with bulk actions
   (currently: strip every chord from the lines the selection touches).
   ============================================================ */
let selToolbar = null;
function ensureSelToolbar(){
  if(selToolbar) return;
  selToolbar = document.createElement('div');
  selToolbar.className = 'sel-toolbar';
  const btn = document.createElement('button');
  btn.textContent = '⌫ Clear chords';
  btn.title = 'Remove all chords from the highlighted lines';
  // mousedown (not click) + preventDefault keeps the text selection alive
  btn.addEventListener('mousedown', e => { e.preventDefault(); clearChordsInSelection(); });
  selToolbar.appendChild(btn);

  const secBtn = document.createElement('button');
  secBtn.textContent = '¶ Section';
  secBtn.title = 'Turn the highlighted lines into section headings (toggle)';
  secBtn.addEventListener('mousedown', e => { e.preventDefault(); makeSectionFromSelection(); });
  selToolbar.appendChild(secBtn);

  const modDown = document.createElement('button');
  modDown.textContent = '♭ −1';
  modDown.title = 'Transpose the highlighted chords down a half step';
  modDown.addEventListener('mousedown', e => { e.preventDefault(); modulateSelection(-1); });
  selToolbar.appendChild(modDown);

  const modUp = document.createElement('button');
  modUp.textContent = '♯ +1';
  modUp.title = 'Transpose the highlighted chords up a half step';
  modUp.addEventListener('mousedown', e => { e.preventDefault(); modulateSelection(1); });
  selToolbar.appendChild(modUp);

  const copyCh = document.createElement('button');
  copyCh.textContent = '⧉ Copy chords';
  copyCh.title = 'Copy just the chord pattern from the highlighted lines (no lyrics)';
  copyCh.addEventListener('mousedown', e => { e.preventDefault(); copyChordRows(); });
  selToolbar.appendChild(copyCh);

  const placeCh = document.createElement('button');
  placeCh.textContent = '⤵ Place chords';
  placeCh.title = 'Snap the copied chords onto these lines, approximating word positions';
  placeCh.addEventListener('mousedown', e => { e.preventDefault(); placeChordRows(); });
  selToolbar.appendChild(placeCh);

  document.body.appendChild(selToolbar);
}
function hideSelToolbar(){ if(selToolbar) selToolbar.classList.remove('show'); }

function updateSelToolbar(){
  if(view !== 'editor'){ hideSelToolbar(); return; }
  const sel = getSelection();
  if(!sel.rangeCount || sel.isCollapsed){ hideSelToolbar(); return; }
  const r = sel.getRangeAt(0);
  if(!editor.contains(r.commonAncestorContainer)){ hideSelToolbar(); return; }
  const rect = r.getBoundingClientRect();
  if(!rect.width && !rect.height){ hideSelToolbar(); return; }
  ensureSelToolbar();
  selToolbar.classList.add('show');
  const tb = selToolbar.getBoundingClientRect();
  const GAP = 14;
  // Sit off to the side of the highlight (vertically centred), detached from
  // it — to the right if there's room, otherwise to the left.
  let top = window.scrollY + rect.top + rect.height/2 - tb.height/2;
  let left = window.scrollX + rect.right + GAP;
  if(left + tb.width > window.scrollX + window.innerWidth - 8){
    left = window.scrollX + rect.left - tb.width - GAP;        // flip to the left
  }
  if(left < window.scrollX + 4){                                // no room either side
    left = window.scrollX + 4;
    top = window.scrollY + rect.top - tb.height - GAP;          // park it above instead
  }
  const maxTop = window.scrollY + window.innerHeight - tb.height - 4;
  selToolbar.style.top = Math.max(window.scrollY + 4, Math.min(top, maxTop)) + 'px';
  selToolbar.style.left = left + 'px';
}
document.addEventListener('selectionchange', updateSelToolbar);

function clearChordsInSelection(){
  const pos = currentPos();
  if(!pos) return;
  const hasChords = song.lines.slice(pos.sL, pos.eL+1)
    .some(ln => ln.type==='lyric' && ln.chords && ln.chords.length);
  if(!hasChords){ toast('No chords in selection'); return; }
  pushHistory();                       // snapshot BEFORE mutating
  for(let i=pos.sL; i<=pos.eL; i++){
    const ln = song.lines[i];
    if(ln.type==='lyric') ln.chords = [];
  }
  // only chords (the overlay) changed — text DOM and the selection stay put
  positionChords();
  updateUndoButtons();
  requestAnimationFrame(updateSelToolbar);
  toast('Cleared chords');
}

/* Turn every non-blank line the selection touches into a section heading,
   using its own text as the label. If they're already all sections, toggle
   them back to plain lyric lines. Chords are dropped on the way to a section
   (headings don't carry chords) but restored offsets aren't recoverable, so
   undo is the way back. */
function makeSectionFromSelection(){
  const pos = currentPos();
  if(!pos) return;
  const touched = [];
  for(let i=pos.sL; i<=pos.eL; i++){
    const ln = song.lines[i];
    if(!isBlank(ln)) touched.push(i);
  }
  if(!touched.length){ toast('Nothing to make a section'); return; }
  const allSections = touched.every(i => song.lines[i].type==='section');
  pushHistory();                       // snapshot BEFORE mutating
  for(const i of touched){
    const ln = song.lines[i];
    if(allSections){
      song.lines[i] = { type:'lyric', text: ln.label, chords: [] };
    } else if(ln.type !== 'section'){
      song.lines[i] = { type:'section', label: (ln.text||'').replace(/\s+$/,'') };
    }
  }
  renderEditor();
  setCaret(pos.sL, 0);
  updateUndoButtons();
  requestAnimationFrame(updateSelToolbar);
  toast(allSections ? 'Back to lyrics' : 'Made section');
}

/* ============================================================
   CHORD POPOVER  (click a word's + ghost, or an existing chord)
   ============================================================ */
let activePop = null;
function closePop(){ if(activePop){ activePop.remove(); activePop = null; } }
document.addEventListener('click', closePop);

function openChordPop(anchorEl, lineEl, off, pad){
  closePop();
  const ln = lineEl.__line;
  const existing = (ln.chords || []).find(c => c.off === off);
  const word = (ln.text.slice(off).match(/^\S+/) || [''])[0];

  const pop = document.createElement('div');
  pop.className = 'pop';
  pop.onclick = e => e.stopPropagation();

  const title = document.createElement('div'); title.className='poptitle';
  title.textContent = word ? `Chord on "${word}"` : 'Chord here';
  pop.appendChild(title);

  const inp = document.createElement('input');
  inp.value = existing ? existing.chord : '';
  inp.placeholder = 'e.g. D, G, A7, D/F#';
  pop.appendChild(inp);

  const used = collectChords();
  if(used.length){
    const qr = document.createElement('div'); qr.className='quickrow';
    used.slice(0,12).forEach(c => {
      const b=document.createElement('span'); b.className='q'; b.textContent=c;
      // Tapping a quick-chord confirms it outright — no need to hit Set.
      b.onmousedown = e => e.preventDefault();
      b.onclick = () => apply(c);
      qr.appendChild(b);
    });
    pop.appendChild(qr);
  }

  const apply = val => {
    pushHistory();
    let padded = false;
    // Placing a chord past the end of an empty/instrumental line: pad with
    // spaces up to the clicked column so the chord has an anchor there.
    if(pad && off > ln.text.length){
      ln.text = ln.text + ' '.repeat(off - ln.text.length);
      padded = true;
    }
    ln.chords = (ln.chords || []).filter(c => c.off !== off);
    if(val) ln.chords.push({ off, chord: val });
    ln.chords.sort((a,b)=>a.off-b.off);
    closePop();
    if(padded) renderEditor();   // the line's text node changed
    else positionChords();
    updateUndoButtons();
  };

  const btns = document.createElement('div'); btns.className='popbtns';
  const save = document.createElement('button'); save.textContent='Set'; save.className='primary';
  save.onclick = () => apply(inp.value.trim());
  const rm = document.createElement('button'); rm.textContent='Remove'; rm.className='rm';
  rm.disabled = !existing;
  rm.onclick = () => apply('');
  btns.appendChild(save); btns.appendChild(rm);
  pop.appendChild(btns);

  document.body.appendChild(pop);
  const r = anchorEl.getBoundingClientRect();
  let top = window.scrollY + r.bottom + 6;
  let left = window.scrollX + r.left;
  if(left + 230 > window.innerWidth) left = window.innerWidth - 240;
  pop.style.top = top+'px'; pop.style.left = left+'px';
  activePop = pop;
  inp.focus(); inp.select();
  // Key handling lives on the whole popup, not just the input, so Enter/Esc
  // work even when focus is on a quick-chord button or the Set/Remove buttons.
  pop.onkeydown = e => {
    if(e.key==='Enter'){ e.preventDefault(); apply(inp.value.trim()); }
    if(e.key==='Escape'){ closePop(); }
    // Del removes the chord outright and closes the editor.
    if(e.key==='Delete' && existing){
      e.preventDefault();
      apply('');
    }
  };
}

/* ---- hover "+" ghost: shows where a chord would attach ----
   The ghost is a persistent element living in editorWrap (NOT in the chord
   layer that gets rebuilt), so a chord re-render can't pull it out from
   under the pointer. We resolve the target line from the hovered element —
   which includes the chord row above the words — so the "+" stays put as
   you move up to click it. On a text line it snaps to the nearest word; on
   an empty / instrumental line you can drop a chord at any column. */
let ghostEl = null;
let ghostTarget = null;
let ghostRAF = null;

function caretFromPoint(x, y){
  let range = null;
  if(document.caretRangeFromPoint){ range = document.caretRangeFromPoint(x, y); }
  else if(document.caretPositionFromPoint){
    const p = document.caretPositionFromPoint(x, y);
    if(p){ range = document.createRange(); range.setStart(p.offsetNode, p.offset); }
  }
  if(!range) return null;
  const el = lineElOf(range.startContainer);
  if(!el || el.parentNode !== editor) return null;
  const off = (range.startContainer.nodeType===3) ? range.startOffset : 0;
  return { el, off };
}

function ensureGhost(){
  if(ghostEl) return;
  ghostEl = document.createElement('span');
  ghostEl.className = 'ed-chord ghost';
  ghostEl.textContent = '+';
  ghostEl.onmousedown = ev => ev.preventDefault();
  ghostEl.onclick = ev => {
    ev.stopPropagation();
    if(ghostTarget) openChordPop(ghostEl, ghostTarget.el, ghostTarget.off, ghostTarget.pad);
  };
  editorWrap.appendChild(ghostEl);
}

/* Where would a chord land for this line + horizontal cursor position?
   Returns { off, x, pad } — x is the wrap-relative pixel column. Shared by
   the hover ghost and by chord dragging. */
function computeTarget(lineEl, cx){
  const ln = lineEl.__line;
  if(!ln || ln.type !== 'lyric') return null;
  const text = ln.text;
  if(text.trim() === ''){
    // empty / instrumental line: free placement by column
    const r = lineEl.getBoundingClientRect();
    const pl = parseFloat(getComputedStyle(lineEl).paddingLeft) || 0;
    let col = Math.round((cx - (r.left + pl)) / getSpaceWidth());
    if(col < 0) col = 0;
    return { off: col, x: chordXForColumn(lineEl, col), pad: true };
  }
  // text line: snap to the start of the nearest word
  const r = lineEl.getBoundingClientRect();
  const pt = parseFloat(getComputedStyle(lineEl).paddingTop) || 0;
  const hit = caretFromPoint(cx, r.top + pt + 2);
  let o = hit ? hit.off : text.length;
  while(o > 0 && !/\s/.test(text[o-1])) o--;
  return { off: o, x: chordX(lineEl, o), pad: false };
}

/* The .line element under a viewport point (chord layer passes through). */
function lineFromPoint(cx, cy){
  const el = document.elementFromPoint(cx, cy);
  if(!el) return null;
  const line = el.closest ? el.closest('.line') : null;
  return (line && line.parentNode === editor) ? line : null;
}

editorWrap.addEventListener('mousemove', e => {
  if(draggingChord || marqueeActive){ hideGhost(); return; }
  if(ghostEl && (e.target === ghostEl)) return;       // keep showing while hovering it
  const lineEl = e.target.closest ? e.target.closest('.line') : null;
  const cx = e.clientX;
  if(!lineEl || lineEl.parentNode !== editor){ hideGhost(); return; }
  if(ghostRAF) cancelAnimationFrame(ghostRAF);
  ghostRAF = requestAnimationFrame(() => updateGhost(lineEl, cx));
});
editorWrap.addEventListener('mouseleave', () => { if(!draggingChord) hideGhost(); });

/* ---- marquee selection of free-placed chords ----
   A drag that starts on a blank/instrumental line (not on a chord) rubber-bands
   a box and selects the chords it touches. Lyric lines are left alone so normal
   text selection still works. Shift adds to the existing selection. */
editorWrap.addEventListener('mousedown', e => {
  if(e.button !== 0) return;
  if(e.target.closest && e.target.closest('.ed-chord')) return;   // chord owns its own drag
  const lineEl = lineFromPoint(e.clientX, e.clientY);
  // Clicking lyric/section text drops the chord selection so it can't shadow a
  // normal text copy; marquee only runs on blank/instrumental lines.
  if(!lineEl || !isFreePlacedLine(lineEl.__line)){ clearChordSel(); return; }

  const startX = e.clientX, startY = e.clientY;
  const additive = e.shiftKey;
  const baseSel = additive ? chordSel.slice() : [];
  let box = null;

  const onMove = ev => {
    if(!marqueeActive){
      if(Math.hypot(ev.clientX-startX, ev.clientY-startY) < 4) return;
      marqueeActive = true;
      box = document.createElement('div'); box.className = 'chord-marquee';
      editorWrap.appendChild(box);
    }
    const s = getSelection(); if(s) s.removeAllRanges();   // suppress contenteditable text drag
    const wr = editorWrap.getBoundingClientRect();
    const x1 = Math.min(startX, ev.clientX), x2 = Math.max(startX, ev.clientX);
    const y1 = Math.min(startY, ev.clientY), y2 = Math.max(startY, ev.clientY);
    box.style.left = (x1 - wr.left) + 'px'; box.style.top = (y1 - wr.top) + 'px';
    box.style.width = (x2 - x1) + 'px'; box.style.height = (y2 - y1) + 'px';
    const hit = [];
    for(const t of chordLayer.children){
      if(!t.__c || !isFreePlacedLine(t.__ln)) continue;
      const r = t.getBoundingClientRect();
      if(r.right >= x1 && r.left <= x2 && r.bottom >= y1 && r.top <= y2) hit.push({ ln:t.__ln, c:t.__c });
    }
    chordSel = mergeSel(baseSel, hit);
    paintSelection();
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    if(box) box.remove();
    if(!marqueeActive){ if(!additive) clearChordSel(); }   // a plain click clears
    marqueeActive = false;
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
});

/* Escape drops the chord selection; Delete/Backspace removes the selected
   chords (but only when text editing isn't underway, so lyric editing is safe). */
document.addEventListener('keydown', e => {
  if(e.key === 'Escape'){ clearChordSel(); return; }
  if(e.key === 'Delete' || e.key === 'Backspace'){
    const ae = document.activeElement;
    const inField = ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA');
    const hasText = !!String(getSelection() || '').length;
    if(chordSel.length && !inField && !hasText){ e.preventDefault(); deleteChordSel(); }
  }
});

/* Copy / cut / paste selected chords. Copy & cut act whenever chords are
   selected; paste only hijacks Cmd/Ctrl+V when the cursor is hovering a
   blank/instrumental line, so pasting text into lyrics is left untouched. */
document.addEventListener('keydown', e => {
  if(!(e.metaKey || e.ctrlKey) || e.altKey) return;
  const k = e.key.toLowerCase();
  const ae = document.activeElement;
  const inField = ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA');
  const hasText = !!String(getSelection() || '').length;   // real text selection wins
  if((k === 'c' || k === 'x') && chordSel.length && !inField && !hasText){
    e.preventDefault();
    if(k === 'c') copyChordSel(); else cutChordSel();
  } else if(k === 'v' && chordClip && chordClip.length && !inField){
    const lineEl = lineFromPoint(lastMouseX, lastMouseY);
    if(lineEl && isFreePlacedLine(lineEl.__line)){ e.preventDefault(); pasteChords(lineEl); }
  }
});

function updateGhost(lineEl, cx){
  const t = computeTarget(lineEl, cx);
  if(!t){ hideGhost(); return; }
  if((lineEl.__line.chords||[]).some(c => c.off === t.off)){ hideGhost(); return; }
  ghostTarget = { el: lineEl, off: t.off, pad: t.pad };
  ensureGhost();
  ghostEl.style.left = t.x + 'px';
  ghostEl.style.top = lineEl.offsetTop + 'px';
  // On blank/instrumental lines the chord is free-placed, so center the ghost
  // on the cursor's snap point instead of letting it extend to the right.
  ghostEl.style.transform = t.pad ? 'translate(-50%, 1px)' : '';
  ghostEl.classList.add('show');
}
function hideGhost(){ if(ghostEl) ghostEl.classList.remove('show'); }

/* ---- drag a chord to a new word / spot ---- */
let draggingChord = false;
function startChordDrag(ev, lineEl, c, tag){
  if(ev.button !== 0) return;                 // left button only
  ev.preventDefault(); ev.stopPropagation();
  const off = c.off;

  // Shift+click toggles this chord in the multi-selection (no drag).
  if(ev.shiftKey){ toggleChordSel(lineEl.__line, c); return; }

  // Mousedown on a chord that's part of a multi-selection → drag them together,
  // preserving the varying gaps between them.
  if(isChordSelected(c) && chordSel.length > 1){ startGroupDrag(ev, c, tag); return; }

  // Otherwise this is a fresh single-chord interaction; drop any old selection.
  clearChordSel();

  const startX = ev.clientX, startY = ev.clientY;
  const wrapRect = () => editorWrap.getBoundingClientRect();
  let moved = false;
  let drop = null;

  const onMove = e => {
    if(!moved && Math.hypot(e.clientX-startX, e.clientY-startY) < 4) return;
    if(!moved){ moved = true; draggingChord = true; tag.classList.add('dragging'); tag.style.pointerEvents='none'; editorWrap.classList.add('dragging'); hideGhost(); }
    const targetLine = lineFromPoint(e.clientX, e.clientY);
    const t = targetLine ? computeTarget(targetLine, e.clientX) : null;
    if(t){
      drop = { el: targetLine, off: t.off, pad: t.pad };
      tag.style.left = t.x + 'px';
      tag.style.top = targetLine.offsetTop + 'px';
    } else {
      drop = null;
      const wr = wrapRect();
      tag.style.left = (e.clientX - wr.left) + 'px';
      tag.style.top = (e.clientY - wr.top - 9) + 'px';
    }
  };
  const onUp = e => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    tag.classList.remove('dragging');
    editorWrap.classList.remove('dragging');
    if(!moved){
      openChordPop(tag, lineEl, off);           // a plain click: edit it
      return;
    }
    draggingChord = false;
    if(drop) moveChord(lineEl, off, drop.el, drop.off, drop.pad);
    else positionChords();                       // dropped nowhere: snap back
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

function moveChord(fromEl, fromOff, toEl, toOff, pad){
  const fromLn = fromEl.__line, toLn = toEl.__line;
  const chord = (fromLn.chords||[]).find(c => c.off === fromOff);
  if(!chord){ positionChords(); return; }
  if(fromLn === toLn && fromOff === toOff){ positionChords(); return; } // no-op
  pushHistory();
  fromLn.chords = fromLn.chords.filter(c => c.off !== fromOff);
  let padded = false;
  if(pad && toOff > toLn.text.length){
    toLn.text = toLn.text + ' '.repeat(toOff - toLn.text.length);
    padded = true;
  }
  toLn.chords = (toLn.chords || []).filter(c => c.off !== toOff);
  toLn.chords.push({ off: toOff, chord: chord.chord });
  toLn.chords.sort((a,b)=>a.off-b.off);
  if(padded) renderEditor();
  else positionChords();
  updateUndoButtons();
}

/* Drag every selected chord as a rigid group: shift them all by the same number
   of columns so the gaps between them are preserved. */
function startGroupDrag(ev, anchor, anchorTag){
  const startX = ev.clientX, startY = ev.clientY;
  const spaceW = getSpaceWidth();
  const minOff = Math.min(...chordSel.map(s => s.c.off));
  // Snapshot the on-screen position of each selected tag so we can preview the
  // shift by sliding them, without disturbing their relative spacing.
  const tags = [];
  for(const t of chordLayer.children){
    if(t.__c && isChordSelected(t.__c)) tags.push({ tag:t, baseLeft: parseFloat(t.style.left) });
  }
  let moved = false, delta = 0;

  const onMove = e => {
    if(!moved && Math.hypot(e.clientX-startX, e.clientY-startY) < 4) return;
    if(!moved){ moved = true; draggingChord = true; editorWrap.classList.add('dragging'); hideGhost(); for(const g of tags) g.tag.classList.add('dragging'); }
    // Clamp so the left-most chord never crosses column 0.
    delta = Math.max(Math.round((e.clientX - startX) / spaceW), -minOff);
    for(const g of tags) g.tag.style.left = (g.baseLeft + delta * spaceW) + 'px';
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    for(const g of tags) g.tag.classList.remove('dragging');
    editorWrap.classList.remove('dragging');
    draggingChord = false;
    if(!moved){ openChordPop(anchorTag, lineElOfModel(anchor), anchor.off); return; }  // plain click
    if(delta) shiftSelectedChords(delta);
    else positionChords();
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

/* Apply a column shift to every selected chord, padding each affected line's
   whitespace so the chords still have room to sit. Keeps the selection. */
function shiftSelectedChords(delta){
  pushHistory();
  const lines = new Set(chordSel.map(s => s.ln));
  for(const s of chordSel) s.c.off = Math.max(0, s.c.off + delta);
  for(const ln of lines){
    ln.chords.sort((a,b)=>a.off-b.off);
    const maxOff = ln.chords.reduce((m,c)=>Math.max(m, c.off), 0);
    if((ln.text||'').length < maxOff) ln.text = (ln.text||'') + ' '.repeat(maxOff - ln.text.length);
  }
  renderEditor();
  updateUndoButtons();
}

/* The .line element backing a model line that owns the given chord. */
function lineElOfModel(c){
  for(const el of editor.children){ if((el.__line.chords||[]).includes(c)) return el; }
  return null;
}

/* ============================================================
   FONT CONTROLS
   ============================================================ */
/* Font prefs persist independently of the song so they stick across reloads
   and across different songs. */
const FONT_KEY = 'chordscribe:fonts';

function saveFontSettings(){
  try {
    localStorage.setItem(FONT_KEY, JSON.stringify({
      lyricFamily: document.getElementById('fontFamily').value,
      chordFamily: document.getElementById('chordFamily').value,
      lyricSize:   document.getElementById('fontSize').value,
      chordSize:   document.getElementById('chordSize').value,
    }));
  } catch(e){ /* quota / private mode — fail silently */ }
}

/* Restore saved font prefs into the controls. Only assigns a <select> value if
   the saved option still exists, so removed fonts fall back to the default. */
function restoreFontSettings(){
  let f;
  try { f = JSON.parse(localStorage.getItem(FONT_KEY) || 'null'); } catch(e){}
  if(!f) return;
  const setSelect = (id, val) => {
    if(val == null) return;
    const sel = document.getElementById(id);
    if([...sel.options].some(o => o.value === val)) sel.value = val;
  };
  const setRange = (id, val) => {
    if(val == null) return;
    document.getElementById(id).value = val;
  };
  setSelect('fontFamily', f.lyricFamily);
  setSelect('chordFamily', f.chordFamily);
  setRange('fontSize', f.lyricSize);
  setRange('chordSize', f.chordSize);
}

function applyFont(){
  const fam = document.getElementById('fontFamily').value;
  const chordFam = document.getElementById('chordFamily').value;
  const size = document.getElementById('fontSize').value;
  const chord = document.getElementById('chordSize').value;
  const root = document.documentElement.style;
  root.setProperty('--lyric-font', fam);
  root.setProperty('--chord-font', chordFam);
  root.setProperty('--lyric-size', size + 'px');
  root.setProperty('--chord-size', chord + 'px');
  document.getElementById('fontSizeVal').textContent = size + 'px';
  document.getElementById('chordSizeVal').textContent = chord + 'px';
  _spaceW = null;
  saveFontSettings();
  requestAnimationFrame(positionChords);
  if(document.getElementById('modalBg').classList.contains('show')){
    requestAnimationFrame(buildRendered);
  }
}

window.addEventListener('resize', () => { requestAnimationFrame(positionChords); });

/* ============================================================
   VIEW SWITCH — visual Editor  <->  raw ChordPro source
   ============================================================ */
let view = 'editor';
const sourceEdit = document.getElementById('sourceEdit');
let sourceTimer = null;

function setView(v){
  if(v === view) return;
  if(view === 'source') commitSource();   // pull any pending edits before leaving
  view = v;
  document.getElementById('viewEditor').classList.toggle('active', v==='editor');
  document.getElementById('viewSource').classList.toggle('active', v==='source');
  document.getElementById('sheet').style.display = v==='editor' ? '' : 'none';
  sourceEdit.style.display = v==='source' ? 'block' : 'none';
  document.getElementById('hintEditor').style.display = v==='editor' ? '' : 'none';
  document.getElementById('hintSource').style.display = v==='source' ? '' : 'none';
  if(v==='source'){
    sourceEdit.value = toChordPro(song);
    autosizeSource();
    sourceEdit.focus({ preventScroll: true });
  } else {
    render();
  }
}

function autosizeSource(){
  sourceEdit.style.height = 'auto';
  sourceEdit.style.height = Math.max(360, sourceEdit.scrollHeight) + 'px';
}

/* Reparse the raw source into the model. Keeps meta from the source too. */
function commitSource(){
  if(sourceTimer){ clearTimeout(sourceTimer); sourceTimer = null; }
  const parsed = parseChordPro(sourceEdit.value);
  song = parsed;
}

sourceEdit.addEventListener('input', () => {
  autosizeSource();
  pushHistoryTyping();
  if(sourceTimer) clearTimeout(sourceTimer);
  sourceTimer = setTimeout(() => {
    song = parseChordPro(sourceEdit.value);
    updateUndoButtons();
  }, 400);
});

/* ============================================================
   PDF IMPORT  —  read back a sheet that ChordScribe printed
   ------------------------------------------------------------
   The renderer prints every line as a row of "cells", each cell a
   chord stacked directly above its slice of lyric, all left-aligned.
   We pull the positioned text out of the PDF with pdf.js, regroup it
   into visual rows, pair each chord row with the lyric row just below
   it, and rebuild the model from the geometry. Because chords sit at
   the same x as the lyric slice they belong to, a chord's character
   offset is just the length of the lyric to its left.

   This is a best-effort reverse of the renderer, not a general PDF
   reader: it assumes the chords-over-words layout this app produces.
   ============================================================ */
const PDFJS_VER = '3.11.174';
/* A bare chord token: root, optional accidental, quality, extension, slash bass. */
const PDF_CHORD_RE = /^[A-G](#|b|♯|♭)?(maj|min|m|sus|aug|dim|add|M|°|ø|\+)?\d*(sus\d*|add\d*)?\d*(\/[A-G](#|b|♯|♭)?)?$/;
/* Non-chord marks that still live on a chord row: x2, [STOP], N.C., etc. */
const PDF_MARK_RE  = /^(x\s?\d+|\[?\s*stop\s*\]?|\(\s*x?\d+\s*\)|n\.?\s?c\.?)$/i;

function pdfIsChordTok(s){
  s = (s||'').trim();
  return s !== '' && (PDF_CHORD_RE.test(s) || PDF_MARK_RE.test(s));
}

/* Group text items into visual rows by their baseline y (top-of-page first). */
function pdfClusterRows(items, tol){
  const rows = [];
  for(const it of items.slice().sort((a,b)=>b.y-a.y)){
    let row = null;
    for(const r of rows){ if(Math.abs(r.y - it.y) <= tol){ row = r; break; } }
    if(!row){ row = { y: it.y, items: [] }; rows.push(row); }
    row.items.push(it);
  }
  for(const r of rows) r.items.sort((a,b)=>a.x-b.x);
  rows.sort((a,b)=>b.y-a.y);
  return rows;
}

/* Rebuild a row's text from individual character positions.
   Chrome faux-bolds headings (title, key line, section labels) by drawing each
   glyph twice with a tiny offset, which pdf.js surfaces as overlapping bigram
   fragments ("An","nd","dC"...). Working at the character level lets us drop the
   duplicates and re-insert the spaces (visual gaps) that the fragments lost,
   while staying a no-op on clean single-run text like the lyrics. Returns the
   reconstructed string plus the x of each character, used to place chords. */
function pdfReconstructRow(items){
  const chars = [];
  for(const it of items){
    const s = it.str;
    if(s === '' || s.trim() === '') continue;   // spaces come back via gaps below
    const cw = it.w / Math.max(1, s.length);
    for(let k=0;k<s.length;k++){
      if(s[k] === ' ') continue;
      chars.push({ ch: s[k], x: it.x + k*cw, cw });
    }
  }
  chars.sort((a,b)=>a.x-b.x);
  let text = '';
  const charX = [];
  let lastRight = null;
  for(const c of chars){
    if(lastRight !== null){
      const gap = c.x - lastRight;
      if(gap < -c.cw*0.34) continue;                      // overlapping duplicate glyph
      if(gap > c.cw*0.15){
        // Visual whitespace -> spaces. Measured on real sheets the gap cleanly
        // splits: mid-word joins sit at <=0 (letters touch / kern), real word
        // boundaries start near +0.2cw, with nothing between. 0.15cw lands in
        // that empty band. Within a run the x-step is one cw (uniform), so real
        // letters never trip this — only true gaps between cells do.
        const n = Math.max(1, Math.round(gap / c.cw));
        for(let j=0;j<n;j++){ charX.push(lastRight + j*c.cw); text += ' '; }
      }
    }
    charX.push(c.x); text += c.ch; lastRight = c.x + c.cw;
  }
  return { text, charX };
}

function pdfRowText(row){ return pdfReconstructRow(row.items).text.replace(/\s+/g,' ').trim(); }

/* True if any part of this row is body content (a section heading or chords).
   Splits the row at wide horizontal gaps first so a section in one column
   isn't masked by a section in another sharing the same baseline (the left
   "INTRO" and right "VERSE 3" land on one line). Used to end the page header. */
function pdfRowHasBody(row){
  const sorted = row.items.slice().sort((a,b)=>a.x-b.x);
  const groups = []; let cur = []; let prevRight = null;
  for(const it of sorted){
    if(prevRight !== null && it.x - prevRight > 40){ groups.push(cur); cur = []; }
    cur.push(it); prevRight = it.x + it.w;
  }
  if(cur.length) groups.push(cur);
  return groups.some(g => { const r = { items:g }; return SECTION_RE.test(pdfRowText(r)) || pdfRowIsChords(r); });
}

/* Chords on a chord row, each with the x where it begins, recovered from the
   reconstructed text so multi-char chords (D/F#) and gaps survive. */
function pdfChordTokens(items){
  const { text, charX } = pdfReconstructRow(items);
  const toks = [];
  const re = /\S+/g; let m;
  while((m = re.exec(text)) !== null){
    toks.push({ chord: m[0], x: charX[m.index] });
  }
  return toks;
}

/* Does this row read like a stack of chords (vs lyrics)? */
function pdfRowIsChords(row){
  const toks = pdfRowText(row).split(/\s+/).filter(Boolean);
  if(!toks.length) return false;
  const hits = toks.filter(pdfIsChordTok).length;
  return hits >= 1 && hits / toks.length >= 0.6;
}

/* Typical width of a single space, from the items' average character width. */
function pdfSpaceWidth(items){
  const ws = items.filter(it=>it.str.trim()).map(it=>it.w/Math.max(1,it.str.length)).filter(w=>w>0);
  if(!ws.length) return 6;
  ws.sort((a,b)=>a-b);
  return ws[Math.floor(ws.length/2)];
}

/* Build a {type:'lyric'} line from a chord row's items and the lyric row's items
   just below it. Reconstructs the lyric text and pins each chord to the
   character offset that sits under its x position. Either row may be empty:
   no chords -> a plain lyric line; no lyrics -> a chord-only instrumental line. */
function pdfBuildLyricLine(chordItems, lyricItems, spaceW){
  const chords = pdfChordTokens(chordItems || []);
  let { text, charX } = pdfReconstructRow(lyricItems || []);
  spaceW = spaceW || pdfSpaceWidth((lyricItems&&lyricItems.length)?lyricItems:(chordItems||[])) || 6;

  const originX = charX.length ? charX[0]
                : chords.length ? chords[0].x : 0;

  // Pad trailing spaces so chords sitting past the last word still land somewhere
  // (chord-only lines build their whole "lyric" of spaces this way).
  const lastChordX = chords.length ? chords[chords.length-1].x : originX;
  let cursorX = charX.length ? charX[charX.length-1] + spaceW : originX;
  while(cursorX < lastChordX - spaceW*0.3){ charX.push(cursorX); text += ' '; cursorX += spaceW; }

  const placed = [];
  for(const c of chords){
    let off = 0;
    for(let i=0;i<charX.length;i++){ if(charX[i] < c.x - spaceW*0.4) off = i+1; else break; }
    if(off > text.length) off = text.length;
    placed.push({ off, chord: c.chord });
  }
  placed.sort((a,b)=>a.off-b.off);
  return { type:'lyric', text, chords: placed };
}

/* Find x positions of column gutters: vertical rivers of whitespace that run
   the full height of the body. Returns [] for a single-column page. */
function pdfColumnSeps(items, pageW){
  if(!items.length) return [];
  const W = Math.ceil(pageW) + 2;
  const filled = new Array(W).fill(false);
  for(const it of items){
    const a = Math.max(0, Math.floor(it.x));
    const b = Math.min(W-1, Math.ceil(it.x + it.w));
    for(let i=a;i<=b;i++) filled[i] = true;
  }
  const minX = Math.min(...items.map(i=>i.x));
  const maxX = Math.max(...items.map(i=>i.x + i.w));
  const seps = [];
  let run = 0;
  for(let i=0;i<=W;i++){
    if(i < W && !filled[i]){ run++; continue; }
    if(run >= 14){
      const start = i - run, mid = start + run/2;
      if(start > minX + 8 && i < maxX - 8) seps.push(mid);
    }
    run = 0;
  }
  return seps.sort((a,b)=>a-b);
}

function pdfColumnOf(x, seps){
  let c = 0;
  for(const s of seps){ if(x > s) c++; }
  return c;
}

/* Turn an ordered list of rows (one newspaper column) into model lines. */
function pdfRowsToLines(rows, spaceW, lines){
  for(let i=0;i<rows.length;i++){
    const row = rows[i];
    const txt = pdfRowText(row);
    if(!txt) continue;

    if(SECTION_RE.test(txt) && !pdfRowIsChords(row)){
      if(lines.length && !isBlank(lines[lines.length-1])) lines.push({type:'lyric', text:'', chords:[]});
      // Title-case "VERSE 1" -> "Verse 1" so it reads naturally back in the editor.
      const label = txt.replace(/\b([A-Za-z])([A-Za-z]*)/g, (m,a,b)=>a.toUpperCase()+b.toLowerCase());
      lines.push({ type:'section', label });
      continue;
    }

    if(pdfRowIsChords(row)){
      const next = rows[i+1];
      const gap = next ? row.y - next.y : Infinity;
      const pairable = next && !pdfRowIsChords(next) && !SECTION_RE.test(pdfRowText(next)) &&
                       gap > 0 && gap < spaceW*3.2;
      if(pairable){
        lines.push(pdfBuildLyricLine(row.items, next.items, spaceW));
        i++;                       // consume the lyric row too
      } else {
        lines.push(pdfBuildLyricLine(row.items, [], spaceW));   // chord-only (intro/instrumental)
      }
      continue;
    }

    // Plain lyric row with no chords above it.
    lines.push(pdfBuildLyricLine([], row.items, spaceW));
  }
}

function pdfParseKeyline(s, meta){
  for(const part of s.split('|')){
    let m;
    if((m = part.match(/key\s*[-–:]\s*(.+)/i)))        meta.key   = m[1].trim();
    else if((m = part.match(/tempo\s*[-–:]\s*(.+)/i))) meta.tempo = m[1].trim();
    else if((m = part.match(/time\s*[-–:]\s*(.+)/i)))  meta.time  = m[1].trim();
  }
}

async function importPdf(arrayBuffer){
  if(!window.pdfjsLib) throw new Error('PDF support failed to load');
  if(!pdfjsLib.GlobalWorkerOptions.workerSrc){
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/'+PDFJS_VER+'/pdf.worker.min.js';
  }
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer) }).promise;
  const meta = {};
  const lines = [];

  for(let p=1; p<=pdf.numPages; p++){
    const page = await pdf.getPage(p);
    const vp = page.getViewport({ scale:1 });
    const tc = await page.getTextContent();
    const items = tc.items
      .filter(it => it.str && it.str.trim() !== '')
      .map(it => ({
        str: it.str,
        x: it.transform[4],
        y: it.transform[5],
        w: it.width,
        h: it.height || Math.abs(it.transform[3]) || 10
      }));
    if(!items.length) continue;

    const heights = items.map(i=>i.h).sort((a,b)=>a-b);
    const medH = heights[Math.floor(heights.length/2)] || 12;
    const spaceW = pdfSpaceWidth(items);

    // ---- header (page 1 only): everything above the first section / chord row ----
    let bodyItems = items;
    if(p === 1){
      const fullRows = pdfClusterRows(items, medH*0.5);
      const headerRows = [];
      let split = 0;
      for(; split<fullRows.length; split++){
        const r = fullRows[split];
        if(pdfRowHasBody(r)) break;
        headerRows.push(r);
      }
      if(headerRows.length){
        // Title = the tallest text on the page; key/tempo/time = the "Key - ..." row.
        let titleItem = null;
        for(const r of headerRows) for(const it of r.items){
          if(!titleItem || it.h > titleItem.h) titleItem = it;
        }
        const titleH = titleItem ? titleItem.h : 0;
        const artistBits = [];
        for(const r of headerRows){
          const t = pdfRowText(r);
          if(!t) continue;
          if(/key\s*[-–:]/i.test(t) || /\b(tempo|time)\s*[-–:]/i.test(t)){ pdfParseKeyline(t, meta); continue; }
          if(titleItem && r.items.some(it => it.h >= titleH - 0.5)){ if(!meta.title) meta.title = t; continue; }
          artistBits.push(t);
        }
        if(artistBits.length && !meta.artist) meta.artist = artistBits[0];
        const headerSet = new Set(headerRows.flatMap(r=>r.items));
        bodyItems = items.filter(it => !headerSet.has(it));
      }
    }
    if(!bodyItems.length) continue;

    // ---- body: split into columns, read each column top-to-bottom, left-to-right ----
    const seps = pdfColumnSeps(bodyItems, vp.width);
    const cols = [];
    for(const it of bodyItems){
      const ci = pdfColumnOf(it.x + it.w/2, seps);
      (cols[ci] = cols[ci] || []).push(it);
    }
    for(const colItems of cols){
      if(!colItems || !colItems.length) continue;
      const rows = pdfClusterRows(colItems, medH*0.5);
      pdfRowsToLines(rows, spaceW, lines);
    }
  }

  // Faux-bold headings sometimes lose word spaces (title) or double a short
  // value (key). Recover Title Case word breaks and collapse an exact doubling.
  if(meta.title){
    meta.title = meta.title.replace(/([a-z])([A-Z])/g,'$1 $2').replace(/\s+/g,' ').trim();
  }
  for(const k of ['key','time']){
    const v = meta[k]; if(!v) continue;
    const m = v.match(/^(.+)\1$/);
    if(m && m[1].length <= 3) meta[k] = m[1];
  }

  while(lines.length && isBlank(lines[lines.length-1])) lines.pop();
  if(!lines.length) throw new Error('No chord/lyric content found in that PDF');
  return { meta, lines };
}

/* ============================================================
   IMPORT
   ============================================================ */
document.getElementById('fileinput').addEventListener('change', e => {
  const f = e.target.files[0]; if(!f) return;
  const isPdf = /\.pdf$/i.test(f.name) || f.type === 'application/pdf';
  const reader = new FileReader();

  if(isPdf){
    reader.onload = async ev => {
      try {
        const parsed = await importPdf(ev.target.result);
        adoptAsNewProject(parsed, 'Imported '+f.name);
      } catch(err){
        console.error(err);
        toast(err && err.message ? 'PDF: '+err.message : 'Could not read that PDF');
      }
    };
    reader.readAsArrayBuffer(f);
  } else {
    reader.onload = ev => {
      adoptAsNewProject(parseChordPro(ev.target.result), 'Imported '+f.name);
    };
    reader.readAsText(f);
  }
  e.target.value = '';   // allow re-importing the same file
});

/* ============================================================
   EXPORT
   ============================================================ */
function openExport(){
  document.getElementById('sourceArea').textContent = toChordPro(song);
  document.getElementById('modalBg').classList.add('show');
  const build = () => requestAnimationFrame(buildRendered);
  if(document.fonts && document.fonts.ready){ document.fonts.ready.then(build); }
  else build();
}
function closeExport(){ document.getElementById('modalBg').classList.remove('show'); }
document.getElementById('modalBg').addEventListener('click', e=>{ if(e.target.id==='modalBg') closeExport(); });

function openHelp(){ document.getElementById('helpBg').classList.add('show'); }
function closeHelp(){ document.getElementById('helpBg').classList.remove('show'); }
document.getElementById('helpBg').addEventListener('click', e=>{ if(e.target.id==='helpBg') closeHelp(); });
document.addEventListener('keydown', e=>{ if(e.key==='Escape'){ closeHelp(); closeProjects(); } });

/* ============================================================
   PROJECTS modal — open / switch / new / rename / duplicate / delete
   ============================================================ */
function openProjects(){
  flushSave();                         // make sure the open song's latest edits are stored
  renderProjectList();
  document.getElementById('projectsBg').classList.add('show');
}
function closeProjects(){ document.getElementById('projectsBg').classList.remove('show'); }
document.getElementById('projectsBg').addEventListener('click', e=>{ if(e.target.id==='projectsBg') closeProjects(); });

function fmtDate(ts){
  try {
    const d = new Date(ts);
    return (d.getMonth()+1) + '/' + d.getDate() + '/' + String(d.getFullYear()).slice(2);
  } catch(e){ return ''; }
}

// Swap a parsed/blank song in as a brand-new project and open it.
function adoptAsNewProject(s, msg){
  flushSave();
  const id = uid();
  setCurrentProject(id);
  song = s;
  writeProject(id, song);
  undoStack = []; redoStack = [];
  render();
  if(msg) toast(msg);
}

function newProject(){
  adoptAsNewProject({ meta:{}, lines:[] }, 'New project');
  renderProjectList();
}

function openProject(id){
  if(id === currentProjectId){ closeProjects(); return; }
  flushSave();                         // store the project we're leaving
  const s = loadProjectSong(id);
  if(!s){ toast('Could not open that project'); return; }
  setCurrentProject(id);
  song = s;
  undoStack = []; redoStack = [];
  render();
  closeProjects();
  toast('Opened “' + projectTitle(song) + '”');
}

function renameProject(id){
  const idx = readIndex();
  const entry = idx.find(p => p.id === id);
  const name = prompt('Rename project', entry ? entry.title : '');
  if(name === null) return;
  const title = name.trim() || 'Untitled';
  if(id === currentProjectId){
    song.meta = song.meta || {};
    song.meta.title = title;
    writeProject(id, song);
    render();                          // reflect new title in the meta bar
  } else {
    const s = loadProjectSong(id);
    if(s){ s.meta = s.meta || {}; s.meta.title = title; writeProject(id, s); }
  }
  renderProjectList();
}

function duplicateProject(id){
  const s = (id === currentProjectId) ? song : loadProjectSong(id);
  if(!s) return;
  const copy = JSON.parse(JSON.stringify(s));
  copy.meta = copy.meta || {};
  copy.meta.title = projectTitle(s) + ' copy';
  writeProject(uid(), copy);
  renderProjectList();
  toast('Duplicated');
}

function deleteProject(id){
  const idx = readIndex();
  const entry = idx.find(p => p.id === id);
  if(!confirm('Delete “' + (entry ? entry.title : 'project') + '”? This can’t be undone.')) return;
  try { localStorage.removeItem(PROJ_KEY(id)); } catch(e){}
  const next = idx.filter(p => p.id !== id);
  writeIndex(next);
  if(id === currentProjectId){
    if(next.length === 0){
      adoptAsNewProject({ meta:{}, lines:[] });   // never leave the editor without a project
    } else {
      const pick = next.slice().sort((a,b) => b.updatedAt - a.updatedAt)[0].id;
      setCurrentProject(pick);
      song = loadProjectSong(pick) || { meta:{}, lines:[] };
      undoStack = []; redoStack = [];
      render();
    }
  }
  renderProjectList();
}

function renderProjectList(){
  const wrap = document.getElementById('projectList');
  if(!wrap) return;
  const idx = readIndex().slice().sort((a,b) => b.updatedAt - a.updatedAt);
  wrap.innerHTML = '';
  if(idx.length === 0){ wrap.innerHTML = '<div class="pl-empty">No saved projects yet.</div>'; return; }
  idx.forEach(p => {
    const row = document.createElement('div');
    row.className = 'pl-row' + (p.id === currentProjectId ? ' current' : '');

    const name = document.createElement('button');
    name.className = 'pl-name';
    name.textContent = p.title || 'Untitled';
    name.title = 'Open';
    name.onclick = () => openProject(p.id);

    const date = document.createElement('span');
    date.className = 'pl-date';
    date.textContent = fmtDate(p.updatedAt);

    const actions = document.createElement('span');
    actions.className = 'pl-actions';
    const mk = (label, fn) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.onclick = e => { e.stopPropagation(); fn(p.id); };
      return b;
    };
    actions.appendChild(mk('Rename', renameProject));
    actions.appendChild(mk('Duplicate', duplicateProject));
    actions.appendChild(mk('Delete', deleteProject));

    row.appendChild(name);
    row.appendChild(date);
    row.appendChild(actions);
    wrap.appendChild(row);
  });
}

function exportTab(which){
  document.getElementById('tabRendered').classList.toggle('active', which==='rendered');
  document.getElementById('tabSource').classList.toggle('active', which==='source');
  document.getElementById('exportRendered').style.display = which==='rendered'?'block':'none';
  document.getElementById('exportSource').style.display = which==='source'?'block':'none';
}

let exportCols = 'auto';

function setCols(n){
  exportCols = n;
  document.querySelectorAll('.colswitch button').forEach(b => {
    const v = b.dataset.col === 'auto' ? 'auto' : Number(b.dataset.col);
    b.classList.toggle('active', v === n);
  });
  // The lyric/chord sliders are a *max* in Auto mode and a *fixed* size when a
  // column count is pinned — relabel so the meaning is obvious.
  const auto = n === 'auto';
  const ll = document.getElementById('expLyricLbl');
  const cl = document.getElementById('expChordLbl');
  if(ll) ll.textContent = auto ? 'Max lyric size' : 'Lyric size';
  if(cl) cl.textContent = auto ? 'Max chord size' : 'Chord size';
  buildRendered();
}

/* Page geometry in CSS px at 96dpi (before zoom). */
const PAGE_W = 8.5 * 96;
const PAGE_H = 11 * 96;
const PAGE_PAD = 0.6 * 96;
const CONTENT_H = PAGE_H - PAGE_PAD * 2;
const CONTENT_W = PAGE_W - PAGE_PAD * 2;
const COL_GAP = 0.3 * 96;
const BLOCK_PAD = 0.12 * 96;   // .rblock right padding, eats into usable column width
const MIN_LYRIC = 9;           // never auto-shrink lyrics below this

function buildHeadEl(){
  const m = song.meta;
  const head = document.createElement('div'); head.className='rhead';

  const left = document.createElement('div'); left.className='rhead-left';
  if(m.title){ const h=document.createElement('h2'); h.textContent=m.title; left.appendChild(h); }
  if(m.artist){ const c=document.createElement('div'); c.className='credit'; c.textContent=m.artist; left.appendChild(c); }
  const kl=[];
  if(m.key) kl.push('Key - '+m.key);
  if(m.tempo) kl.push('Tempo - '+m.tempo);
  if(m.time) kl.push('Time - '+m.time);
  if(kl.length){ const k=document.createElement('div'); k.className='keyline'; k.textContent=kl.join(' | '); left.appendChild(k); }
  head.appendChild(left);

  // Road map + notes ride in a right-hand column across from the title, so
  // they cost no extra vertical space on the page.
  const road = roadmapTokens(m.roadmap);
  const hasNotes = m.notes && m.notes.trim();
  if(road.length || hasNotes){
    const right = document.createElement('div'); right.className='rhead-right';
    if(road.length){
      const rl=document.createElement('div'); rl.className='roadline';
      for(const t of road){ const c=document.createElement('span'); c.className='rchip'; c.textContent=t; rl.appendChild(c); }
      right.appendChild(rl);
    }
    if(hasNotes){ const n=document.createElement('div'); n.className='noteline'; n.textContent=m.notes; right.appendChild(n); }
    head.appendChild(right);
  }
  return head;
}

function buildRenderedLineEl(ln){
  const wrap = document.createElement('div'); wrap.className='rline';
  const row = document.createElement('div'); row.className='rcells';

  const cells = [];
  let curText = '', curChord = null, started = false;
  for(const seg of segmentsOf(ln)){
    const c = (seg.chord!==null && seg.chord!==undefined) ? seg.chord : null;
    if(c !== null){
      if(started || curText.length) cells.push({ chord: curChord, text: curText });
      curChord = c; curText = ''; started = true;
    }
    curText += seg.text;
  }
  if(started || curText.length) cells.push({ chord: curChord, text: curText });
  if(cells.length === 0) cells.push({ chord: null, text: ' ' });

  for(const cell of cells){
    const cellEl = document.createElement('span'); cellEl.className='rcell';
    const chordEl = document.createElement('span'); chordEl.className='rcellchord';
    if(cell.chord !== null && cell.chord !== undefined && cell.chord !== '') chordEl.textContent = cell.chord;
    else chordEl.innerHTML = '&nbsp;';
    const textEl = document.createElement('span'); textEl.className='rcelltext';
    textEl.textContent = cell.text.length ? cell.text : ' ';
    cellEl.appendChild(chordEl); cellEl.appendChild(textEl);
    row.appendChild(cellEl);
  }
  wrap.appendChild(row);
  return wrap;
}

function buildBlockEls(){
  const blocks = [];
  let block = null;
  const newBlock = () => { block = document.createElement('div'); block.className='rblock'; blocks.push(block); };
  newBlock();
  for(const ln of song.lines){
    if(ln.type==='section'){
      newBlock();
      const s=document.createElement('div'); s.className='rsection'; s.textContent=ln.label; block.appendChild(s);
    } else if(isBlank(ln)){
      if(block && block.childNodes.length){
        const b=document.createElement('div'); b.style.height='8px'; block.appendChild(b);
      }
    } else {
      block.appendChild(buildRenderedLineEl(ln));
    }
  }
  return blocks.filter(b => b.childNodes.length);
}

function measureWidestLine(lyricSize, chordSize){
  const probe = document.createElement('div');
  probe.className = 'page-sheet measure-sheet';
  probe.style.setProperty('--exp-lyric', lyricSize + 'px');
  probe.style.setProperty('--exp-chord', lyricSize + 'px');
  probe.style.setProperty('--exp-lyric-font', document.getElementById('fontFamily').value);
  probe.style.setProperty('--exp-chord-font', document.getElementById('chordFamily').value);
  probe.style.padding = '0';
  probe.style.width = 'auto';
  probe.style.whiteSpace = 'nowrap';
  document.body.appendChild(probe);

  let maxW = 0;
  for(const ln of song.lines){
    if(ln.type !== 'lyric') continue;
    const { anchors } = lineToAnchors(ln);
    if(anchors.length === 0) continue;
    const el = buildRenderedLineEl(ln);
    el.style.display = 'block';
    probe.appendChild(el);
    const row = el.querySelector('.rcells');
    if(row){
      row.style.flexWrap = 'nowrap';
      const w = row.getBoundingClientRect().width;
      if(w > maxW) maxW = w;
    }
    probe.removeChild(el);
  }
  document.body.removeChild(probe);
  return maxW;
}

function measureHeights(els, colWidthPx, lyricSize, chordSize){
  const probe = document.createElement('div');
  probe.className = 'page-sheet measure-sheet';
  probe.style.setProperty('--exp-lyric', lyricSize + 'px');
  probe.style.setProperty('--exp-chord', chordSize + 'px');
  probe.style.setProperty('--exp-lyric-font', document.getElementById('fontFamily').value);
  probe.style.setProperty('--exp-chord-font', document.getElementById('chordFamily').value);
  probe.style.padding = '0';
  probe.style.width = colWidthPx + 'px';
  const clones = els.map(el => { const c = el.cloneNode(true); probe.appendChild(c); return c; });
  document.body.appendChild(probe);
  const heights = clones.map(c => {
    const style = getComputedStyle(c);
    return c.getBoundingClientRect().height + parseFloat(style.marginBottom||0);
  });
  document.body.removeChild(probe);
  return heights;
}

/* Flow blocks into `cols` newspaper columns, breaking to a new page when the
   current column is full. Returns the page→column→blockIndex structure. Pure
   given the measured heights, so the auto-fit search can call it repeatedly. */
function packPages(blockEls, headH, cols, colWidth, lyricSize, chordSize){
  const blockH = measureHeights(blockEls, colWidth, lyricSize, chordSize);
  const pages = [];
  let pageCols = null, c = 0, fill = 0;
  const newPage = (reserve) => {
    pageCols = Array.from({length: cols}, () => []);
    pages.push(pageCols);
    c = 0; fill = reserve || 0;
  };
  newPage(headH);
  for(let i=0; i<blockEls.length; i++){
    const h = blockH[i];
    if(fill > 0 && fill + h > CONTENT_H){
      if(c < cols - 1){ c++; fill = 0; }
      else { newPage(0); }
    }
    pageCols[c].push(i);
    fill += h;
  }
  return pages;
}

function colWidthFor(cols){ return (CONTENT_W - COL_GAP * (cols - 1)) / cols; }

/* Auto fit-to-page: treat the slider values as a *max* and pick the column
   count + largest font that packs onto a single page. Preference order is
   biggest lyric font, then fewest columns. If nothing fits on one page even at
   MIN_LYRIC, fall back to the layout with the fewest pages (then biggest font),
   keeping the font as large as the page width allows. */
function chooseAutoLayout(maxLyric, maxChord, headEl, blockEls){
  const chordRatio = maxLyric > 0 ? maxChord / maxLyric : 1;
  // Line width scales linearly with font size, so measure once and rescale.
  const widestRef = measureWidestLine(maxLyric, maxLyric);
  const headH = (ls, cs) => measureHeights([headEl], CONTENT_W, ls, cs)[0];

  // Largest lyric size that fits the column width for a given column count.
  const widthCapFor = (cols) => {
    const usable = colWidthFor(cols) - BLOCK_PAD;
    if(widestRef <= 0) return maxLyric;
    return Math.min(maxLyric, maxLyric * usable / widestRef);
  };

  let best = null;
  for(const cols of [1, 2, 3]){
    const colW = colWidthFor(cols);
    const widthCap = widthCapFor(cols);
    if(widthCap < MIN_LYRIC - 0.01) continue;   // can't fit width even at min
    const pagesAt = (ls) =>
      packPages(blockEls, headH(ls, ls * chordRatio), cols, colW, ls, ls * chordRatio).length;

    let fitFont = null;
    if(pagesAt(widthCap) <= 1){
      fitFont = widthCap;                        // already fits at the biggest width-legal size
    } else if(pagesAt(MIN_LYRIC) <= 1){
      let lo = MIN_LYRIC, hi = widthCap;         // binary-search the largest single-page size
      for(let k=0; k<7; k++){
        const mid = (lo + hi) / 2;
        if(pagesAt(mid) <= 1) lo = mid; else hi = mid;
      }
      fitFont = lo;
    }
    if(fitFont != null && (!best || fitFont > best.lyricSize + 0.01)){
      best = { cols, lyricSize: fitFont, chordSize: fitFont * chordRatio };
    }
  }
  if(best) return best;

  // Nothing fits on one page: minimize page count, then maximize font.
  let fb = null;
  for(const cols of [1, 2, 3]){
    const colW = colWidthFor(cols);
    const ls = Math.max(widthCapFor(cols), MIN_LYRIC);
    const cs = ls * chordRatio;
    const pages = packPages(blockEls, headH(ls, cs), cols, colW, ls, cs).length;
    if(!fb || pages < fb.pages - 0.01 ||
       (Math.abs(pages - fb.pages) < 0.01 && ls > fb.lyricSize + 0.01)){
      fb = { cols, lyricSize: ls, chordSize: cs, pages };
    }
  }
  return fb;
}

function buildRendered(){
  const area = document.getElementById('renderArea');
  area.innerHTML = '';

  const baseLyricSize = +document.getElementById('expLyricSize').value;
  const baseChordSize = +document.getElementById('expChordSize').value;

  const lyricFont = document.getElementById('fontFamily').value;
  const chordFont = document.getElementById('chordFamily').value;

  const headEl = buildHeadEl();
  const blockEls = buildBlockEls();

  let cols, lyricSize, chordSize;
  if(exportCols === 'auto'){
    const pick = chooseAutoLayout(baseLyricSize, baseChordSize, headEl, blockEls);
    cols = pick.cols; lyricSize = pick.lyricSize; chordSize = pick.chordSize;
  } else {
    cols = exportCols;
    const usableColW = colWidthFor(cols) - BLOCK_PAD;
    lyricSize = baseLyricSize;
    chordSize = baseChordSize;
    const widest = measureWidestLine(baseLyricSize, baseChordSize);
    if(widest > usableColW && widest > 0){
      let scale = usableColW / widest;
      const minScale = Math.min(1, MIN_LYRIC / baseLyricSize);
      scale = Math.max(scale, minScale);
      lyricSize = baseLyricSize * scale;
      chordSize = baseChordSize * scale;
    }
  }

  // Show "13px → 18.0px" whenever the rendered size differs from the slider,
  // whether auto grew it to fill the page or shrank it to fit the width.
  const changed = Math.abs(lyricSize - baseLyricSize) > 0.2;
  document.getElementById('expLyricVal').textContent =
    changed ? `${baseLyricSize}px → ${lyricSize.toFixed(1)}px` : `${baseLyricSize}px`;
  document.getElementById('expChordVal').textContent =
    changed ? `${baseChordSize}px → ${chordSize.toFixed(1)}px` : `${baseChordSize}px`;

  const colWidth = colWidthFor(cols);
  const headH = measureHeights([headEl], CONTENT_W, lyricSize, chordSize)[0];
  const pages = packPages(blockEls, headH, cols, colWidth, lyricSize, chordSize);

  pages.forEach((pageCols, pi) => {
    const sheet = document.createElement('div');
    sheet.className = 'page-sheet';
    sheet.style.setProperty('--exp-lyric', lyricSize + 'px');
    sheet.style.setProperty('--exp-chord', chordSize + 'px');
    sheet.style.setProperty('--exp-lyric-font', lyricFont);
    sheet.style.setProperty('--exp-chord-font', chordFont);

    if(pi === 0) sheet.appendChild(headEl);

    const body = document.createElement('div'); body.className='rbody';
    for(let c=0; c<cols; c++){
      const colDiv = document.createElement('div'); colDiv.className='rcol';
      const indices = pageCols[c] || [];
      for(const idx of indices){
        colDiv.appendChild(blockEls[idx].cloneNode(true));
      }
      body.appendChild(colDiv);
    }
    sheet.appendChild(body);

    if(pages.length > 1){
      const pn = document.createElement('div'); pn.className='pagenum';
      pn.textContent = `${pi+1} / ${pages.length}`;
      sheet.appendChild(pn);
    }
    area.appendChild(sheet);
  });
}

function renderedToText(){
  const m=song.meta;
  const out=[];
  if(m.title) out.push(m.title);
  if(m.artist) out.push(m.artist);
  const kl=[];
  if(m.key) kl.push('Key - '+m.key);
  if(m.tempo) kl.push('Tempo - '+m.tempo);
  if(m.time) kl.push('Time - '+m.time);
  if(kl.length) out.push(kl.join(' | '));
  const road = roadmapTokens(m.roadmap);
  if(road.length) out.push('Road map: ' + road.join('  '));
  if(m.notes && m.notes.trim()) out.push('Notes: ' + m.notes.replace(/\n/g,'\n       '));
  out.push('');
  for(const ln of song.lines){
    if(ln.type==='section'){ out.push(ln.label.toUpperCase()); }
    else if(isBlank(ln)){ out.push(''); }
    else {
      const {chords,lyrics}=lineToAscii(ln);
      if(chords.trim()!=='') out.push(chords);
      out.push(lyrics);
    }
  }
  const foot=[];
  if(m.ccli) foot.push('CCLI Song # '+m.ccli);
  if(m.copyright) foot.push('© '+m.copyright);
  if(m.ccli_license) foot.push('CCLI License # '+m.ccli_license);
  if(foot.length){ out.push(''); out.push(...foot); }
  return out.join('\n');
}

function fnameBase(){
  return (song.meta.title||'song').replace(/[^a-z0-9]+/gi,'_').replace(/^_+|_+$/g,'') || 'song';
}
// Browsers use document.title as the default "Save as PDF" filename, so build a
// clean hyphenated name from the song title (e.g. "And-Can-It-Be").
function pdfBase(){
  return (song.meta.title||'song').replace(/[^a-z0-9]+/gi,'-').replace(/^-+|-+$/g,'') || 'song';
}
function download(filename, text){
  try {
    const blob=new Blob([text],{type:'text/plain;charset=utf-8'});
    const url=URL.createObjectURL(blob);
    const a=document.createElement('a');
    a.href=url; a.download=filename; a.rel='noopener';
    document.body.appendChild(a);
    a.click();
    setTimeout(()=>{ a.remove(); URL.revokeObjectURL(url); }, 1000);
  } catch(e){
    showTextFallback(filename, text);
  }
}

function showTextFallback(filename, text){
  let bg = document.getElementById('dlFallback');
  if(bg) bg.remove();
  bg = document.createElement('div');
  bg.id = 'dlFallback';
  bg.style.cssText = 'position:fixed;inset:0;z-index:300;background:rgba(28,20,16,.55);display:flex;align-items:center;justify-content:center;padding:24px;';

  const card = document.createElement('div');
  card.style.cssText = "background:#fff;max-width:640px;width:100%;border-radius:6px;border:1.5px solid #161616;padding:18px;font-family:'IBM Plex Mono',monospace;";

  const msg = document.createElement('div');
  msg.style.cssText = 'font-size:13px;margin-bottom:10px;';
  msg.textContent = 'Save the text below as ' + filename + ' (or use Download / Copy):';

  const ta = document.createElement('textarea');
  ta.readOnly = true;
  ta.style.cssText = "width:100%;height:240px;font-family:'IBM Plex Mono',monospace;font-size:12px;border:1px solid #ccc;border-radius:4px;padding:8px;white-space:pre;";
  ta.value = text;

  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:8px;margin-top:10px;';
  const btnStyle = "font-family:'IBM Plex Mono',monospace;font-size:12px;padding:7px 12px;border:1.5px solid #161616;border-radius:3px;cursor:pointer;";

  const dl = document.createElement('button');
  dl.style.cssText = btnStyle + 'background:#161616;color:#fff;';
  dl.textContent = 'Download';
  dl.onclick = () => {
    try {
      const blob = new Blob([text], {type:'text/plain;charset=utf-8'});
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click();
      setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 1000);
      toast('Downloaded ' + filename);
    } catch(e){ toast('Download blocked — use Copy'); }
  };

  const copy = document.createElement('button');
  copy.style.cssText = btnStyle + 'background:#fff;color:#161616;';
  copy.textContent = 'Copy text';
  copy.onclick = () => {
    ta.select();
    try { navigator.clipboard.writeText(text); } catch(e){ try{ document.execCommand('copy'); }catch(_){} }
    toast('Copied');
  };

  const close = document.createElement('button');
  close.style.cssText = btnStyle + 'background:#fff;color:#161616;margin-left:auto;';
  close.textContent = 'Close';
  close.onclick = () => bg.remove();

  row.appendChild(dl); row.appendChild(copy); row.appendChild(close);
  card.appendChild(msg); card.appendChild(ta); card.appendChild(row);
  bg.appendChild(card);
  document.body.appendChild(bg);
  bg.onclick = e => { if(e.target===bg) bg.remove(); };
  ta.focus(); ta.select();
}
function downloadRenderedTxt(){ showTextFallback(fnameBase()+'-rendered.txt', renderedToText()); }
function downloadSource(){ showTextFallback(fnameBase()+'.pro', toChordPro(song)); }
function copySource(){
  navigator.clipboard.writeText(toChordPro(song)).then(()=>toast('Copied source')).catch(()=>toast('Copy failed'));
}

function buildPrintDocHTML(){
  const m = song.meta;
  const firstSheet = document.querySelector('#renderArea .page-sheet');
  const lyricSize = firstSheet
    ? parseFloat(getComputedStyle(firstSheet).getPropertyValue('--exp-lyric'))
    : +document.getElementById('expLyricSize').value;
  const chordSize = firstSheet
    ? parseFloat(getComputedStyle(firstSheet).getPropertyValue('--exp-chord'))
    : +document.getElementById('expChordSize').value;
  const lyricFont = document.getElementById('fontFamily').value;
  const chordFont = document.getElementById('chordFamily').value;

  const LT = String.fromCharCode(60);
  const sheets = document.querySelectorAll('#renderArea .page-sheet');
  let pagesHTML = '';
  sheets.forEach((s, i) => {
    const clone = s.cloneNode(true);
    clone.querySelectorAll('.pagenum').forEach(p => p.remove());
    pagesHTML += LT+'div class="psheet' + (i < sheets.length-1 ? ' brk' : '') + '">' + clone.innerHTML + LT+'/div>';
  });

  const css = [
    "@page { size: letter; margin: 0; }",
    "* { box-sizing: border-box; }",
    "html,body{ margin:0; padding:0; background:#fff; }",
    "body{ font-family:" + lyricFont + "; color:#111; }",
    ".psheet{ width:8.5in; height:11in; padding:0.6in; overflow:hidden; position:relative; --exp-lyric:" + lyricSize + "px; --exp-chord:" + chordSize + "px; }",
    ".psheet.brk{ page-break-after:always; }",
    "h2{ font-family:" + lyricFont + "; font-weight:900; font-size:26px; margin:0 0 2px; }",
    ".credit{ font-family:'IBM Plex Mono',monospace; font-size:12px; color:#555; }",
    ".keyline{ font-family:'IBM Plex Mono',monospace; font-size:12px; font-weight:600; margin-bottom:0; }",
    ".roadline{ display:flex; flex-wrap:wrap; gap:5px; justify-content:flex-end; }",
    ".roadline .rchip{ font-family:'IBM Plex Mono',monospace; font-size:10px; font-weight:700; letter-spacing:.06em; text-transform:uppercase; color:#000; border:1px solid #000; border-radius:2px; padding:1px 5px; }",
    ".noteline{ font-family:'IBM Plex Mono',monospace; font-size:11px; font-style:italic; color:#444; white-space:pre-wrap; align-self:stretch; text-align:left; }",
    ".rhead{ margin-bottom:16px; display:flex; justify-content:space-between; align-items:flex-start; gap:0.4in; }",
    ".rhead-left{ min-width:0; }",
    ".rhead-right{ display:flex; flex-direction:column; align-items:flex-end; gap:6px; max-width:3in; flex-shrink:0; text-align:right; }",
    ".rbody{ display:flex; gap:0.3in; align-items:flex-start; }",
    ".rcol{ flex:1; min-width:0; }",
    ".rblock{ margin-bottom:14px; padding-right:0.12in; overflow:hidden; }",
    ".rsection{ font-family:'IBM Plex Mono',monospace; font-weight:700; font-size:12px; letter-spacing:.1em; text-transform:uppercase; margin:0 0 6px; }",
    ".rline{ margin-bottom:8px; }",
    ".rcells{ display:flex; flex-wrap:wrap; align-items:flex-end; }",
    ".rcell{ display:inline-flex; flex-direction:column; align-items:flex-start; }",
    ".rcellchord{ font-family:" + chordFont + "; font-size:" + chordSize + "px; font-weight:600; color:#000; line-height:1.05; white-space:pre; padding-right:0.4em; }",
    ".rcelltext{ font-family:" + lyricFont + "; font-size:" + lyricSize + "px; line-height:1.15; white-space:pre; color:#111; }",
    "@media screen { body{ background:#e9e9e9; } .psheet{ margin:16px auto; box-shadow:0 4px 16px rgba(0,0,0,.3); background:#fff; } }"
  ].join('\n');

  const title = (m.title || 'song');
  return [
    LT+'!doctype html>'+LT+'html>'+LT+'head>'+LT+'meta charset="utf-8">'+LT+'title>', title,
    LT+'/title>'+LT+'style>', css, LT+'/style>'+LT+'/head>'+LT+'body>', pagesHTML,
    LT+'/body>'+LT+'/html>'
  ].join('');
}

function printRendered(){
  const sheets = document.querySelectorAll('#renderArea .page-sheet');
  if(!sheets.length){ toast('Nothing to print yet'); return; }

  let sandboxed = false;
  try {
    const href = (location && location.href) || '';
    if(href.indexOf('about:srcdoc') === 0 || href === 'about:blank' || href === '') sandboxed = true;
    if(window.top !== window.self) {
      try { void window.top.location.href; } catch(e){ sandboxed = true; }
    }
  } catch(e){ sandboxed = true; }

  if(sandboxed){ showPrintDocFallback(); return; }

  const lyricFont = document.getElementById('fontFamily').value;
  const chordFont = document.getElementById('chordFamily').value;
  const firstSheet = document.querySelector('#renderArea .page-sheet');
  const lyricSize = firstSheet ? parseFloat(getComputedStyle(firstSheet).getPropertyValue('--exp-lyric')) : 13;
  const chordSize = firstSheet ? parseFloat(getComputedStyle(firstSheet).getPropertyValue('--exp-chord')) : 12;

  let host = document.getElementById('print-host');
  if(host) host.remove();
  host = document.createElement('div');
  host.id = 'print-host';
  sheets.forEach((s, i) => {
    const page = document.createElement('div');
    page.className = 'psheet' + (i < sheets.length-1 ? ' brk' : '');
    const clone = s.cloneNode(true);
    clone.querySelectorAll('.pagenum').forEach(p => p.remove());
    while(clone.firstChild) page.appendChild(clone.firstChild);
    host.appendChild(page);
  });

  let pstyle = document.getElementById('print-style');
  if(pstyle) pstyle.remove();
  pstyle = document.createElement('style');
  pstyle.id = 'print-style';
  pstyle.textContent =
    '#print-host{display:none;}' +
    '@media print{' +
    '@page{size:letter;margin:0;}' +
    'html,body{margin:0!important;padding:0!important;background:#fff!important;}' +
    'body>*:not(#print-host){display:none!important;}' +
    '#print-host{display:block!important;}' +
    '.psheet{width:8.5in;height:11in;padding:0.6in;overflow:hidden;position:relative;box-sizing:border-box;color:#111;' +
      'font-family:' + lyricFont + ';--exp-lyric:' + lyricSize + 'px;--exp-chord:' + chordSize + 'px;}' +
    '.psheet.brk{page-break-after:always;}' +
    '#print-host h2{font-family:' + lyricFont + ';font-weight:900;font-size:26px;margin:0 0 2px;}' +
    '#print-host .credit{font-family:\'IBM Plex Mono\',monospace;font-size:12px;color:#555;}' +
    '#print-host .keyline{font-family:\'IBM Plex Mono\',monospace;font-size:12px;font-weight:600;margin-bottom:0;}' +
    '#print-host .roadline{display:flex;flex-wrap:wrap;gap:5px;justify-content:flex-end;}' +
    '#print-host .roadline .rchip{font-family:\'IBM Plex Mono\',monospace;font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#000;border:1px solid #000;border-radius:2px;padding:1px 5px;}' +
    '#print-host .noteline{font-family:\'IBM Plex Mono\',monospace;font-size:11px;font-style:italic;color:#444;white-space:pre-wrap;align-self:stretch;text-align:left;}' +
    '#print-host .rhead{margin-bottom:16px;display:flex;justify-content:space-between;align-items:flex-start;gap:0.4in;}' +
    '#print-host .rhead-left{min-width:0;}' +
    '#print-host .rhead-right{display:flex;flex-direction:column;align-items:flex-end;gap:6px;max-width:3in;flex-shrink:0;text-align:right;}' +
    '#print-host .rbody{display:flex;gap:0.3in;align-items:flex-start;}' +
    '#print-host .rcol{flex:1;min-width:0;}' +
    '#print-host .rblock{margin-bottom:14px;padding-right:0.12in;overflow:hidden;}' +
    '#print-host .rsection{font-family:\'IBM Plex Mono\',monospace;font-weight:700;font-size:12px;letter-spacing:.1em;text-transform:uppercase;margin:0 0 6px;}' +
    '#print-host .rline{margin-bottom:8px;}' +
    '#print-host .rcells{display:flex;flex-wrap:wrap;align-items:flex-end;}' +
    '#print-host .rcell{display:inline-flex;flex-direction:column;align-items:flex-start;}' +
    '#print-host .rcellchord{font-family:' + chordFont + ';font-size:' + chordSize + 'px;font-weight:600;color:#000;line-height:1.05;white-space:pre;padding-right:0.4em;}' +
    '#print-host .rcelltext{font-family:' + lyricFont + ';font-size:' + lyricSize + 'px;line-height:1.15;white-space:pre;color:#111;}' +
    '}';
  document.head.appendChild(pstyle);
  document.body.appendChild(host);

  const prevTitle = document.title;
  document.title = pdfBase();

  const cleanup = () => {
    host.remove(); pstyle.remove();
    document.title = prevTitle;
    window.removeEventListener('afterprint', cleanup);
  };
  window.addEventListener('afterprint', cleanup);
  setTimeout(() => { try { window.print(); } catch(e){ showPrintDocFallback(); } setTimeout(cleanup, 2000); }, 60);
}

function showPrintDocFallback(){
  const html = buildPrintDocHTML();
  const filename = fnameBase() + '.html';

  let bg = document.getElementById('dlFallback');
  if(bg) bg.remove();
  bg = document.createElement('div');
  bg.id = 'dlFallback';
  bg.style.cssText = 'position:fixed;inset:0;z-index:300;background:rgba(28,20,16,.55);display:flex;align-items:center;justify-content:center;padding:24px;';

  const card = document.createElement('div');
  card.style.cssText = "background:#fff;max-width:560px;width:100%;border-radius:6px;border:1.5px solid #161616;padding:20px;font-family:'IBM Plex Mono',monospace;";

  const h = document.createElement('div');
  h.style.cssText = 'font-size:14px;font-weight:600;margin-bottom:8px;';
  h.textContent = 'Print / Save as PDF';

  const p = document.createElement('div');
  p.style.cssText = 'font-size:12.5px;line-height:1.5;margin-bottom:14px;color:#333;';
  p.textContent = "Printing straight from the app is blocked in this preview. Download the print-ready page (sized to US Letter), open the saved file in your browser, and use Ctrl/Cmd + P to print or Save as PDF.";

  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;';

  const btnStyle = "font-family:'IBM Plex Mono',monospace;font-size:12px;padding:9px 14px;border:1.5px solid #161616;border-radius:3px;cursor:pointer;";

  const dl = document.createElement('button');
  dl.style.cssText = btnStyle + 'background:#8c3b2b;color:#fff;';
  dl.textContent = 'Download print page';
  dl.onclick = () => {
    try {
      const blob = new Blob([html], {type:'text/html;charset=utf-8'});
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click();
      setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 1000);
      toast('Downloaded ' + filename);
    } catch(e){
      toast('Download blocked — use Copy HTML');
    }
  };

  const copy = document.createElement('button');
  copy.style.cssText = btnStyle + 'background:#fff;color:#161616;';
  copy.textContent = 'Copy HTML';
  copy.onclick = () => {
    try { navigator.clipboard.writeText(html); toast('Copied — paste into a .html file'); }
    catch(e){ toast('Copy failed'); }
  };

  const close = document.createElement('button');
  close.style.cssText = btnStyle + 'background:#fff;color:#161616;margin-left:auto;';
  close.textContent = 'Close';
  close.onclick = () => bg.remove();

  row.appendChild(dl); row.appendChild(copy); row.appendChild(close);
  card.appendChild(h); card.appendChild(p); card.appendChild(row);
  bg.appendChild(card);
  document.body.appendChild(bg);
  bg.onclick = e => { if(e.target===bg) bg.remove(); };
}

/* ---------- toast ---------- */
let toastTimer=null;
function toast(msg){
  const t=document.getElementById('toast'); t.textContent=msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer=setTimeout(()=>t.classList.remove('show'),2200);
}

/* ============================================================
   BOOT — load the sample "And Can It Be" so it's not empty
   ============================================================ */
const SAMPLE = `{title: And Can It Be}
{artist: Words by Charles Wesley, Music by Thomas Campbell}
{key: D}
{tempo: 110}
{time: 4/4}
{ccli_license: 2350}
{ccli: 25280}
{copyright: Words: Public Domain | Music: Public Domain}
{roadmap: Intro V1 V2 CH V3 CH Out}
{notes: Build into the last chorus — drums drop out on "amazing love".}

{comment: Verse 1}
[D]And can it be that  [G]I     [A7]should [D]gain
An [G]in  -  [A]t'rest [D/F#]in the [A/E]Sav - [E7]ior's   [A]blood
[A]Died He for [D/A]me     [A]  who [D/F#]caused [D]His    [A]pain
For [G]me who [D/F#]Him     [G]   to [D/A]death [A7]pur - [D]sued

[D]A  -  [A]mazing [D/F#]love! How [G]can  [E7/G#]it     [A]be
That [D]Thou     my [G]God      shouldst [A]die     for [D]me`;

restoreFontSettings();
applyFont();
song = bootProjects();
render();
if(document.fonts && document.fonts.ready){ document.fonts.ready.then(positionChords); }
