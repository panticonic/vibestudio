import React from "react";
import { createStackNavigator } from "@react-navigation/stack";
import { LoginScreen } from "../components/LoginScreen";

declare const require: (moduleName: string) => unknown;

export type RootStackParamList = {
  Login: undefined;
  Main: undefined;
  Settings: undefined;
};

const Stack = createStackNavigator<RootStackParamList>();

// Login is the first-paint route. React Navigation's getComponent boundary
// keeps the much larger authenticated shell (drawer, WebViews, panel bridge)
// and settings screen from being evaluated until the user actually opens them.
const getMainNavigator = () =>
  (
    require("./MainNavigator") as {
      MainNavigator: typeof import("./MainNavigator").MainNavigator;
    }
  ).MainNavigator;
const getSettingsScreen = () =>
  (
    require("../components/SettingsScreen") as {
      SettingsScreen: typeof import("../components/SettingsScreen").SettingsScreen;
    }
  ).SettingsScreen;

export function RootNavigator() {
  return (
    <Stack.Navigator initialRouteName="Login" screenOptions={{ headerShown: false }}>
      <Stack.Screen name="Login" component={LoginScreen} />
      <Stack.Screen name="Main" getComponent={getMainNavigator} />
      <Stack.Screen name="Settings" getComponent={getSettingsScreen} />
    </Stack.Navigator>
  );
}
