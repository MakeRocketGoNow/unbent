#!/usr/bin/env bash
# Finds the simulator to use, booting one if none is running. Sourced; sets UDID.
#
# A simulator that is already booted is used as it is — it is the one being looked at.
# With none, IOS_SIMULATOR names the device to boot ("iPhone 16 Pro"), and without that
# the first available iPhone does. Booting is for a person at a keyboard: an agent should
# find `xcrun simctl list devices booted` empty, stop, and ask.

UDID="$(xcrun simctl list devices booted -j | /usr/bin/python3 -c '
import json, sys
booted = [d for devices in json.load(sys.stdin)["devices"].values() for d in devices]
print(booted[0]["udid"] if booted else "")')"

if [ -z "$UDID" ]; then
  UDID="$(xcrun simctl list devices available -j | IOS_SIMULATOR="${IOS_SIMULATOR:-}" /usr/bin/python3 -c '
import json, os, sys
wanted = os.environ["IOS_SIMULATOR"]
runtimes = json.load(sys.stdin)["devices"]
# Newest runtime first; the keys end in the version, e.g. …SimRuntime.iOS-18-2.
def version(key):
    return [int(part) for part in key.rsplit("iOS-", 1)[-1].split("-") if part.isdigit()]
for key in sorted((k for k in runtimes if "iOS-" in k), key=version, reverse=True):
    for device in runtimes[key]:
        if device["name"] == wanted or (not wanted and device["name"].startswith("iPhone")):
            print(device["udid"])
            sys.exit(0)
')"
  if [ -z "$UDID" ]; then
    echo "error: no simulator${IOS_SIMULATOR:+ named \"$IOS_SIMULATOR\"} is available. Install one from Xcode ▸ Settings ▸ Components." >&2
    exit 1
  fi
  echo "No simulator running, booting $(xcrun simctl list devices | grep "$UDID" | sed -E 's/^ +//; s/ \(.*//')..."
  xcrun simctl boot "$UDID"
  xcrun simctl bootstatus "$UDID" >/dev/null
fi

# The window. Harmless when it is already open, and the only way to see a simulator that
# was booted from a shell.
open -a Simulator
