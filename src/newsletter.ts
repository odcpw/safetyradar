import type { Lang } from './i18n/ui';
// Listmonk public list UUIDs (news.safetyradar.ch), one list per newsletter language.
export const NL_ACTION = 'https://news.safetyradar.ch/subscription/form';
export const NL_LISTS: Record<Lang, string> = {
  de: '53134e4f-2ac5-4117-9c71-c40993fd7cc6',
  fr: '75f0caa1-9b60-4cdd-9fd0-c39222734059',
  it: '696c4a37-0996-4009-b146-3087577185b3',
  en: '5c272cd2-1f7d-4c24-9afd-89b6262170fd',
};
