/* --- CONFIGURAZIONE & STATO GLOBALE --- */
const config = {
    // Definire iceServers vuoto per forzare l'uso della LAN locale/Bluetooth Tethering
    // senza cercare server STUN esterni che fallirebbero offline.
    rtcConfig: { iceServers: [] }, 
    svKey: 'p2p_airchat_history',
    userKey: 'p2p_airchat_username'
};

let localName = '';
let peerName = '';
let pc = null; // RTCPeerConnection
let dataChannel = null;
let isHost = false; // Chi genera l'offerta è host
let scannerStream = null; // Stream video dello scanner

// Elementi UI
const screens = {
    login: document.getElementById('screen-login'),
    connect: document.getElementById('screen-connect'),
    chat: document.getElementById('screen-chat')
};

/* --- INIZIALIZZAZIONE & PWA --- */
window.addEventListener('DOMContentLoaded', () => {
    // Registrazione Service Worker per funzionamento Offline
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('service-worker.js')
            .then(() => console.log('Service Worker Registrato'))
            .catch(err => console.error('Errore SW:', err));
    }

    // Carica username salvato se esiste
    const savedName = localStorage.getItem(config.userKey);
    if (savedName) {
        localName = savedName;
        showScreen('connect');
        initConnectScreen();
    }

    setupEventListeners();
});

function setupEventListeners() {
    // Login
    document.getElementById('login-button').addEventListener('click', doLogin);
    
    // Connessione / Handshake
    document.getElementById('start-hosting').addEventListener('click', startHosting);
    document.getElementById('start-scanning').addEventListener('click', startScanning);
    document.getElementById('stop-scanning').addEventListener('click', stopScanningVideo);

    // Chat
    document.getElementById('send-button').addEventListener('click', sendMessage);
    document.getElementById('message-input').addEventListener('keypress', (e) => {
        if(e.key === 'Enter') sendMessage();
    });
}

/* --- LOGICA UI --- */
function showScreen(screenName) {
    Object.values(screens).forEach(s => s.classList.remove('active'));
    screens[screenName].classList.add('active');
}

function doLogin() {
    const input = document.getElementById('username-input').value.trim();
    if (input.length < 2) return alert('Nome troppo corto');
    localName = input;
    localStorage.setItem(config.userKey, localName);
    showScreen('connect');
    initConnectScreen();
}

function initConnectScreen() {
    document.getElementById('my-name-display').textContent = `Io: ${localName}`;
    loadChatHistory();
}

function updateConnectionStatus(connected) {
    const statusEl = document.getElementById('connection-status');
    const chatDot = document.getElementById('chat-status-dot');

    if (connected) {
        statusEl.textContent = 'CONNESSO';
        statusEl.className = 'status-connected';
        chatDot.className = 'status-dot-connected';
        // Passa automaticamente alla schermata chat dopo 1 secondo
        setTimeout(() => showScreen('chat'), 1000);
    } else {
        statusEl.textContent = 'Disconnesso';
        statusEl.className = 'status-disconnected';
        chatDot.className = 'status-dot-disconnected';
    }
}

/* --- LOGICA WEBRTC (CORE) --- */

// Crea l'oggetto PeerConnection e imposta i listener base
function createPeerConnection() {
    if (pc) pc.close();
    
    pc = new RTCPeerConnection(config.rtcConfig);

    // Gestione Candidati ICE (LAN)
    // Poiché siamo offline, dobbiamo attendere che TUTTI i candidati locali 
    // siano raccolti PRIMA di generare l'SDP finale da mettere nel QR.
    pc.onicecandidate = (event) => {
        if (!event.candidate) {
            console.log('Raccolta ICE completata. SDP pronto per il QR.');
            generateQRCode(JSON.stringify(pc.localDescription));
        }
    };

    pc.onconnectionstatechange = () => {
        console.log('RTC State:', pc.connectionState);
        if (pc.connectionState === 'connected') {
            updateConnectionStatus(true);
        } else if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
            updateConnectionStatus(false);
        }
    };
}

// SETUP DATA CHANNEL (Listener per messaggi)
function setupDataChannel(channel) {
    dataChannel = channel;
    
    dataChannel.onopen = () => {
        console.log('DataChannel Aperto!');
        updateConnectionStatus(true);
        // Invia il proprio nome all'altro peer appena connessi
        sendSystemMessage({ type: 'name_exchange', name: localName });
    };

    dataChannel.onmessage = handleDataMessage;
    dataChannel.onclose = () => updateConnectionStatus(false);
}

// Gestione messaggi tecnici e di testo grezzi
function handleDataMessage(event) {
    let msgObj;
    try {
        msgObj = JSON.parse(event.data);
    } catch (e) { return; }

    if (msgObj.type === 'name_exchange') {
        peerName = msgObj.name;
        document.getElementById('peer-name-display').textContent = peerName;
        document.getElementById('peer-name-display').textContent = peerName;
    } else if (msgObj.type === 'text') {
        renderMessage(msgObj, 'received');
        saveMessageToHistory(msgObj);
    }
}

/* --- FLUSSO HANDSHAKE (QR SIGNALING) --- */

// STEP 1 (HOST): Genera Offerta
async function startHosting() {
    isHost = true;
    createPeerConnection();
    
    // Crea il Data Channel (necessario per chi hosta)
    setupDataChannel(pc.createDataChannel("chat"));

    document.getElementById('start-scanning').classList.add('hidden');
    document.getElementById('qr-container').classList.remove('hidden');
    document.getElementById('qr-instruction').textContent = '1. Fai scansionare questo codice all\'amico';

    try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        // Nota: Il QR verrà generato dal listener onicecandidate quando pronti.
    } catch (err) { console.error(err); }
}

// STEP 2 (SLAVE): Riceve Offerta via QR, genera Risposta
async function handleScannedOffer(offerSdp) {
    isHost = false;
    createPeerConnection();

    // Aspetta il Data Channel creato dall'host
    pc.ondatachannel = (event) => {
        setupDataChannel(event.channel);
    };

    try {
        await pc.setRemoteDescription(new RTCSessionDescription(JSON.parse(offerSdp)));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        // Prepara UI per mostrare la Risposta
        document.getElementById('scanner-container').classList.add('hidden');
        document.getElementById('qr-container').classList.remove('hidden');
        document.getElementById('qr-instruction').textContent = '3. Ora fai scansionare la tua risposta all\'host';
        
        // Nota: Il QR Risposta generato da onicecandidate.
    } catch (err) { alert('Errore nell\'SDP scansionato'); console.error(err); }
}

// STEP 3 (HOST): Riceve Risposta via QR, finalizza
async function handleScannedAnswer(answerSdp) {
    try {
        await pc.setRemoteDescription(new RTCSessionDescription(JSON.parse(answerSdp)));
        console.log('Handshake completato lato Host.');
        hideQR();
    } catch (err) { alert('Errore nella Risposta scansionata'); console.error(err); }
}

/* --- LIBRERIE: GENERAZIONE & SCANSIONE QR (Offline) --- */

// Genera QR usando qrious.min.js e comprime con lz-string
function generateQRCode(sdpString) {
    // Compressione necessaria: SDP è troppo lungo per i QR standard
    const compressed = LZString.compressToEncodedURIComponent(sdpString);
    console.log(`SDP Originale: ${sdpString.length}, Compresso: ${compressed.length}`);

    if (compressed.length > 2000) {
        alert("Errore: I dati di connessione sono troppo grandi per il QR locale. Riprova.");
        location.reload();
        return;
    }

    const canvas = document.getElementById('qr-canvas');
    new QRious({
        element: canvas,
        value: compressed,
        size: 250,
        level: 'L' // Livello correzione basso per massimizzare i dati
    });
}

function hideQR() {
    document.getElementById('qr-container').classList.add('hidden');
    document.getElementById('start-scanning').classList.remove('hidden');
}

// SCANNER: Gestione Video e jsQR.js
function startScanning() {
    document.getElementById('scanner-container').classList.remove('hidden');
    const video = document.getElementById('scanner-video');

    // Richiesta accesso fotocamera (Necessita HTTPS o localhost)
    navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } })
        .then(function(stream) {
            scannerStream = stream;
            video.srcObject = stream;
            video.setAttribute("playsinline", true); // richiesto per iOS
            video.play();
            requestAnimationFrame(tickScanner);
        })
        .catch(err => {
            console.error(err);
            alert("Impossibile accedere alla fotocamera. Verifica permessi o HTTPS.");
            stopScanningVideo();
        });
}

function stopScanningVideo() {
    document.getElementById('scanner-container').classList.add('hidden');
    if (scannerStream) {
        scannerStream.getTracks().forEach(track => track.stop());
        scannerStream = null;
    }
}

// Loop di scansione frame per frame
function tickScanner() {
    const video = document.getElementById('scanner-video');
    const canvasEl = document.getElementById('scanner-canvas');
    const canvas = canvasEl.getContext('2d', { willReadFrequently: true });

    if (video.readyState === video.HAVE_ENOUGH_DATA) {
        canvasEl.height = video.videoHeight;
        canvasEl.width = video.videoWidth;
        canvas.drawImage(video, 0, 0, canvasEl.width, canvasEl.height);
        
        const imageData = canvas.getImageData(0, 0, canvasEl.width, canvasEl.height);
        
        // jsQR rileva il codice
        const code = jsQR(imageData.data, imageData.width, imageData.height, {
            inversionAttempts: "dontInvert",
        });

        if (code) {
            // QR Trovato!
            console.log("QR Rilevato");
            stopScanningVideo();
            handleDecodedData(code.data);
            return; // Esci dal loop
        }
    }
    
    if (scannerStream) {
        requestAnimationFrame(tickScanner);
    }
}

// Decomprime e smista i dati scansionati
function handleDecodedData(compressedData) {
    const sdp = LZString.decompressFromEncodedURIComponent(compressedData);
    if (!sdp) return alert("Dati QR corrotti");

    try {
        const parsed = JSON.parse(sdp);
        if (parsed.type === 'offer') {
            handleScannedOffer(sdp);
        } else if (parsed.type === 'answer') {
            handleScannedAnswer(sdp);
        }
    } catch(e) { alert("QR non valido per questa app"); }
}

/* --- LOGICA MESSAGISTICA & PERSISTENZA --- */

function sendMessage() {
    const input = document.getElementById('message-input');
    const text = input.value.trim();
    
    if (text === '' || !dataChannel || dataChannel.readyState !== 'open') return;

    const msgObj = {
        type: 'text',
        name: localName,
        text: text,
        ts: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };

    // Invia via WebRTC
    dataChannel.send(JSON.stringify(msgObj));
    
    // UI & Storia
    renderMessage(msgObj, 'sent');
    saveMessageToHistory(msgObj);
    input.value = '';
}

function sendSystemMessage(obj) {
    if (dataChannel && dataChannel.readyState === 'open') {
        dataChannel.send(JSON.stringify(obj));
    }
}

function renderMessage(msg, type) {
    const container = document.getElementById('chat-messages');
    const msgEl = document.createElement('div');
    msgEl.className = `message ${type}`;

    const nameSpan = type === 'received' ? `<span class="msg-name">${msg.name}</span>` : '';

    msgEl.innerHTML = `
        ${nameSpan}
        <p class="msg-text">${msg.text}</p>
        <span class="msg-meta">${msg.ts}</span>
    `;

    container.appendChild(msgEl);
    // Auto-scroll in fondo
    container.scrollTop = container.scrollHeight;
}

function saveMessageToHistory(msg) {
    let history = JSON.parse(localStorage.getItem(config.svKey) || '[]');
    history.push(msg);
    // Mantieni solo ultimi 100 messaggi per performance offline
    if (history.length > 100) history.shift(); 
    localStorage.setItem(config.svKey, JSON.stringify(history));
}

function loadChatHistory() {
    const container = document.getElementById('chat-messages');
    container.innerHTML = '';
    let history = JSON.parse(localStorage.getItem(config.svKey) || '[]');
    history.forEach(msg => {
        const type = msg.name === localName ? 'sent' : 'received';
        renderMessage(msg, type);
    });
}