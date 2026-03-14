// ─── MAP SETUP ───────────────────────────────────────────────────
const map = L.map('map').setView([30.9, 75.85], 13);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '© OpenStreetMap contributors', maxZoom: 19
}).addTo(map);

let heatLayer = null;
let markersLayer = L.layerGroup().addTo(map);
let locationMarker = null;

// ─── DATA STORE ──────────────────────────────────────────────────
let readings = [];
let audioCtx = null, analyser = null, stream = null;
let isRecording = false, recordInterval = null, gpsWatcher = null;
let currentLat = null, currentLng = null;

// ─── Try get location on page load (silently) ─────────────────────
navigator.geolocation.getCurrentPosition(pos => {
  currentLat = pos.coords.latitude;
  currentLng = pos.coords.longitude;
  map.setView([currentLat, currentLng], 15);
}, () => {}, { enableHighAccuracy: true });

// ─── COLOR & LABEL HELPERS ───────────────────────────────────────
function getColor(db) {
  if (db < 50) return '#22c55e';
  if (db < 60) return '#84cc16';
  if (db < 70) return '#eab308';
  if (db < 85) return '#f97316';
  return '#ef4444';
}

function getLabel(db) {
  if (db < 50) return '🟢 Quiet';
  if (db < 60) return '🟡 Moderate';
  if (db < 70) return '🟠 Loud';
  if (db < 85) return '🔴 Very Loud';
  return '🚨 Dangerous';
}

// ─── READING LOGIC ───────────────────────────────────────────────
function addReading(lat, lng, db, time) {
  readings.push({ lat, lng, db, time });
  updateMap();
  updateLog(lat, lng, db, time);
  updateStats();
}

function updateMap() {
  markersLayer.clearLayers();
  const heatData = [];
  readings.forEach(r => {
    const col = getColor(r.db);
    L.circleMarker([r.lat, r.lng], {
      radius: 10, fillColor: col, color: '#fff',
      weight: 1.5, opacity: 1, fillOpacity: 0.85
    }).bindPopup(`<b>${r.db} dB</b><br>${getLabel(r.db)}<br><small>${r.time}</small><br><small>${r.lat.toFixed(5)}, ${r.lng.toFixed(5)}</small>`)
      .addTo(markersLayer);
    heatData.push([r.lat, r.lng, r.db / 100]);
  });
  if (heatLayer) map.removeLayer(heatLayer);
  if (heatData.length > 0) {
    heatLayer = L.heatLayer(heatData, {
      radius: 35, blur: 25, maxZoom: 17,
      gradient: { 0.0: '#22c55e', 0.5: '#eab308', 0.7: '#f97316', 1.0: '#ef4444' }
    }).addTo(map);
  }
}

function updateLog(lat, lng, db, time) {
  const log = document.getElementById('log');
  const noMic = log.querySelector('.no-mic');
  if (noMic) noMic.remove();
  const entry = document.createElement('div');
  entry.className = 'log-entry';
  entry.style.borderColor = getColor(db);
  entry.innerHTML = `<span class="db-num" style="color:${getColor(db)}">${db} dB</span> ${getLabel(db)}<br>
    <span class="loc">📍 ${lat.toFixed(5)}, ${lng.toFixed(5)}</span><br>
    <span class="time">🕐 ${time}</span>`;
  log.insertBefore(entry, log.firstChild);
}

function updateStats() {
  const dbs = readings.map(r => r.db);
  document.getElementById('sCount').textContent = dbs.length;
  document.getElementById('sAvg').textContent = (dbs.reduce((a, b) => a + b, 0) / dbs.length).toFixed(1);
  document.getElementById('sMax').textContent = Math.max(...dbs);
}

// ─── MICROPHONE ──────────────────────────────────────────────────
function getMicDb() {
  const buf = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(buf);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  const rms = Math.sqrt(sum / buf.length);
  if (rms === 0) return 0;
  return Math.max(0, Math.min(120, Math.round(20 * Math.log10(rms) + 90)));
}

function updateMeter(db) {
  const col = getColor(db);
  document.getElementById('dbVal').textContent = db + ' ';
  document.getElementById('dbVal').style.color = col;
  document.getElementById('dbBar').style.width = Math.min(100, db) + '%';
  document.getElementById('dbBar').style.background = col;
  document.getElementById('levelLabel').textContent = getLabel(db);
  document.getElementById('levelLabel').style.color = col;
}

// ─── START RECORDING ─────────────────────────────────────────────
async function startRecording() {
  try {
    // Step 1 — get microphone
    stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 2048;
    audioCtx.createMediaStreamSource(stream).connect(analyser);

    // Step 2 — show waiting state
    document.getElementById('btnRecord').textContent = '⏳ Getting Location...';
    document.getElementById('btnRecord').disabled = true;
    document.getElementById('statusPill').textContent = '● WAITING FOR GPS';
    document.getElementById('statusPill').className = 'status-pill idle';

    // Step 3 — begin recording once location is confirmed
    const startWithLocation = (lat, lng) => {
      currentLat = lat;
      currentLng = lng;

      isRecording = true;
      document.getElementById('btnRecord').textContent = '⏹ Stop Recording';
      document.getElementById('btnRecord').classList.add('active');
      document.getElementById('btnRecord').disabled = false;
      document.getElementById('statusPill').textContent = '● RECORDING';
      document.getElementById('statusPill').className = 'status-pill recording';

      // Live meter update
      const meterLoop = setInterval(() => {
        if (!isRecording) { clearInterval(meterLoop); return; }
        updateMeter(getMicDb());
      }, 200);

      // Watch GPS continuously in background
      gpsWatcher = navigator.geolocation.watchPosition(pos => {
        currentLat = pos.coords.latitude;
        currentLng = pos.coords.longitude;
      }, null, { enableHighAccuracy: true });

      // Save reading every 1 second instantly
      recordInterval = setInterval(() => {
        if (!isRecording) return;
        const db = getMicDb();
        const time = new Date().toLocaleTimeString();
        addReading(currentLat, currentLng, db, time);
        map.setView([currentLat, currentLng], map.getZoom());
      }, 1000);
    };

    // If GPS already known — start immediately, no waiting
    if (currentLat !== null) {
      startWithLocation(currentLat, currentLng);
    } else {
      // Otherwise fetch GPS first then start
      navigator.geolocation.getCurrentPosition(pos => {
        startWithLocation(pos.coords.latitude, pos.coords.longitude);
      }, () => {
        alert('Could not get GPS location. Please allow location permission and try again.');
        document.getElementById('btnRecord').textContent = '▶ Start Recording';
        document.getElementById('btnRecord').disabled = false;
        document.getElementById('statusPill').textContent = '● IDLE';
        document.getElementById('statusPill').className = 'status-pill idle';
        stopMic();
      }, { enableHighAccuracy: true, timeout: 10000 });
    }

  } catch (err) {
    alert('Microphone access denied or unavailable.\n\nPlease allow microphone permission in your browser settings.');
  }
}

function stopMic() {
  if (stream) stream.getTracks().forEach(t => t.stop());
  if (audioCtx) audioCtx.close();
  stream = null; audioCtx = null; analyser = null;
}

// ─── STOP RECORDING ──────────────────────────────────────────────
function stopRecording() {
  isRecording = false;
  clearInterval(recordInterval);
  if (gpsWatcher !== null) { navigator.geolocation.clearWatch(gpsWatcher); gpsWatcher = null; }
  stopMic();
  document.getElementById('btnRecord').textContent = '▶ Start Recording';
  document.getElementById('btnRecord').classList.remove('active');
  document.getElementById('btnRecord').disabled = false;
  document.getElementById('statusPill').textContent = '● IDLE';
  document.getElementById('statusPill').className = 'status-pill idle';
  document.getElementById('dbVal').textContent = '-- ';
  document.getElementById('dbVal').style.color = '#22c55e';
  document.getElementById('dbBar').style.width = '0%';
  document.getElementById('levelLabel').textContent = 'Recording stopped';
}

document.getElementById('btnRecord').onclick = () => {
  if (isRecording) stopRecording();
  else startRecording();
};

// ─── LOCATE ME ───────────────────────────────────────────────────
document.getElementById('btnLocate').onclick = () => {
  const btn = document.getElementById('btnLocate');
  btn.textContent = '⏳ Locating...';
  btn.disabled = true;

  navigator.geolocation.getCurrentPosition(pos => {
    currentLat = pos.coords.latitude;
    currentLng = pos.coords.longitude;

    map.flyTo([currentLat, currentLng], 17, { animate: true, duration: 1.5 });

    if (locationMarker) map.removeLayer(locationMarker);
    locationMarker = L.circleMarker([currentLat, currentLng], {
      radius: 12, fillColor: '#38bdf8', color: '#fff',
      weight: 3, opacity: 1, fillOpacity: 0.9
    }).bindPopup(`<b>📍 You are here</b><br><small>${currentLat.toFixed(5)}, ${currentLng.toFixed(5)}</small>`)
      .addTo(map).openPopup();

    btn.textContent = '📍 My Location';
    btn.disabled = false;
  }, () => {
    alert('Could not get your location.\nPlease allow location permission in your browser.');
    btn.textContent = '📍 My Location';
    btn.disabled = false;
  }, { enableHighAccuracy: true, timeout: 8000 });
};

// ─── EXPORT CSV ───────────────────────────────────────────────────
document.getElementById('btnExport').onclick = () => {
  if (!readings.length) { alert('No data to export yet!'); return; }
  const header = 'latitude,longitude,decibels,timestamp\n';
  const rows = readings.map(r => `${r.lat},${r.lng},${r.db},"${r.time}"`).join('\n');
  const blob = new Blob([header + rows], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `noise_map_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
};

// ─── IMPORT CSV ───────────────────────────────────────────────────
document.getElementById('btnImport').onclick = () => document.getElementById('fileInput').click();

document.getElementById('fileInput').onchange = (e) => {
  const file = e.target.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    const lines = ev.target.result.trim().split('\n');
    let count = 0;
    lines.forEach((line, i) => {
      if (i === 0) return;
      const parts = line.split(',');
      if (parts.length < 3) return;
      const lat = parseFloat(parts[0]), lng = parseFloat(parts[1]), db = parseFloat(parts[2]);
      const time = parts[3] ? parts[3].replace(/"/g, '') : 'Imported';
      if (!isNaN(lat) && !isNaN(lng) && !isNaN(db)) { addReading(lat, lng, db, time); count++; }
    });
    if (count > 0) { map.fitBounds(markersLayer.getBounds()); alert(`✅ Imported ${count} readings.`); }
    else alert('No valid data found in CSV.');
  };
  reader.readAsText(file);
  e.target.value = '';
};

// ─── CLEAR ────────────────────────────────────────────────────────
document.getElementById('btnClear').onclick = () => {
  if (!readings.length || confirm('Clear all readings?')) {
    readings = [];
    markersLayer.clearLayers();
    if (heatLayer) { map.removeLayer(heatLayer); heatLayer = null; }
    document.getElementById('log').innerHTML = '<div class="no-mic">All readings cleared. Press <strong>Start Recording</strong> to begin again.</div>';
    document.getElementById('sAvg').textContent = '--';
    document.getElementById('sMax').textContent = '--';
    document.getElementById('sCount').textContent = '0';
  }
};