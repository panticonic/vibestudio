# Desktop media capture

Browser pages and workspace panels use the real browser APIs:

```ts
// Call from a user action. Chromium enforces secure contexts and activation.
const screen = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
const devices = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
// Standard constraints, enumerateDevices(), MediaStreamTrack, MediaRecorder,
// and RTCPeerConnection remain native browser objects.
```

Workspace apps declare `camera`, `microphone`, and/or `screen-capture` in their
manifest. Code panels declare the corresponding authority for their exact
origin. Ordinary websites request origin-scoped camera and microphone approvals
through the existing browser permission flow. Existing manifest approval remains
the authority for workspace code. On macOS, the OS consent follows workspace/site
consent. A denied OS permission names the Privacy & Security settings needed to
recover. Navigation, destruction, or automation invalidates pending consent.

Screen capture always needs consent for each native request, including admitted
apps. There is no session or permanent allow, and simultaneous requests cannot
share an approval. A remembered block can be removed through browser permissions.
Camera approval never authorizes screen capture, and `window-management` never
implies display access.

## Playback and fullscreen

Playback requires document user activation by default. Opening a video link in
another panel does not grant autoplay activation to that new page.

A presented browser or workspace panel can use the standard Fullscreen API,
including videos in cross-origin iframes that permit fullscreen. The compositor
expands the existing native view to the whole window and removes sibling chrome
from the native layer tree. It keeps slot layout updates live, restoring the
latest geometry on exit without reloading the page.

Use **View → Toggle Panel Full Screen** or **Enter Panel Full Screen** in a
panel's context menu to expand normal panel content. Escape leaves media
fullscreen first, then panel fullscreen. **Toggle Full Screen** (F11 on Linux
and Windows, Ctrl+Cmd+F on macOS) controls the whole window and also exits an
active panel/media presentation. Navigation, destruction, or withdrawal of the
panel releases presentation ownership. Temporary media/panel presentation does
not change the saved window fullscreen preference.

Electron's `disableHtmlFullscreenWindowResize` makes the compositor the sole
owner of native window transitions; Chromium still owns the document fullscreen
tree and media Escape behavior. View types remain `shell`, `panel`, and `app`;
browser mode is a separate panel property. Both native fullscreen permission
paths consult the compositor's presentation eligibility.

Native verification on Linux:

```sh
xvfb-run -a node scripts/fullscreen-electron-smoke.mjs
```

The check creates and cleans up its own window, profile, and local fixture
servers. It exercises actual Electron media fullscreen, Escape, cross-origin
nesting, panel restoration, and navigation.

## Source selection and Electron's limitation

Electron 45 classifies both standard display capture and older
`chromeMediaSource` requests as `display-capture`; earlier releases cannot cleanly
separate display capture from device requests. This implementation pins
45.0.0-alpha.14 because [that change](https://github.com/electron/electron/pull/52824)
has not been backported to stable Electron.
A stable 45 release should replace the prerelease after native verification.

The approval explicitly grants one display-capture request, potentially including
the entire desktop and system audio. It does **not** claim to enforce a source
restriction: Electron's legacy API accepts a caller-selected source and bypasses
`setDisplayMediaRequestHandler`. Each such request still needs its own broad,
explicit approval. The narrower browser guarantee—only the source picked by the
user is available—requires a native Electron change, not a renderer wrapper.

Standard `getDisplayMedia()` prefers the OS, following Electron’s
[system-picker API](https://www.electronjs.org/docs/latest/api/session#sessetdisplaymediarequesthandlerhandler-opts)
and [PipeWire source handling](https://www.electronjs.org/docs/latest/api/desktop-capturer#linux):

- macOS 15+: the native system picker and its live sharing controls.
- Linux with PipeWire: `desktopCapturer.getSources()` invokes the desktop portal
  and returns its selected source; that selection is used directly.
- Other native environments: a separate trusted thumbnail chooser. It offers
  screens and windows, selection by keyboard, Cancel/Escape, and an explicit
  system-audio checkbox where Electron supports loopback (Windows). Source names,
  thumbnails, and IDs are never supplied to the requesting page.

Closing or navigating the requesting page ends its native capture. Pages can
also call `stream.getTracks().forEach(track => track.stop())`. The OS presents
its own device/capture indicators where available. Electron does not expose a
complete host-side live-input tracking or stop API, so Vibestudio does not label
an approval as proof that capture is currently active. The existing browser
“stop media” action pauses playback; it is not a capture-stop control.

## Workers and Durable Objects

Workers/DOs consume encoded bytes through existing streaming RPC or HTTP. They
have no device ownership, source inventory, `navigator.mediaDevices`, or native
`MediaStream`. Capture starts in a browser document after user interaction and
approval; cancellation and the document lifetime end the capture. No second
permission store or capture-session service is introduced.

`@vibestudio/shared/mediaRecording` supplies `recordMediaStream(media, options)`:
a thin MediaRecorder-to-ReadableStream encoder. It owns the supplied tracks and
returns `{ body, contentType, stop }`. Consumer cancellation, source ending,
AbortSignal, encoder failure, or exceeding the bounded byte buffer stops the
encoder and releases all tracks. Clone tracks first if another consumer must
retain them. Bytes form one encoded recording; individual chunks are not
standalone video files, and workerd does not supply video codecs for decoding.

A workspace code panel can expose an already user-started recording through the
existing streaming RPC API (the caller's ordinary RPC authority still applies):

```ts
import { rpc } from "@workspace/runtime";
import { recordMediaStream } from "@vibestudio/shared/mediaRecording";

let recording: ReturnType<typeof recordMediaStream> | null = null;
startButton.onclick = async () => {
  const media = await navigator.mediaDevices.getDisplayMedia({ video: true });
  recording?.stop();
  recording = recordMediaStream(media, { mimeType: "video/webm" });
};
stopButton.onclick = () => recording?.stop();

rpc.exposeStreaming(
  "recording",
  async ({ signal }, sink) => {
    const current = recording;
    if (!current || current.body.locked) throw new Error("Start an available recording first");
    const reader = current.body.getReader();
    const abort = () => {
      void reader.cancel(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    let bytes = 0;
    try {
      await sink({
        kind: "head",
        status: 200,
        statusText: "OK",
        headerPairs: [["content-type", current.contentType]],
        finalUrl: "",
      });
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        await sink({ kind: "chunk", bytes: value });
      }
      await sink({ kind: "end", bytesIn: bytes });
    } finally {
      signal.removeEventListener("abort", abort);
      await reader.cancel();
      reader.releaseLock();
    }
  },
  { kind: "closed", reason: "Workspace recording is for authorized internal consumers." }
);
```

A worker or DO uses its ordinary runtime RPC client:

```ts
const response = await rpc.stream(panelId, "recording", [], { signal });
const reader = response.body!.getReader();
try {
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    await consumeEncodedBytes(value);
  }
} finally {
  await reader.cancel(); // Propagates cancellation to the browser-owned recording.
  reader.releaseLock();
}
```

Use `MediaRecorder.isTypeSupported()` when selecting an encoding for another
browser platform. This route supports streaming, recording/storage, and forwarding;
raw media-track/WebRTC parity in workerd would require a media runtime.

## Verification

Run focused host tests for `browserPermissionController`, `deviceMediaAccess`,
`displayCapturePicker`, `approvalQueue`, and `browserPermissionsService`. Run
`node scripts/desktop-media-smoke.mjs` for native Electron capture/encoding checks.
It uses an isolated profile and only a test page/canvas, denying physical-device
and legacy desktop capture. It checks screen approval, native stream creation,
encoding, cancellation, and bounded-buffer failure. Native OS pickers and real
hardware still need manual checks on each supported OS and a signed desktop build.
