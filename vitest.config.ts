import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
    test: {
        // Background-task worktrees (.claude/worktrees/*) are separate checkouts
        // with their own copies of the test tree — and no gitignored goldens —
        // so the default glob would run (and fail) all of them from here.
        exclude: [...configDefaults.exclude, '**/.claude/**'],
        // The astronomy regression scenarios do heavy synchronous computation;
        // a single scenario can exceed Vitest's 5s default on a loaded machine,
        // producing flaky "Test timed out in 5000ms" failures. Give ample
        // headroom so timing alone never fails the suite.
        testTimeout: 30000,
        hookTimeout: 30000,
    },
});
