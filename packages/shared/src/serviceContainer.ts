/**
 * ServiceContainer — topological lifecycle manager for ManagedServices.
 *
 * Registers services with declared dependencies, starts them in dependency
 * order, and stops them in reverse order. Supports partial-failure cleanup.
 *
 * If a ServiceDispatcher is provided, services that implement
 * getServiceDefinition() will have their RPC definitions auto-registered
 * after start().
 */

import type { ManagedService } from "./managedService.js";
import type { ServiceDefinition } from "./serviceDefinition.js";
import type { ServiceDispatcher } from "./serviceDispatcher.js";
import { createDevLogger } from "@vibez1/dev-log";

const log = createDevLogger("ServiceContainer");

export class ServiceContainer {
  private services = new Map<string, ManagedService>();
  private instances = new Map<string, unknown>();
  private startOrder: string[] = [];
  private started = false;
  private dispatcher: ServiceDispatcher | null;

  constructor(dispatcher?: ServiceDispatcher) {
    this.dispatcher = dispatcher ?? null;
  }

  /**
   * Register a managed service with explicit lifecycle hooks (start/stop) and/or
   * declared dependencies. Must be called before startAll().
   *
   * Use this for services that need lifecycle management or dependency ordering.
   * For a plain RPC service definition with no lifecycle, prefer registerRpc().
   */
  registerManaged(service: ManagedService): void {
    if (this.started) {
      throw new Error(`Cannot register service "${service.name}" after container has started`);
    }
    if (this.services.has(service.name)) {
      throw new Error(`Service "${service.name}" is already registered`);
    }
    this.services.set(service.name, service);
  }

  /**
   * Register a plain RPC service from a ServiceDefinition. The definition is
   * registered on the dispatcher when the container starts (see startAll()).
   *
   * This is the common case: a service that only exposes RPC methods and needs
   * no start/stop lifecycle. Pass `deps` to order it after other services.
   * For lifecycle hooks, use registerManaged() with a full ManagedService.
   */
  registerRpc(definition: ServiceDefinition, deps?: string[]): void {
    this.registerManaged({
      name: definition.name,
      dependencies: deps,
      getServiceDefinition: () => definition,
    });
  }

  /**
   * Start all registered services in topological dependency order.
   * On partial failure, already-started services are stopped in reverse order.
   *
   * If a dispatcher was provided, services with getServiceDefinition() have
   * their RPC definitions registered after start().
   */
  async startAll(): Promise<void> {
    if (this.started) {
      throw new Error("Container is already started");
    }

    const order = this.topologicalSort();
    const levels = this.startLevels(order);
    const started = new Set<string>();
    const activeWatchdogs = new Set<ReturnType<typeof setInterval>>();
    let startupAborted = false;

    const stopStartedInstance = async (name: string, instance: unknown): Promise<void> => {
      const service = this.services.get(name);
      if (!service?.stop) return;
      try {
        await service.stop(instance);
      } catch (e) {
        console.error(`[ServiceContainer] Cleanup error for "${name}":`, e);
      }
    };

    const waitForLevel = (promises: Promise<void>[]): Promise<void> =>
      new Promise((resolve, reject) => {
        if (promises.length === 0) {
          resolve();
          return;
        }
        let remaining = promises.length;
        let rejected = false;
        for (const promise of promises) {
          promise.then(
            () => {
              remaining -= 1;
              if (!rejected && remaining === 0) resolve();
            },
            (error: unknown) => {
              remaining -= 1;
              if (!rejected) {
                rejected = true;
                reject(error);
              }
            }
          );
        }
      });

    const startOne = async (name: string): Promise<void> => {
      const service = this.services.get(name)!;
      const resolve = <D>(depName: string, optional?: boolean): D | undefined => {
        if (!this.instances.has(depName)) {
          if (optional) return undefined;
          throw new Error(`Service "${name}" depends on "${depName}" which is not started`);
        }
        return this.instances.get(depName) as D;
      };

      log.info(`[${name}] Starting`);
      if (service.start) {
        // Watchdog: a stuck service start hangs the whole boot with no
        // further output — keep naming the offender until it resolves.
        const startedAt = Date.now();
        const watchdog = setInterval(() => {
          log.warn(
            `[${name}] still starting after ${Math.round((Date.now() - startedAt) / 1000)}s`
          );
        }, 15_000);
        activeWatchdogs.add(watchdog);
        try {
          const instance = await service.start(resolve);
          if (startupAborted) {
            await stopStartedInstance(name, instance);
            return;
          }
          this.instances.set(name, instance);
        } finally {
          clearInterval(watchdog);
          activeWatchdogs.delete(watchdog);
        }
      } else {
        if (startupAborted) return;
        this.instances.set(name, undefined);
      }
      started.add(name);

      if (startupAborted) return;

      // Auto-register RPC service definition if available.
      if (this.dispatcher && service.getServiceDefinition) {
        const def = service.getServiceDefinition();
        if (def) {
          this.dispatcher.registerService(def);
          log.info(`[${name}] Registered RPC service "${def.name}"`);
        }
      }
    };

    try {
      for (const level of levels) {
        await waitForLevel(level.map((name) => startOne(name)));
      }

      this.startOrder = order;
      this.started = true;
      log.info(`All ${order.length} services started`);
    } catch (error) {
      startupAborted = true;
      for (const watchdog of activeWatchdogs) clearInterval(watchdog);
      activeWatchdogs.clear();
      const startedInOrder = order.filter((name) => started.has(name));
      log.info(`Startup failed, cleaning up ${startedInOrder.length} started services...`);
      for (const name of startedInOrder.reverse()) {
        await stopStartedInstance(name, this.instances.get(name));
      }
      this.instances.clear();
      throw error;
    }
  }

  /**
   * Stop all services in reverse dependency order.
   */
  async stopAll(): Promise<void> {
    if (!this.started) return;

    log.info(`Stopping ${this.startOrder.length} services...`);

    for (const name of [...this.startOrder].reverse()) {
      const service = this.services.get(name);
      if (service?.stop) {
        try {
          log.info(`[${name}] Stopping`);
          await service.stop(this.instances.get(name));
        } catch (e) {
          console.error(`[ServiceContainer] Stop error for "${name}":`, e);
        }
      }
    }

    this.instances.clear();
    this.startOrder = [];
    this.started = false;
  }

  /**
   * Get a started service instance by name.
   */
  get<T>(name: string): T {
    if (!this.instances.has(name)) {
      throw new Error(`Service "${name}" is not available (not started or not registered)`);
    }
    return this.instances.get(name) as T;
  }

  /**
   * Check if a service is registered and started.
   */
  has(name: string): boolean {
    return this.instances.has(name);
  }

  /**
   * Topological sort of services by dependencies.
   * Throws on missing dependencies or cycles.
   */
  private topologicalSort(): string[] {
    const result: string[] = [];
    const visited = new Set<string>();
    const visiting = new Set<string>();

    const visit = (name: string, path: string[]) => {
      if (visited.has(name)) return;
      if (visiting.has(name)) {
        throw new Error(`Dependency cycle detected: ${[...path, name].join(" → ")}`);
      }

      const service = this.services.get(name);
      if (!service) {
        throw new Error(`Missing dependency: "${name}" (required by "${path[path.length - 1]}")`);
      }

      visiting.add(name);
      for (const dep of service.dependencies ?? []) {
        visit(dep, [...path, name]);
      }
      // Optional deps: include in ordering if registered, skip if absent
      for (const dep of service.optionalDependencies ?? []) {
        if (this.services.has(dep)) {
          visit(dep, [...path, name]);
        }
      }
      visiting.delete(name);
      visited.add(name);
      result.push(name);
    };

    for (const name of this.services.keys()) {
      visit(name, []);
    }

    return result;
  }

  /**
   * Group the topologically sorted services into dependency layers. Services in
   * one layer have no dependencies on each other, so they can start in parallel.
   */
  private startLevels(order: string[]): string[][] {
    const depthMemo = new Map<string, number>();
    const depth = (name: string): number => {
      const memo = depthMemo.get(name);
      if (memo !== undefined) return memo;
      const service = this.services.get(name)!;
      const deps = [
        ...(service.dependencies ?? []),
        ...(service.optionalDependencies ?? []).filter((dep) => this.services.has(dep)),
      ];
      const value = deps.length === 0 ? 0 : Math.max(...deps.map((dep) => depth(dep) + 1));
      depthMemo.set(name, value);
      return value;
    };

    const levels: string[][] = [];
    for (const name of order) {
      const level = depth(name);
      (levels[level] ??= []).push(name);
    }
    return levels;
  }
}
