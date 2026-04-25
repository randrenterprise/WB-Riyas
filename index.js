const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const pino = require('pino');

// Firebase URL from GitHub Secrets (no .env file)
const FIREBASE_URL = process.env.FIREBASE_URL;
const CURRENCY = process.env.CURRENCY || 'LKR';
const BUSINESS_NAME = process.env.BUSINESS_NAME || 'R & R Enterprise';
const DELIVERY_FEE = parseFloat(process.env.DELIVERY_FEE) || 0;

// Store user sessions
const userSessions = {};

// Helper: Fetch Catalog from Firebase
async function getCatalog() {
    try {
        const response = await fetch(`${FIREBASE_URL}/catalog.json`);
        const data = await response.json();
        if (!data) return [];
        
        return Object.keys(data).map(key => ({
            id: key,
            name: data[key].name,
            category: data[key].category || 'General',
            subcategories: data[key].subcategories || [],
            price: data[key].price,
            description: data[key].description || '',
            sku: data[key].sku || '',
            isParent: data[key].subcategories && data[key].subcategories.length > 0
        }));
    } catch (error) {
        console.error("Failed to fetch catalog:", error);
        return [];
    }
}

// Helper: Save Order
async function saveOrder(orderData) {
    try {
        const response = await fetch(`${FIREBASE_URL}/orders.json`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(orderData)
        });
        return await response.json();
    } catch (error) {
        console.error("Failed to save order:", error);
        throw error;
    }
}

// Helper: Save Quotation
async function saveQuotation(quotationData) {
    try {
        const response = await fetch(`${FIREBASE_URL}/quotations.json`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(quotationData)
        });
        return await response.json();
    } catch (error) {
        console.error("Failed to save quotation:", error);
        throw error;
    }
}

// Helper: Format Catalog Message
function formatCatalog(catalogItems) {
    let message = `📋 *${BUSINESS_NAME} - CATALOG* 📋\n\n`;
    
    // Group by category
    const categories = {};
    catalogItems.forEach(item => {
        if (!categories[item.category]) categories[item.category] = [];
        categories[item.category].push(item);
    });
    
    for (const [category, items] of Object.entries(categories)) {
        message += `*📁 ${category}*\n`;
        items.forEach(item => {
            if (item.isParent && item.subcategories.length > 0) {
                message += `└ 📌 *${item.name}* (Variations available)\n`;
                item.subcategories.forEach(sub => {
                    const subPrice = sub.price ? `${CURRENCY} ${sub.price}` : 'Price on request';
                    message += `   └ 🔹 ${sub.name} - ${subPrice}\n`;
                });
            } else {
                const priceText = item.price ? `${CURRENCY} ${item.price}` : 'Price on request';
                message += `└ 🔹 ${item.name} - ${priceText}\n`;
                if (item.description) message += `   └ 📝 ${item.description.substring(0, 50)}\n`;
            }
        });
        message += "\n";
    }
    
    message += "───────────────────\n";
    message += "*Commands:*\n";
    message += "📋 `catalog` - View full catalog\n";
    message += "🛒 `order` - Start new order/enquiry\n";
    message += "📊 `quote` - Get quotation\n";
    message += "🔍 `search [keyword]` - Search items\n";
    message += "📄 `status [orderID]` - Check order status\n";
    message += "❌ `cancel` - Cancel current\n";
    message += "ℹ️ `help` - Show this help\n";
    
    return message;
}

// Helper: Format Cart/Enquiry
function formatEnquiry(cart) {
    if (cart.length === 0) return "Your enquiry is empty!";
    
    let message = "🛒 *YOUR ENQUIRY* 🛒\n\n";
    cart.forEach((item, idx) => {
        message += `${idx + 1}. ${item.name}\n`;
        message += `   Quantity: ${item.quantity}\n`;
        if (item.price) message += `   Unit Price: ${CURRENCY} ${item.price}\n`;
        message += `   Subtotal: ${CURRENCY} ${(item.price || 0) * item.quantity}\n\n`;
    });
    
    const total = cart.reduce((sum, item) => sum + ((item.price || 0) * item.quantity), 0);
    message += "───────────────────\n";
    message += `*Total Amount: ${CURRENCY} ${total}*\n`;
    if (DELIVERY_FEE > 0) {
        message += `*Delivery: ${CURRENCY} ${DELIVERY_FEE}*\n`;
        message += `*Grand Total: ${CURRENCY} ${total + DELIVERY_FEE}*\n`;
    }
    message += "\n*Next Steps:*\n";
    message += "• `checkout` - Submit enquiry\n";
    message += "• `add [item]` - Add more\n";
    message += "• `remove [number]` - Remove item\n";
    message += "• `qty [number] [qty]` - Change quantity";
    
    return message;
}

// Helper: Generate Invoice/Quotation Text
function generateQuotationText(quoteId, customerDetails, items, total) {
    let text = `📄 *QUOTATION* 📄\n\n`;
    text += `${BUSINESS_NAME}\n`;
    text += `───────────────────\n`;
    text += `Quote #: ${quoteId}\n`;
    text += `Date: ${new Date().toLocaleString()}\n`;
    text += `───────────────────\n\n`;
    text += `*Customer:*\n`;
    text += `Name: ${customerDetails.name}\n`;
    text += `Contact: ${customerDetails.phone}\n`;
    text += `───────────────────\n\n`;
    text += `*Items/Service Details:*\n`;
    
    items.forEach((item, idx) => {
        text += `${idx + 1}. ${item.name}\n`;
        text += `   Quantity: ${item.quantity}\n`;
        if (item.price) text += `   Rate: ${CURRENCY} ${item.price}\n`;
        text += `   Amount: ${CURRENCY} ${(item.price || 0) * item.quantity}\n\n`;
    });
    
    text += `───────────────────\n`;
    text += `*Subtotal: ${CURRENCY} ${total}*\n`;
    if (DELIVERY_FEE > 0) text += `*Delivery: ${CURRENCY} ${DELIVERY_FEE}*\n`;
    text += `*Total: ${CURRENCY} ${total + DELIVERY_FEE}*\n`;
    text += `───────────────────\n\n`;
    text += `*Terms:*\n`;
    text += `• Valid for 7 days\n`;
    text += `• Payment: Cash/Transfer\n`;
    text += `• For confirmation, reply: confirm ${quoteId}\n\n`;
    text += `Thank you for choosing ${BUSINESS_NAME}!`;
    
    return text;
}

// Search Catalog
function searchCatalog(catalog, keyword) {
    const lowerKeyword = keyword.toLowerCase();
    return catalog.filter(item => 
        item.name.toLowerCase().includes(lowerKeyword) ||
        (item.description && item.description.toLowerCase().includes(lowerKeyword)) ||
        (item.subcategories && item.subcategories.some(sub => sub.name.toLowerCase().includes(lowerKeyword)))
    );
}

// Main Bot Function
async function startBot() {
    if (!FIREBASE_URL) {
        console.log("❌ ERROR: FIREBASE_URL is missing in GitHub Secrets!");
        console.log("Please add FIREBASE_URL to repository secrets.");
        process.exit(1);
    }

    console.log(`🚀 Starting ${BUSINESS_NAME} WhatsApp Bot`);
    console.log(`💰 Currency: ${CURRENCY}`);
    console.log(`🚚 Delivery Fee: ${DELIVERY_FEE} ${CURRENCY}`);

    const { state, saveCreds } = await useMultiFileAuthState('session_data');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: ["Business Bot", "Edge", "1.0"]
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.clear();
            console.log('\n═══════════════════════════════════════════');
            console.log('📱 SCAN QR CODE WITH WHATSAPP');
            console.log('═══════════════════════════════════════════\n');
            qrcode.generate(qr, { small: true });
            console.log('\n⏳ Waiting for connection...');
        }

        if (connection === 'open') {
            console.log(`✅ ${BUSINESS_NAME} Bot is ONLINE!`);
            console.log(`📡 Ready to handle enquiries & orders\n`);
        }
        
        if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode;
            if (reason !== DisconnectReason.loggedOut) {
                console.log('🔄 Bot disconnected, restarting in 5 seconds...');
                setTimeout(startBot, 5000);
            } else {
                console.log('🔐 Logged out. Please restart with new session.');
            }
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.remoteJid === 'status@broadcast') return;
        if (msg.key.fromMe) return;

        const sender = msg.key.remoteJid;
        let text = (msg.message.conversation || msg.message.extendedTextMessage?.text || "").trim();
        
        if (msg.message.imageMessage?.caption) {
            text = msg.message.imageMessage.caption;
        }
        
        const lowerText = text.toLowerCase();
        
        console.log(`📩 [${sender.split('@')[0]}]: ${text.substring(0, 50)}`);

        // Initialize session
        if (!userSessions[sender]) {
            userSessions[sender] = {
                step: 'IDLE',
                cart: [],
                tempData: {}
            };
        }

        const session = userSessions[sender];

        // --- HELP ---
        if (lowerText === 'help' || lowerText === 'start') {
            const catalog = await getCatalog();
            await sock.sendMessage(sender, { text: formatCatalog(catalog) });
            return;
        }

        // --- VIEW CATALOG ---
        if (lowerText === 'catalog' || lowerText === 'menu' || lowerText === 'list' || lowerText === 'products') {
            const catalog = await getCatalog();
            if (catalog.length === 0) {
                await sock.sendMessage(sender, { text: "📭 Our catalog is being updated. Please check back soon or contact us directly." });
            } else {
                await sock.sendMessage(sender, { text: formatCatalog(catalog) });
            }
            return;
        }

        // --- SEARCH ---
        if (lowerText.startsWith('search ')) {
            const keyword = text.substring(7);
            const catalog = await getCatalog();
            const results = searchCatalog(catalog, keyword);
            
            if (results.length === 0) {
                await sock.sendMessage(sender, { text: `🔍 No results found for "${keyword}". Try different keywords or view full catalog with 'catalog'` });
            } else {
                let resultText = `🔍 *Search Results for "${keyword}"*\n\n`;
                results.forEach(item => {
                    const priceText = item.price ? `${CURRENCY} ${item.price}` : 'Price on request';
                    resultText += `• *${item.name}* - ${priceText}\n`;
                    if (item.description) resultText += `  ${item.description.substring(0, 60)}...\n`;
                });
                resultText += `\nTo order, reply with: order ${results[0].name}`;
                await sock.sendMessage(sender, { text: resultText });
            }
            return;
        }

        // --- START ENQUIRY/ORDER ---
        if (lowerText === 'order' || lowerText === 'enquiry' || lowerText === 'new') {
            session.step = 'SELECTING_ITEMS';
            await sock.sendMessage(sender, { 
                text: `🛒 *Start Your Enquiry*\n\nTell us what you need. Format:\n\n• \`2x Product Name\`\n• \`Service Name\`\n• \`3 units of Item\`\n\nType \`done\` when finished or \`catalog\` to browse.\n\nType \`cancel\` to abort.` 
            });
            return;
        }

        // --- ADD TO CART ---
        if (session.step === 'SELECTING_ITEMS' && lowerText !== 'done') {
            const catalog = await getCatalog();
            
            let quantity = 1;
            let itemName = text;
            
            // Parse quantity (supports: 2x, 3 units of, 5 nos, quantity 4)
            const qtyMatch = text.match(/^(\d+)\s*[x× units of nos quantity]*\s*(.+)$/i);
            if (qtyMatch) {
                quantity = parseInt(qtyMatch[1]);
                itemName = qtyMatch[2].trim();
            }
            
            // Find item in catalog
            let foundItem = null;
            
            for (const catalogItem of catalog) {
                if (catalogItem.name.toLowerCase() === itemName.toLowerCase()) {
                    if (catalogItem.isParent && catalogItem.subcategories.length > 0) {
                        const subList = catalogItem.subcategories.map((sub, i) => `${i+1}. ${sub.name}${sub.price ? ` - ${CURRENCY} ${sub.price}` : ''}`).join('\n');
                        await sock.sendMessage(sender, { 
                            text: `📌 *${catalogItem.name}* - Choose variation:\n\n${subList}\n\nReply with the number or name.` 
                        });
                        session.tempData.waitingForSubmenu = catalogItem;
                        session.tempData.quantity = quantity;
                        return;
                    }
                    foundItem = catalogItem;
                    break;
                }
                
                if (catalogItem.subcategories) {
                    for (const subItem of catalogItem.subcategories) {
                        if (subItem.name.toLowerCase() === itemName.toLowerCase()) {
                            foundItem = { ...subItem, isSubmenu: true, parentName: catalogItem.name };
                            break;
                        }
                    }
                }
            }
            
            if (foundItem) {
                const existingItem = session.cart.find(i => i.name === foundItem.name);
                if (existingItem) {
                    existingItem.quantity += quantity;
                } else {
                    session.cart.push({
                        id: foundItem.id || Date.now(),
                        name: foundItem.name,
                        price: foundItem.price || 0,
                        quantity: quantity,
                        parentName: foundItem.parentName || null,
                        sku: foundItem.sku || null
                    });
                }
                const total = session.cart.reduce((sum, i) => sum + (i.price * i.quantity), 0);
                await sock.sendMessage(sender, { 
                    text: `✅ Added ${quantity}x ${foundItem.name}\n\n📊 Current Total: ${CURRENCY} ${total}\n\nSend more items or type 'done' to finish.` 
                });
            } else {
                await sock.sendMessage(sender, { 
                    text: `❌ "${itemName}" not found.\n\nType 'catalog' to see available items or 'search [keyword]' to find something.` 
                });
            }
            return;
        }
        
        // --- SUBMENU SELECTION ---
        if (session.tempData.waitingForSubmenu) {
            const parentItem = session.tempData.waitingForSubmenu;
            const quantity = session.tempData.quantity || 1;
            let selectedSub = null;
            
            const numMatch = parseInt(text);
            if (!isNaN(numMatch) && numMatch >= 1 && numMatch <= parentItem.subcategories.length) {
                selectedSub = parentItem.subcategories[numMatch - 1];
            } else {
                selectedSub = parentItem.subcategories.find(sub => sub.name.toLowerCase() === text.toLowerCase());
            }
            
            if (selectedSub) {
                session.cart.push({
                    id: Date.now(),
                    name: `${parentItem.name} - ${selectedSub.name}`,
                    price: selectedSub.price || 0,
                    quantity: quantity,
                    parentName: parentItem.name
                });
                const total = session.cart.reduce((sum, i) => sum + (i.price * i.quantity), 0);
                await sock.sendMessage(sender, { 
                    text: `✅ Added ${quantity}x ${selectedSub.name}\n\n📊 Current Total: ${CURRENCY} ${total}\n\nSend more or type 'done' to finish.` 
                });
            } else {
                await sock.sendMessage(sender, { text: `❌ Invalid option. Reply with number (1-${parentItem.subcategories.length}) or exact name.` });
            }
            
            session.tempData.waitingForSubmenu = null;
            session.tempData.quantity = null;
            return;
        }

        // --- DONE SELECTING ---
        if (session.step === 'SELECTING_ITEMS' && lowerText === 'done') {
            if (session.cart.length === 0) {
                await sock.sendMessage(sender, { text: "❌ No items added. Start with 'order' command." });
                return;
            }
            
            session.step = 'WAITING_FOR_DETAILS';
            await sock.sendMessage(sender, { 
                text: `📝 *Almost Done!*\n\n${formatEnquiry(session.cart)}\n\nPlease send your contact details:\n\n\`Name, Phone Number, Address/Details\`\n\nExample:\nJohn Doe, 0712345678, Colombo` 
            });
            return;
        }

        // --- HANDLE CUSTOMER DETAILS & CREATE ORDER/QUOTATION ---
        if (session.step === 'WAITING_FOR_DETAILS') {
            // Parse customer details
            const parts = text.split(',').map(p => p.trim());
            const customerName = parts[0] || "Customer";
            const phoneMatch = text.match(/(\d{9,10})/);
            const phone = phoneMatch ? phoneMatch[1] : (parts[1] || "Not provided");
            const address = parts[2] || parts.slice(1).join(', ') || text;
            
            const subtotal = session.cart.reduce((sum, item) => sum + ((item.price || 0) * item.quantity), 0);
            const grandTotal = subtotal + DELIVERY_FEE;
            
            const orderData = {
                orderId: `ORD${Date.now()}`,
                businessName: BUSINESS_NAME,
                customer: {
                    name: customerName,
                    phone: phone,
                    address: address,
                    waId: sender.split('@')[0]
                },
                items: session.cart,
                subtotal: subtotal,
                deliveryFee: DELIVERY_FEE,
                total: grandTotal,
                currency: CURRENCY,
                status: 'Pending',
                type: 'enquiry',
                timestamp: new Date().toISOString()
            };
            
            // Save order
            const savedOrder = await saveOrder(orderData);
            orderData.firebaseId = savedOrder.name;
            
            // Generate quotation text
            const quoteId = `QT${Date.now().toString().slice(-8)}`;
            const quotationText = generateQuotationText(quoteId, orderData.customer, session.cart, subtotal);
            
            // Save quotation
            await saveQuotation({
                quoteId: quoteId,
                orderId: orderData.orderId,
                customer: orderData.customer,
                items: session.cart,
                total: grandTotal,
                currency: CURRENCY,
                status: 'Sent',
                timestamp: new Date().toISOString()
            });
            
            // Send quotation
            await sock.sendMessage(sender, { text: quotationText });
            
            // Send confirmation
            await sock.sendMessage(sender, { 
                text: `✅ *Enquiry Received!*\n\nReference: ${orderData.orderId}\n\nWe'll respond within 24 hours.\n\nTo check status: \`status ${orderData.orderId}\`\n\nThank you for choosing ${BUSINESS_NAME}!` 
            });
            
            // Notify admin (optional - add admin number in secrets)
            if (process.env.ADMIN_NUMBER) {
                await sock.sendMessage(process.env.ADMIN_NUMBER, { 
                    text: `🔔 *NEW ENQUIRY*\n\nOrder: ${orderData.orderId}\nCustomer: ${customerName}\nTotal: ${CURRENCY} ${grandTotal}\n\nCheck dashboard for details.` 
                });
            }
            
            // Reset session
            session.step = 'IDLE';
            session.cart = [];
            session.tempData = {};
            
            return;
        }

        // --- GENERATE QUOTATION ONLY ---
        if (lowerText === 'quote' || lowerText === 'quotation' || lowerText === 'estimate') {
            if (session.cart.length === 0) {
                await sock.sendMessage(sender, { 
                    text: "📊 *Generate Quotation*\n\nFirst add items using 'order' command, then send 'quote' again." 
                });
                return;
            }
            
            const subtotal = session.cart.reduce((sum, item) => sum + ((item.price || 0) * item.quantity), 0);
            const quoteId = `QT${Date.now().toString().slice(-8)}`;
            
            const tempCustomer = {
                name: "Customer",
                phone: session.cart[0]?.customerPhone || "Not provided"
            };
            
            const quotationText = generateQuotationText(quoteId, tempCustomer, session.cart, subtotal);
            
            await saveQuotation({
                quoteId: quoteId,
                items: session.cart,
                total: subtotal + DELIVERY_FEE,
                currency: CURRENCY,
                status: 'Draft',
                timestamp: new Date().toISOString()
            });
            
            await sock.sendMessage(sender, { text: quotationText });
            return;
        }
        
        // --- CONFIRM QUOTATION ---
        const confirmMatch = lowerText.match(/confirm\s+(qt\d+)/i);
        if (confirmMatch) {
            const quoteId = confirmMatch[1];
            await sock.sendMessage(sender, { 
                text: `✅ Quotation ${quoteId} confirmed!\n\nPlease send your delivery address and contact details to proceed.\n\nFormat: Name, Phone, Address` 
            });
            session.step = 'WAITING_FOR_DETAILS';
            return;
        }
        
        // --- CHECK ORDER STATUS ---
        const statusMatch = lowerText.match(/status\s+(ord\d+)/i);
        if (statusMatch) {
            const orderId = statusMatch[1];
            try {
                const response = await fetch(`${FIREBASE_URL}/orders.json?orderBy="orderId"&equalTo="${orderId}"`);
                const data = await response.json();
                const order = Object.values(data)[0];
                
                if (order) {
                    let statusMessage = `📦 *Order Status* 📦\n\n`;
                    statusMessage += `Order ID: ${order.orderId}\n`;
                    statusMessage += `Status: ${order.status}\n`;
                    statusMessage += `Total: ${order.currency} ${order.total}\n`;
                    statusMessage += `Date: ${new Date(order.timestamp).toLocaleDateString()}\n\n`;
                    
                    const statusSteps = ['Pending', 'Processing', 'Confirmed', 'Completed', 'Delivered'];
                    const currentStep = statusSteps.indexOf(order.status);
                    
                    if (currentStep >= 0) {
                        statusMessage += `Progress:\n`;
                        statusSteps.forEach((step, idx) => {
                            const emoji = idx <= currentStep ? '✅' : '⭕';
                            statusMessage += `${emoji} ${step}\n`;
                        });
                    }
                    
                    await sock.sendMessage(sender, { text: statusMessage });
                } else {
                    await sock.sendMessage(sender, { text: `❌ Order ${orderId} not found. Please check the ID and try again.` });
                }
            } catch (error) {
                await sock.sendMessage(sender, { text: `❌ Unable to fetch status. Please contact support.` });
            }
            return;
        }
        
        // --- VIEW CART ---
        if (lowerText === 'cart' || lowerText === 'view' || lowerText === 'enquiry') {
            await sock.sendMessage(sender, { text: formatEnquiry(session.cart) });
            return;
        }
        
        // --- MODIFY CART ---
        if (lowerText.startsWith('qty ') && session.cart.length > 0) {
            const parts = text.split(' ');
            if (parts.length >= 3) {
                const itemNum = parseInt(parts[1]) - 1;
                const newQty = parseInt(parts[2]);
                if (session.cart[itemNum] && newQty > 0) {
                    session.cart[itemNum].quantity = newQty;
                    await sock.sendMessage(sender, { text: formatEnquiry(session.cart) });
                }
            }
            return;
        }
        
        if (lowerText.startsWith('remove ') && session.cart.length > 0) {
            const itemNum = parseInt(text.split(' ')[1]) - 1;
            if (session.cart[itemNum]) {
                const removed = session.cart.splice(itemNum, 1);
                await sock.sendMessage(sender, { text: `✅ Removed ${removed[0].name}\n\n${formatEnquiry(session.cart)}` });
            }
            return;
        }
        
        // --- CHECKOUT ---
        if (lowerText === 'checkout' && session.cart.length > 0) {
            session.step = 'WAITING_FOR_DETAILS';
            await sock.sendMessage(sender, { 
                text: `📝 Please send your contact details:\n\n\`Name, Phone Number, Address/Details\`\n\nExample:\nJohn Doe, 0712345678, Colombo` 
            });
            return;
        }
        
        // --- CANCEL ---
        if (lowerText === 'cancel' && session.step !== 'IDLE') {
            session.step = 'IDLE';
            session.cart = [];
            session.tempData = {};
            await sock.sendMessage(sender, { text: "❌ Enquiry cancelled. Start fresh with 'order' when ready." });
            return;
        }
        
        // --- ABOUT / CONTACT ---
        if (lowerText === 'about' || lowerText === 'contact' || lowerText === 'info') {
            await sock.sendMessage(sender, { 
                text: `ℹ️ *About ${BUSINESS_NAME}*\n\nWe provide quality products/services with customer satisfaction guarantee.\n\n📞 Contact: ${process.env.CONTACT_NUMBER || 'Not specified'}\n📧 Email: ${process.env.CONTACT_EMAIL || 'Not specified'}\n\n🕒 Business Hours: Mon-Sat, 9AM-6PM\n\nType 'catalog' to browse our offerings.` 
            });
            return;
        }
        
        // --- BUSINESS HOURS ---
        if (lowerText === 'hours' || lowerText === 'timing') {
            await sock.sendMessage(sender, { 
                text: `🕒 *Business Hours*\n\nMonday - Friday: 9:00 AM - 6:00 PM\nSaturday: 9:00 AM - 4:00 PM\nSunday: Closed\n\nEnquiries received outside hours will be processed next business day.` 
            });
            return;
        }

        // --- DEFAULT RESPONSE ---
        await sock.sendMessage(sender, { 
            text: `🤔 *I didn't understand that.*\n\nType *help* to see all commands.\n\nOr type *catalog* to browse our products/services.` 
        });
    });
}

// Start the bot
startBot().catch(err => {
    console.error("💥 Fatal error:", err);
    process.exit(1);
});
