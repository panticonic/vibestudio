# Binary brand predicate

RPC must recognize ArrayBuffer internal slots across realms, without trusting
mutable prototypes or `Symbol.toStringTag`. Node and Node-compatible workerd
units expose a nonthrowing native predicate; browsers and host control workers
use the intrinsic getter. Standard package export conditions select the
implementation without changing the wire codec or protocol.

This source-only package contains JavaScript and explicit declarations so both
source bundles and compiled consumers resolve the same module tree. The
`workerd` condition denotes the Node-compatible unit runtime; the generic
`worker` condition alone does not imply Node compatibility.
