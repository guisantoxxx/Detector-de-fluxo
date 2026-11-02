/*
  Application:
  - Interface water flow sensor with ESP32 board, exposing data via WiFi (HTTP JSON).

  Board:
  - ESP32 Dev Module
    https://my.cytron.io/p-node32-lite-wifi-and-bluetooth-development-kit
  Sensor:
  - G 1/2 Water Flow Sensor
    https://my.cytron.io/p-g-1-2-water-flow-sensor
*/

#include <WiFi.h>
#include <WebServer.h>

#define LED_BUILTIN 2
#define SENSOR  4

// ---------- WiFi ----------
const char* ssid     = "WIFI";
const char* password = "SENHA";

// ---------- IP Fixo ----------
// Ajuste esses valores conforme a rede do seu roteador.
// - local_IP: o IP que o ESP32 vai sempre usar (escolha um FORA da faixa
//   de DHCP do seu roteador, para não conflitar com outros aparelhos).
// - gateway: normalmente o IP do próprio roteador (geralmente termina em .1).
// - subnet: quase sempre 255.255.255.0 em redes domésticas.
// - primaryDNS/secondaryDNS: pode manter o DNS do Google, ou usar o do roteador.
//IPAddress local_IP(192, 168, 0, 2);
//IPAddress gateway(192, 168, 0, 1);
IPAddress local_IP(192, 168, 100, 250);
IPAddress gateway(192, 168, 100, 1);
IPAddress subnet(255, 255, 255, 0);
IPAddress dns(192, 168, 100, 1);
IPAddress primaryDNS(8, 8, 8, 8);
IPAddress secondaryDNS(8, 8, 4, 4);

WebServer server(80);

// ---------- Sensor de fluxo ----------
long currentMillis = 0;
long previousMillis = 0;
int interval = 2000;  // janela de medição aumentada de 1000ms para 2000ms
float calibrationFactor = 4.5;
volatile unsigned int pulseCount;
float flowRate;
unsigned int flowMilliLitres;
unsigned long totalMilliLitres;

// Debounce do sensor (ignora pulsos muito próximos, tipicamente ruído elétrico)
volatile unsigned long lastPulseTime = 0;
const unsigned long DEBOUNCE_MICROS = 1000; // 1ms

// Limiar mínimo (L/min) para considerar que "tem água passando"
const float FLOW_THRESHOLD = 0.5;
bool flowing = false;

void IRAM_ATTR pulseCounter()
{
  unsigned long now = micros();
  if (now - lastPulseTime > DEBOUNCE_MICROS) {
    pulseCount++;
    lastPulseTime = now;
  }
}

// ---------- Handlers HTTP ----------
void handleStatus()
{
  server.sendHeader("Access-Control-Allow-Origin", "*");

  String json = "{";
  json += "\"flowing\":" + String(flowing ? "true" : "false") + ",";
  json += "\"flowRateLmin\":" + String(flowRate, 2) + ",";
  json += "\"totalMilliLitres\":" + String(totalMilliLitres) + ",";
  json += "\"totalLitres\":" + String(totalMilliLitres / 1000.0, 2);
  json += "}";

  server.send(200, "application/json", json);
}

void handleStatusOptions()
{
  // Resposta ao preflight OPTIONS que o navegador envia antes de requisições
  // com Content-Type application/json, quando a origem é diferente do ESP32
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.sendHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  server.sendHeader("Access-Control-Allow-Headers", "Content-Type");
  server.send(204);
}

void handleRoot()
{
  String html = "<!DOCTYPE html><html><head><meta charset='utf-8'>";
  html += "<meta http-equiv='refresh' content='2'>";
  html += "<title>Monitor de Fluxo de Agua</title></head><body>";
  html += "<h2>Monitor de Fluxo de Agua</h2>";
  html += "<p><b>Status:</b> " + String(flowing ? "AGUA PASSANDO" : "SEM FLUXO") + "</p>";
  html += "<p><b>Vazao atual:</b> " + String(flowRate, 2) + " L/min</p>";
  html += "<p><b>Total acumulado:</b> " + String(totalMilliLitres / 1000.0, 2) + " L</p>";
  html += "</body></html>";

  server.send(200, "text/html", html);
}

void handlePing()
{
  server.send(200, "text/plain", "pong");
}

void setup()
{
  Serial.begin(115200);

  pinMode(LED_BUILTIN, OUTPUT);
  pinMode(SENSOR, INPUT_PULLUP);

  pulseCount = 0;
  flowRate = 0.0;
  flowMilliLitres = 0;
  totalMilliLitres = 0;
  previousMillis = 0;

  attachInterrupt(digitalPinToInterrupt(SENSOR), pulseCounter, FALLING);

  // ---------- Configura IP fixo ----------
  // Precisa ser chamado ANTES do WiFi.begin(). Se falhar (ex: valores fora
  // da faixa da rede), o ESP32 continua e recebe IP via DHCP normalmente.
  if (!WiFi.config(local_IP, gateway, subnet, primaryDNS, secondaryDNS)) {
    Serial.println("Falha ao configurar IP fixo, usando DHCP.");
  }

  // ---------- Conecta ao WiFi ----------
  WiFi.begin(ssid, password);
  Serial.print("Conectando ao WiFi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println();
  Serial.print("Conectado! IP: ");
  Serial.println(WiFi.localIP());
  Serial.print("MAC do ESP32: ");
  Serial.println(WiFi.macAddress());

  // Desativa o modo de economia de energia do rádio WiFi.
  // Sem isso, o ESP32 pode atrasar respostas ocasionalmente para economizar
  // energia, o que aparenta "desconexão" intermitente no app.
  WiFi.setSleep(false);

  // ---------- Rotas do servidor ----------
  server.on("/", handleRoot);
  server.on("/status", HTTP_GET, handleStatus);
  server.on("/status", HTTP_OPTIONS, handleStatusOptions);
  server.on("/ping", handlePing);
  server.begin();
  Serial.println("Servidor HTTP iniciado.");
}

void loop()
{
  server.handleClient();  // precisa ser chamado continuamente

  currentMillis = millis();
  if (currentMillis - previousMillis > interval) {

    // Copia o contador de pulsos acumulados durante a janela e zera com interrupts desligadas
    // (evita condição de corrida entre o loop e a ISR)
    noInterrupts();
    unsigned int pulses = pulseCount;
    pulseCount = 0;
    interrupts();

    unsigned long elapsed = millis() - previousMillis; // tempo real decorrido (ms) nesta janela
    previousMillis = millis();

    // Frequência de pulsos em Hz (pulsos por segundo), com base no tempo real decorrido
    float frequencyHz = (pulses * 1000.0) / elapsed;

    // Vazão em L/min: frequência (Hz) dividida pelo fator de calibração do sensor
    flowRate = frequencyHz / calibrationFactor;

    // Volume que passou nesta janela (elapsed ms), em mL
    flowMilliLitres = (unsigned int)((flowRate / 60.0) * (elapsed / 1000.0) * 1000.0);
    totalMilliLitres += flowMilliLitres;

    // Atualiza o flag binário de fluxo
    flowing = (flowRate > FLOW_THRESHOLD);
    digitalWrite(LED_BUILTIN, flowing ? HIGH : LOW);

    Serial.print("Flow rate: ");
    Serial.print(flowRate, 2);
    Serial.print("L/min");
    Serial.print("\t");

    Serial.print("Output Liquid Quantity: ");
    Serial.print(totalMilliLitres);
    Serial.print("mL / ");
    Serial.print(totalMilliLitres / 1000);
    Serial.println("L");
  }
}
