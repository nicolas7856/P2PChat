/**
 * P2P AirChat - Core Logic
 * Implementazione WebRTC Serverless con Foto/Video e Persistenza
 */

const CFG = {
    rtc: { iceServers: [] }, // Connessione diretta in LAN/Tethering
    keys: {
        user: 'airchat_local_name',
        contacts: 'airchat_db_contacts'
    },
    maxHistory: 100,
    maxFileSize: 2 * 1024 * 1024 // Limite 2MB per stabilità DataChannel
};

// Stato Globale
let pc = null;
let dataChannel = null;
let localName = '';
let currentPeer = '';
let isHost = false;
let stream = null;

// --- 1. INIZIALIZZAZIONE ---

window.addEventListener('DOMContentLoaded', () => {
    // Registrazione Service Worker per funzionamento offline
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('service-worker.js').catch(console.error);
    }

    const savedName = localStorage.getItem(CFG.keys.user);
    if (savedName) {
        localName = savedName;
        document.getElementById('my-name-display').textContent = localName;
        showScreen('connect');
        renderDashboard();
    }

    initUIEvents();
});

function initUIEvents() {
    // Login
    document.getElementById('login-button').onclick = () => {
        const val = document.getElementById('username-input').value.trim();
        if (val) {
            localName = val;
            localStorage.setItem(CFG.keys.user, val);
            location.reload(); 
        }
    };

    // Handshake
    document.getElementById('start-hosting').onclick = startHost;
    document.getElementById('start-scanning').onclick = startScan;
    document.getElementById('stop-scanning').onclick = stopScan;
    document.getElementById('host-scan-step').onclick = () => {
        document.getElementById('qr-container').classList.add('hidden');
        startScan();
    };

    // Chat Actions
    document.getElementById('send-button').onclick = sendTextMsg;
    document.getElementById('message-input').onkeypress = (e) => { if(e.key === 'Enter') sendTextMsg(); };
    document.getElementById('attach-btn').onclick = () => document.getElementById('file-input').click();
    document.getElementById('file-input').onchange = handleFileUpload;
}

function showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById('screen-' + id).classList.add('active');
}

// --- 2. DASHBOARD & PERSISTENZA ---

function renderDashboard() {
    const list = document.getElementById('contacts-list');
    const contacts = JSON.parse(localStorage.getItem(CFG.keys.contacts) || '{}');
    list.innerHTML = '';

    const sortedKeys = Object.keys(contacts).sort((a, b) => {
        const lastA = contacts[a].history.slice(-1)[0]?.ts || '';
        const lastB = contacts[b].history.slice(-1)[0]?.ts || '';
        return lastB.localeCompare(lastA);
    });

    if (sortedKeys.length === 0) {
        list.innerHTML = '<p style="font-size:14px; color:#888; text-align:center;">Nessuna chat recente.</p>';
        return;
    }

    sortedKeys.forEach(name => {
        const history = contacts[name].history;
        const lastMsg = history[history.length - 1];
        const card = document.createElement('div');
        card.className = 'contact-card';
        card.innerHTML = `
            <div class="contact-info">
                <strong>${name}</strong>
                <small>${lastMsg ? (lastMsg.type === 'media' ? '📁 Allegato' : lastMsg.text) : 'Inizia a scrivere...'}</small>
            </div>
            <span>➔</span>
        `;
        card.onclick = () => {
            currentPeer = name;
            startHost(); // Chi clicca riattiva la connessione come Host
        };
        list.appendChild(card);
    });
}

// --- 3. WEBRTC ENGINE (OTTIMIZZATO PER IOS) ---

function createPC() {
    if (pc) pc.close();
    
    pc = new RTCPeerConnection(CFG.rtc);

    // Gestione Candidati ICE: Fondamentale per bypassare mDNS su iOS
    pc.onicecandidate = e => {
        if (!e.candidate) {
            // Gathering terminato: ora il QR conterrà tutti gli IP locali validi
            console.log("ICE Gathering completo.");
            genQR(JSON.stringify(pc.localDescription));
        }
    };

    const handleConnectionChange = () => {
        const connected = pc.iceConnectionState === 'connected' || pc.connectionState === 'connected';
        if (connected) {
            document.getElementById('connection-loading').classList.add('hidden');
            showScreen('chat');
            loadHistory(currentPeer);
        }
    };

    pc.onconnectionstatechange = handleConnectionChange;
    pc.oniceconnectionstatechange = handleConnectionChange;
}

function setupChannel(ch) {
    dataChannel = ch;
    ch.onopen = () => {
        document.getElementById('chat-status-dot').className = 'dot-online';
        ch.send(JSON.stringify({ type: 'sync_name', name: localName }));
    };
    ch.onmessage = e => {
        const msg = JSON.parse(e.data);
        if (msg.type === 'sync_name') {
            currentPeer = msg.name;
            document.getElementById('peer-name-display').textContent = currentPeer;
        } else if (msg.type === 'text' || msg.type === 'media') {
            receiveMsg(msg);
            // Invia conferma di ricezione (ACK) per la doppia spunta
            ch.send(JSON.stringify({ type: 'ack', id: msg.id }));
        } else if (msg.type === 'ack') {
            updateTicks(msg.id);
        }
    };
}

// --- 4. FLUSSO HANDSHAKE QR ---

async function startHost() {
    isHost = true;
    createPC();
    setupChannel(pc.createDataChannel("chat"));
    
    document.getElementById('main-actions').classList.add('hidden');
    document.getElementById('qr-container').classList.remove('hidden');
    document.getElementById('qr-instruction').textContent = "1. Fai scansionare all'amico";
    document.getElementById('host-controls').classList.remove('hidden');

    try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
    } catch (e) { alert("Errore WebRTC: " + e); }
}

async function handleQR(data) {
    try {
        const sdp = LZString.decompressFromEncodedURIComponent(data);
        const obj = JSON.parse(sdp);

        document.getElementById('qr-container').classList.add('hidden');
        document.getElementById('main-actions').classList.add('hidden');
        document.getElementById('connection-loading').classList.remove('hidden');

        if (obj.type === 'offer') {
            isHost = false;
            createPC();
            pc.ondatachannel = e => setupChannel(e.channel);
            await pc.setRemoteDescription(new RTCSessionDescription(obj));
            const ans = await pc.createAnswer();
            await pc.setLocalDescription(ans);
            
            // Il client deve mostrare la sua risposta
            document.getElementById('connection-loading').classList.add('hidden');
            document.getElementById('qr-container').classList.remove('hidden');
            document.getElementById('qr-instruction').textContent = "2. Fai scansionare all'host";
            document.getElementById('host-controls').classList.add('hidden');
        } else if (obj.type === 'answer') {
            await pc.setRemoteDescription(new RTCSessionDescription(obj));
        }
    } catch (e) { alert("QR non valido"); location.reload(); }
}

// --- 5. SCANNER ENGINE ---

async function startScan() {
    document.getElementById('scanner-container').classList.remove('hidden');
    const video = document.getElementById('scanner-video');
    try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
        video.srcObject = stream;
        video.play();
        requestAnimationFrame(tickScanner);
    } catch (e) { alert("Fotocamera non disponibile."); stopScan(); }
}

function stopScan() {
    document.getElementById('scanner-container').classList.add('hidden');
    if (stream) stream.getTracks().forEach(t => t.stop());
}

function tickScanner() {
    const video = document.getElementById('scanner-video');
    if (video.readyState === video.HAVE_ENOUGH_DATA) {
        const canvas = document.getElementById('scanner-canvas');
        canvas.height = video.videoHeight; canvas.width = video.videoWidth;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const code = jsQR(ctx.getImageData(0,0,canvas.width,canvas.height).data, canvas.width, canvas.height);
        if (code) { stopScan(); handleQR(code.data); return; }
    }
    if (stream) requestAnimationFrame(tickScanner);
}

function genQR(sdp) {
    const comp = LZString.compressToEncodedURIComponent(sdp);
    new QRious({ element: document.getElementById('qr-canvas'), value: comp, size: 250 });
}

// --- 6. CHAT, MEDIA & SPUNTE ---

function sendTextMsg() {
    const input = document.getElementById('message-input');
    const text = input.value.trim();
    if (!text || !dataChannel || dataChannel.readyState !== 'open') return;

    const msg = {
        id: Math.random().toString(36).substr(2, 9),
        type: 'text',
        name: localName,
        text: text,
        ts: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };

    dataChannel.send(JSON.stringify(msg));
    renderMsg(msg, 'sent');
    saveMsg(currentPeer, msg);
    input.value = '';
}

function handleFileUpload(e) {
    const file = e.target.files[0];
    if (!file || !dataChannel) return;
    if (file.size > CFG.maxFileSize) return alert("File troppo grande (Max 2MB)");

    const reader = new FileReader();
    reader.onload = (ev) => {
        const msg = {
            id: Math.random().toString(36).substr(2, 9),
            type: 'media',
            mediaType: file.type.split('/')[0], // 'image' o 'video'
            name: localName,
            data: ev.target.result,
            ts: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        };
        dataChannel.send(JSON.stringify(msg));
        renderMsg(msg, 'sent');
        saveMsg(currentPeer, msg);
    };
    reader.readAsDataURL(file);
}

function receiveMsg(msg) {
    renderMsg(msg, 'received');
    saveMsg(currentPeer, msg);
}

function renderMsg(m, type) {
    const chat = document.getElementById('chat-messages');
    const div = document.createElement('div');
    div.id = `msg-${m.id}`;
    div.className = `message ${type}`;

    let body = type === 'received' ? `<strong>${m.name}</strong><br>` : '';
    if (m.type === 'text') {
        body += m.text;
    } else if (m.mediaType === 'image') {
        body += `<img src="${m.data}" class="msg-media" onclick="window.open(this.src)">`;
    } else {
        body += `<video src="${m.data}" controls class="msg-media"></video>`;
    }

    const ticks = type === 'sent' ? `<span class="ticks">✓</span>` : '';
    div.innerHTML = `${body}<span class="msg-meta">${m.ts} ${ticks}</span>`;
    
    chat.appendChild(div);
    chat.scrollTop = chat.scrollHeight;
}

function updateTicks(id) {
    const el = document.getElementById(`msg-${id}`);
    if (el) {
        const ticks = el.querySelector('.ticks');
        if (ticks) {
            ticks.textContent = '✓✓';
            ticks.classList.add('ack');
        }
    }
}

function saveMsg(peer, m) {
    if (!peer) return;
    let db = JSON.parse(localStorage.getItem(CFG.keys.contacts) || '{}');
    if (!db[peer]) db[peer] = { history: [] };
    
    db[peer].history.push(m);
    // Pulizia automatica: mantieni solo gli ultimi 100 messaggi
    if (db[peer].history.length > CFG.maxHistory) {
        db[peer].history.shift();
    }
    
    localStorage.setItem(CFG.keys.contacts, JSON.stringify(db));
}

function loadHistory(peer) {
    const chat = document.getElementById('chat-messages');
    chat.innerHTML = '';
    const db = JSON.parse(localStorage.getItem(CFG.keys.contacts) || '{}');
    if (db[peer]) {
        db[peer].history.forEach(m => renderMsg(m, m.name === localName ? 'sent' : 'received'));
    }
}