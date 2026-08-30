/* ==========================================================================
   Voice and video calls

   WebRTC mesh: every participant holds a direct connection to every other one,
   with Firebase Realtime Database carrying the signalling. No media server, so
   nothing to pay for and nothing to run — but the number of connections grows
   with the square of the group, which is why CALL_MAX_PARTICIPANTS is small.

   Starting a call posts a card into the channel. Anyone can click Join on it,
   Discord style, or ignore it.

   Requires the `calls` rules from database.rules.json to be published, and
   HTTPS (GitHub Pages and Vercel both qualify; plain http://localhost is also
   allowed by browsers for testing).
   ========================================================================== */

/* Add a TURN server here if students on restrictive networks cannot connect.
   STUN alone cannot traverse symmetric NATs or strict firewalls. */
const CALL_ICE_SERVERS = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }
];

/* Mesh connections grow as n*(n-1)/2 — 6 people is already 15 connections. */
const CALL_MAX_PARTICIPANTS = 6;

const callState = {
    inCall: false,
    channel: null,
    type: null,          // 'voice' | 'video'
    peerId: null,
    localStream: null,
    peers: {},           // remotePeerId -> { pc, pendingCandidates: [] }
    micOn: true,
    cameraOn: true,
    listeners: []
};

/* ---------- database paths ---------- */

function callRoot(channel) {
    return database.ref('calls/' + channel.replace(/^#/, ''));
}

function currentCallRoot() {
    return callRoot(callState.channel || currentChannel);
}

/* ---------- starting, joining, leaving ---------- */

async function startCall(type) {
    if (!currentUser || !currentChannel) return;
    if (callState.inCall) {
        alert('You are already in a call.');
        return;
    }

    const root = callRoot(currentChannel);
    const existing = await root.child('active').once('value');

    // Someone already started one in this channel — join that instead
    if (existing.val()) {
        joinCall();
        return;
    }

    await root.update({
        active: true,
        type: type,
        startedBy: callDisplayName(),
        startedAt: Date.now()
    });

    // The card everyone sees in the message list
    database.ref('channels/' + currentChannel.substring(1) + '/messages').push({
        author: currentUser.email,
        nickname: callDisplayName(),
        text: '',
        callType: type,
        timestamp: Date.now(),
        isAdmin: currentUser.isAdmin,
        isMod: currentUser.isMod,
        senderId: currentUser.uid
    });

    joinCall(type);
}

async function joinCall(type) {
    if (!currentUser || !currentChannel) return;
    if (callState.inCall) return;

    const root = callRoot(currentChannel);
    const snapshot = await root.once('value');
    const call = snapshot.val();

    if (!call || !call.active) {
        alert('That call has ended.');
        return;
    }

    const participants = call.participants || {};
    if (Object.keys(participants).length >= CALL_MAX_PARTICIPANTS) {
        alert(`This call is full (${CALL_MAX_PARTICIPANTS} people maximum).`);
        return;
    }

    const callType = type || call.type || 'video';

    let stream;
    try {
        stream = await navigator.mediaDevices.getUserMedia({
            audio: true,
            video: callType === 'video' ? { width: { ideal: 640 }, height: { ideal: 480 } } : false
        });
    } catch (error) {
        console.error('getUserMedia failed:', error);
        alert(describeMediaError(error));
        return;
    }

    callState.inCall = true;
    callState.channel = currentChannel;
    callState.type = callType;
    callState.localStream = stream;
    callState.micOn = true;
    callState.cameraOn = callType === 'video';
    callState.peerId = root.child('participants').push().key;

    const me = root.child('participants/' + callState.peerId);
    me.set({
        nickname: callDisplayName(),
        joinedAt: Date.now(),
        micOn: true,
        cameraOn: callState.cameraOn
    });
    me.onDisconnect().remove();                       // survives a closed tab
    root.child('signals/' + callState.peerId).onDisconnect().remove();

    openCallPanel();
    addTile(callState.peerId, callDisplayName() + ' (you)', stream, true);

    listenForSignals();
    listenForParticipants();

    // The newcomer offers to everyone already here; they only answer. That one
    // rule is what keeps two peers from offering each other at the same time.
    Object.keys(participants).forEach((remoteId) => {
        if (remoteId !== callState.peerId) {
            connectToPeer(remoteId, true);
        }
    });
}

async function leaveCall() {
    if (!callState.inCall) return;

    const root = currentCallRoot();

    Object.keys(callState.peers).forEach(closePeer);

    if (callState.localStream) {
        callState.localStream.getTracks().forEach((track) => track.stop());
    }

    callState.listeners.forEach(({ ref, event, handler }) => ref.off(event, handler));
    callState.listeners = [];

    await root.child('participants/' + callState.peerId).remove();
    await root.child('signals/' + callState.peerId).remove();

    // Last one out closes the call
    const remaining = await root.child('participants').once('value');
    if (!remaining.exists()) {
        await root.remove();
    }

    callState.inCall = false;
    callState.channel = null;
    callState.type = null;
    callState.peerId = null;
    callState.localStream = null;
    callState.peers = {};

    closeCallPanel();
}

/* ---------- signalling ---------- */

function listenForSignals() {
    const ref = currentCallRoot().child('signals/' + callState.peerId);
    const handler = ref.on('child_added', async (snapshot) => {
        const signal = snapshot.val();
        snapshot.ref.remove();                        // consume it
        if (!signal || !signal.from) return;

        try {
            await handleSignal(signal);
        } catch (error) {
            console.error('Signal handling failed:', signal.type, error);
        }
    });
    callState.listeners.push({ ref, event: 'child_added', handler });
}

async function handleSignal(signal) {
    const { from, type, payload } = signal;

    if (type === 'offer') {
        const peer = connectToPeer(from, false);
        await peer.pc.setRemoteDescription(new RTCSessionDescription(payload));
        await flushPendingCandidates(peer);
        const answer = await peer.pc.createAnswer();
        await peer.pc.setLocalDescription(answer);
        sendSignal(from, 'answer', { type: answer.type, sdp: answer.sdp });
        return;
    }

    const peer = callState.peers[from];
    if (!peer) return;

    if (type === 'answer') {
        await peer.pc.setRemoteDescription(new RTCSessionDescription(payload));
        await flushPendingCandidates(peer);
        return;
    }

    if (type === 'candidate') {
        // Candidates can arrive before the description they belong to
        if (peer.pc.remoteDescription && peer.pc.remoteDescription.type) {
            await peer.pc.addIceCandidate(new RTCIceCandidate(payload));
        } else {
            peer.pendingCandidates.push(payload);
        }
    }
}

async function flushPendingCandidates(peer) {
    while (peer.pendingCandidates.length) {
        const candidate = peer.pendingCandidates.shift();
        try {
            await peer.pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (error) {
            console.error('Could not add ICE candidate:', error);
        }
    }
}

function sendSignal(to, type, payload) {
    currentCallRoot().child('signals/' + to).push({
        from: callState.peerId,
        type: type,
        payload: payload
    });
}

function connectToPeer(remoteId, isInitiator) {
    if (callState.peers[remoteId]) return callState.peers[remoteId];

    const pc = new RTCPeerConnection({ iceServers: CALL_ICE_SERVERS });
    const peer = { pc: pc, pendingCandidates: [] };
    callState.peers[remoteId] = peer;

    callState.localStream.getTracks().forEach((track) => {
        pc.addTrack(track, callState.localStream);
    });

    pc.onicecandidate = (event) => {
        if (event.candidate) {
            sendSignal(remoteId, 'candidate', event.candidate.toJSON());
        }
    };

    pc.ontrack = (event) => {
        addTile(remoteId, participantName(remoteId), event.streams[0], false);
    };

    pc.onconnectionstatechange = () => {
        if (['failed', 'closed'].includes(pc.connectionState)) {
            closePeer(remoteId);
        }
    };

    if (isInitiator) {
        (async () => {
            try {
                const offer = await pc.createOffer();
                await pc.setLocalDescription(offer);
                sendSignal(remoteId, 'offer', { type: offer.type, sdp: offer.sdp });
            } catch (error) {
                console.error('Could not create offer:', error);
            }
        })();
    }

    return peer;
}

function closePeer(remoteId) {
    const peer = callState.peers[remoteId];
    if (!peer) return;
    try { peer.pc.close(); } catch (error) { /* already closed */ }
    delete callState.peers[remoteId];
    removeTile(remoteId);
}

/* ---------- participants ---------- */

const participantNames = {};

function listenForParticipants() {
    const ref = currentCallRoot().child('participants');

    const added = ref.on('child_added', (snapshot) => {
        participantNames[snapshot.key] = (snapshot.val() || {}).nickname || 'Someone';
        updateCallCount();
    });

    const removed = ref.on('child_removed', (snapshot) => {
        closePeer(snapshot.key);
        delete participantNames[snapshot.key];
        updateCallCount();
    });

    callState.listeners.push({ ref, event: 'child_added', handler: added });
    callState.listeners.push({ ref, event: 'child_removed', handler: removed });
}

function participantName(peerId) {
    return participantNames[peerId] || 'Someone';
}

function callDisplayName() {
    if (currentUser.isAdmin) return 'Admin';
    if (currentUser.isMod) return 'MOD';
    return currentUser.nickname;
}

/* ---------- camera and mic switches ---------- */

function toggleMic() {
    if (!callState.localStream) return;
    callState.micOn = !callState.micOn;
    callState.localStream.getAudioTracks().forEach((track) => {
        track.enabled = callState.micOn;
    });
    currentCallRoot().child('participants/' + callState.peerId).update({ micOn: callState.micOn });
    updateCallControls();
}

function toggleCamera() {
    if (!callState.localStream) return;

    const videoTracks = callState.localStream.getVideoTracks();
    if (!videoTracks.length) {
        alert('This is a voice call — start a video call to use the camera.');
        return;
    }

    callState.cameraOn = !callState.cameraOn;
    videoTracks.forEach((track) => {
        track.enabled = callState.cameraOn;
    });
    currentCallRoot().child('participants/' + callState.peerId).update({ cameraOn: callState.cameraOn });
    updateCallControls();
}

/* ---------- panel UI ---------- */

function openCallPanel() {
    const panel = document.getElementById('callPanel');
    if (!panel) return;
    panel.classList.add('show');
    document.getElementById('callPanelTitle').textContent =
        (callState.type === 'video' ? 'Video call' : 'Voice call');
    updateCallControls();
    updateCallCount();
}

function closeCallPanel() {
    const panel = document.getElementById('callPanel');
    if (!panel) return;
    panel.classList.remove('show');
    document.getElementById('callTiles').innerHTML = '';
}

function addTile(peerId, name, stream, isLocal) {
    const tiles = document.getElementById('callTiles');
    if (!tiles) return;

    let tile = document.getElementById('tile-' + peerId);
    if (!tile) {
        tile = document.createElement('div');
        tile.className = 'call-tile';
        tile.id = 'tile-' + peerId;
        tile.innerHTML = `
            <video autoplay playsinline${isLocal ? ' muted' : ''}></video>
            <div class="call-tile-avatar">${(name || '?').charAt(0).toUpperCase()}</div>
            <div class="call-tile-name"></div>`;
        tiles.appendChild(tile);
    }

    tile.querySelector('.call-tile-name').textContent = name;

    const video = tile.querySelector('video');
    if (video.srcObject !== stream) {
        video.srcObject = stream;
    }

    // Audio-only participants show an initial instead of a black rectangle
    tile.classList.toggle('audio-only', !stream.getVideoTracks().length);
}

function removeTile(peerId) {
    const tile = document.getElementById('tile-' + peerId);
    if (tile) tile.remove();
}

function updateCallControls() {
    const micBtn = document.getElementById('callMicBtn');
    const camBtn = document.getElementById('callCamBtn');
    if (!micBtn || !camBtn) return;

    micBtn.classList.toggle('off', !callState.micOn);
    micBtn.textContent = callState.micOn ? '🎤' : '🔇';
    micBtn.title = callState.micOn ? 'Mute microphone' : 'Unmute microphone';

    const hasVideo = callState.type === 'video';
    camBtn.disabled = !hasVideo;
    camBtn.classList.toggle('off', !callState.cameraOn);
    camBtn.textContent = callState.cameraOn && hasVideo ? '📹' : '🚫';
    camBtn.title = hasVideo
        ? (callState.cameraOn ? 'Turn camera off' : 'Turn camera on')
        : 'Voice call — no camera';
}

function updateCallCount() {
    const label = document.getElementById('callCount');
    if (!label) return;
    const count = Object.keys(participantNames).length;
    label.textContent = count === 1 ? '1 person' : count + ' people';
}

/* ---------- the joinable card in the message list ---------- */

let activeCallWatcher = null;
let lastCallState = { active: false, count: 0 };

function watchChannelCall(channel) {
    if (activeCallWatcher) {
        activeCallWatcher.ref.off('value', activeCallWatcher.handler);
        activeCallWatcher = null;
    }
    lastCallState = { active: false, count: 0 };
    if (!channel) return;

    const ref = callRoot(channel);
    const handler = ref.on('value', (snapshot) => {
        const call = snapshot.val();
        lastCallState = {
            active: !!(call && call.active),
            count: call && call.participants ? Object.keys(call.participants).length : 0
        };
        repaintCallCards();
    });
    activeCallWatcher = { ref, handler };
}

/* renderMessages() rebuilds the list, so freshly painted cards need the state
   we already know rather than waiting for the next database event. */
function repaintCallCards() {
    document.querySelectorAll('.call-card').forEach((card) => {
        paintCallCard(card, lastCallState.active, lastCallState.count);
    });
}

function paintCallCard(card, isActive, count) {
    const status = card.querySelector('.call-card-status');
    const button = card.querySelector('.call-join-btn');
    if (!status || !button) return;

    if (!isActive) {
        status.textContent = 'Call ended';
        button.style.display = 'none';
        card.classList.add('ended');
        return;
    }

    card.classList.remove('ended');
    status.textContent = count === 1 ? '1 person in the call' : count + ' people in the call';
    button.style.display = '';
    button.textContent = callState.inCall ? 'In call' : 'Join';
    button.disabled = callState.inCall;
}

function describeMediaError(error) {
    switch (error && error.name) {
        case 'NotAllowedError':
            return 'Camera and microphone access was blocked. Allow it in your browser\'s address bar, then try again.';
        case 'NotFoundError':
            return 'No camera or microphone was found on this device.';
        case 'NotReadableError':
            return 'Your camera or microphone is already in use by another app.';
        case 'SecurityError':
            return 'Calls need a secure (https) connection.';
        default:
            return 'Could not start your camera or microphone: ' + ((error && error.message) || 'unknown error');
    }
}

window.addEventListener('beforeunload', () => {
    if (callState.inCall) leaveCall();
});
