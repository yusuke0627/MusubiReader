import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useThemeColors } from '../theme/tokens';

export interface PackTabItem {
  readonly packId: string;
  readonly name: string;
}

export interface PackSwitcherProps {
  packs: readonly PackTabItem[];
  selectedPackId: string;
  onSelectPack: (packId: string) => void;
}

/**
 * Horizontal pack switcher for Home (`5chまとめ`, enabled packs, `マイRSS`).
 */
export function PackSwitcher({
  packs,
  selectedPackId,
  onSelectPack,
}: PackSwitcherProps) {
  const colors = useThemeColors();

  return (
    <View
      style={[
        styles.wrapper,
        { backgroundColor: colors.surface, borderBottomColor: colors.border },
      ]}
    >
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.scrollContent}
      >
        {packs.map((pack) => {
          const isSelected = pack.packId === selectedPackId;
          return (
            <Pressable
              key={pack.packId}
              testID={`pack-tab-${pack.packId}`}
              accessibilityRole="tab"
              accessibilityState={{ selected: isSelected }}
              onPress={() => onSelectPack(pack.packId)}
              style={[
                styles.pill,
                {
                  backgroundColor: isSelected
                    ? colors.accent
                    : colors.surfaceSecondary,
                },
              ]}
            >
              <Text
                style={[
                  styles.pillText,
                  { color: isSelected ? '#FFFFFF' : colors.text },
                ]}
              >
                {pack.name}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  scrollContent: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 8,
    flexDirection: 'row',
    alignItems: 'center',
  },
  pill: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 18,
  },
  pillText: {
    fontSize: 14,
    fontWeight: '600',
  },
});
