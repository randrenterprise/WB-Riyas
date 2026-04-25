const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const pino = require('pino');

// ============= CONFIGURATION =============
// FIREBASE_URL will be loaded from GitHub Secrets (process.env.FIREBASE_URL)
const FIREBASE_URL = process.env.FIREBASE_URL;
const ADMIN_NUMBER = "1234567890"; // REPLACE WITH YOUR WHATSAPP NUMBER (without country code)
// ==========================================

// Store user session states and timers
const userStates = {};
const userTimeouts = {};

// Helper: Fetch timeout settings from Firebase
async function getTimeoutSettings() {
    try {
        const response = await fetch(`${FIREBASE_URL}/settings/timeout.json`);
        const data = await response.json();
        return {
            enabled: data?.enabled !== false,
            duration: data?.duration || 60,
            message: data?.message || "⏰ Session timed out. Type 'menu' to start fresh"
        };
    } catch (error) {
        return { enabled: true, duration: 60, message: "Session timed out. Type 'menu' to start fresh" };
    }
}

// Helper: Reset user timeout
async function resetUserTimeout(sender) {
    if (userTimeouts[sender]) {
        clearTimeout(userTimeouts[sender]);
    }
    
    const settings = await getTimeoutSettings();
    if (settings.enabled && userStates[sender]) {
        userTimeouts[sender] = setTimeout(async () => {
            if (userStates[sender]) {
                const sessionType = userStates[sender].step || 'conversation';
                delete userStates[sender];
                await sendMessage(sock, sender, settings.message);
                console.log(`⏰ Session timed out for ${sender}`);
            }
        }, settings.duration * 1000);
    }
}

// Helper: Send message wrapper
let sockGlobal = null;
async function sendMessage(sock, sender, text, options = {}) {
    try {
        await sock.sendMessage(sender, { text: text, ...options });
        await resetUserTimeout(sender);
    } catch (error) {
        console.error("Send message error:", error);
    }
}

// Helper: Fetch Menu with Categories
async function getFullMenu() {
    try {
        const response = await fetch(`${FIREBASE_URL}/menu.json`);
        const data = await response.json();
        if (!data) return [];
        
        return Object.keys(data).map(key => ({
            id: key,
            category: data[key].category,
            name: data[key].name,
            price: data[key].price,
            description: data[key].description || '',
            imageUrl: data[key].imageUrl,
            subItems: data[key].subItems || [],
            isActive: data[key].isActive !== false,
            stock: data[key].stock || 999
        }));
    } catch (error) {
        console.error("Failed to fetch menu:", error);
        return [];
    }
}

// Helper: Fetch FAQs
async function getFAQs() {
    try {
        const response = await fetch(`${FIREBASE_URL}/faqs.json`);
        const data = await response.json();
        if (!data) return [];
        
        return Object.keys(data).map(key => ({
            id: key,
            question: data[key].question,
            answer: data[key].answer,
            category: data[key].category || 'General'
        }));
    } catch (error) {
        console.error("Failed to fetch FAQs:", error);
        return [];
    }
}

// Helper: Generate Quotation (No Tax)
async function generateQuotation(userId, items, customerInfo) {
    const subtotal = items.reduce((sum, item) => sum + (item.price * item.quantity), 0);
    const total = subtotal; // No tax, no delivery fee for quotes
    
    const quotation = {
        id: 'Q-' + Date.now(),
        userId: userId,
        customerName: customerInfo.name,
        customerPhone: customerInfo.phone,
        customerEmail: customerInfo.email || '',
        items: items,
        subtotal: subtotal,
        total: total,
        status: 'Pending',
        createdAt: new Date().toISOString(),
        validUntil: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
    };
    
    await fetch(`${FIREBASE_URL}/quotations.json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(quotation)
    });
    
    return quotation;
}

// Helper: Get Quotation by ID
async function getQuotationById(id) {
    const response = await fetch(`${FIREBASE_URL}/quotations.json`);
    const data = await response.json();
    if (!data) return null;
    
    for (const key in data) {
        if (data[key].id === id) {
            return { id: key, ...data[key] };
        }
    }
    return null;
}

// Helper: Generate Invoice
async function generateInvoice(quotationId, paymentDetails) {
    const quotation = await getQuotationById(quotationId);
    if (!quotation) return null;
    
    const invoice = {
        id: 'INV-' + Date.now(),
        quotationId: quotationId,
        customerName: quotation.customerName,
        customerPhone: quotation.customerPhone,
        customerEmail: quotation.customerEmail,
        items: quotation.items,
        subtotal: quotation.subtotal,
        total: quotation.total,
        paymentMethod: paymentDetails.method,
        paymentStatus: paymentDetails.status || 'Pending',
        transactionId: paymentDetails.transactionId || '',
        issuedAt: new Date().toISOString(),
        dueDate: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString()
    };
    
    await fetch(`${FIREBASE_URL}/invoices.json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(invoice)
    });
    
    return invoice;
}

// Format Quotation Message
function formatQuotationMessage(quotation) {
    let itemsList = '';
    quotation.items.forEach(item => {
        itemsList += `• ${item.name} x${item.quantity} = ₹${(item.price * item.quantity).toFixed(2)}\n`;
    });
    
    return `
╔════════════════════════════════════╗
║        📄 *QUOTATION*              ║
╠════════════════════════════════════╣
║ ID: ${quotation.id}
║ Customer: ${quotation.customerName}
║ Phone: ${quotation.customerPhone}
╠════════════════════════════════════╣
║ *ITEMS:*
${itemsList}
╠════════════════════════════════════╣
║ *TOTAL: ₹${quotation.total.toFixed(2)}*
╠════════════════════════════════════╣
║ Valid Until: ${new Date(quotation.validUntil).toLocaleDateString()}
║ Status: ${quotation.status}
╠════════════════════════════════════╣
║ *Commands:*                        ║
║ • Type "accept" to accept quote    ║
║ • Type "revise" to request changes ║
║ • Type "invoice" for invoice       ║
╚════════════════════════════════════╝
    `;
}

// Format Invoice Message
function formatInvoiceMessage(invoice) {
    let itemsList = '';
    invoice.items.forEach(item => {
        itemsList += `• ${item.name} x${item.quantity} = ₹${(item.price * item.quantity).toFixed(2)}\n`;
    });
    
    return `
╔════════════════════════════════════╗
║         🧾 *OFFICIAL INVOICE*      ║
╠════════════════════════════════════╣
║ Invoice: ${invoice.id}
║ Date: ${new Date(invoice.issuedAt).toLocaleDateString()}
║ Customer: ${invoice.customerName}
║ Phone: ${invoice.customerPhone}
╠════════════════════════════════════╣
║ *ITEMS:*
${itemsList}
╠════════════════════════════════════╣
║ *TOTAL: ₹${invoice.total.toFixed(2)}*
╠════════════════════════════════════╣
║ Payment: ${invoice.paymentMethod}
║ Status: ${invoice.paymentStatus}
║ Due Date: ${new Date(invoice.dueDate).toLocaleDateString()}
╚════════════════════════════════════╝
    `;
}

// Format Menu Message
async function formatMenuMessage() {
    const menu = await getFullMenu();
    const activeMenu = menu.filter(item => item.isActive && item.stock > 0);
    
    if (activeMenu.length === 0) return "🍽️ Menu is currently empty. Please check back later!";
    
    const categorized = {};
    activeMenu.forEach(item => {
        if (!categorized[item.category]) categorized[item.category] = [];
        categorized[item.category].push(item);
    });
    
    let message = "🍽️ *OUR MENU* 🍽️\n\n";
    
    for (const [category, items] of Object.entries(categorized)) {
        message += `*【${category.toUpperCase()}】*\n`;
        items.forEach(item => {
            message += `┌ *${item.name}*\n`;
            message += `│ 💰 ₹${item.price}\n`;
            if (item.description) message += `│ 📝 ${item.description}\n`;
            if (item.subItems && item.subItems.length > 0) {
                message += `│ 📋 Options: ${item.subItems.join(', ')}\n`;
            }
            message += `│ ✅ In Stock: ${item.stock}\n`;
            message += `└ Type: "order ${item.name.toLowerCase()}"\n\n`;
        });
    }
    
    message += "\n💡 *Quick Commands:*\n";
    message += "• `quote [items]` - Get price quotation\n";
    message += "• `faq` - Frequently asked questions\n";
    message += "• `track [order#]` - Track your order\n";
    message += "• `contact` - Contact support\n";
    message += "• `cancel` - Cancel current session";
    
    return message;
}

// Format FAQ Message
async function formatFAQMessage() {
    const faqs = await getFAQs();
    if (faqs.length === 0) return "No FAQs available yet. Type 'contact' for support.";
    
    let message = "❓ *FREQUENTLY ASKED QUESTIONS*\n\n";
    
    const categorized = {};
    faqs.forEach(faq => {
        if (!categorized[faq.category]) categorized[faq.category] = [];
        categorized[faq.category].push(faq);
    });
    
    for (const [category, items] of Object.entries(categorized)) {
        message += `*📁 ${category}*\n`;
        items.forEach((faq, idx) => {
            message += `\n${idx + 1}. *${faq.question}*\n`;
            message += `   ↳ ${faq.answer}\n`;
        });
        message += "\n";
    }
    
    return message;
}

// Process Order
async function processOrder(sender, orderItem, quantity, customerDetails) {
    const subtotal = orderItem.price * quantity;
    const deliveryFee = 50;
    const total = subtotal + deliveryFee;
    
    const order = {
        id: 'ORD-' + Date.now(),
        userId: sender,
        customerName: customerDetails.name,
        customerPhone: customerDetails.phone,
        customerAddress: customerDetails.address,
        items: [{
            id: orderItem.id,
            name: orderItem.name,
            price: orderItem.price,
            quantity: quantity
        }],
        subtotal: subtotal,
        deliveryFee: deliveryFee,
        total: total,
        status: 'Confirmed',
        paymentMethod: 'Cash on Delivery',
        createdAt: new Date().toISOString(),
        estimatedDelivery: new Date(Date.now() + 45 * 60 * 1000).toISOString()
    };
    
    await fetch(`${FIREBASE_URL}/orders.json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(order)
    });
    
    // Update stock
    const newStock = orderItem.stock - quantity;
    await fetch(`${FIREBASE_URL}/menu/${orderItem.id}.json`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stock: newStock })
    });
    
    return order;
}

// Main Bot Function
async function startBot() {
    if (!FIREBASE_URL) {
        console.log("❌ ERROR: FIREBASE_URL not found!");
        console.log("📍 Please add FIREBASE_URL to GitHub Secrets → Settings → Secrets and variables → Actions");
        console.log("📍 Secret name: FIREBASE_URL");
        console.log("📍 Value: Your Firebase Realtime Database URL (e.g., https://your-project-default-rtdb.firebaseio.com)");
        process.exit(1);
    }

    console.log("🚀 Starting WhatsApp Order Bot...");
    console.log(`📡 Firebase URL: ${FIREBASE_URL}`);
    console.log(`👤 Admin Number: ${ADMIN_NUMBER}`);

    const { state, saveCreds } = await useMultiFileAuthState('session_data');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: ["WhatsApp", "OrderBot", "2.0"]
    });
    
    sockGlobal = sock;

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.clear();
            console.log('\n╔════════════════════════════════════════╗');
            console.log('║     📱 SCAN QR CODE WITH WHATSAPP      ║');
            console.log('╚════════════════════════════════════════╝\n');
            qrcode.generate(qr, { small: true });
            console.log('\n💡 Tip: Open WhatsApp > Linked Devices > Link a Device');
        }

        if (connection === 'open') {
            console.log('\n✅ BOT IS ONLINE!');
            console.log(`📱 Bot is ready to receive messages!`);
            
            if (ADMIN_NUMBER && ADMIN_NUMBER !== "1234567890") {
                const adminJid = ADMIN_NUMBER + '@s.whatsapp.net';
                try {
                    await sock.sendMessage(adminJid, { 
                        text: `🤖 *Bot Online!*\n\n✅ WhatsApp Order Bot is now active.\n📅 Time: ${new Date().toLocaleString()}\n\nType *menu* to start ordering!` 
                    });
                    console.log(`📨 Admin notification sent to +${ADMIN_NUMBER}`);
                } catch(e) {
                    console.log("⚠️ Could not send admin notification");
                }
            }
        }
        
        if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode;
            console.log(`❌ Bot disconnected. Reason: ${reason}`);
            if (reason !== DisconnectReason.loggedOut) {
                console.log('🔄 Restarting bot in 5 seconds...');
                setTimeout(startBot, 5000);
            }
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.remoteJid === 'status@broadcast') return;
        if (msg.key.fromMe) return;

        const sender = msg.key.remoteJid;
        const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || "").toLowerCase().trim();
        const senderNumber = sender.split('@')[0];

        console.log(`📩 [${new Date().toLocaleTimeString()}] ${senderNumber}: ${text}`);

        // ========== CANCEL COMMAND ==========
        if (text === "cancel" && userStates[sender]) {
            delete userStates[sender];
            if (userTimeouts[sender]) {
                clearTimeout(userTimeouts[sender]);
                delete userTimeouts[sender];
            }
            await sendMessage(sock, sender, "✅ Session cancelled! Type *menu* to start fresh.");
            return;
        }

        // ========== QUOTATION FLOW ==========
        if (text.startsWith("quote ")) {
            const itemsText = text.replace("quote ", "");
            const items = [];
            const itemMatches = itemsText.match(/(\d+)\s+([^,]+)/g);
            
            if (itemMatches) {
                const menu = await getFullMenu();
                for (const match of itemMatches) {
                    const [quantity, name] = match.match(/(\d+)\s+(.+)/).slice(1);
                    const menuItem = menu.find(item => 
                        item.name.toLowerCase().includes(name.toLowerCase()) && 
                        item.isActive && item.stock > 0
                    );
                    if (menuItem) {
                        items.push({
                            name: menuItem.name,
                            price: menuItem.price,
                            quantity: parseInt(quantity)
                        });
                    }
                }
            }
            
            if (items.length === 0) {
                await sendMessage(sock, sender, 
                    "❌ Couldn't recognize items. Use format:\n\n*quote 2 pizza, 1 burger*\n\nType *menu* to see available items."
                );
                return;
            }
            
            userStates[sender] = {
                step: 'AWAITING_CUSTOMER_DETAILS',
                quotationItems: items
            };
            
            await sendMessage(sock, sender, 
                "📋 *Quotation Request Received*\n\nPlease provide your details:\n\n1. Full Name\n2. Phone Number\n3. Email (optional)\n\n*Example:*\nJohn Doe, 9876543210, john@email.com"
            );
            return;
        }
        
        // ========== CUSTOMER DETAILS FOR QUOTATION ==========
        if (userStates[sender]?.step === 'AWAITING_CUSTOMER_DETAILS') {
            const details = text.split(',');
            const customerInfo = {
                name: details[0]?.trim() || 'Customer',
                phone: details[1]?.trim() || senderNumber,
                email: details[2]?.trim() || ''
            };
            
            const quotation = await generateQuotation(sender, userStates[sender].quotationItems, customerInfo);
            userStates[sender] = {
                step: 'AWAITING_QUOTATION_ACTION',
                quotationId: quotation.id
            };
            
            await sendMessage(sock, sender, formatQuotationMessage(quotation));
            
            if (ADMIN_NUMBER && ADMIN_NUMBER !== "1234567890") {
                await sock.sendMessage(ADMIN_NUMBER + '@s.whatsapp.net', { 
                    text: `🆕 *New Quotation*\n\nFrom: ${customerInfo.name}\nPhone: ${customerInfo.phone}\nQuotation: ${quotation.id}\nTotal: ₹${quotation.total.toFixed(2)}` 
                }).catch(e => console.log("Admin notification failed"));
            }
            return;
        }
        
        // ========== ACCEPT QUOTATION ==========
        if (text === "accept" && userStates[sender]?.step === 'AWAITING_QUOTATION_ACTION') {
            const quotationId = userStates[sender].quotationId;
            await fetch(`${FIREBASE_URL}/quotations/${quotationId}.json`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status: 'Accepted' })
            });
            
            userStates[sender].step = 'AWAITING_PAYMENT';
            
            await sendMessage(sock, sender, 
                "✅ *Quotation Accepted!*\n\nType *invoice* to generate your invoice."
            );
            return;
        }
        
        // ========== REVISE QUOTATION ==========
        if (text === "revise" && userStates[sender]?.step === 'AWAITING_QUOTATION_ACTION') {
            await sendMessage(sock, sender, 
                "📝 *Request Revision*\n\nPlease describe what changes you'd like:\n- Quantity change?\n- Different items?\n- Other modifications?\n\nOur team will get back to you shortly."
            );
            userStates[sender].step = 'AWAITING_REVISION_DETAILS';
            return;
        }
        
        // ========== GENERATE INVOICE ==========
        if (text === "invoice" && userStates[sender]?.quotationId) {
            const quotation = await getQuotationById(userStates[sender].quotationId);
            if (quotation) {
                const invoice = await generateInvoice(quotation.id, { method: 'Cash on Delivery', status: 'Pending' });
                await sendMessage(sock, sender, formatInvoiceMessage(invoice));
            }
            return;
        }
        
        // ========== ORDER PLACEMENT ==========
        if (text.startsWith("order ")) {
            const productRequested = text.replace("order ", "").trim();
            const menu = await getFullMenu();
            
            const matchedItem = menu.find(item => 
                item.name.toLowerCase().includes(productRequested) && 
                item.isActive && 
                item.stock > 0
            );

            if (!matchedItem) {
                await sendMessage(sock, sender, 
                    `❌ Sorry, *${productRequested}* not found or out of stock.\n\nType *menu* to see available items.`
                );
                return;
            }

            userStates[sender] = { 
                step: 'AWAITING_QUANTITY', 
                orderItem: matchedItem
            };
            
            await sendMessage(sock, sender, 
                `🛒 *${matchedItem.name}*\n💰 Price: ₹${matchedItem.price}\n📝 ${matchedItem.description || 'Delicious item!'}\n📦 In Stock: ${matchedItem.stock}\n\nHow many would you like to order?\n\n(Reply with a number, e.g., "2")`
            );
            return;
        }
        
        // ========== QUANTITY SELECTION ==========
        if (userStates[sender]?.step === 'AWAITING_QUANTITY') {
            const quantity = parseInt(text);
            if (isNaN(quantity) || quantity < 1) {
                await sendMessage(sock, sender, "❌ Please enter a valid number (e.g., 1, 2, 3)");
                return;
            }
            
            if (quantity > userStates[sender].orderItem.stock) {
                await sendMessage(sock, sender, 
                    `❌ Only ${userStates[sender].orderItem.stock} items in stock. Please enter a lower quantity.`
                );
                return;
            }
            
            userStates[sender].orderQuantity = quantity;
            userStates[sender].step = 'AWAITING_ADDRESS';
            
            await sendMessage(sock, sender, 
                "📍 *Delivery Details*\n\nPlease reply with:\n\n1. Full Name\n2. Complete Address\n3. Phone Number\n\n*Example:*\nJohn Doe, 123 Main Street, Apartment 4B, City - 123456, 9876543210"
            );
            return;
        }
        
        // ========== ADDRESS & ORDER CONFIRMATION ==========
        if (userStates[sender]?.step === 'AWAITING_ADDRESS') {
            const parts = text.split(',');
            const customerDetails = {
                name: parts[0]?.trim() || 'Customer',
                address: parts.slice(0, -1).join(',').trim() || text,
                phone: parts[parts.length - 1]?.trim() || senderNumber
            };
            
            const order = await processOrder(
                sender, 
                userStates[sender].orderItem, 
                userStates[sender].orderQuantity, 
                customerDetails
            );
            
            const orderMessage = `
✅ *ORDER CONFIRMED!*

┌─────────────────────────┐
│ Order #: ${order.id}
│ Customer: ${order.customerName}
│ Items: ${order.items[0].name} x${order.items[0].quantity}
│ Subtotal: ₹${order.subtotal}
│ Delivery Fee: ₹50
│ Total: ₹${order.total}
├─────────────────────────┤
│ Status: Confirmed ✓
│ Payment: Cash on Delivery
│ ETA: ~45 minutes
└─────────────────────────┘

Type *track ${order.id}* to check status.
            `;
            
            await sendMessage(sock, sender, orderMessage);
            
            if (ADMIN_NUMBER && ADMIN_NUMBER !== "1234567890") {
                await sock.sendMessage(ADMIN_NUMBER + '@s.whatsapp.net', { 
                    text: `🆕 *New Order #${order.id}*\n\nCustomer: ${customerDetails.name}\nPhone: ${customerDetails.phone}\nItems: ${order.items[0].name} x${order.items[0].quantity}\nTotal: ₹${order.total}`
                }).catch(e => console.log("Admin notification failed"));
            }
            
            delete userStates[sender];
            if (userTimeouts[sender]) {
                clearTimeout(userTimeouts[sender]);
                delete userTimeouts[sender];
            }
            return;
        }
        
        // ========== TRACK ORDER ==========
        if (text.startsWith("track ")) {
            const orderId = text.replace("track ", "").trim().toUpperCase();
            const response = await fetch(`${FIREBASE_URL}/orders.json`);
            const data = await response.json();
            
            let foundOrder = null;
            for (const key in data) {
                if (data[key].id === orderId) {
                    foundOrder = { id: key, ...data[key] };
                    break;
                }
            }
            
            if (!foundOrder) {
                await sendMessage(sock, sender, `❌ Order #${orderId} not found.`);
                return;
            }
            
            const statusMessages = {
                'Confirmed': '✅ Order confirmed',
                'Preparing': '👨‍🍳 Being prepared',
                'Out for Delivery': '🚚 Out for delivery',
                'Delivered': '🎉 Delivered!',
                'Cancelled': '❌ Cancelled'
            };
            
            await sendMessage(sock, sender, 
                `🔍 *ORDER STATUS*\n\nOrder #: ${foundOrder.id}\nStatus: ${foundOrder.status}\n${statusMessages[foundOrder.status] || 'Processing'}\nTotal: ₹${foundOrder.total}`
            );
            return;
        }
        
        // ========== FAQ COMMAND ==========
        if (text === "faq" || text === "help") {
            const faqMessage = await formatFAQMessage();
            const quickCommands = `
╔════════════════════════════════╗
║      📋 *QUICK COMMANDS*       ║
╠════════════════════════════════╣
║ menu      → Show full menu     ║
║ quote     → Get price quote    ║
║ order     → Place an order     ║
║ track     → Track order        ║
║ faq       → FAQs & help        ║
║ contact   → Support info       ║
║ cancel    → Cancel session     ║
╚════════════════════════════════╝
            `;
            await sendMessage(sock, sender, faqMessage + "\n" + quickCommands);
            return;
        }
        
        // ========== MENU COMMAND ==========
        if (text === "menu" || text === "prices" || text === "items") {
            const menuMessage = await formatMenuMessage();
            await sendMessage(sock, sender, menuMessage);
            return;
        }
        
        // ========== CONTACT COMMAND ==========
        if (text === "contact") {
            await sendMessage(sock, sender, 
                "📞 *CUSTOMER SUPPORT*\n\nPhone: +91 98765 43210\nEmail: support@example.com\nHours: 9 AM - 9 PM\n\nReply with your query, we'll respond within 2 hours."
            );
            return;
        }
        
        // ========== DEFAULT RESPONSE ==========
        if (!userStates[sender]) {
            await sendMessage(sock, sender, 
                "👋 *WELCOME!*\n\nI'm your AI ordering assistant.\n\n*Quick Start:*\n• Type *menu* to see products\n• Type *quote 2 pizza, 1 burger* for price\n• Type *faq* for questions\n• Type *contact* for support"
            );
        } else {
            await sendMessage(sock, sender, 
                "❓ I didn't understand that.\n\n*Current Session:* " + userStates[sender].step.replace(/_/g, ' ') + "\n\nType *cancel* to start over\nType *menu* for commands"
            );
        }
    });
}

// Start the bot
startBot().catch(err => {
    console.error("💥 Fatal error:", err);
    console.log("🔄 Restarting in 10 seconds...");
    setTimeout(startBot, 10000);
});
