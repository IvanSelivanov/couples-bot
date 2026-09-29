// Two test suites (eng review D8, D3):
//   unit — pure logic, no network and no database; run it all the time;
//   db   — real Postgres from `supabase start`: lease races, unique keys and
//          SQL functions can only be tested on a live database, mocks lie about them.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["test/unit/**/*.test.js"],
          environment: "node",
        },
      },
      {
        test: {
          name: "db",
          include: ["test/db/**/*.test.js"],
          environment: "node",
          globalSetup: ["test/db/setup.js"],
          // The tests share one database, so parallel files would wipe each
          // other's data. fileParallelism is ignored inside a project, so
          // sequential runs are forced by the --no-file-parallelism flag in
          // the test:db script.
          testTimeout: 20_000,
        },
      },
    ],
  },
});
