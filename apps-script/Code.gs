/**
 * Interior AI Design - newsletter signup + reviews backend.
 *
 * Deploy as a Web App, execute as you, and access for "Anyone".
 * The deployment URL is what CONFIG.sheetEndpoint points at in script.js.
 *
 * Endpoints
 *   GET  ?action=validate&domain=gmial.com
 *        -> {ok, disposable, reason}
 *   GET  ?action=verify&email=a@b.com
 *        -> {ok, configured, verdict, block, reason, suggestion}
 *   GET  ?action=reviews
 *        -> {ok, count, average}
 *   POST {type: "signup" | "review", ...}
 *        -> {ok: true}
 *
 * Mailbox existence comes from ZeroBounce (real-time SMTP verification):
 *   https://api.zerobounce.net/v2/validate
 * The key is read from the script property VERIFY_API_KEY and is never stored in
 * this file. With no key set the script still runs on the free open-source
 * disposable list alone, so nothing breaks before you set one up.
 *
 * That open-source list comes from an open-source, key-free API:
 *   https://disposable-emails-detector.vegastack.com/api/check.json
 * It is fetched here on the server so the browser never downloads the ~3.2MB
 * list. Note the address IS sent to ZeroBounce when a key is configured; that is
 * unavoidable for SMTP verification and is why it happens server side only.
 */

var SHEET_ID = "13DqWeIXO-cF_drix8vIVR8ohh1gLHTD4H_XWSQ1KmU0";
var NOTIFY_EMAIL = "ghostfreak3344@gmail.com";

var DISPOSABLE_API = "https://disposable-emails-detector.vegastack.com/api/check.json";
var DISPOSABLE_TTL_SECONDS = 21600; // 6h; upstream refreshes daily
var VERDICT_TTL_SECONDS = 86400; // 24h per-domain verdict
var LIST_CACHE_KEY = "disposable_list_v1";

/**
 * ZeroBounce real-time mailbox verification. Set the key here (or run
 * setVerifyKey_("...") once) rather than pasting it into source control.
 */
var VERIFY_API = "https://api.zerobounce.net/v2/validate";
var VERIFY_KEY_PROPERTY = "VERIFY_API_KEY";
var VERIFY_CACHE_TTL_SECONDS = 21600; // Apps Script caps CacheService at 6h
var VERIFY_CACHE_PREFIX = "verify:";

/** Columns for the signups sheet. */
var SIGNUP_HEADERS = ["Email", "Valid", "Reason", "Page", "Referrer", "Time", "Verified"];
var EMAIL_COL = 1;
var VALID_COL = 2;
var REASON_COL = 3;
var VERIFIED_COL = 7;

/**
 * Statuses that mean "this mailbox is junk, do not accept the signup".
 * Everything else - including catch-all and unknown, which are genuinely
 * undecidable against Gmail/Outlook - is allowed through and only noted.
 */
var VERIFY_BLOCKING_STATUSES = ["invalid", "spamtrap", "abuse", "do_not_mail"];

/** Sets the ZeroBounce key in script properties instead of in source. */
function setVerifyKey_(key) {
  PropertiesService.getScriptProperties().setProperty(VERIFY_KEY_PROPERTY, String(key || "").trim());
}

function verifyApiKey_() {
  try {
    return String(PropertiesService.getScriptProperties().getProperty(VERIFY_KEY_PROPERTY) || "").trim();
  } catch (err) {
    return "";
  }
}

/** Columns for the reviews sheet. Rating is column C (index 2). */
var REVIEW_HEADERS = ["Submitted", "Name", "Rating", "Review", "Page", "Referrer"];
var REVIEW_RATING_INDEX = 2;

function doGet(e) {
  try {
    var p = e && e.parameter ? e.parameter : {};
    var action = String(p.action || "").toLowerCase();

    if (action === "validate") return jsonOut(validateDomain_(p.domain));
    if (action === "verify") return jsonOut(verifyEmail_(p.email));
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

// -------------------------------------------------------- mailbox verification

/**
 * Cached, deduplicated ZeroBounce lookup for one address.
 *
 * The cache matters for money, not just speed: the frontend warms this on blur
 * and then the POST re-verifies, so without a cache hit the same address would
 * burn two credits per signup.
 *
 * Any failure resolves to "not blocking" rather than throwing, so an expired
 * plan, a rate limit or a network blip can never reject a genuine signup.
 */
function verifyEmail_(raw) {
  var email = String(raw || "").trim().toLowerCase();
  if (!email || email.indexOf("@") === -1) {
    return { ok: false, configured: false, verdict: "shape", block: false, reason: "bad email" };
  }

  var key = verifyApiKey_();
  if (!key) {
    // No key yet: the disposable list still guards the signup, there is just no
    // mailbox-level opinion. Reported honestly so the UI can stay quiet.
    return { ok: true, configured: false, verdict: "unverified", block: false, reason: "" };
  }

  var cache = CacheService.getScriptCache();
  var cacheKey = VERIFY_CACHE_PREFIX + email;
  var hit = cache.get(cacheKey);
  if (hit) {
    try {
      return JSON.parse(hit);
    } catch (err) {
      cache.remove(cacheKey);
    }
  }

  var verdict;
  try {
    var url =
      VERIFY_API +
      "?api_key=" +
      encodeURIComponent(key) +
      "&email=" +
      encodeURIComponent(email);

    var res = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true,
      followRedirects: true,
    });

    if (res.getResponseCode() !== 200) throw new Error("zerobounce HTTP " + res.getResponseCode());

    var body = JSON.parse(res.getContentText());
    verdict = mapVerifyStatus_(body);
  } catch (err) {
    // Fail open. A dead quota or a provider outage must not cost a real signup.
    return { ok: true, configured: true, verdict: "unverified", block: false, reason: String(err) };
  }

  // "unknown" is never billed by ZeroBounce, so caching it is free and it is the
  // one verdict most likely to change on a retry.
  cache.put(cacheKey, JSON.stringify(verdict), VERIFY_CACHE_TTL_SECONDS);
  return verdict;
}

/** Translates a ZeroBounce v2 response into a decision the signup can act on. */
function mapVerifyStatus_(body) {
  var status = String(body.status || "unknown").toLowerCase();
  var sub = String(body.sub_status || "").toLowerCase();
  var block = VERIFY_BLOCKING_STATUSES.indexOf(status) !== -1;

  // No mail server at all is never acceptable, whatever the status says.
  if (body.mx_found === false) {
    status = "invalid";
    sub = sub || "no_dns_entries";
    block = true;
  }

  // `disposable` arrives as do_not_mail + sub_status disposable, but accept the
  // bare sub_status too in case that ever changes.
  if (sub === "disposable" || sub === "toxic") block = true;

  return {
    ok: true,
    configured: true,
    verdict: status,
    sub: sub,
    block: block,
    // Human-facing reason for the sheet. Empty means "nothing to see".
    reason: block ? sub || status : status === "catch-all" || status === "unknown" ? status : "",
    suggestion: body.did_you_mean ? String(body.did_you_mean) : "",
    catchall: body.catchall_domain === true,
  };
}

// -------------------------------------------------------------------- signup

function saveSignup_(d) {
  var email = String(d.email || "").trim().toLowerCase();
  if (!email || email.indexOf("@") === -1) return { ok: false, error: "no email" };

  var reason = String(d.reason || "");

  // Authoritative gate. The frontend check is a courtesy for the visitor and can
  // be bypassed by posting straight to the endpoint, so the decision that counts
  // is made here. `verifyEmail_` only returns block:true for addresses it is
  // confident about, and never blocks when the provider is unreachable.
  var verified = verifyEmail_(email);
  if (verified && verified.block) {
    return {
      ok: false,
      error: "rejected",
      verdict: verified.verdict,
      reason: verified.reason,
      suggestion: verified.suggestion || "",
    };
  }

  // Catch-all and unknown are recorded rather than hidden, so the list can be
  // reviewed later instead of looking identical to a confirmed mailbox.
  var verdictLabel = verified && verified.configured ? String(verified.verdict || "") : "unverified";
  if (!reason && verified && verified.reason) reason = verified.reason;

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
    verdictLabel,
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

/**
 * Writes the header row on a fresh sheet, and on an existing sheet appends only
 * the headers that are missing. Without the append path a live sheet created
 * before a column was added would silently keep the old layout and the new
 * column's values would land under an unlabelled heading.
 */
function ensureHeader_(sheet, headers) {
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    return;
  }

  var existing = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0] || [];
  var present = {};
  for (var i = 0; i < existing.length; i++) {
    var name = String(existing[i] || "").trim().toLowerCase();
    if (name) present[name] = true;
  }

  var missing = [];
  for (var h = 0; h < headers.length; h++) {
    if (!present[String(headers[h]).trim().toLowerCase()]) missing.push(headers[h]);
  }
  if (!missing.length) return;

  var startCol = existing.length + 1;
  sheet.getRange(1, startCol, 1, missing.length).setValues([missing]);
}

/**
 * One-time setup. Creates both sheets if they do not exist, adds any columns
 * added since the sheet was made, and warms the disposable-list cache.
 *
 * Mailbox verification stays switched off until a key is stored. To enable it,
 * run setVerifyKey_("your-zero-bounce-key") once, then redeploy.
 */
function setup() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  ensureHeader_(ss.getSheetByName("Sheet1") || ss.insertSheet("Sheet1"), SIGNUP_HEADERS);
  ensureHeader_(ss.getSheetByName("Reviews") || ss.insertSheet("Reviews"), REVIEW_HEADERS);
  disposableList_(); // warm the cache

  Logger.log(
    verifyApiKey_()
      ? "Mailbox verification: ON (ZeroBounce)."
      : "Mailbox verification: OFF. Run setVerifyKey_(\"...\") to enable."
  );
}
