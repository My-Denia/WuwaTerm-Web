// GENERATED FILE — DO NOT EDIT DIRECTLY.
// Source: contracts/termbase-v1/schema.json (`npm run generate:contracts`).

export const TERMBASE_FORMAT = 'wuwaterm-termbase-v1' as const;
export const TERMBASE_SCHEMA_VERSION = 1 as const;
export const TERMBASE_DIRECTION_VALUES = ['en', 'zh'] as const;
export type TermbaseDirection = (typeof TERMBASE_DIRECTION_VALUES)[number];
export const TERMBASE_KIND_VALUES = [
  'community_term',
  'preferred_term',
  'do_not_translate',
] as const;
export type TermbaseKind = (typeof TERMBASE_KIND_VALUES)[number];
export const TERMBASE_LIMITS = {
  entries: 2000,
  id: { min: 1, max: 64 },
  source: { min: 1, max: 120 },
  target: { min: 1, max: 160 },
  note: { min: 0, max: 160 },
} as const;

export type ContractTermbaseEntryV1 = {
  id: string;
  source: string;
  target: string;
  direction: TermbaseDirection;
  kind: TermbaseKind;
  note: string;
  updated_at: string;
};

export type ContractTermbaseV1 = {
  format: 'wuwaterm-termbase-v1';
  schema_version: 1;
  updated_at: string;
  entries: ContractTermbaseEntryV1[];
};
