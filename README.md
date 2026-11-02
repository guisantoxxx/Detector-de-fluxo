# Monitor de Fluxo de Água

Sistema que detecta se há água passando em um encanamento e mostra a vazão em
tempo real no celular. É composto por duas partes:

1. **Firmware do ESP32** que lê um sensor de vazão **YF-S201** e expõe os dados
   por WiFi em formato JSON (HTTP).
2. **App Android (React Native / Expo)** que consulta o ESP32 a cada 2 segundos,
   mostra o estado visualmente e envia uma notificação quando o fluxo começa ou
   para.

```
Água → Sensor YF-S201 → GPIO4 → ESP32 (conta pulsos, calcula L/min)
                                   │
                                   │  WiFi (HTTP GET /status → JSON)
                                   ▼
                        App Android (consulta a cada 2 s)
                                   │
                                   ▼
               Tela (fluindo / sem fluxo) + notificação ao mudar de estado
```

## Estrutura do projeto

```
.
├── ESP32/
│   └── water_flow.ino      # firmware do ESP32
├── android-app/
│   ├── App.js              # app React Native (Expo)
│   └── ...                 # demais arquivos do projeto Expo
└── README.md
```

---

## Hardware

| Item | Descrição |
|---|---|
| Placa | **ESP32** (ESP32 Dev Module) |
| Sensor | **Sensor de vazão YF-S201** (G 1/2") |

### Ligações

| Fio do sensor | Liga em |
|---|---|
| Vermelho (VCC) | Alimentação do sensor (ver nota abaixo) |
| Preto (GND) | GND do ESP32 |
| Amarelo (sinal) | **GPIO4** do ESP32 |

> **Atenção à tensão do sinal.** O GPIO do ESP32 tolera no máximo **3,3 V**.
> Se o seu sensor tiver resistor de pull-up para 5 V na própria placa, o sinal
> pode chegar a 5 V no pino. Meça com um multímetro e, se for o caso, use um
> divisor de tensão. O LED da placa (GPIO2) acende quando há fluxo detectado.

---

## Firmware do ESP32 (`ESP32/water_flow.ino`)

### Como o sensor é lido

O YF-S201 tem um rotor com ímã e um sensor Hall: a cada volta, ele gera pulsos
na linha de sinal. Quanto mais rápido a água passa, mais pulsos por segundo.

- O GPIO4 é configurado com `INPUT_PULLUP`.
- Uma **interrupção (ISR)** em borda de descida (`FALLING`) incrementa um
  contador de pulsos.
- A ISR tem **debounce de 1 ms**: pulsos separados por menos de 1 ms são
  tratados como ruído elétrico e ignorados.

### Como a vazão é calculada

A cada **2 segundos** (`interval = 2000`), o `loop()`:

1. Copia e zera o contador de pulsos com as interrupções desligadas (evita
   condição de corrida com a ISR).
2. Mede o tempo real decorrido na janela.
3. Calcula a frequência: `Hz = pulsos × 1000 / tempo_ms`.
4. Calcula a vazão: `L/min = Hz / calibrationFactor`.
5. Calcula o volume da janela em mL e soma ao total acumulado.
6. Define `flowing = true` se a vazão for maior que `FLOW_THRESHOLD` (0,5 L/min)
   e acende ou apaga o LED.
7. Imprime os valores no Serial Monitor (115200).

### Parâmetros ajustáveis

| Parâmetro | Valor | Função |
|---|---|---|
| `SENSOR` | `4` | Pino do sinal do sensor |
| `interval` | `2000` ms | Janela de medição |
| `calibrationFactor` | `4.5` | Pulsos por segundo para cada 1 L/min |
| `DEBOUNCE_MICROS` | `1000` µs | Tempo mínimo entre pulsos válidos |
| `FLOW_THRESHOLD` | `0.5` L/min | Vazão mínima para considerar "tem água passando" |

> **Sobre a calibração.** O fator `4.5` vem do exemplo do fabricante do sensor
> G 1/2". Alguns datasheets do YF-S201 citam `7.5` (≈ 450 pulsos por litro).
> Para vazão precisa, calibre com um volume conhecido: passe, por exemplo, 1 L
> de água, conte os pulsos e use `pulsos por litro ÷ 60` como novo fator. Para
> o app, que só precisa saber se há fluxo, a diferença é pequena.

### WiFi e IP fixo

O ESP32 usa um **IP fixo** para que o app sempre o encontre no mesmo endereço.
Os valores ficam no topo do arquivo:

```cpp
IPAddress local_IP(192, 168, 100, 250);   // IP fixo do ESP32
IPAddress gateway(192, 168, 100, 1);      // IP do roteador
IPAddress subnet(255, 255, 255, 0);
IPAddress primaryDNS(8, 8, 8, 8);
IPAddress secondaryDNS(8, 8, 4, 4);
```

- `WiFi.config()` é chamado **antes** de `WiFi.begin()`. Se falhar, o ESP32
  continua e pega um IP por DHCP normalmente (veja o IP no Serial Monitor).
- `WiFi.setSleep(false)` desativa a economia de energia do rádio. Sem isso, o
  ESP32 pode atrasar respostas e parecer "desconectado" de forma intermitente.

#### Reservando o IP no roteador (importante)

Foi necessário **acessar o painel do roteador** e **retirar o IP escolhido da
faixa do DHCP**. Isso evita que o roteador entregue o mesmo endereço a outro
dispositivo (celular, TV, etc.), o que causaria conflito de IP e quedas de
conexão.

Resumo do procedimento:

1. Acesse o painel do roteador (normalmente o IP do gateway, como
   `192.168.100.1`, no navegador).
2. Localize a configuração do **servidor DHCP** (faixa de endereços).
3. Ajuste a faixa para **excluir** o IP do ESP32 (ex.: `192.168.100.250`). Por
   exemplo, faça o DHCP ir de `.2` a `.249`.
4. Salve e, se necessário, reinicie o roteador.

Cada roteador tem um menu diferente, mas a ideia é sempre a mesma: o IP fixo
deve ficar **fora** da faixa de distribuição automática.

### Endpoints HTTP

| Rota | Método | Resposta |
|---|---|---|
| `/` | GET | Página HTML simples com o estado (atualiza a cada 2 s) |
| `/status` | GET | JSON com o estado do fluxo (usado pelo app) |
| `/status` | OPTIONS | Resposta ao preflight CORS (204) |
| `/ping` | GET | `pong` (teste rápido de conexão) |

Exemplo de resposta de `/status`:

```json
{
  "flowing": true,
  "flowRateLmin": 3.42,
  "totalMilliLitres": 1280,
  "totalLitres": 1.28
}
```

O total acumulado é mantido apenas na RAM: **zera quando o ESP32 reinicia**.

### Como gravar

1. Instale o pacote **esp32 by Espressif Systems** no Gerenciador de Placas do
   Arduino IDE.
2. Selecione **Ferramentas → Placa → ESP32 Dev Module**.
3. Preencha `ssid` e `password` no código com os dados da sua rede.
4. Grave e abra o Serial Monitor em **115200**. O IP aparece ao conectar.
5. Teste no navegador: `http://192.168.100.250/status`.

---

## App Android (`android-app/`)

App React Native (Expo) que consulta `GET http://<IP_DO_ESP32>/status` e mostra
visualmente se há água fluindo e qual a vazão atual.

### Como funciona

- **Consulta a cada 2 segundos**, no mesmo ritmo da janela de medição do
  firmware. Cada requisição tem timeout de 4 s, e uma nova consulta não é
  disparada enquanto a anterior não terminou.
- **Confirmação de estado:** a tela só muda entre "fluindo" e "sem fluxo" depois
  de **2 leituras consecutivas** iguais (`CONFIRM_COUNT`). Isso evita que uma
  leitura isolada errada faça a tela piscar. A primeira leitura bem-sucedida
  define o estado inicial diretamente.
- **Suavização:** enquanto está fluindo, a vazão exibida é a média das últimas
  3 leituras. Sem fluxo, mostra 0.
- **Status de conexão:** o app só marca "Sem conexão com o sensor" depois de
  **3 falhas seguidas** (`DISCONNECT_CONFIRM_COUNT`), para que uma falha isolada
  de rede não derrube o indicador.
- **Notificações:** quando o estado confirmado muda (começou ou parou de
  fluir), o app dispara uma notificação local, com alerta visível mesmo com o
  app aberto. A primeira leitura não gera notificação, pois é o estado inicial.
- **Visual:** o fundo e a cor de destaque mudam com o estado, e o ícone de gota
  pulsa enquanto há fluxo. Tocando no ícone de engrenagem (canto superior
  esquerdo), é possível alterar o IP do ESP32 direto no app.

> **Limitação:** a consulta roda dentro do próprio app, sem serviço em segundo
> plano. As notificações só são geradas enquanto o app estiver em execução.

### Pré-requisitos

- Node.js instalado (https://nodejs.org)
- App **Expo Go** instalado no celular Android (Play Store)
- Celular e ESP32 na **mesma rede WiFi**

### Como rodar

```bash
cd android-app
npm install
npx expo start
```

Escaneie o QR code com o Expo Go. Depois, toque na engrenagem e confirme o IP
do ESP32 (o mesmo do Serial Monitor).

### Gerando um APK instalável (opcional)

Para instalar o app sem depender do Expo Go:

```bash
npm install -g eas-cli
eas login
eas build:configure
eas build -p android --profile preview
```

No `eas.json`, o perfil `preview` precisa gerar APK:

```json
{
  "build": {
    "preview": {
      "android": { "buildType": "apk" }
    }
  }
}
```

> **Importante:** o app usa `http://` (sem HTTPS). Em builds instalados, o
> Android pode bloquear tráfego HTTP não criptografado. Se o app instalado não
> conseguir falar com o ESP32 (mas funciona no Expo Go), habilite
> `usesCleartextTraffic` com o plugin `expo-build-properties`.

### Ajustando o comportamento (topo do `App.js`)

| Constante | Valor | Função |
|---|---|---|
| `DEFAULT_IP` | `192.168.100.250` | IP padrão do ESP32 |
| `POLL_INTERVAL_MS` | `2000` | Intervalo entre consultas (acompanhe o `interval` do firmware) |
| `CONFIRM_COUNT` | `2` | Leituras iguais para confirmar mudança de estado |
| `DISCONNECT_CONFIRM_COUNT` | `3` | Falhas seguidas para marcar como desconectado |
| `FETCH_TIMEOUT_MS` | `4000` | Timeout de cada requisição |

Com os valores padrão, a mudança de estado leva alguns segundos para aparecer
na tela: até 2 s da janela de medição do ESP32, mais 2 leituras de confirmação
no app.

---

## Solução de problemas

**O app mostra "Conectado", mas sem fluxo.** "Conectado" só indica que o ESP32
respondeu ao `/status`. O problema está na leitura do sensor. Compare com o
navegador (`http://<IP>/status`) e o Serial Monitor. Se ambos mostram 0, o app
está certo e o problema é o sensor, a fiação ou o ESP32.

Causas comuns do sensor:

- turbina travada por calcário ou sedimento (gire com um palito para testar);
- fio de sinal solto, oxidado ou com umidade no conector;
- sensor sem alimentação ou instalado contra o sentido da seta de fluxo;
- vazão abaixo de `FLOW_THRESHOLD` (0,5 L/min).

**Erro de upload: "port is busy / Acesso negado".** Outro programa está usando a
porta COM. Feche o Serial Monitor e outros programas seriais, e reconecte o USB.

**Erro de upload: "This chip is ESP32, not ESP32-S3".** A placa selecionada no
Arduino IDE está errada. Selecione **ESP32 Dev Module** e confira se não há um
`sketch.yaml` na pasta do sketch forçando outra placa.

**O app não encontra o ESP32.** Confirme que o celular está na mesma rede, que
o IP do app é o mesmo do Serial Monitor e que o IP fixo está fora da faixa do
DHCP do roteador.
