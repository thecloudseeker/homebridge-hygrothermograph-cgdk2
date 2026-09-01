const EventEmitter = require("events");
const noble = require("@stoprocent/noble");
const { Parser, EventTypes, SERVICE_DATA_UUID } = require("./parser");
const MiBeacon = require("./mibeacon");
const { cleanAddress } = require("./address");

const DEFAULT_RESTART_DELAY = 2500;
const MAX_RESTART_DELAY = 60000;
const RESTART_JITTER = 500;
const WATCHDOG_INTERVAL = 30000;
const WATCHDOG_TIMEOUT = 180000;

class Scanner extends EventEmitter {
  constructor(address, options) {
    super();
    options = options || {};
    const {
      log = console,
      forceDiscovering = true,
      restartDelay = DEFAULT_RESTART_DELAY,
      bindKeys = new Map(),
    } = options;
    this.log = log;
    this.address = address;
    this.forceDiscovering = forceDiscovering;
    this.restartDelay = restartDelay;
    this.bindKeys = bindKeys;
    this.warnedMissingBindKeyFor = new Set();

    this.scanning = false;
    this.restartAttempts = 0;
    this.restartTimer = null;
    this.watchdogTimer = null;
    this.lastDiscoveryAt = null;

    this.configure();
  }

  configure() {
    // noble is a singleton shared by every accessory this plugin creates, so
    // each Scanner instance adds its own listener set. Raise the cap so
    // running several sensors doesn't trigger Node's MaxListenersExceeded
    // warning noise.
    noble.setMaxListeners(0);
    noble.on("discover", this.onDiscover.bind(this));
    noble.on("scanStart", this.onScanStart.bind(this));
    noble.on("scanStop", this.onScanStop.bind(this));
    noble.on("warning", this.onWarning.bind(this));
    noble.on("stateChange", this.onStateChange.bind(this));
    // Without a listener here, noble emitting "error" (e.g. an HCI socket
    // failure) would throw and take down the whole Homebridge process.
    noble.on("error", this.onNobleError.bind(this));
  }

  // On cold start, noble's adapter is always "unknown" for a moment before
  // the OS/driver reports poweredOn — calling startScanning here would
  // always throw. That's an expected race, not a fault, so we wait quietly
  // for the "stateChange" listener (registered in configure()) to retry
  // once poweredOn actually arrives, only falling back to scheduleRestart's
  // backoff as a safety net in case that event is ever missed.
  start() {
    if (noble.state !== "poweredOn") {
      this.log.debug(
        `Waiting for the Bluetooth adapter to power on (current state: ${noble.state}).`,
      );
      this.scanning = false;
      this.scheduleRestart();
      return;
    }
    this.log.debug("Start scanning.");
    try {
      noble.startScanning([], true);
      this.scanning = true;
      this.lastDiscoveryAt = Date.now();
      this.startWatchdog();
    } catch (e) {
      this.scanning = false;
      this.log.error(e);
      this.scheduleRestart();
    }
  }

  stop() {
    this.scanning = false;
    this.clearRestartTimer();
    this.stopWatchdog();
    noble.stopScanning();
  }

  onStateChange(state) {
    if (state === "poweredOn") {
      this.restartAttempts = 0;
      this.start();
    } else {
      this.log.info(`Stop scanning. (${state})`);
      this.stop();
    }
  }

  onWarning(message) {
    this.log.info("Warning: ", message);
  }

  onNobleError(error) {
    this.log.error("Bluetooth adapter error:", error);
  }

  onScanStart() {
    this.log.debug("Started scanning.");
    this.restartAttempts = 0;
    this.clearRestartTimer();
  }

  onScanStop() {
    this.log.debug("Stopped scanning.");
    this.stopWatchdog();
    // We are scanning but something stopped it. Restart scan.
    if (this.scanning && this.forceDiscovering) {
      this.scheduleRestart();
    }
  }

  scheduleRestart() {
    this.clearRestartTimer();
    const delay =
      Math.min(
        this.restartDelay * 2 ** this.restartAttempts,
        MAX_RESTART_DELAY,
      ) +
      Math.random() * RESTART_JITTER;
    this.restartAttempts += 1;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.log.debug(`Restarting scan (attempt ${this.restartAttempts}).`);
      this.start();
    }, delay);
    if (typeof this.restartTimer.unref === "function") {
      this.restartTimer.unref();
    }
  }

  clearRestartTimer() {
    if (this.restartTimer != null) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
  }

  // Some adapter/driver failures stop delivering advertisements without ever
  // emitting "scanStop" (a wedged HCI dongle, a silently dropped USB device,
  // certain Raspberry Pi + Bluetooth combinations). Since real BLE traffic
  // (any nearby phone, watch, etc., not just our target sensor) is almost
  // never absent for minutes at a time, prolonged silence is a reliable
  // signal that the scan has died and needs to be force-restarted.
  startWatchdog() {
    this.stopWatchdog();
    this.watchdogTimer = setInterval(
      () => this.checkForStalledScan(),
      WATCHDOG_INTERVAL,
    );
    if (typeof this.watchdogTimer.unref === "function") {
      this.watchdogTimer.unref();
    }
  }

  stopWatchdog() {
    if (this.watchdogTimer != null) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  checkForStalledScan() {
    if (!this.scanning || this.lastDiscoveryAt == null) {
      return;
    }
    const silentFor = Date.now() - this.lastDiscoveryAt;
    if (silentFor < WATCHDOG_TIMEOUT) {
      return;
    }
    this.log.warn(
      `No BLE advertisements seen for ${Math.round(
        silentFor / 1000,
      )}s. The Bluetooth adapter may have stalled, forcing a scan restart.`,
    );
    this.stop();
    this.scheduleRestart();
  }

  onDiscover(peripheral) {
    this.lastDiscoveryAt = Date.now();
    try {
      this.handleDiscover(peripheral);
    } catch (error) {
      this.emit("error", error);
    }
  }

  handleDiscover(peripheral) {
    const {
      advertisement: { serviceData } = {},
      id,
      address,
      rssi,
    } = peripheral || {};

    if (!this.isValidAddress(address) && !this.isValidAddress(id)) {
      return;
    }

    const result = this.parseAdvertisement({
      peripheral,
      serviceData,
      address,
      id,
    });
    if (result == null) {
      return;
    }

    const { eventType, event } = result;
    switch (eventType) {
      case EventTypes.temperatureAndHumidity: {
        const { temperature, humidity, battery } = event;
        this.emit("temperatureChange", temperature, { id, address });
        this.emit("humidityChange", humidity, { id, address });
        this.emit("batteryChange", battery, { id, address });
        break;
      }
      default: {
        this.emit("error", new Error(`Unknown event type ${eventType}`));
        return;
      }
    }
    if (rssi != null) {
      this.emit("rssiChange", rssi, { id, address });
    }
    this.emit("change", event, { id, address });
  }

  isValidAddress(address) {
    return (
      this.address == null ||
      cleanAddress(this.address) === cleanAddress(address)
    );
  }

  parseAdvertisement({ peripheral, serviceData, address, id }) {
    const nativeData = this.getValidServiceData(serviceData);
    if (nativeData != null) {
      this.logPeripheral({ peripheral, serviceData: nativeData });
      return this.parseServiceData(nativeData.data);
    }

    const miBeaconData = this.getValidMiBeaconServiceData(serviceData);
    if (miBeaconData != null) {
      this.logPeripheral({ peripheral, serviceData: miBeaconData });
      return this.parseMiBeaconServiceData(miBeaconData.data, address ?? id);
    }

    return null;
  }

  getValidServiceData(serviceData) {
    return (
      serviceData &&
      serviceData.find((data) => data.uuid.toLowerCase() === SERVICE_DATA_UUID)
    );
  }

  parseServiceData(serviceData) {
    try {
      return new Parser(serviceData).parse();
    } catch (error) {
      this.emit("error", error);
    }
  }

  getValidMiBeaconServiceData(serviceData) {
    return (
      serviceData &&
      serviceData.find(
        (data) => data.uuid.toLowerCase() === MiBeacon.SERVICE_DATA_UUID,
      )
    );
  }

  // Encrypted MiBeacon advertisements (the CGDK2 default unless paired via
  // the Qingping+ app to force the unencrypted 0xfdcd format above) need a
  // per-sensor bindKey to decrypt. A sensor with no configured key is
  // silently unusable to us, so we warn once per address rather than either
  // spamming the log every second or failing loudly.
  parseMiBeaconServiceData(serviceData, address) {
    const bindKey = this.bindKeys.get(cleanAddress(address));
    if (bindKey == null) {
      this.warnMissingBindKeyOnce(address);
      return null;
    }
    try {
      const event = MiBeacon.parse(serviceData, bindKey);
      return event == null
        ? null
        : { eventType: EventTypes.temperatureAndHumidity, event };
    } catch (error) {
      this.emit("error", error);
      return null;
    }
  }

  warnMissingBindKeyOnce(address) {
    const key = cleanAddress(address);
    if (this.warnedMissingBindKeyFor.has(key)) {
      return;
    }
    this.warnedMissingBindKeyFor.add(key);
    this.log.warn(
      `[${address}] Received an encrypted MiBeacon advertisement but no bindKey is configured for it; ignoring. Add one under sensors[].bindKey.`,
    );
  }

  logPeripheral({
    peripheral: {
      address,
      id,
      rssi,
      advertisement: { localName },
    },
    serviceData,
  }) {
    this.log.debug(`[${address || id}] Discovered peripheral ->
      Id: ${id}
      LocalName: ${localName}
      rssi: ${rssi}
      serviceData: ${serviceData.data.toString("hex")}`);
  }
}

module.exports = { Scanner };
