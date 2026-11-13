/* Service worker: lets the app open without signal.
   - App files: saved on install. The page itself is fetched fresh when there is signal,
     and falls back to the saved copy after 3 seconds or when offline.
   - Fonts: saved on install.
   - Map tiles: only tiles the user has actually viewed are kept, for 7 days. Nothing is
     downloaded ahead of time, because the OpenStreetMap tile policy forbids prefetching. */
"use strict";

var SHELL = "rome-shell-v1", FONTS = "rome-fonts-v1", TILES = "rome-tiles-v1";
var FILES = ["index.html", "vendor/leaflet/leaflet.css", "vendor/leaflet/leaflet.js", "vendor/protomaps-leaflet/protomaps-leaflet.js",
             "manifest.webmanifest", "icons/icon-192.png", "icons/icon-180.png", "phrases.json", "menu.json", "place-tags.json", "how-rome-works.json", "bus-81.json", "taxi.json"];
var FONT_CSS = "https://fonts.googleapis.com/css2?family=Marcellus&family=Schibsted+Grotesk:wght@400;500;600;700&display=swap";
var WEEK = 7 * 24 * 60 * 60 * 1000, MAX_TILES = 2500, PAGE_WAIT = 3000;

function saveFonts() {
  return caches.open(FONTS).then(function (cache) {
    return fetch(FONT_CSS, { mode: "cors" }).then(function (res) {
      if (!res.ok) return;
      return res.clone().text().then(function (css) {
        var urls = (css.match(/https:\/\/fonts\.gstatic\.com\/[^)'"\s]+/g) || []).filter(function (u, i, a) { return a.indexOf(u) === i; });
        return Promise.all([cache.put(FONT_CSS, res)].concat(urls.map(function (u) {
          return fetch(u, { mode: "cors" }).then(function (r) { if (r.ok) return cache.put(u, r); }).catch(function () {});
        })));
      });
    });
  }).catch(function () {});   // fonts are optional: the page has system fallbacks
}

/* the offline map of central Rome: one 8.5 MB file. Optional, so a failed download never blocks the install. */
var MAPFILE = "rome.pmtiles";
function saveMap() {
  return caches.open(SHELL).then(function (c) {
    return c.match(MAPFILE).then(function (hit) {
      if (hit) return;
      return fetch(new Request(MAPFILE, { cache: "reload" })).then(function (res) { if (res.ok && res.status === 200) return c.put(MAPFILE, res); });
    });
  }).catch(function () {});
}
/* the map library asks for byte ranges of that file; answer them from the saved copy */
function mapRange(e) {
  return caches.open(SHELL).then(function (cache) {
    return cache.match(MAPFILE).then(function (hit) {
      if (!hit) { e.waitUntil(saveMap()); return fetch(e.request); }
      var r = /bytes=(\d+)-(\d*)/.exec(e.request.headers.get("range") || "");
      if (!r) return hit;
      return hit.blob().then(function (b) {
        var from = +r[1], to = r[2] ? Math.min(+r[2], b.size - 1) : b.size - 1;
        return new Response(b.slice(from, to + 1), { status: 206, headers: {
          "Content-Type": "application/octet-stream", "Accept-Ranges": "bytes",
          "Content-Range": "bytes " + from + "-" + to + "/" + b.size, "Content-Length": String(to - from + 1) } });
      });
    });
  });
}

self.addEventListener("install", function (e) {
  e.waitUntil(Promise.all([
    caches.open(SHELL).then(function (c) { return c.addAll(FILES.map(function (f) { return new Request(f, { cache: "reload" }); })); }),
    saveFonts(),
    saveMap()
  ]).then(function () { return self.skipWaiting(); }));
});

self.addEventListener("activate", function (e) {
  var keep = [SHELL, FONTS, TILES];
  e.waitUntil(caches.keys().then(function (names) {
    return Promise.all(names.map(function (n) { if (n.indexOf("rome-") === 0 && keep.indexOf(n) < 0) return caches.delete(n); }));
  }).then(function () { return self.clients.claim(); }));
});

/* the page: network first, saved copy if the network is slow or absent */
function page(e) {
  return caches.open(SHELL).then(function (cache) {
    return new Promise(function (resolve) {
      var done = false;
      function finish(r) { if (!done && r) { done = true; resolve(r); } }
      var timer = setTimeout(function () { cache.match("index.html").then(finish); }, PAGE_WAIT);
      fetch(e.request).then(function (res) {
        clearTimeout(timer);
        if (res.ok) e.waitUntil(cache.put("index.html", res.clone()));
        finish(res);
      }).catch(function () {
        clearTimeout(timer);
        cache.match("index.html").then(function (hit) { finish(hit || Response.error()); });
      });
    });
  });
}

/* data files: fresh copy when there is signal, saved copy otherwise */
function fresh(e) {
  return caches.open(SHELL).then(function (cache) {
    return fetch(e.request).then(function (res) {
      if (res.ok) e.waitUntil(cache.put(e.request, res.clone()));
      return res;
    }).catch(function () {
      return cache.match(e.request, { ignoreSearch: true }).then(function (hit) { return hit || Response.error(); });
    });
  });
}

/* saved copy first, otherwise fetch and keep */
function cacheFirst(e, name) {
  return caches.open(name).then(function (cache) {
    return cache.match(e.request).then(function (hit) {
      return hit || fetch(e.request).then(function (res) {
        if (res.ok) e.waitUntil(cache.put(e.request, res.clone()));
        return res;
      });
    });
  });
}

/* map tiles: reuse a viewed tile for 7 days, then ask for it again */
function tile(e) {
  var url = e.request.url;
  return caches.open(TILES).then(function (cache) {
    return cache.match(url).then(function (hit) {
      if (hit && Date.now() - (+hit.headers.get("x-saved") || 0) < WEEK) return hit;
      return fetch(e.request).then(function (res) {
        if (res.ok) {
          var copy = res.clone();
          e.waitUntil(copy.blob().then(function (body) {
            var h = new Headers(copy.headers); h.set("x-saved", String(Date.now()));
            return cache.put(url, new Response(body, { status: 200, headers: h }));
          }).then(function () { if (Math.random() < 0.05) return trim(cache); }).catch(function () {}));
        }
        return res;
      }).catch(function () { return hit || Response.error(); });   // offline: an old tile beats none
    });
  });
}
function trim(cache) {
  return cache.keys().then(function (keys) {
    if (keys.length <= MAX_TILES) return;
    return Promise.all(keys.slice(0, keys.length - MAX_TILES + 200).map(function (k) { return cache.delete(k); }));
  });
}

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;
  var url = new URL(req.url);
  if (url.hostname === "tile.openstreetmap.org") { e.respondWith(tile(e)); return; }
  if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") { e.respondWith(cacheFirst(e, FONTS)); return; }
  if (url.origin !== self.location.origin) return;
  if (req.mode === "navigate") { e.respondWith(page(e)); return; }
  if (/\.pmtiles$/.test(url.pathname)) { e.respondWith(mapRange(e)); return; }
  if (/\.json$/.test(url.pathname)) { e.respondWith(fresh(e)); return; }
  e.respondWith(cacheFirst(e, SHELL));
});
