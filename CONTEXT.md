# CONTEXT.md — Tracker Viewer

## Glossário

### Ponto de Log
Uma linha do `log.txt` representando uma amostra do rastreador em um instante. Contém: `data_hora, lat, lon, sat, hdop, kmh, direcao, umidade, temp_dht, ac_x, ac_y, ac_z, gy_x, gy_y, gy_z`.

### Coordenada Raw
Inteiro sem separador decimal no log (ex: `-14163136`). Convertida para decimal dividindo por 1.000.000 (ex: `-14.163136`).

### Jerk
Variação absoluta da aceleração vertical entre amostras consecutivas: `|ac_z[i] - ac_z[i-1]|`. Métrica primária para detecção de impacto de pista.

### Evento de Trepidação
Ponto onde o `jerk` supera threshold adaptativo E o giroscópio não indica curva brusca simultânea. Classifica como irregularidade de pista (quebra-mola, buraco).

### Curva Brusca
Ponto com pico de aceleração simultâneo a alto `|gy_x|` ou `|gy_y|`. Excluído da contagem de eventos de trepidação.

### Threshold Adaptativo
Calculado sobre o dataset inteiro como `média(jerk) + N × desvio_padrão(jerk)`. Leve = média+1σ, Forte = média+2σ.

### Índice de Conforto Térmico
Combinação de temperatura e umidade numa escala de percepção humana (Heat Index simplificado). Exibido como heatbar ao longo do tempo.

### LTTB
Largest-Triangle-Three-Buckets — algoritmo de downsampling que reduz uma série temporal preservando a forma visual e picos. Aplicado antes de renderizar gráficos Chart.js.

### Chunk de Streaming
Lote de ~1000 linhas do log processadas incrementalmente via `ReadableStream` do `fetch`. O mapa é atualizado progressivamente a cada chunk.
