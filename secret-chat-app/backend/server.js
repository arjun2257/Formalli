const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

const app = express();

const allowedOrigins = [
  "http://localhost:3000",
  "https://your-vercel-app-name.vercel.app"
];

app.use(
  cors({
    origin: allowedOrigins,
    methods: ["GET", "POST"]
  })
);

app.use(express.json());

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST"]
  }
});

const users = {
  green: {
    username: "green",
    password: "W@||!@₹",
    displayName: "Green",
    color: "lime"
  },
  malli: {
    username: "malli",
    password: "Majunu",
    displayName: "Blue",
    color: "deepskyblue"
  }
};

app.get("/", (req, res) => {
  res.send("Secret Chat Backend is running");
});

app.post("/login", (req, res) => {
  const { username, password } = req.body;

  const user = users[username];

  if (!user || user.password !== password) {
    return res.status(401).json({
      message: "Invalid username or password"
    });
  }

  return res.json({
    username: user.username,
    displayName: user.displayName,
    color: user.color
  });
});

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  socket.on("join-room", (user) => {
    socket.join("secret-room");
    socket.user = user;

    socket.to("secret-room").emit("system-message", {
      message: `${user.displayName} joined the chat`
    });
  });

  socket.on("i-am-online", (user) => {
    socket.to("secret-room").emit("online-notification", {
      message: `${user.displayName} is online`,
      color: user.color
    });
  });

  socket.on("send-message", (data) => {
    io.to("secret-room").emit("receive-message", {
      sender: data.sender,
      color: data.color,
      message: data.message,
      time: new Date().toLocaleTimeString()
    });
  });

  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);

    if (socket.user) {
      socket.to("secret-room").emit("system-message", {
        message: `${socket.user.displayName} went offline`
      });
    }
  });
});

const PORT = process.env.PORT || 5000;

server.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
});
