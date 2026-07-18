# Tracker & Wi-Fi Survey Viewer

Uma aplicação web (Single-Page Application) premium, moderna e responsiva, desenvolvida para visualizar e analisar dados de geolocalização e intensidade de sinal Wi-Fi a partir de arquivos de logs coletados por um rastreador.

A interface possui estilo *dark mode* refinado com estética de *glassmorphism* (cartões translúcidos), gráficos de linha temporais interativos, painéis colapsáveis e mapas interativos baseados em dados abertos (OpenStreetMap).

---

## 🛠️ Tecnologias Utilizadas

A aplicação foi projetada sem a necessidade de etapas complexas de compilação ou chaves de API pagas. Utiliza:

1. **Estrutura & Estilo:**
   - **HTML5 Semântico** para melhor acessibilidade e estrutura limpa.
   - **CSS3 Vanilla** com variáveis de design customizadas, fontes premium (Outfit via Google Fonts) e efeitos modernos de desfoque de fundo (*backdrop-filter*).

2. **Mapas Interativos:**
   - **[Leaflet.js](https://leafletjs.com/)** (v1.9.4) para plotagem de rotas e marcadores.
   - Utilização de `L.canvas()` para renderização performática de dezenas de milhares de pontos.
   - Provedor de mapas **CartoDB (Dark Matter)**, oferecendo um estilo escuro elegante que combina perfeitamente com a aplicação, sem requisições de tokens ou chaves de acesso.

3. **Gráficos e Analíticos:**
   - **[Chart.js](https://www.chartjs.org/)** para a renderização rápida de múltiplos datasets.
   - **Algoritmo LTTB (Largest-Triangle-Three-Buckets):** Implementado nativamente em JavaScript para fazer o *downsampling* visual de enormes volumes de dados (ex: reduzindo de 34.000 pontos para 800), preservando com exatidão a forma visual da curva e os picos cruciais.

4. **Lógica de Aplicação e Performance:**
   - **JavaScript ES6+** nativo.
   - **Streaming Progressivo (`ReadableStream`):** Arquivos grandes (`log.txt`) são baixados e processados em blocos (chunks), permitindo que o mapa e a interface comecem a ser preenchidos imediatamente sem travar o navegador.

5. **Servidor Local:**
   - Script auxiliar em **Python 3** (`serve.py`) contendo um servidor HTTP leve habilitado com CORS, permitindo o carregamento via streaming dos arquivos locais.

---

## 📂 Estrutura do Projeto

```text
tracker_viewer/
├── index.html       # Estrutura principal da SPA
├── style.css        # Estilos gerais, temas e responsividade
├── app.js           # Lógica core: streaming, parser, detecção IMU, mapas, LTTB e gráficos
├── serve.py         # Script Python para servir a aplicação localmente
├── log.txt          # Arquivo contendo os dados do GPS e dos sensores IMU/DHT
├── wifi.txt         # Arquivo contendo as redes Wi-Fi escaneadas
└── CONTEXT.md       # Glossário de domínio com termos de análise IMU e variáveis ambientais
```

---

## 🚀 Como Executar o Projeto

Para abrir e rodar a aplicação localmente:

1. Certifique-se de que possui o Python instalado em seu computador.
2. Inicie o servidor local executando o seguinte comando no terminal na raiz do projeto:
   ```bash
   python3 serve.py
   ```
3. Abra o seu navegador web favorito e acesse:
   ```text
   http://localhost:8000/index.html
   ```
4. Na página inicial, clique em **"Carregar Arquivos do Workspace"**. Uma barra de progresso indicará o status do carregamento via streaming progressivo.

---

## 📊 Funcionamento e Recursos da Interface

A interface é dividida em duas abas principais acessíveis no menu superior:

### 1. Tracker Log (Dados do Rastreador)
Esta aba foca no mapeamento geográfico e dados ambientais do rastreador a partir do arquivo `log.txt`:
* **Resumos em Destaque:** Exibe cards com estatísticas de velocidade máxima atingida, quantidade de pontos, média de temperatura/umidade e contagem total de eventos de trepidação.
* **Mapa Canvas de Alta Performance:** Renderiza todos os pontos coletados com cores que representam anomalias na pista (Normal, Solavanco Leve, Impacto Forte, Curva Brusca).
* **Popup Rico com Mini-Gauge:** Ao clicar em um ponto no mapa, abre um popup customizado contendo todos os dados ambientais daquele momento, além de um gráfico SVG gauge animado indicando a intensidade do impacto medido pelos sensores inerciais (IMU).
* **Conforto Térmico (Heat Index):** Combina os valores de Temperatura e Umidade em uma faixa colorida (Heatbar), mapeando a percepção humana (Fresco, Confortável, Quente, Crítico) no decorrer de toda a viagem, acompanhada dos gráficos detalhados.
* **Análise Inteligente de Trepidação (IMU):** 
  - Calcula o *jerk* (variação brusca da aceleração vertical) e ajusta **Thresholds Adaptativos** de forma autônoma para cada arquivo (calibrando com base na média e desvio padrão locais).
  - Utiliza os dados do Giroscópio para distinguir curvas fechadas de reais defeitos na pista.
  - Painel colapsável que mostra a distribuição temporal do impacto no gráfico e apresenta uma lista interativa de ocorrências que o leva direto ao ponto correspondente no mapa.

### 2. Wi-Fi Survey (Redes Wi-Fi Escaneadas)
Esta aba exibe e classifica redes sem fio encontradas durante a varredura a partir do arquivo `wifi.txt`:
* **Mapa de Sinais:** Exibe marcadores coloridos com base na potência do sinal recebido (dBm). 
  - 🟢 **Sinal Forte** ($\ge -60$ dBm)
  - 🟡 **Sinal Médio** ($-60$ dBm a $-80$ dBm)
  - 🔴 **Sinal Fraco** ($< -80$ dBm)
  - Clicar em um círculo no mapa revela um popup contendo a listagem de todas as SSIDs detectadas naquele exato ponto geográfico, ordenadas pela intensidade do sinal.
* **Filtros e Busca:** Permite refinar o conteúdo da lista lateral buscando pelo nome da rede (SSID), escolhendo um canal específico ou alterando a intensidade mínima de sinal tolerável no seletor deslizante.
* **Gráficos de Distribuição:** Apresenta um gráfico de colunas mostrando a utilização dos canais de rádio e um gráfico de rosca mostrando a adoção de protocolos de segurança (WPA2, WPA3, etc.).
