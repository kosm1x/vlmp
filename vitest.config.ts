import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["server/tests/**/*.test.ts"],
    globals: true,

    // Pinned at vitest 4's current defaults ON PURPOSE, not tuned. Twice on
    // 2026-07-25 the CI test step ran 14+ minutes against a ~10s suite, and both
    // times these limits were already in force as defaults — so the hang is not a
    // test body or a hook overrunning, and inflating these numbers would fix
    // nothing. Declared so an upstream default change cannot silently move the
    // line, and so the intent sits next to the reporter below.
    testTimeout: 5_000,
    hookTimeout: 10_000,
    teardownTimeout: 10_000,

    // This targets the observed failure, which the timeouts above cannot see: the
    // suite spawns real ffmpeg/ffprobe, and the hang happens AFTER the tests
    // finish — nothing is left to time out. `hanging-process` is documented to
    // dump the open handles (via why-is-node-running) when the process refuses to
    // exit, which would name the culprit. ci.yml's job-level `timeout-minutes`
    // reports only THAT it hung, and on 2026-07-25 it fired ~3 minutes late.
    //
    // HONEST CAVEAT: unverified against the real failure. Both hangs were CI-only,
    // and two local probes — a leaked timer, then a surviving child with piped
    // stdio — each exited cleanly in ~180ms, because vitest tears the worker down
    // before either matters. So this is a documented-behaviour bet, not a proven
    // fix. What IS verified: it costs nothing, printing no extra output on a clean
    // run. If the next CI hang produces no handle dump, this line is not the
    // answer and the next step is capturing worker state on the runner itself.
    reporters: ["default", "hanging-process"],
  },
});
