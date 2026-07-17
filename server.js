import 'dotenv/config';
import express from 'express';
import { readFileSync } from 'fs';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { getHistory, addMessage } from './memory.js';

const {
  WHATSAPP_TOKEN,
  PHONE_NUMBER_ID,
  VERIFY_TOKEN,
  OWNER_NUMBER,
  GEMINI_API_KEY,
  PORT = 3000,
} = process.env;

const GRAPH = `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`;
const knowledge = readFileSync('./knowledge.md', 'utf-8');

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash-lite' });

// Call Gemini with retries so temporary 503 "high demand" spikes self-heal.
async function generateWithRetry(prompt, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const result = await model.generateContent(prompt);
      return result.response.text().trim();
    } catch (err) {
      const status = err?.status;
      if ((status === 503 || status === 429) && i < tries - 1) {
        await new Promise(r => setTimeout(r, 1500 * (i + 1)));
        continue;
      }
      throw err;
    }
  }
}

const systemPrompt = `You are the assistant replying on behalf of a solo
construction contractor via WhatsApp. Reply in his voice: warm, brief, practical,
like a busy tradesperson texting. Keep replies short (1-4 sentences).
Use ONLY the info below. NEVER invent prices, dates, or promises. If asked for a
price or to commit to anything, steer toward booking a free site visit. If unsure,
say you'll check with him and get back to them.

BUSINESS INFO:
${knowledge}`;

// Messages that involve money or commitment -> hold and ask the owner first.
const RISKY = /price|cost|quote|quotation|deposit|pay|invoice|confirm|book|when can you|guarantee|discount|\$|£|₹|€/i;

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
  if (!res.ok) console.error('Send failed:', res.status, await res.text());
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

    addMessage(from, 'user', text);

    // Build the prompt with recent history for thread context
    const history = getHistory(from)
      .map(m => `${m.role === 'user' ? 'Customer' : 'You'}: ${m.text}`)
      .join('\n');

    const reply = await generateWithRetry(
      `${systemPrompt}\n\nConversation so far:\n${history}\n\nYou:`
    );

    if (RISKY.test(text)) {
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
