require("dotenv").config();

const express = require("express");
const path = require("path");
const { pipeline } = require("stream/promises");

const app = express();

const PORT = process.env.PORT || 3000;

const CONFIG = {
    gateUser: process.env.GATE_USER || "Streamx",
    gatePass: process.env.GATE_PASS || "Streamx",
    iptvUrl: (process.env.IPTV_URL || "").replace(/\/+$/, ""),
    iptvUser: process.env.IPTV_USER || "",
    iptvPass: process.env.IPTV_PASS || ""
};

if (!CONFIG.iptvUrl || !CONFIG.iptvUser || !CONFIG.iptvPass) {
    console.warn("WARNING: Missing IPTV_URL, IPTV_USER, or IPTV_PASS in .env");
}

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

function buildApiUrl(action = "", params = {}) {
    const url = new URL(`${CONFIG.iptvUrl}/player_api.php`);
    url.searchParams.set("username", CONFIG.iptvUser);
    url.searchParams.set("password", CONFIG.iptvPass);

    if (action) {
        url.searchParams.set("action", action);
    }

    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null && value !== "") {
            url.searchParams.set(key, value);
        }
    }

    return url.toString();
}

function buildRawStreamUrl(type, id, ext = "mp4") {
    const safeType = String(type || "").trim();
    const safeId = String(id || "").trim();
    const safeExt = String(ext || "mp4").replace(/^\./, "").trim();

    if (!["live", "movie", "series"].includes(safeType)) {
        throw new Error("Invalid stream type");
    }

    if (!safeId) {
        throw new Error("Missing stream ID");
    }

    if (safeType === "live") {
        return `${CONFIG.iptvUrl}/live/${CONFIG.iptvUser}/${CONFIG.iptvPass}/${safeId}.m3u8`;
    }

    if (safeType === "movie") {
        return `${CONFIG.iptvUrl}/movie/${CONFIG.iptvUser}/${CONFIG.iptvPass}/${safeId}.${safeExt}`;
    }

    return `${CONFIG.iptvUrl}/series/${CONFIG.iptvUser}/${CONFIG.iptvPass}/${safeId}.${safeExt}`;
}

function getClientStreamUrl(req, type, id, ext) {
    const base = `${req.protocol}://${req.get("host")}`;
    const url = new URL(`${base}/api/stream/${encodeURIComponent(type)}/${encodeURIComponent(id)}`);
    if (ext) url.searchParams.set("ext", ext);
    return url.toString();
}

async function fetchJson(url) {
    const response = await fetch(url, {
        headers: {
            "Accept": "application/json,text/plain,*/*",
            "User-Agent": "Mozilla/5.0 StreamXSecurePro/2.0"
        }
    });

    if (!response.ok) {
        throw new Error(`Provider returned HTTP ${response.status}`);
    }

    return response.json();
}

app.post("/api/login", async (req, res) => {
    try {
        const { username, password } = req.body || {};

        if (username !== CONFIG.gateUser || password !== CONFIG.gatePass) {
            return res.status(401).json({
                ok: false,
                message: "Invalid gate credentials"
            });
        }

        const data = await fetchJson(buildApiUrl());

        const authed =
            data &&
            data.user_info &&
            String(data.user_info.auth) === "1";

        if (!authed) {
            return res.status(502).json({
                ok: false,
                message: "IPTV provider rejected credentials"
            });
        }

        const status = String(data.user_info.status || "Active").toLowerCase();

        if (status !== "active") {
            return res.status(403).json({
                ok: false,
                message: `IPTV account status: ${data.user_info.status}`
            });
        }

        return res.json({
            ok: true,
            userInfo: {
                status: data.user_info.status,
                expDate: data.user_info.exp_date || null,
                maxConnections: data.user_info.max_connections || null,
                activeConnections: data.user_info.active_cons || null
            }
        });
    } catch (error) {
        console.error("Login error:", error);
        return res.status(500).json({
            ok: false,
            message: "Could not connect to IPTV provider"
        });
    }
});

app.get("/api/categories/:type", async (req, res) => {
    try {
        const type = req.params.type;

        const actionMap = {
            live: "get_live_categories",
            movie: "get_vod_categories",
            series: "get_series_categories"
        };

        const action = actionMap[type];

        if (!action) {
            return res.status(400).json({ ok: false, message: "Invalid category type" });
        }

        const data = await fetchJson(buildApiUrl(action));
        res.json({ ok: true, data: Array.isArray(data) ? data : [] });
    } catch (error) {
        console.error("Categories error:", error);
        res.status(500).json({ ok: false, message: "Could not load categories" });
    }
});

app.get("/api/list/:type", async (req, res) => {
    try {
        const type = req.params.type;

        const actionMap = {
            live: "get_live_streams",
            movie: "get_vod_streams",
            series: "get_series"
        };

        const action = actionMap[type];

        if (!action) {
            return res.status(400).json({ ok: false, message: "Invalid list type" });
        }

        const data = await fetchJson(buildApiUrl(action));
        res.json({ ok: true, data: Array.isArray(data) ? data : [] });
    } catch (error) {
        console.error("List error:", error);
        res.status(500).json({ ok: false, message: "Could not load list" });
    }
});

app.get("/api/info/movie/:id", async (req, res) => {
    try {
        const data = await fetchJson(buildApiUrl("get_vod_info", {
            vod_id: req.params.id
        }));

        res.json({ ok: true, data });
    } catch (error) {
        console.error("Movie info error:", error);
        res.status(500).json({ ok: false, message: "Could not load movie info" });
    }
});

app.get("/api/info/series/:id", async (req, res) => {
    try {
        const data = await fetchJson(buildApiUrl("get_series_info", {
            series_id: req.params.id
        }));

        res.json({ ok: true, data });
    } catch (error) {
        console.error("Series info error:", error);
        res.status(500).json({ ok: false, message: "Could not load series info" });
    }
});

app.get("/api/link/:type/:id", (req, res) => {
    try {
        const type = req.params.type;
        const id = req.params.id;
        const ext = req.query.ext || "mp4";

        const rawUrl = buildRawStreamUrl(type, id, ext);
        const proxiedUrl = getClientStreamUrl(req, type, id, ext);

        res.json({
            ok: true,
            rawUrl,
            proxiedUrl
        });
    } catch (error) {
        res.status(400).json({
            ok: false,
            message: error.message
        });
    }
});

app.get("/api/stream/:type/:id", async (req, res) => {
    try {
        const type = req.params.type;
        const id = req.params.id;
        const ext = req.query.ext || "mp4";

        const rawUrl = buildRawStreamUrl(type, id, ext);

        const range = req.headers.range;

        const headers = {
            "User-Agent": "Mozilla/5.0 StreamXSecurePro/2.0",
            "Accept": "*/*"
        };

        if (range) {
            headers.Range = range;
        }

        const upstream = await fetch(rawUrl, {
            headers,
            redirect: "follow"
        });

        if (!upstream.ok && upstream.status !== 206) {
            return res.status(upstream.status).send(`Stream error: HTTP ${upstream.status}`);
        }

        const contentType =
            upstream.headers.get("content-type") ||
            (type === "live" ? "application/vnd.apple.mpegurl" : "video/mp4");

        res.status(upstream.status);
        res.setHeader("Content-Type", contentType);
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Accept-Ranges", upstream.headers.get("accept-ranges") || "bytes");

        const contentLength = upstream.headers.get("content-length");
        if (contentLength) {
            res.setHeader("Content-Length", contentLength);
        }

        const contentRange = upstream.headers.get("content-range");
        if (contentRange) {
            res.setHeader("Content-Range", contentRange);
        }

        await pipeline(upstream.body, res);
    } catch (error) {
        console.error("Stream proxy error:", error);
        if (!res.headersSent) {
            res.status(500).send("Stream proxy error");
        }
    }
});

app.get("*", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
    console.log(`StreamX Secure Pro running on http://localhost:${PORT}`);
});
