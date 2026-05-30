import React, { useEffect, useMemo, useRef, useState } from "react";
import axios from "axios";
import { io } from "socket.io-client";
import "./App.css";

const BACKEND_URL =
  process.env.REACT_APP_BACKEND_URL || "http://localhost:5000";

function App() {
  const socket = useMemo(() => {
    return io(BACKEND_URL, {
      transports: ["websocket", "polling"],
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000
    });
  }, []);

  const peerConnectionRef = useRef(null);
  const localStreamRef = useRef(null);
  const remoteAudioRef = useRef(null);
  const incomingOfferRef = useRef(null);

  const [user, setUser] = useState(null);

  const [login, setLogin] = useState({
    username: "",
    password: ""
  });

  const [message, setMessage] = useState("");
  const [messages, setMessages] = useState([]);
  const [notification, setNotification] = useState("");
  const [isConnecting, setIsConnecting] = useState(false);

  const [callStatus, setCallStatus] = useState("Idle");
  const [incomingCall, setIncomingCall] = useState(null);
  const [isInCall, setIsInCall] = useState(false);

  const createPeerConnection = () => {
    const peerConnection = new RTCPeerConnection({
      iceServers: [
        {
          urls: "stun:stun.l.google.com:19302"
        },
        {
          urls: "stun:stun1.l.google.com:19302"
        }
      ]
    });

    peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit("ice-candidate", {
          candidate: event.candidate
        });
      }
    };

    peerConnection.ontrack = (event) => {
      if (remoteAudioRef.current) {
        remoteAudioRef.current.srcObject = event.streams[0];
      }
    };

    peerConnection.onconnectionstatechange = () => {
      const state = peerConnection.connectionState;

      if (state === "connected") {
        setCallStatus("Talking...");
        setIsInCall(true);
      }

      if (state === "disconnected" || state === "failed" || state === "closed") {
        cleanupCall();
      }
    };

    peerConnectionRef.current = peerConnection;
    return peerConnection;
  };

  const getLocalAudioStream = async () => {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: false
    });

    localStreamRef.current = stream;
    return stream;
  };

  const cleanupCall = () => {
    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => track.stop());
      localStreamRef.current = null;
    }

    if (remoteAudioRef.current) {
      remoteAudioRef.current.srcObject = null;
    }

    incomingOfferRef.current = null;
    setIncomingCall(null);
    setIsInCall(false);
    setCallStatus("Idle");
  };

  useEffect(() => {
    socket.on("connect", () => {
      console.log("Socket connected:", socket.id);
    });

    socket.on("connect_error", (error) => {
      console.error("Socket connection error:", error.message);
      setNotification("Backend connection issue. Please wait and refresh.");
    });

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

    socket.on("incoming-call", async (data) => {
      incomingOfferRef.current = data.offer;
      setIncomingCall(data.from);
      setCallStatus(`Ringing from ${data.from}...`);
    });

    socket.on("call-accepted", async (data) => {
      if (!peerConnectionRef.current) return;

      await peerConnectionRef.current.setRemoteDescription(
        new RTCSessionDescription(data.answer)
      );

      setCallStatus("Talking...");
      setIsInCall(true);
    });

    socket.on("call-rejected", () => {
      alert("Call rejected");
      cleanupCall();
    });

    socket.on("ice-candidate", async (data) => {
      try {
        if (peerConnectionRef.current && data.candidate) {
          await peerConnectionRef.current.addIceCandidate(
            new RTCIceCandidate(data.candidate)
          );
        }
      } catch (error) {
        console.error("ICE candidate error:", error);
      }
    });

    socket.on("call-ended", () => {
      alert("Call ended");
      cleanupCall();
    });

    return () => {
      socket.off("connect");
      socket.off("connect_error");
      socket.off("receive-message");
      socket.off("online-notification");
      socket.off("system-message");
      socket.off("incoming-call");
      socket.off("call-accepted");
      socket.off("call-rejected");
      socket.off("ice-candidate");
      socket.off("call-ended");
      socket.disconnect();
      cleanupCall();
    };
  }, [socket]);

  const handleLogin = async () => {
    if (!login.username.trim() || !login.password.trim()) {
      alert("Please enter username and password");
      return;
    }

    try {
      setIsConnecting(true);

      const res = await axios.post(`${BACKEND_URL}/login`, login, {
        headers: {
          "Content-Type": "application/json"
        }
      });

      setUser(res.data);
      socket.emit("join-room", res.data);
    } catch (error) {
      console.error("Login error:", error);
      alert("Invalid username or password");
    } finally {
      setIsConnecting(false);
    }
  };

  const sendMessage = () => {
    if (!message.trim() || !user) return;

    socket.emit("send-message", {
      sender: user.displayName,
      color: user.color,
      message: message.trim()
    });

    setMessage("");
  };

  const markOnline = () => {
    if (!user) return;

    socket.emit("i-am-online", user);
  };

  const startCall = async () => {
    try {
      if (!user) return;

      setCallStatus("Calling...");

      const peerConnection = createPeerConnection();
      const stream = await getLocalAudioStream();

      stream.getTracks().forEach((track) => {
        peerConnection.addTrack(track, stream);
      });

      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);

      socket.emit("call-user", {
        from: user.displayName,
        offer
      });
    } catch (error) {
      console.error("Start call error:", error);
      alert("Unable to start call. Please allow microphone permission.");
      cleanupCall();
    }
  };

  const acceptCall = async () => {
    try {
      if (!incomingOfferRef.current) return;

      setCallStatus("Connecting call...");

      const peerConnection = createPeerConnection();
      const stream = await getLocalAudioStream();

      stream.getTracks().forEach((track) => {
        peerConnection.addTrack(track, stream);
      });

      await peerConnection.setRemoteDescription(
        new RTCSessionDescription(incomingOfferRef.current)
      );

      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);

      socket.emit("accept-call", {
        answer
      });

      setIncomingCall(null);
      setCallStatus("Talking...");
      setIsInCall(true);
    } catch (error) {
      console.error("Accept call error:", error);
      alert("Unable to accept call. Please allow microphone permission.");
      cleanupCall();
    }
  };

  const rejectCall = () => {
    socket.emit("reject-call", {
      from: user.displayName
    });

    cleanupCall();
  };

  const endCall = () => {
    socket.emit("end-call", {
      from: user.displayName
    });

    cleanupCall();
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
            onKeyDown={(e) => {
              if (e.key === "Enter") handleLogin();
            }}
          />

          <button onClick={handleLogin} disabled={isConnecting}>
            {isConnecting ? "Connecting..." : "Login"}
          </button>

          <p className="hint">Backend: {BACKEND_URL}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="chat-page">
      <audio ref={remoteAudioRef} autoPlay playsInline />

      <div className="chat-header">
        <h2>ForMalli</h2>

        <div className="header-actions">
          <span style={{ color: user.color }}>
            Logged in as {user.displayName}
          </span>

          <button onClick={markOnline}>I am online</button>

          {!isInCall && !incomingCall && (
            <button onClick={startCall}>Call</button>
          )}

          {isInCall && (
            <button onClick={endCall}>End Call</button>
          )}
        </div>
      </div>

      {notification && <div className="notification">{notification}</div>}

      <div className="call-status">
        Call Status: {callStatus}
      </div>

      {incomingCall && (
        <div className="incoming-call">
          <span>{incomingCall} is calling...</span>

          <button onClick={acceptCall}>Accept</button>
          <button onClick={rejectCall}>Reject</button>
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
