import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

/** Build the extension once before the end-to-end tests (set LOGPANE_SKIP_BUILD=1 to reuse dist/). */
export default function setup(): void {
  if (process.env.LOGPANE_SKIP_BUILD) return;
  execFileSync(process.execPath, ['build.mjs'], { cwd: resolve(__dirname, '../..'), stdio: 'ignore' });
}
