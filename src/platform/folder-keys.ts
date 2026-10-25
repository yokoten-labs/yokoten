// ---- Folder keys in an agent's trust store, on each system (record 0040) ----
//
// Codex saves a trusted folder as a key in config.toml and looks the folder up by that key.
// How it spells and compares the key depends on the system (read in openai/codex at commit
// 970111f, codex-rs/config/src/loader/mod.rs: `normalized_project_trust_keys`,
// `normalize_project_trust_lookup_key`, `project_trust_for_lookup_key`):
// - On Windows the key is compared in ASCII lower case: `C:\Users\x` and `c:\users\x` are one
//   folder. Separators are not changed: `C:/Users/x` is another key, which matches nothing.
// - The folder is looked up as its canonical path first (dunce::canonicalize), then as the
//   current folder as Codex got it. An exact key wins; else, of the keys equal in lower
//   case, the first in byte order.
// - Codex's current folder is the system's: on Linux and macOS getcwd, which resolves every
//   symlink; on Windows the folder as the starting program passed it.
// The helpers are pure: the system comes from the caller, so Linux CI tests the Windows forms.

/** A folder key as Codex compares it on `platform`: ASCII lower case on Windows, as written elsewhere. */
export function codexKeyFold(key: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? key.replace(/[A-Z]+/g, (letters) => letters.toLowerCase()) : key;
}

/**
 * Whether dunce may keep the `\\?\` prefix on the drive path `path` (dunce 1.0.5,
 * `is_safe_to_strip_unc`): a long path (dunce's limit is 260 with the prefix; this
 * asks from 248 on, to be sure), or a part that is a reserved name or ends in a space or a
 * dot. Erring toward yes only adds a spelling to read.
 */
function mayStayVerbatim(path: string): boolean {
  if (path.length + 4 > 248) return true;
  return path
    .split('\\')
    .slice(1)
    .some((part) => /[ .]$/.test(part) || /^(aux|nul|prn|con|com[1-9]|lpt[1-9])(\.|$)/i.test(part.trim()) || /[<>:"/|?*\x00-\x1f]/.test(part));
}

/**
 * The spellings Codex's canonical path of a folder may have, from the real path Node gives
 * (`realpathSync.native`). On Windows Node drops the `\\?\` prefix, but dunce keeps it on a
 * path it can't safely shorten and on every network share (`\\?\UNC\server\share`). Every
 * spelling is read; trust holds only when each says trusted.
 */
export function codexCanonicalForms(real: string, platform: NodeJS.Platform): string[] {
  if (platform !== 'win32' || real.startsWith('\\\\?\\')) return [real];
  if (/^\\\\[^\\]/.test(real)) return [`\\\\?\\UNC\\${real.slice(2)}`];
  if (/^[A-Za-z]:\\/.test(real) && mayStayVerbatim(real)) return [real, `\\\\?\\${real}`];
  return [real];
}

/**
 * The folder Codex takes as its current folder, started in `given` (real path `real`): on
 * Windows the folder as given, elsewhere the real path, which getcwd returns. Codex keys
 * its hooks by this spelling, exactly.
 */
export function codexCurrentFolder(given: string, real: string | null, platform: NodeJS.Platform): string {
  return platform === 'win32' ? given : (real ?? given);
}

/**
 * Each way Codex may look the folder up: for each canonical spelling, the keys in the order
 * Codex tries them (canonical, then its current folder), folded as it compares them.
 */
export function codexLookupReadings(given: string, real: string | null, platform: NodeJS.Platform): string[][] {
  const current = codexCurrentFolder(given, real, platform);
  return codexCanonicalForms(real ?? given, platform).map((canonical) => [...new Set([codexKeyFold(canonical, platform), codexKeyFold(current, platform)])]);
}

/**
 * The saved key Codex takes for the folder key `lookup` (already folded): the key itself if
 * saved, else the first in byte order of the keys that fold to it. Undefined when none does.
 */
export function codexFindKey(saved: Iterable<string>, lookup: string, platform: NodeJS.Platform): string | undefined {
  const keys = [...saved];
  if (keys.includes(lookup)) return lookup;
  // Keys that fold to one key differ only in ASCII case, so UTF-16 order is byte order here.
  return keys.filter((key) => codexKeyFold(key, platform) === lookup).sort()[0];
}
