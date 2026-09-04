# Changelog
## 5.4.0

* Added startup/discovery log lines confirming when a sensor actually starts receiving readings, instead of silence: `[address] Sensor discovered — now receiving readings.` For sensors explicitly listed under `sensors[]`, startup also logs which of them are still pending (`Waiting to discover N configured sensor(s): [...]`) and each discovery updates that list until all have been found.

## 5.3.1

* Fixed a critical regression from 5.3.0: every accessory failed to load (`TypeError: Cannot read properties of undefined (reading 'INT')`) on Homebridge 2.x / HAP-NodeJS 2.x, because the new RSSI/Last Seen characteristics referenced `Characteristic.Formats`/`Characteristic.Perms`, an alias HAP-NodeJS 2.x removed. They're now read from the `Formats`/`Perms` exports directly, which exist on both HAP-NodeJS 1.x and 2.x. If you updated to 5.3.0 and saw sensors disappear or errors on every restart, this fixes it.

## 5.3.0

* Added a `StatusFault` characteristic to the temperature/humidity services, set once a sensor exceeds its configured `timeout`, so the Home/Eve app can show "Not Responding" instead of silently freezing the last good reading.
* Added `Signal Strength (RSSI)` and `Last Seen` diagnostics to the temperature service, plus an opt-in `logSignalStrength` option to log RSSI at info level. See [Diagnostics](README.md#diagnostics).
* Fixed a spurious `Error: Could not start scanning, state is unknown` logged on nearly every restart (an expected Bluetooth-adapter startup race, not a fault) and added clearer info-level startup/shutdown log lines.
* Fixed several fields in the Homebridge UI config form (`Ignored Sensor Addresses`, `Per-Sensor Overrides`, `MQTT`) that rendered with no inputs at all, and masked the MQTT password field instead of showing it in plain text.

## 5.2.0

* Added `fakeGatoOptions`: extra options passed straight through to the `fakegato-history` constructor, merged over (and able to override) this plugin's computed `filename`/`path`/`storage`. Previously these were hardcoded with no way to customize or extend them.

## 5.1.0

* Added `bindKey` support: a per-sensor key that decrypts the CGDK2's normal encrypted Bluetooth broadcasts (Xiaomi's MiBeacon protocol) directly, so it no longer has to be paired via the Qingping+ app to force unencrypted mode. See [Encrypted sensors (bindKey)](README.md#encrypted-sensors-bindkey).

## 5.0.1

* Fixed the CI test script (`node --test test/`) failing on Linux runners; switched to an explicit glob (`node --test "test/**/*.test.js"`).

## 5.0.0

**Breaking:** rewrote the plugin from a Homebridge Accessory to a dynamic Platform — sensors are now discovered automatically instead of needing a manually-configured `address` per accessory. `config.json` must be updated — see [Migrating from 4.x](README.md#migrating-from-4x).

* New `sensors` array to optionally name/override a specific sensor, and `ignoredAddresses` to exclude one.
* Added a test suite, run in CI on Node 22 and 24 alongside lint.
* Hardened config parsing against malformed hand-edited `config.json` values.

## 4.0.4

* Bumped ESLint from the EOL 8.57 to 10.9
* Bumped `fakegato-history` and `mqtt` to their latest versions

## 4.0.3

* Removed dead/broken code in `lib/parser.js` and fixed a misleading buffer-length check.
* Fixed lint errors (formatting only) and added CI to enforce lint going forward.
* Committed `package-lock.json` for reproducible installs.

## 4.0.2

* Fixed `Characteristic.Model` and `config.schema.json`'s offset fields, both leftover from the original Mi Flora-based project.
* Cleaned up the README: documented the fork lineage, corrected stale Mi Flora-era instructions and the packet byte-offset table, and trimmed outdated/redundant sections.
* Added a GitHub Actions workflow that publishes to npm automatically on version bumps

## 4.0.1

* Set `author` to the current maintainer (thecloudseeker); moved prior authors to `contributors`.
* Added `publishConfig.access: public` so the scoped package publishes publicly.

## 4.0.0

* Homebridge 2.0 support. `engines.homebridge` now declares `^1.6.0 || ^2.0.0` and the plugin has been verified against the HAP-NodeJS 2.x API used by Homebridge v2.
* Fixed a breaking change from HAP-NodeJS 2.x: `Service.BatteryService` was removed in favor of `Service.Battery`. This plugin now uses `Service.Battery`, which exists on both Homebridge 1.x and 2.x.
* Replaced the unmaintained `@abandonware/noble` dependency with the actively maintained `@stoprocent/noble` fork for better native-binding stability and support for current Node.js versions/architectures (including Apple Silicon).
* Bluetooth scanning is now watched by a stall-detection watchdog: if no BLE advertisements are seen at all for 3 minutes while a scan should be running, the plugin assumes the adapter has silently wedged and forces a restart, rather than requiring a manual `hcitool lescan` or Homebridge restart.
* Scan restarts now use capped exponential backoff with jitter instead of a fixed delay, so a persistently failing adapter no longer hot-loops restart attempts.
* Added a `noble` `error` event handler. Previously an adapter-level error would go unhandled and crash the entire Homebridge process.
* The plugin now cleans up (stops scanning, disconnects MQTT) on Homebridge shutdown instead of leaving the scan running.
* Fixed `forceDiscoveringDelay`: it was documented as seconds but used internally as milliseconds. It is now consistently seconds end-to-end (default unchanged: 2.5s).
* Bumped `mqtt` to v5 and `fakegato-history` to the latest release.

## 3.0.4

* Added support for CGDK2
* Fork of [homebridge-mi-hygrothermograph](https://github.com/hannseman/homebridge-mi-hygrothermograph)