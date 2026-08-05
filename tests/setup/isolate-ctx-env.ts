/**
 * Strip the framework's ambient `CTX_*` environment from every test worker.
 *
 * Why this exists: production resolvers read `CTX_ROOT`, `CTX_ORG`,
 * `CTX_AGENT_NAME`, `CTX_AGENT_DIR`, `CTX_PROJECT_ROOT` and
 * `CTX_FRAMEWORK_ROOT` (see src/utils/env.ts `resolveEnv`). A live cortextOS
 * agent shell exports all of them. Running `npm test` from inside such a shell
 * therefore runs the suite against real host paths, and the result depends on
 * WHO invoked it — CI and a human get different answers from the same commit.
 *
 * This is not hypothetical. On 2026-08-04 the suite reported 33 failures across
 * 4 files when run from an agent shell and 75/75 passes with the same commit
 * and `env -u` on those six vars. The mechanism in one case:
 * src/hooks/hook-crash-alert.ts sends
 *   [cliPath, 'bus', 'send-message', target, 'high', body]   // CTX_FRAMEWORK_ROOT set
 *   ['bus', 'send-message', target, 'high', body]            // PATH fallback
 * so `body` is argv index 5 or 4 depending on ambient env. The test asserts on
 * index 4 and, under an agent shell, was reading the literal string 'high'.
 *
 * A second incident the same day was worse than a false red: a test derived a
 * write path from ambient `CTX_AGENT_DIR` and wrote into live org config.
 *
 * Tests that need these vars must set them explicitly (and restore them),
 * which several already do. Removing them here makes that requirement
 * enforceable instead of accidental.
 */

for (const key of Object.keys(process.env)) {
  if (key.startsWith('CTX_')) {
    delete process.env[key];
  }
}
