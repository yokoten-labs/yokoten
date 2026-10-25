// What the npm package may hold (#631): a docs-site folder must never ship.
// yokoten keeps no runtime dependencies and the site lives in website/ with its own
// package.json, so any path outside this list fails check-package before a release.
// The list is what `npm pack --dry-run --json` held on the day of the rule; a new
// path is a decision, never an accident.

/** Top-level paths the package may hold (README, LICENSE and package.json are added by npm itself). */
export const PACKAGE_PATHS: readonly string[] = [
  'LICENSE',
  'README.md',
  'package.json',
  'bin',
  'src',
  'kit',
  'dist',
];

/** Read the file paths from the JSON of one `npm pack --dry-run --json`. */
// npm prints the prepack script banner before the JSON, so the JSON starts at its first line.
export function readPackageFiles(stdout: string): string[] {
  const lines = stdout.split('\n');
  const index = lines.findIndex((line) => line.trim() === '[' || line.trim().startsWith('[{'));
  if (index < 0) throw new Error('npm pack printed no JSON');
  const pack = JSON.parse(lines.slice(index).join('\n')) as Array<{ files: Array<{ path: string }> }>;
  return pack[0].files.map((file) => file.path);
}

/** Paths the package holds outside PACKAGE_PATHS (a top-level folder allows its whole subtree). */
export function packageViolations(files: readonly string[]): string[] {
  const allowed = new Set(PACKAGE_PATHS);
  return files.filter((file) => {
    const top = file.split('/')[0];
    return !allowed.has(top);
  });
}
