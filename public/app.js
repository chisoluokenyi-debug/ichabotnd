const $ = (id) => document.getElementById(id);

async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Request failed.");
  return data;
}

function notice(message, isError = false) {
  const el = $("notice");
  if (!el) return;
  el.textContent = message;
  el.style.color = isError ? "#b42318" : "#1768c4";
}

function showLoggedOut() {
  $("auth").hidden = false;
  $("dashboard").hidden = true;
  $("logoutBtn").hidden = true;
}

function showLoggedIn(data) {
  $("auth").hidden = true;
  $("dashboard").hidden = false;
  $("logoutBtn").hidden = false;
  const select = $("pageSelect");
  select.innerHTML = "";
  if (!data.pages || !data.pages.length) {
    select.add(new Option("No Facebook Page connected", ""));
  } else {
    data.pages.forEach(page => select.add(new Option(page.page_name, page.page_id)));
    select.value = data.selectedPageId || data.pages[0].page_id;
  }
  if (!data.pages || !data.pages.length) {
    notice("Login succeeded, but no Facebook Pages were returned. Check Page permissions in Meta.");
  } else {
    notice("Connected. Choose a Page to manage.");
    loadSettings();
    loadBroadcasts();
  }
}

async function loadMe() {
  try {
    const data = await api("/api/me");
    if (!data.loggedIn) return showLoggedOut();
    showLoggedIn(data);
  } catch (error) {
    showLoggedOut();
    notice(error.message, true);
  }
}

async function loadSettings() {
  try {
    const s = await api("/api/settings");
    $("messageWelcome").checked = !!s.welcome_enabled;
    $("welcomeMessage").value = s.welcome_message || "";
    $("messageDefault").checked = !!s.default_enabled;
    $("defaultReply").value = s.default_reply || "";
    $("commentDefault").checked = !!s.comment_enabled;
    $("commentReply").value = s.comment_reply || "";
  } catch (error) { notice(error.message, true); }
}

async function saveSettings() {
  try {
    await api("/api/settings", {
      method: "POST",
      body: JSON.stringify({
        welcome_enabled: $("messageWelcome").checked,
        welcome_message: $("welcomeMessage").value,
        default_enabled: $("messageDefault").checked,
        default_reply: $("defaultReply").value,
        comment_enabled: $("commentDefault").checked,
        comment_reply: $("commentReply").value
      })
    });
    notice("Settings saved successfully.");
  } catch (error) { notice(error.message, true); }
}

async function loadBroadcasts() {
  try {
    const rows = await api("/api/broadcasts");
    const list = $("campaignList");
    list.replaceChildren();
    if (!rows.length) {
      list.textContent = "No broadcasts yet.";
      return;
    }
    rows.forEach(item => {
      const article = document.createElement("article");
      const title = document.createElement("strong");
      title.textContent = item.status + " — " + (item.sent_count || 0) + " sent, " + (item.failed_count || 0) + " failed";
      const message = document.createElement("p");
      message.textContent = item.message;
      const when = document.createElement("small");
      when.textContent = item.scheduled_at ? new Date(item.scheduled_at).toLocaleString() : new Date(item.created_at).toLocaleString();
      article.append(title, message, when);
      list.append(article);
    });
  } catch (error) { notice(error.message, true); }
}

async function submitBroadcast() {
  const message = $("campaignMessage").value.trim();
  const localDate = $("campaignTime").value;
  if (!message) return notice("Enter a broadcast message.", true);
  const payload = { message };
  if (localDate) payload.scheduledAt = new Date(localDate).toISOString();
  try {
    const result = await api("/api/broadcasts", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    notice(result.message || "Broadcast request completed.");
    $("campaignMessage").value = "";
    $("campaignTime").value = "";
    await loadBroadcasts();
  } catch (error) { notice(error.message, true); }
}

document.addEventListener("DOMContentLoaded", () => {
  $("facebookLoginBtn").addEventListener("click", () => {
    window.location.href = "/auth/facebook";
  });
  $("logoutBtn").addEventListener("click", () => {
    window.location.href = "/auth/logout";
  });
  $("refreshBtn").addEventListener("click", loadMe);
  $("pageSelect").addEventListener("change", async event => {
    try {
      await api("/api/pages/select", {
        method: "POST",
        body: JSON.stringify({ pageId: event.target.value })
      });
      await loadSettings();
      await loadBroadcasts();
      notice("Facebook Page selected.");
    } catch (error) { notice(error.message, true); }
  });
  $("saveMessage").addEventListener("click", saveSettings);
  $("saveComment").addEventListener("click", saveSettings);
  $("scheduleBtn").addEventListener("click", submitBroadcast);
  $("campaignRefresh").addEventListener("click", loadBroadcasts);
  loadMe();
});
