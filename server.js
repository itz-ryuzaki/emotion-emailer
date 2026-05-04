require('dotenv').config();
const express = require('express');
const path = require('path');
const nodemailer = require('nodemailer');

const fetch = globalThis.fetch || ((...args) => import('node-fetch').then(({ default: f }) => f(...args)));

// ── API Key setup ─────────────────────────────────────────────
const GROQ_API_KEY = process.env.GROQ_API_KEY;

// ── Email config ──────────────────────────────────────────────
const GMAIL_USER  = process.env.GMAIL_USER;
const GMAIL_PASS  = process.env.GMAIL_PASS;
const REPORT_TO   = process.env.REPORT_TO;

if (!GROQ_API_KEY) {
  console.error("❌ GROQ_API_KEY not found. Set GROQ_API_KEY in environment variables.");
  process.exit(1);
}

if (!GMAIL_USER || !GMAIL_PASS || !REPORT_TO) {
  console.warn("⚠️  Email not configured. Set GMAIL_USER, GMAIL_PASS, REPORT_TO in .env to enable report emails.");
}

// ── Nodemailer transporter ────────────────────────────────────
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: GMAIL_USER,
    pass: GMAIL_PASS
  }
});

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '4mb' }));
app.use(express.urlencoded({ extended: true, limit: '4mb' }));
app.set('trust proxy', 1);

// ── Groq API call ─────────────────────────────────────────────
async function callGroq(userMessage) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${GROQ_API_KEY}`
    },
    body: JSON.stringify({
      model: 'llama-3.1-8b-instant',
      messages: [
        {
          role: 'system',
          content: 'You are MindBridge AI, a compassionate mental wellness and academic support assistant for college students. Be warm, empathetic, concise, and helpful. Focus on mental health, stress management, academic advice, and student wellbeing. If a user seems in crisis, always recommend speaking to a professional counselor.'
        },
        { role: 'user', content: userMessage }
      ],
      max_tokens: 500
    })
  });
  return res;
}



// ── Main AI proxy endpoint ────────────────────────────────────
app.post('/api/gemini-flash', async (req, res) => {
  console.log('POST /api/gemini-flash | body:', JSON.stringify(req.body));

  try {
    let userMessage = req.body && (req.body.message || req.body.text || req.body.content);
    if (typeof req.body === 'string') userMessage = req.body;
    if (!userMessage || !userMessage.trim()) {
      return res.status(400).json({ error: 'No message provided', received: req.body });
    }

    console.log('Calling Groq API...');
    const groqRes = await callGroq(userMessage);
    if (groqRes.ok) {
      const data = await groqRes.json();
      const text = data.choices?.[0]?.message?.content || "I'm here to help. Could you tell me more?";
      return res.json({ candidates: [{ content: { parts: [{ text }] } }] });
    }

    console.log(`Groq failed with status ${groqRes.status}`);
    return res.status(groqRes.status || 500).json({
      error: 'ai_unavailable',
      message: 'AI service temporarily unavailable. Please try again later.'
    });

  } catch (err) {
    console.error('FULL ERROR:', err);
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

// ── Email Report Endpoint ─────────────────────────────────────
app.post('/api/send-report', async (req, res) => {
  console.log('POST /api/send-report');

  if (!GMAIL_USER || !GMAIL_PASS || !REPORT_TO) {
    return res.status(503).json({ error: 'Email not configured on server. Add GMAIL_USER, GMAIL_PASS, REPORT_TO to .env' });
  }

  try {
    const { report } = req.body;
    if (!report) return res.status(400).json({ error: 'No report data provided' });

    const {
      dominantEmotion, dominantPct, avgConfidence,
      avgExpressions, counts, timeline,
      detectedCount, timestamp
    } = report;

    const EMOJI  = { neutral:'😐', happy:'😄', sad:'😢', angry:'😠', fearful:'😨', disgusted:'🤢', surprised:'😲' };
    const COLORS = { neutral:'#9d9ab0', happy:'#f59e0b', sad:'#60a5fa', angry:'#f87171', fearful:'#c084fc', disgusted:'#4ade80', surprised:'#fb923c' };

    const insights = {
      happy:     'Positive emotional state detected — great for focus and productivity! 🌟',
      neutral:   'Calm and composed — ideal for studying and concentration. 📘',
      sad:       'Feeling low detected. Consider a short break, a walk, or talking to a friend. 💙',
      angry:     'Frustration detected. A 5-minute breathing exercise may help reset. 🌬️',
      fearful:   'Anxiety signs present. Try the 5-4-3-2-1 grounding technique or speak to a counselor. 🤝',
      disgusted: 'Discomfort detected. Journaling or talking to someone you trust can help. 📓',
      surprised: 'High stimulation session. Ensure regular breaks to avoid burnout. ⏱️'
    };

    // Build timeline HTML dots
    const timelineDots = (timeline || []).map(entry => {
      const color = entry.emotion ? COLORS[entry.emotion] : '#2a2840';
      return `<span title="${entry.second}s — ${entry.emotion || 'no face'}" style="display:inline-block;width:14px;height:20px;background:${color};border-radius:3px;margin:1px;"></span>`;
    }).join('');

    // Build breakdown bars
    const sortedExprs = Object.entries(avgExpressions || {}).sort((a,b)=>b[1]-a[1]);
    const breakdownRows = sortedExprs.map(([em, val]) => `
      <tr>
        <td style="padding:6px 12px 6px 0;font-size:13px;color:#9d9ab0;text-transform:capitalize;width:90px;">${em}</td>
        <td style="padding:6px 0;">
          <div style="background:#1e1c2e;border-radius:99px;height:8px;width:200px;overflow:hidden;">
            <div style="background:${COLORS[em]};height:100%;width:${Math.round(val*100)}%;border-radius:99px;"></div>
          </div>
        </td>
        <td style="padding:6px 0 6px 10px;font-size:12px;color:#6b6880;font-family:monospace;">${Math.round(val*100)}%</td>
      </tr>
    `).join('');

    const htmlBody = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0a0a0f;font-family:'DM Sans',Arial,sans-serif;color:#e8e6f0;">
  <div style="max-width:560px;margin:0 auto;padding:32px 16px;">

    <!-- Header -->
    <div style="text-align:center;margin-bottom:28px;">
      <div style="font-family:monospace;font-size:22px;font-weight:700;color:#fff;letter-spacing:-1px;">
        emotion<span style="color:#a78bfa;">.</span>detect
      </div>
      <div style="font-size:12px;color:#6b6880;margin-top:4px;">MindBridge Wellness Report · ${timestamp}</div>
    </div>

    <!-- Hero card -->
    <div style="background:#111118;border:1px solid #2a2840;border-radius:16px;padding:28px;text-align:center;margin-bottom:20px;">
      <div style="font-size:56px;line-height:1;margin-bottom:10px;">${EMOJI[dominantEmotion] || '😐'}</div>
      <div style="font-size:28px;font-weight:700;color:#fff;text-transform:capitalize;letter-spacing:-1px;">${dominantEmotion}</div>
      <div style="font-size:13px;color:#a78bfa;font-family:monospace;margin-top:6px;">
        dominant ${dominantPct}% of session &nbsp;·&nbsp; avg confidence ${Math.round(avgConfidence*100)}%
      </div>
      <div style="font-size:12px;color:#6b6880;margin-top:4px;font-family:monospace;">
        ${detectedCount} / 30 seconds — face detected
      </div>
    </div>

    <!-- Timeline -->
    <div style="background:#111118;border:1px solid #2a2840;border-radius:16px;padding:20px;margin-bottom:20px;">
      <div style="font-family:monospace;font-size:10px;color:#6b6880;letter-spacing:2px;text-transform:uppercase;margin-bottom:12px;">second-by-second timeline</div>
      <div style="line-height:1;">${timelineDots}</div>
      <div style="margin-top:12px;display:flex;flex-wrap:wrap;gap:8px;">
        ${Object.entries(COLORS).map(([em,col])=>`
          <span style="font-size:11px;color:#9d9ab0;">
            <span style="display:inline-block;width:10px;height:10px;background:${col};border-radius:2px;margin-right:3px;vertical-align:middle;"></span>${em}
          </span>
        `).join('')}
      </div>
    </div>

    <!-- Breakdown -->
    <div style="background:#111118;border:1px solid #2a2840;border-radius:16px;padding:20px;margin-bottom:20px;">
      <div style="font-family:monospace;font-size:10px;color:#6b6880;letter-spacing:2px;text-transform:uppercase;margin-bottom:12px;">emotion breakdown (30s average)</div>
      <table style="border-collapse:collapse;width:100%">${breakdownRows}</table>
    </div>

    <!-- Insight -->
    <div style="background:#111118;border:1px solid #2a2840;border-radius:16px;padding:20px;margin-bottom:20px;">
      <div style="font-family:monospace;font-size:10px;color:#6b6880;letter-spacing:2px;text-transform:uppercase;margin-bottom:10px;">wellness insight</div>
      <div style="font-size:14px;color:#c4c0d8;line-height:1.7;">${insights[dominantEmotion] || 'Session complete.'}</div>
    </div>

    <!-- Footer -->
    <div style="text-align:center;font-size:11px;color:#3a3850;font-family:monospace;margin-top:24px;">
      generated by MindBridge emotion.detect &nbsp;·&nbsp; runs locally in your browser
    </div>
  </div>
</body>
</html>`;

    const plainText = [
      `MindBridge Emotion Report — ${timestamp}`,
      ``,
      `Dominant mood: ${dominantEmotion.toUpperCase()} (${dominantPct}% of session)`,
      `Avg confidence: ${Math.round(avgConfidence*100)}%`,
      `Detection: ${detectedCount}/30 seconds`,
      ``,
      `Emotion Breakdown:`,
      ...sortedExprs.map(([em,v])=>`  ${em}: ${Math.round(v*100)}%`),
      ``,
      `Insight: ${insights[dominantEmotion] || 'Session complete.'}`
    ].join('\n');

    await transporter.sendMail({
      from: `"MindBridge" <${GMAIL_USER}>`,
      to:   REPORT_TO,
      subject: `🧠 Emotion Report — ${dominantEmotion} (${dominantPct}%) · ${timestamp}`,
      text:    plainText,
      html:    htmlBody
    });

    console.log(`✅ Report emailed to ${REPORT_TO}`);
    res.json({ success: true, sentTo: REPORT_TO });

  } catch (err) {
    console.error('Email error:', err);
    res.status(500).json({ error: 'Failed to send email', details: err.message });
  }
});

// ── Static & HTML routes ──────────────────────────────────────
app.use(express.static(__dirname));

app.get('/',                (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/feed',            (req, res) => res.sendFile(path.join(__dirname, 'feed.html')));
app.get('/chat',            (req, res) => res.sendFile(path.join(__dirname, 'chat.html')));
app.get('/college',         (req, res) => res.sendFile(path.join(__dirname, 'college.html')));
app.get('/sessions',        (req, res) => res.sendFile(path.join(__dirname, 'sessions.html')));
app.get('/xp',              (req, res) => res.sendFile(path.join(__dirname, 'xp.html')));
app.get('/sos',             (req, res) => res.sendFile(path.join(__dirname, 'sos.html')));
app.get('/post-detail',     (req, res) => res.sendFile(path.join(__dirname, 'post-detail.html')));
app.get('/emotion-detector',(req, res) => res.sendFile(path.join(__dirname, 'emotion_detector.html')));

app.listen(PORT, () => {
  console.log(`✅ MindBridge running on port ${PORT}`);
  console.log(`   Groq:  ${GROQ_API_KEY ? '✅ enabled' : '❌ not set'}`);
  console.log(`   Email: ${GMAIL_USER     ? `✅ ${GMAIL_USER} → ${REPORT_TO}` : '❌ not configured'}`);
});
