import { TESTS_WITH_TIMEOUT_ENV, vitestTask, withTestTimeout } from '@gadgets/scripts/vitest-task'

/**
 * Vite+ settings for this package: a two-pass `test` task, the surface in Node and the facet and
 * its sessions in workerd, kept as separate commands so one can replay from the task cache when
 * only the other's inputs moved; and the validated tree the integration harness boots.
 */
export default {
  run: {
    tasks: {
      test: vitestTask(['vitest run', 'vitest run -c vitest.worker.config.ts']),
      // The integration harness boots this validated tree without rebuilding it per test file.
      // Workspace-wide exclusion, as gatekeeper-context's: tracking reaches past the package, and
      // wrangler's randomly named scratch bundles would otherwise miss the cache every run.
      'build:integration-worker': {
        command: withTestTimeout('capnweb-validate build --out .wrangler/validate'),
        cache: {
          env: TESTS_WITH_TIMEOUT_ENV,
          input: [{ auto: true }, { pattern: '!**/.wrangler/**', base: 'workspace' }],
          output: ['.wrangler/validate/**'],
        },
      },
    },
  },
}
