# Godot 4.6.2 class-reference provenance

RoboGodot bundles a deterministic index derived from the official Godot Engine class-reference XML. It is used offline and is not an engine binary or general source dependency.

- Upstream: `godotengine/godot`
- Tag: `4.6.2-stable`
- Commit: `001aa128b1cd80dc4e47e823c360bccf45ed6bad`
- Archive: `https://codeload.github.com/godotengine/godot/tar.gz/001aa128b1cd80dc4e47e823c360bccf45ed6bad`
- Archive SHA-256: `146a0af84fa4b11670ee5574d98d0a508f047db626407909121b38984531f3d1`
- Generator: `server/scripts/generate-doc-index.mjs`; a composite SHA-256 covering the generator, parser, schema/config, and locked dependencies is embedded in the generated manifest.

The Godot Engine source is distributed under the MIT license. The published Godot documentation is licensed under Creative Commons Attribution 3.0. Copyright belongs to Juan Linietsky, Ariel Manzur, and Godot Engine contributors. See [Godot's license page](https://godotengine.org/license/) and [documentation license notice](https://docs.godotengine.org/en/4.6/about/complying_with_licenses.html).

Regenerate with `npm run docs:generate`. The generator downloads only at build time, verifies the immutable archive before extraction, rejects unsafe archive paths/counts/sizes, and writes the compact index. Runtime performs no network access. `npm run docs:check` is offline by default and verifies the checked-in artifact against compiled provenance; pass the pinned `--archive` to additionally regenerate in a temporary directory and byte-compare it.
