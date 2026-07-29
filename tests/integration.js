"use strict";
const { io } = require("socket.io-client");

const baseUrl = process.env.TEST_URL || "http://127.0.0.1:5000";

const login = async (username, password) => {
  const response = await fetch(`${baseUrl}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password })
  });
  if (!response.ok) throw new Error(`Login failed for ${username}: ${response.status}`);
  return response.json();
};

const waitFor = (socket, event, timeout = 5000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${event}`)), timeout);
    socket.once(event, (data) => {
      clearTimeout(timer);
      resolve(data);
    });
  });

const emitAck = (socket, event, payload = {}) =>
  new Promise((resolve, reject) => {
    socket.timeout(5000).emit(event, payload, (error, response) => {
      if (error) reject(error);
      else resolve(response);
    });
  });

(async () => {
  const green = await login("green", "W@||!@");
  const malli = await login("malli", "MALLI");

  const greenSocket = io(baseUrl, { auth: { token: green.token }, transports: ["polling", "websocket"] });
  const malliSocket = io(baseUrl, { auth: { token: malli.token }, transports: ["polling", "websocket"] });
  await Promise.all([waitFor(greenSocket, "connect"), waitFor(malliSocket, "connect")]);

  await emitAck(malliSocket, "notification-settings", { enabled: true });
  const onlineEvent = waitFor(malliSocket, "online-notification");
  const onlineAck = await emitAck(greenSocket, "i-am-online");
  await onlineEvent;
  if (!onlineAck.ok || onlineAck.delivered < 1) throw new Error("Online notification failed");

  const receivedMessage = waitFor(malliSocket, "receive-message");
  const messageAck = await emitAck(greenSocket, "send-message", { message: "integration test" });
  const message = await receivedMessage;
  if (!messageAck.ok || message.message !== "integration test") throw new Error("Message failed");

  const requestEvent = waitFor(malliSocket, "video-call-request");
  const requestAck = await emitAck(greenSocket, "request-video-call");
  const request = await requestEvent;
  if (!requestAck.ok) throw new Error("Video request failed");

  const greenApproved = waitFor(greenSocket, "video-call-approved");
  const malliApproved = waitFor(malliSocket, "video-call-approved");
  const admitAck = await emitAck(malliSocket, "admit-video-call", { requestId: request.requestId });
  const [a, b] = await Promise.all([greenApproved, malliApproved]);
  if (!admitAck.ok || !a.meetUrl || a.meetUrl !== b.meetUrl) throw new Error("Video admission failed");

  greenSocket.disconnect();
  malliSocket.disconnect();
  console.log("Integration test passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
