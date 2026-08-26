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
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Vary": "Origin",
    };
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (req.method !== "GET" && req.method !== "POST") return new Response("method not allowed", { status: 405, headers: cors });
    // Browsers always send Origin on cross-origin fetches — no Origin means curl/bots burning our API quotas
    if (!ALLOWED_ORIGINS.includes(origin)) return new Response("forbidden origin", { status: 403, headers: cors });

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
      const json = (obj, status = 200, extra = {}) =>
        new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json", ...extra } });

      // --- Kakao Login: exchange the authorization code (or refresh) for tokens.
      //     client_id must be the REST key, which lives here as a secret. ---
      if (url.pathname === "/auth/token" && req.method === "POST") {
        const b = await req.json().catch(() => ({}));
        const form = b.refresh_token
          ? { grant_type: "refresh_token", client_id: env.KAKAO_REST_KEY, refresh_token: b.refresh_token }
          : { grant_type: "authorization_code", client_id: env.KAKAO_REST_KEY, redirect_uri: b.redirect_uri || "", code: b.code || "" };
        if (env.KAKAO_CLIENT_SECRET) form.client_secret = env.KAKAO_CLIENT_SECRET;   // required if enabled in the Kakao console's 보안 tab
        const r = await fetch("https://kauth.kakao.com/oauth/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded;charset=utf-8" },
          body: new URLSearchParams(form),
        });
        const body = await r.json().catch(() => ({}));
        if (!r.ok) return json({ error: body.error_description || body.error || "token error" }, r.status === 400 ? 400 : 502);
        return json({ access_token: body.access_token, refresh_token: body.refresh_token, expires_in: body.expires_in });
      }

      // --- Star ratings (login required). One rating per user per place, updatable. ---
      // Bearer token is either a Kakao access token (opaque) or a Google ID token (JWT).
      // User ids are namespaced "k:<kakao id>" / "g:<google sub>" so the providers can't collide.
      const GOOGLE_CLIENT_ID = "461639910588-72hlpadstkq8idus5jvi256113pqok29.apps.googleusercontent.com";
      const verifyUser = async () => {
        const auth = req.headers.get("Authorization") || "";
        if (!auth.startsWith("Bearer ") || auth.length < 20) return null;
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(auth));
        const key = "tok:" + [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, "0")).join("");
        const cached = await env.RATINGS.get(key);
        if (cached) return cached;
        const raw = auth.slice(7);
        let uid = null;
        if (raw.split(".").length === 3) {   // JWT → Google ID token
          const r = await fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(raw));
          if (r.ok) { const b = await r.json(); if (b.aud === GOOGLE_CLIENT_ID && b.sub) uid = "g:" + b.sub; }
        } else {                             // opaque → Kakao access token
          const r = await fetch("https://kapi.kakao.com/v2/user/me", { headers: { Authorization: auth } });
          if (r.ok) { const id = (await r.json()).id; if (id) uid = "k:" + id; }
        }
        if (!uid) return null;
        await env.RATINGS.put(key, uid, { expirationTtl: 600 });
        return uid;
      };
      const summarize = (m, uid) => {
        const vals = Object.values(m);
        return { avg: vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length * 10) / 10 : 0,
                 count: vals.length, mine: m[uid] || 0 };
      };

      if (url.pathname === "/ratings" && req.method === "GET") {
        if (!env.RATINGS) return json({ error: "ratings storage not set" }, 501);
        const uid = await verifyUser();
        if (!uid) return json({ error: "unauthorized" }, 401);
        const ids = (url.searchParams.get("ids") || "").split(",").filter(id => /^\d{1,20}$/.test(id)).slice(0, 120);
        const out = {};
        await Promise.all(ids.map(async id => {
          const m = JSON.parse(await env.RATINGS.get("r:" + id) || "{}");
          if (Object.keys(m).length || true) out[id] = summarize(m, uid);
        }));
        return json(out);
      }

      const rm = url.pathname.match(/^\/ratings\/(\d{1,20})$/);
      if (rm && req.method === "POST") {
        if (!env.RATINGS) return json({ error: "ratings storage not set" }, 501);
        const uid = await verifyUser();
        if (!uid) return json({ error: "unauthorized" }, 401);
        const stars = (await req.json().catch(() => ({}))).stars;
        if (!Number.isInteger(stars) || stars < 1 || stars > 5) return json({ error: "stars must be 1-5" }, 400);
        const key = "r:" + rm[1];
        const m = JSON.parse(await env.RATINGS.get(key) || "{}");
        m[uid] = stars;
        await env.RATINGS.put(key, JSON.stringify(m));
        return json(summarize(m, uid));
      }

      return new Response("not found", { status: 404, headers: cors });
    } catch (e) {
      return new Response("upstream error: " + e.message, { status: 502, headers: cors });
    }
  },
};
