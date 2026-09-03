/**
 * Canonical host-authored approval copy.
 *
 * Product wording belongs here. Approval routing, grant semantics, and policy do
 * not. Keeping those concerns separate makes copy review possible without
 * reading the authority implementation and guarantees that desktop, mobile,
 * terminal, and push surfaces use the same language.
 *
 * Capability-specific names live alongside this file in:
 *   - each host method's service schema (static host service methods)
 *   - HOST_SEMANTIC_CAPABILITY_COPY below (semantic/runtime capabilities)
 */

export interface EditableCapabilityCopy {
  title: string;
  /** Lower-case verb phrase completing "Allow {requesterKind} to …?" */
  action: string;
  description: string;
  group: string;
}

type InstallPartCounts = {
  panels: number;
  agents: number;
  services: number;
  clientApps: number;
  extensions: number;
};

function describeInstallParts(verb: string, empty: string, summary: InstallPartCounts): string {
  const phrases = [
    [summary.panels, "panel", "panels"],
    [summary.agents, "agent", "agents"],
    [summary.services, "service", "services"],
    [summary.clientApps, "client app", "client apps"],
    [summary.extensions, "extension", "extensions"],
  ] as const;
  const parts = phrases
    .filter(([count]) => count > 0)
    .map(([count, singular, plural]) => `${count} ${count === 1 ? singular : plural}`);
  if (parts.length === 0) return empty;
  if (parts.length === 1) return `${verb} ${parts[0]}`;
  return `${verb} ${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
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
    versionLabel: "Remember for this version",
    agentIdentityLabel: "Remember for this agent",
    serviceIdentityLabel: "Remember for this service",
    versionSubject: "this version",
    agentIdentitySubject: "this agent",
    serviceIdentitySubject: "this service",
    exactVersionSubject: "this exact version",
    exactAgentIdentitySubject: "this agent",
    exactServiceIdentitySubject: "this service",
    versionWithNetworkLabel: "Allow all internet access for this version",
    agentIdentityWithNetworkLabel: "Allow all internet access for this agent",
    serviceIdentityWithNetworkLabel: "Allow all internet access for this service",
    versionWithCorsLabel: "Allow reading from any site for this version",
    agentIdentityWithCorsLabel: "Allow reading from any site for this agent",
    serviceIdentityWithCorsLabel: "Allow reading from any site for this service",
    agentCodeReviewBoundary: "Each automated run is still reviewed before it can start.",
  },

  requesterCategories: {
    panel: "Panel",
    "workspace-app": "App",
    agent: "Agent",
    eval: "Agent",
    worker: "Background task",
    "durable-object": "Service",
    extension: "Extension",
    system: "Workspace",
    "internal-service": "Built-in service",
    unknown: "Requester",
  },

  operationKinds: {
    browser: "Browser",
    credential: "Account",
    filesystem: "Files",
    git: "Version history",
    inspection: "Developer tools",
    network: "Internet access",
    panel: "Panel",
    runtime: "Running apps",
    "worker-lifecycle": "Background tasks",
    workspace: "Workspace",
    "service-setup": "Setting up a connection",
    "device-code": "Device sign-in",
    unknown: "Action",
  },

  categories: {
    connectionRequest: "Connect an account",
    gitWrite: "Push changes",
    gitRead: "Download updates",
    accessRequest: "Use an account",
    serviceSetup: "Set up a connection",
    privilegedInput: "Secure input",
    deviceSignIn: "Device sign-in",
    // The install review's category chip, by mode. Plain nouns for what is
    // happening, never the runtime's word for it.
    workspaceSetup: "Your workspace",
    templateAdd: "Add a template",
    templateUpdate: "Template update",
    templateRemove: "Remove a template",
    partChanged: "A part changed",
    workspaceSource: "Workspace update",
    configEdit: "Settings change",
    writeRequest: "Save changes",
    remoteConfig: "Publishing setup",
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
        description:
          "Keep allowing until you close Vibestudio. You can change this in Permissions.",
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
        description: "Save this account and keep using it until you close Vibestudio.",
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
        description: "Keep allowing downloads from here until you close Vibestudio.",
      },
      deny: "Don't download.",
    },
    gitWrite: {
      once: { label: "Push once", description: "Allow this upload once." },
      session: {
        label: "Push for now",
        description: "Keep allowing uploads here until you close Vibestudio.",
      },
      deny: "Don't upload.",
    },
    browserSignIn: {
      once: { label: "Sign in once", description: "Open this sign-in page once." },
      session: {
        label: "Sign in for now",
        description: "Allow sign-ins here until you close Vibestudio.",
      },
      deny: "Don't open this sign-in page.",
    },
    browserOpen: {
      once: { label: "Open once", description: "Open this page once." },
      session: {
        label: "Open for now",
        description: "Allow opening this site until you close Vibestudio.",
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
      once: { label: "Update once", description: "Allow this update once." },
      sessionLabel: "Update for now",
      deny: "Don't allow this update.",
    },
    workspaceConfig: {
      once: { label: "Edit once", description: "Allow this settings change once." },
      session: {
        label: "Edit for now",
        description: "Allow settings changes until you close Vibestudio.",
      },
      deny: "Don't change this setting.",
    },
    workspaceWrite: {
      once: { label: "Save once", description: "Allow saving these changes once." },
      session: {
        label: "Save for now",
        description: "Allow saving to this project until you close Vibestudio.",
      },
      deny: "Don't save these changes.",
    },
    sharedRemote: {
      once: { label: "Change once", description: "Allow this publishing change once." },
      session: {
        label: "Change for now",
        description: "Allow publishing changes until you close Vibestudio.",
      },
      deny: "Don't change this publishing setup.",
    },
    projectImport: {
      once: { label: "Import once", description: "Allow this project import once." },
      session: {
        label: "Import for now",
        description: "Allow project imports until you close Vibestudio.",
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
    missingSecret: "Enter the required value to continue.",
    submit: "Submit",
    submitDescription: "Submit and continue.",
    missingValues: "Fill in the required values to continue.",
    inputDenied: "Cancel",
    cancel: "Cancel",
    cancelDeviceSignInDescription: "Stop waiting for the device sign-in.",
    continue: "Continue",
    useSecretOnceDescription: "Use this value one time, then forget it.",
    secretDenied: "Cancel",
    ephemeralSecretHelp:
      "Enter it here in Vibestudio's secure prompt. It's used once and not saved anywhere.",
    storedSecretHelp:
      "Enter it here in Vibestudio's secure prompt. It's saved securely and only used when needed.",
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
    version: "Remember for this version",
    // A notification opens a review; it never resolves one, and never approves
    // code from a lock screen (§7.8).
    review: "Review",
  },

  /**
   * The one review every arrival of code shares
   * (docs/template-install-unit-approval-ux-plan.md §7).
   *
   * Copy here is normative. It says what a part can do in the words a person
   * would use, never in the words the runtime uses, and it never implies we have
   * reviewed, approved, or vouched for anyone — because we have not.
   */
  installReview: {
    heading: {
      "adopt-root": "Welcome — here's what's in your workspace",
      install: (template: string) => `Add ${template}`,
      update: (template: string) => `Update ${template}`,
      remove: (template: string) => `Remove ${template}`,
      "part-changed": (part: string) => `${part} changed`,
    },
    summary: {
      partChanged: "Someone edited this part in your workspace.",
      /** An upgrade that changes no declared authority is one line, never a list. */
      noPermissionChanges: (count: number) =>
        `Updates ${count} part${count === 1 ? "" : "s"}. No permission changes.`,
      unchangedParts: (count: number) =>
        `${count} other part${count === 1 ? "" : "s"} updated with no permission changes`,
    },
    /** `Adds 1 panel and 2 agents` */
    adds: (summary: {
      panels: number;
      agents: number;
      services: number;
      clientApps: number;
      extensions: number;
    }): string => describeInstallParts("Adds", "Adds nothing new", summary),
    /** `Updates 3 client apps and 13 extensions` */
    updates: (summary: {
      panels: number;
      agents: number;
      services: number;
      clientApps: number;
      extensions: number;
    }): string => describeInstallParts("Updates", "Updates no existing parts", summary),
    /** `Removes 1 panel` */
    removes: (summary: {
      panels: number;
      agents: number;
      services: number;
      clientApps: number;
      extensions: number;
    }): string => describeInstallParts("Removes", "Removes no parts", summary),
    /** The row's own footprint when it has nothing headline to say. */
    nothingUnusual: (everydayCount: number) =>
      everydayCount === 0
        ? "Nothing unusual"
        : `Nothing unusual · ${everydayCount} everyday permission${everydayCount === 1 ? "" : "s"}`,
    sections: {
      everyday: (count: number) => `Plus ${count} everyday permission${count === 1 ? "" : "s"}`,
      everydayFraming:
        "These are the ordinary things parts do here. Ordinary doesn't mean harmless — open any one to see what it does.",
      showAllNotable: (count: number) => `Show all ${count} notable`,
      details: "Details",
      /**
       * A part has two workspace relationships, and they are opposites: what it
       * hosts for everything else, and what it leans on. One label rendered over
       * both facts was a bug — each gets its own honest sentence.
       */
      hostsForWorkspace: "What the rest of your workspace can use it for",
      needsFromWorkspace: "What it needs from the rest of your workspace",
      repairs: (count: number) =>
        `Also changes ${count} part${count === 1 ? "" : "s"} already in your workspace`,
      reviewChanges: "Review changes",
      /** Shown above the list once it is long enough to need narrowing (§7.2). */
      filterAll: "All",
      filterPanels: "Panels",
      filterAgents: "Agents and services",
      filterClientApps: "Client apps",
      filterExtensions: "Extensions",
      noMatches: "No parts match what you typed.",
      /** The right-hand pane's own prompt before anything is picked. */
      pickAPart: "Pick a part to see what it can do.",
    },
    /** Hover and focus copy for an unchecked row or part. */
    willAsk: "Will ask before it does these things.",
    /** The same sentence for a checked one: what the checkbox actually does. */
    willAllow: "Allowed as soon as it's added. Uncheck to be asked instead.",
    noNewPermissions: "No new permissions.",
    /** The rest of a differential line, when a part changed in more ways than fit. */
    moreChanges: (count: number) => `+${count} more`,
    /**
     * Search and the kind filter, which appear only above a long slate.
     *
     * Filtering narrows what is on screen and nothing else: the hidden parts are
     * still arriving, still selected, and still counted in the status line.
     * Saying so is the difference between a filter and a lie.
     */
    filters: {
      search: "Search parts",
      kind: "Filter by kind",
      allKinds: "All kinds",
      hidden: (hidden: number, allowed: number) =>
        `${hidden} part${hidden === 1 ? "" : "s"} hidden by your search or filter — still added, ${
          allowed === 0 ? "none allowed now" : `${allowed} still allowed now`
        }.`,
    },
    /**
     * A refused acceptance, in the review's own voice.
     *
     * What a surface can honestly say is what it can see: the operation did not
     * happen, and the selection on screen is untouched. It deliberately does not
     * name which parts failed or claim the workspace is clean — neither is
     * visible from the surface, and "leave nothing behind" is a promise the
     * server keeps, not one a card may make on its behalf.
     */
    failure: {
      heading: {
        "adopt-root": "Couldn't add these parts",
        install: "Couldn't add these parts",
        update: "Couldn't update these parts",
        remove: "Couldn't remove this template",
        "part-changed": "Couldn't use the new version",
      },
      aftermath: "Your selection is still here, exactly as you left it. You can try again.",
    },
    /**
     * What came of a review that has already been answered (§7.2's result).
     *
     * Distinct from `failure` above, which speaks to a review still on screen.
     * Once the review has left the queue there is no selection to return to, so
     * these say what is now true instead of inviting another attempt.
     */
    result: {
      /** §7.2 verbatim: `Open News →`. */
      openEntryPoint: (title: string) => `Open ${title} →`,
      /**
       * Said only when the server reports the workspace was genuinely left
       * alone. `failure.aftermath` cannot stand in for it: that sentence
       * promises the selection is still on screen, which is true of a refusal
       * and false of a resolved review.
       */
      workspaceUnchanged: "Nothing was added. Your workspace is exactly as it was.",
    },
    actionLabels: {
      "adopt-root": "Add to workspace",
      install: "Add template",
      update: "Update",
      remove: "Remove template",
      "part-changed": "Use the new version",
      notNow: "Not now",
      keepOld: "Keep the old version",
      deny: "Don't allow",
    },
    actionDescriptions: {
      "adopt-root": "Add these parts to your workspace and allow what's checked.",
      install: "Add these parts and allow what's checked.",
      update: "Update these parts and allow what's checked.",
      remove: "Stop following this template. Its parts stay in your workspace.",
      "part-changed": "Use the edited version of this part.",
      notNow: "Leave your workspace exactly as it is.",
      keepOld: "Keep running the version you already reviewed.",
    },
    /** Extensions run outside our protections; that sentence never hides. */
    nativeCodeWarning:
      "Extensions run outside Vibestudio's protections, with access to this computer.",
  },

  headlines: {
    workspaceSourceUpdate: (destination: string) => ({
      title: `Update ${destination}`,
      summary: `Saves changes to ${destination}.`,
    }),
    workspaceConfigEdit: {
      title: "Change workspace settings",
      summary: "Changes settings that affect how your workspace starts and runs.",
    },
    repositoryWrite: (destination: string) => ({
      title: `Save changes to ${destination}`,
      summary: `Adds the reviewed changes to the protected history for ${destination}.`,
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
      `Accesses ${subject}, including its files and anything running in it.`,
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
      summary: `Uses ${target}.`,
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
    deviceSignIn: (credential: string, origin: string) => ({
      title: `Sign in to ${credential}`,
      summary: `Go to ${origin} and enter the code below to finish connecting ${credential}.`,
    }),
    domainMismatch:
      "The sign-in site is different from the service's site. Make sure you recognize both.",
    contextBoundaryWarning:
      "This can affect files and running work in a different part of your project.",
    forcePush: (
      remote: string,
      overwrites:
        | {
            relationship: "related" | "unrelated";
            count: number | null;
          }
        | undefined
    ) => {
      if (overwrites?.relationship === "unrelated") {
        return {
          title: `Replace unrelated history on ${remote}`,
          summary: `Replaces a branch on ${remote} whose history has no common ancestor with the local branch.`,
          warning:
            "The remote commits cannot be counted relative to the local history and may become unreachable.",
        };
      }
      const overwrittenCount = overwrites?.count ?? 0;
      return {
        title: `Overwrite history on ${remote}`,
        summary:
          overwrittenCount > 0
            ? `Replaces ${overwrittenCount} commit${overwrittenCount === 1 ? "" : "s"} on ${remote}.`
            : `Force-updates the branch on ${remote}.`,
        warning:
          overwrittenCount > 0
            ? `The overwritten commit${overwrittenCount === 1 ? "" : "s"} can't be recovered from the remote.`
            : "This may permanently replace commits others are using.",
      };
    },
    git: (action: "read" | "write", remote: string, label: string, credential: string) => ({
      title: action === "write" ? `Push to ${remote}` : `Fetch from ${remote}`,
      summary: `Uses ${credential} to ${label} on ${remote}.`,
    }),
    oauthConnect: (credential: string, audience: string, replacementCredential?: string) => ({
      title: `Connect ${credential}`,
      summary: replacementCredential
        ? `Replaces your existing ${replacementCredential} account with ${credential} for use with ${audience}.`
        : `Connects ${credential} for use with ${audience}.`,
    }),
    credentialUse: (binding: string, credential: string, target: string) => ({
      title: `Use ${binding}`,
      summary: `Uses ${credential} to access ${target}.`,
    }),
  },
} as const;

export const HOST_AUTHORITY_GROUP_COPY = [
  ["approvals", "Your decisions", "Your past and pending permission choices"],
  ["accounts", "Workspace accounts", "Read profiles, membership, and account state"],
  ["credentials", "Accounts and passwords", "Use or manage connected accounts and saved passwords"],
  ["files", "Files and history", "Read or change your files and version history"],
  ["network", "Internet access", "Connect to websites and online services"],
  ["panels", "Panels and browser", "Open, view, or automate panels and browsers"],
  ["notifications", "Notifications", "Read or deliver workspace notifications"],
  [
    "runtime",
    "Apps and automation",
    "Start or manage apps, agents, and automated tasks in your workspace",
  ],
  ["workspace", "Workspace settings", "Change workspace settings, installed apps, or extensions"],
  ["host", "This device", "Use menus, windows, programs, and features on this computer"],
  ["other", "Other", "Access not covered by the categories above"],
] as const;

/**
 * Human names for semantic capabilities that can appear in host approval and
 * version-review prompts. Static service-method copy is in
 * each method's service schema; generated projections enforce exhaustiveness.
 */
interface SemanticCapabilityRow {
  prefix: string;
  authorityCategory: {
    domain: import("./authority/authorityDomains.js").AuthorityDomainId;
    verb: import("./authority/authorityDomains.js").AuthorityVerb;
  };
  title: string;
  action: string;
  description: string;
  group: string;
}

const HOST_SEMANTIC_CAPABILITY_DEFS: readonly SemanticCapabilityRow[] = [
  {
    prefix: "rpc:",
    authorityCategory: { domain: "automation", verb: "act" },
    title: "Communicate with other apps",
    action: "communicate with other apps in your workspace",
    description: "Exchange data with other apps, panels, and services in your workspace",
    group: "runtime",
  },
  {
    prefix: "event:",
    authorityCategory: { domain: "automation", verb: "see" },
    title: "Receive updates from other apps",
    action: "receive updates from other apps in your workspace",
    description: "Get notified when other apps or services in your workspace share updates",
    group: "runtime",
  },
  {
    prefix: "missions.",
    authorityCategory: { domain: "automation", verb: "manage" },
    title: "Manage automated tasks",
    action: "create, run, pause, or stop automated tasks",
    description: "Set up and control long-running automated tasks",
    group: "runtime",
  },
  {
    prefix: "git.project.import",
    authorityCategory: { domain: "files", verb: "act" },
    title: "Import a project",
    action: "import a project from an online repository",
    description: "Download and add a project from an online repository into this workspace",
    group: "files",
  },
  {
    prefix: "git.publish",
    authorityCategory: { domain: "sharing", verb: "act" },
    title: "Publish workspace changes",
    action: "publish workspace changes",
    description: "Upload your workspace changes to a shared online repository",
    group: "files",
  },
  {
    prefix: "git.pull",
    authorityCategory: { domain: "files", verb: "act" },
    title: "Download workspace updates",
    action: "download updates from a shared online repository",
    description: "Download and apply changes from a shared online repository",
    group: "files",
  },
  {
    prefix: "git.remotes.manage",
    authorityCategory: { domain: "sharing", verb: "manage" },
    title: "Manage publishing destinations",
    action: "change where your workspace publishes to",
    description: "Add, change, or remove online repositories your workspace syncs with",
    group: "files",
  },
  {
    prefix: "workspace-host.manage",
    authorityCategory: { domain: "computer", verb: "manage" },
    title: "Open and manage workspace apps",
    action: "open and manage workspace apps",
    description: "Start, inspect, or close apps provided by your workspace",
    group: "workspace",
  },
  {
    prefix: "workspace-units.manage",
    authorityCategory: { domain: "automation", verb: "manage" },
    title: "Manage workspace apps and services",
    action: "manage apps, panels, background tasks, and extensions",
    description: "Build, start, stop, or update apps and services in your workspace",
    group: "workspace",
  },
  {
    prefix: "extensions.reload",
    authorityCategory: { domain: "automation", verb: "manage" },
    title: "Reload extensions",
    action: "reload workspace extensions after changes",
    description: "Reload extensions after their code changes",
    group: "workspace",
  },
  {
    prefix: "browser-passwords.read",
    authorityCategory: { domain: "accounts", verb: "see" },
    title: "View saved passwords and accounts",
    action: "view saved password accounts and preferences",
    description: "View saved account names, websites, and password-saving preferences",
    group: "credentials",
  },
  {
    prefix: "browser-passwords.delete",
    authorityCategory: { domain: "accounts", verb: "act" },
    title: "Delete saved passwords",
    action: "delete saved passwords",
    description: "Permanently delete saved browser passwords",
    group: "credentials",
  },
  {
    prefix: "workspace.dependencies.install",
    authorityCategory: { domain: "automation", verb: "act" },
    title: "Install workspace software",
    action: "install software libraries your workspace needs",
    description: "Install the software libraries your workspace apps and services need to run",
    group: "workspace",
  },
  {
    prefix: "settings.read",
    authorityCategory: { domain: "automation", verb: "see" },
    title: "View workspace settings",
    action: "view workspace settings",
    description: "Read the settings used by this workspace",
    group: "workspace",
  },
  {
    prefix: "workspace-panels.manage",
    authorityCategory: { domain: "automation", verb: "manage" },
    title: "Open and arrange panels",
    action: "open and arrange workspace panels",
    description: "Create, arrange, or close panels in this workspace",
    group: "panels",
  },
  {
    prefix: "browser-data.read",
    authorityCategory: { domain: "web", verb: "see" },
    title: "Read your browser data",
    action: "read your browsing history, bookmarks, passwords, and site data",
    description: "Read your browser information through your workspace's browser-data connection",
    group: "credentials",
  },
  {
    prefix: "browser-data.write",
    authorityCategory: { domain: "web", verb: "act" },
    title: "Change your browser data",
    action: "change your browsing history, bookmarks, passwords, and site data",
    description: "Add or update your browser information through your browser-data connection",
    group: "credentials",
  },
  {
    prefix: "browser-data.delete",
    authorityCategory: { domain: "web", verb: "act" },
    title: "Delete your browser data",
    action: "delete your browsing history, bookmarks, passwords, or site data",
    description: "Delete your browser information through your browser-data connection",
    group: "credentials",
  },
  {
    prefix: "runtime.code-execution.manage",
    authorityCategory: { domain: "automation", verb: "manage" },
    title: "Run code",
    action: "run a program in a safe sandbox",
    description: "Start, watch, or stop an isolated program run",
    group: "runtime",
  },
  {
    prefix: "workspace.runtime-state.manage",
    authorityCategory: { domain: "automation", verb: "manage" },
    title: "Manage running apps and tasks",
    action: "manage apps, panels, and scheduled tasks that are currently running",
    description: "Start, stop, or check on apps and tasks running in your workspace",
    group: "workspace",
  },
  {
    prefix: "workspace.graph.delete",
    authorityCategory: { domain: "files", verb: "act" },
    title: "Permanently delete workspace history",
    action: "permanently delete workspace history or collaboration records (can't be undone)",
    description: "Delete workspace or collaboration records that cannot be restored automatically",
    group: "files",
  },
  {
    prefix: "channel.admin",
    authorityCategory: { domain: "people", verb: "manage" },
    title: "Manage a conversation",
    action: "change settings for a shared conversation",
    description: "Change the settings of a shared conversation",
    group: "runtime",
  },
  {
    prefix: "channel.archive",
    authorityCategory: { domain: "people", verb: "manage" },
    title: "Archive a conversation",
    action: "archive a conversation (it stays in history but is no longer active)",
    description: "Remove a conversation from active use while keeping its history",
    group: "runtime",
  },
  {
    prefix: "channel.members.remove",
    authorityCategory: { domain: "people", verb: "manage" },
    title: "Remove someone from a conversation",
    action: "remove a person from a shared conversation",
    description: "End a person's membership in a shared conversation",
    group: "accounts",
  },
  {
    prefix: "service:workers.resolveService",
    authorityCategory: { domain: "automation", verb: "act" },
    title: "Use a workspace service",
    action: "use a workspace service",
    description: "Connect to a service provided by this workspace",
    group: "runtime",
  },
  {
    prefix: "context.boundary",
    authorityCategory: { domain: "files", verb: "act" },
    title: "Access another part of your project",
    action: "use files and services from another part of your project",
    description: "Work with content or controls belonging to a different part of your project",
    group: "panels",
  },
  {
    prefix: "workspace.files.read",
    authorityCategory: { domain: "files", verb: "see" },
    title: "Read your files",
    action: "read files in your workspace",
    description: "Read the files this app, panel, or extension is approved to see",
    group: "files",
  },
  {
    prefix: "workspace.files.write",
    authorityCategory: { domain: "files", verb: "act" },
    title: "Change your files",
    action: "create or change files in your workspace",
    description: "Create or change the files this app, panel, or extension is approved to edit",
    group: "files",
  },
  {
    prefix: "process.execute",
    authorityCategory: { domain: "computer", verb: "act" },
    title: "Run programs on your device",
    action: "run programs on your computer",
    description: "Start approved programs on this device",
    group: "host",
  },
  {
    prefix: "network.response.read",
    authorityCategory: { domain: "web", verb: "act" },
    title: "Use the internet",
    action: "connect to the internet",
    description: "Connect to approved internet destinations",
    group: "network",
  },
  {
    prefix: "credential.use",
    authorityCategory: { domain: "accounts", verb: "act" },
    title: "Use a connected account",
    action: "use a saved account for its intended service",
    description: "Use an approved account for its intended service",
    group: "credentials",
  },
  {
    prefix: "panel.navigate",
    authorityCategory: { domain: "automation", verb: "act" },
    title: "Open or switch panels",
    action: "open panels or switch what they're showing",
    description: "Open or navigate an approved panel",
    group: "panels",
  },
  {
    prefix: "workspace-service:",
    authorityCategory: { domain: "automation", verb: "act" },
    title: "Use a workspace service",
    action: "use a workspace service",
    description: "Connect to a service set up by this workspace",
    group: "runtime",
  },
  {
    prefix: "notifications",
    authorityCategory: { domain: "computer", verb: "act" },
    title: "Show notifications",
    action: "show and manage notifications",
    description: "Display and manage notifications for this workspace",
    group: "notifications",
  },
  {
    prefix: "native-menus",
    authorityCategory: { domain: "computer", verb: "act" },
    title: "Add menu items",
    action: "add commands to your application menus",
    description: "Add commands to the application menus on this device",
    group: "host",
  },
  {
    prefix: "open-external",
    authorityCategory: { domain: "sharing", verb: "act" },
    title: "Open links in other apps",
    action: "open links in other applications on your device",
    description: "Open links in another application on this device",
    group: "network",
  },
  {
    prefix: "window-management",
    authorityCategory: { domain: "computer", verb: "manage" },
    title: "Manage windows",
    action: "open, focus, or resize Vibestudio windows",
    description: "Open, focus, or change Vibestudio windows",
    group: "host",
  },
  {
    prefix: "panel-hosting",
    authorityCategory: { domain: "automation", verb: "manage" },
    title: "Display panels",
    action: "show and coordinate workspace panels",
    description: "Display and coordinate workspace panels",
    group: "panels",
  },
  {
    prefix: "incoming-pair-links",
    authorityCategory: { domain: "people", verb: "act" },
    title: "Pair other devices",
    action: "accept links that pair another device with Vibestudio",
    description: "Handle links that pair another Vibestudio device",
    group: "host",
  },
  {
    prefix: "clipboard",
    authorityCategory: { domain: "computer", verb: "act" },
    title: "Use your clipboard",
    action: "read from or copy to your clipboard",
    description: "Read or write your clipboard",
    group: "host",
  },
  {
    prefix: "keychain",
    authorityCategory: { domain: "accounts", verb: "manage" },
    title: "Use secure storage",
    action: "save account information in your device's secure storage",
    description: "Store account information securely on this device",
    group: "credentials",
  },
  {
    prefix: "internal-model-runtime.use",
    authorityCategory: { domain: "automation", verb: "act" },
    title: "Use local AI models",
    action: "send prompts to the local AI model running on this device",
    description:
      "Use the local AI model managed by Vibestudio on this device; this does not allow other internet access",
    group: "runtime",
  },
  {
    prefix: "workspace-repo-delete",
    authorityCategory: { domain: "files", verb: "act" },
    title: "Delete a project",
    action: "permanently remove a project from your workspace",
    description: "Remove a project and its files from the workspace",
    group: "files",
  },
  {
    prefix: "workerd.inspector",
    authorityCategory: { domain: "computer", verb: "see" },
    title: "Debug a running service",
    action: "connect developer tools to a running workspace service",
    description: "Connect developer tools to a running workspace service",
    group: "runtime",
  },
];

export const HOST_SEMANTIC_CAPABILITY_COPY: ReadonlyArray<{
  prefix: string;
  presentation: EditableCapabilityCopy;
  authorityCategory: SemanticCapabilityRow["authorityCategory"];
}> = HOST_SEMANTIC_CAPABILITY_DEFS.map(
  ({ prefix, title, action, description, group, authorityCategory }) => ({
    prefix,
    presentation: { title, action, description, group },
    authorityCategory,
  })
);
