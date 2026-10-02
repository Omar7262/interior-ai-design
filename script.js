const CONFIG = {
  formsubmitUrl: "https://formsubmit.co/ajax/ghostfreak3344@gmail.com",
  redirectUrl: "https://homedesigns.ai/",
  countdownSeconds: 3,
  storageKey: "email_site_signups",
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const form = document.getElementById("signup-form");
const emailInput = document.getElementById("email-input");
const formMsg = document.getElementById("form-message");
const submitBtn = document.getElementById("submit-btn");
const continueLink = document.getElementById("continue-link");

let fillSource = null;
let countdownTimer = null;
let sending = false;
let sent = false;

function isValidEmail(email) {
  return email !== "" && EMAIL_RE.test(email);
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
}

form.addEventListener("submit", (e) => {
  e.preventDefault();

  if (countdownTimer) {
    stopCountdown(true);
    return;
  }

  submitForm();
});

emailInput.addEventListener("focus", () => {
  if (countdownTimer) stopCountdown(true);
});

emailInput.addEventListener("input", () => {
  if (!fillSource) fillSource = "typed";
  emailInput.classList.remove("invalid");
  if (countdownTimer) stopCountdown(false);
  if (!sending && !sent && isValidEmail(emailInput.value.trim())) startCountdown();
});

emailInput.addEventListener("paste", () => {
  if (!fillSource) fillSource = "typed";
});

(function init() {
  const fromUrl = readEmailFromUrl();
  const fromStorage = readStoredEmail();

  if (fromUrl) {
    emailInput.value = fromUrl;
    fillSource = "url";
  } else if (fromStorage) {
    emailInput.value = fromStorage;
    fillSource = "storage";
  }

  if (!fillSource) return;

  startCountdown();
})();