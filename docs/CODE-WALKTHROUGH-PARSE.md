# Parser walkthrough: ZIP → AXML/ARSC → APK metadata

This guide covers ApkStart's offline APK metadata path. The parser uses Node built-ins and does not invoke `aapt`, Java, Android Studio, or a network service.

## Data flow

```text
APK file
  └─ ZipFile: central directory + selected entry reads
       ├─ AndroidManifest.xml → parseAxml() → manifest tree
       ├─ resources.arsc → ResTable → label/version/icon resources
       └─ res/... → icon bytes
             ↓
       parseApkZip() → package metadata, launcher, ABIs, permissions, icon
```

For `.apks` and `.xapk` bundles, `Installer.parseBundle()` streams split APK entries to a temporary directory and parses a base APK. Installation later uses `AdbClient.installMultiple()` for the extracted split set.

## `src/core/zip.js`

Exports `ZipArchive` and `ZipFile`:

- `ZipArchive(buffer)` is the in-memory reader used for small archives and synthetic tests.
- `ZipFile(filePath)` indexes a file by reading its ZIP directory, not the entire archive. It supports ZIP64 metadata and can stream an entry to a writable destination through `pipeTo(name, dest)`.
- Both readers provide `has(name)`, `names()`, `list()`, and `read(name)`. Missing entries return `null`; `ZipFile.read()` is bounded to prevent large allocations. Use `pipeTo` for large entries.
- `ZipFile` owns a file descriptor. Close it in `finally`, including parser and bundle error paths.

Central-directory metadata includes the compression method, compressed/uncompressed size, and local-header offset. Entry data begins after the local ZIP header's filename and extra fields; do not derive this offset from central-directory filename lengths.

The implementation supports stored and deflate entries and ZIP64 values. Keep limits and extraction safety checks in mind: parsing metadata safely does not by itself make an archive safe to extract into an arbitrary directory.

## `src/core/axml.js`

`parseAxml(input)` converts compiled Android binary XML into a node tree. Each element has `name`, `tag`, `attrs`, `children`, and `parent`. Attribute objects preserve the namespace URI, name, typed value, data type, and resolved reference ID where available.

Useful helpers:

- `attr(node, name, ns = ANDROID_NS)` returns an attribute object or `null`.
- `attrValue(node, name, ns = ANDROID_NS)` returns the typed attribute value or `null`.
- Pass `ns = null` when looking for an unnamespaced attribute such as the manifest's `package`.
- `children`, `findFirst`, `findAll`, and `findNodes` query nodes by element name.

The attribute array preserves namespace semantics. Avoid treating the literal name `name` as unique: manifest attributes and Android attributes can have different namespaces. The `attributeStart` offset is relative to the `ResXMLTree_attrExt` area; the parser uses `pos + 16 + attrStart` to reach the first attribute. Synthetic fixtures in `test/run-tests.js` protect this contract.

The parser also reads the resource map so known Android attribute IDs can be recovered when a string-pool name is unavailable. Malformed chunks are bounded against the input buffer; unsupported text nodes are not required for the metadata extraction path.

## `src/core/arsc.js`

`new ResTable(buffer, { preferredLang })` reads the resource table and exposes:

- `resolveAll(resourceId)`: all supported string-resource values and their configuration metadata.
- `resolveString(resourceId, preferredLang)`: a deterministic language fallback, defaulting to English.
- `resolveIconPaths(resourceId)`: candidate icon resource paths ordered by useful density and raster preference.

The parser handles ordinary, sparse, and 16-bit-offset resource entry tables, follows reference chains with a depth limit, and reads string resources. Complex bag resources and arbitrary Android resource types are not fully materialized; the APK layer uses safe fallbacks when a resource cannot be resolved.

Keep locale selection and icon-density ordering deterministic. Resource values are often referenced indirectly, so test both direct values and references when extending this parser.

## `src/core/apk.js`

Public API:

```js
const { parseApk, parseApkZip, quickCheck } = require('./apk');

parseApk(filePath)          // open ZIP, parse metadata, close descriptor
parseApkZip(zip, sizeBytes) // parse an already-open ZipFile/compatible reader
quickCheck(filePath)        // check ZIP signature; returns false on I/O errors
```

The metadata object includes `package`, `label`, `versionName`, `versionCode`, `minSdk`, `targetSdk`, `launchActivity`, `abis`, `permissions`, `iconPng`, `iconFile`, `sizeBytes`, and `filePath` for the file-based entry point. Errors are thrown for invalid archives or a missing manifest; callers should surface those errors as install failures.

Launcher resolution searches both `<activity>` and `<activity-alias>` candidates and requires `MAIN` and `LAUNCHER` (or `LEANBACK_LAUNCHER`) in the same intent filter. A launcher alias is the exported entry component; returning its `targetActivity` can fail when the target is not exported.

Icon resolution checks manifest resources, adaptive icon XML layers, and a conservative launcher-name fallback. The parser returns raw candidate image bytes; conversion/decoding to Windows ICO is handled later by `shortcut.js` and the installer.

ABI detection enumerates `lib/<abi>/*.so`. An APK with no native libraries is treated by the installer as architecture-neutral; an ARM-only APK may trigger the configured compatibility image path.

## `src/core/installer.js` and test fixtures

`Installer.install()` handles file validation, parsing, runtime preparation, install, persistence, icon/shortcut creation, and cleanup. `parseBundle()` extracts APK splits with `ZipFile.pipeTo()` rather than buffering a whole bundle in memory. On failure it removes the temporary bundle directory.

`test/lib/make-apk.js` constructs a small valid synthetic APK. The parser tests cover namespace-aware `package`, app/version/SDK metadata, launcher intent parsing, ABI discovery, and icon extraction without requiring a committed third-party APK. If `APKSTART_TEST_APK` points to a real APK, the optional fixture path exercises more real-world resources.

When changing this stack, add a fixture for the edge case and test the public metadata contract. Do not assert only that parsing did not throw.
