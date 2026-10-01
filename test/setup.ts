// Pin what the tests would otherwise take from the machine. Colour: chalk reads FORCE_COLOR when it loads, and
// with no TTY or CI=true (the release workflow) it would drop to no colour, so assertions on escape codes and on
// highlighted cells would pass on a laptop and fail there. This file is preloaded (bunfig.toml) before any import.
process.env.FORCE_COLOR = "3";
delete process.env.NO_COLOR;
