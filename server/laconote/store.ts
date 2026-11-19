import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { DEFAULT_API_URL, DEFAULT_WEB_URL } from "../../shared/laconote.ts";
import { readJsonFile, writeJsonFile } from "../json-file.ts";

/**
 * This machine's Laconote state (03-model.md, Runtime files): the URLs in `laconote.json`, the API key
 * alone in `secrets.json` (0600), and in `imports.json` the action items each meeting already gave.
 * The key leaves this class only through `key()`, for the REST client. Memory changes only after its
 * file is written, so a failed write never leaves the two disagreeing.
 */

const settingsSchema = z.object({ version: z.literal(1), api_url: z.string(), web_url: z.string() });
const secretsSchema = z.object({ version: z.literal(1), laconote_key: z.string().optional() });
const importsSchema = z.object({
  version: z.literal(1),
  meetings: z.record(
    z.string(),
    z.object({ title: z.string(), items: z.array(z.string()), at: z.string() }),
  ),
});
type Imports = z.output<typeof importsSchema>;

export class LaconoteStore {
  private readonly dir: string;
  private settings: z.output<typeof settingsSchema>;
  private secret: string | undefined;
  private imports: Imports;
  /** Files that could not be read and were moved aside. */
  readonly movedAside: string[] = [];

  constructor(dir: string) {
    this.dir = dir;
    const settings = readJsonFile(this.path("laconote.json"), settingsSchema, () => ({ version: 1 as const, api_url: DEFAULT_API_URL, web_url: DEFAULT_WEB_URL }));
    const secrets = readJsonFile(this.path("secrets.json"), secretsSchema, (): z.output<typeof secretsSchema> => ({ version: 1 }));
    const imports = readJsonFile(this.path("imports.json"), importsSchema, () => ({ version: 1 as const, meetings: {} }));
    for (const read of [settings, secrets, imports]) if (read.movedAside) this.movedAside.push(read.movedAside);
    this.settings = settings.value;
    this.secret = secrets.value.laconote_key || undefined;
    this.imports = imports.value;
    // Unreadable URLs fall back to the defaults, and the key was given for whatever server they named:
    // it is dropped rather than sent to the default one. If that fails it is at least not used now.
    if (settings.movedAside && this.secret) {
      try {
        this.clearKey();
      } catch {
        this.secret = undefined;
      }
    }
  }

  private path(name: string): string {
    return join(this.dir, name);
  }

  get apiUrl(): string {
    return this.settings.api_url;
  }

  get webUrl(): string {
    return this.settings.web_url;
  }

  get hasKey(): boolean {
    return Boolean(this.secret);
  }

  key(): string | undefined {
    return this.secret;
  }

  setUrls(apiUrl: string, webUrl: string): void {
    const settings = { version: 1 as const, api_url: apiUrl, web_url: webUrl };
    writeJsonFile(this.path("laconote.json"), settings);
    this.settings = settings;
  }

  setKey(key: string): void {
    const path = this.path("secrets.json");
    // writeJsonFile creates the file 0600 (a umask can only narrow that), so nothing after the write can fail.
    writeJsonFile(path, { version: 1, laconote_key: key });
    this.secret = key;
  }

  /** Also removes copies an unreadable secrets.json left when it was moved aside. */
  clearKey(): void {
    const path = this.path("secrets.json");
    if (existsSync(path)) rmSync(path);
    this.secret = undefined;
    for (const name of readdirSync(this.dir)) if (name.startsWith("secrets.json.broken-")) rmSync(this.path(name));
  }

  /** The item keys a meeting already gave as drafts. */
  imported(source: string): Set<string> {
    return new Set(this.imports.meetings[source]?.items ?? []);
  }

  remember(source: string, title: string, items: string[], at: Date): void {
    const known = this.imported(source);
    for (const item of items) known.add(item);
    const imports: Imports = { version: 1, meetings: { ...this.imports.meetings, [source]: { title, items: [...known], at: at.toISOString() } } };
    writeJsonFile(this.path("imports.json"), imports);
    this.imports = imports;
  }
}
