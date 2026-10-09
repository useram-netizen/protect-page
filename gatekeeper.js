(function () {
  document.documentElement.style.visibility = "hidden";

  const currentScript =
    document.currentScript || document.querySelector("script[data-product-id]");
  const productId = currentScript
    ? currentScript.getAttribute("data-product-id")
    : null;
  const apiBase = currentScript
    ? new URL(currentScript.src).origin
    : window.location.origin;

  if (!productId) {
    console.error("[Gatekeeper] Missing data-product-id attribute.");
    document.documentElement.style.visibility = "visible";
    return;
  }

  const emailKey = `gk_${productId}_email`;
  const tokenKey = `gk_${productId}_token`;

  function renderWatermark(email) {
    if (document.getElementById("gk-watermark")) return;
    const wm = document.createElement("div");
    wm.id = "gk-watermark";
    wm.innerText = `Licensed to: ${email}`;
    wm.style.cssText =
      "position:fixed;bottom:12px;right:16px;font-size:12px;color:rgba(255,255,255,0.35);font-family:sans-serif;pointer-events:none;z-index:999999;user-select:none;";
    document.body.appendChild(wm);
  }

  function unlockPage(email) {
    document.documentElement.style.visibility = "visible";
    const modal = document.getElementById("gk-modal-overlay");
    if (modal) modal.remove();
    renderWatermark(email);
  }

  async function checkSession() {
    const email = localStorage.getItem(emailKey);
    const sessionToken = localStorage.getItem(tokenKey);

    if (email && sessionToken) {
      try {
        const res = await fetch(`${apiBase}/api/auth/validate-session`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, productId, sessionToken }),
        });
        const data = await res.json();
        if (data.valid) {
          unlockPage(email);
          return;
        }
      } catch (e) {}
      localStorage.removeItem(emailKey);
      localStorage.removeItem(tokenKey);
    }
    showModal();
  }

  function showModal() {
    document.documentElement.style.visibility = "visible";
    if (document.getElementById("gk-modal-overlay")) return;

    const overlay = document.createElement("div");
    overlay.id = "gk-modal-overlay";
    overlay.style.cssText =
      "position:fixed;top:0;left:0;width:100vw;height:100vh;background:#090d16;display:flex;align-items:center;justify-content:center;z-index:9999999;font-family:-apple-system,BlinkMacSystemFont,sans-serif;padding:20px;box-sizing:border-box;";

    overlay.innerHTML = `
      <div style="background:#131b2e;border:1px solid #1e293b;border-radius:16px;padding:36px 32px;max-width:400px;width:100%;color:#fff;box-shadow:0 25px 50px rgba(0,0,0,0.6);text-align:center;">
        <div style="width:48px;height:48px;background:rgba(59,130,246,0.1);border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto 16px;color:#3b82f6;font-size:20px;">🔒</div>
        <h2 id="gk-title" style="margin:0 0 8px;font-size:20px;font-weight:700;">Verify Access</h2>
        <p id="gk-desc" style="margin:0 0 20px;font-size:14px;color:#94a3b8;line-height:1.5;">Enter the email you used during checkout to unlock this tool.</p>
        <div id="gk-error" style="display:none;background:rgba(239,68,68,0.1);border:1px solid #ef4444;color:#fca5a5;padding:10px;border-radius:8px;font-size:13px;margin-bottom:16px;"></div>
        <input id="gk-input" type="email" placeholder="name@example.com" style="width:100%;padding:12px 14px;border-radius:8px;border:1px solid #334155;background:#0b1120;color:#fff;font-size:15px;box-sizing:border-box;margin-bottom:16px;outline:none;" />
        <button id="gk-btn" style="width:100%;padding:12px;border-radius:8px;border:none;background:#3b82f6;color:#fff;font-size:15px;font-weight:600;cursor:pointer;">Send Verification Code</button>
      </div>
    `;

    document.body.appendChild(overlay);

    const input = document.getElementById("gk-input");
    const btn = document.getElementById("gk-btn");
    const errBox = document.getElementById("gk-error");
    const title = document.getElementById("gk-title");
    const desc = document.getElementById("gk-desc");

    let savedEmail = "";

    btn.addEventListener("click", async () => {
      errBox.style.display = "none";

      if (input.type === "email") {
        const email = input.value.trim().toLowerCase();
        if (!email) {
          errBox.innerText = "Please enter your email.";
          errBox.style.display = "block";
          return;
        }

        btn.innerText = "Checking...";
        btn.disabled = true;

        try {
          const res = await fetch(`${apiBase}/api/auth/request-otp`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email, productId }),
          });
          const data = await res.json();

          if (!res.ok) {
            errBox.innerText =
              data.error || "No active purchase found for this email.";
            errBox.style.display = "block";
            btn.innerText = "Send Verification Code";
            btn.disabled = false;
            return;
          }

          savedEmail = email;
          title.innerText = "Enter 6-Digit Code";
          desc.innerText = `We sent a code to ${email}.`;
          input.value = "";
          input.type = "text";
          input.placeholder = "123456";
          input.maxLength = 6;
          btn.innerText = "Unlock Tool";
          btn.disabled = false;
        } catch (err) {
          errBox.innerText = "Network error. Please try again.";
          errBox.style.display = "block";
          btn.innerText = "Send Verification Code";
          btn.disabled = false;
        }
      } else {
        const otpCode = input.value.trim();
        if (otpCode.length !== 6) {
          errBox.innerText = "Please enter a 6-digit code.";
          errBox.style.display = "block";
          return;
        }

        btn.innerText = "Verifying...";
        btn.disabled = true;

        try {
          const res = await fetch(`${apiBase}/api/auth/verify-otp`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email: savedEmail, productId, otpCode }),
          });
          const data = await res.json();

          if (!res.ok) {
            errBox.innerText = data.error || "Invalid or expired code.";
            errBox.style.display = "block";
            btn.innerText = "Unlock Tool";
            btn.disabled = false;
            return;
          }

          localStorage.setItem(emailKey, savedEmail);
          localStorage.setItem(tokenKey, data.sessionToken);
          unlockPage(savedEmail);
        } catch (err) {
          errBox.innerText = "Verification failed. Try again.";
          errBox.style.display = "block";
          btn.innerText = "Unlock Tool";
          btn.disabled = false;
        }
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", checkSession);
  } else {
    checkSession();
  }
})();
