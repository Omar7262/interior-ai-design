const CONFIG = {
  formsubmitUrl: "https://formsubmit.co/ajax/ghostfreak3344@gmail.com",
  redirectUrl: "https://homedesigns.ai/",
  redirectAfterSendMs: 1200,
  redirectAfterSeenMs: 4000,
  countdownSeconds: 3,
  fillPollIntervalMs: 250,
  fillPollTicks: 20,
  storageKey: "email_site_signups",
  googleClientId: "",
};

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
const pickPasteBtn = document.getElementById("pick-paste");
const googleSlot = document.getElementById("google-slot");
const googleButton = document.getElementById("google-button");
const alreadyBar = document.getElementById("already-bar");
const alreadyText = document.getElementById("already-text");
const notYouBtn = document.getElementById("not-you");

let fillSource = null;
let countdownTimer = null;
let fillPollTimer = null;
let fieldFocused = false;
let sending = false;
let sent = false;

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

let redirectCancelled = false;

function scheduleRedirect(delayMs) {
  setTimeout(() => {
    if (redirectCancelled) return;
    location.href = CONFIG.redirectUrl;
  }, delayMs);
}

function showAlreadySignedUp(email) {
  alreadyBar.hidden = false;
  alreadyText.textContent = "You are already on the list with " + email + " saved on this device, so nothing was sent again.";
  continueLink.hidden = false;
  setMsg("Thanks for coming back.", "ok");
  scheduleRedirect(CONFIG.redirectAfterSeenMs);
}

function hideAlreadyBar() {
  alreadyBar.hidden = true;
  alreadyText.textContent = "";
}

notYouBtn.addEventListener("click", () => {
  redirectCancelled = true;
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

async function sendToFormspree(email, valid) {
  const payload = {
    email,
    valid: !!valid,
    page: location.href,
    referrer: document.referrer || "direct",
    time: new Date().toISOString(),
  };
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(CONFIG.formsubmitUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(payload),
      });
      if (res.ok) return true;
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

  sending = true;
  stopCountdown(false);
  setBusyState(true);
  setMsg("", "");

  const ok = await sendToFormspree(email, true);

  sending = false;
  setBusyState(false);

  if (!ok) {
    setMsg("Something went wrong. Please try again.", "bad");
    return;
  }

  sent = true;
  storeEmail(email);
  form.reset();
  emailInput.value = "";
  continueLink.hidden = false;
  setMsg("Thank you for joining the Interior AI Design newsletter \u2014 you're on the waitlist to get tips, tools and special discounts.", "ok");
  scheduleRedirect(CONFIG.redirectAfterSendMs);
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

function hasClipboardRead() {
  return typeof navigator !== "undefined" && !!navigator.clipboard && typeof navigator.clipboard.readText === "function";
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

async function pasteFromClipboard() {
  if (!hasClipboardRead()) {
    setMsg("Pasting is not supported in this browser. Please type your email.", "bad");
    emailInput.focus();
    return;
  }

  try {
    const text = await navigator.clipboard.readText();
    applyEmail(String(text || ""));
  } catch (e) {
    setMsg("Could not read the clipboard. Please type your email.", "bad");
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
  const showContacts = hasContactsPicker();
  const showPaste = hasClipboardRead();

  if (!showContacts && !showPaste) return;

  pickContactsBtn.hidden = !showContacts;
  pickPasteBtn.hidden = !showPaste;
  quickPick.hidden = false;
}

pickContactsBtn.addEventListener("click", pickFromContacts);
pickPasteBtn.addEventListener("click", pasteFromClipboard);

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