/**
 * Canonical host-authored approval copy.
 *
 * Product wording belongs here. Approval routing, grant semantics, and policy do
 * not. Keeping those concerns separate makes copy review possible without
 * reading the authority implementation and guarantees that desktop, mobile,
 * terminal, and push surfaces use the same language.
 *
 * Userland approval titles, summaries, warnings, and choices are intentionally
 * NOT defined here: they are supplied by the requesting userland provider and
 * rendered as attributed, untrusted content.
 *
 * Capability-specific names live alongside this file in:
 *   - authority/hostCapabilityPresentations.ts (static host service methods)
 *   - HOST_SEMANTIC_CAPABILITY_COPY below (semantic/runtime capabilities)
 */

export interface EditableCapabilityCopy {
  title: string;
  /** Lower-case verb phrase completing "Allow {requesterKind} to …?" */
  action: string;
  description: string;
  group: string;
}

export const HOST_APPROVAL_COPY = {
  chrome: {
    deny: "Deny",
    block: "Block",
    dismiss: "Dismiss",
    blockDescription: "Deny this and stop asking. You can undo this later in Permissions.",
    onlyThisTime: "Just this once",
    onlyThisTimeDescription: "You'll be asked again next time.",
    rememberedChoiceHint: 'Your choice is saved unless you pick "Just this once."',
    scopedChoiceHint: 'Choose "Remember" to save this decision.',
    rememberedForRequesterHint: (kind: string, label: string) =>
      `Remembered for ${kind.toLowerCase()} "${label}" until you change it.`,
    required: "Required",
    secret: "Secret",
    requestDetails: "Request details",
    addedPermissions: "New permissions",
    unchangedPermissions: "Unchanged permissions",
    removedPermissions: "Removed permissions",
    noNewPermissions: "No new permissions",
  },

  trust: {
    versionLabel: "Trust this version",
    agentIdentityLabel: "Trust this agent",
    serviceIdentityLabel: "Trust this workspace service",
    versionSubject: "this version",
    agentIdentitySubject: "this agent",
    serviceIdentitySubject: "this workspace service",
    exactVersionSubject: "this exact version",
    exactAgentIdentitySubject: "this agent",
    exactServiceIdentitySubject: "this workspace service",
    versionWithNetworkLabel: "Trust this version with internet access",
    agentIdentityWithNetworkLabel: "Trust this agent with internet access",
    serviceIdentityWithNetworkLabel: "Trust this workspace service with internet access",
    versionWithCorsLabel: "Trust this version to read data from other websites",
    agentIdentityWithCorsLabel: "Trust this agent to read data from other websites",
    serviceIdentityWithCorsLabel: "Trust this workspace service to read data from other websites",
    agentCodeReviewBoundary: "Every eval still receives its own code review before it can run.",
  },

  requesterCategories: {
    panel: "Panel",
    "workspace-app": "App",
    agent: "Agent",
    eval: "Agent",
    worker: "Agent",
    "durable-object": "Agent",
    extension: "Extension",
    system: "Workspace",
    "internal-service": "System service",
    unknown: "Something in your workspace",
  },

  operationKinds: {
    browser: "Browser",
    credential: "Account",
    filesystem: "Files",
    git: "Version history",
    inspection: "Developer tools",
    network: "Internet access",
    panel: "Panel",
    runtime: "Running services",
    "worker-lifecycle": "Background tasks",
    workspace: "Workspace",
    "service-setup": "Setting up a connection",
    userland: "App action",
    "external-agent": "Agent action",
    "device-code": "Device sign-in",
    unknown: "Action",
  },

  categories: {
    connectionRequest: "Connect an account",
    gitWrite: "Push changes",
    gitRead: "Fetch from remote",
    accessRequest: "Use an account",
    serviceSetup: "Set up a connection",
    privilegedInput: "Enter a secret",
    privilegedAction: "Sensitive action",
    agentTool: "Agent action",
    deviceSignIn: "Device sign-in",
    appManagement: "Manage apps",
    extensionManagement: "Manage extensions",
    unitManagement: "Manage workspace",
    appSource: "App code update",
    extensionSource: "Extension code update",
    unitSource: "Workspace code update",
    appSetup: "Install apps",
    extensionSetup: "Install extensions",
    workspaceSetup: "Workspace setup",
    workspaceSource: "Workspace code update",
    configEdit: "Settings change",
    writeRequest: "Save changes",
    remoteConfig: "Shared remote setup",
    projectImport: "Import a project",
    networkAccess: "Internet access",
    inspection: "Developer tools",
    signInAction: "Sign in",
    browserAction: "Open in browser",
    capabilityRequest: "Permission request",
  },

  actions: {
    critical: {
      once: {
        label: "Confirm",
        description: "Allow this one time. You'll be asked again if it comes up.",
      },
      deny: "Don't do this.",
    },
    generic: {
      once: { label: "Allow once", description: "Allow this one time." },
      session: {
        label: "Allow for now",
        description: "Keep allowing for this session. You can change this in Permissions.",
      },
      deny: "Don't allow this.",
    },
    oauthConnect: {
      once: {
        label: "Connect once",
        description: "Save this account and use it now. You'll be asked before it's used again.",
      },
      session: {
        label: "Connect for now",
        description: "Save this account and keep using it for this session.",
      },
      deny: "Don't connect.",
    },
    credentialUse: {
      onceLabel: "Use once",
      sessionLabel: "Use for now",
      deny: "Don't use this account.",
    },
    forcePush: {
      once: { label: "Allow once", description: "Allow this one time. You'll be asked each time." },
      deny: "Don't overwrite.",
    },
    gitRead: {
      once: { label: "Fetch once", description: "Allow this download once." },
      session: {
        label: "Fetch for now",
        description: "Keep allowing downloads from here for this session.",
      },
      deny: "Don't download.",
    },
    gitWrite: {
      once: { label: "Push once", description: "Allow this upload once." },
      session: {
        label: "Push for now",
        description: "Keep allowing uploads here for this session.",
      },
      deny: "Don't upload.",
    },
    browserSignIn: {
      once: { label: "Sign in once", description: "Open this sign-in page once." },
      session: {
        label: "Sign in for now",
        description: "Allow sign-ins here for this session.",
      },
      deny: "Don't open this sign-in page.",
    },
    browserOpen: {
      once: { label: "Open once", description: "Open this page once." },
      session: {
        label: "Open for now",
        description: "Allow opening this site for this session.",
      },
      deny: "Don't open this site.",
    },
    browserPermission: {
      once: { label: "Allow once", description: "Allow only this request." },
      session: {
        label: "This session",
        description: "Allow until Vibestudio closes or the browser session ends.",
      },
      always: {
        label: "Always allow",
        description: "Remember this decision for this site.",
      },
      block: {
        label: "Always block",
        description: "Block future requests from this site.",
      },
      dismiss: {
        label: "Dismiss",
        description: "Close without changing the current site decision.",
      },
    },
    workspaceSource: {
      once: { label: "Commit once", description: "Allow this code update once." },
      sessionLabel: "Commit for now",
      deny: "Don't allow this code update.",
    },
    workspaceConfig: {
      once: { label: "Edit once", description: "Allow this settings change once." },
      session: {
        label: "Edit for now",
        description: "Allow settings changes for this session.",
      },
      deny: "Don't change this setting.",
    },
    workspaceWrite: {
      once: { label: "Write once", description: "Allow this write once." },
      session: {
        label: "Write for now",
        description: "Allow writes to this repository for this session.",
      },
      deny: "Don't allow this write.",
    },
    sharedRemote: {
      once: { label: "Change once", description: "Allow this shared remote change once." },
      session: {
        label: "Change for now",
        description: "Allow shared remote changes for this session.",
      },
      deny: "Don't change this shared remote.",
    },
    projectImport: {
      once: { label: "Import once", description: "Allow this project import once." },
      session: {
        label: "Import for now",
        description: "Allow project imports for this session.",
      },
      deny: "Don't import this project.",
    },
    network: {
      once: { label: "Connect once", description: "Allow this internet request once." },
      originLabel: "Allow this site",
    },
    cors: {
      once: { label: "Read once", description: "Allow reading data from this site once." },
      originLabel: "Allow reading from this site",
    },
  },

  forms: {
    saveService: "Save this connection",
    saveServiceDescription: "Save this connection for future use.",
    saveServiceDenied: "Don't save this connection.",
    missingFields: "Fill in the required fields to continue.",
    missingSecret: "Enter the required secret to continue.",
    submit: "Submit",
    submitDescription: "Submit and continue.",
    missingValues: "Fill in the required values to continue.",
    inputDenied: "Cancel",
    cancel: "Cancel",
    cancelDeviceSignInDescription: "Stop waiting for the device sign-in.",
    continue: "Continue",
    useSecretOnceDescription: "Use this secret one time, then forget it.",
    secretDenied: "Cancel",
    ephemeralSecretHelp:
      "You enter the secret here in Vibestudio's secure prompt. It's used once and not saved anywhere.",
    storedSecretHelp:
      "You enter the secret here in Vibestudio's secure prompt. It's saved encrypted and only used for matching requests.",
  },

  externalAgent: {
    allow: "Allow",
    allowDescription: "Allow this action once.",
    deny: "Deny",
    denyDescription: "Don't allow this.",
  },

  deviceSignIn: {
    enterCode: "Enter this code:",
    verificationHelp:
      "Your browser was opened to the verification page. The connection will finish automatically once you approve there.",
  },

  pushActions: {
    once: "Once",
    session: "Session",
    deny: "Deny",
    open: "Open",
    version: "Trust this version",
    approveChange: "Approve change",
    approve: "Approve",
    approveAll: "Approve all",
  },

  unitReview: {
    directPermissions: "What this workspace item can do",
    evaluatedCodePermissions: "What code launched by it may ask to do",
    evaluatedCodeExplanation:
      "This is a maximum, not automatic access. The launched code still needs an applicable approval before it can act.",
    kinds: {
      extension: { singular: "extension", plural: "extensions" },
      app: { singular: "app", plural: "apps" },
      panel: { singular: "panel", plural: "panels" },
      worker: { singular: "background task", plural: "background tasks" },
      scheduledJob: { singular: "scheduled task", plural: "scheduled tasks" },
      agentHeartbeat: { singular: "recurring agent check", plural: "recurring agent checks" },
      mixed: { singular: "workspace item", plural: "workspace items" },
    },
    warningEffects: {
      extension: "an extension with full access to your files, internet, and system",
      app: "apps that run in your workspace",
      panel: "panels that appear and work in your workspace",
      worker: "background tasks that run in your workspace",
      scheduledJob: "tasks that run on a schedule without asking",
      agentHeartbeat: "agents that check in periodically and take actions on their own",
    },
    warning: (effects: readonly string[]) => {
      if (effects.length === 0) return "Approving this workspace settings change.";
      if (effects.length === 1) return `You are approving ${effects[0]}.`;
      return `You are approving ${effects.slice(0, -1).join("; ")} and ${effects[effects.length - 1]}.`;
    },
    title: (
      trigger: "startup" | "meta-change" | "source-change" | "management",
      count: number,
      singular: string,
      composition: string
    ) =>
      trigger === "management"
        ? `Manage ${composition}`
        : trigger === "source-change"
          ? `Update ${singular} code`
          : trigger === "meta-change" || count === 0
            ? "Change workspace settings"
            : `Start ${composition}`,
    summary: (
      trigger: "startup" | "meta-change" | "source-change" | "management",
      count: number,
      singular: string,
      nativeCode: boolean,
      composition: string
    ) =>
      count === 0
        ? "Changes workspace settings."
        : trigger === "management"
          ? `Manages ${composition}.`
          : trigger === "source-change"
            ? nativeCode
              ? "Updates the code for a trusted extension."
              : "Updates the code for a trusted app."
            : `These ${composition} need your approval before they can start.`,
    actionLabels: {
      sourceChange: "Approve update",
      management: "Approve",
      all: "Approve all",
      allow: "Allow",
      devSession: "Allow for 4 hours",
      deny: "Deny",
      denyAll: "Deny all",
    },
    actionDescriptions: {
      sourceChange: (component: string) => `Allow this ${component} code update.`,
      management: (component: string) => `Allow this ${component} change.`,
      config: "Allow this settings change.",
      sourceDevSession: (component: string) =>
        `Allow ${component} code updates without asking for 4 hours.`,
      configDevSession: "Allow settings changes without asking for 4 hours.",
      rejectSource: "Reject this code update.",
      rejectManagement: "Reject this change.",
      rejectComposition: (composition: string) => `Don't approve ${composition}.`,
      rejectKind: (component: string, count: number) =>
        `Don't install these ${component}${count === 1 ? "" : "s"}.`,
      rejectConfig: "Reject this settings change.",
      scheduledJobs: (count: number) =>
        `Approve ${count} scheduled task${count === 1 ? "" : "s"} to run automatically.`,
      agentHeartbeats: (count: number) =>
        `Approve ${count} recurring agent check${count === 1 ? "" : "s"} to run on their own.`,
      panels: (count: number) =>
        `Approve ${count} panel${count === 1 ? "" : "s"} to run in your workspace.`,
      workers: (count: number) =>
        `Approve ${count} background task${count === 1 ? "" : "s"} to run in your workspace.`,
      mixed: (composition: string) => `Approve ${composition}.`,
      install: (count: number, component: string, nativeCode: boolean) =>
        `Install and run ${count} ${component}${count === 1 ? "" : "s"}${nativeCode ? " with full system access" : ""}.`,
    },
    noDeclaredComponents:
      "This change only affects workspace settings. No new apps or tasks are being added.",
  },

  headlines: {
    workspaceSourceUpdate: (destination: string) => ({
      title: `Update ${destination}`,
      summary: `Saves code changes to ${destination}.`,
    }),
    workspaceConfigEdit: {
      title: "Change workspace settings",
      summary: "Changes settings that affect how your workspace starts and runs.",
    },
    repositoryWrite: (destination: string) => ({
      title: `Save to ${destination}`,
      summary: `Uploads your changes to ${destination}.`,
    }),
    sharedRemote: (destination: string, operation: string) => ({
      title: `Change shared sync for ${destination}`,
      summary: `${operation} for ${destination}.`,
    }),
    projectImport: (destination: string) => ({
      title: `Import ${destination}`,
      summary: `Downloads ${destination} from a remote repository.`,
    }),
    networkConnect: (destination: string) => ({
      title: `Connect to ${destination}`,
      summary: `Sends and receives data from ${destination}.`,
    }),
    corsRead: (destination: string) => ({
      title: `Read data from ${destination}`,
      summary: `Reads data from ${destination}, which is a different site than the one making the request.`,
    }),
    inspectRuntime: (target: string) => ({
      title: `Debug ${target}`,
      summary: `Opens developer tools for ${target}.`,
    }),
    contextBoundarySummary: (subject: string) =>
      `Wants to access ${subject}, including its files and anything running in it.`,
    disableService: (service: string) => ({
      title: `Turn off ${service}`,
      summary: `Turns off ${service}. You can re-enable it later.`,
    }),
    browserSignIn: (destination: string) => ({
      title: `Sign in at ${destination}`,
      summary: `Opens ${destination} in your browser to sign in.`,
    }),
    browserOpen: (destination: string) => ({
      title: `Open ${destination}`,
      summary: `Opens ${destination} in your browser.`,
    }),
    genericCapability: (target: string) => ({
      title: `Allow ${target}`,
      summary: `Wants to use ${target}.`,
    }),
    setupService: (service: string) => ({
      title: `Set up ${service}`,
      summary: `Saves your connection settings for ${service}. Secrets are stored encrypted.`,
    }),
    credentialInput: (credential: string, audience: string) => ({
      title: `Add ${credential}`,
      summary: `Saves ${credential} for use with ${audience}. Secrets are stored encrypted and only sent where they're needed.`,
    }),
    secretInputFallback: "Needs a secret for a one-time action. The value isn't saved.",
    externalAgent: (operation: string) => ({
      title: `${operation}`,
      summary: `An AI agent connected to this conversation wants to perform this action.`,
    }),
    deviceSignIn: (credential: string, code: string, origin: string) => ({
      title: `Sign in to ${credential}`,
      summary: `Go to ${origin} and enter the code below to finish connecting ${credential}.`,
    }),
    domainMismatch:
      "The sign-in site is different from the service's site. Make sure you recognize both.",
    contextBoundaryWarning:
      "This can affect files and running work in a different part of your project.",
    forcePush: (remote: string, credential: string, overwrittenCount: number) => ({
      title: `Overwrite history on ${remote}`,
      summary:
        overwrittenCount > 0
          ? `Replaces ${overwrittenCount} commit${overwrittenCount === 1 ? "" : "s"} on ${remote}.`
          : `Overwrites history on ${remote}.`,
      warning:
        overwrittenCount > 0
          ? `The overwritten commit${overwrittenCount === 1 ? "" : "s"} can't be recovered from the remote.`
          : "This may permanently replace commits others are using.",
    }),
    git: (action: "read" | "write", remote: string, label: string, credential: string) => ({
      title: action === "write" ? `Push to ${remote}` : `Fetch from ${remote}`,
      summary: `Uses your ${credential} account to ${label} on ${remote}.`,
    }),
    oauthConnect: (credential: string, audience: string, replacementCredential?: string) => ({
      title: `Connect ${credential}`,
      summary: replacementCredential
        ? `Replaces your existing ${replacementCredential} account with ${credential} for use with ${audience}.`
        : `Connects ${credential} for use with ${audience}.`,
    }),
    credentialUse: (binding: string, credential: string, target: string) => ({
      title: `Use ${binding}`,
      summary: `Uses your ${credential} account with ${target}.`,
    }),
  },
} as const;

export const HOST_AUTHORITY_GROUP_COPY = [
  ["approvals", "Approval decisions", "View and record your consent decisions"],
  ["accounts", "Workspace accounts", "Read profiles, membership, and account state"],
  ["credentials", "Accounts and secrets", "Use or manage connected accounts"],
  ["files", "Files and history", "Read or change your files and version history"],
  ["network", "Internet access", "Connect to external services or open links"],
  ["panels", "Panels and browser", "Open, view, or automate panels and browsers"],
  ["notifications", "Notifications", "Read or deliver workspace notifications"],
  [
    "runtime",
    "Apps and agents",
    "Start or manage apps and automated tasks running in your workspace",
  ],
  ["workspace", "Workspace settings", "Change workspace settings, installed apps, or extensions"],
  ["host", "Device integration", "Use native menus, windows, processes, or device features"],
  ["other", "Other access", "Use declared capabilities not covered above"],
] as const;

/**
 * Human names for semantic capabilities that can appear in host approval and
 * version-review prompts. Static service-method copy is in
 * authority/hostCapabilityPresentations.ts because its exhaustive type check is
 * coupled to the reviewed host method census.
 */
interface SemanticCapabilityRow {
  prefix: string;
  title: string;
  action: string;
  description: string;
  group: string;
}

const HOST_SEMANTIC_CAPABILITY_DEFS: readonly SemanticCapabilityRow[] = [
  {
    prefix: "browser-data.read",
    title: "Read your browser data",
    action: "read your browsing history, bookmarks, passwords, and site data",
    description:
      "Read your browser information through the workspace's approved browser-data provider",
    group: "credentials",
  },
  {
    prefix: "browser-data.write",
    title: "Change your browser data",
    action: "change your browsing history, bookmarks, passwords, and site data",
    description:
      "Add or update your browser information through the approved browser-data provider",
    group: "credentials",
  },
  {
    prefix: "browser-data.delete",
    title: "Delete your browser data",
    action: "delete your browsing history, bookmarks, passwords, or site data",
    description: "Delete your browser information through the approved browser-data provider",
    group: "credentials",
  },
  {
    prefix: "runtime.code-execution.manage",
    title: "Run code",
    action: "start, monitor, or stop a code execution",
    description: "Manage one isolated code run",
    group: "runtime",
  },
  {
    prefix: "workspace.runtime-state.manage",
    title: "Manage running workspace services",
    action: "manage apps, panels, background tasks, and scheduled work that's currently running",
    description: "Maintain running workspace apps, panels, background tasks, and scheduled work",
    group: "workspace",
  },
  {
    prefix: "workspace.graph.delete",
    title: "Permanently delete workspace history",
    action: "permanently delete workspace history or collaboration records (can't be undone)",
    description: "Delete workspace or collaboration records that cannot be restored automatically",
    group: "files",
  },
  {
    prefix: "channel.admin",
    title: "Manage a conversation",
    action: "change settings for a shared conversation",
    description: "Change the settings of a shared conversation",
    group: "runtime",
  },
  {
    prefix: "channel.archive",
    title: "Archive a conversation",
    action: "archive a conversation (it stays in history but is no longer active)",
    description: "Remove a conversation from active use while keeping its history",
    group: "runtime",
  },
  {
    prefix: "channel.members.remove",
    title: "Remove someone from a conversation",
    action: "remove a person from a shared conversation",
    description: "End a person's membership in a shared conversation",
    group: "accounts",
  },
  {
    prefix: "service:workers.resolveService",
    title: "Use a workspace service",
    action: "use a workspace service",
    description: "Connect to a service declared by this workspace",
    group: "runtime",
  },
  {
    prefix: "context.boundary",
    title: "Access another part of your project",
    action: "use files and services from another part of your project",
    description: "Use content or controls belonging to a different workspace context",
    group: "panels",
  },
  {
    prefix: "workspace.files.read",
    title: "Read your files",
    action: "read files in your workspace",
    description: "Read the files the requesting app, panel, or extension was approved to see",
    group: "files",
  },
  {
    prefix: "workspace.files.write",
    title: "Change your files",
    action: "create or change files in your workspace",
    description:
      "Create or change the files the requesting app, panel, or extension was approved to edit",
    group: "files",
  },
  {
    prefix: "workspace.history.write",
    title: "Save to version history",
    action: "save changes to your project's history",
    description: "Create or advance your project's saved history",
    group: "files",
  },
  {
    prefix: "process.execute",
    title: "Run programs on your device",
    action: "run programs on your computer",
    description: "Start approved programs on this device",
    group: "host",
  },
  {
    prefix: "network.fetch",
    title: "Use the internet",
    action: "connect to the internet",
    description: "Connect to approved internet destinations",
    group: "network",
  },
  {
    prefix: "credential.use",
    title: "Use a connected account",
    action: "use a saved account for its intended service",
    description: "Use an approved account for its declared service",
    group: "credentials",
  },
  {
    prefix: "panel.navigate",
    title: "Open or switch panels",
    action: "open panels or switch what they're showing",
    description: "Open or navigate an approved panel",
    group: "panels",
  },
  {
    prefix: "workspace-service:",
    title: "Use a workspace service",
    action: "use a workspace service",
    description: "Connect to a service set up by this workspace",
    group: "runtime",
  },
  {
    prefix: "notifications",
    title: "Show notifications",
    action: "show and manage notifications",
    description: "Display and manage notifications for this workspace",
    group: "notifications",
  },
  {
    prefix: "native-menus",
    title: "Add menu items",
    action: "add commands to your system's application menus",
    description: "Add commands to the device's native application menus",
    group: "host",
  },
  {
    prefix: "open-external",
    title: "Open links in other apps",
    action: "open links in other applications on your device",
    description: "Open links in another application on this device",
    group: "network",
  },
  {
    prefix: "window-management",
    title: "Manage windows",
    action: "open, focus, or resize Vibestudio windows",
    description: "Open, focus, or change Vibestudio windows",
    group: "host",
  },
  {
    prefix: "panel-hosting",
    title: "Display panels",
    action: "show and coordinate workspace panels",
    description: "Display and coordinate workspace panels",
    group: "panels",
  },
  {
    prefix: "incoming-pair-links",
    title: "Pair other devices",
    action: "accept links that pair another device with Vibestudio",
    description: "Handle links that pair another Vibestudio device",
    group: "host",
  },
  {
    prefix: "clipboard",
    title: "Use your clipboard",
    action: "read from or copy to your clipboard",
    description: "Read or write the device clipboard",
    group: "host",
  },
  {
    prefix: "keychain",
    title: "Use secure storage",
    action: "save account information in your device's secure storage",
    description: "Store account material in the device keychain",
    group: "credentials",
  },
  {
    prefix: "external-browser-open",
    title: "Open your browser",
    action: "open a web page in your browser",
    description: "Open a reviewed address in the system browser",
    group: "network",
  },
  {
    prefix: "external-network-fetch",
    title: "Connect to an external service",
    action: "send a request to an approved external service",
    description: "Send a network request to the approved destination",
    group: "network",
  },
  {
    prefix: "internal-model-runtime.use",
    title: "Use local AI models",
    action: "send prompts to the local AI model running on this device",
    description:
      "Use the exact local AI model server managed by Vibestudio on this device; this does not allow other network access",
    group: "runtime",
  },
  {
    prefix: "workspace-main-advance",
    title: "Update shared history",
    action: "save reviewed changes to your project's main history",
    description: "Save reviewed changes to a protected part of your project's history",
    group: "files",
  },
  {
    prefix: "workspace-repo-delete",
    title: "Delete a repository",
    action: "permanently remove a repository from your workspace",
    description: "Remove a repository from the workspace",
    group: "files",
  },
  {
    prefix: "workerd.inspector",
    title: "Debug a running service",
    action: "connect developer tools to a running workspace service",
    description: "Connect developer tools to a running workspace service",
    group: "runtime",
  },
];

export const HOST_SEMANTIC_CAPABILITY_COPY: ReadonlyArray<{
  prefix: string;
  presentation: EditableCapabilityCopy;
}> = HOST_SEMANTIC_CAPABILITY_DEFS.map(({ prefix, title, action, description, group }) => ({
  prefix,
  presentation: { title, action, description, group },
}));
