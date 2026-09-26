const { Scanner } = require("./scanner");
const MiBeacon = require("./mibeacon");
const { cleanAddress } = require("./address");
const { Cgdk2MatterAccessory } = require("./matterAccessory");

const PLUGIN_IDENTIFIER = "@thecloudseeker/homebridge-hygrothermograph-cgdk2";
const PLATFORM_NAME = "HygrotermographCGDK2";

const defaultForceDiscoveringDelay = 2.5;

// registerPlatformAccessories() resolves before Homebridge has finished the
// registration (it's fire-and-forget), and for a device type restored from
// cache Homebridge is still replacing the old endpoint at that moment
// (homebridge/homebridge#4018). State pushed right away lands on the closing
// endpoint and Homebridge logs "Failed to update state ... is closed" as an
// error. Waiting briefly avoids that; pushes in between are kept and sent
// when the wait is over (see markRegistered).
const REGISTRATION_SETTLE_MS = 3000;

let HygrothermographCgdk2AccessoryHandler;

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function defaultNameFor(address) {
  return address == null ? "CGDK2" : `CGDK2 ${address.slice(-5).toUpperCase()}`;
}

class HygrothermographCgdk2Platform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    // Keyed by normalized (colon-stripped, lowercased) BLE address.
    this.handlers = new Map();
    // Homebridge's own Matter API rejects registration attempted before
    // didFinishLaunching ("Do this from your platform's 'didFinishLaunching'
    // event, not during plugin initialisation") - set true once that fires.
    // See buildMatterAccessory/registerHandler and startDiscovery below.
    this.launched = false;

    this.api.on("didFinishLaunching", () => {
      try {
        this.startDiscovery();
      } catch (error) {
        this.log.error("Failed to start Bluetooth discovery:", error);
      }
    });
    this.api.on("shutdown", () => {
      try {
        this.shutdown();
      } catch (error) {
        this.log.error("Error during shutdown:", error);
      }
    });
  }

  // Called once per cached accessory at launch, before didFinishLaunching.
  // Restores it immediately so its characteristics have get-handlers wired
  // up from the start, rather than leaving it dead until BLE re-discovers it.
  configureAccessory(accessory) {
    try {
      const address = accessory.context.address;
      if (address == null) {
        this.log.warn(
          `Ignoring cached accessory with no known address: ${accessory.displayName}`,
        );
        return;
      }
      if (this.isExcluded(cleanAddress(address))) {
        this.log.info(
          `Removing previously-discovered accessory for now-excluded address: ${accessory.displayName}`,
        );
        this.api.unregisterPlatformAccessories(
          PLUGIN_IDENTIFIER,
          PLATFORM_NAME,
          [accessory],
        );
        return;
      }
      this.log.debug(`Restoring cached accessory: ${accessory.displayName}`);
      this.registerHandler(address, accessory);
    } catch (error) {
      this.log.error("Failed to restore cached accessory:", error);
    }
  }

  // Called once per cached Matter accessory at launch (mirrors
  // configureAccessory above, for the Matter side of a bridge that has
  // Matter enabled). Its only job is removing one that should no longer
  // exist - nothing else ever unregisters it otherwise, and Homebridge
  // publishes every cached Matter accessory to controllers whether or not the
  // plugin registers it again:
  //  - its address has since become excluded (see isExcluded), or
  //  - it's from an earlier layout, e.g. the separate temperature/humidity
  //    devices of 5.5.2-5.6.x, whose UUIDs differ from the current one.
  configureMatterAccessory(accessory) {
    try {
      const address = accessory.context?.address;
      let reason;
      if (address == null) {
        reason = "with no known address";
      } else if (this.isExcluded(cleanAddress(address))) {
        reason = "for now-excluded address";
      } else if (
        accessory.UUID !==
        Cgdk2MatterAccessory.uuidFor(this.api.matter, address)
      ) {
        reason = "from an earlier device layout";
      }
      if (reason != null) {
        this.log.info(
          `Removing cached Matter accessory ${reason}: ${accessory.displayName}`,
        );
        this.api.matter
          .unregisterPlatformAccessories(PLUGIN_IDENTIFIER, PLATFORM_NAME, [
            accessory,
          ])
          .catch((error) => {
            this.log.error("Failed to unregister a Matter accessory:", error);
          });
        return;
      }
      this.log.debug(
        `Restoring cached Matter accessory: ${accessory.displayName}`,
      );
    } catch (error) {
      this.log.error("Failed to restore a cached Matter accessory:", error);
    }
  }

  // Plugins must call Homebridge's own api.matter API themselves to expose
  // anything over Matter (it does not happen automatically just because the
  // "Enable Matter" toggle is on for this bridge) - see
  // https://github.com/homebridge/homebridge/wiki/Matter-Plugins.
  //
  // isMatterEnabled() is NOT a reliable "Matter is usable on THIS bridge"
  // check by itself: on a plugin running on the main bridge, Homebridge sets
  // it true as soon as ANY bridge in the whole config has Matter configured
  // - including a completely unrelated plugin's own child bridge - not just
  // the main bridge's own settings (verified against Homebridge 2.4.0's
  // source: server.js gates api.matter on MatterConfigCollector.
  // hasMatterConfig(), which scans every platform's and accessory's _bridge
  // block). Calling registerPlatformAccessories() in that situation rejects
  // with "Matter is not enabled for this bridge" every time. That failure is
  // handled where it actually matters - see buildMatterAccessory's
  // .catch(), which stops a rejected accessory from being pushed to
  // forever - rather than trying to out-guess this flag here.
  //
  // versionGreaterOrEqual (a real, public, long-standing Homebridge API) is
  // an extra floor beyond isMatterAvailable(): that one is satisfied by any
  // 2.0.0-alpha+ build, but re-registering a plugin-composed device type
  // (what this plugin registers - see matterAccessory.js) over its cached
  // copy only works correctly from 2.4.0.
  get matterEnabled() {
    return Boolean(
      this.api.isMatterAvailable?.() &&
      this.api.isMatterEnabled?.() &&
      this.api.versionGreaterOrEqual?.("2.4.0"),
    );
  }

  // Says once per start whether sensors are going to Matter as well as HAP,
  // and if not, which of the conditions above wasn't met. Without this the
  // whole feature is invisible: a bridge with no Matter configured produces
  // exactly the same plugin log as one where it works, which makes "I turned
  // Matter on but nothing shows up in my Matter app" impossible to diagnose
  // from this plugin's output alone.
  //
  // Only the "on" case is info-level (and "asked for but refused" a warning)
  // - matching how Homebridge itself logs "Loading Matter support for child
  // bridge..." at info and stays quiet at debug otherwise, so nothing is
  // added to the startup log of the majority who don't use Matter.
  logMatterStatus() {
    if (!this.api.isMatterAvailable?.()) {
      this.log.debug(
        "Matter is not available on this version of Homebridge; exposing sensors over HomeKit only.",
      );
      return;
    }
    if (!this.api.isMatterEnabled?.()) {
      this.log.debug(
        "Matter is not enabled for this bridge; exposing sensors over HomeKit only. Turn on 'Enable Matter' in this plugin's child bridge settings to also expose them to Matter controllers.",
      );
      return;
    }
    if (!this.api.versionGreaterOrEqual?.("2.4.0")) {
      this.log.warn(
        "Matter is enabled for this bridge, but Homebridge 2.4.0 or later is required for the combined temperature/humidity devices this plugin registers; exposing sensors over HomeKit only.",
      );
      return;
    }
    this.log.info(
      "Matter is enabled for this bridge; sensors will also be registered as Matter devices.",
    );
  }

  get ignoredAddresses() {
    if (this.ignoredAddressesCache == null) {
      this.ignoredAddressesCache = new Set(
        asArray(this.config.ignoredAddresses).map(cleanAddress),
      );
    }
    return this.ignoredAddressesCache;
  }

  // Normalized addresses explicitly listed under sensors[].
  get configuredAddresses() {
    if (this.configuredAddressesCache == null) {
      this.configuredAddressesCache = new Set(
        asArray(this.config.sensors)
          .filter((sensor) => sensor != null && sensor.address != null)
          .map((sensor) => cleanAddress(sensor.address)),
      );
    }
    return this.configuredAddressesCache;
  }

  get autoDiscovery() {
    return this.config.autoDiscovery !== false;
  }

  // An address that must never be exposed: explicitly ignored, or - with
  // autoDiscovery turned off - simply not listed under sensors[].
  isExcluded(normalized) {
    if (this.ignoredAddresses.has(normalized)) {
      return true;
    }
    return !this.autoDiscovery && !this.configuredAddresses.has(normalized);
  }

  get bindKeys() {
    if (this.bindKeysCache == null) {
      this.bindKeysCache = new Map();
      for (const sensor of asArray(this.config.sensors)) {
        if (
          sensor == null ||
          sensor.address == null ||
          sensor.bindKey == null
        ) {
          continue;
        }
        try {
          this.bindKeysCache.set(
            cleanAddress(sensor.address),
            MiBeacon.parseBindKey(sensor.bindKey),
          );
        } catch (error) {
          this.log.warn(
            `Ignoring invalid bindKey for sensor ${sensor.address}: ${error.message}`,
          );
        }
      }
    }
    return this.bindKeysCache;
  }

  get forceDiscoveringDelay() {
    const seconds =
      this.config.forceDiscoveringDelay == null
        ? defaultForceDiscoveringDelay
        : this.config.forceDiscoveringDelay;
    return seconds * 1000;
  }

  configFor(address) {
    const normalized = cleanAddress(address);
    const override = asArray(this.config.sensors).find(
      (sensor) => sensor != null && cleanAddress(sensor.address) === normalized,
    );
    // `name` is excluded from the spread: it identifies the platform block
    // itself (Homebridge convention, though this schema's singular:true
    // normally keeps config-ui-x from writing one), not a per-sensor default.
    // Left in, every auto-discovered sensor without its own sensors[].name
    // override would get the platform's name instead of falling back to
    // defaultNameFor(address).
    const { ignoredAddresses, sensors, name, autoDiscovery, ...defaults } =
      this.config;
    const mqtt =
      defaults.mqtt != null || override?.mqtt != null
        ? { ...defaults.mqtt, ...override?.mqtt }
        : undefined;
    return { ...defaults, ...override, mqtt, address };
  }

  registerHandler(
    address,
    platformAccessory,
    sensorConfig = this.configFor(address),
  ) {
    const normalized = cleanAddress(address);
    // Deferred to startDiscovery (didFinishLaunching) when called from
    // configureAccessory, which runs earlier than Matter registration is
    // safe to attempt - see the `launched` field and matterEnabled getter.
    const matterAccessory = this.launched
      ? this.buildMatterAccessory(address, sensorConfig)
      : undefined;
    const handler = new HygrothermographCgdk2AccessoryHandler(
      platformAccessory,
      sensorConfig,
      this.log,
      matterAccessory,
    );
    this.handlers.set(normalized, handler);
    return handler;
  }

  // Builds the Matter counterpart of a discovered sensor and registers it
  // with Homebridge's Matter server, mirroring how the HAP accessory itself
  // gets created and registered above. Returns undefined when this bridge
  // doesn't have Matter enabled, so the accessory handler just skips pushing
  // to Matter entirely.
  //
  // No dedup against a previous call for the same address: registerHandler
  // (the only caller) is itself only ever invoked once per normalized
  // address per platform lifetime - handlerFor()'s `this.handlers` check
  // guards live discoveries, and configureAccessory only runs once per
  // cached accessory - so there is nothing to dedup here.
  buildMatterAccessory(address, sensorConfig) {
    if (!this.matterEnabled) {
      return undefined;
    }
    const matterAccessory = new Cgdk2MatterAccessory(
      this.api.matter,
      this.log,
      {
        address,
        name: sensorConfig.name || defaultNameFor(address),
      },
    );
    // Fired off rather than awaited: registerHandler (and everything that
    // calls it - configureAccessory, handlerFor) is synchronous, and the
    // Matter registration doesn't need to complete before HAP characteristics
    // become usable. Mirrors registerPlatformAccessories/
    // unregisterPlatformAccessories being called the same way elsewhere in
    // this class for the Matter side.
    this.api.matter
      .registerPlatformAccessories(
        PLUGIN_IDENTIFIER,
        PLATFORM_NAME,
        matterAccessory.toAccessories(),
      )
      .then(() => {
        setTimeout(() => {
          matterAccessory.markRegistered();
          matterAccessory.syncNodeLabel();
        }, REGISTRATION_SETTLE_MS).unref?.();
        this.log.info(
          `[${address}] Registered Matter accessory (temperature, humidity, battery).`,
        );
      })
      .catch((error) => {
        matterAccessory.markRegistrationFailed();
        this.log.error(
          `[${address}] Failed to register Matter accessory; Matter updates for this sensor are disabled for this run:`,
          error,
        );
      });
    return matterAccessory;
  }

  handlerFor(peripheral) {
    const address = peripheral.address || peripheral.id;
    const normalized = cleanAddress(address);
    if (this.isExcluded(normalized)) {
      return null;
    }
    const existing = this.handlers.get(normalized);
    if (existing != null) {
      return existing;
    }

    const sensorConfig = this.configFor(address);
    const uuid = this.api.hap.uuid.generate(
      `homebridge-hygrothermograph-cgdk2:${normalized}`,
    );
    const platformAccessory = new this.api.platformAccessory(
      sensorConfig.name || defaultNameFor(address),
      uuid,
    );
    platformAccessory.context.address = address;
    this.api.registerPlatformAccessories(PLUGIN_IDENTIFIER, PLATFORM_NAME, [
      platformAccessory,
    ]);

    return this.registerHandler(address, platformAccessory, sensorConfig);
  }

  route(peripheral, callback) {
    try {
      const handler = this.handlerFor(peripheral);
      if (handler != null) {
        callback(handler);
      }
    } catch (error) {
      this.log.error("Failed to handle a sensor reading:", error);
    }
  }

  startDiscovery() {
    this.log.info("Starting Bluetooth discovery for CGDK2 sensors.");
    this.launched = true;
    this.logMatterStatus();
    // Any handler restored from cache by configureAccessory ran before this
    // point, so it has no Matter accessory yet even if this bridge has
    // Matter enabled - build it now that it's actually safe to register.
    for (const handler of this.handlers.values()) {
      if (handler.matterAccessory == null) {
        handler.matterAccessory = this.buildMatterAccessory(
          handler.config.address,
          handler.config,
        );
      }
    }
    // Addresses we've actually received a reading from this run (as opposed
    // to just created an accessory for), so restarts give a clear "yes,
    // this sensor is really back online" confirmation instead of silence.
    this.discoveredThisSession = new Set();
    this.pendingConfiguredAddresses = this.buildPendingConfiguredAddresses();
    if (!this.autoDiscovery) {
      if (this.pendingConfiguredAddresses.size > 0) {
        this.log.info(
          "Auto-discovery is off; only sensors listed under 'sensors' will be exposed.",
        );
      } else {
        this.log.warn(
          "Auto-discovery is off but no sensors are listed under 'sensors'; no sensors will be exposed.",
        );
      }
    }
    if (this.pendingConfiguredAddresses.size > 0) {
      this.log.info(
        `Waiting to discover ${this.pendingConfiguredAddresses.size} configured sensor(s): [${[...this.pendingConfiguredAddresses.values()].join(", ")}]`,
      );
    }
    this.scanner = new Scanner(null, {
      log: this.log,
      forceDiscovering: this.config.forceDiscovering !== false,
      restartDelay: this.forceDiscoveringDelay,
      bindKeys: this.bindKeys,
    });
    this.scanner.on("temperatureChange", (temperature, peripheral) => {
      this.route(peripheral, (handler) => handler.setTemperature(temperature));
    });
    this.scanner.on("humidityChange", (humidity, peripheral) => {
      this.route(peripheral, (handler) => handler.setHumidity(humidity));
    });
    this.scanner.on("batteryChange", (batteryLevel, peripheral) => {
      this.route(peripheral, (handler) =>
        handler.setBatteryLevel(batteryLevel),
      );
    });
    this.scanner.on("rssiChange", (rssi, peripheral) => {
      this.route(peripheral, (handler) => handler.setRSSI(rssi));
    });
    this.scanner.on("change", (event, peripheral) => {
      this.logFirstReading(peripheral);
      this.route(peripheral, (handler) => handler.flushBatchedUpdate());
    });
    this.scanner.on("error", (error) => {
      this.log.error(error);
    });
    this.scanner.start();
  }

  // Addresses explicitly listed under sensors[] that we haven't heard from
  // yet this run. Keyed by normalized address (for lookups) to the address
  // as the user wrote it (for readable logging).
  buildPendingConfiguredAddresses() {
    const pending = new Map();
    for (const sensor of asArray(this.config.sensors)) {
      if (sensor == null || sensor.address == null) {
        continue;
      }
      const normalized = cleanAddress(sensor.address);
      if (this.ignoredAddresses.has(normalized)) {
        continue;
      }
      pending.set(normalized, sensor.address);
    }
    return pending;
  }

  logFirstReading(peripheral) {
    const address = peripheral.address || peripheral.id;
    const normalized = cleanAddress(address);
    if (
      this.isExcluded(normalized) ||
      this.discoveredThisSession.has(normalized)
    ) {
      return;
    }
    this.discoveredThisSession.add(normalized);

    if (this.pendingConfiguredAddresses.delete(normalized)) {
      const remaining = [...this.pendingConfiguredAddresses.values()];
      this.log.info(
        remaining.length > 0
          ? `[${address}] Sensor discovered - now receiving readings. Still waiting for: [${remaining.join(", ")}]`
          : `[${address}] Sensor discovered - now receiving readings. All configured sensors have been found.`,
      );
    } else {
      this.log.info(`[${address}] Sensor discovered - now receiving readings.`);
    }
  }

  shutdown() {
    this.log.info("Shutting down Bluetooth scanning and MQTT connections.");
    try {
      if (this.scanner != null) {
        this.scanner.stop();
      }
    } catch (error) {
      this.log.error("Failed to stop the Bluetooth scanner:", error);
    }
    for (const handler of this.handlers.values()) {
      try {
        if (handler.mqttClient != null) {
          handler.mqttClient.end(true);
        }
      } catch (error) {
        this.log.error("Failed to close an MQTT client:", error);
      }
    }
  }
}

module.exports = (homebridge) => {
  ({ HygrothermographCgdk2AccessoryHandler } =
    require("./accessory")(homebridge));
  return { HygrothermographCgdk2Platform, PLUGIN_IDENTIFIER, PLATFORM_NAME };
};
