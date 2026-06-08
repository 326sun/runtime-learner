// Shared compatibility layer. Keep public exports stable across Hanako releases.
// Synchronised with hanako-ui-beautify/lib/hana-runtime-compat.js
import path from "path";
import { fileURLToPath } from "url";

export const HANA_BUS_SKIP = Symbol.for("hana.event-bus.skip");

const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function noop() {}

function fallbackBus(existing = {}) {
  return {
    ...existing,
    listCapabilities: typeof existing.listCapabilities === "function" ? existing.listCapabilities.bind(existing) : () => [],
    getCapability: typeof existing.getCapability === "function" ? existing.getCapability.bind(existing) : () => null,
    hasHandler: typeof existing.hasHandler === "function" ? existing.hasHandler.bind(existing) : () => false,
    request: typeof existing.request === "function"
      ? existing.request.bind(existing)
      : async (type) => { throw new Error(`EventBus request unavailable: ${type}`); },
    subscribe: typeof existing.subscribe === "function" ? existing.subscribe.bind(existing) : () => noop,
  };
}

export function normalizeRuntimeContext(ctx = {}) {
  const log = ctx.log || {};
  const config = ctx.config || {};
  return {
    ...ctx,
    pluginDir: ctx.pluginDir || PLUGIN_DIR,
    bus: fallbackBus(ctx.bus || {}),
    log: {
      info: typeof log.info === "function" ? log.info.bind(log) : noop,
      warn: typeof log.warn === "function" ? log.warn.bind(log) : noop,
      error: typeof log.error === "function" ? log.error.bind(log) : noop,
      debug: typeof log.debug === "function" ? log.debug.bind(log) : noop,
    },
    config: {
      ...config,
      update: typeof config.update === "function" ? config.update.bind(config) : noop,
      set: typeof config.set === "function" ? config.set.bind(config) : noop,
    },
  };
}

export function definePlugin(lifecycle = {}) {
  return class HanaRuntimeCompatPlugin {
    async onload() {
      if (typeof lifecycle.onload === "function") {
        return lifecycle.onload(normalizeRuntimeContext(this.ctx || {}), {
          register: (disposable) => {
            if (typeof this.register === "function") this.register(disposable);
          },
        });
      }
    }

    async onunload() {
      if (typeof lifecycle.onunload === "function") {
        return lifecycle.onunload(normalizeRuntimeContext(this.ctx || {}));
      }
    }
  };
}

export function defineTool(tool = {}) {
  return {
    parameters: { type: "object", properties: {} },
    ...tool,
  };
}

export function defineBusHandler(handler = {}) {
  return handler;
}

export function requestBus(ctx, type, payload, options) {
  return normalizeRuntimeContext(ctx).bus.request(type, payload, options);
}
