# Godot 4.6.2 class-reference provenance

RoboGodot bundles a deterministic index derived from the official Godot Engine class-reference XML. It is used offline and is not an engine binary or general source dependency.

- Upstream: `godotengine/godot`
- Tag: `4.6.2-stable`
- Commit: `001aa128b1cd80dc4e47e823c360bccf45ed6bad`
- Archive: `https://codeload.github.com/godotengine/godot/tar.gz/refs/tags/4.6.2-stable`
- Archive SHA-256: `908b759e7517fec65d687b3d468cd639fd8967d25da1522ef8a2087af638b3fe`
- Generator: `server/scripts/generate-doc-index.mjs`; its SHA-256 is embedded in the generated manifest.

The Godot Engine source is distributed under the MIT license. The published Godot documentation is licensed under Creative Commons Attribution 3.0. Copyright belongs to Juan Linietsky, Ariel Manzur, and Godot Engine contributors. See [Godot's license page](https://godotengine.org/license/) and [documentation license notice](https://docs.godotengine.org/en/4.6/about/complying_with_licenses.html).

Regenerate with `npm run docs:generate`. The generator downloads only at build time, verifies the archive before extraction, and writes the compact index. Runtime performs no network access. `npm run docs:check` regenerates in a temporary directory and byte-compares the checked-in artifact.
