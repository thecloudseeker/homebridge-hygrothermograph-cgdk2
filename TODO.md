# Future improvements

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