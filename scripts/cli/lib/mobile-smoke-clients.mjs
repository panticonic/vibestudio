// Android launch-surface assertions for the mobile smoke (docs/client-hosts-and-clients-plan.md
// 7.3, 7.4, 10 "Mobile"): the launcher shows the clients the host published, a client link
// starts a second client in its own task beside the first, and launcher shortcuts are
// disabled when their client is retired. Pure parsers over `dumpsys` text are kept apart
// from the adb driver so they are testable without a device.

/** Component class of the activity that shows one client instance, and of the host's own screen. */
export const CLIENT_ACTIVITY = "app.vibestudio.mobile.ClientActivity";
export const HOST_ACTIVITY = "app.vibestudio.mobile.MainActivity";
export const INGRESS_ACTIVITY = "app.vibestudio.mobile.IngressActivity";

/**
 * Task ids of the activities of `packageName` in `dumpsys activity activities`, per activity class.
 * `ActivityRecord{… u0 <package>/<class> t<taskId> …}` is the stable shape across API levels.
 */
export function taskIdsByActivity(dump, packageName) {
  const byClass = new Map();
  const record = /ActivityRecord\{[^}]*?\bu\d+ ([^\s/]+)\/(\S+) t(\d+)[^}]*\}/gu;
  for (const [, pkg, cls, task] of dump.matchAll(record)) {
    if (pkg !== packageName) continue;
    const ids = byClass.get(cls) ?? new Set();
    ids.add(Number(task));
    byClass.set(cls, ids);
  }
  return byClass;
}

/**
 * Whether a client started by a link runs in a task of its own: some
 * ClientActivity task exists that is neither the host's nor one of
 * `previousClientTasks`.
 */
export function newClientTask(dump, packageName, previousClientTasks) {
  const tasks = taskIdsByActivity(dump, packageName);
  const host = tasks.get(HOST_ACTIVITY) ?? new Set();
  const found = [...(tasks.get(CLIENT_ACTIVITY) ?? [])].filter(
    (id) => !host.has(id) && !previousClientTasks.has(id)
  );
  return found[0] ?? null;
}

export function clientTasks(dump, packageName) {
  return new Set(taskIdsByActivity(dump, packageName).get(CLIENT_ACTIVITY) ?? []);
}

/**
 * Shortcut ids of `packageName` in `dumpsys shortcut`, with whether each is
 * dynamic, pinned and disabled. Lines look like
 * `ShortcutInfo {id=vibestudio://c/chat/open, flags=0x1 [Dyn], …}`.
 */
export function parseShortcuts(dump, packageName) {
  const shortcuts = [];
  let inPackage = false;
  for (const line of dump.split(/\r?\n/u)) {
    const header = line.match(/^\s*Package: (\S+)/u);
    if (header) inPackage = header[1] === packageName;
    if (!inPackage) continue;
    const info = line.match(/ShortcutInfo \{id=(\S+?), flags=0x[0-9a-f]+ \[([^\]]*)\]/u);
    if (!info) continue;
    const flags = info[2].split(/\s+/u);
    shortcuts.push({
      id: info[1],
      dynamic: flags.includes("Dyn"),
      pinned: flags.includes("Pin"),
      disabled: flags.includes("Dis"),
    });
  }
  return shortcuts;
}

export function clientLink(id, intent = "open") {
  return `vibestudio://c/${encodeURIComponent(id)}/${encodeURIComponent(intent)}`;
}

/** The adb arguments that deliver `link` to the host's ingress activity, as the launcher does for a shortcut. */
export function ingressIntentArgs(packageName, link) {
  return [
    "shell",
    "am",
    "start",
    "-W",
    "-a",
    "android.intent.action.VIEW",
    "-d",
    link,
    "-n",
    `${packageName}/${INGRESS_ACTIVITY}`,
  ];
}

/**
 * Launch a second client from its link and prove it runs in its own task.
 * `deps` are the smoke's own device and log helpers, so this stays a sequence of
 * authoritative events: the host's `client-running.<id>` phase, then the OS's task table.
 */
export async function assertSecondClientSeparateTask(deps, { packageName, clientId }) {
  const { adb, adbCapture, logcat, waitForPhase, deadlineMs } = deps;
  await logcat.waitForPhase("launch-surfaces-published", deadlineMs);
  const shortcuts = parseShortcuts(await adbCapture("shell", "dumpsys", "shortcut"), packageName);
  const link = clientLink(clientId);
  if (!shortcuts.some((shortcut) => shortcut.id === link && shortcut.dynamic)) {
    throw new Error(
      `The launcher menu has no dynamic shortcut ${link}; it has ${JSON.stringify(shortcuts.map((s) => s.id))}`
    );
  }
  const before = clientTasks(await adbCapture("shell", "dumpsys", "activity", "activities"), packageName);
  await adb("shell", "input", "keyevent", "KEYCODE_HOME");
  await adb(...ingressIntentArgs(packageName, link));
  await waitForPhase(`client-running.${clientId}`, deadlineMs);
  const after = await adbCapture("shell", "dumpsys", "activity", "activities");
  const task = newClientTask(after, packageName, before);
  if (task === null) {
    throw new Error(`${clientId} did not start in a task of its own (client tasks before: ${[...before]})`);
  }
  return task;
}
