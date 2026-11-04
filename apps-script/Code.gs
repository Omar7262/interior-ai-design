/**
 * Interior AI Design - newsletter signup backend.
 *
 * HOW TO USE
 *   1. Paste this whole file into the Apps Script editor (replace everything).
 *   2. Deploy > New deployment > gear > Web app
 *        Execute as:      Me
 *        Who has access:  Anyone
 *   3. Click Deploy, approve the permissions Google asks for.
 *   4. Copy the /exec URL and send it to whoever updates the website.
 *
 * No configuration needed. The first signup creates a spreadsheet called
 * "Interior AI Design Signups" in your Drive, and every signup also emails you.
 */

var BOOK_NAME = "Interior AI Design Signups";
var SHEET_NAME = "Sheet1";
var HEADERS = ["Email", "Valid", "Reason", "Page", "Referrer", "Time"];
var PROP_KEY = "SIGNUP_SHEET_ID";

function doGet(e) {
  var p = (e && e.parameter) || {};
  var action = String(p.action || "").toLowerCase();

  try {
    if (action === "reviews") return json_({ ok: true, count: 0, average: 0 });

    if (action === "status") {
      var sh = sheet_();
      return json_({ ok: true, rows: Math.max(0, sh.getLastRow() - 1) });
    }

    if (action === "validate") {
      return json_({
        ok: true,
        domain: String(p.domain || ""),
        disposable: false,
        reason: "",
      });
    }

    return json_({ ok: true, message: "Signup endpoint is live." });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

function doPost(e) {
  try {
    var d = JSON.parse((e && e.postData && e.postData.contents) || "{}");
    return json_(saveSignup_(d));
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

function saveSignup_(d) {
  var email = String(d.email || "").trim().toLowerCase();
  if (!email || email.indexOf("@") < 1) return { ok: false, error: "no email" };

  var sheet = sheet_();
  var last = sheet.getLastRow();

  if (last > 1) {
    var values = sheet.getRange(2, 1, last - 1, 1).getValues();
    for (var i = 0; i < values.length; i++) {
      if (String(values[i][0]).trim().toLowerCase() === email) {
        return { ok: true, duplicate: true };
      }
    }
  }

  sheet.appendRow([
    email,
    d.valid ? "TRUE" : "FALSE",
    String(d.reason || ""),
    String(d.page || ""),
    String(d.referrer || ""),
    new Date(),
  ]);

  notify_(email, String(d.reason || ""));
  return { ok: true };
}

/** Emails the owner of this script about every new signup. */
function notify_(email, reason) {
  var to = "";
  try {
    to = Session.getEffectiveUser().getEmail();
  } catch (err) {}

  if (!to) return;
  try {
    MailApp.sendEmail(
      to,
      "New signup: " + email,
      "Email: " + email + (reason ? "\nFlagged: " + reason : "") + "\nTime: " + new Date()
    );
  } catch (err) {
    // A mail quota problem must never lose the signup.
  }
}

/** Returns the signup sheet, creating it on first use. */
function sheet_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty(PROP_KEY);
  var ss = null;

  if (id) {
    try {
      ss = SpreadsheetApp.openById(id);
    } catch (err) {
      ss = null;
    }
  }

  if (!ss) {
    ss = SpreadsheetApp.create(BOOK_NAME);
    props.setProperty(PROP_KEY, ss.getId());
  }

  var sheet = ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
  }
  return sheet;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON
  );
}
