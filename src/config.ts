import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface ChiasmusConfig {
  /** Enable auto-discovery of chiasmus-adapter-* packages at startup (default: false) */
  adapterDiscovery: boolean;
}

const DEFAULTS: ChiasmusConfig = {
  adapterDiscovery: false,
};

/** Load config from ~/.chiasmus/config.json, falling back to defaults */
export function loadConfig(chiasmusHome: string): ChiasmusConfig {
  const configPath = join(chiasmusHome, "config.json");
  if (!existsSync(configPath)) return { ...DEFAULTS };

  try {
    const raw = JSON.parse(readFileSync(configPath, "utf-8"));
    return {
      adapterDiscovery: typeof raw.adapterDiscovery === "boolean" ? raw.adapterDiscovery : DEFAULTS.adapterDiscovery,
    };
  } catch {
    return { ...DEFAULTS };
  }
}
