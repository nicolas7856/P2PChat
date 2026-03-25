const cfg = { rtc: { iceServers: [] }, store: 'airchat_msg', user: 'airchat_name' };
let pc, dataChannel, localName = '', peerName = '', isHost = false, stream = null;

// INIT
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
    if (pc) {
        pc.close();
        pc = null;
    }
    
    pc = new RTCPeerConnection(cfg.rtc);
    
    pc.onicecandidate = e => {
        if (!e.candidate) {
            console.log("ICE Gathering completo");
            genQR(JSON.stringify(pc.localDescription));
        }
    };

    // Monitoriamo sia connectionState che iceConnectionState per massima compatibilità
    const checkState = () => {
        const connected = pc.connectionState === 'connected' || pc.iceConnectionState === 'connected';
        if (connected) {
            document.getElementById('connection-status').textContent = 'CONNESSO';
            document.getElementById('connection-status').className = 'status-connected';
            document.getElementById('connection-loading').classList.add('hidden');
            setTimeout(() => showScreen('chat'), 500);
        }
    };

    pc.onconnectionstatechange = checkState;
    pc.oniceconnectionstatechange = checkState;
}

function setupChannel(ch) {
    dataChannel = ch;
    ch.onopen = () => {
        document.getElementById('chat-status-dot').className = 'status-dot-connected';
        ch.send(JSON.stringify({type:'name', name: localName}));
    };
    ch.onmessage = e => {
        const d = JSON.parse(e.data);
        if(d.type === 'name') { 
            peerName = d.name; 
            document.getElementById('peer-name-display').textContent = peerName; 
        }
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
    
    try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
    } catch(e) { alert("Errore creazione offerta"); }
}

async function startScan() {
    document.getElementById('scanner-container').classList.remove('hidden');
    const v = document.getElementById('scanner-video');
    try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
        v.srcObject = stream;
        v.play();
        requestAnimationFrame(tick);
    } catch (e) { alert("Errore camera. Assicurati di essere in HTTPS."); stopScan(); }
}

function stopScan() {
    document.getElementById('scanner-container').classList.add('hidden');
    if(stream) {
        stream.getTracks().forEach(t => t.stop());
        stream = null;
    }
}

function tick() {
    const v = document.getElementById('scanner-video');
    if (v && v.readyState === v.HAVE_ENOUGH_DATA) {
        const canvas = document.getElementById('scanner-canvas');
        canvas.height = v.videoHeight; canvas.width = v.videoWidth;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
        const code = jsQR(ctx.getImageData(0,0,canvas.width,canvas.height).data, canvas.width, canvas.height);
        if (code) { 
            stopScan(); 
            handleQR(code.data); 
            return; 
        }
    }
    if(stream) requestAnimationFrame(tick);
}

async function handleQR(data) {
    try {
        const sdp = LZString.decompressFromEncodedURIComponent(data);
        if(!sdp) throw new Error("Decompressione fallita");
        
        const obj = JSON.parse(sdp);
        
        // Se abbiamo scansionato, mostriamo il caricamento per evitare lo schermo bianco
        document.getElementById('main-controls').classList.add('hidden');
        document.getElementById('connection-loading').classList.remove('hidden');

        if(obj.type === 'offer') {
            createPC();
            pc.ondatachannel = e => setupChannel(e.channel);
            await pc.setRemoteDescription(new RTCSessionDescription(obj));
            const ans = await pc.createAnswer();
            await pc.setLocalDescription(ans);
            
            // Per il client, dopo aver generato la risposta, dobbiamo mostrare il QR
            document.getElementById('connection-loading').classList.add('hidden');
            document.getElementById('qr-container').classList.remove('hidden');
            document.getElementById('qr-instruction').textContent = "3. Fai scansionare la risposta all'host";
            document.getElementById('host-controls').classList.add('hidden'); // Il client non ha controlli host
        } else if(obj.type === 'answer') {
            await pc.setRemoteDescription(new RTCSessionDescription(obj));
            // L'host rimane in attesa (mostrando il loader) finché onconnectionstatechange non scatta
        }
    } catch (e) { 
        alert("QR non valido o errore di connessione"); 
        console.error(e);
        document.getElementById('main-controls').classList.remove('hidden');
        document.getElementById('connection-loading').classList.add('hidden');
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