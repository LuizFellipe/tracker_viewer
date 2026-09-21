# Tracker, Wi-Fi & Bluetooth Survey Viewer

Uma aplicação web (Single-Page Application) premium, moderna e responsiva, desenvolvida para visualizar e analisar dados de geolocalização, sensores inerciais/ambientais (IMU/DHT), redes Wi-Fi e sinais Bluetooth (BLE) a partir de logs coletados por um rastreador veicular/embarcado.

A interface possui estilo *dark mode* refinado com estética de *glassmorphism* (cartões translúcidos), gráficos temporais interativos, suporte a multi-sessões organizadas por data, mapas com alta densidade de pontos e painel de ingestão de arquivos.

---

## 🛠️ Tecnologias Utilizadas

1. **Estrutura & Estilo:**
   - **HTML5 Semântico** para estrutura acessível e clara.
   - **CSS3 Vanilla** com design system via variáveis customizadas, tipografia Outfit (Google Fonts) e efeitos modernos de desfoque (*backdrop-filter*).

2. **Mapas Interativos:**
   - **[Leaflet.js](https://leafletjs.com/)** (v1.9.4) com renderização via `L.canvas()` para suportar dezenas de milhares de pontos geográficos sem lentidão.
   - Base cartográfica ESRI World Street Map e CartoDB.

3. **Gráficos e Analíticos:**
   - **[Chart.js](https://www.chartjs.org/)** com múltiplos datasets interativos (velocidade, satélites, temperatura, umidade, jerk, histograma RSSI e top dispositivos BLE).
   - **Algoritmo LTTB (Largest-Triangle-Three-Buckets):** Redução amostral temporal preservando fidelidade visual e picos reais de eventos.

4. **Pipeline de Ingestão e Persistência:**
   - **Formato JSON Particionado por Data:** Estrutura compacta com separação por dia (`data/YYYY-MM-DD.json`) e catálogo central (`data/dataset_index.json`).
   - **Deduplicação Inteligente:** Filtra registros redundantes por chave composta `(tipo, timestamp, lat, lon, identificador)`.
   - **Ingestão Web & CLI:** Importação direta via interface web (arrastar e soltar arquivos) e via script Python offline (`ingest.py`).

5. **Servidor Local:**
   - Script em **Python 3** (`serve.py`) com servidor HTTP leve e cabeçalhos CORS habilitados.

---

## 📂 Estrutura do Projeto

```text
tracker_viewer/
├── data/                    # Datasets particionados por data (JSON)
│   ├── dataset_index.json   # Manifesto/índice central de todas as sessões
│   └── YYYY-MM-DD.json      # Dados consolidados do dia (log, wifi, ble)
├── log/                     # Arquivos originais brutos e sessões de coleta
│   ├── 01/ .. 04/           # Pastas com trios log.txt, wifi.txt, ble.txt
│   └── *.txt                # Dumps e coletas avulsas
├── index.html               # Aplicação SPA
├── style.css                # Estilos, variáveis e componentes de interface
├── app.js                   # Lógica da aplicação: ingestão, mapas, IMU, filtros e gráficos
├── ingest.py                # Script de ingestão, sanitização, deduplicação e geração JSON
├── serve.py                 # Servidor HTTP local
├── CONTEXT.md               # Glossário de termos e definições do domínio
└── README.md                # Documentação do projeto
```

---

## 🚀 Como Executar o Projeto

1. Certifique-se de ter o Python 3 instalado.
2. (Opcional) Se tiver novos arquivos em `log/`, processe a base para JSON executando:
   ```bash
   python3 ingest.py
   ```
3. Inicie o servidor local:
   ```bash
   python3 serve.py
   ```
4. Abra o navegador web em:
   ```text
   http://localhost:8000/
   ```
5. Na barra superior:
   - Escolha o dia desejado no seletor **📅 Data** e clique em **"Carregar Dataset"**.
   - Ou clique em **"➕ Ingerir Arquivos"** para adicionar arquivos `.txt`, `.csv` ou `.json` avulsos diretamente pelo navegador.
   - Use **"⬇ Exportar JSON"** para baixar o payload consolidado do dia ativo.

---

## 📊 Módulos e Recursos da Interface

### 1. 📡 Tracker Log (Telemetria GPS & Sensores IMU/DHT)
- **Cards de Métricas:** Pontos registrados, velocidade máxima, médias de temperatura e umidade e total de eventos de impacto.
- **Classificação Automática de Pista (IMU):**
  - Cálculo de **Jerk** vertical com **Thresholds Adaptativos** calculados sobre a média e desvio padrão.
  - Diferenciação entre **Solavanco Leve**, **Impacto Forte** e **Curva Brusca** (cruzamento com Giroscópio).
- **Popup Interativo com Mini-Gauge SVG:** Apresenta velocímetro de intensidade de impacto e leituras de todos os eixos inerciais e ambientais.
- **Barra de Conforto Térmico (Heat Index):** Visualização colorida da sensação térmica ao longo do tempo.
- **Gráficos com LTTB:** Curvas de velocidade, satélites GPS, temperatura, umidade e variação de aceleração ($\Delta ac_z$).

### 2. 📶 Wi-Fi Survey (Redes Sem Fio)
- **Mapa de Densidade e Cobertura:** Marcadores dimensionados pela quantidade de redes e coloridos pela potência do sinal ($\ge -60$ dBm verde, $-60$ a $-80$ dBm amarelo, $<-80$ dBm vermelho).
- **Popup de Varredura Local:** Lista todas as redes detectadas no ponto com SSID, dBm, canal e tipo de segurança.
- **Filtros em Tempo Real:** Busca textual por SSID/segurança, filtro por canal de transmissão e controle deslizante de sinal mínimo.
- **Gráficos Analíticos:** Ocupação do espectro por canal e divisão percentual de protocolos de segurança (WPA2, WPA3, Open, etc.).

### 3. 🔵 Bluetooth (BLE Survey)
- **Rastreamento de Dispositivos BLE:** Identificação de endereços MAC, nomes de dispositivos (ex: veículos BYD, smart tags, beacons) e canal de detecção.
- **Filtros Dedicados:** Busca por nome/MAC, filtro de intensidade de sinal e chaveamento entre *Todos*, *Com nome* e *Sem nome*.
- **Analíticos BLE:**
  - Histograma de distribuição de potência RSSI em intervalos de 5 dBm.
  - Gráfico dos Top Dispositivos identificados por frequência de detecção e RSSI médio.

### 4. ⚡ Ingestão Dinâmica & Exportação
- **Ingestão Multi-formato:** Suporte a arquivos `log.txt`, `wifi.txt`, `ble.txt` ou arquivos consolidados `.json`.
- **Deduplicação Automática:** Previne duplicação de pontos ao carregar arquivos repetidos ou sobrepostos.
- **Exportação One-Click:** Gera cópia estruturada em JSON pronto para integrações externas ou backups.
