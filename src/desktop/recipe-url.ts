import { RECIPE_SCHEME } from '../shared/recipes';

// gridhive://recipe?d=<code> links from gridhive.dev/r. Windows and Linux pass the link as a command-line
// argument (first launch or 'second-instance'); macOS sends 'open-url'. Only the code is used.

const CODE = /^[A-Za-z0-9_-]{1,200000}$/;

export function recipeCodeFromUrl(raw: string): string | null {
  if (!raw.toLowerCase().startsWith(`${RECIPE_SCHEME}://`)) return null;
  try {
    const url = new URL(raw);
    if (url.hostname !== 'recipe') return null;
    const code = url.searchParams.get('d');
    return code && CODE.test(code) ? code : null;
  } catch {
    return null;
  }
}

export function recipeCodeFromArgs(argv: readonly string[]): string | null {
  for (const arg of argv) {
    const code = recipeCodeFromUrl(arg);
    if (code) return code;
  }
  return null;
}
