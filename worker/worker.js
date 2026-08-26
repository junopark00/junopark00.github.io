/* Cloudflare Worker for 점메추.
   Keeps the Kakao REST / TMAP keys server-side and adds CORS for the GitHub Pages origin.
     GET /search/keyword.json?...   → dapi.kakao.com/v2/local/search/keyword.json  (adds Authorization)
     GET /search/category.json?...  → dapi.kakao.com/v2/local/search/category.json
     GET /route/pedestrian?startX&startY&endX&endY → apis.openapi.sk.com/tmap/routes/pedestrian
                                       (returns { totalTime, totalDistance }; needs TMAP_APP_KEY)
   Deploy: npm i -g wrangler && wrangler login && wrangler deploy
           wrangler secret put KAKAO_REST_KEY
           wrangler secret put TMAP_APP_KEY
   wrangler.toml:  name = "jummechu-api"  main = "worker.js"  compatibility_date = "2025-01-01"
*/
const ALLOWED_ORIGINS = ["https://junopark00.github.io", "http://localhost:8000", "http://127.0.0.1:8000"];

export default {
  async fetch(req, env) {
    const origin = req.headers.get("Origin") || "";
    const cors = {
      "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Vary": "Origin",
    };
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (req.method !== "GET") return new Response("method not allowed", { status: 405, headers: cors });
    if (origin && !ALLOWED_ORIGINS.includes(origin)) return new Response("forbidden origin", { status: 403, headers: cors });

    const url = new URL(req.url);
    try {
      // --- place search (Kakao Local REST API) ---
      const m = url.pathname.match(/^\/search\/(keyword|category)\.json$/);
      if (m) {
        const upstream = new URL(`https://dapi.kakao.com/v2/local/search/${m[1]}.json`);
        for (const k of ["query", "category_group_code", "x", "y", "radius", "sort", "page", "size"]) {
          const v = url.searchParams.get(k); if (v !== null) upstream.searchParams.set(k, v);
        }
        const r = await fetch(upstream, { headers: { Authorization: "KakaoAK " + env.KAKAO_REST_KEY } });
        return new Response(r.body, { status: r.status, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "public, max-age=60" } });
      }
      // --- actual walking time for one place (TMAP pedestrian route) ---
      if (url.pathname === "/route/pedestrian") {
        if (!env.TMAP_APP_KEY) return new Response("tmap key not set", { status: 501, headers: cors });
        const q = url.searchParams;
        for (const k of ["startX", "startY", "endX", "endY"]) {
          if (!q.get(k)) return new Response("missing " + k, { status: 400, headers: cors });
        }
        const r = await fetch("https://apis.openapi.sk.com/tmap/routes/pedestrian?version=1", {
          method: "POST",
          headers: { appKey: env.TMAP_APP_KEY, "Content-Type": "application/json" },
          body: JSON.stringify({
            startX: q.get("startX"), startY: q.get("startY"),
            endX: q.get("endX"), endY: q.get("endY"),
            startName: "start", endName: "end",
          }),
        });
        if (!r.ok) return new Response("tmap error", { status: r.status, headers: cors });
        const body = await r.json();
        const p = body?.features?.[0]?.properties || {};
        return new Response(JSON.stringify({ totalTime: p.totalTime ?? null, totalDistance: p.totalDistance ?? null }),
          { status: 200, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "public, max-age=3600" } });
      }
      return new Response("not found", { status: 404, headers: cors });
    } catch (e) {
      return new Response("upstream error: " + e.message, { status: 502, headers: cors });
    }
  },
};
