import iconPng from "../assets/favicon.png" with { type: "file" };
import iconSvg from "../assets/icon.svg" with { type: "file" };

/** The app icon at the paths browsers and favicon fetchers look for. Embedded in the binary by `bun build --compile`. */
export function favicon(path: string): Response | null {
  if (path === "/favicon.ico") return icon(iconPng, "image/png");
  if (path === "/favicon.svg") return icon(iconSvg, "image/svg+xml");
  return null;
}

function icon(file: string, type: string): Response {
  return new Response(Bun.file(file), { headers: { "Content-Type": type, "Cache-Control": "public, max-age=86400" } });
}
