import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  SafeAreaView,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Animated,
  Easing,
  Keyboard,
  StatusBar,
  Platform,
} from 'react-native';
import * as Notifications from 'expo-notifications';

// ---------- Configurações ----------
const DEFAULT_IP = '192.168.100.250';
const POLL_INTERVAL_MS = 2000;   // igual ao intervalo de atualização do ESP32
const CONFIRM_COUNT = 2;         // leituras consecutivas necessárias para mudar de estado (fluindo)
const DISCONNECT_CONFIRM_COUNT = 3; // falhas consecutivas necessárias para marcar como desconectado
const FETCH_TIMEOUT_MS = 4000;

// ---------- Notificações ----------
// Garante que, mesmo com o app aberto (foreground), a notificação apareça
// como um alerta visível (por padrão o Expo suprime alertas em foreground).
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

async function registerForNotificationsAsync() {
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('flow-status', {
      name: 'Status do fluxo de água',
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250, 250, 250],
    });
  }

  const { status: existingStatus } = await Notifications.getPermissionsAsync();
  let finalStatus = existingStatus;
  if (existingStatus !== 'granted') {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }
  return finalStatus === 'granted';
}

async function sendFlowChangeNotification(isFlowing) {
  await Notifications.scheduleNotificationAsync({
    content: {
      title: isFlowing ? '💧 Água começou a fluir' : '⏸ Fluxo de água parou',
      body: isFlowing
        ? 'O sensor detectou início de fluxo de água.'
        : 'O sensor não detecta mais fluxo de água.',
      sound: true,
    },
    trigger: null, // dispara imediatamente
  });
}

// ---------- Utilitário: fetch com timeout ----------
function fetchWithTimeout(url, timeout = FETCH_TIMEOUT_MS) {
  return Promise.race([
    fetch(url),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('timeout')), timeout)
    ),
  ]);
}

// ---------- Hook: monitora o fluxo com lógica de confirmação ----------
function useFlowMonitor(ip) {
  const [confirmedFlowing, setConfirmedFlowing] = useState(false);
  const [displayRate, setDisplayRate] = useState(0);
  const [connected, setConnected] = useState(false);
  const [lastError, setLastError] = useState(null);

  // Contador de leituras consecutivas do mesmo estado (debounce de estado)
  const pendingRef = useRef({ state: false, count: 0 });
  const rateBufferRef = useRef([]);
  const initializedRef = useRef(false);

  // Guarda o último estado que já gerou notificação, pra não duplicar
  const lastNotifiedStateRef = useRef(null);

  // Contador de falhas consecutivas (debounce da conexão) e trava contra sobreposição
  const failCountRef = useRef(0);
  const isFetchingRef = useRef(false);

  // Pede permissão de notificação assim que o hook monta
  useEffect(() => {
    registerForNotificationsAsync();
  }, []);

  useEffect(() => {
    if (!ip) return;
    let isMounted = true;
    const url = `http://${ip}/status`;

    async function poll() {
      // Evita disparar uma nova consulta se a anterior ainda não terminou
      // (ex: ESP32 demorou um pouco mais a responder)
      if (isFetchingRef.current) return;
      isFetchingRef.current = true;

      try {
        const res = await fetchWithTimeout(url);
        const json = await res.json();
        if (!isMounted) return;

        failCountRef.current = 0;
        setConnected(true);
        setLastError(null);

        const rawFlowing = !!json.flowing;
        const rawRate = Number(json.flowRateLmin) || 0;

        // Na primeira leitura bem-sucedida, assume o estado direto (sem esperar as leituras)
        if (!initializedRef.current) {
          initializedRef.current = true;
          pendingRef.current = { state: rawFlowing, count: CONFIRM_COUNT };
          setConfirmedFlowing(rawFlowing);
          // Não notifica na primeira leitura (é o estado inicial, não uma "mudança")
          lastNotifiedStateRef.current = rawFlowing;
        } else {
          const pending = pendingRef.current;
          if (rawFlowing === pending.state) {
            pending.count = Math.min(pending.count + 1, CONFIRM_COUNT);
          } else {
            // Estado mudou em relação à última leitura: reinicia a contagem
            pending.state = rawFlowing;
            pending.count = 1;
          }
          // Só atualiza o que é exibido depois de N leituras seguidas iguais
          if (pending.count >= CONFIRM_COUNT) {
            setConfirmedFlowing(rawFlowing);

            // Dispara notificação apenas quando o estado CONFIRMADO muda de
            // verdade em relação ao último estado já notificado
            if (lastNotifiedStateRef.current !== rawFlowing) {
              lastNotifiedStateRef.current = rawFlowing;
              sendFlowChangeNotification(rawFlowing);
            }
          }
        }

        // Suaviza o valor exibido com média das últimas leituras enquanto fluindo
        if (rawFlowing) {
          const buf = rateBufferRef.current;
          buf.push(rawRate);
          if (buf.length > 3) buf.shift();
          const avg = buf.reduce((a, b) => a + b, 0) / buf.length;
          setDisplayRate(avg);
        } else {
          rateBufferRef.current = [];
        }
      } catch (err) {
        if (!isMounted) return;

        // Só marca como desconectado depois de N falhas seguidas — uma
        // falha isolada (rede lenta, WiFi power-save) não derruba o status
        failCountRef.current += 1;
        setLastError(err.message || 'Erro de conexão');
        if (failCountRef.current >= DISCONNECT_CONFIRM_COUNT) {
          setConnected(false);
        }
      } finally {
        isFetchingRef.current = false;
      }
    }

    poll();
    const timer = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      isMounted = false;
      clearInterval(timer);
    };
  }, [ip]);

  return {
    flowing: confirmedFlowing,
    rate: confirmedFlowing ? displayRate : 0,
    connected,
    lastError,
  };
}

export default function App() {
  const [ip, setIp] = useState(DEFAULT_IP);
  const [ipInput, setIpInput] = useState(DEFAULT_IP);
  const [editingIp, setEditingIp] = useState(false);

  const { flowing, rate, connected, lastError } = useFlowMonitor(ip);

  // ---------- Animações ----------
  const colorAnim = useRef(new Animated.Value(0)).current; // 0 = sem fluxo, 1 = fluindo
  const pulseAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    Animated.timing(colorAnim, {
      toValue: flowing ? 1 : 0,
      duration: 500,
      useNativeDriver: false,
    }).start();
  }, [flowing]);

  useEffect(() => {
    let loop;
    if (flowing) {
      loop = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, {
            toValue: 1.12,
            duration: 650,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: true,
          }),
          Animated.timing(pulseAnim, {
            toValue: 1,
            duration: 650,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: true,
          }),
        ])
      );
      loop.start();
    } else {
      pulseAnim.setValue(1);
    }
    return () => loop && loop.stop();
  }, [flowing]);

  const backgroundColor = colorAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ['#1a1d24', '#0b3d55'],
  });

  const accentColor = colorAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ['#5a6270', '#3ec6f0'],
  });

  const saveIp = useCallback(() => {
    const trimmed = ipInput.trim();
    if (trimmed.length > 0) {
      setIp(trimmed);
    }
    setEditingIp(false);
    Keyboard.dismiss();
  }, [ipInput]);

  return (
    <Animated.View style={[styles.container, { backgroundColor }]}>
      <StatusBar barStyle="light-content" />
      <SafeAreaView style={styles.safeArea}>
        {/* Cabeçalho: status de conexão + configuração de IP */}
        <View style={styles.header}>
          <View style={styles.connectionRow}>
            <View
              style={[
                styles.connectionDot,
                { backgroundColor: connected ? '#3ecf6f' : '#e0473e' },
              ]}
            />
            <Text style={styles.connectionText}>
              {connected ? 'Conectado' : 'Sem conexão com o sensor'}
            </Text>
          </View>

          {editingIp ? (
            <View style={styles.ipEditRow}>
              <TextInput
                style={styles.ipInput}
                value={ipInput}
                onChangeText={setIpInput}
                placeholder="Ex: 192.168.1.50"
                placeholderTextColor="#7a8290"
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="numbers-and-punctuation"
                onSubmitEditing={saveIp}
              />
              <TouchableOpacity onPress={saveIp} style={styles.ipSaveButton}>
                <Text style={styles.ipSaveButtonText}>✓</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <TouchableOpacity
              onPress={() => {
                setIpInput(ip);
                setEditingIp(true);
              }}
              style={styles.ipDisplayRow}
            >
              <Text style={styles.ipDisplayIcon}>⚙</Text>
              <Text style={styles.ipDisplayText}>{ip}</Text>
            </TouchableOpacity>
          )}
        </View>

        {/* Conteúdo principal */}
        <View style={styles.content}>
          <Animated.View style={{ transform: [{ scale: pulseAnim }] }}>
            <Animated.View style={[styles.iconCircle, { borderColor: accentColor }]}>
              <Text style={[styles.dropIcon, { opacity: flowing ? 1 : 0.5 }]}>💧</Text>
            </Animated.View>
          </Animated.View>

          <Text style={[styles.statusMessage, { color: flowing ? '#3ec6f0' : '#8b95a5' }]}>
            {flowing ? 'Água fluindo' : 'Sem fluxo de água'}
          </Text>

          <View style={styles.rateContainer}>
            <Text style={styles.rateValue}>{rate.toFixed(2)}</Text>
            <Text style={styles.rateUnit}>L/min</Text>
          </View>

          {!connected && lastError && (
            <Text style={styles.errorText}>
              Verifique se o sensor está ligado e na mesma rede WiFi
            </Text>
          )}
        </View>

        <View style={styles.footer}>
          <Text style={styles.footerText}>
            Atualiza a cada {POLL_INTERVAL_MS / 1000}s · confirmação após{' '}
            {CONFIRM_COUNT} leituras
          </Text>
        </View>
      </SafeAreaView>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  safeArea: {
    flex: 1,
    justifyContent: 'space-between',
  },
  header: {
    paddingHorizontal: 20,
    paddingTop: 12,
  },
  connectionRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  connectionDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 8,
  },
  connectionText: {
    color: '#8b95a5',
    fontSize: 13,
  },
  ipDisplayRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 6,
  },
  ipDisplayIcon: {
    fontSize: 12,
    color: '#7a8290',
  },
  ipDisplayText: {
    color: '#7a8290',
    fontSize: 12,
    marginLeft: 6,
  },
  ipEditRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 8,
  },
  ipInput: {
    flex: 1,
    backgroundColor: '#252932',
    color: '#fff',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    fontSize: 14,
  },
  ipSaveButton: {
    marginLeft: 8,
    backgroundColor: '#3ec6f0',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
  },
  ipSaveButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
  dropIcon: {
    fontSize: 64,
  },
  content: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconCircle: {
    width: 140,
    height: 140,
    borderRadius: 70,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 24,
  },
  statusMessage: {
    fontSize: 20,
    fontWeight: '600',
    marginBottom: 24,
  },
  rateContainer: {
    flexDirection: 'row',
    alignItems: 'baseline',
  },
  rateValue: {
    color: '#fff',
    fontSize: 64,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  rateUnit: {
    color: '#8b95a5',
    fontSize: 20,
    marginLeft: 8,
    fontWeight: '500',
  },
  errorText: {
    color: '#e0473e',
    fontSize: 13,
    marginTop: 16,
    textAlign: 'center',
    paddingHorizontal: 40,
  },
  footer: {
    alignItems: 'center',
    paddingBottom: 16,
  },
  footerText: {
    color: '#5a6270',
    fontSize: 11,
  },
});