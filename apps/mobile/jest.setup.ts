// Jest setup for React Native testing
import "react-native-gesture-handler/jestSetup";

// Mock react-native-reanimated (version mismatch with react-native@0.72)
jest.mock("react-native-reanimated", () => {
  const RN = jest.requireActual("react-native");
  return {
    __esModule: true,
    default: {
      View: RN.View,
      Text: RN.Text,
      Image: RN.Image,
      ScrollView: RN.ScrollView,
      createAnimatedComponent: (c: unknown) => c,
    },
    useSharedValue: (v: unknown) => ({ value: v }),
    useAnimatedStyle: (fn: () => unknown) => fn(),
    withTiming: (v: unknown) => v,
    withSpring: (v: unknown) => v,
    withRepeat: (v: unknown) => v,
    withSequence: (...args: unknown[]) => args[0],
    Easing: { linear: (t: unknown) => t, inOut: (fn: unknown) => fn, ease: 0 },
    cancelAnimation: jest.fn(),
    interpolate: (_v: unknown, _in: unknown, out: unknown[]) => out[0],
    Extrapolation: { CLAMP: "clamp" },
    runOnJS: (fn: unknown) => fn,
    createAnimatedComponent: (c: unknown) => c,
  };
});

// Global test timeout
jest.setTimeout(10000);

// Suppress console warnings during tests
const originalWarn = console.warn;
console.warn = (...args: unknown[]) => {
  if (typeof args[0] === "string" && args[0].includes("Warning: ReactDOM.render is deprecated")) {
    return;
  }
  originalWarn.call(console, ...args);
};

// Mock expo-secure-store
jest.mock("expo-secure-store", () => ({
  getItemAsync: jest.fn(() => Promise.resolve(null)),
  setItemAsync: jest.fn(() => Promise.resolve()),
  deleteItemAsync: jest.fn(() => Promise.resolve()),
}));

// Mock expo-notifications
jest.mock("expo-notifications", () => ({
  getPermissionsAsync: jest.fn(() => Promise.resolve({ status: "granted" })),
  requestPermissionsAsync: jest.fn(() => Promise.resolve({ status: "granted" })),
  getExpoPushTokenAsync: jest.fn(() => Promise.resolve({ data: "ExponentPushToken[dummy]" })),
  setNotificationChannelAsync: jest.fn(() => Promise.resolve()),
  setNotificationHandler: jest.fn(),
  addNotificationReceivedListener: jest.fn(() => ({ remove: jest.fn() })),
  addNotificationResponseReceivedListener: jest.fn(() => ({ remove: jest.fn() })),
  removeNotificationSubscription: jest.fn(),
  AndroidImportance: {
    MAX: 4,
  },
}));
