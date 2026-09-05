# Native isolation admission

The Windows launcher creates a fresh LPAC identity and applies Job Object
membership during process creation. It inherits only the selected standard
handles, has no network capabilities, and grants filesystem rights only inside
an exclusively owned staged domain. Immutable runtime/input and writable state
must be disjoint. The root process exiting retires the remaining Job Object
members before the launcher returns.

Build on Windows with `cargo build --locked --release`. The output is
`target/release/vibestudio-isolation.exe`. The sole argument is a private policy
file produced by `compileExecution` in `@vibestudio/process-adapter`.

`cargo check --locked` type-checks the Windows module on Linux too. This does not
validate Windows access checks, LPAC runtime compatibility, ConPTY, process
creation, signing, or lifecycle behavior. Native conformance is pending.

This code is an implementation component, not a shipped application boundary.
Protected admission, runtime staging, broker connections, application launcher
integration and packaged conformance remain necessary before product cutover.
The macOS Seatbelt policy compiler is in the TypeScript package; it does not
itself establish ownership of detached descendants.
