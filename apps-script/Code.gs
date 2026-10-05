/**
 * Interior AI Design - newsletter signup + reviews backend.
 *
 * Deploy as a Web App, execute as you, and access for "Anyone".
 * The deployment URL is what CONFIG.sheetEndpoint points at in script.js.
 *
 * Endpoints
 *   GET  ?action=validate&domain=gmial.com
 *        -> {ok, disposable, reason}
 *   GET  ?action=reviews
 *        -> {ok, count, average}
 *   POST {type: "signup" | "review", ...}
 *        -> {ok: true}
 *
 * Disposable/spam domain data comes from an open-source, key-free API:
 *   https://disposable-emails-detector.vegastack.com/api/check.json
 * It is fetched here on the server so the browser never downloads the ~3.2MB
 * list, and the visitor's address is never sent to that third party.
 */

var SHEET_ID = "13DqWeIXO-cF_drix8vIVR8ohh1gLHTD4H_XWSQ1KmU0";
var NOTIFY_EMAIL = "ghostfreak3344@gmail.com";

var DISPOSABLE_API = "https://disposable-emails-detector.vegastack.com/api/check.json";
var DISPOSABLE_TTL_SECONDS = 21600; // 6h; upstream refreshes daily
var VERDICT_TTL_SECONDS = 86400; // 24h per-domain verdict
var LIST_CACHE_KEY = "disposable_list_v1";

/** Columns for the signups sheet. */
var SIGNUP_HEADERS = ["Email", "Valid", "Reason", "Page", "Referrer", "Time"];
var EMAIL_COL = 1;
var VALID_COL = 2;
var REASON_COL = 3;

/** Columns for the reviews sheet. Rating is column C (index 2). */
var REVIEW_HEADERS = ["Submitted", "Name", "Rating", "Review", "Page", "Referrer"];
var REVIEW_RATING_INDEX = 2;

function doGet(e) {
  try {
    var p = e && e.parameter ? e.parameter : {};
    var action = String(p.action || "").toLowerCase();

    if (action === "validate") return jsonOut(validateDomain_(p.domain));
    if (action === "reviews") return jsonOut(reviewsSummary_());

    return jsonOut({ ok: false, error: "unknown action" });
  } catch (err) {
    // Always answer with JSON so the frontend's res.json() never sees an HTML
    // error page, which is what silently broke the review count before.
    return jsonOut({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

function doPost(e) {
  try {
    var d = JSON.parse((e && e.postData && e.postData.contents) || "{}");
    var type = String(d.type || "signup").toLowerCase();

    if (type === "review") return jsonOut(saveReview_(d));
    return jsonOut(saveSignup_(d));
  } catch (err) {
    return jsonOut({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON
  );
}

// ---------------------------------------------------------------- disposable

/**
 * Caches the whole list as a flat newline string rather than parsed JSON.
 * Apps Script holds big objects awkwardly, but a single string is cheap, and
 * newline scanning avoids building a 125k-key object on every cold start.
 */
function disposableList_() {
  var cache = CacheService.getScriptCache();

  // Read the chunks back. The chunk count lives in its own key, and a missing or
  // truncated chunk invalidates the whole thing rather than silently returning a
  // short list that would mark good domains as clean.
  var count = parseInt(cache.get(LIST_CACHE_KEY + "_n"), 10);
  if (!isNaN(count) && count > 0) {
    var parts = [];
    var complete = true;
    for (var c = 0; c < count; c++) {
      var part = cache.get(LIST_CACHE_KEY + "_" + c);
      if (part === null) { complete = false; break; }
      parts.push(part);
    }
    if (complete) return parts.join("");
  }

  var res = UrlFetchApp.fetch(DISPOSABLE_API, {
    muteHttpExceptions: true,
    followRedirects: true,
  });

  if (res.getResponseCode() !== 200) throw new Error("disposable list HTTP " + res.getResponseCode());

  var domains = JSON.parse(res.getContentText()).domains || {};
  var list = Object.keys(domains).join("\n");

  // CacheService caps a single entry near 100KB, so store in chunks.
  var CHUNK = 90000;
  var chunks = Math.ceil(list.length / CHUNK);
  for (var i = 0; i < chunks; i++) {
    cache.put(LIST_CACHE_KEY + "_" + i, list.substr(i * CHUNK, CHUNK), DISPOSABLE_TTL_SECONDS);
  }
  // The count is written last so a chunk that never landed leaves _n unset,
  // which the reader above treats as a miss.
  cache.put(LIST_CACHE_KEY + "_n", String(chunks), DISPOSABLE_TTL_SECONDS);

  return list;
}

function isDisposable_(domain) {
  var d = String(domain || "").trim().toLowerCase();
  if (!d) return false;

  var cache = CacheService.getScriptCache();
  var memoKey = "disp:" + d;
  var memo = cache.get(memoKey);
  if (memo !== null) return memo === "1";

  var list = disposableList_();
  var hay = "\n" + list + "\n";

  // Match the domain itself and every parent, so user@mail.mailinator.com is
  // caught even when only the parent is listed.
  var parts = d.split(".");
  var disposable = false;
  for (var i = 0; i < parts.length - 1; i++) {
    if (hay.indexOf("\n" + parts.slice(i).join(".") + "\n") !== -1) {
      disposable = true;
      break;
    }
  }

  cache.put(memoKey, disposable ? "1" : "0", VERDICT_TTL_SECONDS);
  return disposable;
}

function validateDomain_(domain) {
  var d = String(domain || "").trim().toLowerCase();

  if (!d || d.indexOf("@") !== -1 || d.indexOf("/") !== -1) {
    return { ok: false, error: "bad domain" };
  }

  try {
    return { ok: true, domain: d, disposable: isDisposable_(d), reason: "" };
  } catch (err) {
    // Fails open: the frontend treats a missing verdict as "no opinion".
    return { ok: false, domain: d, disposable: false, error: String(err) };
  }
}

// -------------------------------------------------------------------- signup

function saveSignup_(d) {
  var email = String(d.email || "").trim().toLowerCase();
  if (!email || email.indexOf("@") === -1) return { ok: false, error: "no email" };

  var reason = String(d.reason || "");

  // The browser already flags these, but re-checking server side keeps the
  // sheet trustworthy even if someone posts straight to the endpoint.
  if (!reason) {
    try {
      if (isDisposable_(email.split("@").pop())) reason = "disposable";
    } catch (err) {
      // Never fail a signup because the lookup is down.
    }
  }

  var sheet = sheetOrCreate_("Sheet1");
  ensureHeader_(sheet, SIGNUP_HEADERS);

  var last = sheet.getLastRow();
  if (last > 1) {
    var existing = sheet.getRange(2, EMAIL_COL, last - 1, 1).getValues();
    for (var i = 0; i < existing.length; i++) {
      if (String(existing[i][0]).trim().toLowerCase() === email) {
        return { ok: true, duplicate: true };
      }
    }
  }

  sheet.appendRow([
    email,
    d.valid ? "TRUE" : "FALSE",
    reason,
    String(d.page || ""),
    String(d.referrer || ""),
    new Date(),
  ]);

  if (NOTIFY_EMAIL) {
    try {
      MailApp.sendEmail({
        to: NOTIFY_EMAIL,
        subject: "New signup" + (reason ? " (" + reason + ")" : ""),
        body: email + (reason ? "\nFlagged: " + reason : ""),
      });
    } catch (err) {
      // A full MailApp quota must never lose the signup.
    }
  }

  return { ok: true };
}

// ------------------------------------------------------------------- reviews

function saveReview_(d) {
  var text = String(d.review || "").trim();
  var rating = Number(d.rating);
  if (!text) return { ok: false, error: "empty review" };
  if (!(rating >= 1 && rating <= 5)) return { ok: false, error: "bad rating" };

  var sheet = sheetOrCreate_("Reviews");
  ensureHeader_(sheet, REVIEW_HEADERS);

  sheet.appendRow([
    new Date(),
    String(d.name || "").slice(0, 40),
    rating,
    text.slice(0, 400),
    String(d.page || ""),
    String(d.referrer || ""),
  ]);

  return { ok: true };
}

/**
 * Count and average of every real review row. Rating lives in column C
 * (REVIEW_RATING_INDEX), not column B - reading B returns the name column and
 * silently yields a count of zero.
 */
function reviewsSummary_() {
  var sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName("Reviews");
  if (!sheet) return { ok: true, count: 0, average: 0 };

  var last = sheet.getLastRow();
  if (last < 2) return { ok: true, count: 0, average: 0 };

  // Filter on the raw cell value. `Array.isArray` returns false for arrays that
  // originate inside the Apps Script sandbox, so a plain loop is used instead.
  var ratings = [];
  var rows = sheet.getRange(2, REVIEW_RATING_INDEX + 1, last - 1, 1).getValues();
  for (var i = 0; i < rows.length; i++) {
    var n = Number(rows[i][0]);
    if (n >= 1 && n <= 5) ratings.push(n);
  }

  if (!ratings.length) return { ok: true, count: 0, average: 0 };

  var sum = ratings.reduce(function (a, b) { return a + b; }, 0);
  return {
    ok: true,
    count: ratings.length,
    average: Math.round((sum / ratings.length) * 10) / 10,
  };
}

// -------------------------------------------------------------------- shared

/**
 * Returns a sheet by name, creating it if this deployment has never been set up
 * yet. Without this a fresh script throws on `getSheetByName` returning null and
 * the visitor loses the signup entirely.
 */
function sheetOrCreate_(name) {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

function ensureHeader_(sheet, headers) {
  if (sheet.getLastRow() === 0) sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
}

function setup() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  ensureHeader_(ss.getSheetByName("Sheet1") || ss.insertSheet("Sheet1"), SIGNUP_HEADERS);
  ensureHeader_(ss.getSheetByName("Reviews") || ss.insertSheet("Reviews"), REVIEW_HEADERS);
  disposableList_(); // warm the cache
}
