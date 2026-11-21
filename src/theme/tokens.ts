import { useColorScheme } from '@/components/useColorScheme';

export interface ThemeColors {
  background: string;
  surface: string;
  surfaceSecondary: string;
  border: string;
  text: string;
  textSecondary: string;
  textMuted: string;
  accent: string;
  accentSoft: string;
  accentText: string;
  badgeSuccessBg: string;
  badgeSuccessText: string;
  badgeSavedBg: string;
  badgeSavedText: string;
  danger: string;
  dangerSoft: string;
}

const LIGHT_COLORS: ThemeColors = {
  background: '#F2F2F7',
  surface: '#FFFFFF',
  surfaceSecondary: '#E5E7EB',
  border: '#E5E5EA',
  text: '#111827',
  textSecondary: '#4B5563',
  textMuted: '#9CA3AF',
  accent: '#2563EB',
  accentSoft: '#DBEAFE',
  accentText: '#1D4ED8',
  badgeSuccessBg: '#DCFCE7',
  badgeSuccessText: '#15803D',
  badgeSavedBg: '#FEF3C7',
  badgeSavedText: '#B45309',
  danger: '#DC2626',
  dangerSoft: '#FEE2E2',
};

const DARK_COLORS: ThemeColors = {
  background: '#000000',
  surface: '#1C1C1E',
  surfaceSecondary: '#2C2C2E',
  border: '#38383A',
  text: '#F9FAFB',
  textSecondary: '#D1D5DB',
  textMuted: '#6B7280',
  accent: '#3B82F6',
  accentSoft: '#1E3A8A',
  accentText: '#93C5FD',
  badgeSuccessBg: '#14532D',
  badgeSuccessText: '#86EFAC',
  badgeSavedBg: '#78350F',
  badgeSavedText: '#FDE68A',
  danger: '#F87171',
  dangerSoft: '#450A0A',
};

export function useThemeColors(): ThemeColors {
  const scheme = useColorScheme();
  return scheme === 'dark' ? DARK_COLORS : LIGHT_COLORS;
}
