#!/usr/bin/env python3
"""
ingest.py — Módulo de Ingestão e Organização de Logs do Tracker Viewer

Processa recursivamente a pasta log/ (ou arquivos avulsos fornecidos),
deduplica registros, descarta datas inválidas e gera uma estrutura JSON
organizada por dia (data/YYYY-MM-DD.json) e um índice central (data/dataset_index.json).
"""

import os
import re
import json
import glob
from datetime import datetime, timezone
from collections import defaultdict

OUTPUT_DIR = "data"
INDEX_FILE = os.path.join(OUTPUT_DIR, "dataset_index.json")

# Regex para datas no formato DD/MM/YYYY HH:MM:SS
DATETIME_REGEX = re.compile(r"^(\d{2})/(\d{2})/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})")

def parse_date_to_iso(date_str, time_str):
    """Converte 'DD/MM/YYYY' e 'HH:MM:SS' para ISO 'YYYY-MM-DDTHH:MM:SS'."""
    try:
        d, m, y = date_str.split('/')
        if int(y) < 2020 or int(y) > 2035:
            return None, None
        iso_date = f"{y}-{m}-{d}"
        iso_datetime = f"{y}-{m}-{d}T{time_str}"
        return iso_date, iso_datetime
    except Exception:
        return None, None

def parse_coord(val_str):
    """Converte coordenada inteira (ex: -15826278) para float decimal (-15.826278)."""
    try:
        v = float(val_str.strip())
        if abs(v) > 180.0:
            return round(v / 1_000_000.0, 6)
        return round(v, 6)
    except Exception:
        return 0.0

def detect_file_type(filepath, first_line):
    basename = os.path.basename(filepath).lower()
    if 'ble' in basename or 'bt' in basename:
        return 'ble'
    if 'wifi' in basename or 'ifi' in basename:
        return 'wifi'
    if 'log' in basename:
        return 'log'

    parts = [p.strip() for p in first_line.split(',')]
    if len(parts) >= 14:
        return 'log'
    if len(parts) == 7 and ':' in parts[3]:
        return 'ble'
    if len(parts) >= 6:
        return 'wifi'
    return 'unknown'

def parse_log_line(parts):
    if len(parts) < 14:
        return None
    dt_match = DATETIME_REGEX.match(parts[0].strip())
    if not dt_match:
        return None
    day, month, year, hour, minute, second = dt_match.groups()
    iso_date, iso_dt = parse_date_to_iso(f"{day}/{month}/{year}", f"{hour}:{minute}:{second}")
    if not iso_date:
        return None

    try:
        direcao = parts[6].strip()
        return {
            "iso_date": iso_date,
            "record": {
                "t": iso_dt,
                "lat": parse_coord(parts[1]),
                "lon": parse_coord(parts[2]),
                "sat": int(float(parts[3].strip() or 0)),
                "hdop": round(float(parts[4].strip() or 0), 2),
                "kmh": round(float(parts[5].strip() or 0), 1),
                "dir": direcao,
                "umid": round(float(parts[7].strip() or 0), 1),
                "temp": round(float(parts[8].strip() or 0), 1),
                "ac": [round(float(parts[9].strip() or 0), 2), round(float(parts[10].strip() or 0), 2), round(float(parts[11].strip() or 0), 2)],
                "gy": [round(float(parts[12].strip() or 0), 2), round(float(parts[13].strip() or 0), 2), round(float(parts[14].strip() or 0) if len(parts) > 14 else 0, 2)]
            }
        }
    except Exception as e:
        return None

def parse_wifi_line(parts):
    if len(parts) < 5:
        return None
    dt_match = DATETIME_REGEX.match(parts[0].strip())
    if not dt_match:
        return None
    day, month, year, hour, minute, second = dt_match.groups()
    iso_date, iso_dt = parse_date_to_iso(f"{day}/{month}/{year}", f"{hour}:{minute}:{second}")
    if not iso_date:
        return None

    try:
        ssid = parts[3].strip()
        rssi = int(float(parts[4].strip()))
        channel = int(float(parts[5].strip())) if len(parts) > 5 and parts[5].strip() else 0
        auth = parts[6].strip() if len(parts) > 6 else ""
        return {
            "iso_date": iso_date,
            "record": {
                "t": iso_dt,
                "lat": parse_coord(parts[1]),
                "lon": parse_coord(parts[2]),
                "ssid": ssid,
                "rssi": rssi,
                "ch": channel,
                "auth": auth
            }
        }
    except Exception:
        return None

def parse_ble_line(parts):
    if len(parts) < 6:
        return None
    dt_match = DATETIME_REGEX.match(parts[0].strip())
    if not dt_match:
        return None
    day, month, year, hour, minute, second = dt_match.groups()
    iso_date, iso_dt = parse_date_to_iso(f"{day}/{month}/{year}", f"{hour}:{minute}:{second}")
    if not iso_date:
        return None

    try:
        mac = parts[3].strip().lower()
        name = parts[4].strip() if len(parts) > 4 else ""
        rssi = int(float(parts[5].strip() or -99))
        channel = int(float(parts[6].strip())) if len(parts) > 6 and parts[6].strip() else 0
        return {
            "iso_date": iso_date,
            "record": {
                "t": iso_dt,
                "lat": parse_coord(parts[1]),
                "lon": parse_coord(parts[2]),
                "mac": mac,
                "name": name,
                "rssi": rssi,
                "ch": channel
            }
        }
    except Exception:
        return None

def process_file(filepath, daily_store, seen_keys):
    try:
        with open(filepath, 'r', encoding='utf-8', errors='replace') as f:
            lines = f.readlines()
    except Exception as e:
        print(f"Erro ao ler {filepath}: {e}")
        return

    if not lines:
        return

    first_meaningful_line = ""
    for l in lines:
        if l.strip() and not l.strip().startswith('#') and not l.strip().startswith('data_hora'):
            first_meaningful_line = l
            break

    ftype = detect_file_type(filepath, first_meaningful_line)
    if ftype == 'unknown':
        return

    count_added = 0
    for line in lines:
        line = line.strip()
        if not line or line.startswith('#') or line.startswith('data_hora'):
            continue

        parts = [p.strip() for p in line.split(',')]

        res = None
        dedup_key = None

        if ftype == 'log':
            res = parse_log_line(parts)
            if res:
                r = res['record']
                dedup_key = (ftype, r['t'], r['lat'], r['lon'])
        elif ftype == 'wifi':
            res = parse_wifi_line(parts)
            if res:
                r = res['record']
                dedup_key = (ftype, r['t'], r['lat'], r['lon'], r['ssid'])
        elif ftype == 'ble':
            res = parse_ble_line(parts)
            if res:
                r = res['record']
                dedup_key = (ftype, r['t'], r['lat'], r['lon'], r['mac'])

        if res and dedup_key:
            if dedup_key not in seen_keys:
                seen_keys.add(dedup_key)
                daily_store[res['iso_date']][ftype].append(res['record'])
                count_added += 1

    print(f"[{ftype.upper():4}] {filepath:35}: {count_added} registros ingeridos.")

def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    daily_store = defaultdict(lambda: {"log": [], "wifi": [], "ble": []})
    seen_keys = set()

    files_to_process = sorted(glob.glob("log/**/*", recursive=True))
    for root_cand in ["log.txt", "wifi.txt", "ble.txt"]:
        if os.path.isfile(root_cand) and root_cand not in files_to_process:
            files_to_process.append(root_cand)

    for p in files_to_process:
        if os.path.isfile(p):
            process_file(p, daily_store, seen_keys)

    index_manifest = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "dates": {}
    }

    for date_str in sorted(daily_store.keys()):
        day_data = daily_store[date_str]
        for category in ["log", "wifi", "ble"]:
            day_data[category].sort(key=lambda x: x["t"])

        log_count = len(day_data["log"])
        wifi_count = len(day_data["wifi"])
        ble_count = len(day_data["ble"])

        lats = [pt["lat"] for pt in day_data["log"] if pt["lat"] != 0.0]
        lons = [pt["lon"] for pt in day_data["log"] if pt["lon"] != 0.0]
        bounds = None
        if lats and lons:
            bounds = [[min(lats), min(lons)], [max(lats), max(lons)]]

        unique_ssids = len(set(w["ssid"] for w in day_data["wifi"] if w["ssid"]))
        unique_macs = len(set(b["mac"] for b in day_data["ble"] if b["mac"]))
        max_speed = max([pt["kmh"] for pt in day_data["log"]], default=0.0)

        daily_file = f"{date_str}.json"
        daily_filepath = os.path.join(OUTPUT_DIR, daily_file)

        output_payload = {
            "date": date_str,
            "summary": {
                "log_points": log_count,
                "wifi_points": wifi_count,
                "ble_points": ble_count,
                "unique_ssids": unique_ssids,
                "unique_macs": unique_macs,
                "max_speed_kmh": max_speed,
                "bounds": bounds
            },
            "log": day_data["log"],
            "wifi": day_data["wifi"],
            "ble": day_data["ble"]
        }

        with open(daily_filepath, "w", encoding="utf-8") as out_f:
            json.dump(output_payload, out_f, ensure_ascii=False, separators=(',', ':'))

        index_manifest["dates"][date_str] = {
            "file": f"data/{daily_file}",
            "log_count": log_count,
            "wifi_count": wifi_count,
            "ble_count": ble_count,
            "unique_ssids": unique_ssids,
            "unique_macs": unique_macs,
            "bounds": bounds
        }
        print(f"-> Salvo {daily_filepath}: {log_count} log, {wifi_count} wifi, {ble_count} ble")

    with open(INDEX_FILE, "w", encoding="utf-8") as idx_f:
        json.dump(index_manifest, idx_f, ensure_ascii=False, indent=2)

    print(f"\nManifesto concluído em: {INDEX_FILE}")
    print(f"Total de dias particionados: {len(index_manifest['dates'])}")

if __name__ == "__main__":
    main()
