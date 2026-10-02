# Offline Phonon-2 dictation

Vibestudio ships the original Fermion Research Phonon-2 weights and the native
encoder/TDT libraries from `fermion-research` 0.2.7. There is no Python
interpreter, Python package, model conversion, or first-use download in the
installed app. The approximately 177 MB model stays in its original five-value
container; loading repacks its values into the native kernel's two-bit planes
without introducing another model quantization. Inference uses upstream's
default one-dot mode.

## Ownership

`scripts/phonon-runtime-artifacts.mjs` bakes `dist/phonon` from checksum-pinned
inputs. Full/source host builds and Electron packaging stage the same payload.
The payload includes JS loading/DSP code, kernels, N-API bindings, weights, and
licenses. Build verification checks the inventory before platform signing.
Vendor payloads are content addressed, with small immutable JS generations
inside them. The atomic `runtime.json` coordinate selects the current generation;
live speech runtimes keep their original installed entry path. Code
updates neither copy weights nor rename/delete loaded libraries. Packaging
includes only the selected vendor payload.
Model/config integrity is also checked when loading. Signing may change native
code bytes, so installed kernels use the application's code trust boundary.

The host's `speech.transcribe` service owns one resident inference subprocess
and serializes invocations. It launches the installed standalone Node runtime
at the immutable resource coordinate with a minimal environment, rather than
inheriting host credentials or Node options. Audio/results remain invocation data and
are never stored on disk. Cancelling active work kills and joins its child;
service shutdown and owner disconnect retire it. Errors propagate through
the ordinary RPC response stream. There are no inference deadlines or
automatic retries.

The chat composer requests microphone access only after a click, records using
the browser's supported codec, and resamples through Web Audio to mono 16 kHz
float32 PCM. Stopping dictation inserts text at the draft selection for review.
The draft cannot be sent or edited during capture/transcription. Failed
transcription retains the recording for an explicit retry or dismissal;
navigation, disconnect, cancellation, and unmount release capture resources.
Speech recognition runs in the workspace, which may be on another device.

English is the model's supported language. The 4 MiB PCM invocation budget
(about 65 seconds) keeps base64 plus RPC metadata inside Iroh's 8 MiB envelope
contract. Native attention windows are at most 30 seconds, split near quiet
audio. This size limit is a transport/allocation contract, not a timer.

## Native targets

The matrix matches `native/node/distribution.json`:

| Target | Baseline | Optional faster encoder/decoder |
| --- | --- | --- |
| Linux x64, glibc | SSE4.1 | AVX2 encoder; decoder dispatches internally |
| Linux ARM64, glibc | ARMv8 NEON, glibc 2.17 | dotprod + LSE; i8mm dispatch within kernel |
| macOS ARM64 | Apple Silicon | Native ARM kernels |
| Windows x64 | SSE4.1 | AVX2 encoder; decoder dispatches internally |

Feature probing occurs through the baseline library before loading an
instruction-specific library. ARM does not assume dotprod, LSE, or i8mm.
This does not add unsupported desktop targets such as Intel macOS, Windows
ARM64, or musl Linux to the app's installed Node matrix.

## Verification

```sh
node --test native/phonon/phonon.test.mjs
node scripts/phonon-smoke.mjs
pnpm test:userland -- --template base --filter packages/agentic-chat/hooks/useDictation.test.tsx --filter packages/agentic-chat/components/ChatInput.test.tsx
pnpm type-check:userland -- --template base
```

The smoke runs the actual bundled subprocess twice, checks a malformed request,
verifies the JFK transcript, and joins clean EOF shutdown. The CI workflow runs
it on each native OS/architecture, including `ubuntu-24.04-arm`. Configuration
is not evidence that other platforms have passed: local verification here is
Linux x64; the remaining matrix requires its native CI results.

## Attribution

Model: [Fermion Research Phonon-2](https://www.fermionresearch.com/models/phonon-2/),
[pinned model release](https://huggingface.co/FermionResearch/Phonon-2/tree/9c7fef3584499a88fe8d394427f45851bbb8b446).
Weights are CC BY 4.0; native engine code is Apache 2.0. Their original licenses
and notices ship under `dist/phonon/<vendor-id>/licenses`. Koffi and fft.js retain their
package licenses. `fixtures/jfk.wav` is the public-domain JFK inaugural-address
excerpt used by [OpenAI Whisper's test audio](https://github.com/openai/whisper/blob/main/tests/jfk.wav).
