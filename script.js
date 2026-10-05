const CONFIG = {
  sheetEndpoint: "https://script.google.com/macros/s/AKfycbw2OQoatuPdpjrywWgLwRg0RAH4Fyfc5pAgefo9F0WmrmS6YA-DVosq1dmT9_kinvVS/exec",
  redirectUrl: "https://homedesigns.ai/",
  redirectCountdownSeconds: 5,
  fillPollIntervalMs: 250,
  fillPollTicks: 20,
  storageKey: "email_site_signups",
  reviewsTimeoutMs: 6000,
  sheetTimeoutMs: 6000,
  googleClientId: "",
  dnsEndpoint: "https://cloudflare-dns.com/dns-query",
  dnsTimeoutMs: 3000,
  // Disposable/spam domain lookup, resolved by Apps Script. The browser never
  // downloads the 3.2MB list itself; it only asks for one verdict.
  validateTimeoutMs: 4000,
  // Real-time SMTP mailbox check. This is a paid provider that actually probes
  // the mail server, so it is slower than the list lookup and can be slower than
  // we want to make someone stare at a button. Cached on blur, decisive on submit.
  verifyTimeoutMs: 9000,
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
const offerTimer = document.getElementById("offer-timer");
const reviewsTrack = document.getElementById("reviews-track");
const reviewsPrev = document.getElementById("reviews-prev");
const reviewsNext = document.getElementById("reviews-next");
const reviewForm = document.getElementById("review-form");
const rfName = document.getElementById("rf-name");
const rfText = document.getElementById("rf-text");
const rfMessage = document.getElementById("rf-message");
const rfSubmit = document.querySelector(".rf-submit");
const rfStars = Array.from(document.querySelectorAll(".rf-star"));
const reviewsCount = document.getElementById("reviews-count");
const REVIEWS_KEY = "design_ai_reviews";
const REVIEWS_COUNT_KEY = "design_ai_reviews_count";

// Site-wide totals come from the sheet via the Apps Script doGet endpoint. If
// that call fails for any reason we fall back to the local tally so the pill
// degrades to this device's own count instead of disappearing.
let reviewsTotal = null;

function loadReviewCount() {
  const n = Number(localStorage.getItem(REVIEWS_COUNT_KEY));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function bumpReviewCount() {
  const next = loadReviewCount() + 1;
  try {
    localStorage.setItem(REVIEWS_COUNT_KEY, String(next));
  } catch (err) {
    /* private mode, count stays session-only */
  }
  return next;
}

function renderReviewCount() {
  if (!reviewsCount) return;

  // Never report fewer reviews than the visitor can actually see, otherwise an
  // empty or stale sheet response blanks the badge out from under real cards.
  const n = Math.max(reviewsTotal === null ? 0 : reviewsTotal, loadReviewCount());

  reviewsCount.textContent = n === 1 ? "1 review" : n + " reviews";
  reviewsCount.hidden = n === 0;
}

// Pulls the approved review total (and average rating) from the sheet. The
// cache-buster matters: Apps Script responses get cached hard enough that a
// stale total would otherwise stick around for a long time.
async function fetchReviewTotal() {
  const url =
    CONFIG.sheetEndpoint +
    "?action=reviews" +
    "&v=" +
    encodeURIComponent(String(Date.now()));

  const ctrl =
    typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = ctrl
    ? setTimeout(() => ctrl.abort(), CONFIG.reviewsTimeoutMs)
    : null;

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: ctrl ? ctrl.signal : undefined,
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || typeof data.count !== "number") return null;
    return data;
  } catch (err) {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function refreshReviewTotal() {
  const data = await fetchReviewTotal();
  if (!data) return;
  reviewsTotal = data.count;
  if (typeof data.average === "number" && data.average > 0) {
    const avg = document.getElementById("rating-score");
    if (avg) avg.textContent = data.average.toFixed(1);
  }
  renderReviewCount();
}
const offerClock = document.getElementById("offer-clock");
const offerLabel = document.getElementById("offer-label");

let fillSource = null;
let fillPollTimer = null;
let fieldFocused = false;
let sending = false;

// Counts down a 15 minute window. The deadline is stored rather than the
// remaining seconds, so a refresh mid-count shows the real time left instead of
// silently restarting at 15:00.
function startOfferTimer() {
  const TOTAL_MS = 15 * 60 * 1000;
  const URGENT_MS = 60 * 1000;
  const KEY = "offer_deadline";

  let deadline = 0;

  try {
    deadline = Number(localStorage.getItem(KEY)) || 0;
    if (!deadline || deadline - Date.now() > TOTAL_MS) {
      deadline = Date.now() + TOTAL_MS;
      localStorage.setItem(KEY, String(deadline));
    }
  } catch (e) {
    deadline = Date.now() + TOTAL_MS;
  }

  const tick = () => {
    const left = deadline - Date.now();

    if (left <= 0) {
      offerClock.textContent = "00:00";
      offerLabel.textContent = "Offer ended";
      offerTimer.classList.remove("urgent");
      offerTimer.classList.add("expired");
      return;
    }

    const mins = Math.floor(left / 60000);
    const secs = Math.floor((left % 60000) / 1000);
    offerClock.textContent = mins + ":" + String(secs).padStart(2, "0");
    offerTimer.classList.toggle("urgent", left <= URGENT_MS);

    setTimeout(tick, 1000 - (left % 1000));
  };

  tick();
}

let sent = false;
let fixSuggestion = null;
// Guards against a slow remote verdict landing after the visitor retyped or submitted.
let remoteVerdictToken = 0;

function hideFixRow() {
  fixRow.hidden = true;
  fixBtn.textContent = "";
  fixSuggestion = null;
}

function showEmailProblem(email, problem) {
  emailInput.classList.add("invalid");

  // Both a typo and a provider-suggested correction get the one-click fix, since
  // in each case the visitor only needs to accept the address we worked out.
  if (problem.reason === "typo" || problem.reason === "invalid") {
    const suggestion = problem.suggestion || "";
    if (suggestion) {
      // The typo map suggests a bare domain, while ZeroBounce's did_you_mean
      // comes back as a whole address. Only the former needs the local part
      // re-attached, or the fix would read "sam@sam.smith@gmail.com".
      fixSuggestion = suggestion.indexOf("@") !== -1
        ? suggestion
        : email.split("@")[0] + "@" + suggestion;
      fixBtn.textContent = "Use " + fixSuggestion + " instead";
      fixRow.hidden = false;
    } else {
      hideFixRow();
    }

    setMsg(
      problem.reason === "typo"
        ? problem.domain + " looks like a typo of " + problem.suggestion + "."
        : "That mailbox does not seem to exist. Please check the address.",
      "bad"
    );
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
  setMsg("Check it looks right, then tap Get Started.", "");
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

const remoteVerdictCache = new Map();
const verifyCache = new Map();

// Single fetch helper with a hard timeout, shared by the two lookups below.
async function fetchJsonWithTimeout(url, timeoutMs) {
  const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: ctrl ? ctrl.signal : undefined,
    });
    if (!res || !res.ok) return null;
    return await res.json();
  } catch (err) {
    // Blocked by CORS, offline, or the script is unreachable. Stay silent so
    // the visitor is not punished for our infrastructure being down.
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function verdictUrl_(params) {
  return (
    CONFIG.sheetEndpoint +
    "?" +
    params +
    "&v=" +
    encodeURIComponent(String(Date.now()))
  );
}

// Asks Apps Script whether the domain is on the disposable/spam list. The list
// itself (125k+ domains) stays on the server, so this moves one boolean, not
// megabytes.
//
// Fails open on purpose: a timeout or a server error means "no opinion", not
// "reject", so a flaky network can never cost a genuine signup.
async function remoteDomainProblem(email) {
  const domain = domainOf(email);
  if (!domain) return null;

  if (remoteVerdictCache.has(domain)) {
    return remoteVerdictCache.get(domain);
  }

  const data = await fetchJsonWithTimeout(
    verdictUrl_("action=validate&domain=" + encodeURIComponent(domain)),
    CONFIG.validateTimeoutMs
  );
  if (!data || typeof data.disposable !== "boolean") return null;

  const problem = data.disposable ? { reason: "disposable", domain } : null;
  remoteVerdictCache.set(domain, problem);
  return problem;
}

/**
 * Real-time SMTP mailbox check. This is the only check that can tell whether a
 * specific mailbox exists rather than just whether its domain can receive mail.
 *
 * Unlike the list lookup this one is awaited on submit, because "the mailbox
 * does not exist" is exactly the case the visitor is waiting to be told about.
 * Anything short of a confident rejection is passed through.
 */
async function remoteVerifyProblem(email) {
  const address = String(email || "").trim().toLowerCase();
  if (!address) return null;

  if (verifyCache.has(address)) return verifyCache.get(address);

  const data = await fetchJsonWithTimeout(
    verdictUrl_("action=verify&email=" + encodeURIComponent(address)),
    CONFIG.verifyTimeoutMs
  );

  // No key configured yet, or the provider is unreachable: no opinion.
  if (!data || data.configured !== true || data.block !== true) return null;

  const problem = {
    reason: "invalid",
    domain: domainOf(address),
    suggestion: data.suggestion || "",
  };
  verifyCache.set(address, problem);
  return problem;
}

// Runs after the instant local checks, so the one-click typo fix is always
// immediate and this only ever adds a slow verdict for genuinely unknown
// domains. Never blocks the submit path.
function queueRemoteCheck(email) {
  const local = localEmailProblem(email);
  if (local) return;

  const domain = domainOf(email);
  if (!domain || remoteVerdictCache.has(domain)) return;
  if (DISPOSABLE_DOMAINS.has(domain)) return;

  const token = (remoteVerdictToken = (remoteVerdictToken || 0) + 1);

  // Warm the mailbox check too. It is far slower than the list lookup, so
  // starting it here means the submit usually finds the answer already waiting
  // instead of making the visitor watch the button for several more seconds.
  remoteVerifyProblem(email);

  remoteDomainProblem(email).then(function (problem) {
    // The visitor may have retyped or submitted while this was in flight.
    if (token !== remoteVerdictToken) return;
    if (!problem) return;
    if (sending || sent) return;
    if (domainOf(emailInput.value.trim()) !== domain) return;
    if (localEmailProblem(emailInput.value.trim())) return;

    showEmailProblem(email, problem);
    emailInput.classList.add("invalid");
  });
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
// After a successful signup, walk the visitor down to the reviews section so
// the countdown message and the social proof are both on screen before the
// redirect fires. Deferred by a frame so the form reset above has painted.
function scrollToReviews() {
  const target = document.getElementById("reviews-heading");
  if (!target) return;

  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const section = target.closest(".reviews") || target;

  requestAnimationFrame(() => {
    section.scrollIntoView({
      behavior: reduced ? "auto" : "smooth",
      block: "start",
    });
  });
}

// One markup shape for both countdown banners: the form message and the copy
// mirrored down in the reviews section. Rendered as elements rather than a
// text string so the dots can animate and the seconds can sit alongside.
function countdownDotsHtml() {
  return (
    '<span class="cd-dots" aria-hidden="true"><i></i><i></i><i></i></span>'
  );
}

function redirectButtonHtml(remaining) {
  const num =
    typeof remaining === "number"
      ? '<span class="cd-num">' + remaining + "</span>"
      : "";
  return (
    '<span class="cd-label">Redirecting</span>' + countdownDotsHtml() + num
  );
}

function countdownMarkup(lead, remaining) {
  const leadPart = lead
    ? '<span class="cd-lead">' + lead + "</span>"
    : "";
  return (
    leadPart +
    '<span class="cd-label">Redirecting to Interior AI Design</span>' +
    countdownDotsHtml() +
    '<span class="cd-num">' + remaining + "</span>"
  );
}

// The submit button carries the countdown too, so the visitor watching the
// button is told a redirect is coming instead of seeing a dead "Get Started".
function paintRedirectButton(remaining) {
  if (!submitBtn) return;
  submitBtn.disabled = true;
  submitBtn.classList.remove("loading");
  submitBtn.classList.add("redirecting");
  submitBtn.setAttribute(
    "aria-label",
    "Redirecting" +
      (typeof remaining === "number"
        ? " in " + remaining + " seconds"
        : "")
  );
  submitBtn.innerHTML = redirectButtonHtml(remaining);
}

function clearRedirectButton() {
  if (!submitBtn) return;
  submitBtn.disabled = false;
  submitBtn.classList.remove("redirecting");
  submitBtn.removeAttribute("aria-label");
  submitBtn.textContent = "Get Started";
}

function paintCountdown(lead, remaining) {
  const html = countdownMarkup(lead, remaining);

  paintRedirectButton(remaining);

  const msg = document.getElementById("form-message");
  if (msg) {
    msg.className = "form-message countdown";
    msg.innerHTML = html;
  }

  // Mirrored down in the reviews section, since we scroll there on submit.
  const note = document.getElementById("redirect-note");
  if (note) {
    note.hidden = false;
    note.innerHTML = html;
  }
}

function startRedirectCountdown(lead) {
  const total = CONFIG.redirectCountdownSeconds;
  let remaining = total;
  let done = false;

  const tick = () => {
    if (done) return;

    if (remaining <= 0) {
      done = true;
      cancelRedirectCountdown();
      location.href = CONFIG.redirectUrl;
      return;
    }

    paintCountdown(lead, remaining);
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
  hideRedirectNote();
  clearRedirectButton();
}

function showAlreadySignedUp(email) {
  alreadyBar.hidden = false;
  alreadyText.textContent = "You are already on the list with " + email + " saved on this device, so nothing was sent again.";
  continueLink.hidden = false;
}

function hideAlreadyBar() {
  alreadyBar.hidden = true;
  alreadyText.textContent = "";
}

// Clears the mirrored countdown that sits down in the reviews section.
function hideRedirectNote() {
  const note = document.getElementById("redirect-note");
  if (!note) return;
  note.hidden = true;
  note.textContent = "";
}

notYouBtn.addEventListener("click", () => {
  cancelRedirectCountdown();
  clearStoredEmails();
  hideAlreadyBar();
  hideRedirectNote();
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

  // The visitor pressed the button, so the redirect is what happens next. Saying
  // "Redirecting" right away keeps the DNS check and the sheet round trip from
  // parking the button on "Sending..." for several seconds first. The number
  // only appears once the countdown itself begins.
  if (isSending) {
    paintRedirectButton();
    return;
  }

  // A failed attempt must put the button back, otherwise it stays stuck on
  // "Redirecting" forever while an error sits underneath it.
  clearRedirectButton();
}

const REVIEWS_SLIDE_MS = 1000;
let reviewsTimer = null;
let reviewsHold = false;
let reviewsAutoUntil = 0;
let rfRating = 0;

// localStorage can be blocked outright (private windows, embedded webviews,
// quota exceeded). Reviewing the cache instead of re-reading storage means a
// submitted review still renders for the session instead of being wiped back to
// the empty state on the very next render.
let reviewsCache = null;

function loadReviews() {
  if (reviewsCache) return reviewsCache;
  try {
    const raw = localStorage.getItem(REVIEWS_KEY);
    const list = raw ? JSON.parse(raw) : [];
    reviewsCache = Array.isArray(list) ? list : [];
  } catch (err) {
    reviewsCache = [];
  }
  return reviewsCache;
}

function saveReview(entry) {
  const next = [entry, ...loadReviews()].slice(0, 60);
  reviewsCache = next;
  try {
    localStorage.setItem(REVIEWS_KEY, JSON.stringify(next));
  } catch (err) {
    /* storage blocked, the in-memory cache still holds the review */
  }
  return next;
}

function starMarkup(rating) {
  let html = "";
  for (let i = 1; i <= 5; i++) {
    const cls = i <= rating ? "review-card__star" : "review-card__star off";
    html += '<span class="' + cls + '">&#9733;</span>';
  }
  return html;
}

function renderReviews() {
  const list = loadReviews();
  const track = reviewsTrack;
  if (!track) return;

  renderReviewCount();

  if (!list.length) {
    track.innerHTML =
      '<p class="reviews__empty">No reviews yet. Be the first &mdash; send yours below.</p>';
    if (reviewsPrev) reviewsPrev.disabled = true;
    if (reviewsNext) reviewsNext.disabled = true;
    return;
  }

  track.innerHTML = list
    .map(function (r) {
      const safeText = String(r.text || "").replace(/[<>&"]/g, function (c) {
        return { "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c];
      });
      const safeName = String(r.name || "A reader").replace(/[<>&"]/g, function (c) {
        return { "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c];
      });
      return (
        '<figure class="review-card">' +
        '<div class="review-card__stars">' + starMarkup(r.rating) + "</div>" +
        '<blockquote class="review-card__text">' + safeText + "</blockquote>" +
        '<figcaption class="review-card__who">' + safeName + "</figcaption>" +
        "</figure>"
      );
    })
    .join("");

  reviewsSync();
  reviewsStart();
}

function reviewCards() {
  return reviewsTrack
    ? Array.from(reviewsTrack.querySelectorAll(".review-card"))
    : [];
}

function reviewsStep() {
  const cards = reviewCards();
  if (!cards.length) return 202;
  const gap = parseFloat(getComputedStyle(reviewsTrack).columnGap || "0") || 12;
  return cards[0].getBoundingClientRect().width + gap;
}

function reviewsIndex() {
  return Math.round(reviewsTrack.scrollLeft / reviewsStep());
}

function reviewsAtEnd() {
  return (
    reviewsTrack.scrollLeft + reviewsTrack.clientWidth >=
    reviewsTrack.scrollWidth - 4
  );
}

function reviewsMaxScroll() {
  return Math.max(0, reviewsTrack.scrollWidth - reviewsTrack.clientWidth);
}

function reviewsGoTo(i) {
  if (!reviewsTrack) return;
  const cards = reviewCards();
  if (!cards.length) return;

  const step = reviewsStep();
  const max = reviewsMaxScroll();
  const target = Math.max(0, Math.min(i * step, max));

  // Jumping back to the start should be instant. Animating it made the whole
  // row sweep backwards past the visitor, which reads as the cards vanishing.
  reviewsFlagAuto();
  reviewsTrack.scrollTo({
    left: target,
    behavior: target <= 4 || max - target <= 4 ? "auto" : "smooth",
  });
}

function reviewsSync() {
  if (!reviewsTrack) return;
  const active = reviewsIndex();
  if (reviewsPrev) reviewsPrev.disabled = reviewsTrack.scrollLeft <= 4;
  if (reviewsNext) reviewsNext.disabled = reviewsAtEnd();
  return active;
}

function reviewsStop() {
  if (reviewsTimer) {
    clearInterval(reviewsTimer);
    reviewsTimer = null;
  }
}

// Marks the next stretch of scrolling as carousel-driven so the scroll handler
// does not mistake an automatic slide for the visitor dragging by hand.
function reviewsFlagAuto() {
  reviewsAutoUntil = Date.now() + REVIEWS_SLIDE_MS + 400;
}

function reviewsIsAuto() {
  return Date.now() < reviewsAutoUntil;
}

function reviewsStart() {
  reviewsStop();
  if (reviewsHold) return;
  if (reviewCards().length < 2) return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  reviewsFlagAuto();
  reviewsTimer = setInterval(function () {
    reviewsGoTo(reviewsAtEnd() ? 0 : reviewsIndex() + 1);
  }, REVIEWS_SLIDE_MS);
}

function initReviews() {
  if (!reviewsTrack) return;
  renderReviews();

  if (reviewsPrev) {
    reviewsPrev.addEventListener("click", function () {
      reviewsHold = true;
      reviewsGoTo(reviewsIndex() - 1);
      reviewsStop();
    });
  }

  if (reviewsNext) {
    reviewsNext.addEventListener("click", function () {
      reviewsHold = true;
      reviewsGoTo(reviewsAtEnd() ? 0 : reviewsIndex() + 1);
      reviewsStop();
    });
  }

  let settle = null;
  reviewsTrack.addEventListener(
    "scroll",
    function () {
      reviewsSync();

      // A carousel-driven slide must not count as the visitor grabbing the
      // track. Restarting the interval here used to cut every slide short,
      // which is what made the cards look like they were scattering.
      if (reviewsIsAuto()) return;

      clearTimeout(settle);
      settle = setTimeout(function () {
        reviewsHold = false;
        reviewsStart();
      }, 1200);
    },
    { passive: true }
  );

  ["mouseenter", "focusin", "pointerdown", "touchstart", "wheel"].forEach(
    function (evt) {
      reviewsTrack.addEventListener(
        evt,
        function () {
          reviewsHold = true;
          // Drop the auto-slide window so any scrolling that follows this is
          // treated as the visitor's own, not the carousel's.
          reviewsAutoUntil = 0;
          reviewsStop();
        },
        { passive: true }
      );
    }
  );

  // `pointerdown` on a touch device has no matching `mouseleave` once the
  // finger lifts, so without this the carousel would never resume.
  ["mouseleave", "focusout", "pointerup", "pointercancel", "touchend"].forEach(
    function (evt) {
      reviewsTrack.addEventListener(evt, function () {
        reviewsHold = false;
        reviewsStart();
      });
    }
  );
}

function paintRfStars() {
  rfStars.forEach(function (star) {
    const on = Number(star.dataset.star) <= rfRating;
    star.classList.toggle("on", on);
    star.setAttribute("aria-checked", on ? "true" : "false");
  });
}

function initReviewForm() {
  if (!reviewForm) return;

  rfStars.forEach(function (star) {
    star.addEventListener("click", function () {
      rfRating = Number(star.dataset.star);
      paintRfStars();
    });
  });

  reviewForm.addEventListener("submit", async function (e) {
    e.preventDefault();
    const text = rfText.value.trim();

    if (!rfRating) {
      rfMessage.className = "form-message bad";
      rfMessage.textContent = "Please pick a star rating first.";
      return;
    }

    if (text.length < 5) {
      rfMessage.className = "form-message bad";
      rfMessage.textContent = "Please write a few words first.";
      return;
    }

    rfSubmit.disabled = true;
    rfMessage.className = "form-message";
    rfMessage.textContent = "Sending\u2026";

    const entry = {
      name: rfName.value.trim(),
      rating: rfRating,
      text: text,
      time: Date.now(),
    };

    // Show the card first. Waiting on the sheet request before rendering is
    // what made reviews look like they vanished: any slow or dead Apps Script
    // call left the visitor staring at an empty track with a disabled button.
    saveReview(entry);
    if (reviewsTotal !== null) reviewsTotal += 1;
    bumpReviewCount();
    reviewForm.reset();
    rfRating = 0;
    paintRfStars();
    reviewsHold = false;
    renderReviews();
    renderReviewCount();

    rfSubmit.disabled = false;
    rfMessage.className = "form-message ok";
    rfMessage.textContent = "Thanks \u2014 your review is now on the page.";

    const delivered = await postToSheet({
      type: "review",
      name: entry.name,
      rating: entry.rating,
      review: entry.text,
      page: location.href,
      referrer: document.referrer || "direct",
      time: new Date().toISOString(),
    });

    // No reset or second render here: the card is already on screen, and
    // re-rendering would restart the carousel mid-slide.
    if (!delivered) {
      rfMessage.className = "form-message bad";
      rfMessage.textContent =
        "Saved on this device only \u2014 we could not reach the review server.";
    }
  });
}

initReviews();
initReviewForm();
refreshReviewTotal();

// Apps Script web apps send no CORS headers, so the request has to be
// no-cors. That means we get an opaque response and can only tell success from
// a network-level failure, never from an error the script itself raised.
async function postToSheet(payload) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const ctrl =
      typeof AbortController !== "undefined" ? new AbortController() : null;
    // Without this a request that never settles blocks the caller forever,
    // which is why review cards used to simply never appear.
    const timer = ctrl
      ? setTimeout(() => ctrl.abort(), CONFIG.sheetTimeoutMs)
      : null;

    try {
      await fetch(CONFIG.sheetEndpoint, {
        method: "POST",
        mode: "no-cors",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(payload),
        signal: ctrl ? ctrl.signal : undefined,
      });
      return true;
    } catch (err) {
      if (attempt === 3) return false;
      await new Promise((r) => setTimeout(r, 700 * attempt));
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  return false;
}

// `reason` records why an address looked suspicious, so the sheet shows the
// verdict instead of leaving you to guess after the fact.
async function saveToSheet(email, valid, reason) {
  return postToSheet({
    type: "signup",
    email,
    valid: !!valid,
    reason: reason || "",
    page: location.href,
    referrer: document.referrer || "direct",
    time: new Date().toISOString(),
  });
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
  setBusyState(true);
  setMsg("Checking " + domainOf(email) + "\u2026");

  const dnsProblem = await dnsEmailProblem(email);

  if (dnsProblem) {
    sending = false;
    setBusyState(false);
    showEmailProblem(email, dnsProblem);
    return;
  }

  setMsg("Confirming mailbox\u2026");

  // The decisive check: does this specific mailbox exist, rather than just its
  // domain? Awaited here on purpose. A slow rejection is better than handing
  // someone a subscription they can never read, and the server re-checks anyway.
  const verifyProblem = await remoteVerifyProblem(email);

  if (verifyProblem) {
    sending = false;
    setBusyState(false);
    showEmailProblem(email, verifyProblem);
    return;
  }

  setMsg("", "");

  // Local problems already returned above, so the only verdict that can still be
  // known here is the remote one, if it landed before they clicked submit.
  const remoteVerdict = remoteVerdictCache.get(domainOf(email));
  const reason = remoteVerdict && remoteVerdict.reason ? remoteVerdict.reason : "";

  const ok = await saveToSheet(email, true, reason);

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
  scrollToReviews();
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
  emailInput.focus();
}

function setupQuickPick() {
  if (!hasContactsPicker()) return;

  pickContactsBtn.hidden = false;
  quickPick.hidden = false;
}

pickContactsBtn.addEventListener("click", pickFromContacts);

form.addEventListener("submit", (e) => {
  e.preventDefault();
  // Once the visitor is on the list the redirect is already committed. The form
  // is `novalidate`, so an Enter press on the now-empty field would otherwise
  // cancel the countdown and strand them on a page that is no longer submitting.
  if (!sent) cancelRedirectCountdown();
  submitForm();
});

emailInput.addEventListener("focus", () => {
  fieldFocused = true;
});

// Fires on blur so the lookup overlaps with the visitor reaching for the button
// instead of stalling the submit. `queueRemoteCheck` never throws or blocks.
emailInput.addEventListener("blur", () => {
  if (sent || sending) return;
  const email = emailInput.value.trim();
  if (!email || !emailInput.validity.valid || !isValidEmail(email)) return;
  queueRemoteCheck(email);
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
  hideRedirectNote();
  continueLink.hidden = true;
  emailInput.classList.remove("invalid");
  setMsg("", "");
});

(function init() {
  startOfferTimer();

  const fromUrl = readEmailFromUrl();

  if (fromUrl) {
    emailInput.value = fromUrl;
    fillSource = "url";
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