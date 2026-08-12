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
import { mobileNavigationLayout } from "../shellCore/mobileLayout";

export type DrawerParamList = {
  PanelContent: undefined;
};

const Drawer = createDrawerNavigator<DrawerParamList>();

export function MainNavigator() {
  const { width, height } = useWindowDimensions();
  const layout = mobileNavigationLayout(width, height);
  const persistent = layout.kind === "tablet";

  return (
    <Drawer.Navigator
      defaultStatus={persistent ? "open" : "closed"}
      screenOptions={{
        headerShown: false,
        drawerType: persistent ? "permanent" : "front",
        drawerStyle: { width: layout.drawerWidth },
        swipeEnabled: !persistent,
        swipeEdgeWidth: 50,
      }}
      drawerContent={(props: { navigation: { closeDrawer: () => void } }) => (
        <DrawerContentWrapper navigation={props.navigation} persistent={persistent} />
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
function DrawerContentWrapper({
  navigation,
  persistent,
}: {
  navigation: { closeDrawer: () => void };
  persistent: boolean;
}) {
  const shellClient = useAtomValue(shellClientAtom);
  const setActivePanelId = useSetAtom(activePanelIdAtom);

  const handleSelectPanel = useCallback(
    (panelId: string) => {
      if (!persistent) navigation.closeDrawer();
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
    [navigation, persistent, setActivePanelId, shellClient]
  );

  return <PanelDrawer onSelectPanel={handleSelectPanel} />;
}
