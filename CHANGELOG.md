# Changelog
## 5.8.1

* Fixed Homebridge logging `Failed to update state ... is closed` (in red) on every restart of a Matter-enabled bridge. Homebridge re-creates the Matter device at startup ([homebridge/homebridge#4018](https://github.com/homebridge/homebridge/issues/4018)), and the plugin's first update arrived before that had finished. The plugin now waits a moment after registering; readings arriving meanwhile are kept and sent right after.

## 5.8.0

* Changed Matter to expose each sensor as a single endpoint carrying temperature, humidity and battery, instead of a device with separate temperature and humidity parts. IKEA Dirigera lists every sensor endpoint as its own product, so 5.7.0 showed each sensor twice there. Re-pair the bridge with your Matter controllers after upgrading. Tested with IKEA Dirigera: one device, and its name, room and readings survive Homebridge restarts.
* Known issue: Homebridge (2.4.0) re-creates this kind of device on every restart, giving it a new Matter `uniqueId` each time. Dirigera is unaffected; other controllers are untested and could treat the sensor as new after a restart. Tracked in [homebridge/homebridge#4018](https://github.com/homebridge/homebridge/issues/4018). You may also see one "Failed to update state … is closed" error per restart; it's harmless.

## 5.7.0

* Changed Matter to expose each sensor as **one** device with Temperature and Humidity readings, instead of two separate devices. Controllers such as IKEA Dirigera listed the two devices as one duplicated product. The two old Matter devices are removed automatically on restart and one new device takes their place; the bridge itself stays paired, but you may need to set the device's name and room again in your controller.
* Added battery level over Matter, reported as low at or below `lowBattery`. Not sent when `disableBatteryLevel` is set.
* Fixed Matter device names being cut off mid-word (e.g. "Temperature & Humidity Temperatu"): the device is now named after the sensor alone. Renaming a sensor is now also passed on to Matter on restart, though some controllers keep the name they saw at pairing.
* Fixed the temperature and humidity Matter devices getting identical serial numbers on macOS hosts; the single device now uses the sensor's address.

## 5.6.0

* Added `autoDiscovery` (**Auto-Discovery** in the Homebridge UI, on by default). Turn it off to expose only the sensors listed under `sensors`; any other sensor is ignored, and a previously auto-discovered one is removed. See [Customizing or ignoring a sensor](README.md#customizing-or-ignoring-a-sensor).

## 5.5.3

* Fixed `Signal Strength (RSSI)` still rejecting readings below -100 dBm on existing sensors: they restore from Homebridge's cache with the pre-5.5.2 range, which is now re-applied on every restart.
* Fixed 127 ("RSSI not available" on some adapters) reading as a perfect signal; readings outside -128..0 dBm are ignored.

## 5.5.2

* Changed Matter to expose each sensor as two flat devices (a temperature sensor and a humidity sensor) instead of one composed device with sub-endpoints. Controllers rejected every subscription to the composed device, so readings never reached them. Matter accessories will need re-adding to your Matter controller.
* Fixed `Signal Strength (RSSI)` rejecting readings below -100 dBm with "characteristic was supplied illegal value"; the range now goes to -128.

## 5.5.1

* Fixed Matter registration being attempted while restoring cached accessories, before Homebridge permits it; it now happens once Homebridge has finished launching.
* Added a startup log line confirming whether Matter is active for this bridge, so a bridge without it switched on is no longer silent about it.

## 5.5.0

* Added Matter support alongside the existing HomeKit accessory: enable via **Enable Matter** in this plugin's child bridge settings. See [Matter (beta)](README.md#matter-beta).
* Fixed `temperatureOffset`/`humidityOffset` not applying to live-pushed HomeKit updates, only to polled reads.
* Fixed the offset being applied twice to MQTT/Fakegato values when `updateInterval` is set.

## 5.4.2

* Fixed garbled text in the "Sensor discovered" log line on non-UTF-8 hosts.
* Fixed a stale/timed-out sensor logging its "Timed out" warning repeatedly (up to 4x per update) instead of once.
* Minor internal cleanup: characteristics are now cached instead of re-resolved on every reading.

## 5.4.1

* Fixed a critical regression from 5.3.1: restoring a cached accessory that already had its RSSI/Last Seen characteristics from a prior run threw `Error: Cannot add a Characteristic with the same UUID...` on every restart, since they were added with `addCharacteristic` (throws on duplicates) instead of `getCharacteristic` (add-or-reuse).

## 5.4.0

* Added startup/discovery log lines confirming when a sensor actually starts receiving readings, instead of silence: `[address] Sensor discovered - now receiving readings.` For sensors explicitly listed under `sensors[]`, startup also logs which of them are still pending (`Waiting to discover N configured sensor(s): [...]`) and each discovery updates that list until all have been found.

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