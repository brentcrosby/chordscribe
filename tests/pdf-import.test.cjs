const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

// The app is a browser script. Load its importer in isolation without
// booting the editor or requiring network access/third-party packages.
const source = readFileSync(join(__dirname, '..', 'app.js'), 'utf8');
const importer = source.match(/const SECTION_RE = .*;/)[0] + '\n' +
  source.slice(source.indexOf('const PDFJS_VER'), source.indexOf('function isImageFile'));
const item = (str, x, y, h = 12) => ({ str, x, y, w: str.length * 6, h });
const body = [item('[Verse 1]', 40, 730), item('C', 40, 710), item('G', 100, 710), item('Sing along', 40, 696)];
const title = item('Example Chords by Test Artist', 40, 780, 18);
const words = items => items.map(i => ({
  text: i.str, confidence: 95,
  bbox: { x0: i.x * 3, x1: (i.x + i.w) * 3, y0: (800 - i.y - i.h/2) * 3, y1: (800 - i.y + i.h/2) * 3 }
}));

function setup(pages, options = {}) {
  const calls = { workers: 0, recognized: 0, terminated: 0, destroyed: 0, rendered: 0, canvases: [], messages: [] };
  const worker = {
    async recognize() {
      calls.recognized++;
      if(options.ocrError) throw new Error('OCR failed');
      return { data: { words: pages[calls.page].words || [] } };
    },
    async terminate() { calls.terminated++; }
  };
  const pdf = {
    numPages: pages.length,
    async getPage(n) {
      calls.page = n - 1;
      const page = pages[n - 1];
      return {
        getViewport: ({ scale }) => ({ width: 600 * scale, height: 800 * scale }),
        async getTextContent() {
          return { items: (page.native || []).map(i => ({ str:i.str, width:i.w, height:i.h, transform:[1,0,0,i.h,i.x,i.y] })) };
        },
        render({ background }) { calls.rendered++; assert.equal(background, '#ffffff'); return { promise: Promise.resolve() }; }
      };
    },
    async destroy() { calls.destroyed++; }
  };
  const pdfjsLib = { GlobalWorkerOptions:{}, getDocument:() => ({ promise:Promise.resolve(pdf) }) };
  const Tesseract = options.noOcr ? null : { async createWorker() { calls.workers++; return worker; } };
  const context = vm.createContext({
    window:{ pdfjsLib, Tesseract }, pdfjsLib, Tesseract, console,
    document:{ createElement(tag) {
      assert.equal(tag, 'canvas');
      const canvas = { width:0, height:0, getContext:() => ({}) };
      calls.canvases.push(canvas);
      return canvas;
    } },
    toast:msg => calls.messages.push(msg),
    isBlank:l => l.type === 'lyric' && !(l.text || '').trim() && !(l.chords || []).length
  });
  vm.runInContext(importer, context);
  return { calls, context, importPdf:() => context.importPdf(new ArrayBuffer(1)) };
}

test('native text PDFs retain chord anchors and need no OCR', async () => {
  const { importPdf, calls } = setup([{ native:[title, ...body] }], { noOcr:true });
  const song = await importPdf();
  assert.equal(song.meta.title, 'Example');
  assert.equal(song.meta.artist, 'Test Artist');
  assert.equal(song.lines[1].text, 'Sing along');
  assert.deepEqual(Array.from(song.lines[1].chords, c => [c.chord, c.off]), [['C',0],['G',10]]);
  assert.equal(calls.workers, 0);
  assert.equal(calls.destroyed, 1);
});

test('image-only PDFs render and recover chords with OCR', async () => {
  const { importPdf, calls } = setup([{ words:words([title, ...body]) }]);
  const song = await importPdf();
  assert.equal(song.meta.title, 'Example');
  assert.equal(song.lines[1].text, 'Sing along');
  assert.deepEqual(Array.from(song.lines[1].chords, c => c.chord), ['C','G']);
  assert.equal(calls.rendered, 1);
  assert.equal(calls.terminated, 1);
  assert.equal(calls.destroyed, 1);
  assert.equal(calls.canvases[0].width, 0);
});

test('a native header alone does not suppress OCR of a scanned body', async () => {
  const { importPdf, calls } = setup([{ native:[title], words:words([title, ...body]) }]);
  const song = await importPdf();
  assert.equal(calls.recognized, 1);
  assert.equal(song.lines[1].chords.length, 2);
});

test('mixed PDFs process every page and reuse one OCR worker', async () => {
  const { importPdf, calls } = setup([
    { words:words(body) }, { native:body }, { words:words(body) }
  ]);
  const song = await importPdf();
  assert.equal(song.lines.filter(l => l.chords?.length).length, 3);
  assert.equal(calls.workers, 1);
  assert.equal(calls.recognized, 2);
  assert.equal(calls.terminated, 1);
  assert(calls.messages.some(m => m.includes('page 3 of 3')));
});

test('scanned columns stay in reading order and page counters disappear', async () => {
  const right = [item('[Chorus]',320,730), item('F',320,710), item('Second column',320,696)];
  const footer = [item('Page',510,20), item('1/2',545,20)];
  const { importPdf } = setup([{ words:words([title, ...body, ...right, ...footer]) }]);
  const song = await importPdf();
  assert.deepEqual(Array.from(song.lines.filter(l => l.type === 'section'), l => l.label), ['[Verse 1]','[Chorus]']);
  assert.deepEqual(Array.from(song.lines.filter(l => l.chords?.length), l => l.chords[0].chord), ['C','F']);
  assert(!song.lines.some(l => /Page|1\/2/.test(l.text || '')));
});

test('instrumental chords and G-key minor chords remain valid', async () => {
  const { importPdf } = setup([{ words:words([item('[Intro]',40,730), item('G',40,710), item('Em',100,710)]) }]);
  const song = await importPdf();
  assert.deepEqual(Array.from(song.lines[1].chords, c => c.chord), ['G','Em']);
  assert.equal(song.lines[1].text.trim(), '');
});

test('narrow doubled OCR roots recover C without changing Bb or words', () => {
  const { context } = setup([]);
  const items = context.ocrBoxItems([
    { text:'Cc', bbox:{ x0:0,x1:9,y0:0,y1:12 } },
    { text:'Bb', bbox:{ x0:20,x1:29,y0:0,y1:12 } },
    { text:'Cc', bbox:{ x0:40,x1:60,y0:0,y1:12 } }
  ],100);
  assert.deepEqual(Array.from(items, i => i.str), ['C','Bb','Cc']);
});

test('unrecognized tokens never become chord anchors', () => {
  const { context } = setup([]);
  const tokens = context.pdfChordTokens([item('C',40,710),item('noise',80,710),item('G',140,710)]);
  assert.deepEqual(Array.from(tokens, t => t.chord), ['C','G']);
});

test('OCR failure releases the canvas, worker and PDF', async () => {
  const { importPdf, calls } = setup([{ words:[] }], { ocrError:true });
  await assert.rejects(importPdf(), /OCR failed/);
  assert.equal(calls.terminated, 1);
  assert.equal(calls.destroyed, 1);
  assert.equal(calls.canvases[0].height, 0);
});

test('missing OCR support reports the dependency and releases the PDF', async () => {
  const { importPdf, calls } = setup([{}], { noOcr:true });
  await assert.rejects(importPdf(), /PDF OCR support failed to load/);
  assert.equal(calls.destroyed, 1);
});

test('blank scans report no content instead of creating an empty song', async () => {
  const { importPdf, calls } = setup([{ words:[] }]);
  await assert.rejects(importPdf(), /No chord\/lyric content found/);
  assert.equal(calls.terminated, 1);
  assert.equal(calls.destroyed, 1);
});
