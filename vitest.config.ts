import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

// SWC transform so decorator metadata (Nest DI) is emitted in tests, and the sibling
// sui-contract/sdk TypeScript is transpiled the same way. Options are inline (ESM module
// output for Vite) so they override the CommonJS `.swcrc` used by the runtime register.
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["test/**/*.{test,spec}.ts"],
    testTimeout: 300_000,
    hookTimeout: 120_000,
  },
  plugins: [
    swc.vite({
      module: { type: "es6" },
      jsc: {
        target: "es2022",
        parser: { syntax: "typescript", decorators: true, dynamicImport: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
        keepClassNames: true,
      },
    }),
  ],
});
