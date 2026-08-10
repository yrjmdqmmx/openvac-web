# Qwen-VL Fixed Fixture Provenance

The four files under `source/` were generated as text-free base images with OpenAI native ImageGen on 2026-08-10. They were normalized to 1040x540 PNG files with macOS `sips` where necessary.

Exact labels, numbers, units, the gauge needle, and the pump curve are not ImageGen output. `scripts/build-qwen-vl-fixed-fixtures.ts` applies those elements with deterministic Sharp SVG overlays and writes the final files plus `scripts/fixtures/qwen-vl-fixed/manifest.json`.

The manifest records source and final SHA-256 digests, dimensions, and expected benchmark answers. Rebuild with:

```sh
pnpm fixtures:qwen-vl:build
```

The random eight-digit visual nonce remains runtime-generated and is intentionally not part of this fixed asset set.
