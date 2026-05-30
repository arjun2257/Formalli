import React, { useEffect, useState } from "react";
import axios from "axios";
import { io } from "socket.io-client";
import "./App.css";

const socket = io("http://localhost:5000");

function App() {
  const [user, setUser] = useState(null);
  const [login, setLogin] = useState({
    username: "",
    password: ""
  });

  const [message, setMessage] = useState("");
  const [messages, setMessages] = useState([]);
  const [notification, setNotification] = useState("");

  useEffect(() => {
    socket.on("receive-message", (data) => {
      setMessages((prev) => [...prev, data]);
    });

    socket.on("online-notification", (data) => {
      setNotification(data.message);

      setTimeout(() => {
        setNotification("");
      }, 4000);
    });

    socket.on("system-message", (data) => {
      setMessages((prev) => [
        ...prev,
        {
          sender: "SYSTEM",
          color: "gray",
          message: data.message,
          time: new Date().toLocaleTimeString()
        }
      ]);
    });

    return () => {
      socket.off("receive-message");
      socket.off("online-notification");
      socket.off("system-message");
    };
  }, []);

  const handleLogin = async () => {
    try {
      const res = await axios.post("http://localhost:5000/login", login);
      setUser(res.data);
      socket.emit("join-room", res.data);
    } catch (error) {
      alert("Invalid username or password");
    }
  };

  const sendMessage = () => {
    if (!message.trim()) return;

    socket.emit("send-message", {
      sender: user.displayName,
      color: user.color,
      message
    });

    setMessage("");
  };

  const markOnline = () => {
    socket.emit("i-am-online", user);
  };

  if (!user) {
    return (
      <div className="login-page">
        <div className="login-box">
          <h2>Login</h2>

          <input
            type="text"
            placeholder="User ID"
            value={login.username}
            onChange={(e) =>
              setLogin({ ...login, username: e.target.value })
            }
          />

          <input
            type="password"
            placeholder="Password"
            value={login.password}
            onChange={(e) =>
              setLogin({ ...login, password: e.target.value })
            }
          />

          <button onClick={handleLogin}>Login</button>

          <p className="hint">
            green / green123 <br />
            blue / blue123
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="chat-page">
      <div className="chat-header">
        <h2>ForMalli</h2>

        <div>
          <span style={{ color: user.color }}>
            Logged in as {user.displayName}
          </span>

          <button onClick={markOnline}>I am online</button>
        </div>
      </div>

      {notification && (
        <div className="notification">
          {notification}
        </div>
      )}

      <div className="terminal">
        {messages.map((msg, index) => (
          <div key={index} className="chat-line">
            <span style={{ color: msg.color, fontWeight: "bold" }}>
              {msg.sender}
            </span>

            <span className="time"> [{msg.time}] </span>

            <span style={{ color: msg.color }}>
              : {msg.message}
            </span>
          </div>
        ))}
      </div>

      <div className="input-area">
        <span className="prompt" style={{ color: user.color }}>
          {user.displayName}&gt;
        </span>

        <input
          type="text"
          value={message}
          placeholder="Type message..."
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") sendMessage();
          }}
        />

        <button onClick={sendMessage}>Send</button>
      </div>
    </div>
  );
}

export default App;