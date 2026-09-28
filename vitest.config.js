// Два набора тестов (eng review D8, D3):
//   unit — чистая логика, без сети и без базы; гоняется на каждый чих;
//   db   — настоящий Postgres из `supabase start`: гонки аренды, уникальные
//          ключи и SQL-функции проверяются только на живой базе, моки их врут.
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
          // Тесты делят одну базу, параллельные файлы стирали бы данные друг
          // друга. Внутри project опция fileParallelism игнорируется, поэтому
          // последовательный запуск задаёт флаг --no-file-parallelism в
          // скрипте test:db.
          testTimeout: 20_000,
        },
      },
    ],
  },
});
