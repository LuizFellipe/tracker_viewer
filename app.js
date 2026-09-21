// ============================================================
//  State
// ============================================================
let logData = [];
let wifiData = [];
let btData = [];
let maps = { log: null, wifi: null, bt: null };
let markers = { logRoute: null, logLayerGroup: null, wifiLayerGroup: null, btLayerGroup: null };
let charts = { temp: null, hum: null, speed: null, jerk: null, wifiChannels: null, wifiSecurity: null, btRssi: null, btTop: null };

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
const inputBtFile    = document.getElementById('input-bt-file');
const selectDateSession = document.getElementById('select-date-session');
const inputBatchFiles   = document.getElementById('input-batch-files');
const btnExportJson     = document.getElementById('btn-export-json');
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
            if (targetTab === 'tab-bt'  && maps.bt)   maps.bt.invalidateSize();
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
function escapeHtml(s) {
    return String(s ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

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
//  Load Workspace / Dataset button
// ============================================================
btnLoadLocal.addEventListener('click', async () => {
    // Se o dataset particionado estiver disponível, carrega a data atualmente selecionada (ou a mais recente)
    if (datasetIndex && datasetIndex.dates && Object.keys(datasetIndex.dates).length > 0) {
        const dates = Object.keys(datasetIndex.dates).sort().reverse();
        const target = selectDateSession && selectDateSession.value ? selectDateSession.value : dates[0];
        await loadDateData(target);
        return;
    }

    setLoadingStatus('Carregando arquivos do workspace...');
    try {
        // Load wifi synchronously (smaller file)
        const wifiRes = await fetch('/wifi.txt');
        if (!wifiRes.ok) throw new Error('wifi.txt não encontrado');
        const wifiText = await wifiRes.text();
        parseWifiData(wifiText);

        // Load bluetooth (optional — does not fail if absent)
        try {
            const btRes = await fetch('/ble.txt');
            if (btRes.ok) {
                const btText = await btRes.text();
                parseBluetoothData(btText);
                initializeBluetoothDashboard();
            }
        } catch (_) { /* ble.txt optional */ }

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

inputBtFile.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setLoadingStatus('Carregando ble.txt...');
    const reader = new FileReader();
    reader.onload = (evt) => {
        parseBluetoothData(evt.target.result);
        setActiveStatus('ble.txt carregado');
        initializeBluetoothDashboard();
    };
    reader.readAsText(file);
});

// ============================================================
//  Streaming parser — fetch (server)
// ============================================================
async function streamLogFile(url) {
    logData = [];
    logMarkers = [];
    resetLogMarkersLayer();

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
            if (!trimmed || trimmed.startsWith('#')) continue;

            if (!headerParsed) {
                if (isHeaderLine(trimmed)) {
                    headers = trimmed.split(',').map(h => h.trim());
                    headerParsed = true;
                    continue;
                }
                // Sem header (ex: log/04/log.txt): parsing posicional direto
            }

            const row = headerParsed ? parseSingleRow(trimmed, headers) : parsePositionalRow(trimmed);
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
    if (remainder.trim() && (headerParsed || !isHeaderLine(remainder.trim()))) {
        const row = headerParsed ? parseSingleRow(remainder.trim(), headers) : parsePositionalRow(remainder.trim());
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
    resetLogMarkersLayer();

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
            if (!trimmed || trimmed.startsWith('#')) continue;

            if (!headerParsed) {
                if (isHeaderLine(trimmed)) {
                    headers = trimmed.split(',').map(h => h.trim());
                    headerParsed = true;
                    continue;
                }
                // Sem header: parsing posicional direto
            }

            const row = headerParsed ? parseSingleRow(trimmed, headers) : parsePositionalRow(trimmed);
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

    if (remainder.trim() && (headerParsed || !isHeaderLine(remainder.trim()))) {
        const row = headerParsed ? parseSingleRow(remainder.trim(), headers) : parsePositionalRow(remainder.trim());
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
function isHeaderLine(trimmed) {
    const lower = trimmed.toLowerCase();
    if (lower.startsWith('data_hora')) return true;
    const cols = lower.split(',').map(c => c.trim());
    return cols.includes('lat') && cols.includes('lon');
}

// Parsing posicional (fallback para logs sem header), igual ao ingest.py:
// data_hora, lat, lon, sat, hdop, kmh, direcao, umidade, temp, ac_x/y/z, gy_x/y/z
function parsePositionalRow(line) {
    const parts = line.split(',');
    if (parts.length < 14) return null;

    const m = parts[0].trim().match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/);
    if (!m) return null;
    const [, d, mo, y, hh, mm, ss] = m;
    const yr = parseInt(y);
    if (yr < 2020 || yr > 2035) return null;

    const latRaw = parseInt(parts[1]);
    const lonRaw = parseInt(parts[2]);
    if (isNaN(latRaw) || isNaN(lonRaw) || latRaw === 0 || lonRaw === 0) return null;

    return {
        data_hora: parts[0].trim(),
        latitude:  latRaw / 1000000,
        longitude: lonRaw / 1000000,
        sat:       parseInt(parts[3])       || 0,
        hdop:      parseFloat(parts[4])     || 0.0,
        kmh:       parseFloat(parts[5])     || 0.0,
        direcao:   parts[6] ? parts[6].trim() : '',
        umidade:   parseFloat(parts[7])     || 0.0,
        temp_dht:  parseFloat(parts[8])     || 0.0,
        ac_x:      parseFloat(parts[9])     || 0.0,
        ac_y:      parseFloat(parts[10])    || 0.0,
        ac_z:      parseFloat(parts[11])    || 0.0,
        gy_x:      parseFloat(parts[12])    || 0.0,
        gy_y:      parseFloat(parts[13])    || 0.0,
        gy_z:      parts.length > 14 ? (parseFloat(parts[14]) || 0.0) : 0.0,
        jerk:      0,
        eventType: 'normal'
    };
}

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
function resetLogMarkersLayer() {
    if (maps.log && markers.logLayerGroup) {
        maps.log.removeLayer(markers.logLayerGroup);
    }
    markers.logLayerGroup = null;
}

function flushChunkToMap(chunk) {
    if (!maps.log) {
        maps.log = initLeafletMap('map-log');
        canvasRenderer = L.canvas({ padding: 0.5 });
    }
    if (!markers.logLayerGroup) {
        markers.logLayerGroup = L.layerGroup().addTo(maps.log);
    }

    const baseIdx = logData.length - chunk.length;
    chunk.forEach((pt, localIdx) => {
        const marker = L.circleMarker([pt.latitude, pt.longitude], {
            renderer: canvasRenderer,
            radius: 3,
            color: '#10b981',
            fillColor: '#10b981',
            fillOpacity: 0.7,
            weight: 0,
        });

        marker.on('click', () => openPointPopup(marker, pt, baseIdx + localIdx));
        marker.addTo(markers.logLayerGroup);
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
//  LTTB Downsampling — retorna índices originais selecionados
// ============================================================
function lttbIndices(values, threshold) {
    const len = values.length;
    if (threshold >= len || threshold < 3) {
        return values.map((_, i) => i);
    }

    const sampled = [0];
    let a = 0;
    const bucketSize = (len - 2) / (threshold - 2);

    for (let i = 0; i < threshold - 2; i++) {
        const avgRangeStart = Math.floor((i + 1) * bucketSize) + 1;
        const avgRangeEnd   = Math.min(Math.floor((i + 2) * bucketSize) + 1, len);
        const avgRangeLen   = avgRangeEnd - avgRangeStart;
        if (avgRangeLen <= 0) continue;

        let avgX = 0, avgY = 0;
        for (let j = avgRangeStart; j < avgRangeEnd; j++) {
            avgX += j;
            avgY += values[j];
        }
        avgX /= avgRangeLen;
        avgY /= avgRangeLen;

        const rangeStart = Math.floor(i * bucketSize) + 1;
        const rangeEnd   = Math.min(Math.floor((i + 1) * bucketSize) + 1, len);
        const pointAX = a;
        const pointAY = values[a];

        let maxArea = -1, maxIdx = rangeStart;
        for (let j = rangeStart; j < rangeEnd; j++) {
            const area = Math.abs((pointAX - avgX) * (values[j] - pointAY) - (pointAX - j) * (avgY - pointAY)) * 0.5;
            if (area > maxArea) { maxArea = area; maxIdx = j; }
        }

        sampled.push(maxIdx);
        a = maxIdx;
    }

    sampled.push(len - 1);
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
    if (!canvas || !logData || logData.length === 0) return;
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
    const rawLabels  = logData.map(d => d.data_hora.split(' ')[1] || d.data_hora);

    // Helper: LTTB downsample preservando índices originais
    function dsData(arr) {
        if (arr.length <= TARGET) {
            return { vals: arr, labels: rawLabels, indices: arr.map((_, i) => i) };
        }
        const indices = lttbIndices(arr, TARGET);
        return {
            vals: indices.map(i => arr[i]),
            labels: indices.map(i => rawLabels[i]),
            indices
        };
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
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {
        attribution: 'Tiles &copy; Esri &mdash; Source: Esri, HERE, Garmin, USGS, Intermap, INCREMENT P, NRCan, Esri Japan, METI, Esri China (Hong Kong), Esri Korea, Esri (Thailand), NGCC, (c) OpenStreetMap contributors, and the GIS User Community',
        maxZoom: 19
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
                <strong style="color:#93c5fd;">${escapeHtml(n.ssid)}</strong><br/>
                Sinal: <span style="color:${sigColor};font-weight:bold;">${n.potencia} dBm</span> |
                Ch: ${n.canal} | ${escapeHtml(n.seguranca)}
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
                <div class="wifi-name">${escapeHtml(w.ssid)}</div>
                <div class="wifi-meta">Ch: ${w.canal} | ${escapeHtml(w.seguranca)}</div>
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

// ============================================================
//  Bluetooth — Parser
//  Format: data_hora, lat_raw, lon_raw, mac, nome, rssi, canal
// ============================================================
function parseBluetoothData(csvText) {
    btData = [];
    const lines = csvText.split('\n');
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const parts = trimmed.split(',');
        if (parts.length < 6) continue;

        const latRaw = parseInt(parts[1]);
        const lonRaw = parseInt(parts[2]);
        if (isNaN(latRaw) || isNaN(lonRaw) || latRaw === 0 || lonRaw === 0) continue;

        const mac   = parts[3].trim();
        const nome  = parts[4].trim() || '';
        const rssi  = parseInt(parts[5]) || -100;
        const canal = parts[6] ? (parseInt(parts[6].trim()) || null) : null;

        btData.push({
            data_hora: parts[0].trim(),
            latitude:  latRaw / 1000000,
            longitude: lonRaw / 1000000,
            mac,
            nome,
            rssi,
            canal,
            hasName: nome.length > 0
        });
    }
}

// ============================================================
//  Bluetooth — Dashboard init
// ============================================================
let currentBtFilters = { search: '', minSignal: -100, type: 'all' };

function initializeBluetoothDashboard() {
    if (btData.length === 0) return;
    if (!maps.bt) maps.bt = initLeafletMap('map-bt');
    applyBtFiltersAndRender();
}

// ============================================================
//  Bluetooth — Filter event listeners
// ============================================================
document.getElementById('bt-search').addEventListener('input', e => {
    currentBtFilters.search = e.target.value.toLowerCase();
    applyBtFiltersAndRender();
});

document.getElementById('bt-filter-signal').addEventListener('input', e => {
    currentBtFilters.minSignal = parseInt(e.target.value);
    document.getElementById('bt-signal-val').innerText = e.target.value + ' dBm';
    applyBtFiltersAndRender();
});

document.getElementById('bt-filter-type').addEventListener('change', e => {
    currentBtFilters.type = e.target.value;
    applyBtFiltersAndRender();
});

// ============================================================
//  Bluetooth — Apply filters & render map + list + stats
// ============================================================
function applyBtFiltersAndRender() {
    if (btData.length === 0) return;

    const filtered = btData.filter(d => {
        const mSearch = d.mac.toLowerCase().includes(currentBtFilters.search) ||
                        d.nome.toLowerCase().includes(currentBtFilters.search);
        const mSig  = d.rssi >= currentBtFilters.minSignal;
        const mType = currentBtFilters.type === 'all' ||
                      (currentBtFilters.type === 'named'   &&  d.hasName) ||
                      (currentBtFilters.type === 'unnamed' && !d.hasName);
        return mSearch && mSig && mType;
    });

    // --- Stats ---
    document.getElementById('bt-stat-total').innerText  = filtered.length.toLocaleString('pt-BR');
    const uniqueMacs = new Set(filtered.map(d => d.mac));
    document.getElementById('bt-stat-unique').innerText = uniqueMacs.size.toLocaleString('pt-BR');
    const namedCount = filtered.filter(d => d.hasName).length;
    document.getElementById('bt-stat-named').innerText  = namedCount.toLocaleString('pt-BR');
    let bestRssi = -200;
    filtered.forEach(d => { if (d.rssi > bestRssi) bestRssi = d.rssi; });
    document.getElementById('bt-stat-best-rssi').innerHTML = filtered.length > 0
        ? bestRssi + ' <span class="stat-unit">dBm</span>' : '— <span class="stat-unit">dBm</span>';

    // --- Map ---
    if (markers.btLayerGroup) maps.bt.removeLayer(markers.btLayerGroup);
    markers.btLayerGroup = L.layerGroup().addTo(maps.bt);

    // Group by location
    const grouped = {};
    filtered.forEach(d => {
        const key = `${d.latitude.toFixed(5)},${d.longitude.toFixed(5)}`;
        if (!grouped[key]) grouped[key] = { lat: d.latitude, lon: d.longitude, devices: [] };
        grouped[key].devices.push(d);
    });

    const allPts = [];
    Object.values(grouped).forEach(loc => {
        let bestSig = -200;
        let hasNamedDevice = false;
        loc.devices.forEach(d => {
            if (d.rssi > bestSig) bestSig = d.rssi;
            if (d.hasName) hasNamedDevice = true;
        });

        let markerColor = '#ef4444'; // weak
        if (bestSig >= -60) markerColor = '#10b981';       // strong
        else if (bestSig >= -80) markerColor = '#f59e0b';  // medium
        if (hasNamedDevice) markerColor = '#a855f7';       // named device overrides

        const circle = L.circleMarker([loc.lat, loc.lon], {
            color: markerColor,
            fillColor: markerColor,
            fillOpacity: 0.65,
            radius: 6 + Math.min(loc.devices.length, 8) * 0.5,
            weight: 1
        });

        // Build popup
        let popupHtml = `<div style="font-family:'Outfit',sans-serif;color:#f3f4f6;max-height:220px;overflow-y:auto;">
            <strong>📍 Local</strong> (${loc.devices.length} dispositivo${loc.devices.length !== 1 ? 's' : ''})<hr style="margin:5px 0;border-color:rgba(255,255,255,0.1);"/>`;
        const shown = [...loc.devices].sort((a, b) => b.rssi - a.rssi).slice(0, 8);
        shown.forEach(d => {
            const sigColor = d.rssi >= -60 ? '#34d399' : (d.rssi >= -80 ? '#fbbf24' : '#f87171');
            const namePart = d.hasName
                ? `<strong style="color:#c084fc;">${escapeHtml(d.nome)}</strong><br/>`
                : `<span style="color:#6b7280;">[Sem nome]</span><br/>`;
            popupHtml += `<div style="margin-bottom:6px;">
                ${namePart}
                <span style="font-size:0.78rem;color:#9ca3af;">${escapeHtml(d.mac)}</span><br/>
                Sinal: <span style="color:${sigColor};font-weight:bold;">${d.rssi} dBm</span>
                ${d.canal !== null ? `| Ch ${d.canal}` : ''}
            </div>`;
        });
        if (loc.devices.length > 8) popupHtml += `<div style="font-size:0.75rem;color:#6b7280;">+${loc.devices.length - 8} mais...</div>`;
        popupHtml += '</div>';

        circle.bindPopup(L.popup({ maxWidth: 280 }).setContent(popupHtml));
        circle.addTo(markers.btLayerGroup);
        allPts.push([loc.lat, loc.lon]);
    });

    if (allPts.length > 0) maps.bt.fitBounds(L.latLngBounds(allPts));

    populateBtList(filtered);
    renderBtAnalytics(filtered);
}

// ============================================================
//  Bluetooth — Device list
// ============================================================
function populateBtList(filteredList) {
    const container = document.getElementById('bt-list');
    container.innerHTML = '';

    if (filteredList.length === 0) {
        container.innerHTML = '<div style="padding:1.5rem;text-align:center;color:var(--text-secondary);">Nenhum dispositivo encontrado.</div>';
        return;
    }

    // Sort: named first, then by RSSI desc
    const sorted = [...filteredList].sort((a, b) => {
        if (a.hasName !== b.hasName) return a.hasName ? -1 : 1;
        return b.rssi - a.rssi;
    });

    sorted.slice(0, 150).forEach(d => {
        const item = document.createElement('div');
        item.className = 'list-item';

        let sigClass = 'badge-danger';
        if (d.rssi >= -60) sigClass = 'badge-success';
        else if (d.rssi >= -80) sigClass = 'badge-warning';

        const nameHtml = d.hasName
            ? `<div class="wifi-name" style="color:#c084fc;">${escapeHtml(d.nome)}</div>`
            : `<div class="wifi-name" style="color:#6b7280;">[Sem nome]</div>`;

        item.innerHTML = `
            <div>
                ${nameHtml}
                <div class="wifi-meta">${escapeHtml(d.mac)}${d.canal !== null ? ` · Ch ${d.canal}` : ''}</div>
                <div class="wifi-meta" style="font-size:0.7rem;color:#4b5563;">${d.data_hora}</div>
            </div>
            <span class="badge ${sigClass}">${d.rssi} dBm</span>
        `;

        item.addEventListener('click', () => {
            maps.bt.setView([d.latitude, d.longitude], 18);
            markers.btLayerGroup.eachLayer(layer => {
                if (layer.getLatLng &&
                    Math.abs(layer.getLatLng().lat - d.latitude) < 0.00001 &&
                    Math.abs(layer.getLatLng().lng - d.longitude) < 0.00001) {
                    layer.openPopup();
                }
            });
        });

        container.appendChild(item);
    });
}

// ============================================================
//  Bluetooth — Analytics charts
// ============================================================
function renderBtAnalytics(filteredList) {
    // --- RSSI Histogram (buckets of 5 dBm) ---
    const buckets = {};
    for (let v = -100; v < -30; v += 5) {
        const label = `${v} a ${v + 5}`;
        buckets[label] = 0;
    }
    filteredList.forEach(d => {
        const bucket = Math.floor(d.rssi / 5) * 5;
        const label = `${bucket} a ${bucket + 5}`;
        if (buckets[label] !== undefined) buckets[label]++;
        else buckets[label] = 1;
    });

    const rssiLabels = Object.keys(buckets);
    const rssiData   = rssiLabels.map(l => buckets[l]);
    const rssiColors = rssiLabels.map(l => {
        const v = parseInt(l.split(' ')[0]);
        if (v >= -60) return 'rgba(16,185,129,0.7)';
        if (v >= -80) return 'rgba(245,158,11,0.7)';
        return 'rgba(239,68,68,0.7)';
    });

    if (charts.btRssi) charts.btRssi.destroy();
    charts.btRssi = new Chart(document.getElementById('chart-bt-rssi').getContext('2d'), {
        type: 'bar',
        data: {
            labels: rssiLabels,
            datasets: [{
                label: 'Dispositivos',
                data: rssiData,
                backgroundColor: rssiColors,
                borderColor: 'rgba(255,255,255,0.05)',
                borderWidth: 1,
                borderRadius: 3
            }]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            scales: {
                x: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#9ca3af', maxRotation: 45, font: { size: 9 } } },
                y: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#9ca3af' } }
            },
            plugins: { legend: { display: false } }
        }
    });

    // --- Top Named Devices (bar chart by name, avg RSSI) ---
    const namedGroups = {};
    filteredList.filter(d => d.hasName).forEach(d => {
        if (!namedGroups[d.nome]) namedGroups[d.nome] = { total: 0, count: 0 };
        namedGroups[d.nome].total += d.rssi;
        namedGroups[d.nome].count++;
    });

    const topNames = Object.entries(namedGroups)
        .map(([name, v]) => ({ name, avg: v.total / v.count, count: v.count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 12);

    const topLabels = topNames.map(t => t.name.length > 18 ? t.name.slice(0, 15) + '…' : t.name);
    const topCounts = topNames.map(t => t.count);
    const topAvgRssi = topNames.map(t => Math.round(t.avg));

    const paletteTop = ['rgba(168,85,247,0.7)','rgba(59,130,246,0.7)','rgba(16,185,129,0.7)',
                        'rgba(245,158,11,0.7)','rgba(239,68,68,0.7)','rgba(96,165,250,0.7)',
                        'rgba(52,211,153,0.7)','rgba(251,191,36,0.7)','rgba(248,113,113,0.7)',
                        'rgba(192,132,252,0.7)','rgba(129,140,248,0.7)','rgba(45,212,191,0.7)'];

    if (charts.btTop) charts.btTop.destroy();

    if (topNames.length === 0) {
        // No named devices — show a friendly message via a blank chart with annotation
        charts.btTop = new Chart(document.getElementById('chart-bt-top').getContext('2d'), {
            type: 'bar',
            data: { labels: ['Sem dispositivos nomeados'], datasets: [{ data: [0], backgroundColor: 'transparent' }] },
            options: {
                responsive: true, maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    title: { display: true, text: 'Nenhum dispositivo com nome identificado', color: '#6b7280', font: { family: 'Outfit', size: 13 } }
                },
                scales: { x: { display: false }, y: { display: false } }
            }
        });
        return;
    }

    charts.btTop = new Chart(document.getElementById('chart-bt-top').getContext('2d'), {
        type: 'bar',
        data: {
            labels: topLabels,
            datasets: [{
                label: 'Detecções',
                data: topCounts,
                backgroundColor: paletteTop.slice(0, topLabels.length),
                borderColor: 'rgba(255,255,255,0.05)',
                borderWidth: 1,
                borderRadius: 4
            }]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            indexAxis: 'y',
            scales: {
                x: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#9ca3af' } },
                y: { grid: { display: false }, ticks: { color: '#f3f4f6', font: { family: 'Outfit', size: 11 } } }
            },
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        afterLabel: (ctx) => `RSSI médio: ${topAvgRssi[ctx.dataIndex]} dBm`
                    }
                }
            }
        }
    });
}

// ============================================================
// ============================================================
//  Ingestion & Multi-Date JSON Management
// ============================================================

let datasetIndex = null;
let currentLoadedDate = null;
let activeDayPayload = null; // Armazena payload do dia ativo para exportação
const memoryDayPayloads = {}; // Armazena payloads em memória (ex: ingestão via browser)

// Inicialização: carregar dataset_index.json se disponível
async function initDatasetIndex() {
    if (!selectDateSession) return;
    try {
        const res = await fetch('/data/dataset_index.json');
        if (!res.ok) {
            selectDateSession.innerHTML = '<option value="">Sem índice JSON gerado</option>';
            return;
        }
        datasetIndex = await res.json();
        const targetDate = populateDateSelector();
        if (targetDate) {
            await loadDateData(targetDate);
        } else {
            setActiveStatus('Selecione uma data para carregar');
        }
    } catch (err) {
        selectDateSession.innerHTML = '<option value="">Erro ao carregar índice</option>';
    }
}

function formatDateBR(isoDate) {
    const [y, m, d] = isoDate.split('-');
    return `${d}/${m}/${y}`;
}

function populateDateSelector(selectedDate = null) {
    if (!datasetIndex || !datasetIndex.dates) return null;
    const dates = Object.keys(datasetIndex.dates).sort().reverse();
    selectDateSession.innerHTML = '';

    if (dates.length === 0) {
        selectDateSession.innerHTML = '<option value="">Nenhum dia encontrado</option>';
        return null;
    }

    // Placeholder: nenhuma data carregada até o usuário escolher
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Selecione uma data...';
    selectDateSession.appendChild(placeholder);

    // Opções individuais por data (mais recente primeiro)
    dates.forEach(d => {
        const info = datasetIndex.dates[d];
        const opt = document.createElement('option');
        opt.value = d;
        const details = [];
        if (info.log_count > 0) details.push(`${info.log_count.toLocaleString('pt-BR')} pts`);
        if (info.wifi_count > 0) details.push(`${info.wifi_count.toLocaleString('pt-BR')} wifi`);
        if (info.ble_count > 0) details.push(`${info.ble_count.toLocaleString('pt-BR')} ble`);
        opt.textContent = `${formatDateBR(d)} (${details.join(' · ') || 'vazio'})`;
        selectDateSession.appendChild(opt);
    });

    const targetDate = selectedDate && dates.includes(selectedDate) ? selectedDate : '';
    selectDateSession.value = targetDate;
    return targetDate;
}

// Carrega estritamente o dia selecionado
async function loadDateData(dateStr) {
    if (!datasetIndex || !datasetIndex.dates || !dateStr) return;
    if (!datasetIndex.dates[dateStr]) return;

    setLoadingStatus(`Carregando dados de ${formatDateBR(dateStr)}...`);
    setProgress(20);

    try {
        let payload = null;
        if (memoryDayPayloads[dateStr]) {
            payload = memoryDayPayloads[dateStr];
        } else {
            const filePath = '/' + datasetIndex.dates[dateStr].file;
            const res = await fetch(filePath);
            if (!res.ok) throw new Error(`Não foi possível ler ${filePath}`);
            payload = await res.json();
        }

        activeDayPayload = payload;
        currentLoadedDate = dateStr;
        if (selectDateSession) selectDateSession.value = dateStr;

        setProgress(60);
        applyDayPayload(payload);
        setProgress(100);
        setActiveStatus(`Data ${formatDateBR(dateStr)} carregada`);
        hideProgress();
        if (btnExportJson) btnExportJson.style.display = 'inline-flex';
    } catch (err) {
        setErrorStatus(err.message);
        hideProgress();
    }
}

// Aplica os dados estruturados no estado da aplicação
function applyDayPayload(payload) {
    // 1. Limpeza de camadas anteriores
    if (markers.logLayerGroup && maps.log) maps.log.removeLayer(markers.logLayerGroup);
    if (markers.wifiLayerGroup && maps.wifi) maps.wifi.removeLayer(markers.wifiLayerGroup);
    if (markers.btLayerGroup && maps.bt) maps.bt.removeLayer(markers.btLayerGroup);
    logMarkers = [];

    // 2. Mapear telemetria GPS
    logData = [];
    if (payload.log && Array.isArray(payload.log)) {
        logData = payload.log.map(pt => ({
            data_hora: pt.t.replace('T', ' '),
            latitude: pt.lat,
            longitude: pt.lon,
            sat: pt.sat,
            hdop: pt.hdop,
            kmh: pt.kmh,
            direcao: pt.dir,
            umidade: pt.umid,
            temp_dht: pt.temp,
            ac_x: pt.ac ? pt.ac[0] : 0,
            ac_y: pt.ac ? pt.ac[1] : 0,
            ac_z: pt.ac ? pt.ac[2] : 0,
            gy_x: pt.gy ? pt.gy[0] : 0,
            gy_y: pt.gy ? pt.gy[1] : 0,
            gy_z: pt.gy ? pt.gy[2] : 0
        }));
    }

    // 3. Mapear Wi-Fi
    wifiData = [];
    if (payload.wifi && Array.isArray(payload.wifi)) {
        wifiData = payload.wifi.map(w => ({
            data_hora: w.t.replace('T', ' '),
            latitude: w.lat,
            longitude: w.lon,
            ssid: w.ssid || '[SSID Oculto]',
            potencia: w.rssi,
            canal: w.ch || 1,
            seguranca: w.auth || ''
        }));
    }

    // 4. Mapear Bluetooth
    btData = [];
    if (payload.ble && Array.isArray(payload.ble)) {
        btData = payload.ble.map(b => ({
            data_hora: b.t.replace('T', ' '),
            latitude: b.lat,
            longitude: b.lon,
            mac: b.mac,
            nome: b.name || '',
            rssi: b.rssi,
            canal: b.ch !== undefined ? b.ch : null,
            hasName: !!(b.name && b.name.trim().length > 0)
        }));
    }

    // Renderizar Log
    if (logData.length > 0) {
        if (!maps.log) {
            maps.log = initLeafletMap('map-log');
            canvasRenderer = L.canvas({ padding: 0.5 });
        }
        markers.logLayerGroup = L.layerGroup().addTo(maps.log);
        logData.forEach((pt, idx) => {
            const marker = L.circleMarker([pt.latitude, pt.longitude], {
                renderer: canvasRenderer,
                radius: 3,
                color: '#10b981',
                fillColor: '#10b981',
                fillOpacity: 0.7,
                weight: 0
            });
            marker.on('click', () => openPointPopup(marker, pt, idx));
            marker.addTo(markers.logLayerGroup);
            logMarkers.push(marker);
        });
        finalizeLogDashboard();
    } else {
        imuEvents = [];
        thresholds = { leve: 0, forte: 0, gyro: 0 };
        updateStatCards();
        if (charts.temp) { charts.temp.destroy(); charts.temp = null; }
        if (charts.hum) { charts.hum.destroy(); charts.hum = null; }
        if (charts.speed) { charts.speed.destroy(); charts.speed = null; }
        if (charts.jerk) { charts.jerk.destroy(); charts.jerk = null; }
        const heatbarCanvas = document.getElementById('chart-heatbar');
        if (heatbarCanvas) {
            const ctx = heatbarCanvas.getContext('2d');
            ctx.clearRect(0, 0, heatbarCanvas.width, heatbarCanvas.height);
        }
        const heatbarLabels = document.getElementById('heatbar-labels');
        if (heatbarLabels) heatbarLabels.innerHTML = '';
        document.getElementById('imu-count-leve').innerText = '0';
        document.getElementById('imu-count-forte').innerText = '0';
        document.getElementById('imu-count-curva').innerText = '0';
        document.getElementById('imu-thresh-leve').innerText = '—';
        document.getElementById('imu-thresh-forte').innerText = '—';
        document.getElementById('log-stat-bumps').innerText = '0';
        const imuList = document.getElementById('event-list');
        if (imuList) imuList.innerHTML = '<div style="color:var(--text-muted);padding:1rem;">Nenhum ponto GPS/IMU registrado para esta seleção.</div>';
    }

    // Renderizar Wi-Fi
    initializeWifiDashboard();

    // Renderizar Bluetooth
    initializeBluetoothDashboard();
}

// Evento ao trocar a data no dropdown
if (selectDateSession) {
    selectDateSession.addEventListener('change', (e) => {
        const selected = e.target.value;
        if (selected) {
            loadDateData(selected);
        }
    });
}

// Exportar JSON do dia selecionado ou consolidado
if (btnExportJson) {
    btnExportJson.addEventListener('click', () => {
        if (!activeDayPayload) {
            alert('Nenhum dado ativo para exportar.');
            return;
        }
        const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(activeDayPayload, null, 2));
        const downloadAnchor = document.createElement('a');
        downloadAnchor.setAttribute('href', dataStr);
        downloadAnchor.setAttribute('download', `${currentLoadedDate || 'tracker_export'}.json`);
        document.body.appendChild(downloadAnchor);
        downloadAnchor.click();
        downloadAnchor.remove();
    });
}

// Ingestão unificada de novos arquivos (.txt, .csv ou .json)
if (inputBatchFiles) {
    inputBatchFiles.addEventListener('change', async (e) => {
        const files = Array.from(e.target.files);
        if (files.length === 0) return;

        setLoadingStatus(`Ingerindo ${files.length} arquivo(s)...`);
        setProgress(0);

        const dailyStore = {};
        const getBucket = (d) => {
            if (!dailyStore[d]) dailyStore[d] = { log: [], wifi: [], ble: [] };
            return dailyStore[d];
        };

        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            const text = await file.text();

            if (file.name.endsWith('.json')) {
                try {
                    const jsonPayload = JSON.parse(text);
                    if (jsonPayload.date && (jsonPayload.log || jsonPayload.wifi || jsonPayload.ble)) {
                        const bucket = getBucket(jsonPayload.date);
                        if (jsonPayload.log) bucket.log.push(...jsonPayload.log);
                        if (jsonPayload.wifi) bucket.wifi.push(...jsonPayload.wifi);
                        if (jsonPayload.ble) bucket.ble.push(...jsonPayload.ble);
                    }
                } catch (err) {
                    console.warn(`Erro no parse JSON de ${file.name}:`, err);
                }
            } else {
                parseTextFileToDailyStore(file.name, text, dailyStore);
            }
            setProgress(((i + 1) / files.length) * 100);
        }

        const ingestedDates = Object.keys(dailyStore).sort();
        if (ingestedDates.length === 0) {
            setErrorStatus('Nenhum registro válido detectado nos arquivos.');
            hideProgress();
            return;
        }

        if (!datasetIndex) datasetIndex = { generated_at: new Date().toISOString(), dates: {} };

        for (const dateStr of ingestedDates) {
            const b = dailyStore[dateStr];

            // Merge com dados já existentes para o dia (memória ou disco)
            let existing = memoryDayPayloads[dateStr] || null;
            if (!existing && datasetIndex.dates[dateStr]) {
                try {
                    const res = await fetch('/' + datasetIndex.dates[dateStr].file);
                    if (res.ok) existing = await res.json();
                } catch (_) { /* arquivo ainda não existe — segue sem merge */ }
            }
            if (existing) {
                if (Array.isArray(existing.log))  b.log.push(...existing.log);
                if (Array.isArray(existing.wifi)) b.wifi.push(...existing.wifi);
                if (Array.isArray(existing.ble))  b.ble.push(...existing.ble);
            }

            const uniqueLogs = Array.from(new Map(b.log.map(item => [`${item.t}_${item.lat}_${item.lon}`, item])).values());
            const uniqueWifis = Array.from(new Map(b.wifi.map(item => [`${item.t}_${item.lat}_${item.lon}_${item.ssid}`, item])).values());
            const uniqueBles = Array.from(new Map(b.ble.map(item => [`${item.t}_${item.lat}_${item.lon}_${item.mac}`, item])).values());

            const lats = uniqueLogs.map(l => l.lat).filter(v => v !== 0);
            const lons = uniqueLogs.map(l => l.lon).filter(v => v !== 0);
            const bounds = lats.length ? [[Math.min(...lats), Math.min(...lons)], [Math.max(...lats), Math.max(...lons)]] : null;

            datasetIndex.dates[dateStr] = {
                file: `data/${dateStr}.json`,
                log_count: uniqueLogs.length,
                wifi_count: uniqueWifis.length,
                ble_count: uniqueBles.length,
                unique_ssids: new Set(uniqueWifis.map(w => w.ssid)).size,
                unique_macs: new Set(uniqueBles.map(b => b.mac)).size,
                bounds
            };

            activeDayPayload = {
                date: dateStr,
                summary: datasetIndex.dates[dateStr],
                log: uniqueLogs,
                wifi: uniqueWifis,
                ble: uniqueBles
            };
            memoryDayPayloads[dateStr] = activeDayPayload;
        }

        const mostRecent = ingestedDates[ingestedDates.length - 1];
        populateDateSelector(mostRecent);
        await loadDateData(mostRecent);
        setActiveStatus(`Ingestão concluída (${ingestedDates.length} dias processados)`);
        hideProgress();
        if (btnExportJson) btnExportJson.style.display = 'inline-flex';
    });
}

function parseTextFileToDailyStore(filename, text, dailyStore) {
    const lines = text.split('\n');
    let ftype = 'unknown';
    const lowerName = filename.toLowerCase();
    if (lowerName.includes('ble') || lowerName.includes('bt')) ftype = 'ble';
    else if (lowerName.includes('wifi') || lowerName.includes('ifi')) ftype = 'wifi';
    else if (lowerName.includes('log')) ftype = 'log';

    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#') || line.startsWith('data_hora')) continue;
        const parts = line.split(',');

        if (ftype === 'unknown') {
            if (parts.length >= 14) ftype = 'log';
            else if (parts.length === 7 && parts[3].includes(':')) ftype = 'ble';
            else if (parts.length >= 5) ftype = 'wifi';
        }

        const dateMatch = line.match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/);
        if (!dateMatch) continue;
        const [_, d, m, y, hh, mm, ss] = dateMatch;
        const yr = parseInt(y);
        if (yr < 2020 || yr > 2035) continue;

        const isoDate = `${y}-${m}-${d}`;
        const isoTime = `${y}-${m}-${d}T${hh}:${mm}:${ss}`;
        if (!dailyStore[isoDate]) dailyStore[isoDate] = { log: [], wifi: [], ble: [] };

        const latRaw = parseFloat(parts[1]);
        const lonRaw = parseFloat(parts[2]);
        const lat = Math.abs(latRaw) > 180 ? +(latRaw / 1000000).toFixed(6) : +latRaw.toFixed(6);
        const lon = Math.abs(lonRaw) > 180 ? +(lonRaw / 1000000).toFixed(6) : +lonRaw.toFixed(6);

        if (ftype === 'log' && parts.length >= 14) {
            dailyStore[isoDate].log.push({
                t: isoTime,
                lat, lon,
                sat: parseInt(parts[3]) || 0,
                hdop: parseFloat(parts[4]) || 0,
                kmh: parseFloat(parts[5]) || 0,
                dir: parts[6] ? parts[6].trim() : '',
                umid: parseFloat(parts[7]) || 0,
                temp: parseFloat(parts[8]) || 0,
                ac: [parseFloat(parts[9])||0, parseFloat(parts[10])||0, parseFloat(parts[11])||0],
                gy: [parseFloat(parts[12])||0, parseFloat(parts[13])||0, parseFloat(parts[14]||0)||0]
            });
        } else if (ftype === 'wifi' && parts.length >= 5) {
            dailyStore[isoDate].wifi.push({
                t: isoTime,
                lat, lon,
                ssid: parts[3] ? parts[3].trim() : '[SSID Oculto]',
                rssi: parseInt(parts[4]) || -100,
                ch: parts[5] ? parseInt(parts[5]) : 1,
                auth: parts[6] ? parts[6].trim() : ''
            });
        } else if (ftype === 'ble' && parts.length >= 6) {
            dailyStore[isoDate].ble.push({
                t: isoTime,
                lat, lon,
                mac: parts[3] ? parts[3].trim().toLowerCase() : '',
                name: parts[4] ? parts[4].trim() : '',
                rssi: parseInt(parts[5]) || -99,
                ch: parts[6] ? parseInt(parts[6]) : null
            });
        }
    }
}

// Inicializar na carga da página
document.addEventListener('DOMContentLoaded', () => {
    initDatasetIndex();
});


