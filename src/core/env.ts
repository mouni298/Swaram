/**
 * Read an environment variable if a `process.env` exists (Node), returning
 * undefined in the browser. Lets providers fall back to conventional env vars
 * (e.g. GROQ_API_KEY) the way the official vendor SDKs do, without assuming Node.
 */
export function readEnv(name: string): string | undefined {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  return env?.[name];
}
