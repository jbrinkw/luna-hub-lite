export const ALLOWED_DOMAINS = ['light', 'switch', 'fan', 'media_player'] as const;
export type AllowedDomain = (typeof ALLOWED_DOMAINS)[number];
