const cfg = { rtc: { iceServers: [] }, store: 'airchat_msg', user: 'airchat_name' };
let pc, dataChannel, localName = '', peerName = '', isHost = false, stream = null;

window.addEventListener('DOMContentLoaded', () => {
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('service-worker.js');
    const saved = localStorage.getItem(cfg.user);
    if (saved) { localName = saved; showScreen('connect'); initConnect(); }
    setupEvents();
});

function setupEvents() {
    document.getElementById('login-button').onclick = () => {
        const n = document.getElementById('username-input').value.trim();
        if(n) { localName = n; localStorage.setItem(cfg.user, n); showScreen('connect'); initConnect(); }
    };
    document.getElementById('start-hosting').onclick = startHost;
    document.getElementById('start-scanning').onclick = startScan;
    document.getElementById('stop-scanning').onclick = stopScan;
    document.getElementById('abort-connection').onclick = () => location.reload();
    document.getElementById('host-scan-step').onclick = () => {
        document.getElementById('qr-container').classList.add('hidden');
        startScan();
    };
    document.getElementById('send-button').onclick = sendMsg;
}

function showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById('screen-'+id).classList.add('active');
}

function initConnect() {
    document.getElementById('my-name-display').textContent = localName;
    loadHistory();
}

// WEBRTC CORE
function createPC() {
    if (pc) pc.close();
    pc = new RTCPeerConnection(cfg.rtc);
    
    pc.onicecandidate = e => {
        if (!e.candidate) genQR(JSON.stringify(pc.localDescription));
    };

    const checkState = () => {
        const isConnected = pc.connectionState === 'connected' || pc.iceConnectionState === 'connected';
        if (isConnected) {
            updateUIStatus(true);
            showScreen('chat');
        }
    };

    pc.onconnectionstatechange = checkState;
    pc.oniceconnectionstatechange = checkState;
}

function updateUIStatus(connected) {
    const s = document.getElementById('connection-status');
    s.textContent = connected ? 'CONNESSO' : 'Disconnesso';
    s.className = connected ? 'status-connected' : 'status-disconnected';
}

function setupChannel(ch) {
    dataChannel = ch;
    ch.onopen = () => {
        document.getElementById('chat-status-dot').className = 'status-dot-connected';
        showScreen('chat'); // Forza entrata in chat
        ch.send(JSON.stringify({type:'name', name: localName}));
    };
    ch.onmessage = e => {
        const d = JSON.parse(e.data);
        if(d.type === 'name') { peerName = d.name; document.getElementById('peer-name-display').textContent = peerName; }
        else if(d.type === 'text') { renderMsg(d, 'received'); saveMsg(d); }
    };
}

// HANDSHAKE FLOW
async function startHost() {
    isHost = true;
    createPC();
    setupChannel(pc.createDataChannel("chat"));
    document.getElementById('main-controls').classList.add('hidden');
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
    } catch (e) { alert("Errore camera"); stopScan(); }
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
    try {
        const sdp = LZString.decompressFromEncodedURIComponent(data);
        if(!sdp) throw new Error("SDP vuoto");
        const obj = JSON.parse(sdp);
        
        // Nascondi tutto e mostra loader
        document.getElementById('main-controls').classList.add('hidden');
        document.getElementById('qr-container').classList.add('hidden');
        document.getElementById('connection-loading').classList.remove('hidden');

        if(obj.type === 'offer') {
            createPC();
            pc.ondatachannel = e => setupChannel(e.channel);
            await pc.setRemoteDescription(new RTCSessionDescription(obj));
            const ans = await pc.createAnswer();
            await pc.setLocalDescription(ans);
            // Il client deve mostrare il QR di risposta
            document.getElementById('connection-loading').classList.add('hidden');
            document.getElementById('qr-container').classList.remove('hidden');
            document.getElementById('qr-instruction').textContent = "3. Fai scansionare la risposta all'host";
            document.getElementById('host-controls').classList.add('hidden');
        } else if(obj.type === 'answer') {
            await pc.setRemoteDescription(new RTCSessionDescription(obj));
            // L'host rimane sul loader finché onopen o onconnectionstatechange scatta
        }
    } catch (e) { 
        alert("QR fallito"); 
        location.reload();
    }
}

function genQR(sdp) {
    const comp = LZString.compressToEncodedURIComponent(sdp);
    new QRious({ element: document.getElementById('qr-canvas'), value: comp, size: 250 });
}

// CHAT LOGIC
function sendMsg() {
    const i = document.getElementById('message-input');
    if(!i.value.trim() || !dataChannel || dataChannel.readyState !== 'open') return;
    const m = { type:'text', name: localName, text: i.value, ts: new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}) };
    dataChannel.send(JSON.stringify(m));
    renderMsg(m, 'sent'); saveMsg(m); i.value = '';
}

function renderMsg(m, type) {
    const c = document.getElementById('chat-messages');
    const d = document.createElement('div');
    d.className = `message ${type}`;
    d.innerHTML = `${type==='received'?'<b>'+m.name+'</b><br>':''}${m.text}<span class="msg-meta">${m.ts}</span>`;
    c.appendChild(d); c.scrollTop = c.scrollHeight;
}

function saveMsg(m) {
    let h = JSON.parse(localStorage.getItem(cfg.store) || '[]');
    h.push(m); localStorage.setItem(cfg.store, JSON.stringify(h.slice(-100)));
}

function loadHistory() {
    let h = JSON.parse(localStorage.getItem(cfg.store) || '[]');
    h.forEach(m => renderMsg(m, m.name === localName ? 'sent' : 'received'));
}