const form = document.querySelector("#login-form");
const errorBox = document.querySelector("#login-error");
const passkeyButton = document.querySelector("#passkey-login-button");
const passkeyHint = document.querySelector("#passkey-hint");
let passkeyInProgress = false;

initializePasskeyLogin();

async function initializePasskeyLogin() {
  if (!window.PublicKeyCredential || !window.kqhPasskey) return;
  try {
    const response = await fetch("/api/local-auth/passkey/status", { cache: "no-store" });
    const status = await response.json();
    if (status.available) {
      passkeyButton.hidden = false;
      passkeyHint.hidden = false;
      if (new URLSearchParams(location.search).get("next") === "/admin") {
        void startPasskeyLogin({ automatic: true });
      }
    }
  } catch { /* keep password login available */ }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = form.querySelector("button");
  const data = new FormData(form);
  errorBox.hidden = true;
  button.disabled = true;
  button.firstElementChild.textContent = "正在确认身份";
  try {
    const response = await fetch("/api/local-auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: data.get("username"), password: data.get("password") }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.message || "登录没有完成。");
    const requested = new URLSearchParams(location.search).get("next");
    location.assign(requested === "/admin" ? requested : payload.redirect || "/admin");
  } catch (error) {
    errorBox.textContent = error.message;
    errorBox.hidden = false;
  } finally {
    button.disabled = false;
    button.firstElementChild.textContent = "进入管理设置";
  }
});

passkeyButton.addEventListener("click", () => startPasskeyLogin());

async function startPasskeyLogin({ automatic = false } = {}) {
  if (passkeyInProgress) return;
  passkeyInProgress = true;
  const username = automatic ? "" : String(form.elements.username.value || "").trim();
  passkeyButton.disabled = true;
  passkeyButton.textContent = "等待设备验证";
  try {
    const optionPayload = await api("/api/local-auth/passkey/login/options", username ? { username } : {});
    const credential = await navigator.credentials.get({ publicKey: window.kqhPasskey.authenticationOptions(optionPayload.options) });
    if (!credential) throw new Error("没有取得 Passkey 凭据。");
    const payload = await api("/api/local-auth/passkey/login/verify", { credential: window.kqhPasskey.credentialToJSON(credential) });
    const requested = new URLSearchParams(location.search).get("next");
    location.assign(requested === "/admin" ? requested : payload.redirect || "/admin");
  } catch (error) {
    showError(automatic && error.name === "NotAllowedError" ? "请点击“使用 Passkey 登录”重试。" : error.message || "Passkey 登录没有完成。");
  } finally {
    passkeyButton.disabled = false;
    passkeyButton.textContent = "使用 Passkey 登录";
    passkeyInProgress = false;
  }
}

function showError(message) {
  errorBox.textContent = message;
  errorBox.hidden = false;
}

async function api(url, body) {
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.message || `请求失败 (${response.status})`);
  return payload;
}
