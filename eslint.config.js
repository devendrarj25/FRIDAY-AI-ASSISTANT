import js from "@eslint/js";
import eslintPluginPrettier from "eslint-plugin-prettier/recommended";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // Generated output and gitignored local folders: never lint build artifacts.
  {
    ignores: [
      "dist",
      "dist-desktop",
      ".output",
      ".vinxi",
      ".venv",
      ".pytest_cache",
      "release/**",
      ".friday-dev/**",
      ".cache",
      "updates/**",
      ".tanstack/**",
    ],
  },

  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // React Compiler advisory rules (eslint-plugin-react-hooks v7). FRIDAY does not
      // ship the React Compiler, and these flag working, tested UI patterns rather than
      // bugs. Kept visible as warnings; converting them means rewriting UI logic, which
      // is a deliberate owner decision (UI is locked), not a lint fix.
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/refs": "warn",
      "react-hooks/immutability": "warn",
      "react-hooks/purity": "warn",
      "react-hooks/preserve-manual-memoization": "warn",
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "server-only",
              message:
                "TanStack Start does not use the Next.js `server-only` package. Rename the module to `*.server.ts` or mark it with `@tanstack/react-start/server-only`.",
            },
          ],
        },
      ],
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
  {
    // TanStack `Route` exports and shadcn cva helpers are the existing pattern.
    // Fast Refresh still works; these files are not Fast Refresh bugs.
    files: [
      "src/routes/**/*.{ts,tsx}",
      "src/components/ui/**/*.{ts,tsx}",
      "src/components/friday/ui.tsx",
      "src/renderer/App.tsx",
    ],
    rules: {
      "react-refresh/only-export-components": "off",
    },
  },
  {
    // The test harnesses load CommonJS build/release engines through require()
    // and assert on raw workflow YAML, so loose shapes and control-character
    // regexes are intentional there and must not fail the lint gate.
    files: ["core/__tests__/**/*.{ts,tsx}", "**/*.test.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "no-control-regex": "off",
    },
  },
  eslintPluginPrettier,
);
