# Future improvements

Bigger-lift items, not urgent — the plugin works fine without them.

## Add a test suite

No automated tests exist. `lib/parser.js` (byte-decoding) and `lib/scanner.js`
(address matching, backoff calculation) are pure logic and easy to unit test.
A basic suite would have caught the dead/broken `parseMacAddress()` code that
got removed in 4.0.2/4.0.3.

## Migrate from the legacy Accessory API to a dynamic Platform

Currently registers via `registerAccessory` (`pluginType: "accessory"` in
`config.schema.json`). Homebridge has been steering new plugins toward the
dynamic Platform API instead. Migrating would also enable auto-discovery of
multiple CGDK2 sensors without requiring a manual `address` per device in
config.json. This is a real rewrite, not a small tweak — only worth doing if
multi-sensor auto-discovery becomes something you actually want.
