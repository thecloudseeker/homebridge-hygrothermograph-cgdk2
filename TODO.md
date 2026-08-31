# Future improvements

## `bindKey` support (encrypted sensor decryption)

Right now the CGDK2 has to be paired via the Qingping+ app to force it into
unencrypted broadcast mode before this plugin can read it. Supporting a
`bindKey` option to decrypt Xiaomi's encrypted MiBeacon protocol would let
the device stay encrypted instead. Scoped to the CGDK2 only; not a general
multi-device feature.

## `fakeGatoOptions` passthrough

Expose a `fakeGatoOptions` config key passed straight through to the
`fakegato-history` module constructor. We hardcode
`{ filename, path, storage: "fs" }` in `getFakeGatoHistoryService()` with no
way for a user to override or extend it.

## Matter compatibility

Expose sensors as Matter devices, not just HomeKit. This plugin currently
only speaks HAP. A HAP accessory can already reach Matter controllers
indirectly via a bridge (e.g. Homebridge Matter Hub) with no plugin-side
changes, since bridging happens at the HAP layer — worth confirming against
a real Matter controller (Apple Home, Google Home, etc.). Native Matter
support (the plugin speaking Matter directly, without going through HAP)
would be a much bigger undertaking and depends on what, if anything,
Homebridge itself ships for this.