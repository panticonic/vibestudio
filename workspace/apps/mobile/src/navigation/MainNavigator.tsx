/**
 * MainNavigator -- Drawer navigator wrapping the main panel screen.
 *
 * Uses @react-navigation/drawer with PanelDrawer as custom drawer content.
 * The drawer is swipeable from the left edge. The main content area shows
 * the AppBar + panel content (WebViews will be wired by Agent F).
 */

import React, { useCallback } from "react";
import { useWindowDimensions } from "react-native";
import { createDrawerNavigator } from "@react-navigation/drawer";
import { useAtomValue, useSetAtom } from "jotai";
import { MainScreen } from "../components/MainScreen";
import { PanelDrawer } from "../components/PanelDrawer";
import { activePanelIdAtom } from "../state/navigationAtoms";
import { shellClientAtom } from "../state/shellClientAtom";
import { mobileDrawerWidth } from "../shellCore/mobileLayout";

export type DrawerParamList = {
  PanelContent: undefined;
};

const Drawer = createDrawerNavigator<DrawerParamList>();

export function MainNavigator() {
  const { width } = useWindowDimensions();

  return (
    <Drawer.Navigator
      screenOptions={{
        headerShown: false,
        drawerType: "front",
        drawerStyle: { width: mobileDrawerWidth(width) },
        swipeEnabled: true,
        swipeEdgeWidth: 50,
      }}
      drawerContent={(props: { navigation: { closeDrawer: () => void } }) => (
        <DrawerContentWrapper navigation={props.navigation} />
      )}
    >
      <Drawer.Screen name="PanelContent" component={MainScreen} />
    </Drawer.Navigator>
  );
}

/**
 * Wrapper that provides PanelDrawer with the onSelectPanel callback.
 * Hydrates and focuses the selected durable panel, then closes the drawer.
 */
function DrawerContentWrapper({ navigation }: { navigation: { closeDrawer: () => void } }) {
  const shellClient = useAtomValue(shellClientAtom);
  const setActivePanelId = useSetAtom(activePanelIdAtom);

  const handleSelectPanel = useCallback(
    (panelId: string) => {
      navigation.closeDrawer();
      if (!shellClient) {
        setActivePanelId(panelId);
        return;
      }
      void shellClient.panels.focus(panelId).catch((error: unknown) => {
        console.warn("[MainNavigator] Failed to focus panel", {
          panelId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    },
    [navigation, setActivePanelId, shellClient]
  );

  return <PanelDrawer onSelectPanel={handleSelectPanel} />;
}
