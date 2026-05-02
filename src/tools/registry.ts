import { tool, type Tool } from "ai";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z, type ZodSchema } from "zod";
import { errorMessage } from "../utils.js";

export interface ToolPlugin {
  toolName: string;
  toolDescription: string;
  toolSchema: ZodSchema;
  execute: (input: unknown) => Promise<string>;
  sourceFile: string;
}

const REGISTRY_BASENAMES = new Set(["registry.ts", "registry.js"]);

function isToolPluginCandidate(
  mod: unknown,
): mod is Omit<ToolPlugin, "sourceFile"> {
  if (mod === null || typeof mod !== "object") return false;
  const m = mod as Record<string, unknown>;
  if (typeof m.toolName !== "string" || m.toolName.length === 0) return false;
  if (typeof m.toolDescription !== "string" || m.toolDescription.length === 0)
    return false;
  if (typeof m.execute !== "function") return false;
  if (m.toolSchema === undefined || m.toolSchema === null) return false;
  const schema = m.toolSchema as { _def?: unknown; parse?: unknown };
  if (typeof schema.parse !== "function" || schema._def === undefined)
    return false;
  return true;
}

export class ToolRegistry {
  private readonly plugins = new Map<string, ToolPlugin>();

  async loadFromDirectory(dir: string): Promise<void> {
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch (err) {
      const message = errorMessage(err);
      console.warn(
        `[tool-registry] cannot read tools dir "${dir}": ${message}`,
      );
      return;
    }

    const isCompiled =
      dir.includes(`${path.sep}dist${path.sep}`) ||
      dir.endsWith(`${path.sep}dist${path.sep}tools`) ||
      dir.endsWith("/dist/tools");
    const preferredExt = isCompiled ? ".js" : ".ts";

    const candidates = entries.filter((name) => {
      if (REGISTRY_BASENAMES.has(name)) return false;
      if (name.endsWith(".d.ts") || name.endsWith(".map")) return false;
      return path.extname(name) === preferredExt;
    });

    for (const name of candidates) {
      const filePath = path.join(dir, name);
      await this.tryLoadFile(filePath);
    }
  }

  private async tryLoadFile(filePath: string): Promise<void> {
    try {
      const url = pathToFileURL(filePath).href;
      const mod = (await import(url)) as Record<string, unknown>;

      if (!isToolPluginCandidate(mod)) {
        console.warn(
          `[tool-registry] skipping "${filePath}": missing required exports ` +
            `(toolName, toolDescription, toolSchema, execute).`,
        );
        return;
      }

      const candidate = mod as unknown as Omit<ToolPlugin, "sourceFile">;

      if (this.plugins.has(candidate.toolName)) {
        console.warn(
          `[tool-registry] tool "${candidate.toolName}" from "${filePath}" ` +
            `conflicts with an existing tool; ignoring duplicate.`,
        );
        return;
      }

      this.plugins.set(candidate.toolName, {
        toolName: candidate.toolName,
        toolDescription: candidate.toolDescription,
        toolSchema: candidate.toolSchema,
        execute: candidate.execute as (input: unknown) => Promise<string>,
        sourceFile: filePath,
      });

      console.info(
        `[tool-registry] loaded tool "${candidate.toolName}" from ${path.basename(filePath)}`,
      );
    } catch (err) {
      const message = errorMessage(err);
      console.warn(`[tool-registry] failed to load "${filePath}": ${message}`);
    }
  }

  size(): number {
    return this.plugins.size;
  }

  getAISDKTools(): Record<string, Tool> {
    const out: Record<string, Tool> = {};
    for (const plugin of this.plugins.values()) {
      out[plugin.toolName] = tool({
        description: plugin.toolDescription,
        parameters: plugin.toolSchema as ZodSchema,
        execute: async (input: unknown) => {
          try {
            const validated = (plugin.toolSchema as ZodSchema).parse(input);
            return await plugin.execute(validated);
          } catch (err) {
            if (err instanceof z.ZodError) {
              return `Tool "${plugin.toolName}" received invalid input: ${err.message}`;
            }
            const message = errorMessage(err);
            return `Tool "${plugin.toolName}" execution failed: ${message}`;
          }
        },
      });
    }
    return out;
  }
}

export async function createDefaultRegistry(): Promise<ToolRegistry> {
  const registry = new ToolRegistry();
  const dir = path.dirname(fileURLToPath(import.meta.url));
  await registry.loadFromDirectory(dir);
  return registry;
}
