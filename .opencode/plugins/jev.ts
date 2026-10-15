/**
 * Local opencode plugin entry.
 *
 * opencode auto-discovers any `*.ts` file in `.opencode/plugins/`. This file is
 * a thin re-export of the package source of truth at `src/index.ts`, so local
 * development and the published npm package share exactly one implementation.
 *
 * @module
 */

export { default } from "../../src/index"
