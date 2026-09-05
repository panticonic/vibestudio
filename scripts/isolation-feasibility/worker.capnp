using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [(name = "main", worker = (
    modules = [(name = "main.js", esModule = "export default { fetch() { return new Response('worker-ok'); } }")],
    compatibilityDate = "2025-01-01"
  ))],
  sockets = [(name = "http", address = "127.0.0.1:18080", http = (), service = "main")]
);
