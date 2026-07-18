// ============================================================
//  State
// ============================================================
let logData = [];
let wifiData = [];
let maps = { log: null, wifi: null };
let markers = { logRoute: null, logLayerGroup: null, wifiLayerGroup: null };
let charts = { temp: null, hum: null, speed: null, jerk: null, wifiChannels: null, wifiSecurity: null };

// IMU analysis state
let imuEvents = [];
let thresholds = { leve: 0, forte: 0, gyro: 0 };

// Canvas renderer for log markers
let canvasRenderer = null;
let logMarkers = []; // references for coloring

// ============================================================
//  DOM References
// ============================================================
const tabBtns        = document.querySelectorAll('.tab-btn');
const tabContents    = document.querySelectorAll('.tab-content');
const btnLoadLocal   = document.getElementById('btn-load-local');
const inputLogFile   = document.getElementById('input-log-file');
const inputWifiFile  = document.getElementById('input-wifi-file');
const statusDot      = document.getElementById('status-dot');
const statusText     = document.getElementById('status-text');
const progressWrap   = document.getElementById('loading-progress-wrap');
const progressBar    = document.getElementById('loading-progress-bar');
const progressLabel  = document.getElementById('loading-progress-label');
const btnImuToggle   = document.getElementById('btn-imu-toggle');
const imuPanel       = document.getElementById('imu-panel');

// ============================================================
//  Tab navigation
// ============================================================
tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        tabBtns.forEach(b => b.classList.remove('active'));
        tabContents.forEach(c => c.classList.remove('active'));
        btn.classList.add('active');
        const targetTab = btn.getAttribute('data-tab');
        document.getElementById(targetTab).classList.add('active');
        setTimeout(() => {
            if (targetTab === 'tab-log'  && maps.log)  maps.log.invalidateSize();
            if (targetTab === 'tab-wifi' && maps.wifi) maps.wifi.invalidateSize();
        }, 100);
    });
});

// ============================================================
//  IMU Panel toggle
// ============================================================
btnImuToggle.addEventListener('click', () => {
    const expanded = imuPanel.classList.toggle('collapsed') === false;
    btnImuToggle.textContent = expanded ? 'Recolher ▴' : 'Expandir ▾';
    btnImuToggle.setAttribute('aria-expanded', expanded);
});

// ============================================================
//  Status helpers
// ============================================================
function setLoadingStatus(text) { statusDot.className = 'dot loading'; statusText.innerText = text; }
function setActiveStatus(text)  { statusDot.className = 'dot active';  statusText.innerText = text; }
function setErrorStatus(text)   { statusDot.className = 'dot';         statusText.innerText = 'Erro: ' + text; }

function setProgress(pct) {
    progressWrap.style.display = 'flex';
    progressBar.style.setProperty('--progress', pct + '%');
    progressLabel.textContent = Math.round(pct) + '%';
}

function hideProgress() {
    progressWrap.style.display = 'none';
}

// ============================================================
//  Load Workspace button — streaming fetch
// ============================================================
btnLoadLocal.addEventListener('click', async () => {
    setLoadingStatus('Carregando arquivos do workspace...');
    try {
        // Load wifi synchronously (smaller file)
        const wifiRes = await fetch('/wifi.txt');
        if (!wifiRes.ok) throw new Error('wifi.txt não encontrado');
        const wifiText = await wifiRes.text();
        parseWifiData(wifiText);

        // Stream log.txt
        await streamLogFile('/log.txt');

        setActiveStatus('Arquivos carregados');
        hideProgress();
        initializeWifiDashboard();
    } catch (err) {
        setErrorStatus(err.message);
        hideProgress();
    }
});

// ============================================================
//  File upload handlers
// ============================================================
inputLogFile.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setLoadingStatus('Carregando log.txt...');
    streamBlobFile(file);
});

inputWifiFile.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setLoadingStatus('Carregando wifi.txt...');
    const reader = new FileReader();
    reader.onload = (evt) => {
        parseWifiData(evt.target.result);
        setActiveStatus('wifi.txt carregado');
        initializeWifiDashboard();
    };
    reader.readAsText(file);
});

// ============================================================
//  Streaming parser — fetch (server)
// ============================================================
async function streamLogFile(url) {
    logData = [];
    logMarkers = [];

    const response = await fetch(url);
    if (!response.ok) throw new Error('log.txt não encontrado');

    const contentLength = response.headers.get('Content-Length');
    const totalBytes = contentLength ? parseInt(contentLength) : null;
    let loadedBytes = 0;
    let remainder = '';
    let headerParsed = false;
    let headers = [];
    let chunkBuffer = [];
    const CHUNK_SIZE = 1000;

    setProgress(0);
    setLoadingStatus('Carregando log.txt via streaming...');

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        loadedBytes += value.length;
        if (totalBytes) setProgress((loadedBytes / totalBytes) * 100);

        const text = remainder + decoder.decode(value, { stream: true });
        const lines = text.split('\n');
        remainder = lines.pop(); // last incomplete line

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            if (!headerParsed) {
                headers = trimmed.split(',').map(h => h.trim());
                headerParsed = true;
                continue;
            }

            const row = parseSingleRow(trimmed, headers);
            if (!row) continue;

            logData.push(row);
            chunkBuffer.push(row);

            if (chunkBuffer.length >= CHUNK_SIZE) {
                flushChunkToMap(chunkBuffer);
                chunkBuffer = [];
                // Yield to browser
                await new Promise(r => setTimeout(r, 0));
            }
        }
    }

    // Parse remaining text
    if (remainder.trim() && headerParsed) {
        const row = parseSingleRow(remainder.trim(), headers);
        if (row) { logData.push(row); chunkBuffer.push(row); }
    }
    if (chunkBuffer.length > 0) flushChunkToMap(chunkBuffer);

    setProgress(100);
    setLoadingStatus('Processando análise IMU...');
    await new Promise(r => setTimeout(r, 50));

    finalizeLogDashboard();
}

// ============================================================
//  Streaming parser — Blob (file upload)
// ============================================================
async function streamBlobFile(file) {
    logData = [];
    logMarkers = [];

    const CHUNK_BYTES = 512 * 1024; // 512KB per read
    let offset = 0;
    let remainder = '';
    let headerParsed = false;
    let headers = [];
    let chunkBuffer = [];
    const CHUNK_SIZE = 1000;

    setProgress(0);

    while (offset < file.size) {
        const slice = file.slice(offset, offset + CHUNK_BYTES);
        const text = await slice.text();
        offset += CHUNK_BYTES;

        setProgress(Math.min((offset / file.size) * 100, 100));

        const lines = (remainder + text).split('\n');
        remainder = lines.pop();

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            if (!headerParsed) {
                headers = trimmed.split(',').map(h => h.trim());
                headerParsed = true;
                continue;
            }

            const row = parseSingleRow(trimmed, headers);
            if (!row) continue;

            logData.push(row);
            chunkBuffer.push(row);

            if (chunkBuffer.length >= CHUNK_SIZE) {
                flushChunkToMap(chunkBuffer);
                chunkBuffer = [];
                await new Promise(r => setTimeout(r, 0));
            }
        }
    }

    if (remainder.trim() && headerParsed) {
        const row = parseSingleRow(remainder.trim(), headers);
        if (row) { logData.push(row); chunkBuffer.push(row); }
    }
    if (chunkBuffer.length > 0) flushChunkToMap(chunkBuffer);

    setProgress(100);
    setLoadingStatus('Processando análise IMU...');
    await new Promise(r => setTimeout(r, 50));

    finalizeLogDashboard();
    setActiveStatus('log.txt carregado');
    hideProgress();
}

// ============================================================
//  Parse single CSV row
// ============================================================
function parseSingleRow(line, headers) {
    const parts = line.split(',');
    if (parts.length < headers.length) return null;

    const row = {};
    headers.forEach((h, idx) => { row[h] = parts[idx] ? parts[idx].trim() : ''; });

    const latRaw = parseInt(row.lat);
    const lonRaw = parseInt(row.lon);
    if (isNaN(latRaw) || isNaN(lonRaw) || latRaw === 0 || lonRaw === 0) return null;

    row.latitude  = latRaw / 1000000;
    row.longitude = lonRaw / 1000000;
    row.sat       = parseInt(row.sat)       || 0;
    row.hdop      = parseFloat(row.hdop)    || 0.0;
    row.kmh       = parseFloat(row.kmh)     || 0.0;
    row.umidade   = parseFloat(row.umidade) || 0.0;
    row.temp_dht  = parseFloat(row.temp_dht)|| 0.0;
    row.ac_x      = parseFloat(row.ac_x)   || 0.0;
    row.ac_y      = parseFloat(row.ac_y)   || 0.0;
    row.ac_z      = parseFloat(row.ac_z)   || 0.0;
    row.gy_x      = parseFloat(row.gy_x)   || 0.0;
    row.gy_y      = parseFloat(row.gy_y)   || 0.0;
    row.gy_z      = parseFloat(row.gy_z)   || 0.0;

    return row;
}

// ============================================================
//  Flush chunk to map (progressive rendering)
// ============================================================
function flushChunkToMap(chunk) {
    if (!maps.log) {
        const firstPt = chunk[0];
        maps.log = initLeafletMap('map-log');
        canvasRenderer = L.canvas({ padding: 0.5 });
    }

    chunk.forEach((pt, localIdx) => {
        const globalIdx = logData.indexOf(pt);
        const marker = L.circleMarker([pt.latitude, pt.longitude], {
            renderer: canvasRenderer,
            radius: 3,
            color: '#10b981',
            fillColor: '#10b981',
            fillOpacity: 0.7,
            weight: 0,
        });

        marker.on('click', () => openPointPopup(marker, pt, globalIdx < 0 ? logData.length - chunk.length + localIdx : globalIdx));
        marker.addTo(maps.log);
        logMarkers.push(marker);
    });

    // Fit on first chunk
    if (logMarkers.length === chunk.length) {
        maps.log.setView([chunk[0].latitude, chunk[0].longitude], 14);
    }
}

// ============================================================
//  Finalize after streaming complete
// ============================================================
function finalizeLogDashboard() {
    updateStatCards();
    computeJerkAndClassify();
    recolorMarkers();
    renderLogCharts();
    renderHeatbar();
    renderImuPanel();

    // Fit map to full route
    if (maps.log && logMarkers.length > 0) {
        const pts = logData.map(d => [d.latitude, d.longitude]);
        maps.log.fitBounds(L.latLngBounds(pts));
    }
}

// ============================================================
//  Stat cards
// ============================================================
function updateStatCards() {
    let maxSpeed = 0, totalTemp = 0, totalHum = 0, validCount = 0;
    logData.forEach(pt => {
        if (pt.kmh > maxSpeed) maxSpeed = pt.kmh;
        if (pt.temp_dht > 0) { totalTemp += pt.temp_dht; totalHum += pt.umidade; validCount++; }
    });
    document.getElementById('log-stat-points').innerText   = logData.length.toLocaleString('pt-BR');
    document.getElementById('log-stat-max-speed').innerHTML= maxSpeed.toFixed(1) + ' <span class="stat-unit">km/h</span>';
    document.getElementById('log-stat-temp').innerHTML     = (validCount > 0 ? (totalTemp/validCount).toFixed(1) : 'N/A') + ' <span class="stat-unit">°C</span>';
    document.getElementById('log-stat-hum').innerHTML      = (validCount > 0 ? (totalHum/validCount).toFixed(1) : 'N/A') + ' <span class="stat-unit">%</span>';
}

// ============================================================
//  LTTB Downsampling
// ============================================================
function lttb(data, threshold) {
    const len = data.length;
    if (threshold >= len || threshold === 0) return data;

    const sampled = [];
    let a = 0;
    sampled.push(data[0]);

    const bucketSize = (len - 2) / (threshold - 2);

    for (let i = 0; i < threshold - 2; i++) {
        let avgX = 0, avgY = 0;
        const avgRangeStart = Math.floor((i + 1) * bucketSize) + 1;
        const avgRangeEnd   = Math.min(Math.floor((i + 2) * bucketSize) + 1, len);
        const avgRangeLen   = avgRangeEnd - avgRangeStart;

        for (let j = avgRangeStart; j < avgRangeEnd; j++) {
            avgX += data[j].x !== undefined ? data[j].x : j;
            avgY += data[j].y !== undefined ? data[j].y : data[j];
        }
        avgX /= avgRangeLen;
        avgY /= avgRangeLen;

        const rangeStart = Math.floor(i * bucketSize) + 1;
        const rangeEnd   = Math.min(Math.floor((i + 1) * bucketSize) + 1, len);
        const pointAX    = data[a].x !== undefined ? data[a].x : a;
        const pointAY    = data[a].y !== undefined ? data[a].y : data[a];

        let maxArea = -1, maxIdx = rangeStart;
        for (let j = rangeStart; j < rangeEnd; j++) {
            const px = data[j].x !== undefined ? data[j].x : j;
            const py = data[j].y !== undefined ? data[j].y : data[j];
            const area = Math.abs((pointAX - avgX) * (py - pointAY) - (pointAX - px) * (avgY - pointAY)) * 0.5;
            if (area > maxArea) { maxArea = area; maxIdx = j; }
        }

        sampled.push(data[maxIdx]);
        a = maxIdx;
    }

    sampled.push(data[len - 1]);
    return sampled;
}

// ============================================================
//  Adaptive jerk & classification
// ============================================================
function computeJerkAndClassify() {
    if (logData.length < 2) return;

    // Compute jerk for each point
    logData[0].jerk   = 0;
    logData[0].eventType = 'normal';
    for (let i = 1; i < logData.length; i++) {
        logData[i].jerk = Math.abs(logData[i].ac_z - logData[i-1].ac_z);
    }

    // Adaptive thresholds for jerk
    const jerks = logData.map(d => d.jerk);
    const meanJerk = jerks.reduce((a,b) => a+b, 0) / jerks.length;
    const stdJerk  = Math.sqrt(jerks.map(j => (j-meanJerk)**2).reduce((a,b)=>a+b,0) / jerks.length);
    thresholds.leve  = meanJerk + 1 * stdJerk;
    thresholds.forte = meanJerk + 2 * stdJerk;

    // Adaptive threshold for gyro magnitude
    const gyroMags = logData.map(d => Math.sqrt(d.gy_x**2 + d.gy_y**2));
    const meanGyro = gyroMags.reduce((a,b) => a+b, 0) / gyroMags.length;
    const stdGyro  = Math.sqrt(gyroMags.map(g => (g-meanGyro)**2).reduce((a,b)=>a+b,0) / gyroMags.length);
    thresholds.gyro = meanGyro + 2 * stdGyro;

    // Classify each point
    imuEvents = [];
    for (let i = 0; i < logData.length; i++) {
        const pt = logData[i];
        const gyroMag = Math.sqrt(pt.gy_x**2 + pt.gy_y**2);
        const isCurve = gyroMag > thresholds.gyro;

        if (isCurve && pt.jerk > thresholds.leve) {
            pt.eventType = 'curva';
            imuEvents.push({ idx: i, type: 'curva', pt });
        } else if (pt.jerk > thresholds.forte) {
            pt.eventType = 'forte';
            imuEvents.push({ idx: i, type: 'forte', pt });
        } else if (pt.jerk > thresholds.leve) {
            pt.eventType = 'leve';
            imuEvents.push({ idx: i, type: 'leve', pt });
        } else {
            pt.eventType = 'normal';
        }
    }

    // Update bumps stat
    const bumps = imuEvents.filter(e => e.type === 'forte' || e.type === 'leve').length;
    document.getElementById('log-stat-bumps').innerText = bumps.toLocaleString('pt-BR');
}

// ============================================================
//  Recolor markers based on event type
// ============================================================
function recolorMarkers() {
    const colorMap = { normal: '#10b981', leve: '#f59e0b', forte: '#ef4444', curva: '#a855f7' };
    for (let i = 0; i < logMarkers.length && i < logData.length; i++) {
        const col = colorMap[logData[i].eventType] || '#10b981';
        logMarkers[i].setStyle({ color: col, fillColor: col });
    }
}

// ============================================================
//  Popup with mini-gauge SVG
// ============================================================
function openPointPopup(marker, pt, idx) {
    const colorMap = { normal: '#10b981', leve: '#f59e0b', forte: '#ef4444', curva: '#a855f7' };
    const labelMap = { normal: '✅ Normal', leve: '🟡 Solavanco Leve', forte: '🔴 Impacto Forte', curva: '🟣 Curva Brusca' };
    const bgMap    = { normal: 'rgba(16,185,129,0.15)', leve: 'rgba(245,158,11,0.15)', forte: 'rgba(239,68,68,0.15)', curva: 'rgba(168,85,247,0.15)' };
    const evType   = pt.eventType || 'normal';
    const col      = colorMap[evType];
    const label    = labelMap[evType];
    const bg       = bgMap[evType];

    // Gauge: jerk relative to forte threshold (0-1 clamped)
    const gaugeVal = thresholds.forte > 0 ? Math.min(pt.jerk / thresholds.forte, 1) : 0;
    const angle    = gaugeVal * 180; // 0-180 degrees half-circle
    const rad      = (angle - 90) * Math.PI / 180;
    const cx = 50, cy = 50, r = 38;
    const x  = cx + r * Math.cos(rad);
    const y  = cy + r * Math.sin(rad);
    const sweepFlag = angle > 0 ? 1 : 0;

    // Color gradient for needle: green -> yellow -> red
    const needleColor = gaugeVal < 0.5 ? '#f59e0b' : '#ef4444';

    const gaugeSvg = `
    <svg width="100" height="58" viewBox="0 0 100 58" xmlns="http://www.w3.org/2000/svg">
      <path d="M 12 50 A 38 38 0 0 1 88 50" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="8" stroke-linecap="round"/>
      <path d="M 12 50 A 38 38 0 0 1 ${x.toFixed(1)} ${y.toFixed(1)}" fill="none" stroke="${col}" stroke-width="8" stroke-linecap="round" opacity="0.9"/>
      <circle cx="${cx}" cy="${cy}" r="4" fill="${col}"/>
      <line x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" stroke="${col}" stroke-width="2" stroke-linecap="round"/>
      <text x="12" y="57" font-size="7" fill="rgba(255,255,255,0.4)" font-family="sans-serif">0</text>
      <text x="83" y="57" font-size="7" fill="rgba(255,255,255,0.4)" font-family="sans-serif">MAX</text>
    </svg>`;

    const html = `<div class="popup-content">
      <div class="popup-header">${pt.data_hora}</div>
      <div class="popup-row"><span class="popup-label">Velocidade</span><span class="popup-val">${pt.kmh.toFixed(1)} km/h</span></div>
      <div class="popup-row"><span class="popup-label">Temperatura</span><span class="popup-val">${pt.temp_dht}°C</span></div>
      <div class="popup-row"><span class="popup-label">Umidade</span><span class="popup-val">${pt.umidade}%</span></div>
      <div class="popup-row"><span class="popup-label">Satélites</span><span class="popup-val">${pt.sat} (HDOP ${pt.hdop})</span></div>
      <div class="popup-row"><span class="popup-label">Acc X/Y/Z</span><span class="popup-val">${pt.ac_x.toFixed(2)} / ${pt.ac_y.toFixed(2)} / ${pt.ac_z.toFixed(2)}</span></div>
      <div class="popup-row"><span class="popup-label">Gyro X/Y/Z</span><span class="popup-val">${pt.gy_x.toFixed(3)} / ${pt.gy_y.toFixed(3)} / ${pt.gy_z.toFixed(3)}</span></div>
      <div class="popup-gauge-wrap">
        <div class="popup-gauge-label">Intensidade de Impacto</div>
        ${gaugeSvg}
        <span class="popup-event-badge" style="background:${bg};color:${col};">${label}</span>
      </div>
    </div>`;

    marker.bindPopup(L.popup({ maxWidth: 260 }).setContent(html)).openPopup();
}

// ============================================================
//  Heatbar — Heat Index
// ============================================================
function computeHeatIndex(T, RH) {
    // Simplified Rothfusz regression (°C input)
    if (T < 27) return T; // Below threshold, feels like temperature
    const HI = -8.78469475556
        + 1.61139411 * T
        + 2.3385248 * RH
        - 0.14611605 * T * RH
        - 0.012308094 * T * T
        - 0.016424828 * RH * RH
        + 0.002211732 * T * T * RH
        + 0.00072546 * T * RH * RH
        - 0.000003582 * T * T * RH * RH;
    return HI;
}

function heatIndexColor(hi) {
    // Fresco <24: blue, Confortável 24-28: green, Quente 28-32: orange, Crítico >32: red
    if (hi < 24) return { r: 96,  g: 165, b: 250 };  // blue
    if (hi < 28) return { r: 16,  g: 185, b: 129 };  // green
    if (hi < 32) return { r: 245, g: 158, b: 11  };  // orange
    return            { r: 239, g: 68,  b: 68   };  // red
}

function renderHeatbar() {
    const canvas = document.getElementById('chart-heatbar');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    // Downsample to ~400 segments
    const N = Math.min(logData.length, 400);
    const step = logData.length / N;
    const segments = [];
    for (let i = 0; i < N; i++) {
        const pt = logData[Math.floor(i * step)];
        const hi = computeHeatIndex(pt.temp_dht, pt.umidade);
        segments.push(heatIndexColor(hi));
    }

    canvas.width  = canvas.offsetWidth  || 400;
    canvas.height = 48;

    const segW = canvas.width / N;
    segments.forEach((col, i) => {
        ctx.fillStyle = `rgba(${col.r},${col.g},${col.b},0.85)`;
        ctx.fillRect(i * segW, 0, segW + 1, canvas.height);
    });

    // Hour labels
    const labelsDiv = document.getElementById('heatbar-labels');
    labelsDiv.innerHTML = '';
    const totalPoints = logData.length;
    const labelCount  = 6;
    for (let i = 0; i <= labelCount; i++) {
        const idx = Math.floor((i / labelCount) * (totalPoints - 1));
        const label = document.createElement('span');
        label.textContent = logData[idx].data_hora.split(' ')[1] || '';
        labelsDiv.appendChild(label);
    }
}

// ============================================================
//  Log Charts (LTTB downsampled)
// ============================================================
function renderLogCharts() {
    const TARGET = 800;
    const rawIndices = logData.map((_, i) => i);
    const rawLabels  = logData.map(d => d.data_hora.split(' ')[1] || d.data_hora);

    // Helper: downsample preserving original indices
    function dsData(arr) {
        if (arr.length <= TARGET) return { vals: arr, labels: rawLabels, indices: rawIndices };
        const step = arr.length / TARGET;
        const sampled = [], sampledLabels = [], sampledIdx = [];
        for (let i = 0; i < TARGET; i++) {
            const idx = Math.min(Math.floor(i * step), arr.length - 1);
            sampled.push(arr[idx]);
            sampledLabels.push(rawLabels[idx]);
            sampledIdx.push(idx);
        }
        return { vals: sampled, labels: sampledLabels, indices: sampledIdx };
    }

    const dTemp  = dsData(logData.map(d => d.temp_dht));
    const dHum   = dsData(logData.map(d => d.umidade));
    const dKmh   = dsData(logData.map(d => d.kmh));
    const dSat   = dsData(logData.map(d => d.sat));
    const dJerk  = dsData(logData.map(d => d.jerk || 0));

    const chartDefaults = {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: { legend: { labels: { color: '#f3f4f6', font: { family: 'Outfit' } } } }
    };

    const xScale = (labels) => ({
        x: {
            grid: { color: 'rgba(255,255,255,0.05)' },
            ticks: { color: '#9ca3af', maxTicksLimit: 8, font: { family: 'Outfit', size: 10 } },
            labels
        }
    });

    // --- Temp Chart ---
    if (charts.temp) charts.temp.destroy();
    charts.temp = new Chart(document.getElementById('chart-temp').getContext('2d'), {
        type: 'line',
        data: {
            labels: dTemp.labels,
            datasets: [{
                label: 'Temperatura (°C)',
                data: dTemp.vals,
                borderColor: '#f59e0b',
                backgroundColor: 'rgba(245,158,11,0.12)',
                fill: true,
                tension: 0.4,
                pointRadius: 0,
                borderWidth: 2
            }]
        },
        options: {
            ...chartDefaults,
            scales: {
                ...xScale(dTemp.labels),
                y: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#f59e0b' } }
            }
        }
    });

    // --- Humidity Chart ---
    if (charts.hum) charts.hum.destroy();
    charts.hum = new Chart(document.getElementById('chart-hum').getContext('2d'), {
        type: 'line',
        data: {
            labels: dHum.labels,
            datasets: [{
                label: 'Umidade (%)',
                data: dHum.vals,
                borderColor: '#60a5fa',
                backgroundColor: 'rgba(96,165,250,0.12)',
                fill: true,
                tension: 0.4,
                pointRadius: 0,
                borderWidth: 2
            }]
        },
        options: {
            ...chartDefaults,
            scales: {
                ...xScale(dHum.labels),
                y: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#60a5fa' } }
            }
        }
    });

    // --- Speed + Satellites ---
    if (charts.speed) charts.speed.destroy();
    charts.speed = new Chart(document.getElementById('chart-speed').getContext('2d'), {
        type: 'line',
        data: {
            labels: dKmh.labels,
            datasets: [
                {
                    label: 'Velocidade (km/h)',
                    data: dKmh.vals,
                    borderColor: '#3b82f6',
                    backgroundColor: 'rgba(59,130,246,0.1)',
                    yAxisID: 'ySpeed',
                    tension: 0.3,
                    pointRadius: 0,
                    borderWidth: 2
                },
                {
                    label: 'Satélites',
                    data: dSat.vals,
                    borderColor: '#a855f7',
                    backgroundColor: 'rgba(168,85,247,0.1)',
                    yAxisID: 'ySat',
                    tension: 0.3,
                    pointRadius: 0,
                    borderWidth: 1.5
                }
            ]
        },
        options: {
            ...chartDefaults,
            scales: {
                ...xScale(dKmh.labels),
                ySpeed: { position: 'left',  grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#3b82f6' } },
                ySat:   { position: 'right', grid: { display: false },                   ticks: { color: '#a855f7' } }
            }
        }
    });

    // --- Jerk Chart ---
    if (charts.jerk) charts.jerk.destroy();

    // Build background color per point based on event type
    const jerkColors = dJerk.indices.map(i => {
        const et = logData[i] ? logData[i].eventType : 'normal';
        if (et === 'forte') return 'rgba(239,68,68,0.8)';
        if (et === 'leve')  return 'rgba(245,158,11,0.7)';
        if (et === 'curva') return 'rgba(168,85,247,0.7)';
        return 'rgba(16,185,129,0.4)';
    });

    charts.jerk = new Chart(document.getElementById('chart-jerk').getContext('2d'), {
        type: 'bar',
        data: {
            labels: dJerk.labels,
            datasets: [
                {
                    label: 'Jerk Vertical',
                    data: dJerk.vals,
                    backgroundColor: jerkColors,
                    borderWidth: 0,
                    borderRadius: 1
                },
                // Threshold lines as fake datasets
                {
                    label: 'Threshold Leve',
                    data: new Array(dJerk.vals.length).fill(thresholds.leve),
                    type: 'line',
                    borderColor: '#f59e0b',
                    borderDash: [4, 4],
                    borderWidth: 1.5,
                    pointRadius: 0,
                    fill: false
                },
                {
                    label: 'Threshold Forte',
                    data: new Array(dJerk.vals.length).fill(thresholds.forte),
                    type: 'line',
                    borderColor: '#ef4444',
                    borderDash: [4, 4],
                    borderWidth: 1.5,
                    pointRadius: 0,
                    fill: false
                }
            ]
        },
        options: {
            ...chartDefaults,
            scales: {
                ...xScale(dJerk.labels),
                y: {
                    grid: { color: 'rgba(255,255,255,0.05)' },
                    ticks: { color: '#9ca3af' },
                    title: { display: true, text: 'Δ ac_z', color: '#9ca3af' }
                }
            }
        }
    });
}

// ============================================================
//  IMU Panel — summary + event list
// ============================================================
function renderImuPanel() {
    const countLeve  = imuEvents.filter(e => e.type === 'leve').length;
    const countForte = imuEvents.filter(e => e.type === 'forte').length;
    const countCurva = imuEvents.filter(e => e.type === 'curva').length;

    document.getElementById('imu-count-leve').innerText  = countLeve.toLocaleString('pt-BR');
    document.getElementById('imu-count-forte').innerText = countForte.toLocaleString('pt-BR');
    document.getElementById('imu-count-curva').innerText = countCurva.toLocaleString('pt-BR');
    document.getElementById('imu-thresh-leve').innerText = thresholds.leve.toFixed(4);
    document.getElementById('imu-thresh-forte').innerText= thresholds.forte.toFixed(4);

    const eventList = document.getElementById('event-list');
    eventList.innerHTML = '';

    if (imuEvents.length === 0) {
        eventList.innerHTML = '<div style="padding:1rem;text-align:center;color:var(--text-secondary);">Nenhum evento detectado.</div>';
        return;
    }

    const iconMap  = { leve: '🟡', forte: '🔴', curva: '🟣' };
    const colorMap = { leve: '#f59e0b', forte: '#ef4444', curva: '#a855f7' };

    // Show last 200 events max
    const shown = imuEvents.slice(-200).reverse();
    shown.forEach(ev => {
        const pt   = ev.pt;
        const item = document.createElement('div');
        item.className = 'list-item';
        item.innerHTML = `
          <span class="event-icon">${iconMap[ev.type]}</span>
          <div class="event-info">
            <span class="event-time">${pt.data_hora.split(' ')[1] || pt.data_hora}</span>
            <span class="event-detail">Jerk: ${pt.jerk.toFixed(4)} · ${ev.type === 'curva' ? 'Curva Brusca' : ev.type === 'forte' ? 'Impacto Forte' : 'Solavanco Leve'}</span>
          </div>
          <span class="event-speed">${pt.kmh.toFixed(1)} km/h</span>
          <span class="badge" style="background:rgba(${ev.type==='forte'?'239,68,68':ev.type==='leve'?'245,158,11':'168,85,247'},0.15);color:${colorMap[ev.type]};">→ Mapa</span>
        `;
        item.addEventListener('click', () => {
            maps.log.flyTo([pt.latitude, pt.longitude], 17, { duration: 1 });
            const markerIdx = ev.idx;
            if (logMarkers[markerIdx]) {
                openPointPopup(logMarkers[markerIdx], pt, markerIdx);
            }
        });
        eventList.appendChild(item);
    });
}

// ============================================================
//  Leaflet map initializer
// ============================================================
function initLeafletMap(containerId) {
    const map = L.map(containerId).setView([-14.1631, -47.6194], 14);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
        subdomains: 'abcd',
        maxZoom: 20
    }).addTo(map);
    return map;
}

// ============================================================
//  Wi-Fi parsing & dashboard (unchanged logic, dark popup)
// ============================================================
function parseWifiData(csvText) {
    wifiData = [];
    const lines = csvText.split('\n');
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const parts = trimmed.split(',');
        if (parts.length < 7) continue;
        const latRaw = parseInt(parts[1]);
        const lonRaw = parseInt(parts[2]);
        if (isNaN(latRaw) || isNaN(lonRaw) || latRaw === 0 || lonRaw === 0) continue;
        wifiData.push({
            data_hora:  parts[0].trim(),
            latitude:   latRaw / 1000000,
            longitude:  lonRaw / 1000000,
            ssid:       parts[3].trim() || '[SSID Oculto]',
            potencia:   parseInt(parts[4]) || -100,
            canal:      parseInt(parts[5]) || 1,
            seguranca:  parts[6].trim()
        });
    }
}

let currentWifiFilters = { search: '', minSignal: -100, channel: 'all' };

function initializeWifiDashboard() {
    if (wifiData.length === 0) return;
    if (!maps.wifi) maps.wifi = initLeafletMap('map-wifi');
    populateWifiChannelFilter();
    applyWifiFiltersAndRender();
}

function populateWifiChannelFilter() {
    const channels = new Set();
    wifiData.forEach(w => channels.add(w.canal));
    const sorted = Array.from(channels).sort((a,b) => a-b);
    const select = document.getElementById('wifi-filter-channel');
    select.innerHTML = '<option value="all">Todos os Canais</option>';
    sorted.forEach(ch => { select.innerHTML += `<option value="${ch}">Canal ${ch}</option>`; });
}

document.getElementById('wifi-search').addEventListener('input', e => {
    currentWifiFilters.search = e.target.value.toLowerCase();
    applyWifiFiltersAndRender();
});

document.getElementById('wifi-filter-signal').addEventListener('input', e => {
    currentWifiFilters.minSignal = parseInt(e.target.value);
    document.getElementById('wifi-signal-val').innerText = e.target.value + ' dBm';
    applyWifiFiltersAndRender();
});

document.getElementById('wifi-filter-channel').addEventListener('change', e => {
    currentWifiFilters.channel = e.target.value;
    applyWifiFiltersAndRender();
});

function applyWifiFiltersAndRender() {
    const filtered = wifiData.filter(w => {
        const ms = w.ssid.toLowerCase().includes(currentWifiFilters.search) ||
                   w.seguranca.toLowerCase().includes(currentWifiFilters.search);
        const msig = w.potencia >= currentWifiFilters.minSignal;
        const mch  = currentWifiFilters.channel === 'all' || w.canal === parseInt(currentWifiFilters.channel);
        return ms && msig && mch;
    });

    const grouped = {};
    filtered.forEach(w => {
        const key = `${w.latitude.toFixed(6)},${w.longitude.toFixed(6)}`;
        if (!grouped[key]) grouped[key] = { lat: w.latitude, lon: w.longitude, networks: [] };
        grouped[key].networks.push(w);
    });

    if (markers.wifiLayerGroup) maps.wifi.removeLayer(markers.wifiLayerGroup);
    markers.wifiLayerGroup = L.layerGroup().addTo(maps.wifi);
    let allPoints = [];

    Object.values(grouped).forEach(loc => {
        let bestSignal = -100;
        loc.networks.forEach(n => { if (n.potencia > bestSignal) bestSignal = n.potencia; });
        let markerColor = '#ef4444';
        if (bestSignal >= -60) markerColor = '#10b981';
        else if (bestSignal >= -80) markerColor = '#f59e0b';

        const circle = L.circleMarker([loc.lat, loc.lon], {
            color: markerColor, fillColor: markerColor,
            fillOpacity: 0.6,
            radius: 8 + loc.networks.length * 0.5
        });

        let popupHtml = `<div style="font-family:'Outfit',sans-serif;color:#f3f4f6;max-height:200px;overflow-y:auto;">
            <strong>Scan Localizado</strong> (${loc.networks.length} Redes)<br/><hr style="margin:5px 0;border-color:rgba(255,255,255,0.1);"/>`;
        loc.networks.sort((a,b) => b.potencia - a.potencia).forEach(n => {
            const sigColor = n.potencia >= -60 ? '#34d399' : (n.potencia >= -80 ? '#fbbf24' : '#f87171');
            popupHtml += `<div style="margin-bottom:6px;">
                <strong style="color:#93c5fd;">${n.ssid}</strong><br/>
                Sinal: <span style="color:${sigColor};font-weight:bold;">${n.potencia} dBm</span> |
                Ch: ${n.canal} | ${n.seguranca}
            </div>`;
        });
        popupHtml += '</div>';

        circle.bindPopup(L.popup({ maxWidth: 260 }).setContent(popupHtml));
        circle.addTo(markers.wifiLayerGroup);
        allPoints.push([loc.lat, loc.lon]);
    });

    if (allPoints.length > 0) maps.wifi.fitBounds(L.latLngBounds(allPoints));

    document.getElementById('wifi-stat-scans').innerText = filtered.length.toLocaleString('pt-BR');
    const uniqueSSIDs = new Set(filtered.map(w => w.ssid));
    document.getElementById('wifi-stat-unique').innerText = uniqueSSIDs.size.toLocaleString('pt-BR');
    let maxSig = -100;
    filtered.forEach(w => { if (w.potencia > maxSig) maxSig = w.potencia; });
    document.getElementById('wifi-stat-best-signal').innerHTML = filtered.length > 0
        ? maxSig + ' <span class="stat-unit">dBm</span>' : 'N/A';

    populateWifiList(filtered);
    renderWifiAnalytics(filtered);
}

function populateWifiList(filteredList) {
    const listContainer = document.getElementById('wifi-list');
    listContainer.innerHTML = '';
    if (filteredList.length === 0) {
        listContainer.innerHTML = '<div style="padding:1.5rem;text-align:center;color:var(--text-secondary);">Nenhuma rede encontrada.</div>';
        return;
    }
    const sorted = [...filteredList].sort((a,b) => b.potencia - a.potencia);
    sorted.slice(0, 100).forEach(w => {
        const item = document.createElement('div');
        item.className = 'list-item';
        let signalClass = 'badge-danger';
        if (w.potencia >= -60) signalClass = 'badge-success';
        else if (w.potencia >= -80) signalClass = 'badge-warning';
        item.innerHTML = `
            <div>
                <div class="wifi-name">${w.ssid}</div>
                <div class="wifi-meta">Ch: ${w.canal} | ${w.seguranca}</div>
                <div class="wifi-meta" style="font-size:0.7rem;color:#4b5563;">${w.data_hora}</div>
            </div>
            <span class="badge ${signalClass}">${w.potencia} dBm</span>
        `;
        item.addEventListener('click', () => {
            maps.wifi.setView([w.latitude, w.longitude], 18);
            markers.wifiLayerGroup.eachLayer(layer => {
                if (layer.getLatLng &&
                    layer.getLatLng().lat.toFixed(6) === w.latitude.toFixed(6) &&
                    layer.getLatLng().lng.toFixed(6) === w.longitude.toFixed(6)) {
                    layer.openPopup();
                }
            });
        });
        listContainer.appendChild(item);
    });
}

function renderWifiAnalytics(filteredList) {
    const channelCounts = {};
    filteredList.forEach(w => { channelCounts[w.canal] = (channelCounts[w.canal] || 0) + 1; });
    const chLabels = Object.keys(channelCounts).sort((a,b) => parseInt(a)-parseInt(b));
    const chData   = chLabels.map(l => channelCounts[l]);

    if (charts.wifiChannels) charts.wifiChannels.destroy();
    charts.wifiChannels = new Chart(document.getElementById('chart-wifi-channels').getContext('2d'), {
        type: 'bar',
        data: {
            labels: chLabels.map(ch => 'Ch ' + ch),
            datasets: [{ label: 'Contagem', data: chData, backgroundColor: 'rgba(59,130,246,0.6)', borderColor: '#3b82f6', borderWidth: 1 }]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            scales: {
                x: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#9ca3af' } },
                y: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#9ca3af' } }
            },
            plugins: { legend: { display: false } }
        }
    });

    const secCounts = {};
    filteredList.forEach(w => { secCounts[w.seguranca] = (secCounts[w.seguranca] || 0) + 1; });
    const secLabels = Object.keys(secCounts);
    const secData   = secLabels.map(l => secCounts[l]);
    const colors = ['rgba(16,185,129,0.7)','rgba(59,130,246,0.7)','rgba(245,158,11,0.7)','rgba(239,68,68,0.7)','rgba(168,85,247,0.7)'];

    if (charts.wifiSecurity) charts.wifiSecurity.destroy();
    charts.wifiSecurity = new Chart(document.getElementById('chart-wifi-security').getContext('2d'), {
        type: 'doughnut',
        data: {
            labels: secLabels,
            datasets: [{ data: secData, backgroundColor: colors.slice(0, secLabels.length), borderColor: 'rgba(255,255,255,0.08)', borderWidth: 1 }]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { position: 'right', labels: { color: '#f3f4f6', font: { family: 'Outfit' } } } }
        }
    });
}
