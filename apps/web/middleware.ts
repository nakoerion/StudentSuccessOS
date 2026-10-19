import { type NextRequest, NextResponse } from "next/server";

/**
 * Forward the pathname to server components (next-intl's request config uses
 * it to pick the tenant's default locale for /t/<slug>/...). Auth checks live
 * in the pages/layouts themselves (server-side), not here.
 */
export function middleware(request: NextRequest) {
  const headers = new Headers(request.headers);
  headers.set("x-ssos-pathname", request.nextUrl.pathname);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|svg|ico|woff2?)$).*)"],
};
