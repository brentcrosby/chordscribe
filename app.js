/* ============================================================
   DATA MODEL
   A song = { meta: {...}, lines: [ line, ... ] }
   line types:
     { type:'section', label:'Verse 1' }
     { type:'blank' }
     { type:'lyric', segments:[ {chord:'D', text:'And can it be that '}, ... ] }
   A segment with chord:null and text means plain text.
   Empty leading segment {chord:'D', text:''} is allowed (chord with no word).
   ============================================================ */

let song = { meta: {}, lines: [] };
let mode = 'chord';
const META_ORDER = ['title','artist','key','tempo','time'];
const META_KEEP = ['ccli_license','ccli','copyright','footer']; // preserved, not shown as inputs

/* ============================================================
   UNDO / REDO
   We snapshot the whole song (deep JSON clone) onto an undo stack before a
   change. Structural changes snapshot immediately; typing snapshots once per
   burst (debounced) so one undo reverts a whole typing run, not each letter.
   ============================================================ */
let undoStack = [];
let redoStack = [];
const HISTORY_LIMIT = 100;
let typingTimer = null;

function snapshot(){ return JSON.stringify(song); }
function restore(s){ song = JSON.parse(s); }

/* Call BEFORE a structural mutation. */
function pushHistory(){
  if(typingTimer){ clearTimeout(typingTimer); typingTimer = null; }
  undoStack.push(snapshot());
  if(undoStack.length > HISTORY_LIMIT) undoStack.shift();
  redoStack = [];
}

/* Call at the START of a typing edit, BEFORE mutating the model. The first
   keystroke of a burst pushes the pre-edit state; subsequent keystrokes
   within the idle window are folded into the same undo step. */
function pushHistoryTyping(){
  if(typingTimer === null){
    undoStack.push(snapshot());
    if(undoStack.length > HISTORY_LIMIT) undoStack.shift();
    redoStack = [];
  } else {
    clearTimeout(typingTimer);
  }
  typingTimer = setTimeout(() => { typingTimer = null; }, 700);
}

function undo(){
  if(typingTimer){ clearTimeout(typingTimer); typingTimer = null; }
  if(undoStack.length === 0) return;
  redoStack.push(snapshot());
  restore(undoStack.pop());
  clearSelection();
  render();
}
function redo(){
  if(redoStack.length === 0) return;
  undoStack.push(snapshot());
  restore(redoStack.pop());
  clearSelection();
  render();
}

document.addEventListener('keydown', e => {
  const mod = e.ctrlKey || e.metaKey;
  if(!mod) return;
  const k = e.key.toLowerCase();
  if(k === 'z' && !e.shiftKey){ e.preventDefault(); undo(); }
  else if((k === 'z' && e.shiftKey) || k === 'y'){ e.preventDefault(); redo(); }
});

/* ---------- PARSER: ChordPro -> model ---------- */
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
        out.meta[key] = val;
      }
      continue;
    }
    if(line.trim()===''){ out.lines.push({type:'blank'}); continue; }
    // skip CCLI trailer plain-text lines if they duplicate meta (keep them as lyric otherwise? no—drop bare CCLI footer)
    out.lines.push({ type:'lyric', segments: parseSegments(line) });
  }
  // Trim trailing blanks
  while(out.lines.length && out.lines[out.lines.length-1].type==='blank') out.lines.pop();
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

/* ---------- SERIALIZER: model -> ChordPro source ---------- */
function toChordPro(s){
  const lines = [];
  // meta block in canonical order
  for(const k of META_ORDER){ if(s.meta[k]!==undefined) lines.push(`{${k}: ${s.meta[k]}}`); }
  for(const k of META_KEEP){ if(s.meta[k]!==undefined) lines.push(`{${k}: ${s.meta[k]}}`); }
  // any other meta we didn't anticipate
  for(const k in s.meta){
    if(!META_ORDER.includes(k) && !META_KEEP.includes(k)) lines.push(`{${k}: ${s.meta[k]}}`);
  }
  lines.push('');
  for(const ln of s.lines){
    if(ln.type==='blank'){ lines.push(''); }
    else if(ln.type==='section'){ lines.push(`{comment: ${ln.label}}`); }
    else if(ln.type==='lyric'){
      let str='';
      for(const seg of ln.segments){
        if(seg.chord!==null && seg.chord!==undefined) str += `[${seg.chord}]`;
        str += seg.text;
      }
      lines.push(str);
    }
  }
  return lines.join('\n');
}

/* ---------- RENDER: model -> stacked ASCII (chords over lyrics) ---------- */
function lineToAscii(ln){
  // returns {chords, lyrics} two strings aligned by column
  let lyric = '';
  let chord = '';
  for(const seg of ln.segments){
    const c = (seg.chord!==null && seg.chord!==undefined) ? seg.chord : '';
    // place chord at current lyric column
    if(c){
      // pad chord line up to current lyric length
      while(chord.length < lyric.length) chord += ' ';
      chord += c;
    }
    lyric += seg.text;
  }
  return { chords: chord.replace(/\s+$/,''), lyrics: lyric };
}

/* Return {lyrics, anchors:[{col, chord}]} where col is the character
   offset into the lyric string. Used for export rendering where chords
   are positioned by character column rather than space-padding, so chord
   font size can differ from lyric size without breaking alignment. */
function lineToAnchors(ln){
  let lyric = '';
  const anchors = [];
  for(const seg of ln.segments){
    const c = (seg.chord!==null && seg.chord!==undefined) ? seg.chord : '';
    if(c) anchors.push({ col: lyric.length, chord: c });
    lyric += seg.text;
  }
  return { lyrics: lyric, anchors };
}

/* ============================================================
   RENDERING THE EDITOR
   ============================================================ */
function render(){
  renderMeta();
  renderHint();
  updateClipBar();
  const ub = document.getElementById('undoBtn'); if(ub) ub.disabled = undoStack.length === 0;
  const rb = document.getElementById('redoBtn'); if(rb) rb.disabled = redoStack.length === 0;
  const sheet = document.getElementById('sheet');
  sheet.innerHTML = '';
  document.getElementById('addRow').style.display = (mode==='lyric') ? 'flex' : 'none';

  if(song.lines.length===0){
    sheet.textContent = '';
    const es = document.createElement('div');
    es.className = 'empty-state';
    es.textContent = 'No song loaded. Import a ChordPro file, or switch to Lyric Mode and start adding lines.';
    sheet.appendChild(es);
    return;
  }

  song.lines.forEach((ln, idx) => {
    if(ln.type==='section'){ sheet.appendChild(renderSection(ln, idx)); }
    else if(ln.type==='blank'){
      const d = document.createElement('div');
      d.className = 'song-line empty-line';
      d.appendChild(lineControls(idx));
      sheet.appendChild(d);
    }
    else { sheet.appendChild(renderLyric(ln, idx)); }
  });

  // Autosize textareas after they're actually in the DOM and laid out,
  // otherwise scrollHeight reads 0 and they collapse to nothing.
  if(mode==='lyric'){
    requestAnimationFrame(() => {
      document.querySelectorAll('.lyric-edit-line').forEach(autosize);
    });
  }
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

function renderHint(){
  const h = document.getElementById('hint');
  h.textContent = '';
  const b = document.createElement('b');
  if(mode==='chord'){
    b.textContent = 'Chord Mode';
    h.appendChild(b);
    h.appendChild(document.createTextNode(' — click any word (or the gap before it) to add, change, or remove a chord. Chords sit above the word they start on.'));
  } else {
    b.textContent = 'Lyric Mode';
    h.appendChild(b);
    h.appendChild(document.createTextNode(' — edit the words freely. Type to change lyrics, add new lines, or rename sections. Existing chords stay attached to the text around them.'));
  }
}

function renderSection(ln, idx){
  const d = document.createElement('div');
  d.className = 'section-label';
  if(mode==='lyric'){
    const inp = document.createElement('input');
    inp.value = ln.label;
    inp.oninput = e => { pushHistoryTyping(); ln.label = e.target.value; };
    const bar=document.createElement('span'); bar.className='bar';
    // copy whole section
    const copy=document.createElement('button'); copy.className='secbtn'; copy.textContent='Copy';
    copy.title='Copy this whole section';
    copy.onclick=()=>copySection(idx);
    // paste below this section (only when something is on the clipboard)
    const del = document.createElement('button'); del.className='del'; del.textContent='✕';
    del.title='Delete section line';
    del.onclick = () => { pushHistory(); song.lines.splice(idx,1); render(); };
    d.appendChild(inp);
    d.appendChild(bar);
    if(clip){
      const [, e] = sectionRange(idx);
      const paste=document.createElement('button'); paste.className='secbtn paste'; paste.textContent='Paste below';
      paste.title='Paste clipboard after this section';
      paste.onclick=()=>pasteAfter(e-1);
      d.appendChild(paste);
    }
    d.appendChild(copy);
    d.appendChild(del);
  } else {
    const span=document.createElement('span'); span.textContent=ln.label;
    d.appendChild(span);
    const bar=document.createElement('span'); bar.className='bar'; d.appendChild(bar);
    // copy/paste available in chord mode as well
    if(clip){
      const [, e] = sectionRange(idx);
      const paste=document.createElement('button'); paste.className='secbtn paste'; paste.textContent='Paste below';
      paste.title='Paste clipboard after this section';
      paste.onclick=()=>pasteAfter(e-1);
      d.appendChild(paste);
    }
    const copy=document.createElement('button'); copy.className='secbtn'; copy.textContent='Copy';
    copy.title='Copy this whole section';
    copy.onclick=()=>copySection(idx);
    d.appendChild(copy);
  }
  return d;
}

/* ----- CHORD MODE: tokenize a lyric line into clickable tokens ----- */
function renderLyric(ln, idx){
  const d = document.createElement('div');
  d.className = 'song-line';
  d.dataset.idx = idx;
  if(selection.has(ln)) d.classList.add('selected');

  if(mode==='lyric'){
    // selection checkbox (left gutter)
    const chk = document.createElement('input');
    chk.type = 'checkbox'; chk.className = 'sel-check';
    chk.checked = selection.has(ln);
    chk.title = 'Select this line for copying';
    chk.onchange = e => {
      if(e.target.checked) selection.add(ln); else selection.delete(ln);
      d.classList.toggle('selected', e.target.checked);
      updateClipBar();
    };
    d.appendChild(chk);

    // editable textarea showing plain lyrics
    const ta = document.createElement('textarea');
    ta.className = 'lyric-edit-line';
    ta.rows = 1;
    ta.value = segmentsToPlain(ln.segments);
    ta.placeholder = '(lyric line)';
    ta.oninput = e => {
      pushHistoryTyping();
      relyric(ln, e.target.value);
      autosize(ta);
    };
    d.appendChild(ta);
    d.appendChild(lineControls(idx));
    return d;
  }

  // CHORD MODE
  const row = document.createElement('div');
  row.className = 'tokrow';
  const tokens = buildTokens(ln);
  tokens.forEach(tok => row.appendChild(renderToken(ln, tok)));
  d.appendChild(row);
  return d;
}

/* Build clickable tokens out of a line's segments.
   Each token = a position where a chord can live + the run of text after it
   up to the next natural break (space or hyphen kept with text).
   We split text so that words/syllables become individually clickable,
   while preserving exactly where chords currently anchor. */
function buildTokens(ln){
  // Flatten into a char array with chord-anchor markers.
  // We'll produce tokens at: each existing chord anchor, and each
  // word/syllable boundary so any word is clickable.
  const tokens = [];
  ln.segments.forEach((seg, si) => {
    const text = seg.text;
    const anchorChord = (seg.chord!==null && seg.chord!==undefined) ? seg.chord : null;

    // Split this segment's text into clickable pieces but keep first piece
    // bound to the segment's chord anchor.
    // Pieces: break on spaces (space attaches to preceding piece) and on hyphens.
    const pieces = splitClickable(text);
    if(pieces.length===0){
      // empty text but maybe has a chord (standalone chord)
      tokens.push({ segIndex: si, offset: 0, text:'', chord: anchorChord, isAnchor:true });
      return;
    }
    pieces.forEach((p, pi) => {
      tokens.push({
        segIndex: si,
        offset: p.offset,
        text: p.text,
        chord: (pi===0) ? anchorChord : null,
        isAnchor: (pi===0)
      });
    });
  });
  return tokens;
}

/* split text into clickable pieces.
   Each piece carries its starting offset within the segment text. */
function splitClickable(text){
  const pieces = [];
  if(text==='') return pieces;
  // Tokenize keeping spaces grouped with the following content boundaries.
  // We'll break before each non-space run, and break after hyphens.
  let i=0;
  const re = /\S+\s*|\s+/g; // word(+trailing spaces) OR pure spaces
  let m;
  while((m = re.exec(text))!==null){
    let chunk = m[0];
    let base = m.index;
    // further split chunk on internal hyphens so each syllable clickable
    // keep the hyphen + surrounding spaces with left piece
    const sub = chunk.split(/(?<=-)/); // split after each hyphen
    let local = 0;
    for(const s of sub){
      if(s==='') continue;
      pieces.push({ text:s, offset: base+local });
      local += s.length;
    }
  }
  return pieces;
}

function renderToken(ln, tok){
  const t = document.createElement('span');
  t.className = 'tok' + (tok.chord ? ' has-chord':'');
  // chord slot
  const cs = document.createElement('span'); cs.className='chordslot';
  if(tok.chord){
    const tag=document.createElement('span'); tag.className='chordtag'; tag.textContent=tok.chord;
    cs.appendChild(tag);
  } else {
    const ph=document.createElement('span'); ph.className='placeholder'; ph.textContent='+';
    cs.appendChild(ph);
  }
  // text
  const txt = document.createElement('span'); txt.className='txt';
  if(tok.text.trim()===''){ txt.classList.add('space-tok'); txt.textContent = tok.text || ' '; }
  else txt.textContent = tok.text;

  t.appendChild(cs); t.appendChild(txt);
  t.onclick = (e) => { e.stopPropagation(); openChordPop(t, ln, tok); };
  return t;
}

/* ---------- chord popover ---------- */
let activePop = null;
function closePop(){ if(activePop){ activePop.remove(); activePop=null; } }
document.addEventListener('click', closePop);

function openChordPop(anchorEl, ln, tok){
  closePop();
  const pop = document.createElement('div');
  pop.className='pop';
  pop.onclick = e => e.stopPropagation();

  const title = document.createElement('div'); title.className='poptitle';
  title.textContent = tok.text.trim() ? `Chord on "${tok.text.trim()}"` : 'Chord here';
  pop.appendChild(title);

  const inp = document.createElement('input');
  inp.value = tok.chord || '';
  inp.placeholder = 'e.g. D, G, A7, D/F#';
  pop.appendChild(inp);

  // quick chords from this song
  const used = collectChords();
  if(used.length){
    const qr = document.createElement('div'); qr.className='quickrow';
    used.slice(0,12).forEach(c => {
      const b=document.createElement('span'); b.className='q'; b.textContent=c;
      b.onclick = () => { inp.value=c; };
      qr.appendChild(b);
    });
    pop.appendChild(qr);
  }

  const btns = document.createElement('div'); btns.className='popbtns';
  const save = document.createElement('button'); save.textContent='Set'; save.className='primary';
  save.onclick = () => { setChord(ln, tok, inp.value.trim()); closePop(); render(); };
  const rm = document.createElement('button'); rm.textContent='Remove'; rm.className='rm';
  rm.disabled = !tok.chord;
  rm.onclick = () => { setChord(ln, tok, ''); closePop(); render(); };
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
  inp.onkeydown = e => {
    if(e.key==='Enter'){ setChord(ln, tok, inp.value.trim()); closePop(); render(); }
    if(e.key==='Escape'){ closePop(); }
  };
}

function collectChords(){
  const set = [];
  for(const ln of song.lines){
    if(ln.type!=='lyric') continue;
    for(const s of ln.segments){
      if(s.chord && !set.includes(s.chord)) set.push(s.chord);
    }
  }
  return set;
}

/* ---------- editing operations on the model ---------- */
/* Set or remove a chord at a token position.
   The token references segIndex + offset within that segment's text.
   To set a chord at an arbitrary offset, we split the segment there. */
function setChord(ln, tok, chordVal){
  const segs = ln.segments;
  const seg = segs[tok.segIndex];
  if(!seg) return;
  pushHistory();

  if(tok.offset===0){
    // chord lands exactly on segment start -> just set/clear its chord
    if(chordVal==='') {
      // removing: merge into previous segment's text if previous has no need
      seg.chord = null;
      mergeNeighbors(ln);
    } else {
      seg.chord = chordVal;
    }
    return;
  }

  // need to split seg at offset
  const before = seg.text.slice(0, tok.offset);
  const after = seg.text.slice(tok.offset);
  if(chordVal===''){
    // there was no chord here (offset>0 means it was inside text, no chord) -> nothing to remove
    return;
  }
  // replace seg with [beforeSeg(keep chord), newSeg(chordVal, after)]
  const beforeSeg = { chord: seg.chord, text: before };
  const newSeg = { chord: chordVal, text: after };
  segs.splice(tok.segIndex, 1, beforeSeg, newSeg);
}

/* When a chord is removed, merge text into the previous segment so we
   don't accumulate fragmentation. */
function mergeNeighbors(ln){
  const segs = ln.segments;
  for(let i=segs.length-1; i>0; i--){
    if(segs[i].chord===null || segs[i].chord===undefined){
      segs[i-1].text += segs[i].text;
      segs.splice(i,1);
    }
  }
}

/* ---------- LYRIC MODE helpers ---------- */
function segmentsToPlain(segs){
  return segs.map(s=>s.text).join('');
}

/* Re-apply edited plain lyric text to a line while trying to keep chords
   anchored at the same character offsets. We map old chord offsets onto
   the new text by clamping to new length. */
function relyric(ln, newText){
  // capture old chord anchor offsets (cumulative)
  const anchors = [];
  let pos=0;
  for(const s of ln.segments){
    if(s.chord!==null && s.chord!==undefined) anchors.push({off:pos, chord:s.chord});
    pos += s.text.length;
  }
  // rebuild segments: place each anchor at min(off, newText.length)
  anchors.sort((a,b)=>a.off-b.off);
  const segs=[];
  let cursor=0;
  for(const a of anchors){
    const off = Math.min(a.off, newText.length);
    if(off>cursor){ segs.push({chord:null, text:newText.slice(cursor,off)}); cursor=off; }
    segs.push({chord:a.chord, text:''});
  }
  if(cursor<newText.length || segs.length===0){
    segs.push({chord:null, text:newText.slice(cursor)});
  }
  // attach trailing text of empty-text anchor segments to following text
  // collapse: ensure each anchor seg gets the text that follows it
  const collapsed=[];
  for(let i=0;i<segs.length;i++){
    const cur=segs[i];
    if(cur.chord!==null && cur.text==='' && i+1<segs.length && (segs[i+1].chord===null)){
      collapsed.push({chord:cur.chord, text:segs[i+1].text});
      i++;
    } else collapsed.push(cur);
  }
  ln.segments = collapsed.length?collapsed:[{chord:null,text:newText}];
}

function autosize(ta){
  ta.style.height='auto';
  ta.style.height=(ta.scrollHeight)+'px';
}

function lineControls(idx){
  const c=document.createElement('div'); c.className='line-controls';
  if(mode==='lyric'){
    const up=document.createElement('button'); up.textContent='↑'; up.title='Move up';
    up.onclick=ev=>{ev.stopPropagation(); if(idx>0){pushHistory();[song.lines[idx-1],song.lines[idx]]=[song.lines[idx],song.lines[idx-1]];render();}};
    const dn=document.createElement('button'); dn.textContent='↓'; dn.title='Move down';
    dn.onclick=ev=>{ev.stopPropagation(); if(idx<song.lines.length-1){pushHistory();[song.lines[idx+1],song.lines[idx]]=[song.lines[idx],song.lines[idx+1]];render();}};
    const cp=document.createElement('button'); cp.textContent='⧉'; cp.title='Copy this line';
    cp.onclick=ev=>{ev.stopPropagation(); copyLine(idx);};
    const del=document.createElement('button'); del.textContent='✕'; del.title='Delete line';
    del.onclick=ev=>{ev.stopPropagation(); pushHistory(); song.lines.splice(idx,1); render();};
    c.appendChild(up); c.appendChild(dn); c.appendChild(cp);
    if(clip){
      const ps=document.createElement('button'); ps.className='paste'; ps.textContent='⎘'; ps.title='Paste below this line';
      ps.onclick=ev=>{ev.stopPropagation(); pasteAfter(idx);};
      c.appendChild(ps);
    }
    c.appendChild(del);
  }
  return c;
}

/* ---------- add controls (lyric mode) ---------- */
function addLyricLine(){
  pushHistory();
  song.lines.push({type:'lyric', segments:[{chord:null,text:''}]});
  render();
  // focus last textarea
  const tas=document.querySelectorAll('.lyric-edit-line');
  if(tas.length) tas[tas.length-1].focus();
}
function addSection(){
  const name = prompt('Section name (e.g. Verse 6, Chorus, Bridge):','Verse');
  if(name===null) return;
  pushHistory();
  song.lines.push({type:'blank'});
  song.lines.push({type:'section', label:name});
  render();
}

/* ============================================================
   COPY / PASTE  (sections and individual lines)
   clip = { kind:'section'|'line', lines:[...deep-copied line objects] }
   ============================================================ */
let clip = null;
/* Selected line OBJECTS (not indices) for multi-line copy. Using object
   references means the selection survives reordering and stays correct even
   if indices shift. */
let selection = new Set();

function clearSelection(){ selection = new Set(); }

function copySelection(){
  if(selection.size === 0) return;
  // copy in document order
  const ordered = song.lines.filter(ln => selection.has(ln));
  const lines = ordered.map(deepCopyLine);
  clip = { kind:'lines', lines };
  clearSelection();
  updateClipBar();
  render();
}

function deepCopyLine(ln){
  if(ln.type==='lyric'){
    return { type:'lyric', segments: ln.segments.map(s => ({ chord: s.chord, text: s.text })) };
  }
  if(ln.type==='section'){ return { type:'section', label: ln.label }; }
  return { type: ln.type };
}

/* The span of a section = its header line through the line just before the
   next section header (or end of song). Returns [start, endExclusive]. */
function sectionRange(startIdx){
  let end = startIdx + 1;
  while(end < song.lines.length && song.lines[end].type !== 'section') end++;
  return [startIdx, end];
}

function copySection(idx){
  const [s, e] = sectionRange(idx);
  const lines = song.lines.slice(s, e).map(deepCopyLine);
  // trim trailing blanks in the copied chunk so pastes don't accumulate gaps
  while(lines.length && lines[lines.length-1].type==='blank') lines.pop();
  clip = { kind:'section', lines };
  updateClipBar();
  render();
}

function copyLine(idx){
  clip = { kind:'line', lines: [ deepCopyLine(song.lines[idx]) ] };
  updateClipBar();
  render();
}

/* Paste the clipboard contents right AFTER the given line index. */
function pasteAfter(idx){
  if(!clip) return;
  pushHistory();
  const copy = clip.lines.map(deepCopyLine);
  // a pasted section reads best with a blank line before it
  const insert = (clip.kind==='section') ? [{type:'blank'}, ...copy] : copy;
  song.lines.splice(idx+1, 0, ...insert);
  render();
}

/* Paste at the very top of the song. */
function pasteAtStart(){
  if(!clip) return;
  pushHistory();
  const copy = clip.lines.map(deepCopyLine);
  const insert = (clip.kind==='section') ? [...copy, {type:'blank'}] : copy;
  song.lines.splice(0, 0, ...insert);
  render();
}

function clearClip(){ clip = null; updateClipBar(); render(); }

function cancelSelection(){ clearSelection(); render(); }

function updateClipBar(){
  const bar = document.getElementById('clipbar');
  const what = document.getElementById('clipWhat');
  const label = document.getElementById('clipLabel');
  const hint = document.getElementById('clipHint');
  const copySel = document.getElementById('clipCopySel');
  const cancelSel = document.getElementById('clipCancelSel');
  const pasteTop = document.getElementById('clipPasteTop');
  const clearBtn = document.getElementById('clipClear');

  const selCount = selection.size;

  // SELECTING state takes priority: show selection count + copy/cancel.
  if(selCount > 0){
    bar.classList.add('show');
    label.textContent = 'Select';
    what.textContent = `${selCount} line${selCount===1?'':'s'} selected.`;
    hint.style.display = 'none';
    copySel.style.display = '';
    cancelSel.style.display = '';
    pasteTop.style.display = 'none';
    clearBtn.style.display = 'none';
    return;
  }

  copySel.style.display = 'none';
  cancelSel.style.display = 'none';

  // CLIP state: something is on the clipboard.
  if(!clip){ bar.classList.remove('show'); return; }
  label.textContent = 'Clipboard';
  hint.style.display = '';
  pasteTop.style.display = '';
  clearBtn.style.display = '';

  if(clip.kind==='section'){
    const lbl = (clip.lines[0] && clip.lines[0].type==='section') ? clip.lines[0].label : 'Section';
    const lyricCount = clip.lines.filter(l => l.type==='lyric').length;
    what.textContent = `Section "${lbl}" (${lyricCount} line${lyricCount===1?'':'s'}) copied.`;
  } else if(clip.kind==='lines'){
    const n = clip.lines.length;
    what.textContent = `${n} line${n===1?'':'s'} copied.`;
  } else {
    const ln = clip.lines[0];
    const preview = ln.type==='lyric' ? ln.segments.map(s=>s.text).join('').trim().slice(0,40) : '(line)';
    what.textContent = `Line copied: "${preview}${preview.length>=40?'…':''}"`;
  }
  bar.classList.add('show');
}

/* ============================================================
   FONT CONTROLS
   ============================================================ */
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
  // textareas need re-measuring after a size change
  if(mode==='lyric'){
    requestAnimationFrame(() => {
      document.querySelectorAll('.lyric-edit-line').forEach(autosize);
    });
  }
  // if the export modal is open, refresh it so the font change is reflected
  if(document.getElementById('modalBg').classList.contains('show')){
    requestAnimationFrame(buildRendered);
  }
}

/* ============================================================
   MODE SWITCH
   ============================================================ */
function setMode(m){
  closePop();
  mode=m;
  document.getElementById('modeChord').classList.toggle('active', m==='chord');
  document.getElementById('modeLyric').classList.toggle('active', m==='lyric');
  render();
}

/* ============================================================
   IMPORT
   ============================================================ */
document.getElementById('fileinput').addEventListener('change', e => {
  const f = e.target.files[0]; if(!f) return;
  const reader = new FileReader();
  reader.onload = ev => {
    pushHistory();
    clearSelection();
    song = parseChordPro(ev.target.result);
    render();
    toast('Imported '+f.name);
  };
  reader.readAsText(f);
});

/* ============================================================
   EXPORT
   ============================================================ */
function openExport(){
  document.getElementById('sourceArea').textContent = toChordPro(song);
  document.getElementById('modalBg').classList.add('show');
  // Build after the modal is visible and fonts are ready, so height
  // measurement (which drives pagination) is accurate.
  const build = () => requestAnimationFrame(buildRendered);
  if(document.fonts && document.fonts.ready){ document.fonts.ready.then(build); }
  else build();
}
function closeExport(){ document.getElementById('modalBg').classList.remove('show'); }
document.getElementById('modalBg').addEventListener('click', e=>{ if(e.target.id==='modalBg') closeExport(); });

function exportTab(which){
  document.getElementById('tabRendered').classList.toggle('active', which==='rendered');
  document.getElementById('tabSource').classList.toggle('active', which==='source');
  document.getElementById('exportRendered').style.display = which==='rendered'?'block':'none';
  document.getElementById('exportSource').style.display = which==='source'?'block':'none';
}

let exportCols = 1;

function setCols(n){
  exportCols = n;
  document.querySelectorAll('.colswitch button').forEach(b => {
    b.classList.toggle('active', Number(b.dataset.col)===n);
  });
  buildRendered();
}

/* Page geometry in CSS px at 96dpi (before zoom). */
const PAGE_W = 8.5 * 96;
const PAGE_H = 11 * 96;
const PAGE_PAD = 0.6 * 96;
const CONTENT_H = PAGE_H - PAGE_PAD * 2;          // usable vertical space per page
const CONTENT_W = PAGE_W - PAGE_PAD * 2;
const COL_GAP = 0.3 * 96;

/* Build the header element (page 1 only). */
function buildHeadEl(){
  const m = song.meta;
  const head = document.createElement('div'); head.className='rhead';
  if(m.title){ const h=document.createElement('h2'); h.textContent=m.title; head.appendChild(h); }
  if(m.artist){ const c=document.createElement('div'); c.className='credit'; c.textContent=m.artist; head.appendChild(c); }
  const kl=[];
  if(m.key) kl.push('Key - '+m.key);
  if(m.tempo) kl.push('Tempo - '+m.tempo);
  if(m.time) kl.push('Time - '+m.time);
  if(kl.length){ const k=document.createElement('div'); k.className='keyline'; k.textContent=kl.join(' | '); head.appendChild(k); }
  return head;
}

/* Build one rendered line using inline flow CELLS — the same approach the
   editor uses, which needs no coordinate math and works in any font.
   Each chord starts a cell; the cell stacks the chord above the run of text
   that follows it (up to the next chord). Text before the first chord, or a
   line with no chords, renders as a plain cell with an empty chord slot. */
function buildLineEl(ln){
  const wrap = document.createElement('div'); wrap.className='rline';
  const row = document.createElement('div'); row.className='rcells';

  // Split the line into cells at each chord boundary.
  const cells = [];
  let curText = '';
  let curChord = null;
  let started = false;
  for(const seg of ln.segments){
    const c = (seg.chord!==null && seg.chord!==undefined) ? seg.chord : null;
    if(c !== null){
      // close the previous cell, open a new one at this chord
      if(started) cells.push({ chord: curChord, text: curText });
      curChord = c; curText = ''; started = true;
    }
    curText += seg.text;
  }
  if(started || curText.length){
    cells.push({ chord: curChord, text: curText });
  }
  if(cells.length === 0) cells.push({ chord: null, text: ' ' });

  for(const cell of cells){
    const cellEl = document.createElement('span'); cellEl.className='rcell';
    const chordEl = document.createElement('span'); chordEl.className='rcellchord';
    if(cell.chord !== null && cell.chord !== undefined && cell.chord !== ''){
      chordEl.textContent = cell.chord;
    } else {
      chordEl.innerHTML = '&nbsp;';
    }
    const textEl = document.createElement('span'); textEl.className='rcelltext';
    textEl.textContent = cell.text.length ? cell.text : ' ';
    cellEl.appendChild(chordEl);
    cellEl.appendChild(textEl);
    row.appendChild(cellEl);
  }
  wrap.appendChild(row);
  return wrap;
}

/* Build the list of section blocks (DOM elements). */
function buildBlockEls(){
  const blocks = [];
  let block = null;
  const newBlock = () => { block = document.createElement('div'); block.className='rblock'; blocks.push(block); };
  newBlock();
  for(const ln of song.lines){
    if(ln.type==='section'){
      newBlock();
      const s=document.createElement('div'); s.className='rsection'; s.textContent=ln.label; block.appendChild(s);
    } else if(ln.type==='blank'){
      if(block && block.childNodes.length){
        const b=document.createElement('div'); b.style.height='8px'; block.appendChild(b);
      }
    } else {
      block.appendChild(buildLineEl(ln));
    }
  }
  return blocks.filter(b => b.childNodes.length);
}

/* Measure the widest rendered line (lyric text width, plus a small stable
   allowance for chords). Chord glyph SIZE is deliberately NOT used here:
   chords are measured at the lyric size so that changing the chord-size
   slider never reflows the layout. Returns px. */
function measureWidestLine(lyricSize, chordSize){
  const probe = document.createElement('div');
  probe.className = 'page-sheet measure-sheet';
  probe.style.setProperty('--exp-lyric', lyricSize + 'px');
  // measure chords at lyric size (stable reference), not the chord slider
  probe.style.setProperty('--exp-chord', lyricSize + 'px');
  probe.style.setProperty('--exp-lyric-font', document.getElementById('fontFamily').value);
  probe.style.setProperty('--exp-chord-font', document.getElementById('chordFamily').value);
  probe.style.padding = '0';
  probe.style.width = 'auto';       // let lines take their natural width
  probe.style.whiteSpace = 'nowrap';
  document.body.appendChild(probe);

  let maxW = 0;
  for(const ln of song.lines){
    if(ln.type !== 'lyric') continue;
    const { anchors } = lineToAnchors(ln);
    // Only chord-bearing lines constrain the fit. Chordless lines (e.g. CCLI
    // footers, plain prose) can wrap or clip and shouldn't drive auto-shrink.
    if(anchors.length === 0) continue;
    const el = buildLineEl(ln);
    el.style.display = 'block';
    probe.appendChild(el);
    const row = el.querySelector('.rcells');
    if(row){
      // measure the row at its natural (unwrapped) width
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
  // probe inner width should equal the column width, so set padding to 0 and width directly
  probe.style.padding = '0';
  probe.style.width = colWidthPx + 'px';
  // clone so we don't disturb the originals
  const clones = els.map(el => { const c = el.cloneNode(true); probe.appendChild(c); return c; });
  document.body.appendChild(probe);
  const heights = clones.map(c => {
    const style = getComputedStyle(c);
    return c.getBoundingClientRect().height + parseFloat(style.marginBottom||0);
  });
  document.body.removeChild(probe);
  return heights;
}

function buildRendered(){
  const area = document.getElementById('renderArea');
  area.innerHTML = '';

  const baseLyricSize = +document.getElementById('expLyricSize').value;
  const baseChordSize = +document.getElementById('expChordSize').value;

  // The export follows the editor's chosen fonts.
  const lyricFont = document.getElementById('fontFamily').value;
  const chordFont = document.getElementById('chordFamily').value;

  const cols = exportCols;
  const colWidth = (CONTENT_W - COL_GAP * (cols - 1)) / cols;
  const blockPad = 0.12 * 96; // padding-right on .rblock
  const usableColW = colWidth - blockPad;

  // Auto-shrink: if the widest chord line is wider than the column, scale the
  // lyric+chord sizes down proportionally so everything fits. The sliders act
  // as the maximum size; we only shrink, never enlarge. A floor keeps text
  // readable. If a line is still too wide at the floor, it clips rather than
  // dragging the whole sheet to an unreadable size.
  const MIN_LYRIC = 9;
  let lyricSize = baseLyricSize;
  let chordSize = baseChordSize;
  const widest = measureWidestLine(baseLyricSize, baseChordSize);
  if(widest > usableColW && widest > 0){
    let scale = usableColW / widest;
    // don't shrink below the readable floor (relative to base)
    const minScale = Math.min(1, MIN_LYRIC / baseLyricSize);
    scale = Math.max(scale, minScale);
    lyricSize = baseLyricSize * scale;
    chordSize = baseChordSize * scale;
  }
  // reflect the effective size in the labels (show shrink when it happens)
  const shrunk = lyricSize < baseLyricSize - 0.2;
  document.getElementById('expLyricVal').textContent =
    shrunk ? `${baseLyricSize}px → ${lyricSize.toFixed(1)}px` : `${baseLyricSize}px`;
  document.getElementById('expChordVal').textContent =
    shrunk ? `${baseChordSize}px → ${chordSize.toFixed(1)}px` : `${baseChordSize}px`;

  const headEl = buildHeadEl();
  const blockEls = buildBlockEls();

  // measure header (full content width) and each block (column width)
  const headH = measureHeights([headEl], CONTENT_W, lyricSize, chordSize)[0];
  const blockH = measureHeights(blockEls, colWidth, lyricSize, chordSize);

  /* Greedy column fill: fill a column up to CONTENT_H, then the next column,
     then a new page. Predictable and never overflows a column. The header
     reserves space at the top of page 1, column 1. */
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
      // current column full: go to next column, or next page
      if(c < cols - 1){ c++; fill = 0; }
      else { newPage(0); }
    }
    pageCols[c].push(i);
    fill += h;
  }

  // Now render pages
  pages.forEach((pageCols, pi) => {
    const sheet = document.createElement('div');
    sheet.className = 'page-sheet';
    sheet.style.setProperty('--exp-lyric', lyricSize + 'px');
    sheet.style.setProperty('--exp-chord', chordSize + 'px');
    sheet.style.setProperty('--exp-lyric-font', lyricFont);
    sheet.style.setProperty('--exp-chord-font', chordFont);

    if(pi === 0) sheet.appendChild(headEl);

    const body = document.createElement('div'); body.className='rbody';
    // ensure we always render `cols` columns for consistent widths
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

/* Plain-text rendered output (chords stacked above lyrics, monospace) */
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
  out.push('');
  for(const ln of song.lines){
    if(ln.type==='section'){ out.push(ln.label.toUpperCase()); }
    else if(ln.type==='blank'){ out.push(''); }
    else {
      const {chords,lyrics}=lineToAscii(ln);
      if(chords.trim()!=='') out.push(chords);
      out.push(lyrics);
    }
  }
  // footer meta
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
function download(filename, text){
  // Try a normal blob download first.
  try {
    const blob=new Blob([text],{type:'text/plain;charset=utf-8'});
    const url=URL.createObjectURL(blob);
    const a=document.createElement('a');
    a.href=url; a.download=filename; a.rel='noopener';
    document.body.appendChild(a);
    a.click();
    setTimeout(()=>{ a.remove(); URL.revokeObjectURL(url); }, 1000);
  } catch(e){
    // Sandboxed iframe blocked the download — show a copyable fallback.
    showTextFallback(filename, text);
  }
}

/* Fallback when the sandbox blocks file downloads: show the content in a
   textarea the user can select-all and copy, with a data-URL link as a
   secondary option. */
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
/* Assemble a complete, print-ready standalone HTML document for the export.
   Opening this in a normal browser tab prints/saves-as-PDF correctly even
   though the in-app sandbox may block printing. */
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

  const LT = String.fromCharCode(60); // '<' — kept out of literal tag form
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
    ".credit{ font-size:12px; color:#555; }",
    ".keyline{ font-size:12px; font-weight:600; margin-bottom:0; }",
    ".rhead{ margin-bottom:16px; }",
    ".rbody{ display:flex; gap:0.3in; align-items:flex-start; }",
    ".rcol{ flex:1; min-width:0; }",
    ".rblock{ margin-bottom:14px; padding-right:0.12in; overflow:hidden; }",
    ".rsection{ font-weight:700; font-size:12px; letter-spacing:.1em; text-transform:uppercase; margin:0 0 6px; }",
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

  // On a real page (e.g. GitHub Pages) we can print directly. In the Claude
  // preview the doc is loaded via srcdoc inside a cross-origin frame, where
  // window.print() is blocked — there we fall back to the downloadable page.
  let sandboxed = false;
  try {
    const href = (location && location.href) || '';
    if(href.indexOf('about:srcdoc') === 0 || href === 'about:blank' || href === '') sandboxed = true;
    if(window.top !== window.self) {
      // framed: try to read parent origin; if cross-origin it throws → sandboxed
      try { void window.top.location.href; } catch(e){ sandboxed = true; }
    }
  } catch(e){ sandboxed = true; }

  if(sandboxed){ showPrintDocFallback(); return; }

  // Direct in-document print: build a print-only host from the rendered sheets.
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
    // move clone's children into the page wrapper
    while(clone.firstChild) page.appendChild(clone.firstChild);
    host.appendChild(page);
  });

  let pstyle = document.getElementById('print-style');
  if(pstyle) pstyle.remove();
  pstyle = document.createElement('style');
  pstyle.id = 'print-style';
  // CSS only (no markup), safe everywhere. Uses var() so chosen fonts/sizes carry.
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
    '#print-host .credit{font-size:12px;color:#555;}' +
    '#print-host .keyline{font-size:12px;font-weight:600;margin-bottom:0;}' +
    '#print-host .rhead{margin-bottom:16px;}' +
    '#print-host .rbody{display:flex;gap:0.3in;align-items:flex-start;}' +
    '#print-host .rcol{flex:1;min-width:0;}' +
    '#print-host .rblock{margin-bottom:14px;padding-right:0.12in;overflow:hidden;}' +
    '#print-host .rsection{font-weight:700;font-size:12px;letter-spacing:.1em;text-transform:uppercase;margin:0 0 6px;}' +
    '#print-host .rline{margin-bottom:8px;}' +
    '#print-host .rcells{display:flex;flex-wrap:wrap;align-items:flex-end;}' +
    '#print-host .rcell{display:inline-flex;flex-direction:column;align-items:flex-start;}' +
    '#print-host .rcellchord{font-family:' + chordFont + ';font-size:' + chordSize + 'px;font-weight:600;color:#000;line-height:1.05;white-space:pre;padding-right:0.4em;}' +
    '#print-host .rcelltext{font-family:' + lyricFont + ';font-size:' + lyricSize + 'px;line-height:1.15;white-space:pre;color:#111;}' +
    '}';
  document.head.appendChild(pstyle);
  document.body.appendChild(host);

  const cleanup = () => {
    host.remove(); pstyle.remove();
    window.removeEventListener('afterprint', cleanup);
  };
  window.addEventListener('afterprint', cleanup);
  setTimeout(() => { try { window.print(); } catch(e){ showPrintDocFallback(); } setTimeout(cleanup, 2000); }, 60);
}

/* Deliver the print-ready HTML as a downloadable file. Built with DOM APIs
   (no innerHTML template, no embedded script, no data: URL) to avoid any
   parser or quoting hazards. */
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

{comment: Verse 1}
[D]And can it be that  [G]I     [A7]should [D]gain
An [G]in  -  [A]t'rest [D/F#]in the [A/E]Sav - [E7]ior's   [A]blood
[A]Died He for [D/A]me     [A]  who [D/F#]caused [D]His    [A]pain
For [G]me who [D/F#]Him     [G]   to [D/A]death [A7]pur - [D]sued

[D]A  -  [A]mazing [D/F#]love! How [G]can  [E7/G#]it     [A]be
That [D]Thou     my [G]God      shouldst [A]die     for [D]me`;

song = parseChordPro(SAMPLE);
render();
