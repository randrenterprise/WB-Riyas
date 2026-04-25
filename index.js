const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const pino = require('pino');

const FIREBASE_URL = process.env.FIREBASE_URL;
const ADMIN_NUMBER = "1234567890";

const userStates = {};
const userTimeouts = {};

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

async function resetUserTimeout(sender) {
    if (userTimeouts[sender]) clearTimeout(userTimeouts[sender]);
    const settings = await getTimeoutSettings();
    if (settings.enabled && userStates[sender]) {
        userTimeouts[sender] = setTimeout(async () => {
            if (userStates[sender]) {
                delete userStates[sender];
                await sendMessage(sock, sender, settings.message);
                console.log(`⏰ Session timed out for ${sender}`);
            }
        }, settings.duration * 1000);
    }
}

let sockGlobal = null;
async function sendMessage(sock, sender, text, options = {}) {
    try {
        await sock.sendMessage(sender, { text: text, ...options });
        await resetUserTimeout(sender);
    } catch (error) {
        console.error("Send message error:", error);
    }
}

async function sendPDF(sock, sender, pdfUrl, filename) {
    try {
        await sock.sendMessage(sender, { 
            document: { url: pdfUrl },
            fileName: filename,
            mimetype: 'application/pdf',
            caption: '📄 Here is your document'
        });
        await resetUserTimeout(sender);
    } catch (error) {
        console.error("Send PDF error:", error);
    }
}

async function getServices() {
    try {
        const response = await fetch(`${FIREBASE_URL}/services.json`);
        const data = await response.json();
        if (!data) return [];
        return Object.keys(data).map(key => ({
            id: key,
            category: data[key].category,
            name: data[key].name,
            description: data[key].description,
            startingPrice: data[key].startingPrice,
            includes: data[key].includes || [],
            isActive: data[key].isActive !== false
        }));
    } catch (error) {
        console.error("Failed to fetch services:", error);
        return [];
    }
}

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

async function generateQuotation(userId, service, customerInfo, customRequirements) {
    const quotation = {
        id: 'QT-' + Date.now(),
        userId: userId,
        customerName: customerInfo.name,
        customerPhone: customerInfo.phone,
        customerEmail: customerInfo.email || '',
        customerAddress: customerInfo.address || '',
        service: service,
        customRequirements: customRequirements,
        estimatedPrice: service.startingPrice,
        finalPrice: null,
        status: 'Pending',
        createdAt: new Date().toISOString(),
        validUntil: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
    };
    
    const response = await fetch(`${FIREBASE_URL}/quotations.json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(quotation)
    });
    
    const result = await response.json();
    quotation.firebaseId = result.name;
    
    // Trigger PDF generation
    await triggerPDFGeneration('quotation', quotation);
    
    return quotation;
}

async function createServiceRequest(userId, service, customerDetails, issue) {
    const request = {
        id: 'SR-' + Date.now(),
        userId: userId,
        customerName: customerDetails.name,
        customerPhone: customerDetails.phone,
        customerAddress: customerDetails.address,
        serviceType: service.name,
        serviceCategory: service.category,
        issueDescription: issue,
        preferredDate: customerDetails.preferredDate || null,
        preferredTime: customerDetails.preferredTime || null,
        status: 'Pending',
        assignedTo: null,
        createdAt: new Date().toISOString(),
        scheduledDate: null
    };
    
    const response = await fetch(`${FIREBASE_URL}/service_requests.json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request)
    });
    
    const result = await response.json();
    request.firebaseId = result.name;
    
    // Trigger PDF generation
    await triggerPDFGeneration('service_request', request);
    
    return request;
}

async function triggerPDFGeneration(type, data) {
    try {
        const pdfUrl = `${FIREBASE_URL.replace('.json', '')}/generate_pdf.php`;
        const response = await fetch(pdfUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: type, data: data })
        });
        const result = await response.json();
        return result.pdfUrl;
    } catch (error) {
        console.error("PDF Generation Error:", error);
        return null;
    }
}

async function formatServicesMessage() {
    const services = await getServices();
    const activeServices = services.filter(s => s.isActive);
    
    if (activeServices.length === 0) {
        return "🔧 Our service catalog is being updated. Please contact us directly for assistance.";
    }
    
    const categorized = {};
    activeServices.forEach(service => {
        if (!categorized[service.category]) categorized[service.category] = [];
        categorized[service.category].push(service);
    });
    
    let message = "🔧 *OUR SERVICES* 🔧\n\n";
    
    const categoryIcons = {
        'CCTV': '📹',
        'Electrical': '⚡',
        'Maintenance': '🛠️',
        'Repair': '🔨',
        'Installation': '📡'
    };
    
    for (const [category, services] of Object.entries(categorized)) {
        const icon = categoryIcons[category] || '📋';
        message += `*${icon} ${category.toUpperCase()}*\n`;
        services.forEach(service => {
            message += `┌ *${service.name}*\n`;
            message += `│ 📝 ${service.description}\n`;
            message += `│ 💰 Starting from ₹${service.startingPrice}\n`;
            if (service.includes && service.includes.length > 0) {
                message += `│ ✓ Includes: ${service.includes.join(', ')}\n`;
            }
            message += `└ Type "request ${service.name.toLowerCase()}"\n\n`;
        });
    }
    
    message += "\n💡 *Quick Commands:*\n";
    message += "• `quote [service]` - Get price estimate\n";
    message += "• `request [service]` - Book service\n";
    message += "• `track [SR-xxxx]` - Track request\n";
    message += "• `pdf [QT-xxxx]` - Download PDF\n";
    message += "• `faq` - Common questions\n";
    message += "• `emergency` - Emergency support\n";
    message += "• `contact` - Contact us";
    
    return message;
}

async function formatFAQMessage() {
    const faqs = await getFAQs();
    if (faqs.length === 0) return "No FAQs available. Type 'contact' for support.";
    
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

async function startBot() {
    if (!FIREBASE_URL) {
        console.log("❌ ERROR: FIREBASE_URL not found in GitHub Secrets!");
        process.exit(1);
    }

    console.log("🚀 Starting Advanced Service WhatsApp Bot...");
    console.log(`📡 Firebase URL: ${FIREBASE_URL}`);

    const { state, saveCreds } = await useMultiFileAuthState('session_data');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: ["WhatsApp", "ServiceBot", "2.0"]
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
        }

        if (connection === 'open') {
            console.log('\n✅ BOT IS ONLINE!');
            console.log(`📱 Ready to handle service requests with PDF generation!`);
            
            if (ADMIN_NUMBER && ADMIN_NUMBER !== "1234567890") {
                try {
                    await sock.sendMessage(ADMIN_NUMBER + '@s.whatsapp.net', { 
                        text: `🔧 *Advanced Service Bot Online!*\n\n✅ PDF Generation Active\n✅ Auto Quotation System\n✅ Service Request Management\n📅 Time: ${new Date().toLocaleString()}` 
                    });
                } catch(e) { console.log("Admin notification failed"); }
            }
        }
        
        if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode;
            if (reason !== DisconnectReason.loggedOut) {
                console.log('🔄 Restarting bot...');
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

        // PDF Download Command
        if (text.startsWith("pdf ")) {
            const docId = text.replace("pdf ", "").trim().toUpperCase();
            
            // Check in quotations
            let response = await fetch(`${FIREBASE_URL}/quotations.json?orderBy="id"&equalTo="${docId}"`);
            let data = await response.json();
            let doc = null;
            let docType = null;
            
            for (const key in data) {
                doc = data[key];
                docType = 'quotation';
                break;
            }
            
            if (!doc) {
                // Check in service requests
                response = await fetch(`${FIREBASE_URL}/service_requests.json?orderBy="id"&equalTo="${docId}"`);
                data = await response.json();
                for (const key in data) {
                    doc = data[key];
                    docType = 'service_request';
                    break;
                }
            }
            
            if (doc && doc.pdfUrl) {
                await sendPDF(sock, sender, doc.pdfUrl, `${docType}_${docId}.pdf`);
            } else {
                await sendMessage(sock, sender, `❌ Document ${docId} not found or PDF not generated yet.`);
            }
            return;
        }

        // Cancel Command
        if (text === "cancel" && userStates[sender]) {
            delete userStates[sender];
            if (userTimeouts[sender]) clearTimeout(userTimeouts[sender]);
            await sendMessage(sock, sender, "✅ Session cancelled! Type *menu* to start fresh.");
            return;
        }

        // Emergency Command
        if (text === "emergency") {
            await sendMessage(sock, sender, 
                "🚨 *EMERGENCY SUPPORT*\n\nFor immediate assistance:\n📞 Call: +91 98765 43210\n📱 WhatsApp Emergency: +91 98765 43210\n\n⚠️ For electrical emergencies, please call directly."
            );
            
            if (ADMIN_NUMBER && ADMIN_NUMBER !== "1234567890") {
                await sock.sendMessage(ADMIN_NUMBER + '@s.whatsapp.net', { 
                    text: `🚨 *EMERGENCY ALERT*\nCustomer: +${senderNumber}\nTime: ${new Date().toLocaleString()}\nPlease contact immediately!`
                }).catch(e => console.log("Admin notification failed"));
            }
            return;
        }

        // Quote Request
        if (text.startsWith("quote ")) {
            const serviceName = text.replace("quote ", "").trim();
            const services = await getServices();
            const matchedService = services.find(s => 
                s.name.toLowerCase().includes(serviceName) && s.isActive
            );
            
            if (!matchedService) {
                await sendMessage(sock, sender, 
                    `❌ Service "${serviceName}" not found.\n\nType *menu* to see all available services.`
                );
                return;
            }
            
            userStates[sender] = {
                step: 'AWAITING_QUOTE_DETAILS',
                service: matchedService
            };
            
            await sendMessage(sock, sender, 
                `📋 *Quote Request: ${matchedService.name}*\n\nStarting from: ₹${matchedService.startingPrice}\n\nPlease provide:\n1. Full Name\n2. Phone Number\n3. Address\n4. Any specific requirements\n\n*Example:*\nJohn Doe, 9876543210, 123 Main Street, Need 4 cameras installed with night vision`
            );
            return;
        }
        
        // Quote Details
        if (userStates[sender]?.step === 'AWAITING_QUOTE_DETAILS') {
            const parts = text.split(',');
            const customerInfo = {
                name: parts[0]?.trim() || 'Customer',
                phone: parts[1]?.trim() || senderNumber,
                address: parts[2]?.trim() || 'Not provided',
                email: ''
            };
            const requirements = parts.slice(3).join(',').trim() || 'No specific requirements';
            
            const quotation = await generateQuotation(
                sender, 
                userStates[sender].service, 
                customerInfo, 
                requirements
            );
            
            const quoteMessage = `
╔════════════════════════════════════╗
║        📄 *QUOTATION #${quotation.id}*     ║
╠════════════════════════════════════╣
║ Service: ${quotation.service.name}
║ Category: ${quotation.service.category}
║ Customer: ${quotation.customerName}
║ Phone: ${quotation.customerPhone}
╠════════════════════════════════════╣
║ Requirements: ${quotation.customRequirements}
╠════════════════════════════════════╣
║ *Estimated Price: ₹${quotation.estimatedPrice}*
║ (Final price may vary after site visit)
╠════════════════════════════════════╣
║ Valid Until: ${new Date(quotation.validUntil).toLocaleDateString()}
║ Status: Pending
╠════════════════════════════════════╣
║ *PDF Generated!*                    ║
║ Type "pdf ${quotation.id}" to download
╠════════════════════════════════════╣
║ *Next Steps:*                       ║
║ • Type "accept" to confirm          ║
║ • Type "modify" to change request   ║
║ • Type "schedule" to book visit     ║
╚════════════════════════════════════╝
            `;
            
            await sendMessage(sock, sender, quoteMessage);
            
            if (ADMIN_NUMBER && ADMIN_NUMBER !== "1234567890") {
                await sock.sendMessage(ADMIN_NUMBER + '@s.whatsapp.net', { 
                    text: `🆕 *New Quote Request*\n\nFrom: ${customerInfo.name}\nPhone: ${customerInfo.phone}\nService: ${quotation.service.name}\nQuote: ${quotation.id}\nPDF Generated!`
                }).catch(e => console.log("Admin notification failed"));
            }
            
            userStates[sender].step = 'AWAITING_QUOTE_ACTION';
            userStates[sender].quotationId = quotation.id;
            return;
        }
        
        // Accept Quote
        if (text === "accept" && userStates[sender]?.step === 'AWAITING_QUOTE_ACTION') {
            await fetch(`${FIREBASE_URL}/quotations/${userStates[sender].quotationId}.json`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status: 'Accepted' })
            });
            
            userStates[sender].step = 'AWAITING_SCHEDULE';
            
            await sendMessage(sock, sender, 
                "✅ *Quote Accepted!*\n\nPlease provide your preferred date and time for site visit.\n\n*Example:*\nTomorrow, 10 AM - 12 PM\nor\nMonday, 2 PM"
            );
            return;
        }
        
        // Schedule Service
        if (userStates[sender]?.step === 'AWAITING_SCHEDULE') {
            userStates[sender].preferredSchedule = text;
            userStates[sender].step = 'AWAITING_SERVICE_REQUEST';
            
            await sendMessage(sock, sender, 
                `📅 *Schedule Received*\n\nPreferred: ${text}\n\nOne of our technicians will confirm the appointment within 2 hours.\n\nType *confirm* to proceed or *modify* to change schedule.`
            );
            return;
        }
        
        // Confirm Service Request
        if (text === "confirm" && userStates[sender]?.step === 'AWAITING_SERVICE_REQUEST') {
            const quoteId = userStates[sender].quotationId;
            const response = await fetch(`${FIREBASE_URL}/quotations/${quoteId}.json`);
            const quote = await response.json();
            
            const serviceRequest = {
                id: 'SR-' + Date.now(),
                quotationId: quoteId,
                customerName: quote.customerName,
                customerPhone: quote.customerPhone,
                customerAddress: quote.customerAddress,
                serviceType: quote.service.name,
                serviceCategory: quote.service.category,
                requirements: quote.customRequirements,
                preferredSchedule: userStates[sender].preferredSchedule,
                status: 'Confirmed',
                createdAt: new Date().toISOString()
            };
            
            const requestResult = await fetch(`${FIREBASE_URL}/service_requests.json`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(serviceRequest)
            });
            
            const result = await requestResult.json();
            serviceRequest.firebaseId = result.name;
            
            // Trigger PDF for service request
            await triggerPDFGeneration('service_request', serviceRequest);
            
            await sendMessage(sock, sender, 
                `✅ *Service Request Confirmed!*\n\nRequest ID: ${serviceRequest.id}\nStatus: Confirmed\n\nPDF Generated! Type *pdf ${serviceRequest.id}* to download.\n\nWe will contact you shortly to confirm the appointment.\n\nType *track ${serviceRequest.id}* to check status.`
            );
            
            if (ADMIN_NUMBER && ADMIN_NUMBER !== "1234567890") {
                await sock.sendMessage(ADMIN_NUMBER + '@s.whatsapp.net', { 
                    text: `🆕 *New Service Request #${serviceRequest.id}*\n\nCustomer: ${quote.customerName}\nPhone: ${quote.customerPhone}\nService: ${quote.service.name}\nPreferred: ${userStates[sender].preferredSchedule}\nPDF Generated!`
                }).catch(e => console.log("Admin notification failed"));
            }
            
            delete userStates[sender];
            return;
        }
        
        // Service Request (Direct)
        if (text.startsWith("request ")) {
            const serviceName = text.replace("request ", "").trim();
            const services = await getServices();
            const matchedService = services.find(s => 
                s.name.toLowerCase().includes(serviceName) && s.isActive
            );
            
            if (!matchedService) {
                await sendMessage(sock, sender, 
                    `❌ Service "${serviceName}" not found.\n\nType *menu* to see all services.`
                );
                return;
            }
            
            userStates[sender] = {
                step: 'AWAITING_SERVICE_DETAILS',
                service: matchedService
            };
            
            await sendMessage(sock, sender, 
                `🔧 *Service Request: ${matchedService.name}*\n\nPlease provide:\n1. Full Name\n2. Phone Number\n3. Complete Address\n4. Issue/Requirement description\n\n*Example:*\nJohn Doe, 9876543210, 123 Main Street, 2 CCTV cameras not working`
            );
            return;
        }
        
        // Service Details
        if (userStates[sender]?.step === 'AWAITING_SERVICE_DETAILS') {
            const parts = text.split(',');
            const customerDetails = {
                name: parts[0]?.trim() || 'Customer',
                phone: parts[1]?.trim() || senderNumber,
                address: parts[2]?.trim() || 'Not provided'
            };
            const issue = parts.slice(3).join(',').trim() || 'No details provided';
            
            const request = await createServiceRequest(
                sender,
                userStates[sender].service,
                customerDetails,
                issue
            );
            
            await sendMessage(sock, sender, 
                `✅ *Service Request Created!*\n\nRequest ID: ${request.id}\nService: ${request.serviceType}\nStatus: ${request.status}\n\nPDF Generated! Type *pdf ${request.id}* to download.\n\nWe will contact you within 2 hours to confirm the schedule.\n\nType *track ${request.id}* for updates.`
            );
            
            if (ADMIN_NUMBER && ADMIN_NUMBER !== "1234567890") {
                await sock.sendMessage(ADMIN_NUMBER + '@s.whatsapp.net', { 
                    text: `🆕 *New Service Request #${request.id}*\n\nCustomer: ${customerDetails.name}\nPhone: ${customerDetails.phone}\nService: ${request.serviceType}\nIssue: ${issue}\nPDF Generated!`
                }).catch(e => console.log("Admin notification failed"));
            }
            
            delete userStates[sender];
            return;
        }
        
        // Track Request
        if (text.startsWith("track ")) {
            const requestId = text.replace("track ", "").trim().toUpperCase();
            const response = await fetch(`${FIREBASE_URL}/service_requests.json`);
            const data = await response.json();
            
            let found = null;
            for (const key in data) {
                if (data[key].id === requestId) {
                    found = { id: key, ...data[key] };
                    break;
                }
            }
            
            if (!found) {
                await sendMessage(sock, sender, `❌ Request #${requestId} not found.`);
                return;
            }
            
            const statusMessages = {
                'Pending': '⏳ Your request is pending review',
                'Confirmed': '✅ Request confirmed, technician will be assigned soon',
                'Assigned': '👨‍🔧 A technician has been assigned to your request',
                'In Progress': '🛠️ Work is in progress',
                'Completed': '🎉 Service completed successfully!',
                'Cancelled': '❌ Request cancelled'
            };
            
            await sendMessage(sock, sender, 
                `🔍 *SERVICE REQUEST STATUS*\n\nRequest ID: ${found.id}\nService: ${found.serviceType}\nStatus: ${found.status}\n${statusMessages[found.status] || 'Processing'}\n\nCreated: ${new Date(found.createdAt).toLocaleDateString()}\n\nType *pdf ${found.id}* to download service document.`
            );
            return;
        }
        
        // FAQ Command
        if (text === "faq" || text === "help") {
            const faqMessage = await formatFAQMessage();
            const quickCommands = `
╔════════════════════════════════════╗
║      📋 *QUICK COMMANDS*           ║
╠════════════════════════════════════╣
║ menu      → Show all services      ║
║ quote     → Get price estimate     ║
║ request   → Book a service         ║
║ track     → Track request status   ║
║ pdf       → Download PDF document  ║
║ emergency → Urgent support         ║
║ faq       → FAQs & help            ║
║ contact   → Contact us             ║
║ cancel    → Cancel session         ║
╚════════════════════════════════════╝
            `;
            await sendMessage(sock, sender, faqMessage + "\n" + quickCommands);
            return;
        }
        
        // Menu Command
        if (text === "menu" || text === "services") {
            const servicesMessage = await formatServicesMessage();
            await sendMessage(sock, sender, servicesMessage);
            return;
        }
        
        // Contact Command
        if (text === "contact") {
            await sendMessage(sock, sender, 
                "📞 *CONTACT US*\n\n┌─────────────────────────┐\n│ Phone: +91 98765 43210\n│ WhatsApp: +91 98765 43210\n│ Email: support@servicepro.com\n│ Hours: 9 AM - 8 PM (Mon-Sat)\n├─────────────────────────┤\n│ *Emergency Support:*\n│ 24/7 for electrical issues\n│ Call: +91 98765 43210\n└─────────────────────────┘"
            );
            return;
        }
        
        // Default Response
        if (!userStates[sender]) {
            await sendMessage(sock, sender, 
                "🔧 *WELCOME TO SERVICE PRO*\n\nWe provide:\n📹 CCTV Installation & Repair\n⚡ Electrical Work\n🛠️ Maintenance Services\n🔨 Repairs\n\n*Quick Start:*\n• Type *menu* to see all services\n• Type *quote [service]* for estimate with PDF\n• Type *request [service]* to book service\n• Type *emergency* for urgent help\n• Type *faq* for common questions\n\nAll documents auto-generate as PDF!"
            );
        } else {
            await sendMessage(sock, sender, 
                "❓ I didn't understand that.\n\n*Current Session:* " + userStates[sender].step.replace(/_/g, ' ') + "\n\nType *cancel* to start over\nType *menu* for available commands"
            );
        }
    });
}

startBot().catch(err => {
    console.error("💥 Fatal error:", err);
    console.log("🔄 Restarting in 10 seconds...");
    setTimeout(startBot, 10000);
});
