/** Where the SPA lives — nginx falls back to its index.html for anything below. */
export const BASE_PATH = "/";

/** The path-based views. `/` is the landing page (null); any other unknown path is « page introuvable ». */
export type Route =
  | { k: "scrutin"; numero: number }
  | { k: "loi"; slug: string }
  | { k: "depute"; slug: string }
  | { k: "deputes" }
  | { k: "introuvable" };

/** A route that has an address of its own (the not-found view never gets pushed). */
export type PathRoute = Exclude<Route, { k: "introuvable" }>;

/** `/8431` → scrutin, `/loi/<slug>` → bill, `/depute/<slug>` / `/deputes` → deputies. */
export function routeFromPath(pathname: string): Route | null {
  if (pathname === "/" || pathname === "" || pathname === "/index.html") return null;
  // `/scrutin/9336` (a link people write by hand) is the same ballot as `/9336`.
  const mNum = /^\/(?:scrutins?\/)?(\d+)\/?$/.exec(pathname);
  if (mNum?.[1]) {
    const n = Number(mNum[1]);
    // /0 or a number too long to be exact names no ballot: say so, never fall back to home.
    return Number.isSafeInteger(n) && n > 0 ? { k: "scrutin", numero: n } : { k: "introuvable" };
  }
  const mLoi = /^\/loi\/([a-z0-9][a-z0-9-]*)\/?$/.exec(pathname);
  if (mLoi?.[1]) return { k: "loi", slug: mLoi[1] };
  const mDep = /^\/depute\/([a-z0-9][a-z0-9-]*)\/?$/.exec(pathname);
  if (mDep?.[1]) return { k: "depute", slug: mDep[1] };
  if (/^\/deputes\/?$/.test(pathname)) return { k: "deputes" };
  return { k: "introuvable" };
}

/** The URL a route lives at — single source for push/replaceState. */
export function pathForRoute(route: PathRoute): string {
  switch (route.k) {
    case "scrutin":
      return `/${route.numero}`;
    case "loi":
      return `/loi/${route.slug}`;
    case "depute":
      return `/depute/${route.slug}`;
    case "deputes":
      return "/deputes";
  }
}

/** The address the current one should read as, or null when it is already canonical (or not found). */
export function canonicalPath(pathname: string): string | null {
  const route = routeFromPath(pathname);
  if (route?.k === "introuvable") return null;
  const want = route ? pathForRoute(route) : BASE_PATH;
  return pathname === want ? null : want;
}
