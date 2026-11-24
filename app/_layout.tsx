import { useFonts } from 'expo-font';
import {
  DarkTheme,
  DefaultTheme,
  type Href,
  Stack,
  ThemeProvider,
  useRouter,
} from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect } from 'react';
import 'react-native-reanimated';

import { useColorScheme } from '@/components/useColorScheme';
import {
  configureNotificationHandler,
  subscribeNotificationNavigation,
} from '../src/services/sync-service';
import { AppDataProvider } from '../src/state/app-context';

export {
  // Catch any errors thrown by the Layout component.
  ErrorBoundary,
} from 'expo-router';

export const unstable_settings = {
  initialRouteName: '(tabs)',
};

// Prevent the splash screen from auto-hiding before asset loading is complete.
SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const [loaded, error] = useFonts({
    SpaceMono: require('../assets/fonts/SpaceMono-Regular.ttf'),
  });

  useEffect(() => {
    void configureNotificationHandler();
  }, []);

  useEffect(() => {
    if (error) throw error;
  }, [error]);

  useEffect(() => {
    if (loaded) {
      SplashScreen.hideAsync();
    }
  }, [loaded]);

  if (!loaded) {
    return null;
  }

  return (
    <AppDataProvider>
      <RootLayoutNav />
    </AppDataProvider>
  );
}

function RootLayoutNav() {
  const colorScheme = useColorScheme();
  const router = useRouter();

  useEffect(() => {
    return subscribeNotificationNavigation((route) => {
      router.navigate(route as Href);
    });
  }, [router]);

  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      <Stack>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen
          name="article/[id]"
          options={{
            title: '記事',
            headerBackTitle: '戻る',
            headerTransparent: false,
          }}
        />
        <Stack.Screen
          name="benchmark"
          options={{ title: 'ダウンロード速度ベンチマーク', headerBackTitle: '戻る' }}
        />
      </Stack>
    </ThemeProvider>
  );
}
