const cfg = { rtc: { iceServers: [] }, store: 'chat_v1_msg', user: 'chat_v1_user' };
let pc, dataChannel, localName = '', peerName = '', isHost = false, stream = null;

// INIZIALIZZAZIONE
window.addEventListener('DOMContentLoaded', () => {
    // Registra Service Worker
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('service-worker.js').catch(console.error);
    }
    
    const saved = localStorage.getItem(cfg.user);
    if (saved) {
        localName = saved;
        showScreen('connect');
        document.getElementById('my-name-display').textContent = localName;
        loadHistory();
    }

    // Event Listeners
    document.getElementById('login-button').onclick = () => {
        const val = document.getElementById('username-input').value.trim();
        if (val) {
            localName = val;
            localStorage.setItem(cfg.user, val);
            showScreen('connect');
            document.getElementById('my-name-display').textContent = localName;
            loadHistory();
        }
    };

    document.getElementById('start-hosting').onclick = startHost;
    document.getElementById('start-scanning').onclick = startScan;
    document.getElementById('stop-scanning').onclick = stopScan;
    document.getElementById('host-scan-step').onclick = () => {
        document.getElementById('qr-container').classList.add('hidden');
        startScan();
    };
    document.getElementById('send-button').onclick = sendMsg;
});

function showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById('screen-' + id).classList.add('active');
}

// WEBRTC LOGIC
function createPC() {
    if (pc) pc.close();
    pc = new RTCPeerConnection(cfg.rtc);

    pc.onicecandidate = e => {
        if (!e.candidate) {
            genQR(JSON.stringify(pc.localDescription));
        }
    };

    const onStateChange = () => {
        const connected = pc.connectionState === 'connected' || pc.iceConnectionState === 'connected';
        document.getElementById('connection-status').textContent = connected ? 'CONNESSO' : 'Disconnesso';
        document.getElementById('connection-status').className = connected ? 'status-connected' : 'status-disconnected';
        if (connected) {
            document.getElementById('connection-loading').classList.add('hidden');
            document.getElementById('chat-status-dot').className = 'dot-online';
            setTimeout(() => showScreen('chat'), 500);
        }
    };

    pc.onconnectionstatechange = onStateChange;
    pc.oniceconnectionstatechange = onStateChange;
}

function setupChannel(ch) {
    dataChannel = ch;
    ch.onopen = () => {
        document.getElementById('chat-status-dot').className = 'dot-online';
        ch.send(JSON.stringify({type:'name', name: localName}));
    };
    ch.onmessage = e => {
        const data = JSON.parse(e.data);
        if (data.type === 'name') {
            peerName = data.name;
            document.getElementById('peer-name-display').textContent = peerName;
        } else if (data.type === 'text') {
            renderMsg(data, 'received');
            saveMsg(data);
        }
    };
}

// HANDSHAKE
async function startHost() {
    isHost = true;
    createPC();
    setupChannel(pc.createDataChannel("chat"));
    document.getElementById('main-controls').classList.add('hidden');
    document.getElementById('qr-container').classList.remove('hidden');
    document.getElementById('qr-instruction').textContent = "1. Fai scansionare questo QR all'amico";
    document.getElementById('host-next-controls').classList.remove('hidden');
    
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
}

async function startScan() {
    document.getElementById('scanner-container').classList.remove('hidden');
    const video = document.getElementById('scanner-video');
    try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
        video.srcObject = stream;
        video.play();
        requestAnimationFrame(tick);
    } catch (err) {
        alert("Errore accesso fotocamera");
        stopScan();
    }
}

function stopScan() {
    document.getElementById('scanner-container').classList.add('hidden');
    if (stream) stream.getTracks().forEach(t => t.stop());
}

function tick() {
    const video = document.getElementById('scanner-video');
    if (video.readyState === video.HAVE_ENOUGH_DATA) {
        const canvas = document.getElementById('scanner-canvas');
        canvas.height = video.videoHeight; canvas.width = video.videoWidth;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const code = jsQR(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height);
        if (code) {
            stopScan();
            handleQR(code.data);
            return;
        }
    }
    if (document.getElementById('scanner-container').classList.contains('active') || stream) {
        requestAnimationFrame(tick);
    }
}

async function handleQR(data) {
    try {
        const sdp = LZString.decompressFromEncodedURIComponent(data);
        if (!sdp) return;
        const obj = JSON.parse(sdp);

        // Mostra loader per evitare schermo bianco
        document.getElementById('qr-container').classList.add('hidden');
        document.getElementById('main-controls').classList.add('hidden');
        document.getElementById('connection-loading').classList.remove('hidden');

        if (obj.type === 'offer') {
            createPC();
            pc.ondatachannel = e => setupChannel(e.channel);
            await pc.setRemoteDescription(new RTCSessionDescription(obj));
            const ans = await pc.createAnswer();
            await pc.setLocalDescription(ans);
            // Client mostra il QR di risposta
            document.getElementById('connection-loading').classList.add('hidden');
            document.getElementById('qr-container').classList.remove('hidden');
            document.getElementById('qr-instruction').textContent = "2. Ora fai scansionare la tua risposta all'host";
            document.getElementById('host-next-controls').classList.add('hidden');
        } else if (obj.type === 'answer') {
            await pc.setRemoteDescription(new RTCSessionDescription(obj));
            // Host rimane in attesa sul loader
        }
    } catch (e) {
        alert("QR non valido");
        location.reload();
    }
}

function genQR(sdp) {
    const comp = LZString.compressToEncodedURIComponent(sdp);
    new QRious({ element: document.getElementById('qr-canvas'), value: comp, size: 250 });
}

// MESSAGGI
function sendMsg() {
    const input = document.getElementById('message-input');
    const text = input.value.trim();
    if (!text || !dataChannel || dataChannel.readyState !== 'open') return;

    const msg = {
        type: 'text',
        name: localName,
        text: text,
        ts: new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})
    };
    dataChannel.send(JSON.stringify(msg));
    renderMsg(msg, 'sent');
    saveMsg(msg);
    input.value = '';
}

function renderMsg(m, type) {
    const chat = document.getElementById('chat-messages');
    const div = document.createElement('div');
    div.className = `message ${type}`;
    div.innerHTML = `${type === 'received' ? '<b>' + m.name + '</b><br>' : ''}${m.text}<span class="msg-meta">${m.ts}</span>`;
    chat.appendChild(div);
    chat.scrollTop = chat.scrollHeight;
}

function saveMsg(m) {
    let h = JSON.parse(localStorage.getItem(cfg.store) || '[]');
    h.push(m);
    localStorage.setItem(cfg.store, JSON.stringify(h.slice(-100)));
}

function loadHistory() {
    const chat = document.getElementById('chat-messages');
    chat.innerHTML = '';
    let h = JSON.parse(localStorage.getItem(cfg.store) || '[]');
    h.forEach(m => renderMsg(m, m.name === localName ? 'sent' : 'received'));
}