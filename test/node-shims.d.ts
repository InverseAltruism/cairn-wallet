// Minimal ambient declarations for the node built-ins the tests use. The project
// ships no @types/node (tsconfig types:[]) — tests run under tsx/node at runtime.
declare module "node:fs" {
  export function readFileSync(path: string | URL, encoding: string): string;
  export function readdirSync(path: string | URL, options?: { withFileTypes?: boolean }): any[];
}
declare module "node:path" {
  export function join(...parts: string[]): string;
}
declare module "node:url" {
  export function fileURLToPath(url: string | URL): string;
}
