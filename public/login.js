const form = document.querySelector("#login-form");
const errorBox = document.querySelector("#login-error");

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
