/** External documents receive a zero-authority, explicitly connected RPC provider. */

import { exposeAutofillBridge } from "./autofillBridge.js";
import { exposeWebsiteNotificationBridge } from "./websiteNotificationBridge.js";

exposeAutofillBridge();
exposeWebsiteNotificationBridge();

import { exposeWebsiteWorkspaceProvider } from "./websiteWorkspaceProvider.js";
exposeWebsiteWorkspaceProvider();
