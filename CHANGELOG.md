# Changelog
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