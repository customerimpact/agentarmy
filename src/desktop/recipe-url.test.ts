import { describe, expect, it } from 'vitest';
import { recipeCodeFromArgs, recipeCodeFromUrl } from './recipe-url';

describe('recipe links for the desktop app', () => {
  it('takes the code from a gridhive:// link', () => {
    expect(recipeCodeFromUrl('gridhive://recipe?d=eyJ2IjoxfQ')).toBe('eyJ2IjoxfQ');
    expect(recipeCodeFromUrl('GridHive://recipe/?d=abc_-1')).toBe('abc_-1');
  });

  it('ignores other links and odd codes', () => {
    expect(recipeCodeFromUrl('https://gridhive.dev/r#abc')).toBeNull();
    expect(recipeCodeFromUrl('gridhive://settings?d=abc')).toBeNull();
    expect(recipeCodeFromUrl('gridhive://recipe?d=a%20b')).toBeNull();
    expect(recipeCodeFromUrl('gridhive://recipe')).toBeNull();
  });

  it('finds the link among command-line arguments', () => {
    expect(recipeCodeFromArgs(['GridHive.exe', '--hidden', 'gridhive://recipe?d=xyz'])).toBe('xyz');
    expect(recipeCodeFromArgs(['GridHive.exe', '--hidden'])).toBeNull();
  });
});
