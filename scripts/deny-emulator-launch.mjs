#!/usr/bin/env node
// PreToolUse hook on Bash: refuse any command that starts the Android emulator or touches
// its snapshots.
//
// AGENTS.md already said not to, and on 2026-09-06 an agent did it anyway: it launched the
// emulator by hand with the snapshot flags inverted, and the AVD's `default_boot` snapshot,
// which held the emulator's signed-in session, was overwritten with a signed-out cold boot.
// There was nothing to restore it from. A rule an agent can read past is not a safeguard,
// so the harness enforces this one.
//
// What it refuses: the emulator binary given any flag, `-avd` and `-no-snapshot*` wherever
// they appear, `qemu-system`, and any path into `snapshots/default_boot`. What it lets
// through: `adb`, `gradlew`, and `emulator -list-avds`, which only reads. A command naming
// `-list-avds` passes whole, so `emulator -list-avds && emulator -avd X` would get by; the
// guard is against an agent reaching for the obvious launch, not one working around it.
//
// It sees only the command the agent typed, not what that command spawns, so the emulator
// `pnpm android` boots for itself is the scripts' own check — see `apps/android/scripts/`.
//
// Node rather than jq because node is the one tool every checkout of this repo already
// has. An error here is reported and does not block, so a broken hook fails open.

let input = '';
for await (const chunk of process.stdin) input += chunk;

const command = JSON.parse(input).tool_input?.command ?? '';

if (/-list-avds/.test(command)) process.exit(0);

const launches = [
  /(^|[^-])-avd(\s|=|$)/,
  /(^|[;&|(]|\s)([^\s;&|()]*\/)?emulator\s+-/,
  /qemu-system/,
  /-no-snapshot/,
  /snapshots\/default_boot/,
];

if (launches.some((pattern) => pattern.test(command))) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          "Starting the Android emulator, or changing its snapshots, is the user's to do. " +
          'One launched from an agent shell has no GUI session and drops every real mouse ' +
          "click, and hand-rolled snapshot flags overwrite the AVD's default_boot snapshot, " +
          'which holds its signed-in session and cannot be restored. Ask the user to start ' +
          'it from Android Studio Device Manager or with `pnpm android` in their own ' +
          'terminal. adb, gradlew and `emulator -list-avds` are unaffected.',
      },
    }),
  );
}
