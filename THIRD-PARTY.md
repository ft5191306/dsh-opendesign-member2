# Third-party material

This package contains material that is not original to it. Nothing here was
written by this project's author, and the MIT grant in `LICENSE` does not apply
to it.

## `assets/frames/` — vendored from the Open Design app

The five `.od-frames/` payload files are reproduced from the installed **Open
Design** application so that the `od-frames` row can stage them without a live
OD installation. Provenance, source paths, byte counts and sha256 digests for
every file are recorded in `assets/frames/SOURCES.json`; that file is the
authoritative record and is checked into this repository alongside the payload.

- `iphone.html`, `android.html`, `neutral.html`, `layout.css` — byte copies.
  Each carries its own header line noting it is derived from the Open Design
  mobile-app template (**Apache-2.0**).
- `deck-framework.md` — rendered from the OD daemon chunk that Open Design
  itself uses, rather than paraphrased, so the shipped text is what OD would
  have written.

Upstream: Open Design (Apache-2.0 components). No Open Design source is
modified here; the files are reproduced verbatim and their notices are intact.

## `cordis.patch.yml` — generated, contains vendored prompt prose

The six `opendesign*` preset declarations, including roughly 470 KB of vendored
Open Design prompt text, are carried over from the sibling
`dsh-opendesign-preset` package by `tools/build-plugin-patch.mjs`. That
generator exists precisely to copy those rows byte-for-byte rather than
re-serialise them, and it self-checks the result with a content hash.

## What this means for redistribution

The vendored prose is Open Design's text, not this project's. Publishing this
repository redistributes it. The sibling `dsh-opendesign-preset` repository has
the same consideration and its commits were held unpushed for that reason; the
same call applies here and is the maintainer's to make.
