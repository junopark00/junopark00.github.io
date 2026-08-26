/* Cloudflare Worker for 점메추.
   Keeps the Kakao REST key server-side and adds CORS for the GitHub Pages origin.
     GET /search/keyword.json?...   → dapi.kakao.com/v2/local/search/keyword.json  (adds Authorization)
     GET /search/category.json?...  → dapi.kakao.com/v2/local/search/category.json
   Deploy: npm i -g wrangler && wrangler login && wrangler deploy
           wrangler secret put KAKAO_REST_KEY
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
      return new Response("not found", { status: 404, headers: cors });
    } catch (e) {
      return new Response("upstream error: " + e.message, { status: 502, headers: cors });
    }
  },
};
