# homebridge-hygrothermograph-cgdk2
This is a fork of [ormisum/homebridge-hygrothermograph-cgdk2](https://github.com/ormisum/homebridge-hygrothermograph-cgdk2), which is itself a fork of [hannseman/homebridge-mi-hygrothermograph](https://github.com/hannseman/homebridge-mi-hygrothermograph), for the Qingping Temp & RH Lite (CGDK2) temperature sensor. This fork updates it for Homebridge v2 and reworks Bluetooth scanning to be significantly more stable.

[Homebridge](https://github.com/homebridge/homebridge) plugin for exposing measured temperature and humidity as [HomeKit](https://www.apple.com/home-app/) accessories.

Supported sensors:

* [Qingping Temp & RH Lite (CGDK2)](https://www.qingping.co/temp-rh-monitor-lite/overview)

![Qingping Temp & RH Monitor Lite (CGDK2)](images/hygrothermograph.png "Qingping Temp & RH Monitor Lite (CGDK2)")

## Compatibility

* Homebridge `1.6.0` or newer, including Homebridge `2.0`.
* Node.js `18.20.4+`, `20.18.0+`, `22.10.0+`, or `24+`.

## Installation
Make sure your system matches the prerequisites. You need to have a C compiler and [Node.js](https://nodejs.org/) installed (see versions above).

BLE scanning is provided by [@stoprocent/noble](https://github.com/stoprocent/noble), an actively maintained fork of the original Noble BLE library used to discover and read values from the sensor.

These libraries and their dependencies are required to provide access to the kernel Bluetooth subsystem:

```sh
sudo apt-get install bluetooth bluez libbluetooth-dev libudev-dev
```

For more detailed information and descriptions for other platforms please see the [noble fork's documentation](https://github.com/stoprocent/noble#readme).

### Pair with Qingping+ App

Download the iOS or Android Qingping+ App and setup your CGDK2. This causes the temperature sensor to send unencrypted data.

**Note:** This step is necessary, unless you'd rather decrypt the sensor's normal encrypted broadcasts instead — see [Encrypted sensors (bindKey)](#encrypted-sensors-bindkey) below.

### Install homebridge and this plugin
```
[sudo] npm install -g --unsafe-perm homebridge
[sudo] npm install -g --unsafe-perm @thecloudseeker/homebridge-hygrothermograph-cgdk2
```

**Note:** depending on your platform you might need to run `npm install -g` with root privileges.

See the [Homebridge documentation](https://github.com/homebridge/homebridge#readme) for more information.

If you are running Homebridge as another user than `root` (you should) then some additional configuration needs to be made to allow [Node.js](https://nodejs.org/) access to the kernel Bluetooth subsystem without root privileges.

You'll need to grant the node binary cap_net_raw privileges:

```
sudo setcap cap_net_raw+eip $(eval readlink -f `which node`)
```

Please see the [noble fork's documentation](https://github.com/stoprocent/noble#running-without-rootsudo-linux-specific) for more details.


## Migrating from 4.x

Version 5.0.0 rewrote this plugin from a Homebridge Accessory to a Platform, so that sensors are discovered automatically instead of needing a manually-configured `address` per device. **This is a breaking config change** — update your `config.json`:

```json
// Before (4.x)
"accessories": [
    {
      "accessory": "HygrotermographCGDK2",
      "name": "Temperature & Humidity"
    }
]
```

```json
// After (5.x)
"platforms": [
    {
      "platform": "HygrotermographCGDK2"
    }
]
```

If you had multiple accessory blocks with different `address` values, those become entries in an optional `sensors` array instead — see [Customizing or ignoring a sensor](#customizing-or-ignoring-a-sensor) below. Everything else (`timeout`, `mqtt`, `fakeGatoEnabled`, etc.) works the same, just nested under the platform block (or per-sensor, if you want different values for different sensors).


## Homebridge configuration

Sensors are discovered automatically. Once a CGDK2 is paired via the Qingping+ app and broadcasting nearby, this plugin picks it up over Bluetooth and exposes it as a HomeKit accessory — no `address` or per-sensor config required. Just add the platform to your Homebridge `config.json`:

```json
"platforms": [
    {
      "platform": "HygrotermographCGDK2"
    }
]
```

See [config-sample.json](config-sample.json) for a complete example, including a per-sensor override.

The following apply to every discovered sensor. All except `forceDiscovering`/`forceDiscoveringDelay` (platform-wide only — there's a single shared Bluetooth scan for every sensor) can be overridden for one specific sensor — see [Customizing or ignoring a sensor](#customizing-or-ignoring-a-sensor) below.

| Key                     | Default         | Description                                                                                                                                                                                                 |
|-------------------------|-----------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `timeout`               | `15`            | Time in minutes after last contact when a sensor should be regarded as unreachable. If set to `0`, timeout will be disabled.                                                                                |
| `humidityName`          | `"Humidity"`    | Name of the humidity sensor as it will appear in your Home-app.                                                                                                                                             |
| `temperatureName`       | `"Temperature"` | Name of the temperature sensor as it will appear in your Home-app.                                                                                                                                          |
| `fakeGatoEnabled`       | `false`         | If historical data should be reported to the Elgato Eve App.                                                                                                                                                |
| `fakeGatoStoragePath`   |                 | Optional. Custom path where to save fakegato history.                                                                                                                                                       |
| `fakeGatoOptions`       |                 | Optional. Extra options passed straight through to the `fakegato-history` constructor, merged over (and able to override) the `filename`/`path`/`storage` this plugin computes.                            |
| `mqtt`                  |                 | Optional. Configuration for publishing values to an MQTT-broker. See the [MQTT](#mqtt) section for details.                                                                                                 |
| `forceDiscovering`      | `true`          | Retry start scanning for devices when stopped. For some users scanning will be stopped when connecting to other BLE devices. Setting `forceDiscovering` to `true` will start scanning again in these cases. |
| `forceDiscoveringDelay` | `2.5`           | The delay, in seconds, before scanning restarts after it stops unexpectedly. Only applicable if `forceDiscovering` is `true`. Retries automatically back off (up to 60s) if the adapter keeps failing.       |
| `updateInterval`        |                 | By default values will be updated as they come in. Often this is once per second, if this is not desired `updateInterval` can be set to how often updates should be made. Accepts values in seconds.        |
| `lowBattery`            | `10`            | At what battery percentage Homekit should start warning about low battery.                                                                                                                                  |
| `disableBatteryLevel`   | `false`         | If battery level should not be exposed to Homekit. New E-Ink sensors do currently not support sending battery levels and setting this to `true` will make Elgato Eve not warn about it.                     |
| `temperatureOffset`     | `0`             | An offset to apply to temperature values for calibration if measured values are incorrect.                                                                                                                  |
| `humidityOffset`        | `0`             | An offset to apply to humidity values for calibration if measured values are incorrect.                                                                                                                     |

### Customizing or ignoring a sensor

By default every discovered sensor gets an auto-generated name like "CGDK2 AE:65" (from the last two bytes of its BLE address) — rename it in the Home app like any accessory, or give it a name up front along with any other override, by adding it to the optional `sensors` array, matched by address:

```json
"platforms": [
    {
      "platform": "HygrotermographCGDK2",
      "sensors": [
        {
          "address": "4c:64:a8:d0:ae:65",
          "name": "Living Room",
          "timeout": 30
        }
      ]
    }
]
```

Any of the defaults above can be overridden per-sensor this way. A sensor doesn't need to be listed here at all to work — it's only for customizing one.

To stop an unwanted sensor from showing up at all (e.g. a neighbor's, picked up over BLE in an apartment building), add its address to `ignoredAddresses` instead:

```json
"platforms": [
    {
      "platform": "HygrotermographCGDK2",
      "ignoredAddresses": ["2c:34:b3:d4:a1:61"]
    }
]
```

The easiest way to find a sensor's address for either of the above is to run Homebridge in debug mode (`homebridge -D`) with the sensor nearby and paired via the Qingping+ app. The plugin only logs peripherals whose advertisement matches its Bluetooth service data, so a line like:

```
[4c:64:a8:d0:ae:65] Discovered peripheral -> ...
```

gives you the address, in the format `4c:64:a8:d0:ae:65`.

#### MacOS

MacOS does not expose a BLE device's MAC address. Instead it assigns a device unique identifier in the format `5C61F8CE-9F0B-4371-B996-5C9AE0E0D14B`. The same `homebridge -D` debug-log method above still works on MacOS — just use the `Id` value from the "Discovered peripheral" log line as the address instead of a MAC address. This identifier can also be found using MacOS tools like [Bluetooth Explorer](https://developer.apple.com/bluetooth/).

### Encrypted sensors (bindKey)

As an alternative to [pairing via the Qingping+ app](#pair-with-qingping-app), the plugin can decrypt the CGDK2's normal encrypted Bluetooth broadcasts directly, so the sensor never needs to be switched into unencrypted mode at all. This needs a `bindKey`: a 16-byte encryption key, unique per sensor, assigned to it when it's first bound to a Xiaomi/MiHome account.

To obtain it without changing how the sensor is paired, use a Xiaomi-cloud key extractor such as [PiotrMachowski/Xiaomi-cloud-tokens-extractor](https://github.com/PiotrMachowski/Xiaomi-cloud-tokens-extractor), which reads it from your Xiaomi cloud account rather than modifying the device itself. Then add it to that sensor's entry in `sensors`:

```json
"platforms": [
    {
      "platform": "HygrotermographCGDK2",
      "sensors": [
        {
          "address": "4c:64:a8:d0:ae:65",
          "bindKey": "0123456789abcdef0123456789abcdef"
        }
      ]
    }
]
```

A sensor with no `bindKey` configured is simply ignored if it's broadcasting encrypted — nothing crashes, but you'll see a one-time warning in the log (`homebridge -D`) naming its address. `bindKey` only matters for a sensor sending encrypted data in the first place; a sensor already paired via the Qingping+ app doesn't need one.


### Elgato Eve

This plugin has support for adding historical data to the [Elgato Eve App](https://apps.apple.com/us/app/elgato-eve/id917695792) by using the excellent module [fakegato-history](https://github.com/simont77/fakegato-history), which requires a unique serial number per device — every discovered sensor's BLE address is used automatically, so there's nothing to configure for this to work.

When restarting Homebridge the Eve app will show the Accessories as having 0% battery until the sensor actually reports its battery status. This can sometimes take a couple of minutes. Just be patient and the actual battery status will show up.

The E-Ink sensors do not report the current battery level. This will cause Elgato Eve to incorrectly warn about low battery. Set `disableBatteryLevel` to `true` to disable these warnings.

To enable the Elgato Eve feature set `fakeGatoEnabled` to `true` in `config.json`

```json
{
  "fakeGatoEnabled": true
}
```

[fakegato-history](https://github.com/simont77/fakegato-history) caches historical values into a json-file.
Usually located in `/var/lib/homebridge` or `~/.homebridge`. To customise this one can set `fakeGatoStoragePath` to the desired path:

```json
{
  "fakeGatoStoragePath": "/tmp/"
}
```

For anything else fakegato-history supports beyond the storage path, set `fakeGatoOptions` — it's passed straight through to the `fakegato-history` constructor, merged over (and able to override) this plugin's own `filename`/`path`/`storage` defaults:

```json
{
  "fakeGatoOptions": {
    "minutes": 5
  }
}
```

See the [fakegato-history](https://github.com/simont77/fakegato-history) source for the full set of supported options.

### MQTT

The plugin can be configured to publish temperature/humidity/battery values to an MQTT-broker.

Basic configuration:

```json
{
  "mqtt": {
    "url": "mqtt://test.mosquitto.org",
    "temperatureTopic": "sensors/temperature",
    "humidityTopic": "sensors/humidity",
    "batteryTopic": "sensors/battery"
  }
}
```

If one is interested in only publishing a specific value just skip configuring the topics wished to ignore:

```json
{
  "mqtt": {
    "url": "mqtt://test.mosquitto.org",
    "temperatureTopic": "sensors/temperature"
  }
}
```

To enable authentication specify the `username` and `password` parameters:

```json
{
  "mqtt": {
    "url": "mqtt://test.mosquitto.org",
    "username": "admin",
    "password": "hunter2",
    "temperatureTopic": "sensors/temperature"
  }
}
```

For more options see the [MQTT.js documentation](https://github.com/mqttjs/MQTT.js#readme).
Everything set in `mqtt` will be passed to the `options` argument on `Client`.
The `Client#publish` options `qos` and `retain` can also be configured the same way.


## Technical details
The plugin scans for [Bluetooth Low Energy](https://en.wikipedia.org/wiki/Bluetooth_Low_Energy) peripherals and check the broadcast advertisement packets.
By only reading the advertisement packet there is no need to establish a connection to the peripheral.
Inside each packet discovered we look for Service Data with a UUID of `0xfdcd` (the Qingping-native format sent once paired via the Qingping+ app) or `0xfe95` (Xiaomi's encrypted MiBeacon format, decoded if a [bindKey](#encrypted-sensors-bindkey) is configured for that sensor). If found we start trying to parse the actual Service Data to find the temperature and humidity.

### Packet format

For example, `50:20:aa:bb:cc:dd:ee:ff:00:00:f5:00:26:02:00:00:50` (illustrative, decodes to 24.5°C / 55.0% / 80% battery) breaks down as:

| byte  | function    | type     |
|:-----:|-------------|----------|
| 1-2   | (unused)    |          |
| 3-8   | MAC-address | 6 bytes, reversed |
| 9-10  | (unused)    |          |
| 11-12 | Temperature | int16LE, ÷10 |
| 13-14 | Humidity    | uint16LE, ÷10 |
| 15-16 | (unused)    |          |
| 17    | Battery     | uint8, % |

### Bluetooth stability

BLE scanning on cheap USB dongles, some Raspberry Pi Bluetooth chips, and certain OS/driver combinations is known to silently die without Node ever finding out about it — the classic symptom is a sensor that stops updating until Homebridge is restarted. This fork addresses that directly:

* Uses [@stoprocent/noble](https://github.com/stoprocent/noble), an actively maintained fork of Noble with better native bindings and support for current Node.js/OS/architecture combinations. The original `@abandonware/noble` dependency is stale and prone to failing to build on newer Node versions and Apple Silicon.
* A watchdog detects a stalled adapter (no BLE activity at all for 3 minutes) and automatically restarts scanning, backing off if the adapter keeps failing so a genuinely broken one isn't hammered with restart attempts.
* Adapter-level errors are caught and logged instead of crashing the whole Homebridge process, and scanning/MQTT now shut down cleanly instead of being left dangling.

If you still see stalls, check your dongle/kernel combination — some hardware is unreliable regardless of the userland library.

## Credits

* [ormisum/homebridge-hygrothermograph-cgdk2](https://github.com/ormisum/homebridge-hygrothermograph-cgdk2) — added CGDK2 support, forked by this project.
* [hannseman/homebridge-mi-hygrothermograph](https://github.com/hannseman/homebridge-mi-hygrothermograph) — original plugin this is ultimately descended from.

## Legal

*Qingping* is a registered trademark of Qingping Technology (Beijing) Co., Ltd.

This project is in no way affiliated with, authorized, maintained, sponsored or endorsed by *Qingping* or any of its affiliates or subsidiaries.
