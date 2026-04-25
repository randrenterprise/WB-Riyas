const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const pino = require('pino');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const FIREBASE_URL = process.env.FIREBASE_URL;
const chatStates = {};

// 🔹 Helper: Firebase REST
const fbFetch = async (path) => {
  const res = await fetch(`${FIREBASE_URL}/${path}.json`);
  return res.ok ? await res.json() : null;
};
const fbPush = async (path, data) => {
  const res = await fetch(`${FIREBASE_URL}/${path}.json`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
  });
  return res.ok ? await res.json() : null;
};

// 🔹 PDF Generator (No Tax/GST as requested)
async function generateQuotePDF(quote) {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([595.28, 841.89]); // A4
  const { width, height } = page.getSize();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  // Header
  page.drawText('QUOTATION', { x: 50, y: height - 50, size: 24, font: bold, color: rgb(0,0,0) });
  page.drawText(`ID: ${quote.quoteId}`, { x: 50, y: height - 75, size: 12, font, color: rgb(0.3,0.3,0.3) });
  page.drawText(`Date: ${new Date().toLocaleDateString()}`, { x: 50, y: height - 95, size: 12, font, color: rgb(0.3,0.3,0.3) });

  // Table Header
  let y = height - 140;
  page.drawText('ITEM', { x: 50, y, size: 12, font: bold });
  page.drawText('QTY', { x: 350, y, size: 12, font: bold });
  page.drawText('PRICE', { x: 450, y, size: 12, font: bold });
  y -= 20;
  page.drawRectangle({ x: 50, y, width: 500, height: 1, color: rgb(0.8,0.8,0.8) });
  y -= 25;

  // Items
  quote.items.forEach(item => {
    page.drawText(item.name, { x: 50, y, size: 11, font });
    page.drawText(String(item.qty), { x: 350, y, size: 11, font });
    page.drawText(`₹${(item.price * item.qty).toLocaleString()}`, { x: 450, y, size: 11, font });
    y -= 20;
  });

  // Total
  y -= 20;
  page.drawRectangle({ x: 50, y, width: 500, height: 1, color: rgb(0.8,0.8,0.8) });
  y -= 30;
  page.drawText('TOTAL AMOUNT', { x: 350, y, size: 14, font: bold });
  page.drawText(`₹${quote.total.toLocaleString()}`, { x: 450, y, size: 14, font: bold, color: rgb(0.1,0.5,0.3) });

  // Footer
  page.drawText('Thank you for your business!', { x: 50, y: 50, size: 10, font, color: rgb(0.5,0.5,0.5) });

  return await pdfDoc.save();
}

async function startBot() {
  if (!FIREBASE_URL) { console.error("❌ FIREBASE_URL missing!"); process.exit(1); }
  const { state, saveCreds } = await useMultiFileAuthState('session_data');
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version, auth: state, printQRInTerminal: false,
    logger: pino({ level: 'silent' }), browser: ["JavaGoat AI", "Desktop", "2.0"]
  });

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) { console.clear(); console.log('\n📱 Scan QR:'); qrcode.generate(qr, { small: true }); }
    if (connection === 'open') console.log('✅ JAVAGOAT QUOTEBOT ONLINE');
    if (connection === 'close') {
      const reason = lastDisconnect?.error?.output?.statusCode;
      if (reason !== DisconnectReason.loggedOut) startBot();
    }
  });
  sock.ev.on('creds.update', saveCreds);

  // 🔹 Q&A Matcher
  async function matchFAQ(text) {
    const faq = await fbFetch('faq');
    if (!faq) return null;
    const lower = text.toLowerCase();
    const match = Object.values(faq).find(f => f.keywords?.some(k => lower.includes(k)) || lower.includes(f.q.toLowerCase()));
    return match;
  }

  // 🔹 Quote Flow Engine
  async function handleQuoteFlow(sender, text, state) {
    const s = chatStates[sender] || { step: 'ask_category' };

    if (s.step === 'ask_category') {
      const cats = await fbFetch('menuCategories');
      if (!cats) return await sock.sendMessage(sender, { text: "⚠️ Menu not available right now." });
      const list = Object.entries(cats).map(([k, v]) => `• ${v.name} (ID: ${k})`).join('\n');
      await sock.sendMessage(sender, { text: `📂 *Select Category:*\n${list}\n\nReply with ID or Name.` });
      chatStates[sender] = { step: 'wait_category' };
    } 
    else if (s.step === 'wait_category') {
      const cats = await fbFetch('menuCategories');
      const match = Object.entries(cats).find(([k, v]) => v.name.toLowerCase().includes(text) || k === text);
      if (!match) return await sock.sendMessage(sender, { text: "❌ Invalid category. Type /quote to restart." });
      
      chatStates[sender] = { step: 'wait_item', catId: match[0], catName: match[1].name, items: match[1].items };
      const itemMsg = Object.entries(match[1].items).map(([k, v]) => `• ${v.name} - ₹${v.price}`).join('\n');
      await sock.sendMessage(sender, { text: `📦 *${match[1].name} Items:*\n${itemMsg}\n\nReply with Item Name or ID.` });
    }
    else if (s.step === 'wait_item') {
      const items = s.items;
      const match = Object.entries(items).find(([k, v]) => v.name.toLowerCase().includes(text) || k === text);
      if (!match) return await sock.sendMessage(sender, { text: "❌ Item not found." });
      
      chatStates[sender] = { ...s, step: 'wait_qty', itemId: match[0], itemName: match[1].name, price: match[1].price };
      await sock.sendMessage(sender, { text: `✅ Selected: *${match[1].name}*\n💰 Price: ₹${match[1].price}\n\n🔢 Enter Quantity:` });
    }
    else if (s.step === 'wait_qty') {
      const qty = parseInt(text);
      if (isNaN(qty) || qty < 1) return await sock.sendMessage(sender, { text: "❌ Enter a valid number." });
      
      const total = s.price * qty;
      const quoteId = 'QT-' + Date.now().toString(36).toUpperCase();
      const quoteData = {
        userId: sender.split('@')[0],
        items: [{ id: s.itemId, name: s.itemName, price: s.price, qty }],
        total, status: 'pending', createdAt: new Date().toISOString()
      };
      
      const pdfBytes = await generateQuotePDF({ quoteId, ...quoteData });
      await fbPush('quotes', { ...quoteData, quoteId });
      
      await sock.sendMessage(sender, {
        document: pdfBytes,
        mimetype: 'application/pdf',
        fileName: `Quote_${quoteId}.pdf`,
        caption: `📄 *QUOTATION #${quoteId}*\n\n💰 Total: ₹${total.toLocaleString()}\n\nReply *CONFIRM* to approve or *INVOICE* to finalize.`
      });
      chatStates[sender] = { step: 'await_action', quoteId, total };
    }
    else if (s.step === 'await_action') {
      if (text.toLowerCase() === 'confirm') {
        await sock.sendMessage(sender, { text: "✅ Quotation confirmed! Our team will proceed." });
      } else if (text.toLowerCase() === 'invoice') {
        await sock.sendMessage(sender, { text: "🧾 Invoice generated & sent to your email. (Mock)" });
      } else {
        await sock.sendMessage(sender, { text: "Reply *CONFIRM* or *INVOICE*." });
      }
      delete chatStates[sender];
    }
  }

  // 🔹 Message Router
  sock.ev.on('messages.upsert', async (m) => {
    const msg = m.messages[0];
    if (!msg.message || msg.key.remoteJid === 'status@broadcast' || msg.key.fromMe) return;
    
    const sender = msg.key.remoteJid;
    const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim();

    if (['/quote', 'quote'].includes(text.toLowerCase())) {
      delete chatStates[sender];
      return handleQuoteFlow(sender, '', {});
    }
    if (['/help', 'help'].includes(text.toLowerCase())) {
      return await sock.sendMessage(sender, { text: `🤖 *Commands:*\n• /quote → Generate quotation\n• /menu → View catalog\n• /faq → Get answers` });
    }
    if (['/menu', 'menu'].includes(text.toLowerCase())) {
      const cats = await fbFetch('menuCategories');
      const msg = Object.values(cats).map(c => `📂 *${c.name}*\n${Object.values(c.items).map(i => `• ${i.name}: ₹${i.price}`).join('\n')}`).join('\n\n');
      return await sock.sendMessage(sender, { text: `📋 *CATALOG*\n\n${msg}` });
    }

    // FAQ Fallback
    const faq = await matchFAQ(text);
    if (faq) return await sock.sendMessage(sender, { text: `❓ *${faq.q}*\n✅ ${faq.a}` });

    // Continue Flow
    await handleQuoteFlow(sender, text, chatStates[sender] || {});
  });
}
startBot().catch(console.error);
