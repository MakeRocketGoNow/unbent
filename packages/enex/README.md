# @unbent/enex

Evernote `.enex` parsing and ENML → Markdown conversion. Runtime-agnostic: no DOM, no node
built-ins, so the same code runs in a browser Web Worker and in tests.

## Streaming

`parseEnexStream` holds one `<note>` in memory at a time and awaits `onNote`, so a caller
that uploads inside it applies backpressure. Measured on a real 3.4GB notebook: 3,335 notes
and 3,896 attachments in 69s, peak heap 134MB.

This is not optional. A single ENEX file can exceed 3GB, which cannot be read into a string,
cannot be uploaded whole (Cloudflare caps request bodies at 100MB), and cannot be chunked
across requests without reassembling XML parser state server-side.

## Attachments

ENEX resources carry no hash. `<en-media hash="…">` refers to the **MD5 of the decoded
bytes**, so resolution is a lookup keyed on a computed digest — never positional. In the
real export the first resource in a note matched the *second* `en-media` reference.

MD5 is implemented locally because WebCrypto omits it. It matches Evernote's identifiers
and is never used for security. Verified against the RFC 1321 test vectors.

## Void elements

`en-media` and `en-todo` are void in ENML, but an HTML parser treats unknown tags as
containers and nests everything that follows inside them — silently swallowing sibling
attachments and list item text. They are rewritten to `img`/`input` before parsing.

## Tests

```bash
pnpm test                                    # unit tests and fixtures
ENEX_DIR=~/Downloads/export pnpm test        # also parse real export files
ENEX_DIR=… ENEX_BENCH=1 pnpm test            # also the multi-gigabyte benchmark
```

Fixtures in `test/fixtures/` are real notes lifted from an export; clipper output is
stranger than anything worth inventing.
