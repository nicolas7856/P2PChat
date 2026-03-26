const cfg = { 
    rtc: { iceServers: [] }, 
    keys: { user: 'p2p_name', contacts: 'p2p_contacts' } 
};

let pc, dataChannel, localName = '', peerName = '', isHost = false, stream = null;

// INIZIALIZZAZIONE
window.addEventListener('DOMContentLoaded', () => {
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('service-worker.js');
    const saved = localStorage.getItem(cfg.keys.user);
    if (saved) {
        localName = saved;
        document.getElementById('my-name-display').textContent = localName;
        showScreen('connect');
        renderDashboard();
    }
    setupEvents();
});

function setupEvents() {
    document.getElementById('login-button').onclick = () => {
        const n = document.getElementById('username-input').value.trim();
        if(n) { localName = n; localStorage.setItem(cfg.keys.user, n); location.reload(); }
    };
    document.getElementById('start-hosting').onclick = startHost;
    document.getElementById('start-scanning').onclick = startScan;
    document.getElementById('stop-scanning').onclick = stopScan;
    document.getElementById('host-scan-step').onclick = () => {
        document.getElementById('qr-container').classList.add('hidden');
        startScan();
    };
    document.getElementById('attach-btn').onclick = () => document.getElementById('file-input').click();
    document.getElementById('file-input').onchange = handleFile;
    document.getElementById('send-button').onclick = sendMsg;
    document.getElementById('message-input').onkeypress = e => { if(e.key === 'Enter') sendMsg(); };
}

function showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById('screen-' + id).classList.add('active');
}

/**
 * DASHBOARD E RUBRICA
 */
function renderDashboard() {
    const list = document.getElementById('contacts-list');
    const contacts = JSON.parse(localStorage.getItem(cfg.keys.contacts) || '{}');
    list.innerHTML = '';
    Object.keys(contacts).forEach(name => {
        const last = contacts[name].history.slice(-1)[0];
        const card = document.createElement('div');
        card.className = 'contact-card';
        card.innerHTML = `
            <div class="contact-info">
                <strong>${name}</strong>
                <small>${last ? (last.type === 'text' ? last.text : '📁 Media') : 'Nessun messaggio'}</small>
            </div>
            <span>➔</span>
        `;
        card.onclick = () => { peerName = name; startHost(); };
        list.appendChild(card);
    });
}

/**
 * WEBRTC CORE
 */
function createPC() {
    if (pc) pc.close();
    pc = new RTCPeerConnection(cfg.rtc);
    pc.onicecandidate = e => { if (!e.candidate) genQR(JSON.stringify(pc.localDescription)); };
    pc.onconnectionstatechange = () => {
        if(pc.connectionState === 'connected') {
            document.getElementById('connection-loading').classList.add('hidden');
            showScreen('chat');
            loadHistory(peerName);
        }
    };
}

function setupChannel(ch) {
    dataChannel = ch;
    ch.onopen = () => ch.send(JSON.stringify({type:'name_sync', name: localName}));
    ch.onmessage = e => {
        const d = JSON.parse(e.data);
        if(d.type === 'name_sync') { 
            peerName = d.name; 
            document.getElementById('peer-name-display').textContent = peerName; 
        } else if(d.type === 'text' || d.type === 'media') {
            renderMsg(d, 'received');
            saveMsg(peerName, d);
            ch.send(JSON.stringify({type: 'ack', id: d.id})); // Invia doppia spunta
        } else if(d.type === 'ack') {
            markAsReceived(d.id);
        }
    };
}

// HANDSHAKE
async function startHost() {
    isHost = true;
    createPC();
    setupChannel(pc.createDataChannel("chat"));
    document.getElementById('main-actions').classList.add('hidden');
    document.getElementById('qr-container').classList.remove('hidden');
    document.getElementById('qr-instruction').textContent = "1. Fai scansionare all'amico";
    document.getElementById('host-controls').classList.remove('hidden');
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
}

async function startScan() {
    document.getElementById('scanner-container').classList.remove('hidden');
    const v = document.getElementById('scanner-video');
    try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
        v.srcObject = stream; v.play();
        requestAnimationFrame(tick);
    } catch (e) { alert("Camera Error"); stopScan(); }
}

function stopScan() {
    document.getElementById('scanner-container').classList.add('hidden');
    if(stream) stream.getTracks().forEach(t => t.stop());
}

function tick() {
    const v = document.getElementById('scanner-video');
    if (v.readyState === v.HAVE_ENOUGH_DATA) {
        const canvas = document.getElementById('scanner-canvas');
        canvas.height = v.videoHeight; canvas.width = v.videoWidth;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
        const code = jsQR(ctx.getImageData(0,0,canvas.width,canvas.height).data, canvas.width, canvas.height);
        if (code) { stopScan(); handleQR(code.data); return; }
    }
    if(stream) requestAnimationFrame(tick);
}

async function handleQR(data) {
    const sdp = LZString.decompressFromEncodedURIComponent(data);
    if(!sdp) return;
    const obj = JSON.parse(sdp);
    document.getElementById('main-actions').classList.add('hidden');
    document.getElementById('qr-container').classList.add('hidden');
    document.getElementById('connection-loading').classList.remove('hidden');

    if(obj.type === 'offer') {
        createPC();
        pc.ondatachannel = e => setupChannel(e.channel);
        await pc.setRemoteDescription(new RTCSessionDescription(obj));
        const ans = await pc.createAnswer();
        await pc.setLocalDescription(ans);
        document.getElementById('connection-loading').classList.add('hidden');
        document.getElementById('qr-container').classList.remove('hidden');
        document.getElementById('qr-instruction').textContent = "2. Fai scansionare la risposta all'host";
        document.getElementById('host-controls').classList.add('hidden');
    } else if(obj.type === 'answer') {
        await pc.setRemoteDescription(new RTCSessionDescription(obj));
    }
}

function genQR(sdp) {
    const comp = LZString.compressToEncodedURIComponent(sdp);
    new QRious({ element: document.getElementById('qr-canvas'), value: comp, size: 250 });
}

/**
 * MESSAGGI E MEDIA
 */
function sendMsg() {
    const i = document.getElementById('message-input');
    if(!i.value.trim() || !dataChannel) return;
    const m = {
        id: Math.random().toString(36).substr(2, 9),
        type: 'text', name: localName, text: i.value,
        ts: new Date().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})
    };
    dataChannel.send(JSON.stringify(m));
    renderMsg(m, 'sent'); saveMsg(peerName, m); i.value = '';
}

function handleFile(e) {
    const file = e.target.files[0];
    if(!file || !dataChannel) return;
    if(file.size > 2 * 1024 * 1024) return alert("File troppo grande (Max 2MB)");

    const reader = new FileReader();
    reader.onload = (ev) => {
        const m = {
            id: Math.random().toString(36).substr(2, 9),
            type: 'media', mediaType: file.type.split('/')[0],
            name: localName, data: ev.target.result,
            ts: new Date().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})
        };
        dataChannel.send(JSON.stringify(m));
        renderMsg(m, 'sent'); saveMsg(peerName, m);
    };
    reader.readAsDataURL(file);
}

function renderMsg(m, type) {
    const c = document.getElementById('chat-messages');
    const d = document.createElement('div');
    d.id = `msg-${m.id}`;
    d.className = `message ${type}`;
    let html = type === 'received' ? `<strong>${m.name}</strong><br>` : '';
    if(m.type === 'text') html += m.text;
    else if(m.mediaType === 'image') html += `<img src="${m.data}" class="msg-media">`;
    else html += `<video src="${m.data}" controls class="msg-media"></video>`;
    
    html += `<span class="msg-meta">${m.ts} <span class="ticks">${type === 'sent' ? '✓' : ''}</span></span>`;
    d.innerHTML = html;
    c.appendChild(d); c.scrollTop = c.scrollHeight;
}

function markAsReceived(id) {
    const el = document.getElementById(`msg-${id}`);
    if(el) { const t = el.querySelector('.ticks'); t.textContent = '✓✓'; t.classList.add('ack'); }
}

function saveMsg(peer, m) {
    let db = JSON.parse(localStorage.getItem(cfg.keys.contacts) || '{}');
    if(!db[peer]) db[peer] = { history: [] };
    db[peer].history.push(m);
    if(db[peer].history.length > 100) db[peer].history.shift(); // Pulizia 100 messaggi
    localStorage.setItem(cfg.keys.contacts, JSON.stringify(db));
}

function loadHistory(peer) {
    const c = document.getElementById('chat-messages'); c.innerHTML = '';
    const db = JSON.parse(localStorage.getItem(cfg.keys.contacts) || '{}');
    if(db[peer]) db[peer].history.forEach(m => renderMsg(m, m.name === localName ? 'sent' : 'received'));
}