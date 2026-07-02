---
name: google-drive
description: Google Drive file browsing, uploads, permissions, shared drives, and change sync on top of verified Google Workspace.
---

# Google Drive Skill

Use this skill when the user wants Vibez1 to work with Google Drive files,
shared drives, permissions, exports, uploads, or change sync. This skill sits
on top of the verified `google-workspace` connection and reuses the staged
`google-drive` binding.

## Prerequisite

Google Drive has no separate console setup beyond Google Workspace. The user
must first complete `skills/google-workspace/ONBOARDING.md` and reach the
verified stage.

## Runtime Helpers

```ts
import {
  createGoogleDriveClient,
  getGoogleDriveOnboardingStatus,
  verifyGoogleDriveAccess,
} from "@workspace-skills/google-drive";
```

Recommended flow:

1. Run `getGoogleDriveOnboardingStatus()`.
2. If the stage is `needs-google-workspace`, finish Google Workspace setup
   first.
3. If the stage is `ready`, create a Drive client and use the file, permission,
   shared-drive, or change-sync methods as needed.
4. Run `verifyGoogleDriveAccess()` when you want a live Drive API check before
   handing the connection to a workflow.

## What The Client Can Do

The underlying client comes from `@workspace/integrations/drive` and supports:

- `about()` for account and storage metadata
- `listFiles()`, `getFile()`, `createFile()`, `updateFile()`, `moveFile()`
- `trashFile()`, `restoreFile()`, `deleteFile()`, `copyFile()`
- `downloadFile()`, `exportFile()`
- `listPermissions()`, `createPermission()`, `updatePermission()`,
  `deletePermission()`
- `listDrives()`, `getDrive()`, `createDrive()`, `updateDrive()`,
  `deleteDrive()`
- `getStartPageToken()`, `listChanges()`, `startPollingChanges()`

Use the Drive client directly for file operations; use this skill for
onboarding, readiness checks, and a stable Drive-facing entrypoint.

## Files

| Document | Content |
|----------|---------|
| [index.ts](index.ts) | Importable Drive skill helpers |
