Open Graph card assets.
=======================

The fonts are served as static assets (this folder is copied into `dist/web`) and are
fetched by the Worker when it draws a poll's link card. They are read once per isolate and
reused (see worker/services/ogImage.ts). The rasterizer itself is not here: workerd only
compiles WebAssembly at deploy time, so `@resvg/resvg-wasm`'s module is imported into the
Worker bundle instead of being served as an asset.

- The rasterizer, `@resvg/resvg-wasm` 2.6.2, travels in the Worker bundle as
  `node_modules/@resvg/resvg-wasm/index_bg.wasm`, MPL-2.0.
- `noto-sans-sc-chinese-simplified.woff2` - the CJK subset of Noto Sans SC, weight 400,
  from `@fontsource/noto-sans-sc@5.0.0`. It carries the CJK Unified Ideographs block, so
  it renders simplified and traditional text alike (shared characters take the simplified
  forms, which is what the subset provides).
- `noto-sans-sc-latin.woff2` - the Latin subset of the same family: letters, digits, and
  the punctuation the card's own lines use.
- `LICENSE-NOTO-SANS.txt` - the SIL Open Font License 1.1 the fonts are distributed under.

To refresh these: install the two packages, copy the files over, and update the versions
above. A bold face is deliberately not shipped: resvg resolves `font-family` to the first
registered face of that family and ignores `font-weight`, so a second weight would change
nothing; the card emphasizes its title by size and colour instead.
