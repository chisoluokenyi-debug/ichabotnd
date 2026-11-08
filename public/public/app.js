
"use strict";

const $ = id => document.getElementById(id);

let selectedPage = "";

async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || "Request failed.");
  }

  return data;
}

function notice(message) {
  $("notice").textContent = message;
}

async function checkLogin() {
  try {
    const data = await api("/api/me");
    $("auth").hidden = true;
    $("dashboard").hidden = false;
    $("logoutBtn").hidden = false;
    notice("Signed in as " + data.user.email);
    await loadPages();
    await loadCampaigns();
    await loadSummary();
  } catch {
    $("auth").hidden = false;
    $("dashboard").hidden = true;
    $("logoutBtn").hidden = true;
  }
}

$("loginBtn").addEventListener("click", async event => {
  event.preventDefault();

  try {
    const data = await api("/api/login", {
      method: "POST",
      body: JSON.stringify({
        email: $("email").value,
        password: $("password").value
      })
    });

    notice(data.message);
    await checkLogin();
  } catch (err) {
    alert(err.message);
  }
});

$("registerBtn").addEventListener("click", async () => {
  try {
    const data = await api("/api/register", {
      method: "POST",
      body: JSON.stringify({
        email: $("email").value,
        password: $("password").value
      })
    });

    alert(data.message);
  } catch (err) {
    alert(err.message);
  }
});

$("logoutBtn").addEventListener("click", async () => {
  try {
    await api("/api/logout", { method: "POST" });
    location.reload();
  } catch (err) {
    alert(err.message);
  }
});

$("facebookBtn").addEventListener("click", () => {
  location.href = "/api/facebook/start";
});

async function loadPages() {
  const data = await api("/api/pages");
  const select = $("pageSelect");

  select.innerHTML = "";

  if (!data.pages.length) {
    select.add(new Option("Connect a Facebook Page first", ""));
    selectedPage = "";
    return;
  }

  data.pages.forEach(page => {
    select.add(new Option(page.page_name, page.page_id));
  });

  selectedPage = select.value;
}

$("pageSelect").addEventListener("change", event => {
  selectedPage = event.target.value;
});

$("refreshBtn").addEventListener("click", async () => {
  try {
    await loadPages();
    notice("Page list refreshed.");
  } catch (err) {
    alert(err.message);
  }
});

async function saveRule(type) {
  if (!selectedPage) {
    alert("Connect and select a Facebook Page first.");
    return;
  }

  const messenger = type === "messenger";

  const keyword = $(messenger ? "messageKeyword" : "commentKeyword").value;
  const reply = $(messenger ? "messageReply" : "commentReply").value;
  const isDefault = $(messenger ? "messageDefault" : "commentDefault").checked;
  const isWelcome = messenger && $("messageWelcome").checked;

  try {
    const data = await api(`/api/rules/${encodeURIComponent(selectedPage)}`, {
      method: "POST",
      body: JSON.stringify({
        type,
        keyword,
        reply,
        isDefault,
        isWelcome
      })
    });

    notice(data.message);
  } catch (err) {
    alert(err.message);
  }
}

$("saveMessage").addEventListener("click", () => saveRule("messenger"));
$("saveComment").addEventListener("click", () => saveRule("comment"));

$("scheduleBtn").addEventListener("click", async () => {
  if (!selectedPage) {
    alert("Connect and select a Facebook Page first.");
    return;
  }

  const message = $("campaignMessage").value.trim();
  const time = $("campaignTime").value;

  if (!message || !time) {
    alert("Enter your message and schedule time.");
    return;
  }

  try {
    const data = await api("/api/campaigns", {
      method: "POST",
      body: JSON.stringify({
        pageId: selectedPage,
        message,
        scheduledAt: new Date(time).toISOString()
      })
    });

    notice(data.message);
    $("campaignMessage").value = "";
    $("campaignTime").value = "";
    await loadCampaigns();
  } catch (err) {
    alert(err.message);
  }
});

async function loadCampaigns() {
  try {
    const data = await api("/api/campaigns");
    const list = $("campaignList");
    list.innerHTML = "";

    if (!data.campaigns.length) {
      list.textContent = "No campaigns yet.";
      return;
    }

    data.campaigns.forEach(campaign => {
      const item = document.createElement("article");
      const heading = document.createElement("strong");
      heading.textContent = "Campaign #" + campaign.id + " — " + campaign.status;

      const details = document.createElement("p");
      details.textContent =
        "Scheduled: " + new Date(campaign.scheduled_at).toLocaleString() +
        " | Sent: " + campaign.sent_count +
        " | Failed: " + campaign.failed_count;

      item.append(heading, details);
      list.append(item);
    });
  } catch (err) {
    $("campaignList").textContent = err.message;
  }
}

async function loadSummary() {
  try {
    const data = await api("/api/dashboard");
    $("summary").textContent = JSON.stringify(data, null, 2);
  } catch (err) {
    $("summary").textContent = err.message;
  }
}

$("campaignRefresh").addEventListener("click", loadCampaigns);
$("summaryRefresh").addEventListener("click", loadSummary);

checkLogin();

const params = new URLSearchParams(location.search);
if (params.get("facebook") === "connected") {
  notice("Facebook connection completed. Refresh your Pages.");
  history.replaceState({}, "", "/");
}
