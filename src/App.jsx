 
import React, { useState, useEffect, useRef } from "react";
import '@fortawesome/fontawesome-free/css/all.min.css';

import "./App.css";

export default function App() {
  const [topic, setTopic] = useState("");
  const [lesson, setLesson] = useState("");
  const [quiz, setQuiz] = useState([]);
  const [summary, setSummary] = useState("");
  const [selected, setSelected] = useState({});
  const [score, setScore] = useState(null);
  const [loading, setLoading] = useState(false);

  // --- NEW: Chat & Voice states ---
  const [chatMode, setChatMode] = useState(false); // toggle chat mode on/off
  const [messages, setMessages] = useState([]); // {role: 'user'|'assistant', content}
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef(null);

  // Helper: try to extract JSON from a text blob using regex (handles model wrappers)
  const extractJSON = (text) => {
    if (!text) return null;
    // first try direct parse
    try {
      return JSON.parse(text);
    } catch (e) {
      // try to find a JSON block inside text
      const jsonMatch = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
      if (jsonMatch) {
        try {
          return JSON.parse(jsonMatch[0]);
        } catch (e2) {
          console.warn("Failed to parse extracted JSON block", e2);
          return null;
        }
      }
      return null;
    }
  };

  const fetchLesson = async () => {
    if (!topic.trim()) return alert("Please enter a topic first!");
    setLoading(true);
    setLesson("");
    setQuiz([]);
    setSummary("");
    setScore(null);
    setSelected({});
    // reset chat context when new lesson is generated (keeps things tidy)
    setMessages([]);

    try {
      const payload = {
        model: "llama-3.1-8b-instant",
        temperature: 0.7, // increase for more variety, lower for deterministic
        messages: [
          {
            role: "system",
            content:
              "You are a concise teaching assistant. Always respond ONLY with valid JSON (no extra text). The JSON must contain: lesson (string), quiz (array of objects with q, a (array of 3 strings), correct (exact string answer)), summary (string). Keep lesson ~2-4 sentences, quiz length 2, summary 1 sentence.",
          },
          {
            role: "user",
            content: `Create a lesson for the topic: "${topic}". Return ONLY valid JSON with keys exactly: lesson, quiz, summary. Example quiz item: {"q":"...","a":["opt1","opt2","opt3"],"correct":"opt2"}. Do not include any explanation outside JSON.`,
          },
        ],
        max_tokens: 800,
      };

      const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.REACT_APP_GROQ_API_KEY}`,
        },
        body: JSON.stringify(payload),
      });

      const result = await response.json();
      // inspect model raw output in console for debugging
      const rawText = result?.choices?.[0]?.message?.content || result?.choices?.[0]?.text || "";
      console.log("Groq raw response:", rawText, result);

      // try to parse JSON or extract JSON block
      const parsed = extractJSON(rawText);

      if (parsed && parsed.lesson && parsed.quiz && parsed.summary) {
        setLesson(parsed.lesson);
        setQuiz(Array.isArray(parsed.quiz) ? parsed.quiz : []);
        setSummary(parsed.summary);
        localStorage.setItem("autotutor-progress", JSON.stringify({ topic, ...parsed }));
      } else {
        // If parsing fails, show the raw text (so you can see what the API returned)
        console.warn("Could not parse JSON from model. Showing raw text as lesson fallback.");
        setLesson(rawText || `Lesson generation failed for "${topic}". Check console.`);
        setQuiz([
          {
            q: `What is ${topic}?`,
            a: ["A function", "A concept", "A library"],
            correct: "A concept",
          },
          {
            q: `Why is ${topic} important?`,
            a: ["For styling", "For organization", "For memory"],
            correct: "For organization",
          },
        ]);
        setSummary(`${topic} helps developers write clean and maintainable code.`);
      }
    } catch (err) {
      console.error("Fetch error:", err);
      alert("Error connecting to Groq API — check console and your API key.");
    } finally {
      setLoading(false);
    }
  };

  // --- NEW: send chat message to Groq (conversational) ---
  const sendChatMessage = async (userText, speakResponse = true) => {
    if (!userText || chatLoading) return;
    // append user message to UI
    const userMsg = { role: "user", content: userText };
    setMessages((m) => {
      const next = [...m, userMsg];
      return next;
    });
    setChatInput("");
    setChatLoading(true);

    try {
      // Build a compact conversation array for the model: system + previous assistant/user messages (limit length for safety)
      const systemPrompt = {
        role: "system",
        content:
          "You are a helpful, concise teaching assistant. Answer the user's questions clearly and directly. When helpful, provide short code examples. Keep responses brief (2-6 sentences) unless the user asks for more detail.",
      };

      // convert our messages to model format; keep last ~10 messages to avoid long history
      const history = (messages || []).slice(-10).map((m) => ({ role: m.role, content: m.content }));
      // add current user message
      history.push(userMsg);

      const payload = {
        model: "llama-3.1-8b-instant",
        temperature: 0.6,
        messages: [systemPrompt, ...history],
        max_tokens: 600,
      };

      const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.REACT_APP_GROQ_API_KEY}`,
        },
        body: JSON.stringify(payload),
      });

      const result = await response.json();
      const rawText = result?.choices?.[0]?.message?.content || result?.choices?.[0]?.text || "";
      console.log("Groq chat raw response:", rawText, result);

      // append assistant message
      const assistantMsg = { role: "assistant", content: rawText };
      setMessages((m) => [...m, assistantMsg]);

      // speak the response if allowed
      if (speakResponse && rawText) {
        speakText(rawText);
      }
    } catch (err) {
      console.error("Chat error:", err);
      const errMsg = { role: "assistant", content: "Sorry — there was an error fetching a response. Check console." };
      setMessages((m) => [...m, errMsg]);
    } finally {
      setChatLoading(false);
    }
  };

  // --- NEW: Text-to-Speech (SpeechSynthesis) ---
  const speakText = (text) => {
    if (!("speechSynthesis" in window)) return;
    try {
      const utter = new SpeechSynthesisUtterance(text);
      // choose a voice if you like; default is fine
      utter.lang = "en-US";
      speechSynthesis.cancel(); // stop previous
      speechSynthesis.speak(utter);
    } catch (err) {
      console.warn("TTS error:", err);
    }
  };

  // --- NEW: Speech-to-Text (SpeechRecognition) setup ---
  useEffect(() => {
    // feature-detect
    const SpeechRecognition =
      window.SpeechRecognition || window.webkitSpeechRecognition || window.mozSpeechRecognition || null;
    if (!SpeechRecognition) {
      recognitionRef.current = null;
      return;
    }
    const rec = new SpeechRecognition();
    rec.lang = "en-US";
    rec.interimResults = false;
    rec.maxAlternatives = 1;

    rec.onresult = (e) => {
      const transcript = e.results[0][0].transcript;
      setChatInput(transcript);
      // automatically send after recognition ends
      sendChatMessage(transcript, true);
    };

    rec.onerror = (e) => {
      console.warn("Speech recognition error:", e);
      setListening(false);
    };

    rec.onend = () => {
      setListening(false);
    };

    recognitionRef.current = rec;

    // cleanup on unmount
    return () => {
      try {
        rec.onresult = null;
        rec.onerror = null;
        rec.onend = null;
      } catch {}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // run only once

  const toggleListen = () => {
    const rec = recognitionRef.current;
    if (!rec) {
      alert("Speech recognition not supported in this browser.");
      return;
    }
    if (listening) {
      try {
        rec.stop();
      } catch {}
      setListening(false);
    } else {
      try {
        rec.start();
        setListening(true);
      } catch (err) {
        console.warn("Could not start recognition:", err);
        setListening(false);
      }
    }
  };

  // load progress
  useEffect(() => {
    const saved = localStorage.getItem("autotutor-progress");
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        setTopic(parsed.topic || "");
        setLesson(parsed.lesson || "");
        setQuiz(parsed.quiz || []);
        setSummary(parsed.summary || "");
      } catch {}
    }
  }, []);

  const selectOption = (qIndex, opt) => {
    if (score !== null) return;
    setSelected((s) => {
      const next = { ...s, [qIndex]: opt };
      localStorage.setItem("autotutor-progress", JSON.stringify({ topic, lesson, quiz, summary, selected: next }));
      return next;
    });
  };

  const submitQuiz = () => {
    if (quiz.length === 0) return;
    let s = 0;
    quiz.forEach((q, i) => {
      if (selected[i] === q.correct) s++;
    });
    setScore(s);
    localStorage.setItem("autotutor-progress", JSON.stringify({ topic, lesson, quiz, summary, selected, score: s }));
  };

  const resetAll = () => {
    localStorage.removeItem("autotutor-progress");
    setTopic("");
    setLesson("");
    setQuiz([]);
    setSummary("");
    setSelected({});
    setScore(null);
    // also clear chat
    setMessages([]);
    setChatInput("");
  };

  // handy: clear chat messages (optional small control)
  const clearChat = () => {
    setMessages([]);
  };

  return (
    <div className="app-container">
      <header>
        {/* <h1>🤖 AutoTutor</h1> */}
        <h1>
          <i className="fas fa-brain" style={{ color: "#00BFA6", marginRight: "8px" }}></i>
          AutoTutor
        </h1>

        <p>AI that Teaches You Back</p>
      </header>

      <section className="input-section">
        <input
          type="text"
          placeholder="Enter a topic"
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && fetchLesson()}
        />
        <button onClick={fetchLesson} disabled={loading}>
          {loading ? <i className="fas fa-spinner fa-spin"></i> : "Generate Lesson"}
        </button>
        <button className="reset-btn" onClick={resetAll}>
          Clear
        </button>
      </section>

      {/* --- Toggle for Chat Mode --- */}
      <section className="voice-controls" style={{ display: "flex", justifyContent: "center", gap: 12, marginTop: 8 }}>
        <button
          onClick={() => setChatMode((c) => !c)}
          style={{
            background: chatMode ? "linear-gradient(45deg,#00BFA6,#007a58)" : undefined,
            minWidth: 160,
          }}
        >
          <i className="fas fa-comments" style={{ marginRight: 8 }}></i>
          {chatMode ? "Chat Mode: ON" : "Chat Mode: OFF"}
        </button>

        {/* Voice input quick control (works even if chatMode off; will send message to chat history) */}
        <button onClick={toggleListen} style={{ minWidth: 160 }}>
          <i className={`fas fa-microphone${listening ? " fa-beat" : ""}`} style={{ marginRight: 8 }}></i>
          {listening ? "Listening..." : "Speak Question"}
        </button>

        {/* Optional: quick speak latest assistant reply */}
        <button
          onClick={() => {
            const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
            if (lastAssistant) speakText(lastAssistant.content);
            else if (lesson) speakText(lesson);
            else alert("No assistant response or lesson to speak.");
          }}
          style={{ minWidth: 120 }}
        >
          <i className="fas fa-play" style={{ marginRight: 8 }}></i>Listen
        </button>
        <button onClick={() => window.speechSynthesis.cancel()}>🛑 Stop</button>

      </section>

      {lesson && (
        <section className="lesson-section">
          <h2>📘 Lesson</h2>
          <p>{lesson}</p>
        </section>
      )}

      {quiz.length > 0 && (
        <section className="quiz-section">
          <h2>🧩 Quiz</h2>
          {quiz.map((q, i) => (
            <div key={i} className="question-card">
              <p className="question-text">{q.q}</p>
              <div className="options">
                {q.a.map((opt) => {
                  const isSelected = selected[i] === opt;
                  const showCorrect = score !== null && opt === q.correct;
                  const showWrong = score !== null && isSelected && opt !== q.correct;
                  return (
                    <button
                      key={opt}
                      className={`option-btn ${isSelected ? "selected" : ""} ${showCorrect ? "correct" : ""} ${
                        showWrong ? "wrong" : ""
                      }`}
                      onClick={() => selectOption(i, opt)}
                      disabled={score !== null}
                    >
                      {opt}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}

          <div className="quiz-actions">
            {score === null ? (
              <button className="submit-btn" onClick={submitQuiz}>
                Submit Quiz
              </button>
            ) : (
              <p className="score">
                Your Score: {score} / {quiz.length}
              </p>
            )}
          </div>
        </section>
      )}

      {summary && (
        <section className="summary-section">
          <h2>🧾 Summary</h2>
          <p>{summary}</p>
        </section>
      )}

      {/* --- NEW: Chat panel (renders only when chatMode is ON) --- */}
      {chatMode && (
        <section className="lesson-section" style={{ marginTop: 18 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <h2>💬 Chat with AutoTutor</h2>
            <div>
              <button
                onClick={clearChat}
                style={{
                  background: "transparent",
                  border: "1px solid rgba(255,255,255,0.12)",
                  padding: "6px 10px",
                  borderRadius: 8,
                  cursor: "pointer",
                }}
              >
                Clear Chat
              </button>
            </div>
          </div>

          <div
            style={{
              maxHeight: 260,
              overflowY: "auto",
              padding: 12,
              borderRadius: 8,
              border: "1px solid rgba(255,255,255,0.06)",
              background: "rgba(0,0,0,0.05)",
              marginBottom: 12,
            }}
          >
            {messages.length === 0 && (
              <p style={{ opacity: 0.85 }}>Ask a follow-up question about the lesson, or say something using the microphone.</p>
            )}

            {messages.map((m, idx) => (
              <div
                key={idx}
                style={{
                  display: "flex",
                  marginBottom: 10,
                  justifyContent: m.role === "assistant" ? "flex-start" : "flex-end",
                }}
              >
                <div
                  style={{
                    maxWidth: "86%",
                    padding: "8px 12px",
                    borderRadius: 12,
                    background: m.role === "assistant" ? "rgba(255,255,255,0.08)" : "linear-gradient(90deg,#FF204E,#A0153E)",
                    color: m.role === "assistant" ? "#fff" : "#fff",
                  }}
                >
                  <small style={{ opacity: 0.8, display: "block", marginBottom: 4 }}>
                    {m.role === "assistant" ? "Tutor" : "You"}
                  </small>
                  <div style={{ whiteSpace: "pre-wrap" }}>{m.content}</div>
                </div>
              </div>
            ))}
          </div>

          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && chatInput.trim()) {
                  sendChatMessage(chatInput.trim(), true);
                }
              }}
              placeholder="Type a question (or use Speak Question)..."
              style={{
                flex: 1,
                padding: "10px 12px",
                borderRadius: 8,
                border: "1px solid rgba(255,255,255,0.12)",
                background: "#ffffffee",
                color: "#00224D",
              }}
            />
            <button
              onClick={() => {
                if (!chatInput.trim()) return;
                sendChatMessage(chatInput.trim(), true);
              }}
              disabled={chatLoading}
              style={{ minWidth: 120 }}
            >
              {chatLoading ? <i className="fas fa-spinner fa-spin"></i> : <><i className="fas fa-paper-plane" style={{ marginRight: 8 }}></i>Send</>}
            </button>
          </div>
        </section>
      )}

      <footer>
        <p>
          <b>AutoTutor — Redefining education with AI precision.</b>
        </p>
      </footer>
    </div>
  );
}
