const path = require("path");

const fs = require("fs");

const express = require("express");

const { isHomepageEnabled } = require("../config");

const LEGACY_HTML_REDIRECTS_BASE = {
  "index.html": "/",

  "challenges.html": "/challenges",

  "history.html": "/history",

  "leaderboard.html": "/leaderboard",

  "leaderboard-user.html": "/leaderboard/user",

  "lab.html": "/lab",

  "quiz.html": "/quiz",

  "admin.html": "/admin",
};

const PAGE_SHELL_FILES = new Set(Object.keys(LEGACY_HTML_REDIRECTS_BASE));

function safeDecodePath(rawPath) {
  try {
    return decodeURIComponent(rawPath);
  } catch {
    return rawPath;
  }
}

function legacyHtmlFilename(reqPath) {
  const decoded = safeDecodePath(reqPath);

  const match = decoded.match(/^\/([^/]+\.html)$/i);

  return match ? match[1].toLowerCase() : null;
}

function getLegacyRedirects(getConfig) {
  const redirects = { ...LEGACY_HTML_REDIRECTS_BASE };
  if (isHomepageEnabled(getConfig())) {
    redirects["index.html"] = "/login";
    redirects["home.html"] = "/";
  }
  return redirects;
}

function loginRedirectPath(getConfig) {
  return isHomepageEnabled(getConfig()) ? "/login" : "/";
}

const NAV_BRAND_RE =
  /<a href="[^"]*" class="nav-brand navElement" id="nav-brand"><\/a>/;

function navBrandHref(getConfig) {
  return isHomepageEnabled(getConfig()) ? "/" : "/challenges";
}

function patchNavBrandHref(html, getConfig) {
  if (!NAV_BRAND_RE.test(html)) return html;
  const href = navBrandHref(getConfig);
  return html.replace(
    NAV_BRAND_RE,
    `<a href="${href}" class="nav-brand navElement" id="nav-brand"></a>`,
  );
}

function getPageHtml(publicDir, filename, getConfig, cache) {
  const cacheKey = `${filename}:${navBrandHref(getConfig)}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  const filePath = path.join(publicDir, filename);
  const html = patchNavBrandHref(
    fs.readFileSync(filePath, "utf8"),
    getConfig,
  );
  cache.set(cacheKey, html);
  return html;
}

function mountPages(app, db, publicDir, getConfig) {
  const pageHtmlCache = new Map();

  const sendPage = (filename) => (req, res) => {
    if (req.session?.userId) {
      res.setHeader(
        "Cache-Control",
        "no-store, no-cache, must-revalidate, proxy-revalidate",
      );

      res.setHeader("Pragma", "no-cache");

      res.setHeader("Expires", "0");
    }

    res.type("html").send(getPageHtml(publicDir, filename, getConfig, pageHtmlCache));
  };

  const homepageOn = () => isHomepageEnabled(getConfig());

  app.get("/", (req, res) => {
    sendPage(homepageOn() ? "home.html" : "index.html")(req, res);
  });

  app.get("/login", (req, res) => {
    if (!homepageOn()) return res.redirect(302, "/");
    sendPage("index.html")(req, res);
  });

  app.get("/challenges", sendPage("challenges.html"));

  app.get("/history", sendPage("history.html"));

  app.get("/leaderboard", sendPage("leaderboard.html"));

  app.get("/leaderboard/user", sendPage("leaderboard-user.html"));

  app.get("/lab", sendPage("lab.html"));

  app.get("/quiz", sendPage("quiz.html"));

  app.get("/admin", (req, res) => {
    const authRedirect = loginRedirectPath(getConfig);

    if (!req.session?.userId) {
      return res.redirect(authRedirect);
    }

    const user = db
      .prepare("SELECT is_admin, password_changed_at FROM users WHERE id = ?")
      .get(req.session.userId);

    if (!user) {
      req.session.destroy(() => {
        res.clearCookie("connect.sid");
      });

      return res.redirect(authRedirect);
    }

    if (
      user.password_changed_at &&
      (!req.session.authenticatedAt ||
        req.session.authenticatedAt < user.password_changed_at)
    ) {
      req.session.destroy(() => {
        res.clearCookie("connect.sid");
      });

      return res.redirect(authRedirect);
    }

    if (user.is_admin !== 1) {
      return res.redirect("/challenges");
    }

    res.setHeader(
      "Cache-Control",
      "no-store, no-cache, must-revalidate, proxy-revalidate",
    );

    res.setHeader("Pragma", "no-cache");

    res.setHeader("Expires", "0");

    res
      .type("html")
      .send(getPageHtml(publicDir, "admin.html", getConfig, pageHtmlCache));
  });

  app.use((req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();

    const filename = legacyHtmlFilename(req.path);

    if (!filename) return next();

    const target = getLegacyRedirects(getConfig)[filename];

    if (!target) return next();

    const search = req.url.includes("?")
      ? req.url.slice(req.url.indexOf("?"))
      : "";

    res.redirect(301, target + search);
  });

  app.use((req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();

    const base = path.basename(safeDecodePath(req.path)).toLowerCase();

    const shellFiles = new Set(PAGE_SHELL_FILES);
    if (homepageOn()) shellFiles.add("home.html");

    if (shellFiles.has(base)) return res.status(404).end();

    next();
  });

  app.use(express.static(publicDir));
}

module.exports = { mountPages };
