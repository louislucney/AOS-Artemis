/** Inject the project's Figma token into the process env so the vendored
 * REST client (which reads FIGMA_ACCESS_TOKEN) works unchanged. */
export function syncFigmaTokenEnv(token: string | null): void {
  if (token) process.env.FIGMA_ACCESS_TOKEN = token;
}
