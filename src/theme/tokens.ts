/* Canonical AgentControl design tokens (TS mirror of tokens.css).
   Consumed by TSX inline styles so no component hard-codes a hex outside
   src/theme. Values mirror agentcontrol-app/src/theme/colors.ts — keep the
   two in sync. Light-only by design. */
export const Colors = {
  canvas: '#FAFAFC',
  surface: '#FFFFFF',
  subtle: '#F6F7F9',

  border: 'rgba(15,23,42,0.08)',
  borderStrong: 'rgba(15,23,42,0.12)',

  textPrimary: '#0A0A0F',
  textBody: '#1F2937',
  textMuted: '#6B7280',
  textSubtle: '#9CA3AF',

  accent: '#3E5FFF',
  accentHover: '#2D4AFF',
  accentTint: 'rgba(62,95,255,0.10)',
  accentSoft: '#E8EDFF',

  // Status — soft tint background + ink text pairs, plus strong dot fills.
  statusRun: '#F97316',
  statusRunTint: 'rgba(249,115,22,0.10)',
  statusRunInk: '#C2410C',
  statusWaitTint: 'rgba(234,179,8,0.12)',
  statusWaitInk: '#A16207',
  statusWaitStrong: '#A16207',
  statusDone: '#10B981',
  statusDoneStrong: '#047857',
  statusDoneTint: 'rgba(16,185,129,0.10)',
  statusDoneInk: '#047857',
  statusError: '#EF4444',
  statusErrorStrong: '#DC2626',
  statusErrorTint: 'rgba(239,68,68,0.10)',
  statusErrorInk: '#B91C1C',
  statusIdle: '#94A3B8',
  statusIdleStrong: '#64748B',
  statusIdleTint: 'rgba(148,163,184,0.10)',
  statusIdleInk: '#64748B',
  statusInfoTint: 'rgba(62,95,255,0.10)',
  statusInfoInk: '#1E3A8A',

  // Info / accent chip
  accentChipTint: 'rgba(62,95,255,0.10)',
  accentChipInk: '#1E3A8A',
} as const;
