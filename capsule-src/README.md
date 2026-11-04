# Capsule source projects (`capsule-src/`)

This directory holds the source for **multi-file capsules**. At runtime only the **single-file HTML**
in `capsules/` is used.

Each subdirectory is a small project (any framework) and needs at least:

- `index.html` (Vite entry point)
- `package.json` (with a `"build"` script)

We recommend `vite-plugin-singlefile` to inline all JS/CSS into one `index.html`:

```ts
import { viteSingleFile } from "vite-plugin-singlefile";

export default {
  plugins: [viteSingleFile()],
  build: { outDir: "../../capsules/<name>", emptyOutDir: true },
};
```

A single-file `.html` with no build step can also be placed directly in
`capsule-src/<name>/`; `scripts/build-capsules.sh` copies it as-is.
