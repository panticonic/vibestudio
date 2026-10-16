/** External documents receive a zero-authority, explicitly connected RPC provider. */

import { exposeAutofillBridge } from "./autofillBridge.js";
import { exposeWebsiteNotificationBridge } from "./websiteNotificationBridge.js";
import { installAdBlockCosmetics } from "./adblockCosmetics.js";

exposeAutofillBridge();
exposeWebsiteNotificationBridge();
installAdBlockCosmetics();

import { exposeWebsiteWorkspaceProvider } from "./websiteWorkspaceProvider.js";
exposeWebsiteWorkspaceProvider();
