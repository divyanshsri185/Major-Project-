'use strict';
const statusEl = document.getElementById('status');
const button = document.getElementById('connect');
const video = document.getElementById('camera');
const token = new URLSearchParams(location.search).get('token');
let stream = null;
let socket = null;
let peer = null;
let pendingIce = [];

function status(text) { statusEl.textContent = text; }
function send(type, data) {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({type, data: data ?? null}));
}
function cleanup() {
  if (socket) { try { socket.close(); } catch {} socket = null; }
  if (peer) { try { peer.close(); } catch {} peer = null; }
  if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
  video.srcObject = null;
}
async function connect() {
  if (!token) { status('This pairing link is missing its token. Scan a new QR code from Invigil.'); return; }
  button.disabled = true;
  try {
    status('Requesting camera permission…');
    stream = await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'},width:{ideal:1280},height:{ideal:720}},audio:false});
    video.srcObject = stream;
    video.style.display = 'block';
    await video.play().catch(()=>{});
    status('Camera ready. Connecting securely to Invigil…');
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    socket = new WebSocket(`${protocol}//${location.host}/?role=phone&token=${encodeURIComponent(token)}`);
    socket.onopen = () => { status('Connected. Waiting for laptop…'); send('ready'); };
    socket.onerror = () => status('Could not connect. Check the Invigil page and scan a fresh QR code.');
    socket.onclose = () => { status('Connection closed. Return to the laptop and create a new pairing QR code.'); button.disabled = false; };
    socket.onmessage = async event => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      try {
        if (message.type === 'offer') {
          if (peer) peer.close();
          peer = new RTCPeerConnection({iceServers:[{urls:'stun:stun.l.google.com:19302'}]});
          stream.getTracks().forEach(track => peer.addTrack(track, stream));
          peer.onicecandidate = e => { if (e.candidate) send('ice', e.candidate); };
          peer.onconnectionstatechange = () => {
            if (peer && peer.connectionState === 'connected') status('Phone camera is streaming to the laptop.');
            if (peer && ['failed','disconnected'].includes(peer.connectionState)) status('Video connection interrupted. Keep this page open and retry pairing if needed.');
          };
          await peer.setRemoteDescription(message.data);
          for (const candidate of pendingIce) await peer.addIceCandidate(candidate);
          pendingIce = [];
          const answer = await peer.createAnswer();
          await peer.setLocalDescription(answer);
          send('answer', peer.localDescription);
        } else if (message.type === 'ice' && peer) {
          if (peer.remoteDescription) await peer.addIceCandidate(message.data);
          else pendingIce.push(message.data);
        }
      } catch (e) { status('WebRTC setup failed: ' + (e.message || 'connection error')); }
    };
  } catch (e) {
    status('Could not open camera: ' + (e.message || e.name || 'permission denied') + '. Use HTTPS and allow camera access.');
    button.disabled = false;
  }
}
button.addEventListener('click', connect);
window.addEventListener('pagehide', cleanup);
