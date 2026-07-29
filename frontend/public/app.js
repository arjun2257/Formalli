"use strict";

const $ = (id) => document.getElementById(id);
const SESSION_KEY = "formalli-session-v2";
const NOTIFICATION_KEY = "formalli-notifications-v2";

const normalizeUrl = (value) => String(value || "").trim().replace(/\/$/, "");
const resolveBackendUrl = () => {
  const configured = normalizeUrl(window.FORMALLI_CONFIG?.backendUrl);
  if (configured) return configured;

  const host = window.location.hostname;
  const localOrLan =
    host === "localhost" ||
    host === "127.0.0.1" ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host);
  return localOrLan ? `http://${host}:5000` : "";
};

const BACKEND_URL = resolveBackendUrl();
let session = null;
let socket = null;
let serviceWorkerRegistration = null;
let toastTimer = null;
let incomingVideoRequest = null;
let videoAccess = null;
let notificationsEnabled = localStorage.getItem(NOTIFICATION_KEY) === "true";
let partnerUsername = "";

const setAppHeight = () => {
  const height = window.visualViewport?.height || window.innerHeight;
  document.documentElement.style.setProperty("--app-height", `${height}px`);
};
setAppHeight();
window.addEventListener("resize", setAppHeight);
window.visualViewport?.addEventListener("resize", setAppHeight);

const showElement = (element, visible) => element.classList.toggle("hidden", !visible);
const showToast = (text, timeout = 5000) => {
  clearTimeout(toastTimer);
  $("toast").textContent = text;
  showElement($("toast"), true);
  toastTimer = setTimeout(() => showElement($("toast"), false), timeout);
};
const showLoginMessage = (text) => {
  $("loginMessage").textContent = text;
  showElement($("loginMessage"), Boolean(text));
};

const api = async (path, options = {}) => {
  if (!BACKEND_URL) throw new Error("Backend URL is not configured.");
  const response = await fetch(`${BACKEND_URL}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || `Request failed (${response.status})`);
  return body;
};

const updateNotificationButtons = () => {
  $("notificationButton").textContent = notificationsEnabled
    ? "Notifications On"
    : "Enable Notifications";
  $("notificationButton").classList.toggle("active-button", notificationsEnabled);
  showElement($("notificationTestButton"), notificationsEnabled);
};

const registerServiceWorker = async () => {
  if (!("serviceWorker" in navigator)) return null;
  try {
    serviceWorkerRegistration = await navigator.serviceWorker.register(
      "/service-worker.js",
      { scope: "/" }
    );
    return serviceWorkerRegistration;
  } catch (error) {
    console.error("Service worker registration failed:", error);
    return null;
  }
};
registerServiceWorker();

const showBrowserNotification = async (title, body, tag) => {
  if (!notificationsEnabled || Notification.permission !== "granted") return;
  try {
    const registration =
      serviceWorkerRegistration || (await navigator.serviceWorker.ready);
    await registration.showNotification(title, {
      body,
      icon: "/favicon.svg",
      badge: "/favicon.svg",
      tag: tag || "formalli-notification",
      renotify: true,
      vibrate: [150, 80, 150],
      data: { url: "/" }
    });
  } catch (error) {
    console.error("Chrome notification failed:", error);
    showToast(`Notification failed: ${error.message}`, 7000);
  }
};

const updateSocketNotificationSetting = () => {
  if (!socket?.connected) return;
  socket.emit("notification-settings", { enabled: notificationsEnabled });
};

const enableNotifications = async () => {
  if (!window.isSecureContext) {
    throw new Error(
      "Chrome notifications require HTTPS. They cannot work from http://10.x.x.x. Use the Vercel HTTPS URL."
    );
  }
  if (!("Notification" in window) || !("serviceWorker" in navigator)) {
    throw new Error("Notifications are not supported in this browser.");
  }

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error("Permission was not granted. Enable notifications in Chrome site settings.");
  }

  await registerServiceWorker();
  notificationsEnabled = true;
  localStorage.setItem(NOTIFICATION_KEY, "true");
  updateNotificationButtons();
  updateSocketNotificationSetting();
  await showBrowserNotification(
    "ForMalli notifications enabled",
    "Chrome notifications are ready while ForMalli is open or running in the background.",
    "formalli-test"
  );
  showToast("Notifications enabled. A test notification was shown.");
};

const disableNotifications = () => {
  notificationsEnabled = false;
  localStorage.removeItem(NOTIFICATION_KEY);
  updateNotificationButtons();
  updateSocketNotificationSetting();
  showToast("Notifications disabled on this device.");
};

const appendMessage = (item) => {
  if (document.querySelector(`[data-message-id="${CSS.escape(item.id)}"]`)) return;
  showElement($("emptyChat"), false);

  const article = document.createElement("article");
  article.className = "chat-message";
  article.dataset.messageId = item.id;

  const meta = document.createElement("div");
  meta.className = "message-meta";
  const sender = document.createElement("strong");
  sender.textContent = item.sender;
  sender.style.color = item.color;
  const time = document.createElement("time");
  time.textContent = item.time;
  meta.append(sender, time);

  const text = document.createElement("div");
  text.className = "message-text";
  text.textContent = item.message;

  article.append(meta, text);
  $("messages").appendChild(article);
  $("terminalEnd").scrollIntoView({ block: "end" });
};

const setChatStatus = (text, type = "warning") => {
  $("chatStatus").textContent = `Chat: ${text}`;
  $("chatStatus").className = type;
};

const updatePresence = (state) => {
  const online = Boolean(state?.[partnerUsername]);
  $("partnerStatus").textContent = `Partner: ${online ? "Online" : "Offline"}`;
  $("partnerStatus").className = online ? "ok" : "muted";
};

const emitWithAck = (event, payload = {}) =>
  new Promise((resolve, reject) => {
    if (!socket?.connected) return reject(new Error("Chat is reconnecting. Try again shortly."));
    socket.timeout(10000).emit(event, payload, (timeoutError, response) => {
      if (timeoutError) return reject(new Error("Backend response timed out."));
      if (!response?.ok) return reject(new Error(response?.message || "Operation failed."));
      resolve(response);
    });
  });

const connectSocket = () => {
  socket?.disconnect();
  setChatStatus("Connecting");

  socket = io(BACKEND_URL, {
    auth: { token: session.token },
    transports: ["polling", "websocket"],
    upgrade: true,
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 750,
    reconnectionDelayMax: 5000,
    timeout: 20000
  });

  socket.on("connect", () => {
    setChatStatus("Connected", "ok");
    updateSocketNotificationSetting();
  });
  socket.on("disconnect", () => setChatStatus("Reconnecting"));
  socket.on("connect_error", (error) => {
    if (error.message === "unauthorized") {
      sessionStorage.removeItem(SESSION_KEY);
      session = null;
      socket.disconnect();
      showElement($("chatPage"), false);
      showElement($("loginPage"), true);
      showLoginMessage("Session expired. Please log in again.");
      return;
    }
    setChatStatus("Connection error", "warning");
    showToast(`Backend socket connection failed: ${error.message}`, 7000);
  });
  socket.on("chat-history", (history) => {
    $("messages").replaceChildren();
    showElement($("emptyChat"), !(Array.isArray(history) && history.length));
    (history || []).forEach(appendMessage);
  });
  socket.on("receive-message", (item) => {
    appendMessage(item);
    if (item.username !== session.user.username && document.hidden) {
      showBrowserNotification(
        `${item.sender} sent a message`,
        item.message.length > 120 ? `${item.message.slice(0, 117)}...` : item.message,
        `message-${item.id}`
      );
    }
  });
  socket.on("presence-state", updatePresence);
  socket.on("online-notification", (data) => {
    showToast(data.message || "Your partner is online.");
    showBrowserNotification(data.title || "ForMalli", data.message, "online-status");
  });
  socket.on("video-call-request", (data) => {
    incomingVideoRequest = data;
    $("incomingVideoText").textContent = `${data.from} requested a Google Meet call.`;
    showElement($("incomingVideoPanel"), true);
    $("videoStatus").textContent = "Video: Admission requested";
    showBrowserNotification(
      "ForMalli video request",
      `${data.from} requested a Google Meet call. Open ForMalli to Admit or Reject.`,
      `video-${data.requestId}`
    );
  });
  socket.on("video-call-approved", (access) => {
    videoAccess = access;
    incomingVideoRequest = null;
    showElement($("incomingVideoPanel"), false);
    showElement($("approvedVideoPanel"), true);
    $("videoStatus").textContent = "Video: Admitted";
    showToast("Video call admitted. Tap Join Meet.", 8000);
    showBrowserNotification(
      "Google Meet admitted",
      "Open ForMalli and tap Join Meet.",
      `approved-${access.requestId}`
    );
  });
  socket.on("video-call-rejected", (data) => {
    $("videoStatus").textContent = "Video: Rejected";
    showToast(`${data.rejectedBy || "Partner"} rejected the video request.`);
  });
};

const openChat = () => {
  const user = session.user;
  partnerUsername = user.username === "green" ? "malli" : "green";
  $("identity").textContent = `Logged in as ${user.displayName}`;
  $("identity").style.color = user.color;
  $("prompt").textContent = `${user.displayName}>`;
  $("prompt").style.color = user.color;
  showElement($("loginPage"), false);
  showElement($("chatPage"), true);
  updateNotificationButtons();
  connectSocket();
};

const login = async () => {
  const username = $("username").value.trim().toLowerCase();
  const password = $("password").value;
  if (!username || !password) return showLoginMessage("Enter username and password.");

  $("loginButton").disabled = true;
  $("loginButton").textContent = "Connecting...";
  showLoginMessage("");
  try {
    const result = await api("/api/login", {
      method: "POST",
      body: JSON.stringify({ username, password })
    });
    session = result;
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
    $("password").value = "";
    openChat();
  } catch (error) {
    showLoginMessage(error.message);
  } finally {
    $("loginButton").disabled = false;
    $("loginButton").textContent = "Login";
  }
};

$("loginButton").addEventListener("click", login);
$("password").addEventListener("keydown", (event) => {
  if (event.key === "Enter") login();
});
$("logoutButton").addEventListener("click", () => {
  socket?.disconnect();
  socket = null;
  session = null;
  sessionStorage.removeItem(SESSION_KEY);
  $("messages").replaceChildren();
  showElement($("emptyChat"), true);
  showElement($("chatPage"), false);
  showElement($("loginPage"), true);
});
$("notificationButton").addEventListener("click", async () => {
  try {
    if (notificationsEnabled) disableNotifications();
    else await enableNotifications();
  } catch (error) {
    showToast(error.message, 9000);
  }
});
$("notificationTestButton").addEventListener("click", async () => {
  await showBrowserNotification(
    "ForMalli test notification",
    "Chrome notifications are working on this device.",
    `test-${Date.now()}`
  );
  showToast("Test notification requested.");
});
$("onlineButton").addEventListener("click", async () => {
  try {
    const result = await emitWithAck("i-am-online");
    showToast(result.message);
  } catch (error) {
    showToast(error.message);
  }
});
$("videoButton").addEventListener("click", async () => {
  try {
    const result = await emitWithAck("request-video-call");
    $("videoStatus").textContent = "Video: Waiting for admission";
    showToast(result.message);
  } catch (error) {
    showToast(error.message);
  }
});
$("admitButton").addEventListener("click", async () => {
  try {
    const result = await emitWithAck("admit-video-call", {
      requestId: incomingVideoRequest.requestId
    });
    videoAccess = result.access;
    incomingVideoRequest = null;
    showElement($("incomingVideoPanel"), false);
    showElement($("approvedVideoPanel"), true);
    $("videoStatus").textContent = "Video: Admitted";
  } catch (error) {
    showToast(error.message);
  }
});
$("rejectButton").addEventListener("click", async () => {
  try {
    await emitWithAck("reject-video-call", { requestId: incomingVideoRequest.requestId });
    incomingVideoRequest = null;
    showElement($("incomingVideoPanel"), false);
    $("videoStatus").textContent = "Video: Rejected";
  } catch (error) {
    showToast(error.message);
  }
});
$("joinMeetButton").addEventListener("click", () => {
  if (videoAccess?.meetUrl) window.location.assign(videoAccess.meetUrl);
});
$("closeMeetButton").addEventListener("click", () => {
  videoAccess = null;
  showElement($("approvedVideoPanel"), false);
  $("videoStatus").textContent = "Video: Idle";
});
$("sendButton").addEventListener("click", async () => {
  const message = $("messageInput").value.trim();
  if (!message) return;
  try {
    await emitWithAck("send-message", { message });
    $("messageInput").value = "";
    $("sendButton").disabled = true;
    $("messageInput").focus();
  } catch (error) {
    showToast(error.message);
  }
});
$("messageInput").addEventListener("input", () => {
  $("sendButton").disabled = !$("messageInput").value.trim() || !socket?.connected;
});
$("messageInput").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    $("sendButton").click();
  }
});

const initialize = async () => {
  $("backendUrl").textContent = BACKEND_URL || "Missing BACKEND_URL in Vercel";
  if (!BACKEND_URL) {
    $("backendStatus").textContent = "Backend: not configured";
    $("configError").innerHTML =
      "Add <b>BACKEND_URL=https://YOUR-SERVICE.onrender.com</b> in Vercel and redeploy.";
    showElement($("configError"), true);
    $("loginButton").disabled = true;
    return;
  }

  try {
    await api("/healthz");
    $("backendStatus").textContent = "Backend: online";
  } catch (error) {
    $("backendStatus").textContent = "Backend: waking/offline";
    showLoginMessage(`Backend connection failed: ${error.message}`);
  }

  try {
    session = JSON.parse(sessionStorage.getItem(SESSION_KEY));
    if (session?.token && session?.user) openChat();
    else session = null;
  } catch {
    sessionStorage.removeItem(SESSION_KEY);
  }
};

initialize();
