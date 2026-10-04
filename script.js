const CONFIG = {
  sheetEndpoint: "https://script.google.com/macros/s/AKfycbw2OQoatuPdpjrywWgLwRg0RAH4Fyfc5pAgefo9F0WmrmS6YA-DVosq1dmT9_kinvVS/exec",
  redirectUrl: "https://homedesigns.ai/",
  redirectAfterSeenMs: 5000,
  countdownSeconds: 5,
  redirectCountdownSeconds: 3,
  fillPollIntervalMs: 250,
  fillPollTicks: 20,
  storageKey: "email_site_signups",
  googleClientId: "",
  dnsEndpoint: "https://cloudflare-dns.com/dns-query",
  dnsTimeoutMs: 3000,
};

// Domains people reach for by misspelling a provider. Mapped to what they
// almost certainly meant. Several of these are registered and do accept mail,
// which is exactly why a DNS check alone cannot catch them.
const TYPO_DOMAINS = {
  "gmial.com": "gmail.com",
  "gmai.com": "gmail.com",
  "gnail.com": "gmail.com",
  "gmil.com": "gmail.com",
  "gmaill.com": "gmail.com",
  "gmails.com": "gmail.com",
  "gmail.co": "gmail.com",
  "gmail.con": "gmail.com",
  "gmail.cm": "gmail.com",
  "hotmial.com": "hotmail.com",
  "hotmai.com": "hotmail.com",
  "hotmil.com": "hotmail.com",
  "hotnail.com": "hotmail.com",
  "hotmail.co": "hotmail.com",
  "hotmail.con": "hotmail.com",
  "yaho.com": "yahoo.com",
  "yhoo.com": "yahoo.com",
  "yahooo.com": "yahoo.com",
  "yahoo.co": "yahoo.com",
  "yahoo.con": "yahoo.com",
  "outlok.com": "outlook.com",
  "outllok.com": "outlook.com",
  "outliook.com": "outlook.com",
  "outlook.co": "outlook.com",
  "outlook.con": "outlook.com",
  "iclod.com": "icloud.com",
  "iclould.com": "icloud.com",
  "aoll.com": "aol.com",
  "liv.com": "live.com",
  "protonmai.com": "protonmail.com",
  "protonmal.com": "protonmail.com",
};

const DISPOSABLE_DOMAINS = new Set([
  "mailinator.com",
  "guerrillamail.com",
  "guerrillamail.net",
  "sharklasers.com",
  "10minutemail.com",
  "10minutemail.net",
  "yopmail.com",
  "tempmail.email",
  "temp-mail.org",
  "tempinbox.com",
  "tmpmail.org",
  "trashmail.com",
  "getnada.com",
  "dispostable.com",
  "throwawaymail.com",
  "maildrop.cc",
  "moakt.com",
  "fakeinbox.com",
  "mailnesia.com",
  "mintemail.com",
  "mytrashmail.com",
  "spamgourmet.com",
  "mailcatch.com",
  "discard.email",
  "mail-temporaire.fr",
  "grr.la",
]);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const form = document.getElementById("signup-form");
const emailInput = document.getElementById("email-input");
const formMsg = document.getElementById("form-message");
const submitBtn = document.getElementById("submit-btn");
const continueLink = document.getElementById("continue-link");
const confirmBar = document.getElementById("confirm-bar");
const foundEmailEl = document.getElementById("found-email");
const confirmSendBtn = document.getElementById("confirm-send");
const confirmChangeBtn = document.getElementById("confirm-change");
const quickPick = document.getElementById("quick-pick");
const pickContactsBtn = document.getElementById("pick-contacts");
const googleSlot = document.getElementById("google-slot");
const googleButton = document.getElementById("google-button");
const alreadyBar = document.getElementById("already-bar");
const alreadyText = document.getElementById("already-text");
const notYouBtn = document.getElementById("not-you");
const fixRow = document.getElementById("fix-row");
const fixBtn = document.getElementById("fix-btn");

let fillSource = null;
let countdownTimer = null;
let fillPollTimer = null;
let fieldFocused = false;
let sending = false;
let sent = false;
let fixSuggestion = null;

function hideFixRow() {
  fixRow.hidden = true;
  fixBtn.textContent = "";
  fixSuggestion = null;
}

function showEmailProblem(email, problem) {
  stopCountdown(true);
  emailInput.classList.add("invalid");

  if (problem.reason === "typo") {
    fixSuggestion = email.split("@")[0] + "@" + problem.suggestion;
    fixBtn.textContent = "Use " + fixSuggestion + " instead";
    fixRow.hidden = false;
    setMsg(problem.domain + " looks like a typo of " + problem.suggestion + ".", "bad");
    return;
  }

  hideFixRow();

  if (problem.reason === "disposable") {
    setMsg("That is a throwaway inbox. Please use an address you can read.", "bad");
  } else if (problem.reason === "nomail") {
    setMsg(problem.domain + " cannot receive email. Please check the address.", "bad");
  } else {
    setMsg("Please enter a valid email first.", "bad");
  }
}

fixBtn.addEventListener("click", () => {
  if (!fixSuggestion) return;

  emailInput.value = fixSuggestion;
  fillSource = "typed";
  fieldFocused = true;
  emailInput.classList.remove("invalid");
  hideFixRow();
  setMsg("Check it looks right, then it sends.", "");
  startCountdown();
});

const RESERVED_EMAIL_DOMAINS = new Set([
  "example",
  "example.com",
  "example.net",
  "example.org",
  "invalid",
  "local",
  "localhost",
  "test",
]);

function isReservedEmailDomain(email) {
  const parts = String(email).trim().toLowerCase().split("@");
  if (parts.length !== 2) return false;
  return RESERVED_EMAIL_DOMAINS.has(parts[1]);
}

function isValidEmail(email) {
  if (email === "" || !EMAIL_RE.test(email)) return false;
  return !isReservedEmailDomain(email);
}

function domainOf(email) {
  const parts = String(email).trim().toLowerCase().split("@");
  return parts.length === 2 ? parts[1] : null;
}

// Problems we can decide without leaving the browser, so they can block the
// countdown immediately instead of making someone wait on a network round trip.
function localEmailProblem(email) {
  const domain = domainOf(email);
  if (!domain) return { reason: "shape" };

  if (TYPO_DOMAINS[domain]) {
    return { reason: "typo", domain, suggestion: TYPO_DOMAINS[domain] };
  }

  if (DISPOSABLE_DOMAINS.has(domain)) {
    return { reason: "disposable", domain };
  }

  return null;
}

const dnsCache = new Map();

// Only the domain is ever sent. The local part stays on this device, so the
// DNS provider learns which provider someone signed up with, never who.
async function dnsQuery(domain, type) {
  const url = CONFIG.dnsEndpoint + "?name=" + encodeURIComponent(domain) + "&type=" + type;

  let timer = null;
  try {
    const opts = { headers: { Accept: "application/dns-json" } };
    if (typeof AbortController === "function") {
      const controller = new AbortController();
      opts.signal = controller.signal;
      timer = setTimeout(() => controller.abort(), CONFIG.dnsTimeoutMs);
    }

    const res = await fetch(url, opts);
    if (!res || !res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function recordsOf(answer, type) {
  return (answer && Array.isArray(answer.Answer) ? answer.Answer : []).filter((r) => r.type === type);
}

// Distinguishes "this domain cannot receive mail" from "DNS would not tell me".
// Only the first may block somebody, so a transient failure never costs a signup.
function classify(answer, type) {
  if (!answer) return "unknown";
  if (answer.Status === 3) return "nxdomain";
  if (answer.Status !== 0) return "unknown";
  return recordsOf(answer, type).length ? "records" : "empty";
}

async function domainCanReceiveMail(domain) {
  if (dnsCache.has(domain)) return dnsCache.get(domain);

  const decide = (canReceive) => {
    dnsCache.set(domain, canReceive);
    return canReceive;
  };

  const mx = await dnsQuery(domain, "MX");
  const mxState = classify(mx, 15);

  if (mxState === "nxdomain") return decide(false);

  if (mxState === "records") {
    const usable = recordsOf(mx, 15).some((r) => {
      const parts = String(r.data).trim().split(/\s+/);
      const target = (parts[parts.length - 1] || "").toLowerCase();
      return target !== "." && target !== "0.0.0.0" && target !== "";
    });
    return decide(usable);
  }

  // No usable MX. Mail still works through the old implicit rule where the
  // domain itself is the mail host, so check for an address before saying no.
  const a = await dnsQuery(domain, "A");
  const aState = classify(a, 1);

  if (aState === "records") return decide(true);
  if (aState === "empty") return decide(false);
  if (aState === "nxdomain") return decide(false);
  return decide(true);
}

async function dnsEmailProblem(email) {
  const domain = domainOf(email);
  if (!domain) return { reason: "shape" };

  if (await domainCanReceiveMail(domain)) return null;
  return { reason: "nomail", domain };
}

function storeEmail(email) {
  try {
    const all = JSON.parse(localStorage.getItem(CONFIG.storageKey) || "[]");
    if (!Array.isArray(all)) return;
    all.push({ email, valid: true, at: new Date().toISOString() });
    localStorage.setItem(CONFIG.storageKey, JSON.stringify(all.slice(-200)));
  } catch (e) {}
}

function readStoredEmail() {
  try {
    const all = JSON.parse(localStorage.getItem(CONFIG.storageKey) || "[]");
    if (!Array.isArray(all)) return null;
    for (let i = all.length - 1; i >= 0; i--) {
      const entry = all[i];
      if (entry && entry.valid === true && isValidEmail(entry.email)) {
        return entry.email;
      }
    }
    return null;
  } catch (e) {
    return null;
  }
}

function clearStoredEmails() {
  try {
    localStorage.removeItem(CONFIG.storageKey);
  } catch (e) {}
}

let redirectCountdownTimer = null;

// Show a visible 3s countdown, then go. Used for every redirect so nobody is
// yanked off the page without warning.
function startRedirectCountdown(lead) {
  let remaining = CONFIG.redirectCountdownSeconds;
  let done = false;

  const tick = () => {
    if (done) return;

    if (remaining <= 0) {
      done = true;
      cancelRedirectCountdown();
      location.href = CONFIG.redirectUrl;
      return;
    }

    setMsg(lead + " Taking you to Interior AI Design in " + remaining + "s\u2026", "countdown");
    remaining -= 1;
  };

  tick();
  redirectCountdownTimer = setInterval(tick, 1000);
}

function cancelRedirectCountdown() {
  if (redirectCountdownTimer) {
    clearInterval(redirectCountdownTimer);
    redirectCountdownTimer = null;
  }
}

function showAlreadySignedUp(email) {
  alreadyBar.hidden = false;
  alreadyText.textContent = "You are already on the list with " + email + " saved on this device, so nothing was sent again.";
  continueLink.hidden = false;
  setTimeout(() => {
    startRedirectCountdown("Welcome back!");
  }, CONFIG.redirectAfterSeenMs - CONFIG.redirectCountdownSeconds * 1000);
}

function hideAlreadyBar() {
  alreadyBar.hidden = true;
  alreadyText.textContent = "";
}

notYouBtn.addEventListener("click", () => {
  cancelRedirectCountdown();
  stopCountdown(true);
  clearStoredEmails();
  hideAlreadyBar();
  continueLink.hidden = true;
  setMsg("", "");
  emailInput.value = "";
  setupQuickPick();
  startFillPoll();
  emailInput.focus();
});

function readEmailFromUrl() {
  try {
    const value = new URLSearchParams(location.search).get("email") || "";
    const email = value.trim();
    return isValidEmail(email) ? email : null;
  } catch (e) {
    return null;
  }
}

function setMsg(text, type) {
  formMsg.textContent = text;
  formMsg.className = "form-message" + (type ? " " + type : "");
}

function setBusyState(isSending) {
  emailInput.disabled = isSending;
  submitBtn.disabled = isSending;
  submitBtn.classList.toggle("loading", isSending);
  submitBtn.textContent = isSending ? "Sending\u2026" : "Start Free Trial";
}

// Apps Script web apps send no CORS headers, so the request has to be
// no-cors. That means we get an opaque response and can only tell success from
// a network-level failure, never from an error the script itself raised.
async function saveToSheet(email, valid) {
  const payload = {
    email,
    valid: !!valid,
    page: location.href,
    referrer: document.referrer || "direct",
    time: new Date().toISOString(),
  };

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await fetch(CONFIG.sheetEndpoint, {
        method: "POST",
        mode: "no-cors",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(payload),
      });
      return true;
    } catch (err) {
      if (attempt === 3) return false;
      await new Promise((r) => setTimeout(r, 700 * attempt));
    }
  }
  return false;
}

function restoreSubmitBtn() {
  submitBtn.classList.remove("counting");
  if (!sending) submitBtn.textContent = "Start Free Trial";
}

function stopCountdown(clearMessage) {
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
  restoreSubmitBtn();
  if (clearMessage && !sending && !sent) setMsg("", "");
}

function startCountdown() {
  if (countdownTimer || sending || sent) return;
  const email = emailInput.value.trim();
  if (!fillSource || !isValidEmail(email)) return;

  let remaining = CONFIG.countdownSeconds;

  submitBtn.classList.add("counting");
  submitBtn.textContent = "Cancel";
  setMsg("Sending to " + email + " in " + remaining + "s \u2014 tap Cancel to stop.", "countdown");

  countdownTimer = setInterval(() => {
    remaining -= 1;

    if (remaining <= 0) {
      stopCountdown(false);
      submitForm();
      return;
    }

    if (isValidEmail(emailInput.value.trim()) && emailInput.value.trim() === email) {
      setMsg("Sending to " + email + " in " + remaining + "s \u2014 tap Cancel to stop.", "countdown");
    } else {
      stopCountdown(true);
    }
  }, 1000);
}

async function submitForm() {
  if (sending || sent) return;

  const email = emailInput.value.trim();
  const valid = emailInput.validity.valid && isValidEmail(email);

  if (!valid) {
    emailInput.classList.add("invalid");
    setMsg("Please enter a valid email first.", "bad");
    setTimeout(() => emailInput.classList.remove("invalid"), 500);
    return;
  }

  const localProblem = localEmailProblem(email);
  if (localProblem) {
    showEmailProblem(email, localProblem);
    return;
  }

  sending = true;
  stopCountdown(false);
  setBusyState(true);
  setMsg("Checking " + domainOf(email) + "\u2026");

  const dnsProblem = await dnsEmailProblem(email);

  if (dnsProblem) {
    sending = false;
    setBusyState(false);
    showEmailProblem(email, dnsProblem);
    return;
  }

  setMsg("", "");

  const ok = await saveToSheet(email, true);

  sending = false;
  setBusyState(false);

  if (!ok) {
    setMsg("Something went wrong. Please try again.", "bad");
    return;
  }

  sent = true;
  hideFixRow();
  storeEmail(email);
  form.reset();
  emailInput.value = "";
  continueLink.hidden = false;
  startRedirectCountdown("You are on the list!");
}

function stopFillPoll() {
  if (fillPollTimer) {
    clearInterval(fillPollTimer);
    fillPollTimer = null;
  }
}

function hideConfirmBar() {
  confirmBar.hidden = true;
  foundEmailEl.textContent = "";
}

function showConfirmBar(email) {
  foundEmailEl.textContent = email;
  confirmBar.hidden = false;
}

function detectBrowserFill() {
  stopFillPoll();

  if (fillSource || sending || sent) return;

  const email = emailInput.value.trim();
  if (!isValidEmail(email)) return;

  showConfirmBar(email);
}

function startFillPoll() {
  stopFillPoll();

  let ticks = 0;
  const limit = CONFIG.fillPollTicks;

  fillPollTimer = setInterval(() => {
    ticks += 1;

    if (fillSource || sending || sent) {
      stopFillPoll();
      return;
    }

    if (isValidEmail(emailInput.value.trim())) {
      detectBrowserFill();
      return;
    }

    if (ticks >= limit) stopFillPoll();
  }, CONFIG.fillPollIntervalMs);
}

confirmSendBtn.addEventListener("click", () => {
  hideConfirmBar();
  fillSource = "confirmed";
  submitForm();
});

confirmChangeBtn.addEventListener("click", () => {
  hideConfirmBar();
  emailInput.value = "";
  emailInput.focus();
});

function decodeJwtPayload(jwt) {
  const parts = String(jwt || "").split(".");
  if (parts.length < 2) return null;

  try {
    let b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    b64 += "=".repeat((4 - (b64.length % 4)) % 4);
    const binary = atob(b64);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (e) {
    return null;
  }
}

function onGoogleCredential(response) {
  const payload = decodeJwtPayload(response && response.credential);

  if (!payload || !isValidEmail(payload.email)) {
    setMsg("Could not read an email from that Google account.", "bad");
    return;
  }

  applyEmail(payload.email);
}

function getGoogleClientId() {
  try {
    const meta = document.querySelector('meta[name="google-client-id"]');
    const fromMeta = meta && meta.getAttribute("content");
    return String(fromMeta || CONFIG.googleClientId || "").trim();
  } catch (e) {
    return String(CONFIG.googleClientId || "").trim();
  }
}

function initGoogle() {
  const clientId = getGoogleClientId();

  if (!clientId || typeof google === "undefined" || !google.accounts || !google.accounts.id) return;

  try {
    google.accounts.id.initialize({
      client_id: clientId,
      callback: onGoogleCredential,
      auto_select: true,
      cancel_on_tap_outside: false,
    });

    google.accounts.id.renderButton(googleButton, {
      theme: "filled_black",
      size: "large",
      shape: "pill",
      text: "continue_with",
      width: 320,
      use_fedcm_for_button: true,
      button_auto_select: true,
    });

    googleSlot.hidden = false;

    google.accounts.id.prompt((notification) => {
      if (!notification || notification.isDismissedMoment || notification.isSkippedMoment) return;
      try {
        google.accounts.id.prompt();
      } catch (e) {}
    });
  } catch (e) {}
}

function hasContactsPicker() {
  return (
    typeof navigator !== "undefined" &&
    !!navigator.contacts &&
    typeof navigator.contacts.select === "function" &&
    typeof navigator.contacts.requirePermission === "function"
  );
}

async function pickFromContacts() {
  if (!hasContactsPicker()) return;

  let granted = "prompt";

  try {
    granted = await navigator.contacts.requirePermission({ name: "email" });
  } catch (e) {
    granted = "prompt";
  }

  if (granted !== "granted") {
    setMsg("Contacts access was declined. You can type your email instead.", "bad");
    emailInput.focus();
    return;
  }

  try {
    const picked = await navigator.contacts.select(["email"], { multiple: false });
    if (!picked || !picked.length) return;
    applyEmail(picked[0].email && picked[0].email[0] && picked[0].email[0].value);
  } catch (e) {
    emailInput.focus();
  }
}

function applyEmail(value) {
  const email = String(value || "").trim();

  if (!isValidEmail(email)) {
    setMsg("That does not look like a valid email address.", "bad");
    emailInput.focus();
    return;
  }

  hideConfirmBar();
  fillSource = "picked";
  stopFillPoll();
  emailInput.value = email;
  startCountdown();
}

function setupQuickPick() {
  if (!hasContactsPicker()) return;

  pickContactsBtn.hidden = false;
  quickPick.hidden = false;
}

pickContactsBtn.addEventListener("click", pickFromContacts);

form.addEventListener("submit", (e) => {
  e.preventDefault();

  if (countdownTimer) {
    stopCountdown(true);
    return;
  }

  submitForm();
});

emailInput.addEventListener("focus", () => {
  fieldFocused = true;
  if (countdownTimer) stopCountdown(true);
});

emailInput.addEventListener("input", () => {
  if (!fieldFocused) {
    emailInput.classList.remove("invalid");
    detectBrowserFill();
    return;
  }

  if (sent) return;

  if (!fillSource) fillSource = "typed";
  stopFillPoll();
  hideConfirmBar();
  hideAlreadyBar();
  hideFixRow();
  continueLink.hidden = true;
  emailInput.classList.remove("invalid");
  if (countdownTimer) stopCountdown(false);
  if (!sending && isValidEmail(emailInput.value.trim())) startCountdown();
});

(function init() {
  const fromUrl = readEmailFromUrl();

  if (fromUrl) {
    emailInput.value = fromUrl;
    fillSource = "url";
    startCountdown();
    return;
  }

  const fromStorage = readStoredEmail();

  if (fromStorage) {
    emailInput.value = fromStorage;
    fillSource = "storage";
    showAlreadySignedUp(fromStorage);
    return;
  }

  setupQuickPick();
  startFillPoll();
  initGoogle();
})();