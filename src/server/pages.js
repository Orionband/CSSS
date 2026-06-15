const path = require("path");

const express = require("express");

const LEGACY_HTML_REDIRECTS = {
  "index.html": "/",

  "challenges.html": "/challenges",

  "history.html": "/history",

  "leaderboard.html": "/leaderboard",

  "leaderboard-user.html": "/leaderboard/user",

  "lab.html": "/lab",

  "quiz.html": "/quiz",

  "admin.html": "/admin",
};

const PAGE_SHELL_FILES = new Set(Object.keys(LEGACY_HTML_REDIRECTS));

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

function mountPages(app, db, publicDir) {
  const sendPage = (filename) => (req, res) => {
    if (req.session?.userId) {
      res.setHeader(
        "Cache-Control",
        "no-store, no-cache, must-revalidate, proxy-revalidate",
      );

      res.setHeader("Pragma", "no-cache");

      res.setHeader("Expires", "0");
    }

    res.sendFile(path.join(publicDir, filename));
  };

  app.get("/", sendPage("index.html"));

  app.get("/challenges", sendPage("challenges.html"));

  app.get("/history", sendPage("history.html"));

  app.get("/leaderboard", sendPage("leaderboard.html"));

  app.get("/leaderboard/user", sendPage("leaderboard-user.html"));

  app.get("/lab", sendPage("lab.html"));

  app.get("/quiz", sendPage("quiz.html"));

  app.get("/admin", (req, res) => {
    if (!req.session?.userId) {
      return res.redirect("/");
    }

    const user = db
      .prepare("SELECT is_admin, password_changed_at FROM users WHERE id = ?")
      .get(req.session.userId);

    if (!user) {
      req.session.destroy(() => {
        res.clearCookie("connect.sid");
      });

      return res.redirect("/");
    }

    if (
      user.password_changed_at &&
      (!req.session.authenticatedAt ||
        req.session.authenticatedAt < user.password_changed_at)
    ) {
      req.session.destroy(() => {
        res.clearCookie("connect.sid");
      });

      return res.redirect("/");
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

    res.sendFile(path.join(publicDir, "admin.html"));
  });

  app.use((req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();

    const filename = legacyHtmlFilename(req.path);

    if (!filename) return next();

    const target = LEGACY_HTML_REDIRECTS[filename];

    if (!target) return next();

    const search = req.url.includes("?")
      ? req.url.slice(req.url.indexOf("?"))
      : "";

    res.redirect(301, target + search);
  });

  app.use((req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();

    const base = path.basename(safeDecodePath(req.path)).toLowerCase();

    if (PAGE_SHELL_FILES.has(base)) return res.status(404).end();

    next();
  });

  app.use(express.static(publicDir));
}

module.exports = { mountPages };
