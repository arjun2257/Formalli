const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

const app = express();

/**
 * Allowed frontend URLs
 * Local React: http://localhost:3000
 * Online Vercel: https://formalli.vercel.app
 */
const allowedOrigins = [
  "http://localhost:3000",
  "https://formalli.vercel.app"
];

/**
 * Express CORS configuration
 */
app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    methods: ["GET", "POST", "OPTIONS"],
    credentials: true
  })
);

app.options("*", cors());
app.use(express.json());

const server = http.createServer(app);

/**
 * Socket.IO CORS configuration
 */
const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST", "OPTIONS"],
    credentials: true
  }
});

/**
 * Two private users only
 */
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

/**
 * Health check route for Render
 */
app.get("/", (req, res) => {
  res.send("Secret Chat Backend is running");
});

/**
 * Login API
 */
app.post("/login", (req, res) => {
  const { username, password } = req.body;

  console.log("Login request:", username);

  const user = users[username];

  if (!user || user.password !== password) {
    console.log("Login failed:", username);

    return res.status(401).json({
      message: "Invalid username or password"
    });
  }

  console.log("Login success:", username);

  return res.json({
    username: user.username,
    displayName: user.displayName,
    color: user.color
  });
});

/**
 * Socket.IO real-time chat handling
 */
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

/**
 * Render uses process.env.PORT
 * Local uses 5000
 */
const PORT = process.env.PORT || 5000;

server.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
});
