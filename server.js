import 'dotenv/config';
import express from 'express';
import { readFileSync } from 'fs';
import { getHistory, addMessage } from './memory.js';

const {
  WHATSAPP_TOKEN,
  PHONE_NUMBER_ID,
  VERIFY_TOKEN,
  OWNER_NUMBER,
  PORT = 3000,
} = process.env;

const GRAPH = `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`;
const knowledge = readFileSync('./knowledge.md', 'utf-8');

// --- LLM providers, tried in order until one succeeds --------------------
// Add as many Gemini keys as you like via env vars. Each key has its own
// daily free quota, so N keys ~= N x capacity. OpenRouter is the final net.
//   GEMINI_API_KEY, GEMINI_API_KEY_2, GEMINI_API_KEY_3, GEMINI_API_KEY_4
//   OPENROUTER_API_KEY   (get free key at openrouter.ai)
const GEMINI_KEYS = [
  process.env.GEMINI_API_KEY,
  process.env.GEMINI_API_KEY_2,
  process.env.GEMINI_API_KEY_3,
  process.env.GEMINI_API_KEY_4,
].filter(Boolean);

// Models tried per Gemini key (cheapest/fastest first).
const GEMINI_MODELS = ['gemini-2.5-flash-lite', 'gemini-2.5-flash', 'gemini-2.0-flash'];

// OpenRouter free models — final fallback if all Gemini quotas are spent.
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODELS = [
  'qwen/qwen3-next-80b-a3b-instruct:free',
  'meta-llama/llama-3.3-70b-instruct:free',
  'google/gemma-4-31b-it:free',
];

// One Gemini call via REST (so we can rotate raw keys easily).
async function callGemini(key, modelName, prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${key}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
  });
  if (!res.ok) {
    const e = new Error(`Gemini ${res.status}`);
    e.status = res.status;
    throw e;
  }
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw Object.assign(new Error('Gemini empty'), { status: 500 });
  return text.trim();
}

// One OpenRouter call (OpenAI-compatible chat API).
async function callOpenRouter(modelName, prompt) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENROUTER_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: modelName,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) {
    const e = new Error(`OpenRouter ${res.status}`);
    e.status = res.status;
    throw e;
  }
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw Object.assign(new Error('OpenRouter empty'), { status: 500 });
  return text.trim();
}

// Try Gemini keys x models, then OpenRouter models. Skip any that 429/503.
async function generateWithRetry(prompt) {
  let lastErr;

  // 1) Every Gemini key, every model.
  for (let k = 0; k < GEMINI_KEYS.length; k++) {
    for (const modelName of GEMINI_MODELS) {
      try {
        return await callGemini(GEMINI_KEYS[k], modelName, prompt);
      } catch (err) {
        lastErr = err;
        console.log(`Gemini key#${k + 1} ${modelName} failed (${err.status}), next...`);
        // 429 = quota for this key/model; 503 = overloaded. Either way move on.
      }
    }
  }

  // 2) OpenRouter fallback.
  if (OPENROUTER_KEY) {
    for (const modelName of OPENROUTER_MODELS) {
      try {
        return await callOpenRouter(modelName, prompt);
      } catch (err) {
        lastErr = err;
        console.log(`OpenRouter ${modelName} failed (${err.status}), next...`);
      }
    }
  }

  throw lastErr || new Error('No LLM provider available');
}

const systemPrompt = `You are the assistant replying on behalf of Aditya Singh of
Balaji Construction, a construction contractor, via WhatsApp. Reply in his voice:
warm, respectful, brief, and practical — like a helpful contractor texting.
Keep replies short (1-4 sentences).

IMPORTANT — language: reply in the SAME language the customer used. If they write
in Hindi, reply in Hindi; if English, reply in English; Hinglish is fine. Never
switch to a language the customer did not use. Do NOT use Australian/Western slang
like "G'day" or "mate".

Use ONLY the info below. NEVER invent prices, dates, or promises. If asked for a
price or to commit to anything, steer toward booking a free site visit. If unsure,
say you'll check with Aditya and get back to them.

BUSINESS INFO:
${knowledge}`;

// Messages that involve money or commitment -> hold and ask the owner first.
const RISKY = /price|cost|quote|quotation|deposit|pay|invoice|confirm|book|when can you|guarantee|discount|kitna|kharcha|rate|paisa|advance|booking|\$|£|₹|€/i;

// --- Send a text message via the Cloud API ---
async function sendWhatsApp(to, body) {
  const res = await fetch(GRAPH, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body },
    }),
  });
  if (!res.ok) {
    console.error('Send failed:', res.status, await res.text());
  } else {
    console.log('Send OK to', to);
  }
}

const app = express();
app.use(express.json());

// --- Webhook verification (Meta calls this once when you save the webhook) ---
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Webhook verified.');
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// --- Incoming messages ---
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // ack immediately so Meta doesn't retry

  console.log('>>> Webhook POST received:', JSON.stringify(req.body));

  try {
    const entry = req.body.entry?.[0]?.changes?.[0]?.value;
    const msg = entry?.messages?.[0];
    if (!msg || msg.type !== 'text') {
      console.log('... not a text message, ignoring. type=', msg?.type);
      return;
    }

    const from = msg.from;              // customer's number
    const text = msg.text.body;

    // Owner approval command: reply "/ok <number> <message>" to send manually,
    // or just talk to the customer yourself.
    if (from === OWNER_NUMBER && text.startsWith('/ok ')) {
      const [, target, ...rest] = text.split(' ');
      await sendWhatsApp(target, rest.join(' '));
      return;
    }

    // First-time customer whose first message is just a greeting (hi/hello/namaste):
    // send the branded welcome and stop. If their first message is a real question,
    // skip the canned greeting and let the AI answer it directly.
    const isNew = getHistory(from).length === 0;
    const bareGreeting = /^\s*(hi+|hey+|hello+|namaste|namaskar|hii+|start|yo)\b[\s!.]*$/i;
    if (isNew && bareGreeting.test(text)) {
      const greeting = `🙏 Namaste! Balaji Construction mein aapka swagat hai.\n\n` +
        `Main Aditya Singh ka assistant hoon. Aap construction ya interior se ` +
        `related koi bhi kaam ke baare mein puchh sakte hain.\n\n` +
        `Batayein, aapko kya kaam karwana hai?`;
      await sendWhatsApp(from, greeting);
      addMessage(from, 'assistant', greeting);
      return;
    }

    addMessage(from, 'user', text);

    // Build the prompt with recent history for thread context
    const history = getHistory(from)
      .map(m => `${m.role === 'user' ? 'Customer' : 'You'}: ${m.text}`)
      .join('\n');

    const reply = await generateWithRetry(
      `${systemPrompt}\n\nConversation so far:\n${history}\n\nYou:`
    );

    if (RISKY.test(text)) {
      console.log('... RISKY match -> holding for owner approval. from=', from);
      // Hold the auto-reply; ping the owner with a ready-to-send draft.
      addMessage(from, 'assistant', '(held for owner approval)');
      if (OWNER_NUMBER) {
        await sendWhatsApp(
          OWNER_NUMBER,
          `⚠️ Needs you — from ${from}\nThem: "${text}"\n\nDraft: "${reply}"\n\n` +
          `To send this, reply:\n/ok ${from} ${reply}`
        );
      }
    } else {
      await sendWhatsApp(from, reply);
      addMessage(from, 'assistant', reply);
    }
  } catch (err) {
    console.error('Handler error:', err);
  }
});

app.get('/', (_req, res) => res.send('WA agent running.'));
app.listen(PORT, () => console.log(`Listening on port ${PORT}`));
