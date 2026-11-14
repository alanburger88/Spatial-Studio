import type { Project } from './types';
import { LANGUAGE_DATA, type LanguageData } from './languages.data';

/**
 * Languages a project can be translated into. Left-to-right, Latin-script languages only: they render reliably
 * with the fonts the PDF engine has. Month names, date order and number conventions come from a table generated
 * from CLDR (scripts/gen-languages.mjs), so formatting is the same lookup in the browser and on the server.
 */
export const SOURCE_LANGUAGE = 'en-US';

const EN_US: LanguageData = {
  code: 'en-US', name: 'English (United States)', endonym: 'English (United States)',
  months: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  datePattern: '{m} {d}, {y}', group: ',', decimal: '.', currencyFirst: true, gap: '',
};

const BY_CODE = new Map<string, LanguageData>([[EN_US.code, EN_US], ...LANGUAGE_DATA.map((l) => [l.code, l] as [string, LanguageData])]);

/** Every language that can be added to a project (excluding the English source), sorted by English name. */
export const AVAILABLE_LANGUAGES: Array<{ code: string; name: string; endonym: string }> = LANGUAGE_DATA
  .map(({ code, name, endonym }) => ({ code, name, endonym }))
  .sort((a, b) => a.name.localeCompare(b.name));

export const languageData = (code: string | undefined | null): LanguageData => BY_CODE.get(code ?? '') ?? EN_US;
export const isSupportedLanguage = (code: string): boolean => BY_CODE.has(code);
/** Plain name for the UI: "Spanish (United States)". Unknown codes are returned unchanged. */
export const languageName = (code: string): string => BY_CODE.get(code)?.name ?? code;
/** Name without the region, for sentences: "Spanish". */
export const languageShortName = (code: string): string => languageName(code).replace(/\s*\(.*\)$/, '').replace(/^(European|Mexican|Brazilian|Canadian) /, '');

/**
 * The project's target languages (never includes the English source). Projects that predate the language list
 * behave as before: Spanish (US) is the one target language.
 */
export function projectLanguages(project: Pick<Project, 'languages'>): string[] {
  return project.languages ? project.languages.filter((l) => l !== SOURCE_LANGUAGE) : ['es-US'];
}
