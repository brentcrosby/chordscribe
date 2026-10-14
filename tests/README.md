# Importer checks

Run the PDF importer regression tests with Node.js:

```sh
node --test tests/pdf-import.test.cjs
```

These tests use synthetic text and OCR boxes, require no dependencies or
network access, and cover native text, scanned pages, mixed documents,
multiple columns, instrumental chords, OCR normalization and cleanup.

For an end-to-end check, serve the app locally and use Import with both a
selectable-text PDF and an image-only PDF. Check that every page imports,
columns read left to right, and chords sit above the expected words. Also
check an image import because it shares the positioning helpers.

The reported Hallelujah sheets were verified locally in Chromium with
PDF.js 3.11.174 and Tesseract.js 5. Both pages of each of the three PDFs
imported. The original PDFs and extracted lyrics are not test fixtures.
OCR can still require manual corrections for indistinct glyphs.
