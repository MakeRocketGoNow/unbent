import { defineConfig } from 'vitest/config';

/**
 * Two suites live here, and only one of them can run anywhere.
 *
 * `test/` drives a live `wrangler dev` with real D1 and R2, because the thing it checks is
 * the actual query path: a mock would happily return whatever it was told to. That needs a
 * Worker already running on :8787, so it cannot run in CI and cannot run on a laptop that
 * has not started one.
 *
 * `src/` is ordinary unit tests: pure functions reading a stubbed `Env`, no server, no
 * bindings, no network. Nothing stopped those from running in CI except that they shared a
 * script with the suite that could not, so the whole target was skipped and
 * `src/auth.test.ts` (the only test of which sign-in methods an instance offers) has never
 * run there. Splitting them is what lets the half that is portable be treated as portable.
 *
 * The default `vitest run` still runs both, so the local workflow in test/README.md is
 * unchanged; `--project unit` is the subset CI takes.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'live',
          include: ['test/**/*.test.ts'],
        },
      },
      /*
         `eval/` is measurement, not tests: a harness that runs Auto-fill's arms against a
         private sample and prints counts (see eval/autofill.eval.ts). It skips itself
         unless `AUTOFILL_EVAL_SAMPLE` is set, so the default run and CI are unchanged.
      */
      {
        test: {
          name: 'eval',
          include: ['eval/**/*.eval.ts'],
        },
      },
    ],
  },
});
