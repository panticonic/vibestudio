import * as fs from "fs";
import * as path from "path";
import { createLocalPanelViewStateStore } from "@vibestudio/shell-core/localViewState";
import type { LocalPanelViewStateStore } from "@vibestudio/shell-core/panelManager";

export function createElectronLocalViewStateStore(statePath: string): LocalPanelViewStateStore {
  const filePath = path.join(statePath, "local-view-state", "panels.json");
  return createLocalPanelViewStateStore({
    read: () => fs.promises.readFile(filePath, "utf8"),
    async write(serialized) {
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
      await fs.promises.writeFile(filePath, serialized);
    },
  });
}
